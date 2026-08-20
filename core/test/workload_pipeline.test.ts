import { expect } from 'chai';
import { WorkloadPipeline } from '../src/workload_pipeline';
import { ScoredScheduler } from '../src/scheduler';
import { TaskStore } from '../src/db/task_store';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { ToleranceAwareImageValidator, ToleranceAwareNumericValidator } from '../src/result_validator';
import { Task, TaskStatus } from '../src/types';
import Database from 'better-sqlite3';

describe('WorkloadPipeline & Tolerance-Aware Streaming Validation Tests', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let scheduler: ScoredScheduler;
  let pipeline: WorkloadPipeline;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskStore = new TaskStore(db);
    scheduler = new ScoredScheduler();
    pipeline = new WorkloadPipeline(taskStore, scheduler);
  });

  afterEach(() => {
    db.close();
  });

  it('Streaming Result Validation: Valid result completes task and updates throughput telemetry', async () => {
    const task = taskStore.createTask({
      id: 'task-val-01',
      inputRef: '/data/images_chunk_01.bin',
      computationDescriptor: 'img_blur',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/data/out/images_chunk_01.bin'
    });

    taskStore.assignTask(task.id, 'worker-mac-01', 30000);

    // Register numeric validator with reference outputs [10.0, 20.0, 30.0]
    pipeline.registerValidator('task-val-01', new ToleranceAwareNumericValidator([10.0, 20.0, 30.0], 0.05));

    // Worker returns slightly divergent but acceptable output [10.02, 19.98, 30.01] (delta <= 0.05)
    const validOutput = JSON.stringify([10.02, 19.98, 30.01]);

    const result = await pipeline.handleTaskResult({
      taskId: 'task-val-01',
      workerId: 'worker-mac-01',
      outputData: validOutput,
      executionTimeMs: 500,
      itemCount: 100 // 200 items/sec
    });

    expect(result.success).to.be.true;
    expect(result.status).to.equal(TaskStatus.COMPLETED);

    const completed = taskStore.getTask('task-val-01');
    expect(completed!.status).to.equal(TaskStatus.COMPLETED);
  });

  it('Cross-Hardware Image Tolerance Validation: Validates pixel deltas within tolerance (delta <= 2, MSE <= 0.5)', async () => {
    const task = taskStore.createTask({
      id: 'task-img-01',
      inputRef: '/data/chunk_img.bin',
      computationDescriptor: 'img_sobel',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/data/out/chunk_img.bin'
    });
    taskStore.assignTask(task.id, 'worker-arm-01', 30000);

    const referencePixels = Buffer.from([100, 150, 200, 250]);
    pipeline.registerValidator('task-img-01', new ToleranceAwareImageValidator(referencePixels, 2, 0.5));

    // ARM NEON worker returns pixel buffer with delta = 1 on one byte (e.g. 101 instead of 100) -> Pass
    const slightlyDivergentPixels = Buffer.from([101, 150, 200, 250]);

    const result = await pipeline.handleTaskResult({
      taskId: 'task-img-01',
      workerId: 'worker-arm-01',
      outputData: slightlyDivergentPixels,
      executionTimeMs: 200
    });

    expect(result.success).to.be.true;
    expect(result.status).to.equal(TaskStatus.COMPLETED);
    expect(result.validationDetails.maxPixelDelta).to.equal(1);
  });

  it('Tolerance Validation Failure: Records failure in attempt_history and resets task for redistribution', async () => {
    const task = taskStore.createTask({
      id: 'task-fail-01',
      inputRef: '/data/chunk_img.bin',
      computationDescriptor: 'img_sobel',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/data/out/chunk_img.bin'
    });
    taskStore.assignTask(task.id, 'worker-buggy-01', 30000);

    const referencePixels = Buffer.from([100, 150, 200, 250]);
    pipeline.registerValidator('task-fail-01', new ToleranceAwareImageValidator(referencePixels, 2, 0.5));

    // Buggy output: delta = 20 (exceeds tolerance 2)
    const corruptedPixels = Buffer.from([120, 150, 200, 250]);

    const result = await pipeline.handleTaskResult({
      taskId: 'task-fail-01',
      workerId: 'worker-buggy-01',
      outputData: corruptedPixels,
      executionTimeMs: 150
    });

    expect(result.success).to.be.false;
    expect(result.status).to.equal(TaskStatus.PENDING); // Reset to PENDING for reallocation
    expect(result.error).to.include('Image tolerance exceeded');

    // Asserts attempt history records failure and worker ID
    const failedTask = taskStore.getTask('task-fail-01')!;
    expect(failedTask.retryCount).to.equal(1);
    expect(failedTask.attemptHistory).to.have.lengthOf(1);
    expect(failedTask.attemptHistory[0].workerId).to.equal('worker-buggy-01');
    expect(failedTask.attemptHistory[0].reason).to.equal('VALIDATION_TOLERANCE_EXCEEDED');

    // Asserts worker is now in task's exclusion list
    expect(taskStore.getExcludedWorkerIds(task.id)).to.deep.equal(['worker-buggy-01']);
  });

  it('Tolerance Validation Reallocation & Completion: Task redistributed to healthy worker completes successfully', async () => {
    const task = taskStore.createTask({
      id: 'task-retry-01',
      inputRef: '/data/chunk.bin',
      computationDescriptor: 'numeric_kernel',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/out/chunk.bin'
    });

    pipeline.registerValidator('task-retry-01', new ToleranceAwareNumericValidator([50, 100, 150], 0.1));

    // Attempt 1: Worker 1 fails validation
    taskStore.assignTask(task.id, 'worker-01', 30000);
    const failRes = await pipeline.handleTaskResult({
      taskId: 'task-retry-01',
      workerId: 'worker-01',
      outputData: JSON.stringify([99, 100, 150]), // First element 99 vs 50 -> Fails
      executionTimeMs: 100
    });
    expect(failRes.success).to.be.false;
    expect(taskStore.getTask(task.id)!.status).to.equal(TaskStatus.PENDING);

    // Attempt 2: Reassigned to Worker 2 -> Produces valid output
    taskStore.assignTask(task.id, 'worker-02', 30000);
    const successRes = await pipeline.handleTaskResult({
      taskId: 'task-retry-01',
      workerId: 'worker-02',
      outputData: JSON.stringify([50.01, 99.99, 150.02]),
      executionTimeMs: 80
    });
    expect(successRes.success).to.be.true;
    expect(successRes.status).to.equal(TaskStatus.COMPLETED);

    const finalTask = taskStore.getTask(task.id)!;
    expect(finalTask.status).to.equal(TaskStatus.COMPLETED);
    expect(finalTask.retryCount).to.equal(1);
    expect(finalTask.attemptHistory).to.have.lengthOf(1);
    expect(finalTask.attemptHistory[0].workerId).to.equal('worker-01');
  });

  it('Concurrency Invariant: Late result from superseded worker / attempt is rejected without completing newer attempt', async () => {
    const task = taskStore.createTask({
      id: 'task-late-result-01',
      inputRef: '/data/chunk.bin',
      computationDescriptor: 'img_filter',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/out/chunk.bin'
    });

    // 1. Task assigned to Worker 1 (Attempt 1)
    taskStore.assignTask(task.id, 'worker-slow-01', 30000);

    // 2. Worker 1 disconnects / expires -> Recovered to PENDING
    taskStore.recordTaskFailure(task.id, 'worker-slow-01', 'WORKER_DISCONNECTED');
    expect(taskStore.getTask(task.id)!.status).to.equal(TaskStatus.PENDING);

    // 3. Task reassigned to Worker 2 (Attempt 2)
    taskStore.assignTask(task.id, 'worker-fast-02', 30000);
    expect(taskStore.getTask(task.id)!.status).to.equal(TaskStatus.ASSIGNED);
    expect(taskStore.getTask(task.id)!.assignedWorkerId).to.equal('worker-fast-02');

    // 4. Late result arrives from Worker 1 (Attempt 1) with valid data
    const lateRes = await pipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'worker-slow-01',
      outputData: 'valid_data_from_slow_worker',
      executionTimeMs: 45000,
      attemptNumber: 1 // Attempt 1 (stale, task is on Attempt 2)
    });

    // Invariant Assertions:
    // a. Late result is rejected with STALE_ATTEMPT_IGNORED
    expect(lateRes.success).to.be.false;
    expect(lateRes.error).to.include('STALE_ATTEMPT_IGNORED');

    // b. Task state remains ASSIGNED to Worker 2 (NOT completed prematurely by Worker 1)
    const currentTask = taskStore.getTask(task.id)!;
    expect(currentTask.status).to.equal(TaskStatus.ASSIGNED);
    expect(currentTask.assignedWorkerId).to.equal('worker-fast-02');

    // 5. Worker 2 delivers actual result for Attempt 2
    const worker2Res = await pipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'worker-fast-02',
      outputData: 'valid_data_from_fast_worker',
      executionTimeMs: 300,
      attemptNumber: 2
    });

    expect(worker2Res.success).to.be.true;
    expect(worker2Res.status).to.equal(TaskStatus.COMPLETED);
    expect(taskStore.getTask(task.id)!.status).to.equal(TaskStatus.COMPLETED);
  });
});
