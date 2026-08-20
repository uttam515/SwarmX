import { expect } from 'chai';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations';
import { TaskStore } from '../src/db/task_store';
import { TaskStatus } from '../src/types';

describe('TaskStore, DAG Validation, Leases & Crash Recovery Tests', () => {
  let db: Database.Database;
  let taskStore: TaskStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    taskStore = new TaskStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('Normal lifecycle: PENDING -> ASSIGNED -> RUNNING -> COMPLETED with atomic state transitions', () => {
    const task = taskStore.createTask({
      id: 'task-1',
      inputRef: 'data://input/1',
      computationDescriptor: 'test-descriptor',
      requiredResources: { minCpuCores: 2 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'data://output/1'
    });

    expect(task.status).to.equal(TaskStatus.PENDING);
    expect(task.retryCount).to.equal(0);

    // Assign
    const assigned = taskStore.assignTask('task-1', 'worker-apple-silicon', 10000);
    expect(assigned.status).to.equal(TaskStatus.ASSIGNED);
    expect(assigned.assignedWorkerId).to.equal('worker-apple-silicon');
    expect(assigned.leaseExpiresAtMs).to.be.greaterThan(Date.now());

    // Start
    const running = taskStore.startTask('task-1', 10000);
    expect(running.status).to.equal(TaskStatus.RUNNING);

    // Complete
    const completed = taskStore.completeTask('task-1', 'data://output/1/done');
    expect(completed.status).to.equal(TaskStatus.COMPLETED);
    expect(completed.resultDestination).to.equal('data://output/1/done');
    expect(completed.leaseExpiresAtMs).to.be.undefined;
  });

  it('DAG Cycle Detection: Rejects cyclic dependencies (A -> B -> C -> A) and self-dependencies', () => {
    // Self-dependency
    expect(() => {
      taskStore.createTask({
        id: 'self-task',
        inputRef: 'data://1',
        computationDescriptor: 'desc',
        requiredResources: {},
        dependencies: ['self-task'],
        executionConstraints: {},
        resultDestination: 'data://out'
      });
    }).to.throw(/cannot depend on itself/);

    // Create A
    taskStore.createTask({
      id: 'task-A',
      inputRef: 'data://A',
      computationDescriptor: 'desc',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'data://out'
    });

    // Create B depending on A (A -> B)
    taskStore.createTask({
      id: 'task-B',
      inputRef: 'data://B',
      computationDescriptor: 'desc',
      requiredResources: {},
      dependencies: ['task-A'],
      executionConstraints: {},
      resultDestination: 'data://out'
    });

    // Create C depending on B (B -> C)
    taskStore.createTask({
      id: 'task-C',
      inputRef: 'data://C',
      computationDescriptor: 'desc',
      requiredResources: {},
      dependencies: ['task-B'],
      executionConstraints: {},
      resultDestination: 'data://out'
    });

    // Attempt to add cycle: A depends on C (C -> A)
    expect(() => {
      taskStore.createTask({
        id: 'task-A-cycle',
        inputRef: 'data://A',
        computationDescriptor: 'desc',
        requiredResources: {},
        dependencies: ['task-C'],
        executionConstraints: {},
        resultDestination: 'data://out'
      });
      // Or if task-A had updated dependencies to task-C
      taskStore.validateDagCycle('task-A', ['task-C']);
    }).to.throw(/Cyclic dependency detected/);
  });

  it('Branching / Merging DAG: A -> B, A -> C, and B,C -> D (Diamond Graph)', () => {
    // 1. Create Diamond DAG
    taskStore.createTask({ id: 'A', inputRef: 'd://A', computationDescriptor: 'desc', requiredResources: {}, dependencies: [], executionConstraints: {}, resultDestination: 'd://out/A' });
    taskStore.createTask({ id: 'B', inputRef: 'd://B', computationDescriptor: 'desc', requiredResources: {}, dependencies: ['A'], executionConstraints: {}, resultDestination: 'd://out/B' });
    taskStore.createTask({ id: 'C', inputRef: 'd://C', computationDescriptor: 'desc', requiredResources: {}, dependencies: ['A'], executionConstraints: {}, resultDestination: 'd://out/C' });
    taskStore.createTask({ id: 'D', inputRef: 'd://D', computationDescriptor: 'desc', requiredResources: {}, dependencies: ['B', 'C'], executionConstraints: {}, resultDestination: 'd://out/D' });

    // Initial state: Only A is eligible for assignment
    expect(taskStore.areDependenciesSatisfied('A')).to.be.true;
    expect(taskStore.areDependenciesSatisfied('B')).to.be.false;
    expect(taskStore.areDependenciesSatisfied('C')).to.be.false;
    expect(taskStore.areDependenciesSatisfied('D')).to.be.false;

    // Run & complete A
    taskStore.assignTask('A', 'worker-1');
    taskStore.startTask('A');
    taskStore.completeTask('A');

    // Now B and C both become eligible
    expect(taskStore.areDependenciesSatisfied('B')).to.be.true;
    expect(taskStore.areDependenciesSatisfied('C')).to.be.true;
    expect(taskStore.areDependenciesSatisfied('D')).to.be.false; // D still blocked on B & C

    // Run & complete B
    taskStore.assignTask('B', 'worker-1');
    taskStore.startTask('B');
    taskStore.completeTask('B');
    expect(taskStore.areDependenciesSatisfied('D')).to.be.false; // Still blocked on C

    // Run & complete C
    taskStore.assignTask('C', 'worker-2');
    taskStore.startTask('C');
    taskStore.completeTask('C');

    // Now D dependencies are fully satisfied
    expect(taskStore.areDependenciesSatisfied('D')).to.be.true;
    taskStore.assignTask('D', 'worker-1');
    taskStore.startTask('D');
    const completedD = taskStore.completeTask('D');
    expect(completedD.status).to.equal(TaskStatus.COMPLETED);
  });

  it('Worker-Loss & Lease Recovery: Reclaims in-flight tasks when worker disconnects', () => {
    taskStore.createTask({ id: 'task-w1', inputRef: 'd://1', computationDescriptor: 'desc', requiredResources: {}, dependencies: [], executionConstraints: {}, resultDestination: 'd://out' });
    taskStore.assignTask('task-w1', 'worker-fragile');
    taskStore.startTask('task-w1');

    // Worker fragile disappears / disconnects
    const recovery = taskStore.recoverWorkerLoss('worker-fragile', 3);
    expect(recovery.recovered).to.have.lengthOf(1);
    expect(recovery.failed).to.have.lengthOf(0);

    const recovered = taskStore.getTask('task-w1')!;
    expect(recovered.status).to.equal(TaskStatus.PENDING);
    expect(recovered.retryCount).to.equal(1);
    expect(recovered.assignedWorkerId).to.be.undefined;
    expect(recovered.attemptHistory).to.have.lengthOf(1);
    expect(recovered.attemptHistory[0].reason).to.equal('WORKER_DISCONNECTED');

    // Task can now be assigned to healthy worker-2 and completed
    taskStore.assignTask('task-w1', 'worker-healthy');
    taskStore.startTask('task-w1');
    const done = taskStore.completeTask('task-w1');
    expect(done.status).to.equal(TaskStatus.COMPLETED);
  });

  it('Task Lease Expiration: Reclaims tasks after lease timeout expires', () => {
    const baseTime = Date.now();
    taskStore.createTask({ id: 'task-leased', inputRef: 'd://1', computationDescriptor: 'desc', requiredResources: {}, dependencies: [], executionConstraints: {}, resultDestination: 'd://out' });
    taskStore.assignTask('task-leased', 'worker-slow', 5000); // 5s lease

    // Before lease expiry: not recovered
    const early = taskStore.recoverExpiredLeases(baseTime + 1000, 3);
    expect(early.recovered).to.have.lengthOf(0);

    // After lease expiry (+6000ms): reclaimed
    const expired = taskStore.recoverExpiredLeases(baseTime + 6000, 3);
    expect(expired.recovered).to.have.lengthOf(1);
    expect(taskStore.getTask('task-leased')!.status).to.equal(TaskStatus.PENDING);
    expect(taskStore.getTask('task-leased')!.attemptHistory[0].reason).to.equal('LEASE_EXPIRED');
  });

  it('Host Crash Recovery: Survives process restart and increments retries or transitions to FAILED', () => {
    taskStore.createTask({ id: 'task-crash', inputRef: 'd://1', computationDescriptor: 'desc', requiredResources: {}, dependencies: [], executionConstraints: {}, resultDestination: 'd://out' });
    taskStore.assignTask('task-crash', 'worker-1');
    taskStore.startTask('task-crash');

    // Crash 1
    taskStore.recoverInFlightTasks(3);
    expect(taskStore.getTask('task-crash')!.status).to.equal(TaskStatus.PENDING);
    expect(taskStore.getTask('task-crash')!.retryCount).to.equal(1);

    // Crash 2
    taskStore.assignTask('task-crash', 'worker-2');
    taskStore.startTask('task-crash');
    taskStore.recoverInFlightTasks(3);
    expect(taskStore.getTask('task-crash')!.status).to.equal(TaskStatus.PENDING);
    expect(taskStore.getTask('task-crash')!.retryCount).to.equal(2);

    // Crash 3 (reaches max retries = 3 -> transitions to FAILED)
    taskStore.assignTask('task-crash', 'worker-3');
    taskStore.startTask('task-crash');
    const result3 = taskStore.recoverInFlightTasks(3);

    expect(result3.failed).to.have.lengthOf(1);
    expect(taskStore.getTask('task-crash')!.status).to.equal(TaskStatus.FAILED);
    expect(taskStore.getTask('task-crash')!.retryCount).to.equal(3);
  });

  it('Task Assignment Atomicity: Prevents race collisions on double assignment', () => {
    taskStore.createTask({ id: 'task-race', inputRef: 'd://1', computationDescriptor: 'desc', requiredResources: {}, dependencies: [], executionConstraints: {}, resultDestination: 'd://out' });

    // First assignment succeeds
    const a1 = taskStore.assignTask('task-race', 'worker-1');
    expect(a1.status).to.equal(TaskStatus.ASSIGNED);

    // Second assignment fails atomically
    expect(() => taskStore.assignTask('task-race', 'worker-2')).to.throw(/Cannot assign task in ASSIGNED state/);
  });

  it('Heartbeat Lease Renewal: Long-running task with active heartbeats is never expired', () => {
    const baseTime = Date.now();
    taskStore.createTask({ id: 'task-long-running', inputRef: 'd://1', computationDescriptor: 'desc', requiredResources: {}, dependencies: [], executionConstraints: {}, resultDestination: 'd://out' });
    taskStore.assignTask('task-long-running', 'worker-active', 5000); // 5s lease
    taskStore.startTask('task-long-running', 5000);

    // Simulate 4s elapsed: Heartbeat arrives at baseTime + 4000, extending lease for another 5s (expires at baseTime + 9000)
    const renewedCount = taskStore.renewWorkerLeases('worker-active', 5000, baseTime + 4000);
    expect(renewedCount).to.equal(1);

    // At t = baseTime + 6s: Without heartbeat, task would have expired at 5s.
    // With heartbeat renewal at t = 4s, new lease expires at t = 9s, so it is NOT reclaimed.
    const checkAt6s = taskStore.recoverExpiredLeases(baseTime + 6000, 3);
    expect(checkAt6s.recovered).to.have.lengthOf(0);
    expect(taskStore.getTask('task-long-running')!.status).to.equal(TaskStatus.RUNNING);

    // Task completes successfully
    const completed = taskStore.completeTask('task-long-running', 'd://out/success');
    expect(completed.status).to.equal(TaskStatus.COMPLETED);
  });
});
