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
   */
  public evaluateEligibility(telemetry: WorkerTelemetry): boolean {
    const ignoreBattery = process.env.SWARMX_DEMO_IGNORE_BATTERY === 'true' ||
                          process.env.SWARMX_DEMO_IGNORE_BATTERY === '1' ||
                          process.env.SWARMX_FORCE_SWARM === '1';
    const batteryOk = ignoreBattery || telemetry.batteryLevel >= 0.20 || telemetry.isCharging === true;
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
