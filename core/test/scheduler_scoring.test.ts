import { expect } from 'chai';
import { ScoredScheduler, DEFAULT_SCHEDULER_WEIGHTS } from '../src/scheduler';
import { WorkerState, WorkerManager } from '../src/worker_manager';
import { TaskStore } from '../src/db/task_store';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { Task, TaskStatus, ThermalState } from '../src/types';
import Database from 'better-sqlite3';

describe('ScoredScheduler & Starvation Lifecycle Tests', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let scheduler: ScoredScheduler;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskStore = new TaskStore(db);
    scheduler = new ScoredScheduler(DEFAULT_SCHEDULER_WEIGHTS);
  });

  afterEach(() => {
    db.close();
  });

  const createMockWorker = (
    deviceId: string,
    cores: number,
    ramMb: number,
    hasGpu: boolean,
    isEligible: boolean = true,
    cpuUtilization: number = 0.2,
    batteryLevel: number = 0.9
  ): WorkerState => ({
    deviceId,
    capabilityProfile: {
      capabilitySchemaVersion: 1,
      deviceId,
      deviceName: `Worker ${deviceId}`,
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: cores,
      totalRamMb: ramMb,
      hasGpu
    },
    latestTelemetry: {
      deviceId,
      timestampMs: Date.now(),
      batteryLevel,
      isCharging: false,
      thermalState: ThermalState.NOMINAL,
      cpuUtilization,
      availableRamMb: ramMb * 0.75,
      isEligible
    },
    isEligible,
    connectedAtMs: Date.now(),
    lastHeartbeatMs: Date.now()
  });

  it('Hard Eligibility Pre-Filter: Ineligible workers are completely excluded from candidate selection', () => {
    const fastIneligibleWorker = createMockWorker('fast-hot-mac', 16, 32768, true, false, 0.1, 0.95);
    const slowEligibleWorker = createMockWorker('slow-cool-mac', 4, 8192, false, true, 0.2, 0.80);

    const task: Task = {
      id: 'task-filter-01',
      inputRef: '/data/chunk.bin',
      computationDescriptor: 'img_filter',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/out/chunk.bin',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    const decision = scheduler.scheduleTask(task, [fastIneligibleWorker, slowEligibleWorker], taskStore);

    expect(decision.status).to.equal('ASSIGNED');
    expect(decision.selectedWorker).to.not.be.null;
    expect(decision.selectedWorker!.deviceId).to.equal('slow-cool-mac');

    // Asserts fast-hot-mac was not even scored
    expect(decision.candidateScores.some(c => c.workerId === 'fast-hot-mac')).to.be.false;
  });

  it('Deterministic Explainable Scoring: Ranks workers by w1..w4 and records component breakdown', () => {
    const workerA = createMockWorker('worker-a', 8, 16384, false, true, 0.10); // High capacity
    const workerB = createMockWorker('worker-b', 8, 16384, false, true, 0.85); // Low capacity (high CPU)

    scheduler.setWorkerThroughput('worker-a', 1500); // 1500 items/s
    scheduler.setWorkerThroughput('worker-b', 500);  // 500 items/s

    const task: Task = {
      id: 'task-score-01',
      inputRef: '/data/chunk.bin',
      computationDescriptor: 'img_filter',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/out/chunk.bin',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    const decision = scheduler.scheduleTask(task, [workerA, workerB], taskStore);

    expect(decision.status).to.equal('ASSIGNED');
    expect(decision.selectedWorker!.deviceId).to.equal('worker-a');

    const scoreA = decision.candidateScores.find(c => c.workerId === 'worker-a')!;
    const scoreB = decision.candidateScores.find(c => c.workerId === 'worker-b')!;

    expect(scoreA.finalScore).to.be.greaterThan(scoreB.finalScore);
    expect(scoreA.components.throughputScore).to.be.greaterThan(scoreB.components.throughputScore);
    expect(scoreA.components.capacityScore).to.be.greaterThan(scoreB.components.capacityScore);
  });

  it('Task-Specific Exclusions: Worker excluded on Task A remains eligible for Task B', () => {
    const workerA = createMockWorker('worker-a', 8, 16384, true, true);
    const workerB = createMockWorker('worker-b', 8, 16384, false, true);

    const taskA = taskStore.createTask({
      id: 'task-a',
      inputRef: '/data/a.bin',
      computationDescriptor: 'kernel_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/out/a.bin'
    });

    const taskB = taskStore.createTask({
      id: 'task-b',
      inputRef: '/data/b.bin',
      computationDescriptor: 'kernel_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/out/b.bin'
    });

    // 1. Worker A fails validation on Task A
    taskStore.recordTaskFailure(taskA.id, 'worker-a', 'VALIDATION_TOLERANCE_EXCEEDED');

    // 2. Scheduling Task A excludes Worker A and selects Worker B
    const decisionA = scheduler.scheduleTask(taskStore.getTask(taskA.id)!, [workerA, workerB], taskStore);
    expect(decisionA.status).to.equal('ASSIGNED');
    expect(decisionA.selectedWorker!.deviceId).to.equal('worker-b');
    expect(decisionA.candidateScores.find(c => c.workerId === 'worker-a')!.isExcludedForTask).to.be.true;

    // 3. Scheduling Task B: Worker A is NOT excluded and is selected due to GPU capability
    const decisionB = scheduler.scheduleTask(taskStore.getTask(taskB.id)!, [workerA, workerB], taskStore);
    expect(decisionB.status).to.equal('ASSIGNED');
    expect(decisionB.selectedWorker!.deviceId).to.equal('worker-a');
    expect(decisionB.candidateScores.find(c => c.workerId === 'worker-a')!.isExcludedForTask).to.be.false;
  });

  it('Starvation Handling vs Waiting: Distinguishes NO_ELIGIBLE_WORKER_REMAINING from WAITING_FOR_ELIGIBLE_WORKER', () => {
    const workerA = createMockWorker('worker-a', 4, 8192, false, true);
    const workerB = createMockWorker('worker-b', 4, 8192, false, true);

    const task = taskStore.createTask({
      id: 'task-starve-01',
      inputRef: '/data/chunk.bin',
      computationDescriptor: 'kernel_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/out/chunk.bin'
    });

    // Scenario 1: Swarm empty / workers temporarily ineligible -> WAITING_FOR_ELIGIBLE_WORKER
    const waitingDecision = scheduler.scheduleTask(task, [], taskStore);
    expect(waitingDecision.status).to.equal('WAITING_FOR_ELIGIBLE_WORKER');
    expect(waitingDecision.selectedWorker).to.be.null;

    // Scenario 2: Both workers fail validation on this task -> Excluded from all candidates
    taskStore.recordTaskFailure(task.id, 'worker-a', 'VALIDATION_TOLERANCE_EXCEEDED');
    taskStore.recordTaskFailure(task.id, 'worker-b', 'VALIDATION_TOLERANCE_EXCEEDED');

    const starvedDecision = scheduler.scheduleTask(taskStore.getTask(task.id)!, [workerA, workerB], taskStore);
    expect(starvedDecision.status).to.equal('NO_ELIGIBLE_WORKER_REMAINING');
    expect(starvedDecision.selectedWorker).to.be.null;
    expect(starvedDecision.candidateScores.every(c => c.isExcludedForTask)).to.be.true;
  });
});
