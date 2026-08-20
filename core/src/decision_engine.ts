import { WorkloadDescriptor, WorkerTelemetry, CapabilityProfile } from './types';
import { KernelRegistry } from './kernel_registry';
import { WorkerManager } from './worker_manager';

export interface DecisionResult {
  decision: 'SWARM' | 'LOCAL';
  estimatedLocalTimeMs: number;
  estimatedSwarmTimeMs: number;
  estimatedGain: number; // Ratio: T_local / T_swarm
  reason: string;
  selectedWorkerCount: number;
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

export class DistributionDecisionEngine {
  private config: DecisionEngineConfig;
  private kernelRegistry: KernelRegistry;
  private localKernelCalibration: Map<string, number> = new Map(); // kernelId -> measured bytes/sec
  private workerKernelCalibration: Map<string, number> = new Map(); // `${deviceId}:${kernelId}` -> measured bytes/sec

  constructor(
    config: Partial<DecisionEngineConfig> = {},
    kernelRegistry: KernelRegistry = KernelRegistry.getInstance()
  ) {
    this.config = { ...DEFAULT_DECISION_CONFIG, ...config };
    this.kernelRegistry = kernelRegistry;
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

  public evaluate(
    workload: WorkloadDescriptor,
    connectedWorkers: { deviceId: string; capabilityProfile?: CapabilityProfile; telemetry?: WorkerTelemetry }[]
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
        estimatedLocalTimeMs: localTimeMs,
        estimatedSwarmTimeMs: localTimeMs * 2,
        estimatedGain: 0.5,
        reason: `Payload (${payloadBytes} bytes) is below minimum beneficial threshold (${kernel.minBeneficialBytes} bytes)`,
        selectedWorkerCount: 0,
        calibratedLocalThroughputMBs: Number((localThroughput / (1024 * 1024)).toFixed(2))
      };
    }

    // 3. Gating Rule: Filter Eligible Workers with Kernel Platform Support
    const eligibleWorkers = connectedWorkers.filter(w => {
      // Must pass thermal & CPU load rule if telemetry is present
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
        estimatedLocalTimeMs: localTimeMs,
        estimatedSwarmTimeMs: Infinity,
        estimatedGain: 0,
        reason: 'No eligible workers available in cluster',
        selectedWorkerCount: 0,
        calibratedLocalThroughputMBs: Number((localThroughput / (1024 * 1024)).toFixed(2))
      };
    }

    // 4. Mathematical Cost Model Calculation
    // Local execution time: T_local = payloadBytes / throughput_local
    const estimatedLocalTimeMs = (payloadBytes / localThroughput) * 1000;

    // Transfer time: T_transfer = 2 * (payloadBytes / LAN_Bandwidth) (send input + receive output)
    const transferTimeMs = ((2 * payloadBytes) / this.config.defaultLanBandwidthBytesPerSec) * 1000;

    // Aggregate swarm compute throughput: sum of calibrated worker throughputs
    let aggregateWorkerThroughput = 0;
    for (const w of eligibleWorkers) {
      const workerRate = this.getWorkerThroughput(w.deviceId, kernelId, w.capabilityProfile?.hasGpu ?? false);
      aggregateWorkerThroughput += workerRate;
    }

    const swarmComputeTimeMs = (payloadBytes / aggregateWorkerThroughput) * 1000;
    const estimatedSwarmTimeMs =
      this.config.ipcOverheadMs +
      transferTimeMs +
      swarmComputeTimeMs +
      this.config.coordinationOverheadMs;

    const estimatedGain = estimatedSwarmTimeMs > 0 ? estimatedLocalTimeMs / estimatedSwarmTimeMs : 0;

    // 5. Decision Threshold
    if (estimatedGain >= this.config.minGainThreshold) {
      return {
        decision: 'SWARM',
        estimatedLocalTimeMs: Math.round(estimatedLocalTimeMs),
        estimatedSwarmTimeMs: Math.round(estimatedSwarmTimeMs),
        estimatedGain: Number(estimatedGain.toFixed(2)),
        reason: `Estimated swarm speedup of ${estimatedGain.toFixed(2)}x exceeds threshold (${this.config.minGainThreshold}x) across ${eligibleWorkers.length} worker(s)`,
        selectedWorkerCount: eligibleWorkers.length,
        calibratedLocalThroughputMBs: Number((localThroughput / (1024 * 1024)).toFixed(2)),
        calibratedSwarmThroughputMBs: Number((aggregateWorkerThroughput / (1024 * 1024)).toFixed(2))
      };
    } else {
      return {
        decision: 'LOCAL',
        estimatedLocalTimeMs: Math.round(estimatedLocalTimeMs),
        estimatedSwarmTimeMs: Math.round(estimatedSwarmTimeMs),
        estimatedGain: Number(estimatedGain.toFixed(2)),
        reason: `Estimated swarm speedup of ${estimatedGain.toFixed(2)}x is below threshold (${this.config.minGainThreshold}x) due to network transfer overhead`,
        selectedWorkerCount: eligibleWorkers.length,
        calibratedLocalThroughputMBs: Number((localThroughput / (1024 * 1024)).toFixed(2)),
        calibratedSwarmThroughputMBs: Number((aggregateWorkerThroughput / (1024 * 1024)).toFixed(2))
      };
    }
  }
}
