import { expect } from 'chai';
import { DistributionDecisionEngine } from '../src/decision_engine';
import { WorkloadDescriptor, ThermalState } from '../src/types';

describe('DistributionDecisionEngine Tests (Phase B)', () => {
  const engine = new DistributionDecisionEngine();

  const createTestWorkload = (bytes: number, kernelId = 'image_filter_box_blur_v1'): WorkloadDescriptor => ({
    workloadId: 'test-wkl-01',
    version: '1.0.0',
    computation: {
      domain: 'IMAGE_PROCESSING',
      kernelId,
      parameters: { radius: 2 }
    },
    data: {
      itemCount: 1,
      totalPayloadBytes: bytes,
      format: 'RAW_PLANAR_RGBA_UINT8'
    },
    constraints: {
      isPure: true,
      isIdempotent: true,
      toleranceValidator: 'IMAGE_PIXEL_DELTA'
    }
  });

  it('1. Uncertified kernel -> LOCAL with clear reason', () => {
    const wkl = createTestWorkload(10 * 1024 * 1024, 'custom_unregistered_filter');
    const result = engine.evaluate(wkl, [{ deviceId: 'worker-1' }]);
    expect(result.decision).to.equal('LOCAL');
    expect(result.reason).to.include('not certified');
  });

  it('2. Tiny payload below threshold -> LOCAL', () => {
    const wkl = createTestWorkload(1024); // 1 KB < 64 KB minimum
    const result = engine.evaluate(wkl, [{ deviceId: 'worker-1' }]);
    expect(result.decision).to.equal('LOCAL');
    expect(result.reason).to.include('below minimum beneficial threshold');
  });

  it('3. No connected workers -> LOCAL', () => {
    const wkl = createTestWorkload(50 * 1024 * 1024);
    const result = engine.evaluate(wkl, []);
    expect(result.decision).to.equal('LOCAL');
    expect(result.reason).to.include('No eligible workers');
  });

  it('4. Ineligible workers (thermal throttle & CPU overload) -> LOCAL', () => {
    const wkl = createTestWorkload(50 * 1024 * 1024);
    const result = engine.evaluate(wkl, [
      {
        deviceId: 'worker-overloaded',
        telemetry: {
          deviceId: 'worker-overloaded',
          timestampMs: Date.now(),
          batteryLevel: 0.9,
          isCharging: true,
          thermalState: ThermalState.SERIOUS, // Throttle!
          cpuUtilization: 0.95, // 95% CPU!
          availableRamMb: 8000
        }
      }
    ]);
    expect(result.decision).to.equal('LOCAL');
    expect(result.reason).to.include('No eligible workers');
  });

  it('5. Large workload with multiple fast GPU workers -> SWARM', () => {
    // 50 MB image batch across 3 fast workers
    const wkl = createTestWorkload(50 * 1024 * 1024);
    const fastEngine = new DistributionDecisionEngine({
      defaultLanBandwidthBytesPerSec: 50 * 1024 * 1024 // 50 MB/s LAN
    });

    const result = fastEngine.evaluate(wkl, [
      {
        deviceId: 'worker-mac-1',
        capabilityProfile: {
          capabilitySchemaVersion: 1,
          deviceId: 'worker-mac-1',
          deviceName: 'MacBook Pro M2',
          osType: 'darwin',
          osVersion: '15.0',
          cpuArch: 'arm64',
          cpuCores: 12,
          totalRamMb: 32768,
          hasGpu: true
        }
      },
      {
        deviceId: 'worker-mac-2',
        capabilityProfile: {
          capabilitySchemaVersion: 1,
          deviceId: 'worker-mac-2',
          deviceName: 'MacBook Air M3',
          osType: 'darwin',
          osVersion: '15.0',
          cpuArch: 'arm64',
          cpuCores: 8,
          totalRamMb: 16384,
          hasGpu: true
        }
      },
      {
        deviceId: 'worker-win-1',
        capabilityProfile: {
          capabilitySchemaVersion: 1,
          deviceId: 'worker-win-1',
          deviceName: 'Desktop RTX',
          osType: 'windows',
          osVersion: '11.0',
          cpuArch: 'x64',
          cpuCores: 16,
          totalRamMb: 32768,
          hasGpu: true
        }
      }
    ]);

    expect(result.decision).to.equal('SWARM');
    expect(result.estimatedGain).to.be.greaterThan(1.25);
    expect(result.selectedWorkerCount).to.equal(3);
  });

  it('6. Slow transfer bandwidth making distribution slower than local -> LOCAL', () => {
    const wkl = createTestWorkload(20 * 1024 * 1024);
    const slowLanEngine = new DistributionDecisionEngine({
      defaultLanBandwidthBytesPerSec: 2 * 1024 * 1024 // Very slow 2 MB/s link
    });

    const result = slowLanEngine.evaluate(wkl, [
      {
        deviceId: 'worker-1',
        capabilityProfile: {
          capabilitySchemaVersion: 1,
          deviceId: 'worker-1',
          deviceName: 'Worker',
          osType: 'darwin',
          osVersion: '15.0',
          cpuArch: 'arm64',
          cpuCores: 8,
          totalRamMb: 16384,
          hasGpu: false
        }
      }
    ]);

    expect(result.decision).to.equal('LOCAL');
    expect(result.estimatedGain).to.be.lessThan(1.25);
    expect(result.reason).to.include('below threshold');
  });

  it('7. Calibration store dynamically adjusts decision based on empirical measurements', () => {
    const customEngine = new DistributionDecisionEngine({
      defaultLanBandwidthBytesPerSec: 50 * 1024 * 1024
    });

    // Record empirical local measurement: 5 MB/s (slower local CPU)
    customEngine.recordLocalCalibration('image_filter_box_blur_v1', 5 * 1024 * 1024);
    // Record empirical worker measurement: 50 MB/s (fast GPU worker)
    customEngine.recordWorkerCalibration('worker-fast', 'image_filter_box_blur_v1', 50 * 1024 * 1024);

    const wkl = createTestWorkload(16 * 1024 * 1024); // 16 MB (2048x2048)
    const result = customEngine.evaluate(wkl, [{
      deviceId: 'worker-fast',
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId: 'worker-fast',
        deviceName: 'MacBook Pro M3 Max',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 16,
        totalRamMb: 65536,
        hasGpu: true
      }
    }]);

    expect(result.decision).to.equal('SWARM');
    expect(result.calibratedLocalThroughputMBs).to.equal(5.0);
    expect(result.calibratedSwarmThroughputMBs).to.equal(50.0);
    expect(result.estimatedGain).to.be.greaterThan(2.0);
  });
});

