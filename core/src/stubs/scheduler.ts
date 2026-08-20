/**
 * ============================================================================
 * PHASE 0 STUB — SCHEDULER INTERFACE
 * ============================================================================
 * Out of scope for Phase 0.
 * In Phase 1 & 2, this service will consume worker telemetry & capability
 * profiles from WorkerManager and schedule tasks from TaskStore adaptively.
 * ============================================================================
 */

import { Task } from '../types';
import { WorkerState } from '../worker_manager';

export interface IScheduler {
  /**
   * Schedules an eligible task to an optimal worker.
   * Stub implementation returns null (no-op in Phase 0).
   */
  scheduleNextTask(pendingTasks: Task[], availableWorkers: WorkerState[]): { taskId: string; workerId: string } | null;

  /**
   * Rebalances running tasks if worker state degrades.
   */
  evaluateRebalance(runningTasks: Task[], workers: WorkerState[]): void;
}

export class SchedulerStub implements IScheduler {
  public scheduleNextTask(
    _pendingTasks: Task[], 
    _availableWorkers: WorkerState[]
  ): { taskId: string; workerId: string } | null {
    // PHASE 0 STUB: Placement intelligence implemented in Phase 1
    return null;
  }

  public evaluateRebalance(_runningTasks: Task[], _workers: WorkerState[]): void {
    // PHASE 0 STUB: Adaptive rebalancing implemented in Phase 1
  }
}
