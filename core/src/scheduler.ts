import { Task, TaskStatus } from './types';
import { WorkerState } from './worker_manager';
import { TaskStore } from './db/task_store';

export interface SchedulerWeights {
  w1_throughput: number;   // default 0.40
  w2_capacity: number;     // default 0.30
  w3_transferCost: number; // default 0.15
  w4_instability: number;  // default 0.15
}

export const DEFAULT_SCHEDULER_WEIGHTS: SchedulerWeights = {
  w1_throughput: 0.40,
  w2_capacity: 0.30,
  w3_transferCost: 0.15,
  w4_instability: 0.15
};

export interface CandidateScore {
  workerId: string;
  eligible: boolean;
  finalScore: number;
  components: {
    throughputScore: number;
    capacityScore: number;
    transferCostScore: number;
    instabilityPenalty: number;
  };
  isExcludedForTask: boolean;
  rejectionReason?: string;
}

export interface SchedulingDecision {
  taskId: string;
  selectedWorker: WorkerState | null;
  status: 'ASSIGNED' | 'WAITING_FOR_ELIGIBLE_WORKER' | 'NO_ELIGIBLE_WORKER_REMAINING';
  weights: SchedulerWeights;
  candidateScores: CandidateScore[];
  reason?: string;
}

export interface IScheduler {
  scheduleTask(
    task: Task,
    allWorkers: WorkerState[],
    taskStore?: TaskStore
  ): SchedulingDecision;
}

/**
 * Deterministic Scored Scheduler (Phase H: Heterogeneous Worker & Adaptive Scheduling):
 * - Hard pre-filter: Worker must pass binary eligibility gate (battery, thermal, CPU load, supported kernel)
 * - Task-specific exclusion: Workers that failed previous attempts on this task are excluded
 * - Deterministic explainable scoring: score = w1*throughput + w2*capacity - w3*transferCost - w4*instability
 * - Adaptive throughput: EMA updates on chunk completion
 * - Multi-chunk proportional allocation
 */
export class ScoredScheduler implements IScheduler {
  private weights: SchedulerWeights;
  private workerThroughputHistory: Map<string, number> = new Map(); // items/sec or MB/s
  private workerFailureCounts: Map<string, number> = new Map();

  constructor(weights: SchedulerWeights = DEFAULT_SCHEDULER_WEIGHTS) {
    this.weights = { ...weights };
  }

  public setWorkerThroughput(workerId: string, itemsPerSecond: number): void {
    this.workerThroughputHistory.set(workerId, itemsPerSecond);
  }

  public updateWorkerThroughputEma(workerId: string, measuredItemsPerSecond: number, alpha: number = 0.2): void {
    const prev = this.workerThroughputHistory.get(workerId);
    if (prev === undefined) {
      this.workerThroughputHistory.set(workerId, measuredItemsPerSecond);
    } else {
      const updated = alpha * measuredItemsPerSecond + (1 - alpha) * prev;
      this.workerThroughputHistory.set(workerId, updated);
    }
  }

  public recordWorkerFailure(workerId: string): void {
    const current = this.workerFailureCounts.get(workerId) || 0;
    this.workerFailureCounts.set(workerId, current + 1);
  }

  public resetWorkerFailures(workerId: string): void {
    this.workerFailureCounts.delete(workerId);
  }

  /**
   * Distributes N work items proportionally across eligible workers based on their calculated score weights.
   */
  public allocateMultiChunkWorkload(
    totalItems: number,
    candidateScores: CandidateScore[]
  ): Map<string, number> {
    const allocation = new Map<string, number>();
    const eligible = candidateScores.filter(c => c.eligible && !c.isExcludedForTask && c.finalScore > 0);

    if (eligible.length === 0 || totalItems <= 0) {
      return allocation;
    }

    const totalScore = eligible.reduce((sum, c) => sum + c.finalScore, 0);
    let assignedTotal = 0;

    for (let i = 0; i < eligible.length; i++) {
      const c = eligible[i];
      if (i === eligible.length - 1) {
        // Last worker gets remainder to ensure exact sum == totalItems
        allocation.set(c.workerId, totalItems - assignedTotal);
      } else {
        const count = Math.round((c.finalScore / totalScore) * totalItems);
        allocation.set(c.workerId, count);
        assignedTotal += count;
      }
    }

    return allocation;
  }

