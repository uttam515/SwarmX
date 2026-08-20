import { expect } from 'chai';
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
import { KernelRegistry } from '../src/kernel_registry';
import { IpcServer } from '../src/ipc_server';
import { Task, TaskStatus } from '../src/types';

describe('Production Workload Pipeline & Multi-Kernel Extensibility (Phase J)', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let workloadPipeline: WorkloadPipeline;
  let scheduler: ScoredScheduler;
  let decisionEngine: DistributionDecisionEngine;
  let ipcServer: IpcServer;

  const testSocketPath = path.join('/tmp', `swarmx-prod-${Date.now()}.sock`);
  const testPort = 59190;

  beforeEach(async () => {
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

  it('1. Workload progress tracking reports completed chunks and percentage accurately', async () => {
    const workloadId = 'wkl-prog-01';
    workloadPipeline.registerWorkload(workloadId, 10);

    const task1 = taskStore.createTask({
      id: 't-prog-1',
      inputRef: 'ref',
      computationDescriptor: 'test_kernel',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      status: TaskStatus.PENDING
    });

    taskStore.assignTask(task1.id, 'worker-1', 30000);
    workloadPipeline.trackTaskInWorkload(workloadId, task1.id);

    const prog1 = workloadPipeline.getWorkloadProgress(workloadId)!;
    expect(prog1.totalChunks).to.equal(10);
    expect(prog1.completedChunks).to.equal(0);
    expect(prog1.inFlightChunks).to.equal(1);
    expect(prog1.percentComplete).to.equal(0);

    await workloadPipeline.handleTaskResult({
      taskId: task1.id,
      workerId: 'worker-1',
      outputData: 'res',
      executionTimeMs: 10,
      attemptNumber: 1,
      itemCount: 1
    });

    const prog2 = workloadPipeline.getWorkloadProgress(workloadId)!;
    expect(prog2.completedChunks).to.equal(1);
    expect(prog2.inFlightChunks).to.equal(0);
    expect(prog2.percentComplete).to.equal(10.0);
  });

  it('2. Workload cancellation gracefully abandons in-flight tasks', async () => {
    const workloadId = 'wkl-cancel-01';
    workloadPipeline.registerWorkload(workloadId, 5);

    const task = taskStore.createTask({
      id: 't-cancel-1',
      inputRef: 'ref',
      computationDescriptor: 'test_kernel',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      status: TaskStatus.PENDING
    });

    taskStore.assignTask(task.id, 'worker-1', 30000);
    workloadPipeline.trackTaskInWorkload(workloadId, task.id);

    let finishedStatus: TaskStatus | null = null;
    workloadPipeline.onTaskFinished(task.id, (res) => {
      finishedStatus = res.status;
    });

    const cancelled = workloadPipeline.cancelWorkload(workloadId);
    expect(cancelled).to.be.true;
    expect(finishedStatus).to.equal(TaskStatus.ABANDONED);

    const prog = workloadPipeline.getWorkloadProgress(workloadId)!;
    expect(prog.isCancelled).to.be.true;
    expect(prog.inFlightChunks).to.equal(0);
  });

  it('3. Multi-kernel registry certifies BoxBlur, GaussianBlur, and Matrix Multiplication', () => {
    const registry = KernelRegistry.getInstance();
    expect(registry.isCertified('image_filter_box_blur_v1')).to.be.true;
    expect(registry.isCertified('image_filter_gaussian_blur_v1')).to.be.true;
    expect(registry.isCertified('matrix_multiply_v1')).to.be.true;
    expect(registry.isCertified('uncertified_kernel')).to.be.false;

    const kernels = registry.listKernels();
    expect(kernels.length).to.be.at.least(3);
  });

  it('4. IPC Server exposes listKernels, getWorkloadProgress, and cancelWorkload endpoints', async () => {
    const listRes = await ipcServer.handleMessage({
      id: 1,
      method: 'listKernels',
      params: {}
    });
    expect(listRes.result).to.be.an('array');
    expect(listRes.result.some((k: any) => k.kernelId === 'image_filter_box_blur_v1')).to.be.true;

    workloadPipeline.registerWorkload('wkl-ipc-01', 4);
    const progRes = await ipcServer.handleMessage({
      id: 2,
      method: 'getWorkloadProgress',
      params: { workloadId: 'wkl-ipc-01' }
    });
    expect(progRes.result.totalChunks).to.equal(4);

    const cancelRes = await ipcServer.handleMessage({
      id: 3,
      method: 'cancelWorkload',
      params: { workloadId: 'wkl-ipc-01' }
    });
    expect(cancelRes.result.success).to.be.true;
  });
});
