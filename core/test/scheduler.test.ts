import { expect } from 'chai';
import { DeterministicFifoScheduler } from '../src/scheduler';
import { WorkerManager, WorkerState } from '../src/worker_manager';
import { Task, TaskStatus, CapabilityProfile, ThermalState, CAPABILITY_SCHEMA_VERSION } from '../src/types';

describe('Scheduler Interface & Boundary Tests', () => {
  let scheduler: DeterministicFifoScheduler;
  let workerManager: WorkerManager;

  const makeWorker = (
    id: string,
    cores: number,
    ramMb: number,
    hasGpu: boolean,
    battery: number = 0.80,
    isCharging: boolean = true
  ): WorkerState => {
    const profile: CapabilityProfile = {
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      deviceId: id,
      deviceName: `Worker ${id}`,
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: cores,
      totalRamMb: ramMb,
      hasGpu,
      gpuModel: hasGpu ? 'Apple M3 Pro' : undefined
    };

    workerManager.registerWorker(profile);
    return workerManager.updateTelemetry({
      deviceId: id,
      timestampMs: Date.now(),
      batteryLevel: battery,
      isCharging,
      thermalState: ThermalState.NOMINAL,
      cpuUtilization: 0.15,
      availableRamMb: ramMb / 2
    });
  };

  beforeEach(() => {
    scheduler = new DeterministicFifoScheduler();
    workerManager = new WorkerManager();
  });

  it('Separation of Concerns: Only eligible workers pass to scheduler', () => {
    // Worker 1: Eligible
    const w1 = makeWorker('worker-1', 8, 16384, false);
    expect(w1.isEligible).to.be.true;

    // Worker 2: Ineligible due to critical thermal state
    const w2Profile: CapabilityProfile = {
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      deviceId: 'worker-hot',
      deviceName: 'Overheating Worker',
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 16,
      totalRamMb: 65536,
      hasGpu: true
    };
    workerManager.registerWorker(w2Profile);
    const w2 = workerManager.updateTelemetry({
      deviceId: 'worker-hot',
      timestampMs: Date.now(),
      batteryLevel: 0.90,
      isCharging: true,
      thermalState: ThermalState.CRITICAL, // Gate fails
      cpuUtilization: 0.95,
      availableRamMb: 32768
    });
    expect(w2.isEligible).to.be.false;

    // Pre-filtering: Scheduler only consumes eligible workers
    const eligiblePool = workerManager.listEligibleWorkers();
    expect(eligiblePool).to.have.lengthOf(1);
    expect(eligiblePool[0].deviceId).to.equal('worker-1');
  });

  it('Deterministic Selection: Selects worker matching CPU, RAM, and GPU constraints', () => {
    const wSmall = makeWorker('worker-small', 4, 8192, false);
    const wGpu = makeWorker('worker-gpu', 12, 36864, true);

    const gpuTask: Task = {
      id: 'task-gpu',
      inputRef: 'data://ml-dataset',
      computationDescriptor: 'matrix-multiply',
      requiredResources: { minCpuCores: 8, minRamMb: 16384, requiresGpu: true },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'data://out',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    const eligible = workerManager.listEligibleWorkers();
    const selected = scheduler.selectWorker(gpuTask, eligible);
    expect(selected).to.not.be.null;
    expect(selected!.deviceId).to.equal('worker-gpu');

    // If task requires 64 cores, no worker matches
    const hugeTask: Task = { ...gpuTask, id: 'task-huge', requiredResources: { minCpuCores: 64 } };
    const noWorker = scheduler.selectWorker(hugeTask, eligible);
    expect(noWorker).to.be.null;
  });
});
