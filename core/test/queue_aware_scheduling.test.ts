import { expect } from 'chai';
import { DistributionDecisionEngine, WorkerCandidateLoad } from '../src/decision_engine';
import { WorkloadDescriptor } from '../src/types';
import { KernelRegistry } from '../src/kernel_registry';

describe('Queue-Aware Adaptive Scheduling Tests (Phase 3C)', () => {
  let engine: DistributionDecisionEngine;
  let kernelRegistry: KernelRegistry;

  beforeEach(() => {
    kernelRegistry = KernelRegistry.getInstance();
    // Calibration for compute-heavy MatMul workloads:
    // Local Host CPU: 10 MB/s, Worker Node (Accelerate): 200 MB/s, LAN: 100 MB/s
    engine = new DistributionDecisionEngine({
      minGainThreshold: 1.25,
      defaultLanBandwidthBytesPerSec: 100 * 1024 * 1024,
      defaultLocalThroughputBytesPerSec: 10 * 1024 * 1024,
      defaultWorkerThroughputBytesPerSec: 200 * 1024 * 1024,
      ipcOverheadMs: 2.0,
      coordinationOverheadMs: 5.0
    });
  });

  const createMatMulWorkload = (dim: number = 512): WorkloadDescriptor => {
    const bytes = dim * dim * 4 * 2; // Two matrices (2MB for 512x512)
    return {
      version: '1.0',
      workloadId: `wkl-test-matmul-${dim}`,
      computation: {
        kernelId: 'matrix_multiply_v1',
        domain: 'linear_algebra',
        parameters: { M: dim, K: dim, N: dim }
      },
      data: {
        totalPayloadBytes: bytes,
        format: 'binary_f32',
        itemCount: 1,
        payloadBase64: 'fake-base64'
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'PASS_THROUGH'
      }
    };
  };

  it('A. Idle Remote Worker: Selects SWARM when remote predicted completion is faster', () => {
    const workload = createMatMulWorkload(512); // ~2MB payload
    const workers: WorkerCandidateLoad[] = [
      {
        deviceId: 'mac-worker-02',
        capabilityProfile: {
          capabilitySchemaVersion: 1,
          deviceId: 'mac-worker-02',
          deviceName: 'MacBook Pro M3',
          osType: 'darwin',
          osVersion: '15.0',
          cpuArch: 'arm64',
          cpuCores: 12,
          totalRamMb: 16384,
          hasGpu: true,
          supportedKernels: ['matrix_multiply_v1']
        },
        inFlightTasks: 0
      }
    ];

    const decision = engine.evaluate(workload, workers);
    expect(decision.decision).to.equal('SWARM');
    expect(decision.selectedWorkerId).to.equal('mac-worker-02');
    expect(decision.estimatedQueueTimeMs).to.equal(0);
    expect(decision.estimatedGain).to.be.greaterThan(1.25);
    expect(decision.reason).to.include("Remote worker 'mac-worker-02' predicted completion");
  });

  it('B. Remote Queue Saturated: Selects LOCAL when remote queue wait pushes effective time past local compute', () => {
    const workload = createMatMulWorkload(512);
    // Remote worker with 30 in-flight tasks (causing heavy queue wait)
    const workers: WorkerCandidateLoad[] = [
      {
        deviceId: 'mac-worker-02',
        capabilityProfile: {
          capabilitySchemaVersion: 1,
          deviceId: 'mac-worker-02',
          deviceName: 'MacBook Pro M3',
          osType: 'darwin',
          osVersion: '15.0',
          cpuArch: 'arm64',
          cpuCores: 12,
          totalRamMb: 16384,
          hasGpu: false,
          supportedKernels: ['matrix_multiply_v1']
        },
        inFlightTasks: 30 // Heavy queue backlog
      }
    ];

    const decision = engine.evaluate(workload, workers);
    expect(decision.decision).to.equal('LOCAL');
    expect(decision.estimatedQueueTimeMs).to.be.greaterThan(0);
    expect(decision.reason).to.include('queue saturation');
  });

  it('C. Multiple Simultaneous Tasks: Reservations prevent stampede on empty remote queue', () => {
    const workload = createMatMulWorkload(512);
    const workerId = 'mac-worker-fast';
    const worker: WorkerCandidateLoad = {
      deviceId: workerId,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId: workerId,
        deviceName: 'Mac Studio M2 Ultra',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 24,
        totalRamMb: 65536,
        hasGpu: false,
        supportedKernels: ['matrix_multiply_v1']
      }
    };

    // Task 1: Remote is idle (0 in-flight) -> SWARM
    const decision1 = engine.evaluate(workload, [worker]);
    expect(decision1.decision).to.equal('SWARM');
    expect(decision1.estimatedQueueTimeMs).to.equal(0);

    // Acquire reservation for Task 1
    engine.acquireReservation(workerId);
    expect(engine.getInFlightCount(workerId)).to.equal(1);

    // Task 2: Remote now has 1 in-flight -> Queue wait is non-zero
    const decision2 = engine.evaluate(workload, [worker]);
    expect(decision2.estimatedQueueTimeMs).to.be.greaterThan(0);

    // Saturate the worker by acquiring 25 reservations
    for (let i = 0; i < 25; i++) {
      engine.acquireReservation(workerId);
    }

    // Next task: Remote queue is saturated -> Decision switches to LOCAL
    const decisionSaturated = engine.evaluate(workload, [worker]);
    expect(decisionSaturated.decision).to.equal('LOCAL');

    // Release all reservations -> Decision switches back to SWARM
    for (let i = 0; i < 26; i++) {
      engine.releaseReservation(workerId);
    }
    expect(engine.getInFlightCount(workerId)).to.equal(0);

    const decisionAfterRelease = engine.evaluate(workload, [worker]);
    expect(decisionAfterRelease.decision).to.equal('SWARM');
  });

  it('D. Multiple Heterogeneous Workers: Dynamically balances workloads across fastest queue', () => {
    const workload = createMatMulWorkload(512);
    const workers: WorkerCandidateLoad[] = [
      {
        deviceId: 'worker-m2-air',
        capabilityProfile: {
          capabilitySchemaVersion: 1,
          deviceId: 'worker-m2-air',
          deviceName: 'MacBook Air M2',
          osType: 'darwin',
          osVersion: '15.0',
          cpuArch: 'arm64',
          cpuCores: 8,
          totalRamMb: 16384,
          hasGpu: false,
          supportedKernels: ['matrix_multiply_v1']
        },
        inFlightTasks: 0 // Idle
      },
      {
        deviceId: 'worker-m3-max',
        capabilityProfile: {
          capabilitySchemaVersion: 1,
          deviceId: 'worker-m3-max',
          deviceName: 'MacBook Pro M3 Max',
          osType: 'darwin',
          osVersion: '15.0',
          cpuArch: 'arm64',
          cpuCores: 16,
          totalRamMb: 36864,
          hasGpu: false,
          supportedKernels: ['matrix_multiply_v1']
        },
        inFlightTasks: 20 // Saturated queue
      }
    ];

    // Worker M3 Max is saturated (20 in-flight tasks); M2 Air is idle
    const decision = engine.evaluate(workload, workers);
    expect(decision.decision).to.equal('SWARM');
    expect(decision.selectedWorkerId).to.equal('worker-m2-air');
  });

  it('E. Gating Rules: Small payloads below threshold remain LOCAL', () => {
    const smallWorkload: WorkloadDescriptor = {
      version: '1.0',
      workloadId: 'wkl-small',
      computation: { kernelId: 'matrix_multiply_v1', domain: 'linear_algebra', parameters: { M: 16, K: 16, N: 16 } },
      data: { totalPayloadBytes: 2048, format: 'binary_f32', itemCount: 1, payloadBase64: 'fake' },
      constraints: { isPure: true, isIdempotent: true, toleranceValidator: 'PASS_THROUGH' }
    };
    const workers: WorkerCandidateLoad[] = [
      {
        deviceId: 'mac-worker-02',
        capabilityProfile: {
          capabilitySchemaVersion: 1,
          deviceId: 'mac-worker-02',
          deviceName: 'MacBook Pro M3',
          osType: 'darwin',
          osVersion: '15.0',
          cpuArch: 'arm64',
          cpuCores: 12,
          totalRamMb: 16384,
          hasGpu: true,
          supportedKernels: ['matrix_multiply_v1']
        },
        inFlightTasks: 0
      }
    ];

    const decision = engine.evaluate(smallWorkload, workers);
    expect(decision.decision).to.equal('LOCAL');
    expect(decision.reason).to.include('below minimum beneficial threshold');
  });
});
