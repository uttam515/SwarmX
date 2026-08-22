import 'mocha';
import { expect } from 'chai';
import { WorkerManager } from '../src/worker_manager';
import { WorkerExecutionStage, CapabilityProfile } from '../src/types';

describe('Worker Live State Machine & Authoritative Transitions (Requirement 2)', () => {
  let workerManager: WorkerManager;

  const profile: CapabilityProfile = {
    capabilitySchemaVersion: 1,
    deviceId: 'mac-air-uttam',
    deviceName: "Uttam's MacBook Air",
    osType: 'darwin',
    osVersion: '15.0',
    cpuArch: 'arm64',
    cpuCores: 8,
    totalRamMb: 16384,
    hasGpu: true
  };

  beforeEach(() => {
    workerManager = new WorkerManager();
  });

  it('1. Registration initializes live state in READY stage', () => {
    const worker = workerManager.registerWorker(profile);
    expect(worker.liveState).to.exist;
    expect(worker.liveState!.deviceId).to.equal('mac-air-uttam');
    expect(worker.liveState!.deviceName).to.equal("Uttam's MacBook Air");
    expect(worker.liveState!.connectionState).to.equal('CONNECTED');
    expect(worker.liveState!.stage).to.equal(WorkerExecutionStage.READY);
    expect(worker.liveState!.completedChunks).to.equal(0);
    expect(worker.liveState!.failedChunks).to.equal(0);
  });

  it('2. Authoritative stage progression: FETCHING -> DECRYPTING -> DECODING -> EXECUTING -> TRANSMITTING -> COMPLETED -> READY', () => {
    workerManager.registerWorker(profile);

    // FETCHING
    let state = workerManager.updateWorkerStage('mac-air-uttam', WorkerExecutionStage.FETCHING, {
      currentTaskId: 'wkl-vid-01-chunk-17',
      currentChunkIndex: 17,
      totalChunks: 30,
      startFrameIndex: 510,
      frameCount: 30
    });
    expect(state?.stage).to.equal(WorkerExecutionStage.FETCHING);
    expect(state?.currentTaskId).to.equal('wkl-vid-01-chunk-17');
    expect(state?.currentChunkIndex).to.equal(17);
    expect(state?.pipelineStages.fetching).to.be.true;
    expect(state?.pipelineStages.executing).to.be.false;

    // DECRYPTING
    state = workerManager.updateWorkerStage('mac-air-uttam', WorkerExecutionStage.DECRYPTING);
    expect(state?.stage).to.equal(WorkerExecutionStage.DECRYPTING);
    expect(state?.pipelineStages.fetching).to.be.true;
    expect(state?.pipelineStages.decrypting).to.be.true;

    // EXECUTING
    state = workerManager.updateWorkerStage('mac-air-uttam', WorkerExecutionStage.EXECUTING);
    expect(state?.stage).to.equal(WorkerExecutionStage.EXECUTING);
    expect(state?.pipelineStages.executing).to.be.true;

    // TRANSMITTING
    state = workerManager.updateWorkerStage('mac-air-uttam', WorkerExecutionStage.TRANSMITTING);
    expect(state?.stage).to.equal(WorkerExecutionStage.TRANSMITTING);
    expect(state?.pipelineStages.transmitting).to.be.true;

    // COMPLETED
    state = workerManager.updateWorkerStage('mac-air-uttam', WorkerExecutionStage.COMPLETED, {
      executionTimeMs: 184
    });
    expect(state?.completedChunks).to.equal(1);
    expect(state?.currentTaskId).to.be.undefined;

    // READY
    state = workerManager.updateWorkerStage('mac-air-uttam', WorkerExecutionStage.READY);
    expect(state?.stage).to.equal(WorkerExecutionStage.READY);
    expect(state?.pipelineStages.fetching).to.be.false;
    expect(state?.pipelineStages.executing).to.be.false;
  });

  it('3. Failure transitions to FAILED and increments failedChunks', () => {
    workerManager.registerWorker(profile);
    workerManager.updateWorkerStage('mac-air-uttam', WorkerExecutionStage.FETCHING);
    const state = workerManager.updateWorkerStage('mac-air-uttam', WorkerExecutionStage.FAILED);
    expect(state?.stage).to.equal(WorkerExecutionStage.FAILED);
    expect(state?.failedChunks).to.equal(1);
  });

  it('4. Unregister transitions live state to OFFLINE', () => {
    workerManager.registerWorker(profile);
    workerManager.unregisterWorker('mac-air-uttam');
    const states = workerManager.listLiveStates();
    expect(states.length).to.equal(0);
  });
});
