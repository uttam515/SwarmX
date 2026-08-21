import { WorkloadDescriptor, WorkerTelemetry, CapabilityProfile } from './types';
import { KernelRegistry } from './kernel_registry';
import { WorkerManager } from './worker_manager';

export interface DecisionResult {
  decision: 'SWARM' | 'LOCAL';
  estimatedLocalTimeMs: number;
  estimatedSwarmTimeMs: number;
  estimatedQueueTimeMs?: number;
  estimatedTransferTimeMs?: number;
  estimatedComputeTimeMs?: number;
  estimatedGain: number; // Ratio: T_local / T_swarm
  reason: string;
  selectedWorkerCount: number;
  selectedWorkerId?: string;
  calibratedLocalThroughputMBs?: number;
  calibratedSwarmThroughputMBs?: number;
}

export interface DecisionEngineConfig {
  minGainThreshold: number; // e.g. 1.25 (25% improvement required)
  defaultLanBandwidthBytesPerSec: number; // e.g. 25 MB/s on hotspot/Wi-Fi
  defaultLocalThroughputBytesPerSec: number; // e.g. 12 MB/s for BoxBlur
  defaultWorkerThroughputBytesPerSec: number; // e.g. 35 MB/s per worker
  ipcOverheadMs: number; // ~2ms
  coordinationOverheadMs: number; // ~5ms
}

export const DEFAULT_DECISION_CONFIG: DecisionEngineConfig = {
  minGainThreshold: 1.25, // Require at least 25% speedup to justify network distribution
  defaultLanBandwidthBytesPerSec: 25 * 1024 * 1024, // 25 MB/s Wi-Fi
  defaultLocalThroughputBytesPerSec: 12 * 1024 * 1024, // 12 MB/s for 2D BoxBlur on single CPU core
  defaultWorkerThroughputBytesPerSec: 35 * 1024 * 1024, // 35 MB/s for multi-core SIMD worker
  ipcOverheadMs: 2.0,
  coordinationOverheadMs: 5.0
};

export interface WorkerCandidateLoad {
  deviceId: string;
  capabilityProfile?: CapabilityProfile;
  telemetry?: WorkerTelemetry;
  inFlightTasks?: number;
}

export class DistributionDecisionEngine {
  private config: DecisionEngineConfig;
  private kernelRegistry: KernelRegistry;
  private localKernelCalibration: Map<string, number> = new Map(); // kernelId -> measured bytes/sec
  private workerKernelCalibration: Map<string, number> = new Map(); // `${deviceId}:${kernelId}` -> measured bytes/sec
  private workerInFlight: Map<string, number> = new Map(); // deviceId -> live active task reservations

  constructor(
    config: Partial<DecisionEngineConfig> = {},
    kernelRegistry: KernelRegistry = KernelRegistry.getInstance()
  ) {
    this.config = { ...DEFAULT_DECISION_CONFIG, ...config };
    this.kernelRegistry = kernelRegistry;
  }

  /**
   * Acquires a lightweight scheduling reservation for a worker before task execution begins.
   * Prevents simultaneous task arrivals from all observing an empty remote queue.
   */
  public acquireReservation(deviceId: string): void {
    const current = this.workerInFlight.get(deviceId) || 0;
    this.workerInFlight.set(deviceId, current + 1);
  }

  /**
   * Releases a scheduling reservation upon task completion or failure.
   */
  public releaseReservation(deviceId: string): void {
    const current = this.workerInFlight.get(deviceId) || 0;
    if (current <= 1) {
      this.workerInFlight.delete(deviceId);
    } else {
      this.workerInFlight.set(deviceId, current - 1);
    }
  }

  /**
   * Returns current active in-flight count for a worker.
   */
  public getInFlightCount(deviceId: string): number {
    return this.workerInFlight.get(deviceId) || 0;
  }

  /**
   * Records empirical calibration data measured for local host execution.
   */
  public recordLocalCalibration(kernelId: string, measuredBytesPerSec: number): void {
    if (measuredBytesPerSec > 0) {
      this.localKernelCalibration.set(kernelId, measuredBytesPerSec);
    }
  }

