import { expect } from 'chai';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
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
import { DistributionDecisionEngine } from '../src/decision_engine';
import { IpcServer } from '../src/ipc_server';
import { WorkloadDescriptor, ThermalState } from '../src/types';

describe('End-to-End Transparent Interception & Execution Simulation (Phase E)', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let workloadPipeline: WorkloadPipeline;
  let scheduler: ScoredScheduler;
  let decisionEngine: DistributionDecisionEngine;
  let ipcServer: IpcServer;

  const testSocketPath = path.join('/tmp', `swarmx-e2e-${Date.now()}.sock`);
  const testPort = 59160;

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

    decisionEngine = new DistributionDecisionEngine({
      defaultLanBandwidthBytesPerSec: 50 * 1024 * 1024,
      minGainThreshold: 1.0 // Allow swarm offloading in test fixture
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

  it('exercises full loop: IPC executeWorkload -> Scheduler -> Worker Kernel -> Pipeline -> IPC Result', async () => {
    // 1. Connect and pair simulated macOS worker
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyHex = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const salt = crypto.randomBytes(16);

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
      deviceId: 'worker-mac-sim-01',
      deviceName: 'Simulated MacBook Air M2',
      host: '127.0.0.1',
      port: testPort,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId: 'worker-mac-sim-01',
        deviceName: 'Simulated MacBook Air M2',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu: true
      }
    }));
    await discoveryAckPromise;

    // Pairing handshake
    const initRes = await ipcServer.handleMessage({
      id: 1,
      method: 'initiatePairing',
      params: { workerDeviceId: 'worker-mac-sim-01' }
    });
    const initiationId = initRes.result.initiationId;
    const hostPubKeyHex = initRes.result.hostPublicKeyHex;

    const hostPubDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(hostPubKeyHex, 'hex')]);
    const hostKeyObj = crypto.createPublicKey({ key: hostPubDer, format: 'der', type: 'spki' });
    const sharedSecret = crypto.diffieHellman({ privateKey: workerKeypair.privateKey, publicKey: hostKeyObj });
    const sasContext = `swarmx-sas-v1:swarmx-host:worker-mac-sim-01:${hostPubKeyHex}:${workerPubkeyHex}`;
    const sasCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);
    const { hostToWorkerKey, workerToHostKey } = PairingService.deriveDirectionalKeys(sharedSecret, salt);

    const pairSuccessPromise = new Promise<any>((resolve) => {
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
      workerDeviceId: 'worker-mac-sim-01',
      workerDeviceName: 'Simulated MacBook Air M2',
      workerPublicKeyHex: workerPubkeyHex,
      workerSaltHex: salt.toString('hex'),
      confirmedSasCode: sasCode,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId: 'worker-mac-sim-01',
        deviceName: 'Simulated MacBook Air M2',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu: true
      }
    }));

    const pairSuccess = await pairSuccessPromise;
    const sessionId = pairSuccess.sessionId;

    // Send positive telemetry so eligibility passes
    const telePayload = JSON.stringify({
      deviceId: 'worker-mac-sim-01',
      timestampMs: Date.now(),
      batteryLevel: 0.85,
      isCharging: true,
      thermalState: ThermalState.NOMINAL,
      cpuUtilization: 0.15,
      availableRamMb: 12000
    });
    const teleIv = Buffer.alloc(12);
    crypto.randomBytes(4).copy(teleIv, 0, 0, 4);
    teleIv.writeBigUInt64BE(BigInt(1), 4);
    const teleCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, teleIv);
    teleCipher.setAAD(Buffer.from(`${sessionId}:1`, 'utf-8'));
    const teleCt = Buffer.concat([teleCipher.update(Buffer.from(telePayload, 'utf-8')), teleCipher.final()]);

    ws.send(JSON.stringify({
      type: 'ENCRYPTED_TELEMETRY',
      workerDeviceId: 'worker-mac-sim-01',
      envelope: {
        sessionId,
        sequenceNum: 1,
        ivNonce: teleIv.toString('base64'),
        ciphertext: teleCt.toString('base64'),
        authTag: teleCipher.getAuthTag().toString('base64')
      }
    }));
    await new Promise((r) => setTimeout(r, 40));

    // 2. Set up worker listener for EXECUTE_TASK
    let taskReceivedByWorker: any = null;
    ws.on('message', (data: any) => {
      const msg = JSON.parse(data.toString('utf-8'));
      if (msg.type === 'EXECUTE_TASK') {
        taskReceivedByWorker = msg;
        // Decrypt task envelope
        const envelope = msg.envelope;
        const nonce = Buffer.from(envelope.ivNonce, 'base64');
        const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
        const authTag = Buffer.from(envelope.authTag, 'base64');
        const aad = Buffer.from(`${envelope.sessionId}:${envelope.sequenceNum}`, 'utf-8');

        const decipher = crypto.createDecipheriv('aes-256-gcm', hostToWorkerKey, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);
        const decryptedTask = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8'));

        // Simulate BoxBlur execution: Output processed buffer (echoing input with expected arithmetic)
        const inBytes = Buffer.from(decryptedTask.inputData, 'base64');
        const outBytes = Buffer.from(inBytes); // In a solid image, boxblur preserves values

        const resPayload = JSON.stringify({
          taskId: decryptedTask.taskId,
          attemptNumber: 1,
          status: 'COMPLETED',
          outputData: outBytes.toString('base64'),
          executionTimeMs: 15,
          itemCount: 1
        });

        // Encrypt TASK_RESULT with workerToHostKey
        const resIv = Buffer.alloc(12);
        crypto.randomBytes(4).copy(resIv, 0, 0, 4);
        resIv.writeBigUInt64BE(BigInt(2), 4);
        const resCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, resIv);
        resCipher.setAAD(Buffer.from(`${sessionId}:2`, 'utf-8'));
        const resCt = Buffer.concat([resCipher.update(Buffer.from(resPayload, 'utf-8')), resCipher.final()]);

        ws.send(JSON.stringify({
          type: 'TASK_RESULT',
          workerDeviceId: 'worker-mac-sim-01',
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

    // 3. Submit Workload via IPC
    const solidImageBuffer = Buffer.alloc(1024 * 1024 * 4, 128); // 4MB RGBA image
    const workload: WorkloadDescriptor = {
      workloadId: 'wkl-e2e-boxblur-01',
      version: '1.0.0',
      computation: {
        domain: 'IMAGE_PROCESSING',
        kernelId: 'image_filter_box_blur_v1',
        parameters: { radius: 2, width: 1024, height: 1024, mode: 'RGBA' }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: solidImageBuffer.length,
        format: 'RAW_PLANAR_RGBA_UINT8',
        payloadBase64: solidImageBuffer.toString('base64')
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'IMAGE_PIXEL_DELTA'
      }
    };

    const execRes = await ipcServer.handleMessage({
      id: 99,
      method: 'executeWorkload',
      params: { workload }
    });

    expect(execRes.error).to.be.undefined;
    expect(execRes.result).to.not.be.undefined;
    expect(execRes.result.status).to.equal('COMPLETED');
    expect(execRes.result.taskId).to.equal('wkl-e2e-boxblur-01');
    expect(execRes.result.outputData).to.equal(solidImageBuffer.toString('base64'));

    ws.close();
  });
});
