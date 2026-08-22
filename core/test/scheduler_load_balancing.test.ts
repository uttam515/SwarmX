import 'mocha';
import { expect } from 'chai';
import { ScoredScheduler } from '../src/scheduler';
import { TaskStore } from '../src/db/task_store';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { WorkerState } from '../src/worker_manager';
import { Task, TaskStatus } from '../src/types';
import Database from 'better-sqlite3';

describe('Scheduler Dynamic In-Flight Load Balancing (Requirement 2 & Judge Spec)', () => {
  let scheduler: ScoredScheduler;
  let taskStore: TaskStore;
  let db: Database.Database;

  const createMockWorker = (id: string, name: string, cores: number): WorkerState => ({
    deviceId: id,
    capabilityProfile: {
      capabilitySchemaVersion: 1,
      deviceId: id,
      deviceName: name,
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: cores,
      totalRamMb: 16384,
      hasGpu: true,
      supportedKernels: ['video_frame_analysis_v1', 'matrix_multiply_v1']
    },
    latestTelemetry: {
      deviceId: id,
      timestampMs: Date.now(),
      batteryLevel: 0.95,
      isCharging: true,
      thermalState: 0,
      cpuUtilization: 0.10,
      availableRamMb: 12000,
      isEligible: true
    },
    isEligible: true,
    connectedAtMs: Date.now(),
    lastHeartbeatMs: Date.now(),
    liveState: {
      deviceId: id,
      deviceName: name,
      connectionState: 'CONNECTED',
      stage: 0 as any,
      completedChunks: 0,
      failedChunks: 0,
      retryCount: 0,
      pipelineStages: { fetching: false, decrypting: false, decoding: false, executing: false, transmitting: false },
      lastHeartbeatMs: Date.now(),
      isEligible: true
    }
  });

  const createTask = (id: string): Task => ({
    id,
    inputRef: 'inline',
    computationDescriptor: JSON.stringify({ kernelId: 'video_frame_analysis_v1', parameters: { width: 512, height: 512, frameCount: 30 } }),
    requiredResources: { minCpuCores: 1, minRamMb: 64 },
    dependencies: [],
    executionConstraints: {},
    resultDestination: 'memory',
    retryCount: 0,
    attemptHistory: [],
    status: TaskStatus.PENDING,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now()
  });

  beforeEach(() => {
    scheduler = new ScoredScheduler();
    db = createDatabase(':memory:');
    runMigrations(db);
    taskStore = new TaskStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('1. Distributes 3 sequential tasks across 3 distinct physical workers (round-robin)', () => {
    const workers = [
      createMockWorker('worker-01', "Uttam's MacBook Air", 8),
      createMockWorker('worker-02', "Jatin's MacBook Air", 8),
      createMockWorker('worker-03', 'Worker #3 MacBook Pro', 12)
    ];

    const t0 = taskStore.createTask(createTask('task-00'));
    const t1 = taskStore.createTask(createTask('task-01'));
    const t2 = taskStore.createTask(createTask('task-02'));

    // Step 1: Task 00 scheduled -> assigns to best idle worker
    const dec0 = scheduler.scheduleTask(t0, workers, taskStore);
    expect(dec0.status).to.equal('ASSIGNED');
    const w0 = dec0.selectedWorker!.deviceId;
    taskStore.assignTask(t0.id, w0, 30000);

    // Step 2: Task 01 scheduled -> in-flight penalty on w0 forces selection of an idle worker (w1 or w2)
    const dec1 = scheduler.scheduleTask(t1, workers, taskStore);
    expect(dec1.status).to.equal('ASSIGNED');
    const w1 = dec1.selectedWorker!.deviceId;
    expect(w1).to.not.equal(w0);
    taskStore.assignTask(t1.id, w1, 30000);

    // Step 3: Task 02 scheduled -> in-flight penalty on w0 & w1 forces selection of remaining idle worker
    const dec2 = scheduler.scheduleTask(t2, workers, taskStore);
    expect(dec2.status).to.equal('ASSIGNED');
    const w2 = dec2.selectedWorker!.deviceId;
    expect(w2).to.not.equal(w0);
    expect(w2).to.not.equal(w1);
    taskStore.assignTask(t2.id, w2, 30000);

    // Verify all 3 physical workers own exactly 1 active task
    expect(taskStore.getActiveTaskCountForWorker(w0)).to.equal(1);
    expect(taskStore.getActiveTaskCountForWorker(w1)).to.equal(1);
    expect(taskStore.getActiveTaskCountForWorker(w2)).to.equal(1);
  });

  it('2. Worker that finishes task immediately receives next queued task', () => {
    const workers = [
      createMockWorker('worker-01', "Uttam's MacBook Air", 8),
      createMockWorker('worker-02', "Jatin's MacBook Air", 8),
      createMockWorker('worker-03', 'Worker #3 MacBook Pro', 8)
    ];

    const t0 = taskStore.createTask(createTask('task-00'));
    const t1 = taskStore.createTask(createTask('task-01'));
    const t2 = taskStore.createTask(createTask('task-02'));
    const t3 = taskStore.createTask(createTask('task-03'));

    taskStore.assignTask(t0.id, 'worker-01', 30000);
    taskStore.assignTask(t1.id, 'worker-02', 30000);
    taskStore.assignTask(t2.id, 'worker-03', 30000);

    // Worker-02 completes its task first
    taskStore.completeTask(t1.id, 'memory://result-01');
    expect(taskStore.getActiveTaskCountForWorker('worker-02')).to.equal(0);
    expect(taskStore.getActiveTaskCountForWorker('worker-01')).to.equal(1);
    expect(taskStore.getActiveTaskCountForWorker('worker-03')).to.equal(1);

    // Next pending task (task-03) must be assigned to the newly idle worker-02
    const dec3 = scheduler.scheduleTask(t3, workers, taskStore);
    expect(dec3.status).to.equal('ASSIGNED');
    expect(dec3.selectedWorker!.deviceId).to.equal('worker-02');
  });
});
