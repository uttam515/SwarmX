import { Task, TaskStatus } from './types';
import { TaskStore } from './db/task_store';

export interface StragglerDetectorConfig {
  detectionThresholdMultiplier: number; // e.g. 2.5x cluster/worker moving average
  minObservationsBeforeDeclaration: number; // e.g. 3 observations before declaring straggler
  minDurationMsThreshold: number; // e.g. 50ms to prevent jitter on tiny sub-chunks
  stragglerEmaAlpha: number; // e.g. 0.20 for exponential moving average
  enableWorkStealing: boolean;
}

export const DEFAULT_STRAGGLER_CONFIG: StragglerDetectorConfig = {
  detectionThresholdMultiplier: 2.5,
  minObservationsBeforeDeclaration: 3,
  minDurationMsThreshold: 50,
  stragglerEmaAlpha: 0.20,
  enableWorkStealing: true
};

export interface InFlightTaskTracking {
  taskId: string;
  workerId: string;
  startTimeMs: number;
  expectedDurationMs: number;
}

export interface StealResult {
  stolen: boolean;
  taskId?: string;
  victimWorkerId?: string;
  thiefWorkerId?: string;
  reason?: string;
  task?: Task;
}

/**
 * Straggler Detector & Work-Stealing Coordinator (Milestone 2.2):
 * - Tracks runtime worker latency moving averages (EMA)
 * - Identifies straggling tasks exceeding configurable thresholds
 * - Coordinates non-blocking chunk theft with atomic exactly-once database CAS
 */
export class WorkStealer {
  private config: StragglerDetectorConfig;
  private workerAvgDurationMs: Map<string, number> = new Map();
  private workerObservationCount: Map<string, number> = new Map();
  private inFlightTasks: Map<string, InFlightTaskTracking> = new Map();
  private totalStealsCount: number = 0;

  constructor(config: Partial<StragglerDetectorConfig> = {}) {
    this.config = { ...DEFAULT_STRAGGLER_CONFIG, ...config };
  }

  public getConfig(): StragglerDetectorConfig {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<StragglerDetectorConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  public recordTaskStart(taskId: string, workerId: string, expectedDurationMs: number = 100): void {
    this.inFlightTasks.set(taskId, {
      taskId,
      workerId,
      startTimeMs: Date.now(),
      expectedDurationMs
    });
  }

  public recordTaskCompletion(taskId: string, workerId: string, durationMs: number): void {
    this.inFlightTasks.delete(taskId);

    const prevAvg = this.workerAvgDurationMs.get(workerId);
    const count = (this.workerObservationCount.get(workerId) || 0) + 1;
    this.workerObservationCount.set(workerId, count);

    if (prevAvg === undefined) {
      this.workerAvgDurationMs.set(workerId, durationMs);
    } else {
      const newAvg = (this.config.stragglerEmaAlpha * durationMs) + ((1 - this.config.stragglerEmaAlpha) * prevAvg);
      this.workerAvgDurationMs.set(workerId, newAvg);
    }
  }

  public recordTaskFailure(taskId: string): void {
    this.inFlightTasks.delete(taskId);
  }

  public getClusterMedianDurationMs(): number {
    const values = Array.from(this.workerAvgDurationMs.values()).filter(v => v > 0);
    if (values.length === 0) return this.config.minDurationMsThreshold;
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return values.length % 2 !== 0 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }

  /**
   * Evaluates whether a specific in-flight task is currently a straggler.
   */
  public isTaskStraggling(taskId: string, now: number = Date.now()): { isStraggler: boolean; reason?: string; elapsedMs: number } {
    const tracking = this.inFlightTasks.get(taskId);
    if (!tracking) {
      return { isStraggler: false, elapsedMs: 0 };
    }

    const elapsedMs = now - tracking.startTimeMs;
    const workerObs = this.workerObservationCount.get(tracking.workerId) || 0;
    const workerAvg = this.workerAvgDurationMs.get(tracking.workerId) || tracking.expectedDurationMs;
    const clusterMedian = this.getClusterMedianDurationMs();

    // False-positive protection: Minimum duration threshold
    if (elapsedMs < this.config.minDurationMsThreshold) {
      return { isStraggler: false, elapsedMs };
    }

    // Baseline reference: whichever is faster between worker history and cluster median
    const baseline = Math.max(this.config.minDurationMsThreshold, Math.min(workerAvg, clusterMedian));
    const thresholdMs = baseline * this.config.detectionThresholdMultiplier;

    if (elapsedMs >= thresholdMs) {
      return {
        isStraggler: true,
        reason: `Task ${taskId} on worker ${tracking.workerId} elapsed ${elapsedMs}ms exceeds straggler threshold ${thresholdMs.toFixed(0)}ms (${this.config.detectionThresholdMultiplier}x baseline ${baseline.toFixed(0)}ms)`,
        elapsedMs
      };
    }

    return { isStraggler: false, elapsedMs };
  }

  /**
   * Finds the oldest eligible straggler task and attempts an atomic steal for thiefWorkerId.
   */
  public attemptSteal(thiefWorkerId: string, taskStore: TaskStore, now: number = Date.now()): StealResult {
    if (!this.config.enableWorkStealing) {
      return { stolen: false, reason: 'Work stealing is disabled in config' };
    }
    const stragglerCandidates: { taskId: string; tracking: InFlightTaskTracking; elapsedMs: number }[] = [];

    for (const [taskId, tracking] of this.inFlightTasks.entries()) {
      // Cannot steal from self
      if (tracking.workerId === thiefWorkerId) continue;

      const evalResult = this.isTaskStraggling(taskId, now);
      if (evalResult.isStraggler) {
        stragglerCandidates.push({ taskId, tracking, elapsedMs: evalResult.elapsedMs });
      }
    }

    if (stragglerCandidates.length === 0) {
      return { stolen: false, reason: 'No straggling tasks available to steal' };
    }

    // Prioritize oldest/longest running straggler
    stragglerCandidates.sort((a, b) => b.elapsedMs - a.elapsedMs);
    const target = stragglerCandidates[0];

    // Atomic DB CAS steal transition
    const stealResult = taskStore.stealTask(target.taskId, thiefWorkerId);
    if (stealResult.success && stealResult.task) {
      this.totalStealsCount++;
      // Re-track task with thief as owner
      this.inFlightTasks.set(target.taskId, {
        taskId: target.taskId,
        workerId: thiefWorkerId,
        startTimeMs: now,
        expectedDurationMs: target.tracking.expectedDurationMs
      });

      return {
        stolen: true,
        taskId: target.taskId,
        victimWorkerId: target.tracking.workerId,
        thiefWorkerId,
        task: stealResult.task,
        reason: `Successfully stole task ${target.taskId} from straggling worker ${target.tracking.workerId}`
      };
    }

    return {
      stolen: false,
      taskId: target.taskId,
      reason: stealResult.reason || 'Atomic steal collision'
    };
  }

  public getTotalStealsCount(): number {
    return this.totalStealsCount;
  }

  public getWorkerAvgDurationMs(workerId: string): number | undefined {
    return this.workerAvgDurationMs.get(workerId);
  }
}
