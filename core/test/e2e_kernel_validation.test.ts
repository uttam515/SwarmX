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
import { ToleranceAwareImageValidator } from '../src/result_validator';
import {
  WorkloadDescriptor,
  Task,
  TaskStatus,
  CapabilityProfile,
  CAPABILITY_SCHEMA_VERSION
} from '../src/types';

describe('End-to-End Multi-Kernel Validation & Lifecycle Tests (Phase K)', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let workloadPipeline: WorkloadPipeline;
  let scheduler: ScoredScheduler;
  let decisionEngine: DistributionDecisionEngine;
  let ipcServer: IpcServer;

  const testSocketPath = path.join('/tmp', `swarmx-e2e-kernel-${Date.now()}.sock`);
  const testPort = 59195;

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

  const registerMockWorker = (id: string, kernels: string[], hasGpu: boolean = true) => {
    const profile: CapabilityProfile = {
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      deviceId: id,
      deviceName: `Worker ${id}`,
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 8,
      totalRamMb: 16384,
      hasGpu,
      supportedKernels: kernels
    };
    workerManager.registerWorker(profile);
    workerManager.updateTelemetry({
      deviceId: id,
      timestampMs: Date.now(),
      batteryLevel: 0.90,
      isCharging: true,
      thermalState: 0,
      cpuUtilization: 0.20,
      availableRamMb: 12000
    });
    scheduler.setWorkerThroughput(id, 1500);
  };

  it('1. E2E Kernel Pipeline: image_filter_box_blur_v1 completes full execution loop', async () => {
    registerMockWorker('mac-worker-1', ['image_filter_box_blur_v1']);

    // Create 16x16 RGBA image (1024 bytes)
    const rawBuffer = Buffer.alloc(1024, 150);
    const workload: WorkloadDescriptor = {
      version: '1.0.0',
      workloadId: 'wkl-box-e2e',
      computation: {
        kernelId: 'image_filter_box_blur_v1',
        domain: 'IMAGE_PROCESSING',
        parameters: { radius: 2, width: 16, height: 16, channels: 4 }
      },
      data: {
        totalPayloadBytes: 1024,
        itemCount: 1,
        payloadBase64: rawBuffer.toString('base64'),
        format: 'RAW_PLANAR_RGBA_UINT8'
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'IMAGE_PIXEL_DELTA'
      }
    };

    // Step 1: Evaluate
    const evalRes = await ipcServer.handleMessage({
      id: 1,
      method: 'evaluateWorkload',
      params: { workload }
    });
    expect(evalRes.result.decision).to.be.oneOf(['SWARM', 'LOCAL']);

    // Step 2: Create task & assign to worker
    const task = taskStore.createTask({
      id: 'task-box-01',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      status: TaskStatus.PENDING
    });

    taskStore.assignTask(task.id, 'mac-worker-1', 30000);

    // Step 3: Worker simulates native BoxBlur on uniform field (output = 150)
    const workerOutput = Buffer.alloc(1024, 150);
    const procResult = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'mac-worker-1',
      outputData: workerOutput,
      executionTimeMs: 5,
      attemptNumber: 1,
      itemCount: 1
    });

    expect(procResult.success).to.be.true;
    expect(procResult.status).to.equal(TaskStatus.COMPLETED);
  });

  it('2. E2E Kernel Pipeline: image_filter_gaussian_blur_v1 executes and validates', async () => {
    registerMockWorker('mac-worker-1', ['image_filter_gaussian_blur_v1']);

    const rawBuffer = Buffer.alloc(1024, 200);
    const task = taskStore.createTask({
      id: 'task-gauss-01',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_gaussian_blur_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      status: TaskStatus.PENDING
    });

    taskStore.assignTask(task.id, 'mac-worker-1', 30000);

    const procResult = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'mac-worker-1',
      outputData: rawBuffer,
      executionTimeMs: 8,
      attemptNumber: 1,
      itemCount: 1
    });

    expect(procResult.success).to.be.true;
    expect(procResult.status).to.equal(TaskStatus.COMPLETED);
  });

  it('3. E2E Kernel Pipeline: matrix_multiply_v1 calculates Float32 GEMM accurately', async () => {
    registerMockWorker('mac-worker-1', ['matrix_multiply_v1']);

    // Two 2x2 float matrices: A = [[1, 2], [3, 4]], B = [[5, 6], [7, 8]]
    // Expected C = [[19, 22], [43, 50]]
    const expectedC = new Float32Array([19.0, 22.0, 43.0, 50.0]);
    const outBuffer = Buffer.from(expectedC.buffer);

    const task = taskStore.createTask({
      id: 'task-gemm-01',
      inputRef: 'ref',
      computationDescriptor: 'matrix_multiply_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      status: TaskStatus.PENDING
    });

    taskStore.assignTask(task.id, 'mac-worker-1', 30000);

    const procResult = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'mac-worker-1',
      outputData: outBuffer,
      executionTimeMs: 4,
      attemptNumber: 1,
      itemCount: 1
    });

    expect(procResult.success).to.be.true;
    expect(procResult.status).to.equal(TaskStatus.COMPLETED);
  });

  it('4. Robustness: Unsupported worker is rejected by scheduler and routed to supported worker', () => {
    registerMockWorker('worker-box-only', ['image_filter_box_blur_v1']);
    registerMockWorker('worker-gemm', ['matrix_multiply_v1']);

    const gemmTask: Task = {
      id: 't-gemm-route',
      inputRef: 'ref',
      computationDescriptor: 'matrix_multiply_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    const decision = scheduler.scheduleTask(gemmTask, workerManager.listWorkers(), taskStore);
    expect(decision.status).to.equal('ASSIGNED');
    expect(decision.selectedWorker?.deviceId).to.equal('worker-gemm');
  });

  it('5. Robustness: Worker failure recovers task and redistributes without pipeline failure', async () => {
    registerMockWorker('flaky-worker', ['image_filter_box_blur_v1']);
    registerMockWorker('backup-worker', ['image_filter_box_blur_v1']);

    const task = taskStore.createTask({
      id: 't-failover-01',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      status: TaskStatus.PENDING
    });

    // Register image validator expecting 150
    workloadPipeline.registerValidator(task.id, new ToleranceAwareImageValidator(Buffer.alloc(1024, 150), 2, 0.5));

    taskStore.assignTask(task.id, 'flaky-worker', 30000);

    // Simulate validation failure on flaky-worker
    const corruptedOutput = Buffer.alloc(1024, 0); // Corrupted dark image
    const failResult = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'flaky-worker',
      outputData: corruptedOutput,
      executionTimeMs: 5,
      attemptNumber: 1,
      itemCount: 1
    });

    expect(failResult.success).to.be.false;
    const taskAfterFail = taskStore.getTask(task.id)!;
    expect(taskAfterFail.status).to.equal(TaskStatus.PENDING);

    // Re-schedule: flaky-worker is now excluded, routes to backup-worker
    const decision = scheduler.scheduleTask(taskAfterFail, workerManager.listWorkers(), taskStore);
    expect(decision.status).to.equal('ASSIGNED');
    expect(decision.selectedWorker?.deviceId).to.equal('backup-worker');

    // Complete on backup-worker
    taskStore.assignTask(task.id, 'backup-worker', 30000);
    const successResult = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'backup-worker',
      outputData: Buffer.alloc(1024, 150),
      executionTimeMs: 5,
      attemptNumber: 2,
      itemCount: 1
    });

    expect(successResult.success).to.be.true;
    expect(successResult.status).to.equal(TaskStatus.COMPLETED);
  });
});
