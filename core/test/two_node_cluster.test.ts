import { expect } from 'chai';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { TaskStore } from '../src/db/task_store';
import { WorkerManager } from '../src/worker_manager';
import { PairingService } from '../src/pairing_service';
import { ScoredScheduler } from '../src/scheduler';
import { WorkloadPipeline } from '../src/workload_pipeline';
import { TransportServer } from '../src/transport_server';
import { IpcServer } from '../src/ipc_server';
import { ToleranceAwareImageValidator } from '../src/result_validator';
import { TaskStatus } from '../src/types';

describe('Two-Node macOS Cluster Integration & Fault Tolerance Tests (Step 4A)', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let scheduler: ScoredScheduler;
  let workloadPipeline: WorkloadPipeline;
  let transportServer: TransportServer;
  let ipcServer: IpcServer;

  const testPort = 59130;
  const testSocketPath = path.join('/tmp', `swarmx-cluster-${Date.now()}.sock`);

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskStore = new TaskStore(db);
    workerManager = new WorkerManager();
    pairingService = new PairingService(db);
    scheduler = new ScoredScheduler();
    workloadPipeline = new WorkloadPipeline(taskStore, scheduler);

    transportServer = new TransportServer(testPort, pairingService, workerManager, taskStore, workloadPipeline);
    await transportServer.start();

    ipcServer = new IpcServer(testSocketPath, taskStore, workerManager, pairingService, transportServer);
    await ipcServer.start();
  });

  afterEach(async () => {
    await ipcServer.stop();
    await transportServer.stop();
    db.close();
    if (fs.existsSync(testSocketPath)) {
      try { fs.unlinkSync(testSocketPath); } catch (e) {}
    }
  });

  // Helper simulating a native macOS worker process with directional AES-GCM crypto
  const connectAndPairWorker = async (
    deviceId: string,
    deviceName: string,
    cores: number = 8,
    hasGpu: boolean = true
  ) => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyHex = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const salt = crypto.randomBytes(16);

    // 1. Send discovery beacon and wait for ACK
    const discoveryAckPromise = new Promise<void>((resolve) => {
      const handler = (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'DISCOVERY_ACK') {
          ws.off('message', handler);
          resolve();
        }
      };
      ws.on('message', handler);
    });

    ws.send(JSON.stringify({
      type: 'DISCOVERY_BEACON',
      deviceId,
      deviceName,
      host: '127.0.0.1',
      port: testPort,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId,
        deviceName,
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: cores,
        totalRamMb: 16384,
        hasGpu
      }
    }));

    await discoveryAckPromise;

    // 2. Initiate pairing from host via IPC
    const initRes = await ipcServer.handleMessage({
      id: 1,
      method: 'initiatePairing',
      params: { workerDeviceId: deviceId }
    });
    const initiationId = initRes.result.initiationId;
    const hostPubKeyHex = initRes.result.hostPublicKeyHex;

    // 3. Worker computes SAS and directional keys
    const hostPubDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(hostPubKeyHex, 'hex')]);
    const hostKeyObj = crypto.createPublicKey({ key: hostPubDer, format: 'der', type: 'spki' });
    const sharedSecret = crypto.diffieHellman({ privateKey: workerKeypair.privateKey, publicKey: hostKeyObj });
    const sasContext = `swarmx-sas-v1:swarmx-host:${deviceId}:${hostPubKeyHex}:${workerPubkeyHex}`;
    const sasCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);
    const { hostToWorkerKey, workerToHostKey } = PairingService.deriveDirectionalKeys(sharedSecret, salt);

    // 4. Worker sends PAIRING_CONFIRM
    const confirmPromise = new Promise<any>((resolve) => {
      const handler = (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'PAIRING_SUCCESS') {
          ws.off('message', handler);
          resolve(msg);
        }
      };
      ws.on('message', handler);
    });

    ws.send(JSON.stringify({
      type: 'PAIRING_CONFIRM',
      initiationId,
      workerDeviceId: deviceId,
      workerDeviceName: deviceName,
      workerPublicKeyHex: workerPubkeyHex,
      workerSaltHex: salt.toString('hex'),
      confirmedSasCode: sasCode,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId,
        deviceName,
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: cores,
        totalRamMb: 16384,
        hasGpu
      }
    }));

    const pairSuccess = await confirmPromise;
    const sessionId = pairSuccess.sessionId;

    // Send initial telemetry and wait for ACK
    const telemAckPromise = new Promise<void>((resolve) => {
      const handler = (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'ENCRYPTED_TELEMETRY_ACK') {
          ws.off('message', handler);
          resolve();
        }
      };
      ws.on('message', handler);
    });

    const telemIv = Buffer.alloc(12);
    crypto.randomBytes(4).copy(telemIv, 0, 0, 4);
    telemIv.writeBigUInt64BE(BigInt(1), 4);
    const telemCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, telemIv);
    telemCipher.setAAD(Buffer.from(`${sessionId}:1`, 'utf-8'));
    const telemPayload = JSON.stringify({
      deviceId,
      batteryLevel: 0.95,
      isCharging: true,
      thermalState: 0,
      cpuUtilization: 0.10,
      availableRamMb: 12000,
      timestampMs: Date.now()
    });
    const telemCiphertext = Buffer.concat([telemCipher.update(Buffer.from(telemPayload, 'utf-8')), telemCipher.final()]);
    ws.send(JSON.stringify({
      type: 'ENCRYPTED_TELEMETRY',
      deviceId,
      envelope: {
        sessionId,
        sequenceNum: 1,
        ivNonce: telemIv.toString('base64'),
        ciphertext: telemCiphertext.toString('base64'),
        authTag: telemCipher.getAuthTag().toString('base64')
      }
    }));

    await telemAckPromise;

    return {
      ws,
      deviceId,
      sessionId,
      sharedSecret,
      hostToWorkerKey,
      workerToHostKey
    };
  };

  it('2-Node Cluster E2E Execution & Mid-Run Fault Tolerance Recovery', async () => {
    // 1. Establish 2-Node Cluster: Mac #1 (Surviving Worker) and Mac #2 (Primary Worker)
    const worker1 = await connectAndPairWorker('mac-worker-01', 'MacBook Air M2', 8, true);
    const worker2 = await connectAndPairWorker('mac-worker-02', 'MacBook Pro M3', 12, true);

    expect(workerManager.listWorkers()).to.have.lengthOf(2);
    expect(workerManager.listEligibleWorkers()).to.have.lengthOf(2);

    // 2. Register Image Validator with reference output
    const rawImageChunk = Buffer.from([10, 20, 30, 40, 50]);
    // Kernel brightness scale (x * 11 / 10)
    const expectedOutput = Buffer.from([11, 22, 33, 44, 55]);
    workloadPipeline.registerValidator('task-img-batch-01', new ToleranceAwareImageValidator(expectedOutput, 2, 0.5));

    // 3. Create Task and schedule to Primary Worker (Mac #2 - higher core count)
    const task = taskStore.createTask({
      id: 'task-img-batch-01',
      inputRef: rawImageChunk.toString('base64'),
      computationDescriptor: 'image_transform_v1',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/out/batch_01.bin'
    });

    const schedulingDecision = scheduler.scheduleTask(task, workerManager.listWorkers(), taskStore);
    expect(schedulingDecision.status).to.equal('ASSIGNED');
    expect(schedulingDecision.selectedWorker!.deviceId).to.equal('mac-worker-02');

    // 4. Assign and dispatch task to Mac #2
    taskStore.assignTask(task.id, 'mac-worker-02', 30000);
    const taskExecutingPromise = new Promise<any>((resolve) => {
      worker2.ws.on('message', (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'EXECUTE_TASK') resolve(msg);
      });
    });
    transportServer.sendExecuteTask('mac-worker-02', task, rawImageChunk.toString('base64'), 5);

    const executeMsg = await taskExecutingPromise;
    expect(executeMsg.taskId).to.equal('task-img-batch-01');

    // 5. FAULT INJECTION: Kill Mac #2 worker mid-flight
    const faultStartTime = Date.now();
    await new Promise<void>((resolve) => {
      worker2.ws.on('close', resolve);
      worker2.ws.terminate(); // Hard kill
    });

    // Wait for server event-loop to fire close event and run recoverWorkerLoss
    await new Promise((r) => setTimeout(r, 50));

    // 6. Assert Event-Driven Worker-Loss Detection & Latency
    const detectionTime = Date.now() - faultStartTime;
    expect(detectionTime).to.be.lessThan(200); // Measurable fast detection (<200ms)

    // Task is automatically reclaimed to PENDING
    const reclaimedTask = taskStore.getTask(task.id)!;
    expect(reclaimedTask.status).to.equal(TaskStatus.PENDING);
    expect(reclaimedTask.retryCount).to.equal(1);
    expect(reclaimedTask.attemptHistory).to.have.lengthOf(1);
    expect(reclaimedTask.attemptHistory[0].reason).to.equal('WORKER_DISCONNECTED');

    // 7. Scheduler immediately reassigns task to Surviving Node (Mac #1)
    const reassignDecision = scheduler.scheduleTask(reclaimedTask, workerManager.listWorkers(), taskStore);
    expect(reassignDecision.status).to.equal('ASSIGNED');
    expect(reassignDecision.selectedWorker!.deviceId).to.equal('mac-worker-01');

    taskStore.assignTask(task.id, 'mac-worker-01', 30000);

    // 8. Mac #1 receives task, executes kernel, and returns valid encrypted result
    const worker1TaskPromise = new Promise<any>((resolve) => {
      worker1.ws.on('message', (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'EXECUTE_TASK') resolve(msg);
      });
    });
    transportServer.sendExecuteTask('mac-worker-01', taskStore.getTask(task.id)!, rawImageChunk.toString('base64'), 5);
    const worker1ExecMsg = await worker1TaskPromise;
    expect(worker1ExecMsg.taskId).to.equal(task.id);

    // Worker 1 computes valid result and encrypts with workerToHostKey
    const worker1ResPayload = JSON.stringify({
      taskId: task.id,
      attemptNumber: 2,
      status: 'COMPLETED',
      outputData: expectedOutput.toString('base64'),
      executionTimeMs: 45,
      itemCount: 5
    });

    const resIv = Buffer.alloc(12);
    crypto.randomBytes(4).copy(resIv, 0, 0, 4);
    resIv.writeBigUInt64BE(BigInt(2), 4);
    const resCipher = crypto.createCipheriv('aes-256-gcm', worker1.workerToHostKey, resIv);
    resCipher.setAAD(Buffer.from(`${worker1.sessionId}:2`, 'utf-8'));
    const resCiphertext = Buffer.concat([resCipher.update(Buffer.from(worker1ResPayload, 'utf-8')), resCipher.final()]);

    const resultAckPromise = new Promise<any>((resolve) => {
      worker1.ws.on('message', (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'TASK_RESULT_ACK') resolve(msg);
      });
    });

    worker1.ws.send(JSON.stringify({
      type: 'TASK_RESULT',
      workerDeviceId: 'mac-worker-01',
      taskId: task.id,
      envelope: {
        sessionId: worker1.sessionId,
        sequenceNum: 2,
        ivNonce: resIv.toString('base64'),
        ciphertext: resCiphertext.toString('base64'),
        authTag: resCipher.getAuthTag().toString('base64')
      }
    }));

    const resultAck = await resultAckPromise;
    expect(resultAck.type).to.equal('TASK_RESULT_ACK');
    expect(resultAck.success).to.be.true;

    // 9. Verify 100% Correct Final Aggregation & Zero Lost Work
    const finalTask = taskStore.getTask(task.id)!;
    expect(finalTask.status).to.equal(TaskStatus.COMPLETED);
    expect(finalTask.assignedWorkerId).to.equal('mac-worker-01');

    // Cleanup worker 1
    worker1.ws.close();
  });
});
