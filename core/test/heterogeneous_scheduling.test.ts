import { expect } from 'chai';
import { ScoredScheduler, CandidateScore } from '../src/scheduler';
import { WorkerState } from '../src/worker_manager';
import { Task, TaskStatus, ThermalState } from '../src/types';

describe('Heterogeneous Worker Simulation & Adaptive Scheduling (Phase H)', () => {
  let scheduler: ScoredScheduler;

  // 4 Deterministic Simulated Worker Profiles
  const workerA_MacGPU: WorkerState = {
    deviceId: 'worker-a-mac-gpu',
    isEligible: true,
    capabilityProfile: {
      capabilitySchemaVersion: 1,
      deviceId: 'worker-a-mac-gpu',
      deviceName: 'MacBook Pro M3 Max',
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 16,
      totalRamMb: 65536,
      hasGpu: true,
      gpuModel: 'Apple M3 Max 40-core GPU',
      gpuAccelerationType: 'Metal',
      supportedKernels: ['image_filter_box_blur_v1', 'matrix_multiply_v1']
    },
    latestTelemetry: {
      deviceId: 'worker-a-mac-gpu',
      timestampMs: Date.now(),
      batteryLevel: 0.95,
      isCharging: true,
      thermalState: ThermalState.NOMINAL,
      cpuUtilization: 0.15,
      availableRamMb: 50000,
      isEligible: true
    },
    connectedAtMs: Date.now(),
    lastHeartbeatMs: Date.now()
  };

  const workerB_WindowsCPU: WorkerState = {
    deviceId: 'worker-b-win-cpu',
    isEligible: true,
    capabilityProfile: {
      capabilitySchemaVersion: 1,
      deviceId: 'worker-b-win-cpu',
      deviceName: 'Dell XPS 15 (Core i7)',
      osType: 'windows',
      osVersion: '11.0',
      cpuArch: 'x64',
      cpuCores: 12,
      totalRamMb: 32768,
      hasGpu: false,
      supportedKernels: ['image_filter_box_blur_v1']
    },
    latestTelemetry: {
      deviceId: 'worker-b-win-cpu',
      timestampMs: Date.now(),
      batteryLevel: 0.80,
      isCharging: false,
      thermalState: ThermalState.FAIR,
      cpuUtilization: 0.35,
      availableRamMb: 20000,
      isEligible: true
    },
    connectedAtMs: Date.now(),
    lastHeartbeatMs: Date.now()
  };

  const workerC_AndroidGPU: WorkerState = {
    deviceId: 'worker-c-android-gpu',
    isEligible: true,
    capabilityProfile: {
      capabilitySchemaVersion: 1,
      deviceId: 'worker-c-android-gpu',
      deviceName: 'Galaxy S24 Ultra',
      osType: 'android',
      osVersion: '14.0',
      cpuArch: 'arm64',
      cpuCores: 8,
      totalRamMb: 12288,
      hasGpu: true,
      gpuModel: 'Adreno 750',
      gpuAccelerationType: 'Vulkan',
      supportedKernels: ['image_filter_box_blur_v1']
    },
    latestTelemetry: {
      deviceId: 'worker-c-android-gpu',
      timestampMs: Date.now(),
      batteryLevel: 0.65,
      isCharging: false,
      thermalState: ThermalState.NOMINAL,
      cpuUtilization: 0.40,
      availableRamMb: 6000,
      isEligible: true
    },
    connectedAtMs: Date.now(),
    lastHeartbeatMs: Date.now()
  };

  const workerD_Overloaded: WorkerState = {
    deviceId: 'worker-d-busy',
    isEligible: false,
    capabilityProfile: {
      capabilitySchemaVersion: 1,
      deviceId: 'worker-d-busy',
      deviceName: 'Busy Server',
      osType: 'linux',
      osVersion: '6.5',
      cpuArch: 'x64',
      cpuCores: 32,
      totalRamMb: 131072,
      hasGpu: true,
      supportedKernels: ['image_filter_box_blur_v1']
    },
    latestTelemetry: {
      deviceId: 'worker-d-busy',
      timestampMs: Date.now(),
      batteryLevel: 1.0,
      isCharging: true,
      thermalState: ThermalState.CRITICAL, // Overheating!
      cpuUtilization: 0.96, // High load!
      availableRamMb: 10000,
      isEligible: false
    },
    connectedAtMs: Date.now(),
    lastHeartbeatMs: Date.now()
  };

  beforeEach(() => {
    scheduler = new ScoredScheduler();
    scheduler.setWorkerThroughput('worker-a-mac-gpu', 1800); // 1800 items/s
    scheduler.setWorkerThroughput('worker-b-win-cpu', 900);   // 900 items/s
    scheduler.setWorkerThroughput('worker-c-android-gpu', 450); // 450 items/s
  });

  it('1. Hard eligibility gate rejects overheated/overloaded workers before scoring', () => {
    const task: Task = {
      id: 't1',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: { minCpuCores: 4 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    const decision = scheduler.scheduleTask(task, [workerA_MacGPU, workerD_Overloaded]);
    expect(decision.status).to.equal('ASSIGNED');
    expect(decision.selectedWorker?.deviceId).to.equal('worker-a-mac-gpu');

    // Hard pre-filter excludes worker-d-busy before scoring
    expect(decision.candidateScores.some(c => c.workerId === 'worker-d-busy')).to.be.false;
  });

  it('2. Kernel compatibility rejects workers lacking certified kernel', () => {
    const matrixTask: Task = {
      id: 't-matrix',
      inputRef: 'ref',
      computationDescriptor: 'matrix_multiply_v1', // Only Worker A supports this
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    const decision = scheduler.scheduleTask(matrixTask, [workerA_MacGPU, workerB_WindowsCPU, workerC_AndroidGPU]);
    expect(decision.selectedWorker?.deviceId).to.equal('worker-a-mac-gpu');

    // Worker B and C do not support matrix_multiply_v1
    expect(decision.candidateScores.some(c => c.workerId === 'worker-b-win-cpu')).to.be.false;
    expect(decision.candidateScores.some(c => c.workerId === 'worker-c-android-gpu')).to.be.false;
  });

  it('3. GPU constraint routes GPU-required tasks strictly to GPU-capable workers', () => {
    const gpuTask: Task = {
      id: 't-gpu',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: { requiresGpu: true },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    const decision = scheduler.scheduleTask(gpuTask, [workerB_WindowsCPU, workerC_AndroidGPU]);
    expect(decision.selectedWorker?.deviceId).to.equal('worker-c-android-gpu');

    // Worker B lacks GPU and is excluded from candidateScores
    expect(decision.candidateScores.some(c => c.workerId === 'worker-b-win-cpu')).to.be.false;
  });

  it('4. Multi-chunk allocation divides 1000 work items proportionally to capacity/scores', () => {
    const task: Task = {
      id: 't-multi',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    const decision = scheduler.scheduleTask(task, [workerA_MacGPU, workerB_WindowsCPU, workerC_AndroidGPU]);
    const allocation = scheduler.allocateMultiChunkWorkload(1000, decision.candidateScores);

    const allocA = allocation.get('worker-a-mac-gpu') || 0;
    const allocB = allocation.get('worker-b-win-cpu') || 0;
    const allocC = allocation.get('worker-c-android-gpu') || 0;

    expect(allocA + allocB + allocC).to.equal(1000);
    // Worker A (fastest GPU) gets largest slice, B gets medium, C gets smallest
    expect(allocA).to.be.greaterThan(allocB);
    expect(allocB).to.be.greaterThan(allocC);
    expect(allocA).to.be.greaterThan(400); // ~50%
  });

  it('5. Adaptive throughput updates dynamically re-rank workers when conditions change', () => {
    const task: Task = {
      id: 't-adapt',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    // Initially Worker A wins
    const decision1 = scheduler.scheduleTask(task, [workerA_MacGPU, workerB_WindowsCPU]);
    expect(decision1.selectedWorker?.deviceId).to.equal('worker-a-mac-gpu');

    // Simulate Worker A throughput dropping drastically (e.g. background workload / thermal throttling)
    scheduler.updateWorkerThroughputEma('worker-a-mac-gpu', 100, 1.0); // Drops to 100 items/s
    scheduler.updateWorkerThroughputEma('worker-b-win-cpu', 1200, 1.0); // Rises to 1200 items/s

    const decision2 = scheduler.scheduleTask(task, [workerA_MacGPU, workerB_WindowsCPU]);
    // Worker B overtakes Worker A!
    expect(decision2.selectedWorker?.deviceId).to.equal('worker-b-win-cpu');
  });

  it('6. Worker instability penalties demote frequently failing workers', () => {
    const task: Task = {
      id: 't-fail',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'mem',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    // Set equal baseline throughput
    scheduler.setWorkerThroughput('worker-a-mac-gpu', 1000);
    scheduler.setWorkerThroughput('worker-b-win-cpu', 1000);

    // Record 4 failures on Worker A
    scheduler.recordWorkerFailure('worker-a-mac-gpu');
    scheduler.recordWorkerFailure('worker-a-mac-gpu');
    scheduler.recordWorkerFailure('worker-a-mac-gpu');
    scheduler.recordWorkerFailure('worker-a-mac-gpu');

    const decision = scheduler.scheduleTask(task, [workerA_MacGPU, workerB_WindowsCPU]);
    const scoreA = decision.candidateScores.find(c => c.workerId === 'worker-a-mac-gpu')!;
    expect(scoreA.components.instabilityPenalty).to.equal(1.0); // 4 * 0.30 capped at 1.0
    expect(decision.selectedWorker?.deviceId).to.equal('worker-b-win-cpu');
  });
});
