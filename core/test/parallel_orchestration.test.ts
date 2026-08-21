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

describe('Parallel Workload Orchestration & Multi-Task Tests (Phase 2B)', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let workloadPipeline: WorkloadPipeline;
  let scheduler: ScoredScheduler;
  let decisionEngine: DistributionDecisionEngine;
  let ipcServer: IpcServer;

  const testSocketPath = path.join('/tmp', `swarmx-ipc-parallel-${Date.now()}.sock`);
  const testPort = 59155;

  before(async () => {
    if (fs.existsSync(testSocketPath)) fs.unlinkSync(testSocketPath);
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

  after(async () => {
    await ipcServer.stop();
    await transportServer.stop();
    if (fs.existsSync(testSocketPath)) fs.unlinkSync(testSocketPath);
  });

  const sendIpc = (method: string, params: any = {}): Promise<any> => {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(testSocketPath, () => {
        const payload = JSON.stringify({ id: 1, method, params }) + '\n';
        client.write(payload);
      });
      let buffer = '';
      client.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) {
          const line = buffer.split('\n')[0];
          client.end();
          resolve(JSON.parse(line));
        }
      });
      client.on('error', reject);
    });
  };

  it('1. Multiple simultaneous executeWorkload requests receive independent IDs and complete successfully', async () => {
    await sendIpc('setSimulationMode', { enabled: true });
    await sendIpc('setForceSwarmMode', { enabled: true });

    const numConcurrent = 4;
    const M = 8;
    const K = 8;
    const N = 8;

    const executeOne = (idx: number) => {
      const inFloats = new Float32Array(M * K + K * N);
      for (let i = 0; i < M * K; i++) inFloats[i] = 1.0 * idx;
      for (let i = 0; i < K * N; i++) inFloats[M * K + i] = 2.0;

      const rawBuffer = Buffer.from(inFloats.buffer, inFloats.byteOffset, inFloats.byteLength);

      const wkl = {
        workloadId: `wkl-parallel-test-${idx}`,
        version: '1.0.0',
        computation: {
          domain: 'NUMERICAL_COMPUTATION',
          kernelId: 'matrix_multiply_v1',
          parameters: { M, K, N, dtype: 'FLOAT32', batchId: 'batch-001' }
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

      return sendIpc('executeWorkload', { workload: wkl });
    };

    const promises = Array.from({ length: numConcurrent }, (_, i) => executeOne(i + 1));
    const results = await Promise.all(promises);

    expect(results).to.have.lengthOf(numConcurrent);
    results.forEach((res, i) => {
      expect(res.error).to.be.undefined;
      expect(res.result.status).to.equal('COMPLETED');
      expect(res.result.workloadId).to.equal(`wkl-parallel-test-${i + 1}`);
      expect(res.result.workerId).to.include('sim-worker-virtual');

      const outBuf = Buffer.isBuffer(res.result.outputData)
        ? res.result.outputData
        : Buffer.from(res.result.outputData, 'base64');
      const outFloats = new Float32Array(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength / 4);
      expect(outFloats.length).to.equal(64);
      const expectedVal = (1.0 * (i + 1)) * 2.0 * K;
      for (let j = 0; j < 64; j++) {
        expect(outFloats[j]).to.be.closeTo(expectedVal, 1e-4);
      }
    });

    const recent = ipcServer.getRecentWorkloads();
    const parallelEvents = recent.filter(w => w.batchId === 'batch-001');
    expect(parallelEvents).to.have.lengthOf(numConcurrent);
    parallelEvents.forEach(e => {
      expect(e.status).to.equal('COMPLETE');
      expect(e.isForceSwarm).to.equal(true);
    });
  });
});