  /**
   * Records empirical calibration data measured for a specific worker node.
   */
  public recordWorkerCalibration(deviceId: string, kernelId: string, measuredBytesPerSec: number): void {
    if (measuredBytesPerSec > 0) {
      this.workerKernelCalibration.set(`${deviceId}:${kernelId}`, measuredBytesPerSec);
    }
  }

  public getLocalThroughput(kernelId: string): number {
    return this.localKernelCalibration.get(kernelId) ?? this.config.defaultLocalThroughputBytesPerSec;
  }

  public getWorkerThroughput(deviceId: string, kernelId: string, hasGpu: boolean = false): number {
    const key = `${deviceId}:${kernelId}`;
    if (this.workerKernelCalibration.has(key)) {
      return this.workerKernelCalibration.get(key)!;
    }
    let base = this.config.defaultWorkerThroughputBytesPerSec;
    if (hasGpu) {
      base *= 1.5;
    }
    return base;
  }

  public getPredictedQueueTimeMs(deviceId: string, kernelId: string, payloadBytes: number): number {
    const inFlight = this.getInFlightCount(deviceId);
    const throughput = this.getWorkerThroughput(deviceId, kernelId);
    const computeMs = (payloadBytes / Math.max(1, throughput)) * 1000;
    return Math.round(inFlight * computeMs);
  }

