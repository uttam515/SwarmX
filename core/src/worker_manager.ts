import { 
  CapabilityProfile, 
  CAPABILITY_SCHEMA_VERSION, 
  WorkerTelemetry, 
  ThermalState,
  WorkerExecutionStage,
  WorkerLiveState
} from './types';

export interface WorkerState {
  deviceId: string;
  capabilityProfile: CapabilityProfile;
  latestTelemetry?: WorkerTelemetry;
  isEligible: boolean;
  connectedAtMs: number;
  lastHeartbeatMs: number;
  liveState?: WorkerLiveState;
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

    const liveState: WorkerLiveState = existing?.liveState || {
      deviceId: profile.deviceId,
      deviceName: profile.deviceName || profile.deviceId,
      connectionState: 'CONNECTED',
      stage: WorkerExecutionStage.READY,
      completedChunks: 0,
      failedChunks: 0,
      retryCount: 0,
      pipelineStages: {
        fetching: false,
        decrypting: false,
        decoding: false,
        executing: false,
        transmitting: false
      },
      lastHeartbeatMs: now,
      isEligible: false
    };

    liveState.connectionState = 'CONNECTED';
    liveState.stage = WorkerExecutionStage.READY;
    liveState.lastHeartbeatMs = now;

    const workerState: WorkerState = {
      deviceId: profile.deviceId,
      capabilityProfile: profile,
      latestTelemetry: existing?.latestTelemetry,
      isEligible: existing?.isEligible ?? false,
      connectedAtMs: existing?.connectedAtMs ?? now,
      lastHeartbeatMs: now,
      liveState
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

    const live = this.getOrCreateLiveState(worker);
    worker.latestTelemetry = telemetry;
    worker.isEligible = isEligible;
    worker.lastHeartbeatMs = Date.now();
    live.isEligible = isEligible;
    live.lastHeartbeatMs = worker.lastHeartbeatMs;

    this.workers.set(telemetry.deviceId, worker);
    return worker;
  }

  private getOrCreateLiveState(worker: WorkerState): WorkerLiveState {
    if (!worker.liveState) {
      worker.liveState = {
        deviceId: worker.deviceId,
        deviceName: worker.capabilityProfile?.deviceName || worker.deviceId,
        connectionState: 'CONNECTED',
        stage: WorkerExecutionStage.READY,
        completedChunks: 0,
        failedChunks: 0,
        retryCount: 0,
        pipelineStages: {
          fetching: false,
          decrypting: false,
          decoding: false,
          executing: false,
          transmitting: false
        },
        lastHeartbeatMs: worker.lastHeartbeatMs || Date.now(),
        isEligible: worker.isEligible
      };
    }
    return worker.liveState;
  }

  /**
   * Updates the live execution stage and task context for a worker.
   */
  public updateWorkerStage(
    deviceId: string,
    stage: WorkerExecutionStage,
    details?: Partial<WorkerLiveState>
  ): WorkerLiveState | undefined {
    const worker = this.workers.get(deviceId);
    if (!worker) return undefined;

    const live = this.getOrCreateLiveState(worker);
    const now = Date.now();
    live.stage = stage;
    live.stageStartTimeMs = now;

    if (details) {
      if (details.currentTaskId !== undefined) live.currentTaskId = details.currentTaskId;
      if (details.currentChunkIndex !== undefined) live.currentChunkIndex = details.currentChunkIndex;
      if (details.totalChunks !== undefined) live.totalChunks = details.totalChunks;
      if (details.startFrameIndex !== undefined) live.startFrameIndex = details.startFrameIndex;
      if (details.frameCount !== undefined) live.frameCount = details.frameCount;
      if (details.executionTimeMs !== undefined) live.executionTimeMs = details.executionTimeMs;
      if (details.lastCompletedTaskId !== undefined) live.lastCompletedTaskId = details.lastCompletedTaskId;
      if (details.pipelineStages) {
        live.pipelineStages = { ...live.pipelineStages, ...details.pipelineStages };
      }
    }

    // Authoritative pipeline stage flag synchronization based on real stage
    if (stage === WorkerExecutionStage.FETCHING) {
      live.pipelineStages = { fetching: true, decrypting: false, decoding: false, executing: false, transmitting: false };
    } else if (stage === WorkerExecutionStage.DECRYPTING) {
      live.pipelineStages = { fetching: true, decrypting: true, decoding: false, executing: false, transmitting: false };
    } else if (stage === WorkerExecutionStage.DECODING) {
      live.pipelineStages = { fetching: true, decrypting: true, decoding: true, executing: false, transmitting: false };
    } else if (stage === WorkerExecutionStage.EXECUTING) {
      live.pipelineStages = { fetching: true, decrypting: true, decoding: true, executing: true, transmitting: false };
    } else if (stage === WorkerExecutionStage.TRANSMITTING) {
      live.pipelineStages = { fetching: true, decrypting: true, decoding: true, executing: true, transmitting: true };
    } else if (stage === WorkerExecutionStage.COMPLETED || stage === WorkerExecutionStage.READY) {
      if (stage === WorkerExecutionStage.COMPLETED) {
        live.completedChunks++;
      }
      live.currentTaskId = undefined;
      live.currentChunkIndex = undefined;
      live.startFrameIndex = undefined;
      live.frameCount = undefined;
      live.pipelineStages = { fetching: false, decrypting: false, decoding: false, executing: false, transmitting: false };
    } else if (stage === WorkerExecutionStage.FAILED) {
      live.failedChunks++;
    } else if (stage === WorkerExecutionStage.RETRYING) {
      live.retryCount++;
    } else if (stage === WorkerExecutionStage.OFFLINE) {
      live.connectionState = 'OFFLINE';
    }

    return live;
  }

  public unregisterWorker(deviceId: string): boolean {
    const worker = this.workers.get(deviceId);
    if (worker && worker.liveState) {
      worker.liveState.connectionState = 'OFFLINE';
      worker.liveState.stage = WorkerExecutionStage.OFFLINE;
    }
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

  public listLiveStates(): WorkerLiveState[] {
    return Array.from(this.workers.values()).map(w => this.getOrCreateLiveState(w));
  }
}
