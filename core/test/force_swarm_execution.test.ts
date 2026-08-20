import 'mocha';
import { expect } from 'chai';
import * as fs from 'fs';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { TaskStore } from '../src/db/task_store';
import { WorkerManager } from '../src/worker_manager';
import { PairingService } from '../src/pairing_service';
import { TransportServer } from '../src/transport_server';
import { IpcServer } from '../src/ipc_server';
import { ScoredScheduler } from '../src/scheduler';
import { WorkloadPipeline } from '../src/workload_pipeline';
import { Logger } from '../src/logger';
import { WorkloadDescriptor } from '../src/types';

describe('Demo Forced Swarm Execution Path Tests', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let ipcServer: IpcServer;
  let scheduler: ScoredScheduler;
  let workloadPipeline: WorkloadPipeline;
  let testPort: number;
  let testSocketPath: string;
  let testDbPath: string;
  let testLogPath: string;

  const testWorkload: WorkloadDescriptor = {
    workloadId: 'wkl-test-forced',
    version: '1.0.0',
    computation: {
      domain: 'IMAGE_PROCESSING',
      kernelId: 'image_filter_box_blur_v1',
      parameters: { radius: 2, width: 128, height: 128, mode: 'RGBA' }
    },
    data: {
      itemCount: 1,
      totalPayloadBytes: 65536,
      format: 'RAW_PLANAR_RGBA_UINT8'
    },
    constraints: {
      isPure: true,
      isIdempotent: true,
      toleranceValidator: 'IMAGE_PIXEL_DELTA',
      maxDelta: 2,
      maxMse: 0.5
    }
  };

  beforeEach(async () => {
    const id = crypto.randomUUID().substring(0, 8);
    testDbPath = `/tmp/swarmx_force_test_${id}.db`;
    testSocketPath = `/tmp/swarmx_force_test_${id}.sock`;
    testLogPath = `/tmp/swarmx_force_test_${id}.log`;
    testPort = 55000 + Math.floor(Math.random() * 1000);

    Logger.init(testLogPath);

    db = createDatabase(testDbPath);
    runMigrations(db);
    taskStore = new TaskStore(db);
    workerManager = new WorkerManager();
    pairingService = new PairingService(db);
    scheduler = new ScoredScheduler();
    workloadPipeline = new WorkloadPipeline(taskStore, scheduler);

    transportServer = new TransportServer(
      testPort,
      pairingService,
      workerManager,
      taskStore,
      workloadPipeline
    );
    await transportServer.start();

    ipcServer = new IpcServer(
      testSocketPath,
      taskStore,
      workerManager,
      pairingService,
      transportServer,
      workloadPipeline,
      scheduler
    );
    await ipcServer.start();
  });

  afterEach(async () => {
    await ipcServer.stop();
    await transportServer.stop();
    Logger.close();
    db.close();

    for (const file of [testDbPath, testSocketPath, testLogPath]) {
      if (fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch (e) {}
      }
    }
  });

  it('1. executeWorkload with forceSwarm: false falls back locally if cost model recommends LOCAL', async () => {
    // Register a worker but workload is below threshold for 1 item (65KB)
    workerManager.registerWorker({
      deviceId: 'mac-worker-01',
      deviceName: 'Remote Mac',
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 8,
      totalRamMb: 16384,
      hasGpu: true,
      gpuModel: 'Apple M2',
      capabilitySchemaVersion: 1
    });

    const response = await (ipcServer as any).handleMessage({
      id: 1,
      method: 'executeWorkload',
      params: { workload: testWorkload, forceSwarm: false }
    });

    expect(response.result).to.exist;
    expect(response.result.status).to.equal('LOCAL_FALLBACK');
  });

  it('2. executeWorkload with forceSwarm: true fails explicitly when no eligible worker exists', async () => {
    // 0 workers registered
    const response = await (ipcServer as any).handleMessage({
      id: 2,
      method: 'executeWorkload',
      params: { workload: testWorkload, forceSwarm: true }
    });

    expect(response.result).to.exist;
    expect(response.result.status).to.equal('FAILED');
    expect(response.result.reason).to.include('No eligible remote worker');
  });

  it('3. evaluateWorkload cost recommendation remains unchanged when force mode is used elsewhere', async () => {
    workerManager.registerWorker({
      deviceId: 'mac-worker-01',
      deviceName: 'Remote Mac',
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 8,
      totalRamMb: 16384,
      hasGpu: true,
      gpuModel: 'Apple M2',
      capabilitySchemaVersion: 1
    });

    const evalResponse = await (ipcServer as any).handleMessage({
      id: 3,
      method: 'evaluateWorkload',
      params: { workload: testWorkload }
    });

    expect(evalResponse.result).to.exist;
    expect(evalResponse.result.decision).to.equal('LOCAL');
    expect(evalResponse.result.reason).to.include('below threshold');
  });

  it('4. executeWorkload with forceSwarm: true dispatches to physical remote worker and returns COMPLETED', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyHex = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const salt = crypto.randomBytes(16);
    const deviceId = 'mac-worker-physical-02';

    // 1. Discovery beacon
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
      deviceName: "Jatin's MacBook Air",
      host: '127.0.0.1',
      port: testPort,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId,
        deviceName: "Jatin's MacBook Air",
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 10,
        totalRamMb: 16384,
        hasGpu: true,
        gpuModel: 'Apple Silicon GPU'
      }
    }));
    await discoveryAckPromise;

    // 2. Host initiates pairing
    const initRes = await (ipcServer as any).handleMessage({
      id: 10,
      method: 'initiatePairing',
      params: { workerDeviceId: deviceId }
    });
    const initiationId = initRes.result.initiationId;
    const hostPubKeyHex = initRes.result.hostPublicKeyHex;

    // 3. Worker confirms pairing
    const hostPubDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(hostPubKeyHex, 'hex')]);
    const hostKeyObj = crypto.createPublicKey({ key: hostPubDer, format: 'der', type: 'spki' });
    const sharedSecret = crypto.diffieHellman({ privateKey: workerKeypair.privateKey, publicKey: hostKeyObj });
    const sasContext = `swarmx-sas-v1:swarmx-host:${deviceId}:${hostPubKeyHex}:${workerPubkeyHex}`;
    const sasCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);
    const { hostToWorkerKey, workerToHostKey } = PairingService.deriveDirectionalKeys(sharedSecret, salt);

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
      workerDeviceName: "Jatin's MacBook Air",
      workerPublicKeyHex: workerPubkeyHex,
      workerSaltHex: salt.toString('hex'),
      confirmedSasCode: sasCode,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId,
        deviceName: "Jatin's MacBook Air",
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 10,
        totalRamMb: 16384,
        hasGpu: true,
        gpuModel: 'Apple Silicon GPU'
      }
    }));

    const pairSuccess = await confirmPromise;
    const sessionId = pairSuccess.sessionId;

    // Send telemetry to become READY
    const telemIv = Buffer.alloc(12);
    crypto.randomBytes(4).copy(telemIv, 0, 0, 4);
    telemIv.writeBigUInt64BE(BigInt(1), 4);
    const telemCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, telemIv);
    telemCipher.setAAD(Buffer.from(`${sessionId}:1`, 'utf-8'));
    const telemPayload = JSON.stringify({
      deviceId,
      batteryLevel: 0.98,
      isCharging: true,
      thermalState: 0,
      cpuUtilization: 0.05,
      availableRamMb: 14000
    });
    const telemCt = Buffer.concat([telemCipher.update(Buffer.from(telemPayload, 'utf-8')), telemCipher.final()]);

    ws.send(JSON.stringify({
      type: 'ENCRYPTED_TELEMETRY',
      workerDeviceId: deviceId,
      envelope: {
        sessionId,
        sequenceNum: 1,
        ivNonce: telemIv.toString('base64'),
        ciphertext: telemCt.toString('base64'),
        authTag: telemCipher.getAuthTag().toString('base64')
      }
    }));
    await new Promise((r) => setTimeout(r, 50));

    // Listen for EXECUTE_TASK on worker side and reply with processed BoxBlur output
    let receivedTask: any = null;
    ws.on('message', (data: any) => {
      const msg = JSON.parse(data.toString('utf-8'));
      if (msg.type === 'EXECUTE_TASK') {
        receivedTask = msg;
        const env = msg.envelope;
        const nonce = Buffer.from(env.ivNonce, 'base64');
        const ciphertext = Buffer.from(env.ciphertext, 'base64');
        const authTag = Buffer.from(env.authTag, 'base64');
        const aad = Buffer.from(`${env.sessionId}:${env.sequenceNum}`, 'utf-8');

        const decipher = crypto.createDecipheriv('aes-256-gcm', hostToWorkerKey, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);
        const decryptedTask = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8'));

        // Box blur on uniform buffer yields exact same bytes
        const inBytes = Buffer.from(decryptedTask.inputData, 'base64');
        const outBase64 = inBytes.toString('base64');

        const resPayload = JSON.stringify({
          taskId: decryptedTask.taskId,
          attemptNumber: 1,
          status: 'COMPLETED',
          outputData: outBase64,
          executionTimeMs: 12,
          itemCount: 1
        });

        const resIv = Buffer.alloc(12);
        crypto.randomBytes(4).copy(resIv, 0, 0, 4);
        resIv.writeBigUInt64BE(BigInt(2), 4);
        const resCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, resIv);
        resCipher.setAAD(Buffer.from(`${sessionId}:2`, 'utf-8'));
        const resCt = Buffer.concat([resCipher.update(Buffer.from(resPayload, 'utf-8')), resCipher.final()]);

        ws.send(JSON.stringify({
          type: 'TASK_RESULT',
          workerDeviceId: deviceId,
          taskId: decryptedTask.taskId,
          envelope: {
            sessionId,
            sequenceNum: 2,
            ivNonce: resIv.toString('base64'),
            ciphertext: resCt.toString('base64'),
            authTag: resCipher.getAuthTag().toString('base64')
          }
        }));
      }
    });

    const workloadWithData: WorkloadDescriptor = {
      ...testWorkload,
      data: {
        ...testWorkload.data,
        payloadBase64: Buffer.alloc(65536, 140).toString('base64')
      }
    };

    const response = await (ipcServer as any).handleMessage({
      id: 4,
      method: 'executeWorkload',
      params: { workload: workloadWithData, forceSwarm: true }
    });

    expect(response.result).to.exist;
    expect(response.result.status).to.equal('COMPLETED');
    expect(response.result.workerId).to.equal(deviceId);
    expect(receivedTask).to.exist;

    ws.close();
  });

  it('5. executeWorkload with forceSwarm: true returns FAILED when worker transport fails to dispatch', async () => {
    // Register worker with eligible telemetry but without active websocket
    workerManager.registerWorker({
      deviceId: 'mac-worker-dead',
      deviceName: 'Offline Worker',
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 8,
      totalRamMb: 16384,
      hasGpu: true,
      capabilitySchemaVersion: 1
    });

    workerManager.updateTelemetry({
      deviceId: 'mac-worker-dead',
      timestampMs: Date.now(),
      batteryLevel: 0.95,
      isCharging: true,
      thermalState: 0,
      cpuUtilization: 0.10,
      availableRamMb: 12000
    });

    const response = await (ipcServer as any).handleMessage({
      id: 5,
      method: 'executeWorkload',
      params: { workload: testWorkload, forceSwarm: true }
    });

    expect(response.result).to.exist;
    expect(response.result.status).to.equal('FAILED');
    expect(response.result.reason).to.include('Failed to dispatch to worker transport');
  });

  it('6. Validation occurs on remote results and rejects corrupted output', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyHex = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const salt = crypto.randomBytes(16);
    const deviceId = 'mac-worker-corrupt-01';

    // 1. Discovery beacon
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
      deviceName: 'Corrupt Worker',
      host: '127.0.0.1',
      port: testPort,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId,
        deviceName: 'Corrupt Worker',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu: true,
        gpuModel: 'Apple M2'
      }
    }));
    await discoveryAckPromise;

    // 2. Initiate pairing
    const initRes = await (ipcServer as any).handleMessage({
      id: 20,
      method: 'initiatePairing',
      params: { workerDeviceId: deviceId }
    });
    const initiationId = initRes.result.initiationId;
    const hostPubKeyHex = initRes.result.hostPublicKeyHex;

    const hostPubDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(hostPubKeyHex, 'hex')]);
    const hostKeyObj = crypto.createPublicKey({ key: hostPubDer, format: 'der', type: 'spki' });
    const sharedSecret = crypto.diffieHellman({ privateKey: workerKeypair.privateKey, publicKey: hostKeyObj });
    const sasContext = `swarmx-sas-v1:swarmx-host:${deviceId}:${hostPubKeyHex}:${workerPubkeyHex}`;
    const sasCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);
    const { hostToWorkerKey, workerToHostKey } = PairingService.deriveDirectionalKeys(sharedSecret, salt);

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
      workerDeviceName: 'Corrupt Worker',
      workerPublicKeyHex: workerPubkeyHex,
      workerSaltHex: salt.toString('hex'),
      confirmedSasCode: sasCode,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId,
        deviceName: 'Corrupt Worker',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu: true,
        gpuModel: 'Apple M2'
      }
    }));

    const pairSuccess = await confirmPromise;
    const sessionId = pairSuccess.sessionId;

    // Send telemetry to become READY
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
      cpuUtilization: 0.05,
      availableRamMb: 12000
    });
    const telemCt = Buffer.concat([telemCipher.update(Buffer.from(telemPayload, 'utf-8')), telemCipher.final()]);

    ws.send(JSON.stringify({
      type: 'ENCRYPTED_TELEMETRY',
      workerDeviceId: deviceId,
      envelope: {
        sessionId,
        sequenceNum: 1,
        ivNonce: telemIv.toString('base64'),
        ciphertext: telemCt.toString('base64'),
        authTag: telemCipher.getAuthTag().toString('base64')
      }
    }));
    await new Promise((r) => setTimeout(r, 50));

    // Register a strict tolerance validator that will reject corrupted bytes
    const expectedOutput = Buffer.alloc(65536, 140);
    const { ToleranceAwareImageValidator } = await import('../src/result_validator');
    workloadPipeline.registerValidator('wkl-corrupt-test', new ToleranceAwareImageValidator(expectedOutput, 2, 0.5));

    // Worker returns corrupted pixel buffer (all 0s instead of 140)
    ws.on('message', (data: any) => {
      const msg = JSON.parse(data.toString('utf-8'));
      if (msg.type === 'EXECUTE_TASK') {
        const corruptedBytes = Buffer.alloc(65536, 0); // Completely wrong pixels
        const resPayload = JSON.stringify({
          taskId: msg.taskId,
          attemptNumber: 1,
          status: 'COMPLETED',
          outputData: corruptedBytes.toString('base64'),
          executionTimeMs: 10,
          itemCount: 1
        });

        const resIv = Buffer.alloc(12);
        crypto.randomBytes(4).copy(resIv, 0, 0, 4);
        resIv.writeBigUInt64BE(BigInt(2), 4);
        const resCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, resIv);
        resCipher.setAAD(Buffer.from(`${sessionId}:2`, 'utf-8'));
        const resCt = Buffer.concat([resCipher.update(Buffer.from(resPayload, 'utf-8')), resCipher.final()]);

        ws.send(JSON.stringify({
          type: 'TASK_RESULT',
          workerDeviceId: deviceId,
          taskId: msg.taskId,
          envelope: {
            sessionId,
            sequenceNum: 2,
            ivNonce: resIv.toString('base64'),
            ciphertext: resCt.toString('base64'),
            authTag: resCipher.getAuthTag().toString('base64')
          }
        }));
      }
    });

    const corruptWorkload: WorkloadDescriptor = {
      ...testWorkload,
      workloadId: 'wkl-corrupt-test',
      data: {
        ...testWorkload.data,
        payloadBase64: Buffer.alloc(65536, 140).toString('base64')
      }
    };

    const response = await (ipcServer as any).handleMessage({
      id: 21,
      method: 'executeWorkload',
      params: { workload: corruptWorkload, forceSwarm: true }
    });

    expect(response.result).to.exist;
    expect(response.result.status).to.equal('FAILED');
    expect(response.result.reason).to.include('Image tolerance exceeded');

    ws.close();
  });

  it('7. Multiple consecutive executeWorkload calls with identical workloadId do not collide on SQLite tasks.id', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyHex = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const salt = crypto.randomBytes(16);
    const deviceId = 'mac-worker-repeat-01';

    // Discovery beacon
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
      deviceName: 'Repeat Worker',
      host: '127.0.0.1',
      port: testPort,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId,
        deviceName: 'Repeat Worker',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu: true,
        gpuModel: 'Apple M2'
      }
    }));
    await discoveryAckPromise;

    // Initiate pairing
    const initRes = await (ipcServer as any).handleMessage({
      id: 30,
      method: 'initiatePairing',
      params: { workerDeviceId: deviceId }
    });
    const initiationId = initRes.result.initiationId;
    const hostPubKeyHex = initRes.result.hostPublicKeyHex;

    const hostPubDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(hostPubKeyHex, 'hex')]);
    const hostKeyObj = crypto.createPublicKey({ key: hostPubDer, format: 'der', type: 'spki' });
    const sharedSecret = crypto.diffieHellman({ privateKey: workerKeypair.privateKey, publicKey: hostKeyObj });
    const sasContext = `swarmx-sas-v1:swarmx-host:${deviceId}:${hostPubKeyHex}:${workerPubkeyHex}`;
    const sasCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);
    const { hostToWorkerKey, workerToHostKey } = PairingService.deriveDirectionalKeys(sharedSecret, salt);

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
      workerDeviceName: 'Repeat Worker',
      workerPublicKeyHex: workerPubkeyHex,
      workerSaltHex: salt.toString('hex'),
      confirmedSasCode: sasCode,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId,
        deviceName: 'Repeat Worker',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu: true,
        gpuModel: 'Apple M2'
      }
    }));

    const pairSuccess = await confirmPromise;
    const sessionId = pairSuccess.sessionId;

    // Telemetry
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
      cpuUtilization: 0.05,
      availableRamMb: 12000
    });
    const telemCt = Buffer.concat([telemCipher.update(Buffer.from(telemPayload, 'utf-8')), telemCipher.final()]);

    ws.send(JSON.stringify({
      type: 'ENCRYPTED_TELEMETRY',
      workerDeviceId: deviceId,
      envelope: {
        sessionId,
        sequenceNum: 1,
        ivNonce: telemIv.toString('base64'),
        ciphertext: telemCt.toString('base64'),
        authTag: telemCipher.getAuthTag().toString('base64')
      }
    }));
    await new Promise((r) => setTimeout(r, 50));

    // Handle EXECUTE_TASK
    let seq = 2;
    ws.on('message', (data: any) => {
      const msg = JSON.parse(data.toString('utf-8'));
      if (msg.type === 'EXECUTE_TASK') {
        const env = msg.envelope;
        const nonce = Buffer.from(env.ivNonce, 'base64');
        const ciphertext = Buffer.from(env.ciphertext, 'base64');
        const authTag = Buffer.from(env.authTag, 'base64');
        const aad = Buffer.from(`${env.sessionId}:${env.sequenceNum}`, 'utf-8');

        const decipher = crypto.createDecipheriv('aes-256-gcm', hostToWorkerKey, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);
        const decryptedTask = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8'));

        const inBytes = Buffer.from(decryptedTask.inputData, 'base64');
        const outBase64 = inBytes.toString('base64');

        const resPayload = JSON.stringify({
          taskId: decryptedTask.taskId,
          attemptNumber: 1,
          status: 'COMPLETED',
          outputData: outBase64,
          executionTimeMs: 10,
          itemCount: 1
        });

        const currentSeq = seq++;
        const resIv = Buffer.alloc(12);
        crypto.randomBytes(4).copy(resIv, 0, 0, 4);
        resIv.writeBigUInt64BE(BigInt(currentSeq), 4);
        const resCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, resIv);
        resCipher.setAAD(Buffer.from(`${sessionId}:${currentSeq}`, 'utf-8'));
        const resCt = Buffer.concat([resCipher.update(Buffer.from(resPayload, 'utf-8')), resCipher.final()]);

        ws.send(JSON.stringify({
          type: 'TASK_RESULT',
          workerDeviceId: deviceId,
          taskId: decryptedTask.taskId,
          envelope: {
            sessionId,
            sequenceNum: currentSeq,
            ivNonce: resIv.toString('base64'),
            ciphertext: resCt.toString('base64'),
            authTag: resCipher.getAuthTag().toString('base64')
          }
        }));
      }
    });

    const staticWorkload: WorkloadDescriptor = {
      ...testWorkload,
      workloadId: 'wkl-static-id-01',
      data: {
        ...testWorkload.data,
        payloadBase64: Buffer.alloc(65536, 140).toString('base64')
      }
    };

    // Run 1: with static workloadId
    const res1 = await (ipcServer as any).handleMessage({
      id: 31,
      method: 'executeWorkload',
      params: { workload: staticWorkload, forceSwarm: true }
    });
    expect(res1.result.status).to.equal('COMPLETED');

    // Run 2: with exact same static workloadId -> must succeed and NOT throw UNIQUE constraint error
    const res2 = await (ipcServer as any).handleMessage({
      id: 32,
      method: 'executeWorkload',
      params: { workload: staticWorkload, forceSwarm: true }
    });
    expect(res2.result.status).to.equal('COMPLETED');
    expect(res2.result.taskId).to.not.equal(res1.result.taskId);

    ws.close();
  });
});