  public scheduleTask(
    task: Task,
    allWorkers: WorkerState[],
    taskStore?: TaskStore
  ): SchedulingDecision {
    // 1. Derive task-specific excluded worker IDs (e.g. from prior VALIDATION_TOLERANCE_EXCEEDED / EXECUTION_ERROR)
    const excludedWorkerIds = taskStore ? taskStore.getExcludedWorkerIds(task.id) : [];
    const candidateScores: CandidateScore[] = [];

    for (const worker of allWorkers) {
      const isExcludedForTask = excludedWorkerIds.includes(worker.deviceId);

      // Hard Eligibility Pre-Filter Check
      let isEligible = worker.isEligible;
      let rejectionReason: string | undefined;

      if (!worker.isEligible) {
        rejectionReason = 'Worker is not marked eligible in WorkerManager';
      } else if (worker.latestTelemetry?.thermalState !== undefined && worker.latestTelemetry.thermalState >= 2) {
        isEligible = false;
        rejectionReason = `Thermal state ${worker.latestTelemetry.thermalState} exceeds threshold`;
      } else if (worker.latestTelemetry?.cpuUtilization !== undefined && worker.latestTelemetry.cpuUtilization >= 0.90) {
        isEligible = false;
        rejectionReason = `CPU utilization ${(worker.latestTelemetry.cpuUtilization * 100).toFixed(0)}% exceeds 90% threshold`;
      } else if (worker.latestTelemetry?.batteryLevel !== undefined && !worker.latestTelemetry.isCharging && worker.latestTelemetry.batteryLevel < 0.20) {
        isEligible = false;
        rejectionReason = `Battery ${(worker.latestTelemetry.batteryLevel * 100).toFixed(0)}% below 20% limit`;
      }

      // Check task resource requirements (min CPU, min RAM, GPU constraint)
      const minCores = task.requiredResources?.minCpuCores || 1;
      const minRam = task.requiredResources?.minRamMb || 0;
      const requiresGpu = task.requiredResources?.requiresGpu || false;

      if (worker.capabilityProfile.cpuCores < minCores) {
        isEligible = false;
        rejectionReason = `CPU cores (${worker.capabilityProfile.cpuCores}) < required (${minCores})`;
      } else if (worker.capabilityProfile.totalRamMb < minRam) {
        isEligible = false;
        rejectionReason = `RAM (${worker.capabilityProfile.totalRamMb} MB) < required (${minRam} MB)`;
      } else if (requiresGpu && !worker.capabilityProfile.hasGpu) {
        isEligible = false;
        rejectionReason = 'Task requires GPU acceleration';
      }

      // Kernel compatibility check
      if (worker.capabilityProfile.supportedKernels && worker.capabilityProfile.supportedKernels.length > 0) {
        let kernelId = task.computationDescriptor;
        try {
          const parsed = JSON.parse(task.computationDescriptor);
          if (parsed.kernelId) kernelId = parsed.kernelId;
        } catch (e) {}

        if (!worker.capabilityProfile.supportedKernels.includes(kernelId) && !worker.capabilityProfile.supportedKernels.includes(task.computationDescriptor)) {
          isEligible = false;
          rejectionReason = `Kernel '${kernelId}' not in worker supportedKernels`;
        }
      }

      if (!isEligible) {
        continue;
      }

      // Compute explainable component scores
      // 1. Throughput Score [0.0 - 1.0]: observed items/sec normalized against nominal 2000 items/s
      const observedThroughput = this.workerThroughputHistory.get(worker.deviceId);
      const nominalThroughput = (worker.capabilityProfile.cpuCores * 100) + (worker.capabilityProfile.hasGpu ? 500 : 0);
      const throughputScore = Math.min(1.0, (observedThroughput ?? nominalThroughput) / 2000);

      // 2. Capacity Headroom Score [0.0 - 1.0]: based on CPU utilization, available RAM, and in-flight tasks
      const inFlightCount = taskStore ? taskStore.getActiveTaskCountForWorker(worker.deviceId) : 0;
      const inFlightLoad = Math.min(0.8, inFlightCount * 0.20);
      const cpuHeadroom = Math.max(0.05, 1.0 - (worker.latestTelemetry?.cpuUtilization ?? 0.3) - inFlightLoad);
      const ramHeadroom = Math.min(1.0, (worker.latestTelemetry?.availableRamMb ?? 4096) / worker.capabilityProfile.totalRamMb);
      const capacityScore = Math.max(0.0, Math.min(1.0, (0.5 * cpuHeadroom) + (0.5 * ramHeadroom)));

      // 3. Predicted Transfer Cost Score [0.0 - 1.0]: base LAN latency overhead
      const transferCostScore = 0.10;

      // 4. Instability Penalty [0.0 - 1.0]: based on recent failure count for this worker
      const failureCount = this.workerFailureCounts.get(worker.deviceId) || 0;
      const instabilityPenalty = Math.min(1.0, failureCount * 0.30);

      // Final deterministic formula: w1*throughput + w2*capacity - w3*transfer - w4*instability
      const finalScore = Math.max(0.0, (this.weights.w1_throughput * throughputScore) +
                         (this.weights.w2_capacity * capacityScore) -
                         (this.weights.w3_transferCost * transferCostScore) -
                         (this.weights.w4_instability * instabilityPenalty));

      candidateScores.push({
        workerId: worker.deviceId,
        eligible: true,
        finalScore: Math.round(finalScore * 10000) / 10000,
        components: {
          throughputScore: Math.round(throughputScore * 10000) / 10000,
          capacityScore: Math.round(capacityScore * 10000) / 10000,
          transferCostScore: Math.round(transferCostScore * 10000) / 10000,
          instabilityPenalty: Math.round(instabilityPenalty * 10000) / 10000
        },
        isExcludedForTask
      });
    }

    // 3. Filter candidates to only eligible, non-excluded workers
    const assignableCandidates = candidateScores
      .filter(c => c.eligible && !c.isExcludedForTask)
      .sort((a, b) => b.finalScore - a.finalScore);

    if (assignableCandidates.length > 0) {
      const topCandidate = assignableCandidates[0];
      const selectedWorker = allWorkers.find(w => w.deviceId === topCandidate.workerId) || null;
      return {
        taskId: task.id,
        selectedWorker,
        status: 'ASSIGNED',
        weights: this.weights,
        candidateScores,
        reason: `Selected worker ${topCandidate.workerId} with highest score ${topCandidate.finalScore.toFixed(4)}`
      };
    }

    // 4. Starvation vs Waiting Distinction
    const eligibleCount = candidateScores.filter(c => c.eligible).length;
    if (eligibleCount > 0 && candidateScores.filter(c => c.eligible).every(c => c.isExcludedForTask)) {
      return {
        taskId: task.id,
        selectedWorker: null,
        status: 'NO_ELIGIBLE_WORKER_REMAINING',
        weights: this.weights,
        candidateScores,
        reason: `All ${eligibleCount} eligible workers are in task exclusion list`
      };
    }

    return {
      taskId: task.id,
      selectedWorker: null,
      status: 'WAITING_FOR_ELIGIBLE_WORKER',
      weights: this.weights,
      candidateScores,
      reason: 'No eligible workers currently available in swarm'
    };
  }

