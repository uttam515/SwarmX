import { expect } from 'chai';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { TaskStore } from '../src/db/task_store';
import { WorkloadPipeline } from '../src/workload_pipeline';
import { ScoredScheduler } from '../src/scheduler';
import { WorkStealer } from '../src/work_stealer';
import { Task, TaskStatus } from '../src/types';

describe('Adaptive Chunking & Straggler Work-Stealing (Milestone 2.2)', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let scheduler: ScoredScheduler;
  let workloadPipeline: WorkloadPipeline;
  let workStealer: WorkStealer;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskStore = new TaskStore(db);
    scheduler = new ScoredScheduler();
    workloadPipeline = new WorkloadPipeline(taskStore, scheduler);
    workStealer = new WorkStealer({
      detectionThresholdMultiplier: 2.5,
      minObservationsBeforeDeclaration: 2,
      minDurationMsThreshold: 50,
      enableWorkStealing: true
    });
  });

  afterEach(() => {
    db.close();
  });

  const createAssignedTask = (id: string, workerId: string): Task => {
    const task = taskStore.createTask({
      id,
      inputRef: `ref-${id}`,
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      status: TaskStatus.PENDING
    });
    return taskStore.assignTask(task.id, workerId, 30000);
  };

  it('1. Equal-speed workers complete without triggering false straggler stealing', () => {
    workStealer.recordTaskCompletion('t0', 'worker-a', 40);
    workStealer.recordTaskCompletion('t1', 'worker-a', 42);
    workStealer.recordTaskCompletion('t2', 'worker-b', 39);
    workStealer.recordTaskCompletion('t3', 'worker-b', 41);

    const task = createAssignedTask('t-equal-1', 'worker-a');
    workStealer.recordTaskStart(task.id, 'worker-a', 40);

    const evalRes = workStealer.isTaskStraggling(task.id, Date.now() + 60); // 60ms < 2.5 * 40 = 100ms
    expect(evalRes.isStraggler).to.be.false;

    const stealRes = workStealer.attemptSteal('worker-b', taskStore);
    expect(stealRes.stolen).to.be.false;
  });

  it('2. Heterogeneous worker speeds maintain separate moving averages', () => {
    // Fast Mac GPU (20ms) vs Slow CPU (100ms)
    workStealer.recordTaskCompletion('t-f1', 'mac-gpu', 20);
    workStealer.recordTaskCompletion('t-f2', 'mac-gpu', 22);
    workStealer.recordTaskCompletion('t-s1', 'win-cpu', 100);
    workStealer.recordTaskCompletion('t-s2', 'win-cpu', 105);

    expect(workStealer.getWorkerAvgDurationMs('mac-gpu')!).to.be.lessThan(30);
    expect(workStealer.getWorkerAvgDurationMs('win-cpu')!).to.be.greaterThan(90);
  });

  it('3. Worker becomes 10x slower mid-workload and is stolen by fast worker', () => {
    workStealer.recordTaskCompletion('t-w1', 'worker-slow', 50);
    workStealer.recordTaskCompletion('t-w2', 'worker-slow', 50);

    const task = createAssignedTask('t-straggler-01', 'worker-slow');
    workStealer.recordTaskStart(task.id, 'worker-slow', 50);

    // Simulate 10x slowdown: elapsed 500ms > 2.5 * 50 = 125ms
    const simulatedNow = Date.now() + 500;
    const isStraggler = workStealer.isTaskStraggling(task.id, simulatedNow);
    expect(isStraggler.isStraggler).to.be.true;

    // Fast worker-fast steals task
    const stealResult = workStealer.attemptSteal('worker-fast', taskStore, simulatedNow);
    expect(stealResult.stolen).to.be.true;
    expect(stealResult.thiefWorkerId).to.equal('worker-fast');
    expect(stealResult.victimWorkerId).to.equal('worker-slow');

    // DB state updated with incremented retryCount
    const updatedTask = taskStore.getTask(task.id)!;
    expect(updatedTask.assignedWorkerId).to.equal('worker-fast');
    expect(updatedTask.retryCount).to.equal(1);
  });

  it('4. Worker gradually slows down and triggers straggler threshold via EMA', () => {
    workStealer.recordTaskCompletion('t1', 'worker-decay', 50);
    workStealer.recordTaskCompletion('t2', 'worker-decay', 80);
    workStealer.recordTaskCompletion('t3', 'worker-decay', 120);
    workStealer.recordTaskCompletion('t4', 'worker-decay', 160);

    const task = createAssignedTask('t-decay-1', 'worker-decay');
    workStealer.recordTaskStart(task.id, 'worker-decay', 50);

    const evalRes = workStealer.isTaskStraggling(task.id, Date.now() + 350);
    expect(evalRes.isStraggler).to.be.true;
  });

  it('5. Worker disappears while chunk is stealable -> Stolen and completed on healthy worker', async () => {
    workStealer.recordTaskCompletion('t1', 'crashed-worker', 50);
    workStealer.recordTaskCompletion('t2', 'crashed-worker', 50);

    const task = createAssignedTask('t-crash-steal', 'crashed-worker');
    workStealer.recordTaskStart(task.id, 'crashed-worker', 50);

    const steal = workStealer.attemptSteal('healthy-worker', taskStore, Date.now() + 200);
    expect(steal.stolen).to.be.true;

    // Complete on healthy-worker
    const res = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'healthy-worker',
      outputData: 'valid_data',
      executionTimeMs: 20,
      attemptNumber: 2,
      itemCount: 1
    });

    expect(res.success).to.be.true;
    expect(res.status).to.equal(TaskStatus.COMPLETED);
  });

  it('6. Race condition: Task completes just before steal commit -> Steal fails gracefully', () => {
    const task = createAssignedTask('t-race-1', 'worker-a');
    workStealer.recordTaskStart(task.id, 'worker-a', 50);

    // Worker A completes task in DB
    taskStore.completeTask(task.id, 'output_from_a');

    // Worker B attempts steal on already-completed task
    const steal = taskStore.stealTask(task.id, 'worker-b');
    expect(steal.success).to.be.false;
    expect(steal.reason).to.include('not in-flight');

    const finalTask = taskStore.getTask(task.id)!;
    expect(finalTask.status).to.equal(TaskStatus.COMPLETED);
    expect(finalTask.assignedWorkerId).to.equal('worker-a');
  });

  it('7. Duplicate completion rejection: Second completion attempt is rejected', async () => {
    const task = createAssignedTask('t-dup-1', 'worker-a');
    
    const res1 = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'worker-a',
      outputData: 'res1',
      executionTimeMs: 10,
      attemptNumber: 1
    });
    expect(res1.success).to.be.true;

    // Second duplicate completion attempt
    const res2 = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'worker-a',
      outputData: 'res2',
      executionTimeMs: 10,
      attemptNumber: 1
    });
    expect(res2.success).to.be.false;
  });

  it('8. Late result from previous attempt (pre-steal) is rejected with STALE_ATTEMPT_IGNORED', async () => {
    const task = createAssignedTask('t-stale-steal', 'worker-slow');
    workStealer.recordTaskStart(task.id, 'worker-slow', 50);

    // Steal occurs: worker-fast takes attempt 2
    taskStore.stealTask(task.id, 'worker-fast');

    // Slow worker finishes late and sends Attempt 1
    const lateRes = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'worker-slow',
      outputData: 'late_output',
      executionTimeMs: 500,
      attemptNumber: 1
    });

    expect(lateRes.success).to.be.false;
    expect(lateRes.error).to.include('STALE_ATTEMPT_IGNORED');

    // Worker Fast finishes Attempt 2
    const validRes = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'worker-fast',
      outputData: 'valid_fast_output',
      executionTimeMs: 25,
      attemptNumber: 2
    });

    expect(validRes.success).to.be.true;
    expect(validRes.status).to.equal(TaskStatus.COMPLETED);
  });

  it('9. Multiple simultaneous stragglers are stolen in order of longest elapsed time', () => {
    workStealer.recordTaskCompletion('t1', 'slow-1', 40);
    workStealer.recordTaskCompletion('t2', 'slow-1', 40);
    workStealer.recordTaskCompletion('t3', 'slow-2', 40);
    workStealer.recordTaskCompletion('t4', 'slow-2', 40);

    const task1 = createAssignedTask('t-strag-old', 'slow-1');
    const task2 = createAssignedTask('t-strag-newer', 'slow-2');

    workStealer.recordTaskStart(task1.id, 'slow-1', 40);
    workStealer.recordTaskStart(task2.id, 'slow-2', 40);

    // Set task1 elapsed to 500ms and task2 to 200ms
    const now = Date.now();
    (workStealer as any).inFlightTasks.get(task1.id).startTimeMs = now - 500;
    (workStealer as any).inFlightTasks.get(task2.id).startTimeMs = now - 200;

    const steal1 = workStealer.attemptSteal('fast-node', taskStore);
    expect(steal1.stolen).to.be.true;
    expect(steal1.taskId).to.equal('t-strag-old'); // Oldest straggler stolen first
  });

  it('10. All workers become slow -> Does not trigger self-stealing or infinite loop', () => {
    workStealer.recordTaskCompletion('t1', 'slow-only', 300);
    workStealer.recordTaskCompletion('t2', 'slow-only', 300);

    const task = createAssignedTask('t-slow-all', 'slow-only');
    workStealer.recordTaskStart(task.id, 'slow-only', 300);

    // Worker slow-only cannot steal its own task
    const steal = workStealer.attemptSteal('slow-only', taskStore);
    expect(steal.stolen).to.be.false;
  });

  it('11. Single-worker workload: Stealing is disabled or returns no candidates', () => {
    const task = createAssignedTask('t-single-1', 'lone-worker');
    workStealer.recordTaskStart(task.id, 'lone-worker', 50);

    const steal = workStealer.attemptSteal('lone-worker', taskStore);
    expect(steal.stolen).to.be.false;
  });

  it('12. Small workload below minDurationMsThreshold prevents premature jitter stealing', () => {
    workStealer.recordTaskCompletion('t1', 'worker-a', 5);
    workStealer.recordTaskCompletion('t2', 'worker-a', 5);

    const task = createAssignedTask('t-micro-1', 'worker-a');
    workStealer.recordTaskStart(task.id, 'worker-a', 5);

    // Elapsed 20ms is 4x baseline (5ms), but below minDurationMsThreshold (50ms)
    const evalRes = workStealer.isTaskStraggling(task.id, Date.now() + 20);
    expect(evalRes.isStraggler).to.be.false;
  });
});
