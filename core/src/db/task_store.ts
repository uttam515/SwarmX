import Database from 'better-sqlite3';
import { Task, TaskStatus, TaskAttempt } from '../types';

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_LEASE_DURATION_MS = 30000; // 30s default lease

export class TaskStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Validates that adding a new task with given dependencies does not introduce cycles into the DAG.
   * Throws an error if a cycle is detected.
   */
  public validateDagCycle(newTaskId: string, dependencies: string[]): void {
    if (!dependencies || dependencies.length === 0) return;

    if (dependencies.includes(newTaskId)) {
      throw new Error(`Cyclic dependency detected: Task ${newTaskId} cannot depend on itself`);
    }

    // Build adjacency list: child -> parents
    const adj = new Map<string, string[]>();
    const allTasks = this.listTasks();
    for (const t of allTasks) {
      adj.set(t.id, [...t.dependencies]);
    }
    adj.set(newTaskId, [...dependencies]);

    // Check reachability from each parent back to newTaskId using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (node: string, path: string[]): boolean => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const parents = adj.get(node) || [];
      for (const parent of parents) {
        if (!visited.has(parent)) {
          if (hasCycle(parent, path)) return true;
        } else if (recursionStack.has(parent)) {
          path.push(parent);
          return true;
        }
      }

      recursionStack.delete(node);
      path.pop();
      return false;
    };

    const cyclePath: string[] = [];
    if (hasCycle(newTaskId, cyclePath)) {
      throw new Error(`Cyclic dependency detected in task graph: ${cyclePath.join(' -> ')}`);
    }
  }

  public createTask(task: Omit<Task, 'retryCount' | 'attemptHistory' | 'status' | 'createdAtMs' | 'updatedAtMs'> & { status?: TaskStatus }): Task {
    const dependencies = task.dependencies || [];
    this.validateDagCycle(task.id, dependencies);

    const now = Date.now();
    const fullTask: Task = {
      id: task.id,
      inputRef: task.inputRef,
      computationDescriptor: task.computationDescriptor,
      requiredResources: task.requiredResources || {},
      dependencies,
      executionConstraints: task.executionConstraints || {},
      resultDestination: task.resultDestination || '',
      retryCount: 0,
      attemptHistory: [],
      status: task.status || TaskStatus.PENDING,
      assignedWorkerId: task.assignedWorkerId,
      leaseExpiresAtMs: null,
      createdAtMs: now,
      updatedAtMs: now
    };

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, status, input_ref, computation_descriptor,
        required_resources_json, dependencies_json, execution_constraints_json,
        result_destination, retry_count, attempt_history_json,
        assigned_worker_id, lease_expires_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      fullTask.id,
      fullTask.status,
      fullTask.inputRef,
      fullTask.computationDescriptor,
      JSON.stringify(fullTask.requiredResources),
      JSON.stringify(fullTask.dependencies),
      JSON.stringify(fullTask.executionConstraints),
      fullTask.resultDestination,
      fullTask.retryCount,
      JSON.stringify(fullTask.attemptHistory),
      fullTask.assignedWorkerId || null,
      fullTask.leaseExpiresAtMs || null,
      fullTask.createdAtMs,
      fullTask.updatedAtMs
    );

    return fullTask;
  }

  public getTask(id: string): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return this.mapRowToTask(row);
  }

  public listTasks(filterStatus?: TaskStatus): Task[] {
    let stmt: Database.Statement;
    if (filterStatus) {
      stmt = this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at_ms ASC');
      return (stmt.all(filterStatus) as any[]).map(r => this.mapRowToTask(r));
    } else {
      stmt = this.db.prepare('SELECT * FROM tasks ORDER BY created_at_ms ASC');
      return (stmt.all() as any[]).map(r => this.mapRowToTask(r));
    }
  }

  public areDependenciesSatisfied(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    if (task.dependencies.length === 0) return true;

    const placeholders = task.dependencies.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT count(*) as count FROM tasks 
      WHERE id IN (${placeholders}) AND status = ?
    `);
    const result = stmt.get(...task.dependencies, TaskStatus.COMPLETED) as { count: number };
    return result.count === task.dependencies.length;
  }

  /**
   * Transactionally safe atomic task assignment.
   */
  public assignTask(taskId: string, workerId: string, leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS): Task {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (task.status !== TaskStatus.PENDING) {
        throw new Error(`Invalid state transition: Cannot assign task in ${task.status} state`);
      }
      if (!this.areDependenciesSatisfied(taskId)) {
        throw new Error(`Cannot assign task ${taskId}: DAG dependencies are not yet satisfied`);
      }

      const now = Date.now();
      const leaseExpiresAtMs = now + leaseDurationMs;
      
      const stmt = this.db.prepare(`
        UPDATE tasks 
        SET status = ?, assigned_worker_id = ?, lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = ?
      `);
      const result = stmt.run(TaskStatus.ASSIGNED, workerId, leaseExpiresAtMs, now, taskId, TaskStatus.PENDING);
      if (result.changes === 0) {
        throw new Error(`Concurrent assignment collision or invalid state for task ${taskId}`);
      }

      return this.getTask(taskId)!;
    })();
  }

  public startTask(taskId: string, leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS): Task {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (task.status !== TaskStatus.ASSIGNED) {
        throw new Error(`Invalid state transition: Cannot start task in ${task.status} state`);
      }

      const now = Date.now();
      const leaseExpiresAtMs = now + leaseDurationMs;

      const stmt = this.db.prepare(`
        UPDATE tasks 
        SET status = ?, lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = ?
      `);
      const result = stmt.run(TaskStatus.RUNNING, leaseExpiresAtMs, now, taskId, TaskStatus.ASSIGNED);
      if (result.changes === 0) {
        throw new Error(`Failed to start task ${taskId}: State conflict`);
      }

      return this.getTask(taskId)!;
    })();
  }

  public stealTask(
    taskId: string,
    newWorkerId: string,
    leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS
  ): { success: boolean; task?: Task; reason?: string } {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) return { success: false, reason: `Task ${taskId} not found` };

      // Only in-flight tasks (ASSIGNED or RUNNING) can be stolen
      if (task.status !== TaskStatus.ASSIGNED && task.status !== TaskStatus.RUNNING) {
        return { success: false, reason: `Task ${taskId} is not in-flight (status: ${task.status})` };
      }

      const previousWorkerId = task.assignedWorkerId;
      const now = Date.now();
      const newRetryCount = task.retryCount + 1; // Increment generation attempt
      const attemptHistory = [...task.attemptHistory];
      attemptHistory.push({
        timestampMs: now,
        workerId: previousWorkerId,
        previousStatus: task.status,
        reason: 'WORK_STOLEN_BY_SCHEDULER',
        details: { newWorkerId, previousAttempt: task.retryCount + 1, newAttempt: newRetryCount + 1 }
      });

      const leaseExpiresAtMs = now + leaseDurationMs;
      const stmt = this.db.prepare(`
        UPDATE tasks
        SET status = ?, assigned_worker_id = ?, retry_count = ?, attempt_history_json = ?, lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND (status = ? OR status = ?)
      `);

      const result = stmt.run(
        TaskStatus.ASSIGNED,
        newWorkerId,
        newRetryCount,
        JSON.stringify(attemptHistory),
        leaseExpiresAtMs,
        now,
        taskId,
        TaskStatus.ASSIGNED,
        TaskStatus.RUNNING
      );

      if (result.changes === 0) {
        return { success: false, reason: `Atomic steal collision: Task ${taskId} state changed concurrently` };
      }

      return { success: true, task: this.getTask(taskId)! };
    })();
  }

  public renewLease(taskId: string, leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS): boolean {
    const now = Date.now();
    const leaseExpiresAtMs = now + leaseDurationMs;
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET lease_expires_at_ms = ?, updated_at_ms = ?
      WHERE id = ? AND status IN (?, ?)
    `);
    const result = stmt.run(leaseExpiresAtMs, now, taskId, TaskStatus.ASSIGNED, TaskStatus.RUNNING);
    return result.changes > 0;
  }

  public renewWorkerLeases(workerId: string, leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS, fromTimeMs: number = Date.now()): number {
    const leaseExpiresAtMs = fromTimeMs + leaseDurationMs;
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET lease_expires_at_ms = ?, updated_at_ms = ?
      WHERE assigned_worker_id = ? AND status IN (?, ?)
    `);
    const result = stmt.run(leaseExpiresAtMs, fromTimeMs, workerId, TaskStatus.ASSIGNED, TaskStatus.RUNNING);
    return result.changes;
  }

  public completeTask(taskId: string, resultDestination?: string): Task {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.ASSIGNED) {
        throw new Error(`Invalid state transition: Cannot complete task in ${task.status} state`);
      }

      const now = Date.now();
      const newDest = resultDestination || task.resultDestination;
      const stmt = this.db.prepare(`
        UPDATE tasks 
        SET status = ?, result_destination = ?, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE id = ? AND status IN (?, ?)
      `);
      const result = stmt.run(TaskStatus.COMPLETED, newDest, now, taskId, TaskStatus.RUNNING, TaskStatus.ASSIGNED);
      if (result.changes === 0) {
        throw new Error(`Failed to complete task ${taskId}: State conflict`);
      }

      return this.getTask(taskId)!;
    })();
  }

  public failTask(taskId: string, reason: string): Task {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED || task.status === TaskStatus.ABANDONED) {
        throw new Error(`Cannot fail task already in terminal state ${task.status}`);
      }

      const now = Date.now();
      const attempt: TaskAttempt = {
        timestampMs: now,
        workerId: task.assignedWorkerId,
        previousStatus: task.status,
        reason
      };
      const updatedHistory = [...task.attemptHistory, attempt];

      const stmt = this.db.prepare(`
        UPDATE tasks 
        SET status = ?, attempt_history_json = ?, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `);
      stmt.run(TaskStatus.FAILED, JSON.stringify(updatedHistory), now, taskId);
      return this.getTask(taskId)!;
    })();
  }

  public abandonTask(taskId: string, reason: string): Task {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED || task.status === TaskStatus.ABANDONED) {
        throw new Error(`Cannot abandon task already in terminal state ${task.status}`);
      }

      const now = Date.now();
      const attempt: TaskAttempt = {
        timestampMs: now,
        workerId: task.assignedWorkerId,
        previousStatus: task.status,
        reason
      };
      const updatedHistory = [...task.attemptHistory, attempt];

      const stmt = this.db.prepare(`
        UPDATE tasks 
        SET status = ?, attempt_history_json = ?, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `);
      stmt.run(TaskStatus.ABANDONED, JSON.stringify(updatedHistory), now, taskId);
      return this.getTask(taskId)!;
    })();
  }

  /**
   * Worker-Loss Recovery:
   * When a worker disconnects or disappears, reclaims all tasks assigned to that worker.
   * Increments retry_count and logs WORKER_DISCONNECTED to attempt_history.
   * Transitions to FAILED if retry_count >= maxRetries; otherwise resets to PENDING.
   */
  public recoverWorkerLoss(workerId: string, maxRetries: number = DEFAULT_MAX_RETRIES): { recovered: Task[]; failed: Task[] } {
    if (!this.db.open) return { recovered: [], failed: [] };
    return this.db.transaction(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM tasks 
        WHERE assigned_worker_id = ? AND status IN (?, ?)
      `);
      const workerTasks = stmt.all(workerId, TaskStatus.ASSIGNED, TaskStatus.RUNNING) as any[];

      const recovered: Task[] = [];
      const failed: Task[] = [];
      const now = Date.now();

      const updateStmt = this.db.prepare(`
        UPDATE tasks 
        SET status = ?, retry_count = ?, attempt_history_json = ?, assigned_worker_id = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `);

      for (const row of workerTasks) {
        const task = this.mapRowToTask(row);
        const newRetryCount = task.retryCount + 1;
        const attempt: TaskAttempt = {
          timestampMs: now,
          workerId: task.assignedWorkerId,
          previousStatus: task.status,
          reason: 'WORKER_DISCONNECTED'
        };
        const updatedHistory = [...task.attemptHistory, attempt];

        if (newRetryCount >= maxRetries) {
          updateStmt.run(
            TaskStatus.FAILED,
            newRetryCount,
            JSON.stringify(updatedHistory),
            now,
            task.id
          );
          failed.push(this.getTask(task.id)!);
        } else {
          updateStmt.run(
            TaskStatus.PENDING,
            newRetryCount,
            JSON.stringify(updatedHistory),
            now,
            task.id
          );
          recovered.push(this.getTask(task.id)!);
        }
      }

      return { recovered, failed };
    })();
  }

  /**
   * Task Lease Expiration Recovery:
   * Finds tasks whose lease expired without heartbeat/completion.
   * Reclaims tasks back to PENDING (or FAILED if max retries exceeded).
   */
  public recoverExpiredLeases(nowMs: number = Date.now(), maxRetries: number = DEFAULT_MAX_RETRIES): { recovered: Task[]; failed: Task[] } {
    if (!this.db.open) return { recovered: [], failed: [] };
    return this.db.transaction(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM tasks 
        WHERE status IN (?, ?) AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ?
      `);
      const expiredRows = stmt.all(TaskStatus.ASSIGNED, TaskStatus.RUNNING, nowMs) as any[];

      const recovered: Task[] = [];
      const failed: Task[] = [];

      const updateStmt = this.db.prepare(`
        UPDATE tasks 
        SET status = ?, retry_count = ?, attempt_history_json = ?, assigned_worker_id = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `);

      for (const row of expiredRows) {
        const task = this.mapRowToTask(row);
        const newRetryCount = task.retryCount + 1;
        const attempt: TaskAttempt = {
          timestampMs: nowMs,
          workerId: task.assignedWorkerId,
          previousStatus: task.status,
          reason: 'LEASE_EXPIRED'
        };
        const updatedHistory = [...task.attemptHistory, attempt];

        if (newRetryCount >= maxRetries) {
          updateStmt.run(
            TaskStatus.FAILED,
            newRetryCount,
            JSON.stringify(updatedHistory),
            nowMs,
            task.id
          );
          failed.push(this.getTask(task.id)!);
        } else {
          updateStmt.run(
            TaskStatus.PENDING,
            newRetryCount,
            JSON.stringify(updatedHistory),
            nowMs,
            task.id
          );
          recovered.push(this.getTask(task.id)!);
        }
      }

      return { recovered, failed };
    })();
  }

  /**
   * Explicit Crash Recovery:
   * Any task in ASSIGNED or RUNNING state at restart time is evaluated.
   * retry_count is incremented, and an attempt_history entry is added for HOST_CRASH_RECOVERY.
   * If retry_count >= maxRetries, transition to FAILED (preventing infinite loops).
   * Otherwise, reset to PENDING.
   */
  public recoverInFlightTasks(maxRetries: number = DEFAULT_MAX_RETRIES): { recovered: Task[]; failed: Task[] } {
    return this.db.transaction(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM tasks 
        WHERE status IN (?, ?)
      `);
      const inFlightRows = stmt.all(TaskStatus.ASSIGNED, TaskStatus.RUNNING) as any[];

      const recovered: Task[] = [];
      const failed: Task[] = [];
      const now = Date.now();

      const updateStmt = this.db.prepare(`
        UPDATE tasks 
        SET status = ?, retry_count = ?, attempt_history_json = ?, assigned_worker_id = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `);

      for (const row of inFlightRows) {
        const task = this.mapRowToTask(row);
        const newRetryCount = task.retryCount + 1;
        const attempt: TaskAttempt = {
          timestampMs: now,
          workerId: task.assignedWorkerId,
          previousStatus: task.status,
          reason: 'HOST_CRASH_RECOVERY'
        };
        const updatedHistory = [...task.attemptHistory, attempt];

        if (newRetryCount >= maxRetries) {
          updateStmt.run(
            TaskStatus.FAILED,
            newRetryCount,
            JSON.stringify(updatedHistory),
            now,
            task.id
          );
          failed.push(this.getTask(task.id)!);
        } else {
          updateStmt.run(
            TaskStatus.PENDING,
            newRetryCount,
            JSON.stringify(updatedHistory),
            now,
            task.id
          );
          recovered.push(this.getTask(task.id)!);
        }
      }

      return { recovered, failed };
    })();
  }

  public getActiveTaskCountForWorker(workerId: string): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE assigned_worker_id = ? AND status IN ('ASSIGNED', 'RUNNING')"
    );
    const row = stmt.get(workerId) as any;
    return row ? row.count : 0;
  }

  /**
   * Returns the list of worker IDs that have previously failed validation or execution for this task.
   */
  public getExcludedWorkerIds(taskId: string): string[] {
    const task = this.getTask(taskId);
    if (!task) return [];
    const excluded = new Set<string>();
    for (const attempt of task.attemptHistory) {
      if (
        attempt.workerId &&
        (attempt.reason === 'VALIDATION_TOLERANCE_EXCEEDED' ||
         attempt.reason === 'EXECUTION_ERROR' ||
         attempt.reason === 'TOLERANCE_MISMATCH')
      ) {
        excluded.add(attempt.workerId);
      }
    }
    return Array.from(excluded);
  }

  /**
   * Records a task failure (e.g. VALIDATION_TOLERANCE_EXCEEDED or EXECUTION_ERROR),
   * appends attempt details with workerId, and resets to PENDING for redistribution (or FAILED if max retries exceeded).
   */
  public recordTaskFailure(
    taskId: string,
    workerId: string,
    reason: string,
    details?: any,
    maxRetries: number = DEFAULT_MAX_RETRIES
  ): Task {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);

      const now = Date.now();
      const newRetryCount = task.retryCount + 1;
      const attempt: TaskAttempt = {
        timestampMs: now,
        workerId,
        previousStatus: task.status,
        reason,
        details
      };
      const updatedHistory = [...task.attemptHistory, attempt];

      const newStatus = newRetryCount >= maxRetries ? TaskStatus.FAILED : TaskStatus.PENDING;

      const stmt = this.db.prepare(`
        UPDATE tasks 
        SET status = ?, retry_count = ?, attempt_history_json = ?, assigned_worker_id = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `);
      stmt.run(newStatus, newRetryCount, JSON.stringify(updatedHistory), now, taskId);

      return this.getTask(taskId)!;
    })();
  }

  private mapRowToTask(row: any): Task {
    return {
      id: row.id,
      status: row.status as TaskStatus,
      inputRef: row.input_ref,
      computationDescriptor: row.computation_descriptor,
      requiredResources: JSON.parse(row.required_resources_json || '{}'),
      dependencies: JSON.parse(row.dependencies_json || '[]'),
      executionConstraints: JSON.parse(row.execution_constraints_json || '{}'),
      resultDestination: row.result_destination,
      retryCount: row.retry_count,
      attemptHistory: JSON.parse(row.attempt_history_json || '[]'),
      assignedWorkerId: row.assigned_worker_id || undefined,
      leaseExpiresAtMs: row.lease_expires_at_ms || undefined,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms
    };
  }
}
