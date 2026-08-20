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
import { TransportServer } from '../src/transport_server';
import { WorkloadPipeline } from '../src/workload_pipeline';
import { ScoredScheduler } from '../src/scheduler';
import { ToleranceAwareImageValidator } from '../src/result_validator';
import { DistributionDecisionEngine } from '../src/decision_engine';
import { IpcServer } from '../src/ipc_server';
import { Task, TaskStatus, ThermalState, WorkloadDescriptor } from '../src/types';

describe('Hostile Fault Injection & Reliability Hardening Tests (Phase G)', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let workloadPipeline: WorkloadPipeline;
  let scheduler: ScoredScheduler;
  let decisionEngine: DistributionDecisionEngine;
  let ipcServer: IpcServer;

  const testSocketPath = path.join('/tmp', `swarmx-fault-${Date.now()}.sock`);
  const testPort = 59180;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskStore = new TaskStore(db);
    workerManager = new WorkerManager();
    pairingService = new PairingService(db);
    scheduler = new ScoredScheduler();
    workloadPipeline = new WorkloadPipeline(taskStore, scheduler);
    workloadPipeline.registerValidator('image_filter_box_blur_v1', new ToleranceAwareImageValidator(Buffer.alloc(100, 100), 2, 0.5));

    transportServer = new TransportServer(testPort, pairingService, workerManager, taskStore, workloadPipeline);
    await transportServer.start();

    decisionEngine = new DistributionDecisionEngine({
      defaultLanBandwidthBytesPerSec: 50 * 1024 * 1024,
      minGainThreshold: 1.0
    });

    ipcServer = new IpcServer(
      testSocketPath,
      taskStore,
      workerManager,
      pairingService,
      transportServer,
      workloadPipeline,
      scheduler,
      decisionEngine
    );
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

  // Helper connecting a paired simulated worker
  const spawnPairedWorker = async (deviceId: string, hasGpu = true) => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyHex = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const salt = crypto.randomBytes(16);

    // Discovery
    const ackPromise = new Promise<void>((resolve) => {
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
      deviceName: `Worker-${deviceId}`,
      host: '127.0.0.1',
      port: testPort,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId,
        deviceName: `Worker-${deviceId}`,
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu
      }
    }));
    await ackPromise;

    // Pairing
    const initRes = await ipcServer.handleMessage({
      id: 1,
      method: 'initiatePairing',
      params: { workerDeviceId: deviceId }
    });

    const hostPubKeyHex = initRes.result.hostPublicKeyHex;
    const hostPubDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(hostPubKeyHex, 'hex')]);
    const hostKeyObj = crypto.createPublicKey({ key: hostPubDer, format: 'der', type: 'spki' });
    const sharedSecret = crypto.diffieHellman({ privateKey: workerKeypair.privateKey, publicKey: hostKeyObj });
    const sasContext = `swarmx-sas-v1:swarmx-host:${deviceId}:${hostPubKeyHex}:${workerPubkeyHex}`;
    const sasCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);
    const { hostToWorkerKey, workerToHostKey } = PairingService.deriveDirectionalKeys(sharedSecret, salt);

    const pairDone = new Promise<any>((resolve) => {
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
      initiationId: initRes.result.initiationId,
      workerDeviceId: deviceId,
      workerDeviceName: `Worker-${deviceId}`,
      workerPublicKeyHex: workerPubkeyHex,
      workerSaltHex: salt.toString('hex'),
      confirmedSasCode: sasCode,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId,
        deviceName: `Worker-${deviceId}`,
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu
      }
    }));

    const pairRes = await pairDone;

    // Telemetry
    const telePayload = JSON.stringify({
      deviceId,
      timestampMs: Date.now(),
      batteryLevel: 0.90,
      isCharging: true,
      thermalState: ThermalState.NOMINAL,
      cpuUtilization: 0.15,
      availableRamMb: 12000
    });
    const teleIv = Buffer.alloc(12);
    crypto.randomBytes(4).copy(teleIv, 0, 0, 4);
    teleIv.writeBigUInt64BE(BigInt(1), 4);
    const teleCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, teleIv);
    teleCipher.setAAD(Buffer.from(`${pairRes.sessionId}:1`, 'utf-8'));
    const teleCt = Buffer.concat([teleCipher.update(Buffer.from(telePayload, 'utf-8')), teleCipher.final()]);

    ws.send(JSON.stringify({
      type: 'ENCRYPTED_TELEMETRY',
      workerDeviceId: deviceId,
      envelope: {
        sessionId: pairRes.sessionId,
        sequenceNum: 1,
        ivNonce: teleIv.toString('base64'),
        ciphertext: teleCt.toString('base64'),
        authTag: teleCipher.getAuthTag().toString('base64')
      }
    }));

    await new Promise((r) => setTimeout(r, 40));

    return { ws, deviceId, hostToWorkerKey, workerToHostKey, sessionId: pairRes.sessionId };
  };

  it('1. Worker disappears BEFORE task assignment -> scheduler excludes it', async () => {
    const worker1 = await spawnPairedWorker('w1');
    worker1.ws.terminate();
    await new Promise((r) => setTimeout(r, 50));

    // Worker 1 is unregistered / disconnected
    const task = taskStore.createTask({
      id: 'task-fault-1',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: { minCpuCores: 1, minRamMb: 64 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      status: TaskStatus.PENDING
    });

    const scheduleDecision = scheduler.scheduleTask(task, workerManager.listWorkers(), taskStore);
    expect(scheduleDecision.status).to.equal('WAITING_FOR_ELIGIBLE_WORKER');
  });

  it('2. Worker disappears AFTER assignment -> TaskStore reclaims task and increments retry count', async () => {
    const worker1 = await spawnPairedWorker('w1');
    const task = taskStore.createTask({
      id: 'task-fault-2',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: { minCpuCores: 1, minRamMb: 64 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      status: TaskStatus.PENDING
    });

    taskStore.assignTask(task.id, 'w1', 30000);
    worker1.ws.terminate(); // Hard disconnect

    await new Promise((r) => setTimeout(r, 50));

    const reclaimed = taskStore.getTask(task.id)!;
    expect(reclaimed.status).to.equal(TaskStatus.PENDING);
    expect(reclaimed.retryCount).to.equal(1);
    expect(reclaimed.attemptHistory[0].reason).to.equal('WORKER_DISCONNECTED');
  });

  it('3. Duplicate TASK_RESULT -> Second result rejected without double completion', async () => {
    const worker1 = await spawnPairedWorker('w1');
    const task = taskStore.createTask({
      id: 'task-fault-3',
      inputRef: 'ref',
      computationDescriptor: 'test_pass_through',
      requiredResources: { minCpuCores: 1, minRamMb: 64 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      status: TaskStatus.PENDING
    });

    taskStore.assignTask(task.id, 'w1', 30000);

    const validPayload = Buffer.alloc(100, 128).toString('base64');
    const res1 = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'w1',
      outputData: validPayload,
      executionTimeMs: 10,
      attemptNumber: 1,
      itemCount: 1
    });
    expect(res1.success).to.be.true;
    expect(res1.status).to.equal(TaskStatus.COMPLETED);

    // Second duplicate result submission
    try {
      await workloadPipeline.handleTaskResult({
        taskId: task.id,
        workerId: 'w1',
        outputData: validPayload,
        executionTimeMs: 10,
        attemptNumber: 1,
        itemCount: 1
      });
    } catch (err: any) {
      expect(err.message).to.include('Cannot complete task in COMPLETED state');
    }

    worker1.ws.close();
  });

  it('4. Stale TASK_RESULT from previous attempt -> STALE_ATTEMPT_IGNORED', async () => {
    const worker1 = await spawnPairedWorker('w1');
    const task = taskStore.createTask({
      id: 'task-fault-4',
      inputRef: 'ref',
      computationDescriptor: 'test_pass_through',
      requiredResources: { minCpuCores: 1, minRamMb: 64 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      status: TaskStatus.PENDING
    });

    // Record failure so attempt count becomes 2
    taskStore.recordTaskFailure(task.id, 'w1', 'TEST_FAIL', {});
    const updatedTask = taskStore.getTask(task.id)!;
    expect(updatedTask.retryCount).to.equal(1);

    taskStore.assignTask(task.id, 'w1', 30000);

    // Stale result from attempt 1 arrives
    const res = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'w1',
      outputData: 'data',
      executionTimeMs: 10,
      attemptNumber: 1, // Stale! Current attempt is 2
      itemCount: 1
    });

    expect(res.success).to.be.false;
    expect(res.error).to.include('STALE_ATTEMPT_IGNORED');

    worker1.ws.close();
  });

  it('5. Replayed encrypted envelope / sequence number -> Rejected by pairing service', async () => {
    const worker1 = await spawnPairedWorker('w1');

    const iv = Buffer.alloc(12);
    crypto.randomBytes(4).copy(iv, 0, 0, 4);
    iv.writeBigUInt64BE(BigInt(10), 4);
    const cipher = crypto.createCipheriv('aes-256-gcm', worker1.workerToHostKey, iv);
    cipher.setAAD(Buffer.from(`${worker1.sessionId}:10`, 'utf-8'));
    const ct = Buffer.concat([cipher.update(Buffer.from('test_worker_payload', 'utf-8')), cipher.final()]);

    const envelope = {
      sessionId: worker1.sessionId,
      sequenceNum: 10,
      ivNonce: iv.toString('base64'),
      ciphertext: ct.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64')
    };

    // First decrypt succeeds
    const dec1 = pairingService.decryptEnvelope(envelope);
    expect(dec1.toString('utf-8')).to.equal('test_worker_payload');

    // Replaying identical sequence number must throw
    expect(() => {
      pairingService.decryptEnvelope(envelope);
    }).to.throw(/Replay attack detected/);

    worker1.ws.close();
  });

  it('6. Corrupted ciphertext / auth tag -> Rejects gracefully without crashing', async () => {
    const worker1 = await spawnPairedWorker('w1');

    const iv = Buffer.alloc(12);
    crypto.randomBytes(4).copy(iv, 0, 0, 4);
    iv.writeBigUInt64BE(BigInt(11), 4);
    const cipher = crypto.createCipheriv('aes-256-gcm', worker1.workerToHostKey, iv);
    cipher.setAAD(Buffer.from(`${worker1.sessionId}:11`, 'utf-8'));
    const ct = Buffer.concat([cipher.update(Buffer.from('test_worker_payload', 'utf-8')), cipher.final()]);

    const corruptedEnvelope = {
      sessionId: worker1.sessionId,
      sequenceNum: 11,
      ivNonce: iv.toString('base64'),
      ciphertext: Buffer.from('corrupted_garbage_bytes').toString('base64'),
      authTag: cipher.getAuthTag().toString('base64')
    };

    expect(() => {
      pairingService.decryptEnvelope(corruptedEnvelope);
    }).to.throw();

    worker1.ws.close();
  });

  it('7. Corrupted image output -> ToleranceAwareImageValidator rejects task completion', async () => {
    const worker1 = await spawnPairedWorker('w1');
    const task = taskStore.createTask({
      id: 'task-fault-7',
      inputRef: Buffer.alloc(100, 100).toString('base64'), // Reference ground truth: 100
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: { minCpuCores: 1, minRamMb: 64 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      status: TaskStatus.PENDING
    });

    taskStore.assignTask(task.id, 'w1', 30000);

    // Intentionally corrupted pixel buffer with massive delta (250 instead of 100)
    const corruptedOutput = Buffer.alloc(100, 250).toString('base64');
    const res = await workloadPipeline.handleTaskResult({
      taskId: task.id,
      workerId: 'w1',
      outputData: corruptedOutput,
      executionTimeMs: 10,
      attemptNumber: 1,
      itemCount: 1
    });

    expect(res.success).to.be.false;
    expect(res.error).to.include('tolerance exceeded');

    // Worker 1 is penalized and excluded
    const excludedWorkers = taskStore.getExcludedWorkerIds(task.id);
    expect(excludedWorkers).to.include('w1');

    worker1.ws.close();
  });

  it('8. Task Lease Expiration -> Task is reclaimed to PENDING', async () => {
    const task = taskStore.createTask({
      id: 'task-fault-8',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: { minCpuCores: 1, minRamMb: 64 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      status: TaskStatus.PENDING
    });

    // Assign with expired lease (in the past)
    taskStore.assignTask(task.id, 'w-expired', 1);
    await new Promise((r) => setTimeout(r, 10));

    const recovery = taskStore.recoverExpiredLeases(Date.now(), 3);
    expect(recovery.recovered.length).to.equal(1);

    const reclaimed = taskStore.getTask(task.id)!;
    expect(reclaimed.status).to.equal(TaskStatus.PENDING);
    expect(reclaimed.retryCount).to.equal(1);
    expect(reclaimed.attemptHistory[0].reason).to.equal('LEASE_EXPIRED');
  });

  it('9. Host crash / restart -> Recovers in-flight tasks without corruption', () => {
    const task = taskStore.createTask({
      id: 'task-fault-9',
      inputRef: 'ref',
      computationDescriptor: 'image_filter_box_blur_v1',
      requiredResources: { minCpuCores: 1, minRamMb: 64 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      status: TaskStatus.PENDING
    });

    taskStore.assignTask(task.id, 'w-crash', 30000);

    // Simulate daemon restart: recoverInFlightTasks
    const recovery = taskStore.recoverInFlightTasks(3);
    expect(recovery.recovered.map(t => t.id)).to.include(task.id);

    const postRecoveryTask = taskStore.getTask(task.id)!;
    expect(postRecoveryTask.status).to.equal(TaskStatus.PENDING);
    expect(postRecoveryTask.retryCount).to.equal(1);
    expect(postRecoveryTask.attemptHistory[0].reason).to.equal('HOST_CRASH_RECOVERY');
  });

  it('10. Multiple concurrent workloads -> Complete independently with zero cross-contamination', async () => {
    const w1 = await spawnPairedWorker('w1');
    const w2 = await spawnPairedWorker('w2');

    const task1 = taskStore.createTask({
      id: 'task-iso-1',
      inputRef: 'ref1',
      computationDescriptor: 'test_pass_through_1',
      requiredResources: { minCpuCores: 1, minRamMb: 64 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      status: TaskStatus.PENDING
    });

    const task2 = taskStore.createTask({
      id: 'task-iso-2',
      inputRef: 'ref2',
      computationDescriptor: 'test_pass_through_2',
      requiredResources: { minCpuCores: 1, minRamMb: 64 },
      dependencies: [],
      executionConstraints: {},
      resultDestination: 'memory',
      status: TaskStatus.PENDING
    });

    taskStore.assignTask(task1.id, 'w1', 30000);
    taskStore.assignTask(task2.id, 'w2', 30000);

    const out1 = Buffer.from('OUTPUT_FOR_TASK_1').toString('base64');
    const out2 = Buffer.from('OUTPUT_FOR_TASK_2').toString('base64');

    const [res1, res2] = await Promise.all([
      workloadPipeline.handleTaskResult({
        taskId: task1.id,
        workerId: 'w1',
        outputData: out1,
        executionTimeMs: 15,
        attemptNumber: 1,
        itemCount: 1
      }),
      workloadPipeline.handleTaskResult({
        taskId: task2.id,
        workerId: 'w2',
        outputData: out2,
        executionTimeMs: 20,
        attemptNumber: 1,
        itemCount: 1
      })
    ]);

    expect(res1.success).to.be.true;
    expect(res2.success).to.be.true;
    expect(taskStore.getTask(task1.id)!.resultDestination).to.equal(out1);
    expect(taskStore.getTask(task2.id)!.resultDestination).to.equal(out2);

    w1.ws.close();
    w2.ws.close();
  });
});