  public selectWorker(task: Task, eligibleWorkers: WorkerState[]): WorkerState | null {
    const decision = this.scheduleTask(task, eligibleWorkers);
    return decision.selectedWorker;
  }
}

/**
 * Phase 0 Deterministic FIFO Scheduler (Retained for backwards compatibility)
 */
export class DeterministicFifoScheduler implements IScheduler {
  public selectWorker(task: Task, eligibleWorkers: WorkerState[]): WorkerState | null {
    for (const worker of eligibleWorkers) {
      if (!worker.isEligible) continue;
      const minCores = task.requiredResources?.minCpuCores || 1;
      const minRam = task.requiredResources?.minRamMb || 0;
      const requiresGpu = task.requiredResources?.requiresGpu || false;

      if (worker.capabilityProfile.cpuCores >= minCores &&
          worker.capabilityProfile.totalRamMb >= minRam &&
          (!requiresGpu || worker.capabilityProfile.hasGpu)) {
        return worker;
      }
    }
    return null;
  }

  public scheduleTask(task: Task, allWorkers: WorkerState[]): SchedulingDecision {
    const selectedWorker = this.selectWorker(task, allWorkers);
    return {
      taskId: task.id,
      selectedWorker,
      status: selectedWorker ? 'ASSIGNED' : 'WAITING_FOR_ELIGIBLE_WORKER',
      weights: DEFAULT_SCHEDULER_WEIGHTS,
      candidateScores: []
    };
  }
}

