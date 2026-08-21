import 'mocha';
import { expect } from 'chai';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { IpcServer } from '../src/ipc_server';
import { TaskStore } from '../src/db/task_store';
import { WorkerManager } from '../src/worker_manager';
import { PairingService } from '../src/pairing_service';
import { TransportServer } from '../src/transport_server';
import { WorkloadPipeline } from '../src/workload_pipeline';
import { ScoredScheduler } from '../src/scheduler';
import { DistributionDecisionEngine } from '../src/decision_engine';
import { SimulationWorkerAdapter } from '../src/simulation_worker';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { BINARY_FRAME_MAGIC, encodeBinaryFrame, decodeBinaryFrame } from '../src/binary_framing';

describe('Single-Round-Trip Execution & Trustworthy Telemetry Tests (Phase 9B)', () => {
  let socketPath: string;
  let testPort: number;
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let scheduler: ScoredScheduler;
  let decisionEngine: DistributionDecisionEngine;
  let workloadPipeline: WorkloadPipeline;
  let simulationWorker: SimulationWorkerAdapter;
  let ipcServer: IpcServer;

  beforeEach(async () => {
    socketPath = path.join('/tmp', `swarmx-single-rt-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);
    testPort = 59400 + Math.floor(Math.random() * 500);
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    db = createDatabase(':memory:');
    runMigrations(db);
    taskStore = new TaskStore(db);
    workerManager = new WorkerManager();
    pairingService = new PairingService(db);
    scheduler = new ScoredScheduler();
    workloadPipeline = new WorkloadPipeline(taskStore, scheduler);

    transportServer = new TransportServer(testPort, pairingService, workerManager, taskStore, workloadPipeline);
    await transportServer.start();

    decisionEngine = new DistributionDecisionEngine({
      minGainThreshold: 1.0,
      ipcOverheadMs: 1.0,
      coordinationOverheadMs: 1.0
    });

    simulationWorker = new SimulationWorkerAdapter();
    simulationWorker.setConfig({ enabled: true, simulatedDelayMs: 2 });

    ipcServer = new IpcServer(
      socketPath,
      taskStore,
      workerManager,
      pairingService,
      transportServer,
      workloadPipeline,
      scheduler,
      decisionEngine,
      simulationWorker
    );

    await ipcServer.start();
  });

  afterEach(async () => {
    await ipcServer.stop();
    await transportServer.stop();
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });

  const sendBinaryRequest = (msg: any, rawPayload: Buffer): Promise<{ metadata: any; outputPayload: Buffer }> => {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        const frame = encodeBinaryFrame(msg, rawPayload);
        client.write(frame);
      });

      let buffer = Buffer.alloc(0);
      client.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length >= 8) {
          const jsonLen = buffer.readUInt32BE(4);
          const totalExpected = 8 + jsonLen;
          if (buffer.length >= totalExpected) {
            const decoded = decodeBinaryFrame(buffer);
            if (decoded) {
              const res = decoded.metadata.result || {};
              const expectedPayloadBytes = res.totalPayloadBytes || decoded.metadata.totalPayloadBytes || 0;
              if (decoded.payload.length >= expectedPayloadBytes) {
                client.end();
                resolve({ metadata: decoded.metadata, outputPayload: decoded.payload });
              }
            }
          }
        }
      });

      client.on('error', reject);
    });
  };

  it('1. Single Binary Frame Request executes SWARM and returns explicit telemetry with memory:// reference', async () => {
    const M = 64, K = 64, N = 64;
    const aFloats = new Float32Array(M * K).fill(2.0);
    const bFloats = new Float32Array(K * N).fill(3.0);
    const inFloats = new Float32Array(M * K + K * N);
    inFloats.set(aFloats, 0);
    inFloats.set(bFloats, M * K);
    const rawBuffer = Buffer.from(inFloats.buffer, inFloats.byteOffset, inFloats.byteLength);

    const workload = {
      workloadId: 'wkl-rt-test-01',
      version: '1.0.0',
      computation: {
        domain: 'NUMERICAL_COMPUTATION',
        kernelId: 'matrix_multiply_v1',
        parameters: { M, K, N, dtype: 'FLOAT32', chunks: 2 }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: rawBuffer.length,
        format: 'FLOAT32_ARRAY'
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'NUMERIC_TOLERANCE',
        maxMse: 1e-4
      }
    };

    const res = await sendBinaryRequest(
      { id: 1, method: 'executeWorkload', params: { workload, forceSwarm: true } },
      rawBuffer
    );

    expect(res.metadata.result.status).to.equal('COMPLETED');
    expect(res.metadata.result.totalChunks).to.equal(2);
    expect(res.outputPayload.length).to.equal(M * N * 4);

    const alignedBuf = Buffer.from(res.outputPayload);
    const outFloats = new Float32Array(alignedBuf.buffer, alignedBuf.byteOffset, alignedBuf.byteLength / 4);
    expect(outFloats[0]).to.be.closeTo(2.0 * 3.0 * K, 1e-4);

    // Verify explicit telemetry fields
    const telemetry = res.metadata.result.telemetry;
    expect(telemetry).to.not.be.undefined;
    expect(telemetry.decisionMs).to.be.a('number');
    expect(telemetry.chunkingMs).to.be.a('number');
    expect(telemetry.schedulingMs).to.be.a('number');
    expect(telemetry.workerComputeMs).to.be.a('number');
    expect(telemetry.reassemblyMs).to.be.a('number');
    expect(telemetry.validationMs).to.be.a('number');
    expect(telemetry.coreTotalMs).to.be.a('number');

    // Verify SQLite task result destination is lightweight memory pointer
    const tasks = taskStore.listTasks();
    const chunkTask = tasks.find((t: any) => t.id.includes('wkl-rt-test-01'));
    expect(chunkTask).to.not.be.undefined;
    expect(chunkTask!.resultDestination).to.include('memory://');
  });

  it('2. Single Binary Frame returns LOCAL_FALLBACK with decision telemetry when small workload is not forced', async () => {
    simulationWorker.setConfig({ enabled: false }); // No workers available
    const M = 16, K = 16, N = 16;
    const inFloats = new Float32Array(M * K + K * N).fill(1.0);
    const rawBuffer = Buffer.from(inFloats.buffer, inFloats.byteOffset, inFloats.byteLength);

    const workload = {
      workloadId: 'wkl-rt-local-01',
      version: '1.0.0',
      computation: {
        domain: 'NUMERICAL_COMPUTATION',
        kernelId: 'matrix_multiply_v1',
        parameters: { M, K, N, dtype: 'FLOAT32' }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: rawBuffer.length,
        format: 'FLOAT32_ARRAY'
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'NUMERIC_TOLERANCE'
      }
    };

    const res = await sendBinaryRequest(
      { id: 2, method: 'executeWorkload', params: { workload, forceSwarm: false } },
      rawBuffer
    );

    expect(res.metadata.result.status).to.equal('LOCAL_FALLBACK');
    expect(res.metadata.result.reason).to.be.a('string');
    expect(res.metadata.result.telemetry.decisionMs).to.be.a('number');
  });
});
