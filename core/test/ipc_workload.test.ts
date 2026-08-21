import { expect } from 'chai';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { TaskStore } from '../src/db/task_store';
import { WorkerManager } from '../src/worker_manager';
import { PairingService } from '../src/pairing_service';
import { TransportServer } from '../src/transport_server';
import { WorkloadPipeline } from '../src/workload_pipeline';
import { ScoredScheduler } from '../src/scheduler';
import { DistributionDecisionEngine } from '../src/decision_engine';
import { IpcServer } from '../src/ipc_server';
import { WorkloadDescriptor } from '../src/types';

describe('IPC Workload Integration Tests (Phase C)', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let workloadPipeline: WorkloadPipeline;
  let scheduler: ScoredScheduler;
  let decisionEngine: DistributionDecisionEngine;
  let ipcServer: IpcServer;

  let testSocketPath: string;
  let testPort: number;

  beforeEach(async () => {
    testSocketPath = path.join('/tmp', `swarmx-ipc-wkl-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);
    testPort = 59200 + Math.floor(Math.random() * 500);

    db = createDatabase(':memory:');
    runMigrations(db);
    taskStore = new TaskStore(db);
    workerManager = new WorkerManager();
    pairingService = new PairingService(db);
    scheduler = new ScoredScheduler();
    workloadPipeline = new WorkloadPipeline(taskStore, scheduler);

    transportServer = new TransportServer(testPort, pairingService, workerManager, taskStore, workloadPipeline);
    await transportServer.start();

    decisionEngine = new DistributionDecisionEngine();

    ipcServer = new IpcServer(
      testSocketPath,
      taskStore,
      workerManager,
      pairingService,
      transportServer,
      workloadPipeline,
      scheduler,
      decisionEngine
    );
    await ipcServer.start();
  });

  afterEach(async () => {
    await ipcServer.stop();
    await transportServer.stop();
    db.close();
    if (fs.existsSync(testSocketPath)) {
      try { fs.unlinkSync(testSocketPath); } catch (e) {}
    }
  });

  const sendIpc = (method: string, params: any): Promise<any> => {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(testSocketPath, () => {
        client.write(JSON.stringify({ id: 1, method, params }) + '\n');
      });

      client.on('data', (data) => {
        const res = JSON.parse(data.toString('utf-8').trim());
        client.end();
        resolve(res);
      });

      client.on('error', reject);
    });
  };

  const sampleBoxBlurWorkload: WorkloadDescriptor = {
    workloadId: 'wkl-boxblur-test-01',
    version: '1.0.0',
    computation: {
      domain: 'IMAGE_PROCESSING',
      kernelId: 'image_filter_box_blur_v1',
      parameters: { radius: 2 }
    },
    data: {
      itemCount: 1,
      totalPayloadBytes: 1048576, // 1 MB
      format: 'RAW_PLANAR_RGBA_UINT8',
      payloadBase64: Buffer.from([10, 20, 30, 40]).toString('base64')
    },
    constraints: {
      isPure: true,
      isIdempotent: true,
      toleranceValidator: 'IMAGE_PIXEL_DELTA'
    }
  };

  it('1. evaluateWorkload returns deterministic evaluation for certified kernel', async () => {
    const res = await sendIpc('evaluateWorkload', { workload: sampleBoxBlurWorkload });
    expect(res.error).to.be.undefined;
    expect(res.result).to.not.be.undefined;
    expect(res.result.decision).to.equal('LOCAL'); // No workers connected yet
    expect(res.result.reason).to.include('No eligible workers');
  });

  it('2. evaluateWorkload rejects uncertified kernel', async () => {
    const uncertifiedWkl = {
      ...sampleBoxBlurWorkload,
      computation: { domain: 'IMAGE', kernelId: 'uncertified_custom_func', parameters: {} }
    };
    const res = await sendIpc('evaluateWorkload', { workload: uncertifiedWkl });
    expect(res.error).to.be.undefined;
    expect(res.result.decision).to.equal('LOCAL');
    expect(res.result.reason).to.include('not certified');
  });

  it('3. evaluateWorkload validates Workload IR schema', async () => {
    const malformed = { computation: {} };
    const res = await sendIpc('evaluateWorkload', { workload: malformed });
    expect(res.error).to.include('computation.kernelId is required');
  });

  it('4. executeWorkload falls back to LOCAL_FALLBACK when no workers exist', async () => {
    const res = await sendIpc('executeWorkload', { workload: sampleBoxBlurWorkload });
    expect(res.error).to.be.undefined;
    expect(res.result.status).to.equal('LOCAL_FALLBACK');
    expect(res.result.reason).to.include('No eligible workers');
  });

  it('5. evaluateWorkload respects toggleSwarm', async () => {
    await sendIpc('toggleSwarm', { enabled: false });
    const res = await sendIpc('evaluateWorkload', { workload: sampleBoxBlurWorkload });
    expect(res.result.decision).to.equal('LOCAL');
    expect(res.result.reason).to.include('disabled by user');
  });

  it('6. setForceSwarmMode enables Core-managed override and causes evaluateWorkload to return SWARM', async () => {
    // 1. Enable simulation worker so an eligible worker exists
    await sendIpc('setSimulationMode', { enabled: true });

    // 2. Set Core-managed force swarm
    const forceRes = await sendIpc('setForceSwarmMode', { enabled: true });
    expect(forceRes.result.success).to.be.true;
    expect(forceRes.result.forceSwarm).to.be.true;

    // 3. evaluateWorkload now evaluates to SWARM
    const evalRes = await sendIpc('evaluateWorkload', { workload: sampleBoxBlurWorkload });
    expect(evalRes.result.decision).to.equal('SWARM');
    expect(evalRes.result.reason).to.include('Core override');

    // 4. Disable force swarm mode and verify it returns to adaptive decision
    await sendIpc('setForceSwarmMode', { enabled: false });
    const evalAdaptive = await sendIpc('evaluateWorkload', { workload: sampleBoxBlurWorkload });
    expect(evalAdaptive.result.reason).to.not.include('Core override');
  });

  it('7. executeWorkload dispatches to virtual worker when Simulation Mode + Force Swarm are enabled', async () => {
    await sendIpc('setSimulationMode', { enabled: true });
    await sendIpc('setForceSwarmMode', { enabled: true });

    const rawBuffer = Buffer.alloc(16 * 16 * 4, 120);
    const wkl: WorkloadDescriptor = {
      ...sampleBoxBlurWorkload,
      computation: {
        domain: 'IMAGE_PROCESSING',
        kernelId: 'image_filter_box_blur_v1',
        parameters: { radius: 2, width: 16, height: 16, mode: 'RGBA' }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: rawBuffer.length,
        format: 'RAW_PLANAR_RGBA_UINT8',
        payloadBase64: rawBuffer.toString('base64')
      }
    };

    const execRes = await sendIpc('executeWorkload', { workload: wkl });
    expect(execRes.error).to.be.undefined;
    expect(execRes.result.status).to.equal('COMPLETED');
    expect(execRes.result.workerId).to.include('sim-worker-virtual');
    expect(execRes.result.workerHostname).to.include('Virtual');
  });

  it('8. executeWorkload dispatches Float32 Matrix Multiplication to virtual worker and passes validation', async () => {
    await sendIpc('setSimulationMode', { enabled: true });
    await sendIpc('setForceSwarmMode', { enabled: true });

    const M = 8;
    const K = 8;
    const N = 8;
    const inFloats = new Float32Array(M * K + K * N);
    for (let i = 0; i < M * K; i++) inFloats[i] = 1.5;
    for (let i = 0; i < K * N; i++) inFloats[M * K + i] = 2.0;

    const rawBuffer = Buffer.from(inFloats.buffer, inFloats.byteOffset, inFloats.byteLength);

    const wkl = {
      workloadId: 'wkl-matmul-ipc-test',
      version: '1.0.0',
      computation: {
        domain: 'NUMERICAL_COMPUTATION',
        kernelId: 'matrix_multiply_v1',
        parameters: { M, K, N, dtype: 'FLOAT32' }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: rawBuffer.length,
        format: 'FLOAT32_ARRAY',
        payloadBase64: rawBuffer.toString('base64')
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'NUMERIC_TOLERANCE',
        maxMse: 1e-4
      }
    };

    const execRes = await sendIpc('executeWorkload', { workload: wkl });
    expect(execRes.error).to.be.undefined;
    expect(execRes.result.status).to.equal('COMPLETED');
    expect(execRes.result.workerId).to.include('sim-worker-virtual');
    expect(execRes.result.workerHostname).to.include('Virtual');

    const outBuf = Buffer.from(execRes.result.outputData, 'base64');
    expect(outBuf.length).to.equal(M * N * 4);

    const outFloats = new Float32Array(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength / 4);
    expect(outFloats.length).to.equal(64);
    // 1.5 * 2.0 * 8 = 24.0
    for (let i = 0; i < 64; i++) {
      expect(outFloats[i]).to.be.closeTo(24.0, 1e-4);
    }
  });
});
