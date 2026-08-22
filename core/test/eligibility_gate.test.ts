import { expect } from 'chai';
import { WorkerManager } from '../src/worker_manager';
import { CapabilityProfile, ThermalState, WorkerTelemetry, CAPABILITY_SCHEMA_VERSION } from '../src/types';

describe('WorkerManager & Eligibility Gate Tests', () => {
  let workerManager: WorkerManager;

  beforeEach(() => {
    workerManager = new WorkerManager();
  });

  it('should accept valid capability schema version and reject unsupported versions', () => {
    const validProfile: CapabilityProfile = {
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      deviceId: 'worker-mac-1',
      deviceName: 'MacBook Pro M3',
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 12,
      totalRamMb: 36864,
      hasGpu: true,
      gpuModel: 'Apple M3 Pro'
    };

    const state = workerManager.registerWorker(validProfile);
    expect(state.deviceId).to.equal('worker-mac-1');

    const invalidProfile: CapabilityProfile = {
      ...validProfile,
      deviceId: 'worker-future',
      capabilitySchemaVersion: 999
    };

    expect(() => workerManager.registerWorker(invalidProfile)).to.throw(
      /Unsupported capability schema version/
    );
  });

  it('Eligibility Gate: Battery Rule (>= 20% or charging)', () => {
    const baseTelemetry: WorkerTelemetry = {
      deviceId: 'worker-1',
      timestampMs: Date.now(),
      batteryLevel: 0.15, // 15% (below threshold)
      isCharging: false,
      thermalState: ThermalState.NOMINAL,
      cpuUtilization: 0.20,
      availableRamMb: 16000
    };

    // Low battery, not charging -> INELIGIBLE (0)
    expect(workerManager.evaluateEligibility(baseTelemetry)).to.be.false;

    // Low battery, but plugged in / charging -> ELIGIBLE (1)
    expect(workerManager.evaluateEligibility({ ...baseTelemetry, isCharging: true })).to.be.true;

    // Sufficient battery (>= 20%), unplugged -> ELIGIBLE (1)
    expect(workerManager.evaluateEligibility({ ...baseTelemetry, batteryLevel: 0.20 })).to.be.true;

    // Demo Mode Override: SWARMX_DEMO_IGNORE_BATTERY=true makes low battery eligible
    process.env.SWARMX_DEMO_IGNORE_BATTERY = 'true';
    expect(workerManager.evaluateEligibility(baseTelemetry)).to.be.true;
    delete process.env.SWARMX_DEMO_IGNORE_BATTERY;
  });

  it('Eligibility Gate: Thermal Rule (NOMINAL / FAIR only)', () => {
    const baseTelemetry: WorkerTelemetry = {
      deviceId: 'worker-1',
      timestampMs: Date.now(),
      batteryLevel: 0.80,
      isCharging: false,
      thermalState: ThermalState.NOMINAL,
      cpuUtilization: 0.20,
      availableRamMb: 16000
    };

    // NOMINAL -> ELIGIBLE
    expect(workerManager.evaluateEligibility({ ...baseTelemetry, thermalState: ThermalState.NOMINAL })).to.be.true;

    // FAIR -> ELIGIBLE
    expect(workerManager.evaluateEligibility({ ...baseTelemetry, thermalState: ThermalState.FAIR })).to.be.true;

    // SERIOUS -> INELIGIBLE
    expect(workerManager.evaluateEligibility({ ...baseTelemetry, thermalState: ThermalState.SERIOUS })).to.be.false;

    // CRITICAL -> INELIGIBLE
    expect(workerManager.evaluateEligibility({ ...baseTelemetry, thermalState: ThermalState.CRITICAL })).to.be.false;
  });

  it('Eligibility Gate: CPU Load Rule (< 90%)', () => {
    const baseTelemetry: WorkerTelemetry = {
      deviceId: 'worker-1',
      timestampMs: Date.now(),
      batteryLevel: 0.80,
      isCharging: true,
      thermalState: ThermalState.NOMINAL,
      cpuUtilization: 0.85,
      availableRamMb: 16000
    };

    // 85% CPU -> ELIGIBLE
    expect(workerManager.evaluateEligibility(baseTelemetry)).to.be.true;

    // 90% CPU -> INELIGIBLE
    expect(workerManager.evaluateEligibility({ ...baseTelemetry, cpuUtilization: 0.90 })).to.be.false;

    // 95% CPU -> INELIGIBLE
    expect(workerManager.evaluateEligibility({ ...baseTelemetry, cpuUtilization: 0.95 })).to.be.false;
  });
});
