import { expect } from 'chai';
import { SimulationWorkerAdapter } from '../src/simulation_worker';
import { Task, TaskStatus } from '../src/types';
import { ToleranceAwareImageValidator } from '../src/result_validator';

describe('🧪 Development Simulation Mode & Virtual Worker Adapter Tests', () => {
  let simAdapter: SimulationWorkerAdapter;

  beforeEach(() => {
    simAdapter = new SimulationWorkerAdapter();
  });

  it('1. Simulation worker is disabled by default', () => {
    expect(simAdapter.isEnabled).to.be.false;
    const config = simAdapter.getConfig();
    expect(config.enabled).to.be.false;
    expect(config.failureMode).to.equal('NONE');
  });

  it('2. Virtual capability profile correctly reflects simulated Apple Silicon specs', () => {
    const profile = simAdapter.getCapabilityProfile();
    expect(profile.deviceId).to.equal('sim-worker-virtual-m3');
    expect(profile.deviceName).to.include('Virtual Apple Silicon Worker');
    expect(profile.cpuArch).to.equal('arm64');
    expect(profile.cpuCores).to.equal(10);
    expect(profile.totalRamMb).to.equal(16384);
    expect(profile.hasGpu).to.be.true;
    expect(profile.isSimulated).to.be.true;
  });

  it('3. Executing a task when disabled throws an explicit error', async () => {
    const task: Task = {
      id: 'task-sim-test-01',
      inputRef: 'inline',
      computationDescriptor: JSON.stringify({ kernelId: 'image_filter_box_blur_v1', parameters: { radius: 2, width: 4, height: 4, mode: 'RGBA' } }),
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    try {
      await simAdapter.executeTask(task);
      expect.fail('Should have thrown error when disabled');
    } catch (e: any) {
      expect(e.message).to.include('disabled');
    }
  });

  it('4. Executes genuine 2D BoxBlur pixel transformation and passes ToleranceAwareImageValidator', async () => {
    simAdapter.setConfig({ enabled: true, simulatedDelayMs: 5 });

    const width = 16;
    const height = 16;
    const channels = 4;
    const rawBuffer = Buffer.alloc(width * height * channels, 120);

    const task: Task = {
      id: 'task-sim-boxblur-01',
      inputRef: 'inline',
      computationDescriptor: JSON.stringify({
        kernelId: 'image_filter_box_blur_v1',
        parameters: { radius: 2, width, height, mode: 'RGBA' }
      }),
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    const result = await simAdapter.executeTask(task, rawBuffer.toString('base64'), 1);

    expect(result.workerId).to.equal('sim-worker-virtual-m3');
    expect(result.workerHostname).to.include('Simulated Mac #2');
    expect(result.outputData).to.be.a('string');

    const outputDataStr = typeof result.outputData === 'string' ? result.outputData : result.outputData.toString('base64');
    const outputBuffer = Buffer.from(outputDataStr, 'base64');
    expect(outputBuffer.length).to.equal(rawBuffer.length);

    // Validate with ToleranceAwareImageValidator against identical computed reference
    const validator = new ToleranceAwareImageValidator(outputBuffer, 2, 0.5);
    const valResult = await validator.validate(task, outputDataStr);
    expect(valResult.isValid).to.be.true;
  });

  it('5. Simulated DISCONNECTED failure mode throws and does not corrupt pipeline', async () => {
    simAdapter.setConfig({ enabled: true, failureMode: 'DISCONNECTED' });

    const task: Task = {
      id: 'task-sim-fail-01',
      inputRef: 'inline',
      computationDescriptor: JSON.stringify({ kernelId: 'image_filter_box_blur_v1' }),
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    try {
      await simAdapter.executeTask(task);
      expect.fail('Should have failed in DISCONNECTED mode');
    } catch (e: any) {
      expect(e.message).to.include('DISCONNECTED');
    }
  });

  it('6. Simulated TASK_FAILURE returns empty outputData without throwing unhandled exception', async () => {
    simAdapter.setConfig({ enabled: true, failureMode: 'TASK_FAILURE', simulatedDelayMs: 2 });

    const task: Task = {
      id: 'task-sim-fail-02',
      inputRef: 'inline',
      computationDescriptor: JSON.stringify({ kernelId: 'image_filter_box_blur_v1' }),
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      retryCount: 0,
      attemptHistory: [],
      status: TaskStatus.PENDING,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    const result = await simAdapter.executeTask(task);
    expect(result.outputData).to.equal('');
  });
});
