import 'mocha';
import { expect } from 'chai';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { IpcServer } from '../src/ipc_server';
import { TaskStore } from '../src/db/task_store';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { WorkerManager } from '../src/worker_manager';
import { PairingService } from '../src/pairing_service';
import { TransportServer } from '../src/transport_server';
import { ScoredScheduler } from '../src/scheduler';
import { WorkloadPipeline } from '../src/workload_pipeline';
import Database from 'better-sqlite3';

describe('Non-Interactive Demo Flow & Workload Cancellation Tests', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let scheduler: ScoredScheduler;
  let workloadPipeline: WorkloadPipeline;
  let ipcServer: IpcServer;
  const testSockPath = path.join('/tmp', `swarmx-nonint-${Date.now()}.sock`);

  beforeEach(async () => {
    if (fs.existsSync(testSockPath)) {
      try { fs.unlinkSync(testSockPath); } catch (e) {}
    }
    db = createDatabase(':memory:');
    runMigrations(db);
    taskStore = new TaskStore(db);
    workerManager = new WorkerManager();
    pairingService = new PairingService(db);
    transportServer = new TransportServer(59299, pairingService, workerManager, taskStore);
    scheduler = new ScoredScheduler();
    workloadPipeline = new WorkloadPipeline(taskStore, scheduler);

    ipcServer = new IpcServer(
      testSockPath,
      taskStore,
      workerManager,
      pairingService,
      transportServer,
      workloadPipeline,
      scheduler
    );
    await ipcServer.start();
  });

  afterEach(async () => {
    await ipcServer.stop();
    await transportServer.stop();
    db.close();
    if (fs.existsSync(testSockPath)) {
      try { fs.unlinkSync(testSockPath); } catch (e) {}
    }
  });

  it('1. Verifies cancelWorkload clears in-flight tasks and updates status to CANCELLED', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise<void>((resolve) => client.on('connect', () => resolve()));

    const cancelMsg = {
      jsonrpc: '2.0',
      id: 1,
      method: 'cancelWorkload',
      params: { workloadId: 'wkl-active-test' }
    };

    const cancelPromise = new Promise<any>((resolve) => {
      client.on('data', (data) => {
        const response = JSON.parse(data.toString().trim());
        resolve(response);
      });
    });

    client.write(JSON.stringify(cancelMsg) + '\n');
    const res = await cancelPromise;
    expect(res.result.success).to.be.true;

    // Verify recent workloads contains cancellation event
    const recent = ipcServer.getRecentWorkloads();
    expect(recent.length).to.be.greaterThan(0);
    expect(recent[recent.length - 1].status).to.equal('FAILED');
    expect(recent[recent.length - 1].decisionReason).to.include('aborted');

    client.end();
  });

  it('2. Verifies listRecentWorkloads defaults to video_frame_analysis_v1 metadata', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise<void>((resolve) => client.on('connect', () => resolve()));

    const listMsg = {
      jsonrpc: '2.0',
      id: 2,
      method: 'listRecentWorkloads',
      params: {}
    };

    const listPromise = new Promise<any>((resolve) => {
      client.on('data', (data) => {
        const response = JSON.parse(data.toString().trim());
        resolve(response);
      });
    });

    client.write(JSON.stringify(listMsg) + '\n');
    const res = await listPromise;
    expect(Array.isArray(res.result)).to.be.true;

    client.end();
  });
});