  public evaluate(
    workload: WorkloadDescriptor,
    connectedWorkers: WorkerCandidateLoad[]
  ): DecisionResult {
    const kernelId = workload.computation.kernelId;
    const payloadBytes = workload.data.totalPayloadBytes;

    // 1. Gating Rule: Certified Kernel Check
    if (!this.kernelRegistry.isCertified(kernelId)) {
      return {
        decision: 'LOCAL',
        estimatedLocalTimeMs: 0,
        estimatedSwarmTimeMs: Infinity,
        estimatedGain: 0,
        reason: `Kernel '${kernelId}' is not certified in KernelRegistry`,
        selectedWorkerCount: 0
      };
    }

    const kernel = this.kernelRegistry.getKernel(kernelId)!;
    const localThroughput = this.getLocalThroughput(kernelId);

    // 2. Gating Rule: Payload Size Below Minimum Beneficial Threshold
    if (payloadBytes < kernel.minBeneficialBytes) {
      const localTimeMs = (payloadBytes / localThroughput) * 1000;
      return {
        decision: 'LOCAL',
        estimatedLocalTimeMs: Math.round(localTimeMs),
        estimatedSwarmTimeMs: Math.round(localTimeMs * 2),
        estimatedGain: 0.5,
        reason: `Payload (${payloadBytes} bytes) is below minimum beneficial threshold (${kernel.minBeneficialBytes} bytes)`,
        selectedWorkerCount: 0,
        calibratedLocalThroughputMBs: Number((localThroughput / (1024 * 1024)).toFixed(2))
      };
    }

    // 3. Gating Rule: Filter Eligible Workers with Kernel Platform Support
    const eligibleWorkers = connectedWorkers.filter(w => {
      if (w.telemetry) {
        if (w.telemetry.cpuUtilization >= 0.90) return false;
        if (w.telemetry.thermalState >= 2) return false; // SERIOUS or CRITICAL
        if (!w.telemetry.isCharging && w.telemetry.batteryLevel < 0.20) return false;
      }
      if (w.capabilityProfile) {
        if (!this.kernelRegistry.isPlatformSupported(kernelId, w.capabilityProfile.osType)) {
          return false;
        }
      }
      return true;
    });

    if (eligibleWorkers.length === 0) {
      const localTimeMs = (payloadBytes / localThroughput) * 1000;
      return {
        decision: 'LOCAL',
        estimatedLocalTimeMs: Math.round(localTimeMs),
        estimatedSwarmTimeMs: Infinity,
        estimatedGain: 0,
        reason: 'No eligible workers available in cluster',
        selectedWorkerCount: 0,
        calibratedLocalThroughputMBs: Number((localThroughput / (1024 * 1024)).toFixed(2))
      };
    }

    // 4. Mathematical Cost Model Calculation with Queue Latency
    const estimatedLocalTimeMs = Math.round((payloadBytes / localThroughput) * 1000);
    const transferTimeMs = Math.round(((2 * payloadBytes) / this.config.defaultLanBandwidthBytesPerSec) * 1000);

    // Evaluate effective completion time for each candidate worker
    interface WorkerEvaluation {
      deviceId: string;
      computeMs: number;
      queueMs: number;
      transferMs: number;
      effectiveSwarmMs: number;
      inFlight: number;
      workerRate: number;
    }

    const workerEvaluations: WorkerEvaluation[] = [];

    for (const w of eligibleWorkers) {
      const workerRate = this.getWorkerThroughput(w.deviceId, kernelId, w.capabilityProfile?.hasGpu ?? false);
      const computeMs = Math.round((payloadBytes / Math.max(1, workerRate)) * 1000);
      const inFlight = (w.inFlightTasks !== undefined) ? w.inFlightTasks : (this.workerInFlight.get(w.deviceId) || 0);
      const queueMs = Math.round(inFlight * computeMs);
      const effectiveSwarmMs =
        this.config.ipcOverheadMs +
        transferTimeMs +
        queueMs +
        computeMs +
        this.config.coordinationOverheadMs;

      workerEvaluations.push({
        deviceId: w.deviceId,
        computeMs,
        queueMs,
        transferMs: transferTimeMs,
        effectiveSwarmMs: Math.round(effectiveSwarmMs),
        inFlight,
        workerRate
      });
    }

    // Select candidate with the fastest effective completion time
    workerEvaluations.sort((a, b) => a.effectiveSwarmMs - b.effectiveSwarmMs);
    const best = workerEvaluations[0];

    const estimatedSwarmTimeMs = best.effectiveSwarmMs;
    const estimatedGain = estimatedSwarmTimeMs > 0 ? estimatedLocalTimeMs / estimatedSwarmTimeMs : 0;

    // 5. Queue-Aware Decision Threshold
    if (estimatedGain >= this.config.minGainThreshold) {
      return {
        decision: 'SWARM',
        estimatedLocalTimeMs,
        estimatedSwarmTimeMs,
        estimatedQueueTimeMs: best.queueMs,
        estimatedTransferTimeMs: best.transferMs,
        estimatedComputeTimeMs: best.computeMs,
        estimatedGain: Number(estimatedGain.toFixed(2)),
        reason: `Remote worker '${best.deviceId}' predicted completion (${estimatedSwarmTimeMs}ms: queue ${best.queueMs}ms, transfer ${best.transferMs}ms, compute ${best.computeMs}ms) is ${estimatedGain.toFixed(2)}x faster than local (${estimatedLocalTimeMs}ms)`,
        selectedWorkerCount: eligibleWorkers.length,
        selectedWorkerId: best.deviceId,
        calibratedLocalThroughputMBs: Number((localThroughput / (1024 * 1024)).toFixed(2)),
        calibratedSwarmThroughputMBs: Number((best.workerRate / (1024 * 1024)).toFixed(2))
      };
    } else {
      let reason = `Local execution (${estimatedLocalTimeMs}ms) is faster or within threshold vs remote (${estimatedSwarmTimeMs}ms)`;
      if (best.queueMs > 0 && (best.queueMs + best.transferMs + best.computeMs) > estimatedLocalTimeMs) {
        reason = `Remote worker '${best.deviceId}' queue saturation (${best.inFlight} in-flight tasks, ${best.queueMs}ms queue) causes effective remote time (${estimatedSwarmTimeMs}ms) to exceed local (${estimatedLocalTimeMs}ms)`;
      } else {
        reason = `Estimated swarm speedup of ${estimatedGain.toFixed(2)}x is below threshold (${this.config.minGainThreshold}x) due to network transfer overhead (${transferTimeMs}ms)`;
      }

      return {
        decision: 'LOCAL',
        estimatedLocalTimeMs,
        estimatedSwarmTimeMs,
        estimatedQueueTimeMs: best.queueMs,
        estimatedTransferTimeMs: best.transferMs,
        estimatedComputeTimeMs: best.computeMs,
        estimatedGain: Number(estimatedGain.toFixed(2)),
        reason,
        selectedWorkerCount: eligibleWorkers.length,
        selectedWorkerId: best.deviceId,
        calibratedLocalThroughputMBs: Number((localThroughput / (1024 * 1024)).toFixed(2)),
        calibratedSwarmThroughputMBs: Number((best.workerRate / (1024 * 1024)).toFixed(2))
      };
    }
  }
}
