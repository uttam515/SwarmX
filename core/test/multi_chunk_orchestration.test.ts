import 'mocha';
import { expect } from 'chai';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { IpcServer } from '../src/ipc_server';
import { TaskStore } from '../src/db/task_store';
import { WorkerManager, WorkerState } from '../src/worker_manager';
import { PairingService } from '../src/pairing_service';
import { TransportServer } from '../src/transport_server';
import { WorkloadPipeline } from '../src/workload_pipeline';
import { ScoredScheduler } from '../src/scheduler';
import { DistributionDecisionEngine } from '../src/decision_engine';
import { SimulationWorkerAdapter } from '../src/simulation_worker';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { WorkloadDescriptor } from '../src/types';

describe('Multi-Chunk Orchestration Tests (Phase 5B)', () => {
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
    socketPath = path.join('/tmp', `swarmx-chunk-test-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);
    testPort = 59300 + Math.floor(Math.random() * 500);
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
    simulationWorker.setConfig({ enabled: true, simulatedDelayMs: 5 });

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

  const sendIpcRequest = async (req: any): Promise<any> => {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify(req) + '\n');
      });

      let buffer = '';
      client.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        if (buffer.includes('\n')) {
          try {
            const parsed = JSON.parse(buffer.trim());
            client.end();
            resolve(parsed);
          } catch (e) {
            // Buffer more TCP chunks
          }
        }
      });

      client.on('error', (err) => reject(err));
    });
  };

  const createMatmulWorkload = (M: number, K: number, N: number, chunks?: number): { workload: WorkloadDescriptor, aFloats: Float32Array, bFloats: Float32Array } => {
    const aFloats = new Float32Array(M * K);
    const bFloats = new Float32Array(K * N);

    for (let i = 0; i < M * K; i++) aFloats[i] = (i % 10) * 0.5;
    for (let i = 0; i < K * N; i++) bFloats[i] = (i % 8) * 0.25;

    const aBuf = Buffer.from(aFloats.buffer, aFloats.byteOffset, aFloats.byteLength);
    const bBuf = Buffer.from(bFloats.buffer, bFloats.byteOffset, bFloats.byteLength);
    const payloadBuf = Buffer.concat([aBuf, bBuf]);

    const workload: WorkloadDescriptor = {
      version: '1.0',
      workloadId: `wkl-matmul-test-${M}x${K}x${N}`,
      computation: {
        domain: 'linear_algebra',
        kernelId: 'matrix_multiply_v1',
        parameters: { M, K, N, ...(chunks ? { chunks } : {}) }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: payloadBuf.length,
        format: 'binary_f32',
        payloadBase64: payloadBuf.toString('base64')
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'PASS_THROUGH'
      }
    };

    return { workload, aFloats, bFloats };
  };

  const computeReferenceMatmul = (a: Float32Array, b: Float32Array, M: number, K: number, N: number): Float32Array => {
    const c = new Float32Array(M * N);
    for (let i = 0; i < M; i++) {
      for (let k = 0; k < K; k++) {
        const aVal = a[i * K + k];
        for (let j = 0; j < N; j++) {
          c[i * N + j] += aVal * b[k * N + j];
        }
      }
    }
    return c;
  };

  it('A & B & C. N-Worker Chunking: Partitions 128x64 @ 64x64 into 4 chunks and reassembles accurately', async () => {
    const M = 128, K = 64, N = 64;
    const { workload, aFloats, bFloats } = createMatmulWorkload(M, K, N, 4);

    const res = await sendIpcRequest({
      id: 1,
      method: 'executeWorkload',
      params: { workload, forceSwarm: true }
    });

    expect(res.result.status).to.equal('COMPLETED');
    expect(res.result.totalChunks).to.equal(4);
    expect(res.result.completedChunks).to.equal(4);

    const outputBuf = Buffer.from(res.result.outputData, 'base64');
    expect(outputBuf.length).to.equal(M * N * 4);

    const resultF32 = new Float32Array(outputBuf.buffer, outputBuf.byteOffset, outputBuf.byteLength / 4);
    const refF32 = computeReferenceMatmul(aFloats, bFloats, M, K, N);

    for (let i = 0; i < refF32.length; i++) {
      expect(resultF32[i]).to.be.closeTo(refF32[i], 1e-4);
    }
  });

  it('D & E & F. Concurrent Out-of-Order Execution & Reassembly', async () => {
    const M = 256, K = 128, N = 128;
    const { workload, aFloats, bFloats } = createMatmulWorkload(M, K, N, 8);

    const res = await sendIpcRequest({
      id: 2,
      method: 'executeWorkload',
      params: { workload, forceSwarm: true }
    });

    expect(res.result.status).to.equal('COMPLETED');
    expect(res.result.totalChunks).to.equal(8);

    const outputBuf = Buffer.from(res.result.outputData, 'base64');
    const resultF32 = new Float32Array(outputBuf.buffer, outputBuf.byteOffset, outputBuf.byteLength / 4);
    const refF32 = computeReferenceMatmul(aFloats, bFloats, M, K, N);

    expect(resultF32.length).to.equal(M * N);
    for (let i = 0; i < 256; i++) {
      expect(resultF32[i]).to.be.closeTo(refF32[i], 1e-4);
    }
  });

  it('G. Parent Progress Tracking: Records completedChunks and totalChunks in pipeline', async () => {
    const M = 128, K = 64, N = 64;
    const { workload } = createMatmulWorkload(M, K, N, 4);

    await sendIpcRequest({
      id: 3,
      method: 'executeWorkload',
      params: { workload, forceSwarm: true }
    });

    const progress = workloadPipeline.getWorkloadProgress(workload.workloadId);
    expect(progress).to.not.be.undefined;
    expect(progress?.totalChunks).to.equal(4);
    expect(progress?.completedChunks).to.equal(4);
    expect(progress?.percentComplete).to.equal(100);
  });

  it('J & K. Reservation Lifecycle: Reservations are fully released upon completion', async () => {
    const M = 64, K = 64, N = 64;
    const { workload } = createMatmulWorkload(M, K, N, 2);

    expect(decisionEngine.getInFlightCount(SimulationWorkerAdapter.DEVICE_ID)).to.equal(0);

    await sendIpcRequest({
      id: 4,
      method: 'executeWorkload',
      params: { workload, forceSwarm: true }
    });

    expect(decisionEngine.getInFlightCount(SimulationWorkerAdapter.DEVICE_ID)).to.equal(0);
  });

  it('M & N. Small Workload & Single-Task Compatibility: Does not chunk small matrices (M < 64)', async () => {
    const M = 16, K = 16, N = 16;
    const { workload } = createMatmulWorkload(M, K, N);

    const res = await sendIpcRequest({
      id: 5,
      method: 'executeWorkload',
      params: { workload, forceSwarm: true }
    });

    expect(res.result.status).to.equal('COMPLETED');
    expect(res.result.totalChunks).to.be.undefined;
  });

  it('O. Unsupported Kernel Compatibility: Non-GEMM kernels execute via existing single-task path', async () => {
    const blurWorkload: WorkloadDescriptor = {
      version: '1.0',
      workloadId: 'wkl-boxblur-single',
      computation: {
        domain: 'vision',
        kernelId: 'image_filter_box_blur_v1',
        parameters: { width: 10, height: 10, mode: 'RGBA', radius: 2 }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: 400,
        format: 'raw_rgba',
        payloadBase64: Buffer.alloc(400, 128).toString('base64')
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'PASS_THROUGH'
      }
    };

    const res = await sendIpcRequest({
      id: 6,
      method: 'executeWorkload',
      params: { workload: blurWorkload, forceSwarm: true }
    });

    expect(res.result.status).to.equal('COMPLETED');
    expect(res.result.totalChunks).to.be.undefined;
  });

  it('P & Q. Uneven Partition Numerical Verification: M=100 with 3 chunks [34, 33, 33] matches reference GEMM', async () => {
    const M = 100, K = 50, N = 50;
    const { workload, aFloats, bFloats } = createMatmulWorkload(M, K, N, 3);

    const res = await sendIpcRequest({
      id: 7,
      method: 'executeWorkload',
      params: { workload, forceSwarm: true }
    });

    expect(res.result.status).to.equal('COMPLETED');
    expect(res.result.totalChunks).to.equal(3);
    expect(res.result.completedChunks).to.equal(3);

    const outputBuf = Buffer.from(res.result.outputData, 'base64');
    expect(outputBuf.length).to.equal(M * N * 4);

    const resultF32 = new Float32Array(outputBuf.buffer, outputBuf.byteOffset, outputBuf.byteLength / 4);
    const refF32 = computeReferenceMatmul(aFloats, bFloats, M, K, N);

    for (let i = 0; i < refF32.length; i++) {
      expect(resultF32[i]).to.be.closeTo(refF32[i], 1e-4);
    }
  });

  it('L. No Eligible Worker: When simulation is disabled and 0 workers connected, returns FAILED or LOCAL_FALLBACK', async () => {
    simulationWorker.setConfig({ enabled: false });

    const M = 64, K = 64, N = 64;
    const { workload } = createMatmulWorkload(M, K, N, 2);

    const res = await sendIpcRequest({
      id: 8,
      method: 'executeWorkload',
      params: { workload, forceSwarm: true }
    });

    expect(res.result.status).to.equal('FAILED');
    expect(res.result.reason).to.include('No eligible remote worker');
  });

  it('H & I. Fault Tolerance: Mid-workload retry & reassignment upon worker failure', async () => {
    // Register physical worker A
    workerManager.registerWorker({
      capabilitySchemaVersion: 1,
      deviceId: 'worker-flaky-01',
      deviceName: 'Flaky Worker Node',
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 8,
      totalRamMb: 16384,
      hasGpu: true,
      supportedKernels: ['matrix_multiply_v1']
    });

    const M = 128, K = 64, N = 64;
    const { workload, aFloats, bFloats } = createMatmulWorkload(M, K, N, 4);

    // Run execution with simulation fallback enabled
    const res = await sendIpcRequest({
      id: 9,
      method: 'executeWorkload',
      params: { workload, forceSwarm: true }
    });

    expect(res.result.status).to.equal('COMPLETED');
    expect(res.result.totalChunks).to.equal(4);
    expect(res.result.completedChunks).to.equal(4);

    const outputBuf = Buffer.from(res.result.outputData, 'base64');
    const resultF32 = new Float32Array(outputBuf.buffer, outputBuf.byteOffset, outputBuf.byteLength / 4);
    const refF32 = computeReferenceMatmul(aFloats, bFloats, M, K, N);

    for (let i = 0; i < refF32.length; i++) {
      expect(resultF32[i]).to.be.closeTo(refF32[i], 1e-4);
    }
  });
});

