import { 
  CapabilityProfile, 
  CAPABILITY_SCHEMA_VERSION, 
  WorkerTelemetry, 
  ThermalState 
} from './types';

export interface WorkerState {
  deviceId: string;
  capabilityProfile: CapabilityProfile;
  latestTelemetry?: WorkerTelemetry;
  isEligible: boolean;
  connectedAtMs: number;
  lastHeartbeatMs: number;
}

export class WorkerManager {
  private workers: Map<string, WorkerState> = new Map();

  /**
   * Ingests and registers a worker's versioned capability profile.
   * Throws an error if capability_schema_version is unsupported.
   */
  public registerWorker(profile: CapabilityProfile): WorkerState {
    if (profile.capabilitySchemaVersion !== CAPABILITY_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported capability schema version: ${profile.capabilitySchemaVersion}. Expected version ${CAPABILITY_SCHEMA_VERSION}.`
      );
    }

    const now = Date.now();
    const existing = this.workers.get(profile.deviceId);

    const workerState: WorkerState = {
      deviceId: profile.deviceId,
      capabilityProfile: profile,
      latestTelemetry: existing?.latestTelemetry,
      isEligible: existing?.isEligible ?? false,
      connectedAtMs: existing?.connectedAtMs ?? now,
      lastHeartbeatMs: now
    };

    this.workers.set(profile.deviceId, workerState);
    return workerState;
  }

  /**
   * Hard eligibility gate (0 or 1):
   * Gate conditions:
   * 1. Battery: battery_level >= 0.20 OR is_charging === true
   * 2. Thermal: thermal_state < SERIOUS (i.e. NOMINAL or FAIR only)
   * 3. CPU: cpu_utilization < 0.90 (90%)
   */
  public evaluateEligibility(telemetry: WorkerTelemetry): boolean {
    const batteryOk = telemetry.batteryLevel >= 0.20 || telemetry.isCharging === true;
    const thermalOk = telemetry.thermalState < ThermalState.SERIOUS;
    const cpuOk = telemetry.cpuUtilization < 0.90;

    return batteryOk && thermalOk && cpuOk;
  }

  /**
   * Updates worker telemetry and recomputes eligibility status.
   */
  public updateTelemetry(telemetry: WorkerTelemetry): WorkerState {
    const worker = this.workers.get(telemetry.deviceId);
    if (!worker) {
      throw new Error(`Worker ${telemetry.deviceId} is not registered`);
    }

    const isEligible = this.evaluateEligibility(telemetry);
    telemetry.isEligible = isEligible;

    worker.latestTelemetry = telemetry;
    worker.isEligible = isEligible;
    worker.lastHeartbeatMs = Date.now();

    this.workers.set(telemetry.deviceId, worker);
    return worker;
  }

  public unregisterWorker(deviceId: string): boolean {
    return this.workers.delete(deviceId);
  }

  public getWorker(deviceId: string): WorkerState | undefined {
    return this.workers.get(deviceId);
  }

  public listWorkers(): WorkerState[] {
    return Array.from(this.workers.values());
  }

  public listEligibleWorkers(): WorkerState[] {
    return Array.from(this.workers.values()).filter(w => w.isEligible);
  }
}
