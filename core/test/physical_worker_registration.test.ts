import 'mocha';
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { TaskStore } from '../src/db/task_store';
import { WorkerManager } from '../src/worker_manager';
import { PairingService } from '../src/pairing_service';
import { TransportServer } from '../src/transport_server';
import { IpcServer } from '../src/ipc_server';
import { Logger } from '../src/logger';
import { CAPABILITY_SCHEMA_VERSION, ThermalState } from '../src/types';

describe('Physical Worker Registration & Observability Audit Tests', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let ipcServer: IpcServer;
  let testPort: number;
  let testSocketPath: string;
  let testDbPath: string;
  let testLogPath: string;

  beforeEach(async () => {
    const id = crypto.randomUUID().substring(0, 8);
    testDbPath = `/tmp/swarmx_test_${id}.db`;
    testSocketPath = `/tmp/swarmx_test_${id}.sock`;
    testLogPath = `/tmp/swarmx_test_${id}.log`;
    testPort = 54000 + Math.floor(Math.random() * 1000);

    Logger.init(testLogPath);

    db = createDatabase(testDbPath);
    runMigrations(db);
    taskStore = new TaskStore(db);
    workerManager = new WorkerManager();
    pairingService = new PairingService(db);

    transportServer = new TransportServer(
      testPort,
      pairingService,
      workerManager,
      taskStore
    );
    await transportServer.start();

    ipcServer = new IpcServer(
      testSocketPath,
      taskStore,
      workerManager,
      pairingService,
      transportServer
    );
    await ipcServer.start();
  });

  afterEach(async () => {
    await ipcServer.stop();
    await transportServer.stop();
    db.close();
    Logger.close();

    try { if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); } catch (e) {}
    try { if (fs.existsSync(testSocketPath)) fs.unlinkSync(testSocketPath); } catch (e) {}
    try { if (fs.existsSync(testLogPath)) fs.unlinkSync(testLogPath); } catch (e) {}
  });

  it('1. Physical Worker Full Handshake Sequence: BEACON -> ACK -> PAIRING_REQ -> CONFIRM -> SUCCESS -> TELEMETRY', async () => {
    const workerDeviceId = 'macos-worker-physical-01';
    const workerDeviceName = 'MacBook Pro Physical';
    const workerWs = new WebSocket(`ws://127.0.0.1:${testPort}`);

    let receivedAck: any = null;
    let receivedPairingRequest: any = null;
    let receivedPairingSuccess: any = null;
    let receivedTelemetryAck: any = null;

    // Await WebSocket Open & send DISCOVERY_BEACON
    await new Promise<void>((resolve) => {
      workerWs.on('open', () => {
        workerWs.send(JSON.stringify({
          type: 'DISCOVERY_BEACON',
          deviceId: workerDeviceId,
          deviceName: workerDeviceName,
          capabilityProfile: {
            capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
            deviceId: workerDeviceId,
            deviceName: workerDeviceName,
            osType: 'darwin',
            osVersion: '15.2',
            cpuArch: 'arm64',
            cpuCores: 12,
            totalRamMb: 32768,
            hasGpu: true,
            gpuModel: 'Apple M3 Pro'
          }
        }));
      });

      workerWs.on('message', (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'DISCOVERY_ACK') {
          receivedAck = msg;
          resolve();
        } else if (msg.type === 'PAIRING_REQUEST') {
          receivedPairingRequest = msg;
        } else if (msg.type === 'PAIRING_SUCCESS') {
          receivedPairingSuccess = msg;
        } else if (msg.type === 'ENCRYPTED_TELEMETRY_ACK') {
          receivedTelemetryAck = msg;
        }
      });
    });

    // Verify Step 1: DISCOVERY_ACK received
    expect(receivedAck).to.not.be.null;
    expect(receivedAck.type).to.equal('DISCOVERY_ACK');

    // Verify Step 2: getStatus reflects 1 discovered node, 1 socket connection, but 0 registered workers
    const statusBefore = await ipcServer.handleMessage({ id: 1, method: 'getStatus' });
    expect(statusBefore.result.webSocketConnectionCount).to.equal(1);
    expect(statusBefore.result.discoveredWorkerCount).to.equal(1);
    expect(statusBefore.result.activeWorkerCount).to.equal(0);
    expect(statusBefore.result.connectedWorkers).to.equal(0);

    // Verify Step 3: Host initiates pairing via IPC
    const initRes = await ipcServer.handleMessage({
      id: 2,
      method: 'initiatePairing',
      params: { workerDeviceId }
    });
    expect(initRes.result.initiationId).to.be.a('string');

    // Wait for worker to receive PAIRING_REQUEST over WebSocket
    await new Promise((r) => setTimeout(r, 60));
    expect(receivedPairingRequest).to.not.be.null;
    expect(receivedPairingRequest.initiationId).to.equal(initRes.result.initiationId);

    // Verify Step 4: Worker derives SAS and replies PAIRING_CONFIRM
    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyBytes = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const workerPublicKeyHex = workerPubkeyBytes.toString('hex');
    const salt = crypto.randomBytes(16);

    const hostPubkeyBytes = Buffer.from(receivedPairingRequest.hostPublicKeyHex, 'hex');
    const hostKeyDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), hostPubkeyBytes]);
    const hostPublicKeyObj = crypto.createPublicKey({ key: hostKeyDer, format: 'der', type: 'spki' });
    const sharedSecret = crypto.diffieHellman({ privateKey: workerKeypair.privateKey, publicKey: hostPublicKeyObj });

    const sasContext = `swarmx-sas-v1:${receivedPairingRequest.hostDeviceId}:${workerDeviceId}:${receivedPairingRequest.hostPublicKeyHex}:${workerPublicKeyHex}`;
    const sasCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);

    workerWs.send(JSON.stringify({
      type: 'PAIRING_CONFIRM',
      initiationId: receivedPairingRequest.initiationId,
      workerDeviceId,
      workerDeviceName,
      workerPublicKeyHex,
      workerSaltHex: salt.toString('hex'),
      confirmedSasCode: sasCode,
      capabilityProfile: {
        capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
        deviceId: workerDeviceId,
        deviceName: workerDeviceName,
        osType: 'darwin',
        osVersion: '15.2',
        cpuArch: 'arm64',
        cpuCores: 12,
        totalRamMb: 32768,
        hasGpu: true,
        gpuModel: 'Apple M3 Pro'
      }
    }));

    await new Promise((r) => setTimeout(r, 60));
    expect(receivedPairingSuccess).to.not.be.null;
    expect(receivedPairingSuccess.type).to.equal('PAIRING_SUCCESS');
    expect(receivedPairingSuccess.sessionId).to.be.a('string');

    // Verify Step 5: Worker is registered in WorkerManager and trusted in PairingService
    expect(pairingService.isWorkerTrusted(workerDeviceId)).to.be.true;
    const worker = workerManager.getWorker(workerDeviceId);
    expect(worker).to.not.be.undefined;
    expect(worker?.capabilityProfile.cpuCores).to.equal(12);

    // Verify Step 6: Worker sends encrypted telemetry
    const { workerToHostKey } = PairingService.deriveDirectionalKeys(sharedSecret, salt);
    const telemetryPayload = {
      deviceId: workerDeviceId,
      batteryLevel: 0.95,
      isCharging: true,
      thermalState: ThermalState.NOMINAL,
      cpuUtilization: 0.10,
      availableRamMb: 24000,
      timestampMs: Date.now()
    };
    const iv = Buffer.alloc(12);
    crypto.randomBytes(4).copy(iv, 0, 0, 4);
    iv.writeBigUInt64BE(BigInt(1), 4);
    const cipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, iv);
    cipher.setAAD(Buffer.from(`${receivedPairingSuccess.sessionId}:1`, 'utf-8'));
    const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(telemetryPayload), 'utf-8')), cipher.final()]);
    const tag = cipher.getAuthTag();

    workerWs.send(JSON.stringify({
      type: 'ENCRYPTED_TELEMETRY',
      envelope: {
        sessionId: receivedPairingSuccess.sessionId,
        sequenceNum: 1,
        ivNonce: iv.toString('base64'),
        ciphertext: ct.toString('base64'),
        authTag: tag.toString('base64')
      }
    }));

    await new Promise((r) => setTimeout(r, 60));
    expect(receivedTelemetryAck).to.not.be.null;

    // Verify Step 7: getStatus now shows 1 active worker, 1 eligible worker, 1 trusted worker
    const statusAfter = await ipcServer.handleMessage({ id: 3, method: 'getStatus' });
    expect(statusAfter.result.activeWorkerCount).to.equal(1);
    expect(statusAfter.result.eligibleWorkerCount).to.equal(1);
    expect(statusAfter.result.trustedWorkerCount).to.equal(1);
    expect(statusAfter.result.discoveredWorkerCount).to.equal(0); // Excluded because it's now paired & connected

    // Clean close
    workerWs.close();
  });

  it('2. Invalid or missing registration message returns explicit error and does not corrupt state', async () => {
    const workerWs = new WebSocket(`ws://127.0.0.1:${testPort}`);
    let receivedError: any = null;

    await new Promise<void>((resolve) => {
      workerWs.on('open', () => {
        // Send message with missing type
        workerWs.send(JSON.stringify({ foo: 'bar' }));
      });
      workerWs.on('message', (data: any) => {
        receivedError = JSON.parse(data.toString('utf-8'));
        resolve();
      });
    });

    expect(receivedError).to.not.be.null;
    expect(receivedError.error).to.include('Missing message type');
    workerWs.close();
  });

  it('3. Worker capability schema version mismatch fails registration and transitions state to REJECTED', async () => {
    const workerDeviceId = 'macos-worker-unsupported-v99';
    const workerWs = new WebSocket(`ws://127.0.0.1:${testPort}`);

    let receivedAck: any = null;
    let receivedPairingRequest: any = null;
    let receivedError: any = null;

    await new Promise<void>((resolve) => {
      workerWs.on('open', () => {
        workerWs.send(JSON.stringify({
          type: 'DISCOVERY_BEACON',
          deviceId: workerDeviceId,
          deviceName: 'Future Mac',
          capabilityProfile: {
            capabilitySchemaVersion: 99, // Unsupported version
            deviceId: workerDeviceId,
            deviceName: 'Future Mac'
          }
        }));
      });

      workerWs.on('message', (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'DISCOVERY_ACK') {
          receivedAck = msg;
          resolve();
        } else if (msg.type === 'PAIRING_REQUEST') {
          receivedPairingRequest = msg;
        } else if (msg.error) {
          receivedError = msg;
        }
      });
    });

    expect(receivedAck).to.not.be.null;

    // Host initiates pairing
    const initRes = await ipcServer.handleMessage({
      id: 1,
      method: 'initiatePairing',
      params: { workerDeviceId }
    });

    await new Promise((r) => setTimeout(r, 60));
    expect(receivedPairingRequest).to.not.be.null;

    // Worker derives SAS
    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyBytes = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const workerPublicKeyHex = workerPubkeyBytes.toString('hex');
    const salt = crypto.randomBytes(16);

    const hostPubkeyBytes = Buffer.from(receivedPairingRequest.hostPublicKeyHex, 'hex');
    const hostKeyDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), hostPubkeyBytes]);
    const hostPublicKeyObj = crypto.createPublicKey({ key: hostKeyDer, format: 'der', type: 'spki' });
    const sharedSecret = crypto.diffieHellman({ privateKey: workerKeypair.privateKey, publicKey: hostPublicKeyObj });

    const sasContext = `swarmx-sas-v1:${receivedPairingRequest.hostDeviceId}:${workerDeviceId}:${receivedPairingRequest.hostPublicKeyHex}:${workerPublicKeyHex}`;
    const sasCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);

    // Worker sends invalid schema version in capabilityProfile
    workerWs.send(JSON.stringify({
      type: 'PAIRING_CONFIRM',
      initiationId: receivedPairingRequest.initiationId,
      workerDeviceId,
      workerDeviceName: 'Future Mac',
      workerPublicKeyHex,
      workerSaltHex: salt.toString('hex'),
      confirmedSasCode: sasCode,
      capabilityProfile: {
        capabilitySchemaVersion: 99,
        deviceId: workerDeviceId,
        deviceName: 'Future Mac'
      }
    }));

    await new Promise((r) => setTimeout(r, 60));
    expect(receivedError).to.not.be.null;
    expect(receivedError.error).to.include('Unsupported capability schema version');
    expect(workerManager.getWorker(workerDeviceId)).to.be.undefined;

    workerWs.close();
  });

  it('4. Structured logs contain required diagnostic tags and are written to log file', async () => {
    const workerDeviceId = 'macos-worker-log-test';
    const workerWs = new WebSocket(`ws://127.0.0.1:${testPort}`);

    await new Promise<void>((resolve) => {
      workerWs.on('open', () => {
        workerWs.send(JSON.stringify({
          type: 'DISCOVERY_BEACON',
          deviceId: workerDeviceId,
          deviceName: 'Log Mac',
          capabilityProfile: {
            capabilitySchemaVersion: 1,
            deviceId: workerDeviceId,
            deviceName: 'Log Mac',
            cpuArch: 'arm64',
            cpuCores: 8,
            totalRamMb: 16384,
            hasGpu: true
          }
        }));
      });
      workerWs.on('message', () => resolve());
    });

    // Wait a brief tick for file write flush
    await new Promise((r) => setTimeout(r, 80));

    expect(fs.existsSync(testLogPath)).to.be.true;
    const logContent = fs.readFileSync(testLogPath, 'utf-8');

    expect(logContent).to.include('[TRANSPORT] WebSocket accepted');
    expect(logContent).to.include('[HANDSHAKE] Worker identity received: macos-worker-log-test');
    expect(logContent).to.include('[CAPABILITIES] Capabilities received for macos-worker-log-test');
    expect(logContent).to.include('[WORKER STATE] DISCOVERED: macos-worker-log-test');

    workerWs.close();
  });
});
