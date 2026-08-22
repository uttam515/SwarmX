import 'mocha';
import { expect } from 'chai';
import WebSocket from 'ws';
import * as crypto from 'crypto';
import { TransportServer } from '../src/transport_server';
import { WorkerManager } from '../src/worker_manager';
import { PairingService } from '../src/pairing_service';
import { TaskStore } from '../src/db/task_store';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import Database from 'better-sqlite3';

describe('Remote Worker Discovery -> Persistent Connection -> Pairing -> Ready Lifecycle', () => {
  let server: TransportServer;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let taskStore: TaskStore;
  let db: Database.Database;
  const testPort = 59288;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskStore = new TaskStore(db);
    workerManager = new WorkerManager();
    pairingService = new PairingService(db);
    server = new TransportServer(testPort, pairingService, workerManager, taskStore);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  it('Maintains transport connection after DISCOVERY_BEACON and completes UI Pair -> REGISTERED -> READY', async () => {
    const remoteDeviceId = 'macos-worker-DDFB250B';
    const remoteDeviceName = "Jatin's MacBook Air";
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // Mark the connected socket as remote IP (e.g. 172.16.72.150) so Core handles it as a true remote worker
    for (const client of (server as any).wss.clients) {
      client._remoteAddress = '172.16.72.150';
    }

    // 1. Worker sends DISCOVERY_BEACON (Simulating LaunchAgent background start on Jatin's Mac)
    const discoveryBeacon = {
      type: 'DISCOVERY_BEACON',
      deviceId: remoteDeviceId,
      deviceName: remoteDeviceName,
      host: '172.16.72.150',
      port: 50051,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId: remoteDeviceId,
        deviceName: remoteDeviceName,
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu: true,
        supportedKernels: ['video_frame_analysis_v1']
      }
    };

    const discoveryAckPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'DISCOVERY_ACK') resolve(msg);
      });
    });

    ws.send(JSON.stringify(discoveryBeacon));
    const ack = await discoveryAckPromise;
    expect(ack.type).to.equal('DISCOVERY_ACK');

    // 2. Verify Host lists remote worker in Discovered Nearby Devices AND transport socket is genuinely open
    const discovered = server.getDiscoveredWorkers();
    expect(discovered.length).to.equal(1);
    expect(discovered[0].deviceId).to.equal(remoteDeviceId);
    expect(discovered[0].deviceName).to.equal(remoteDeviceName);

    // 3. User clicks "Pair" in VS Code UI -> triggers initiatePairing
    const initiation = pairingService.createPairingInitiation(remoteDeviceId);
    
    // Set up worker listener for PAIRING_REQUEST
    const workerKeys = crypto.generateKeyPairSync('x25519');
    const workerPubKeyRaw = workerKeys.publicKey.export({ type: 'spki', format: 'der' });
    const workerPublicKeyHex = workerPubKeyRaw.subarray(workerPubKeyRaw.length - 32).toString('hex');
    const workerSaltHex = crypto.randomBytes(16).toString('hex');

    const pairingRequestPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'PAIRING_REQUEST') resolve(msg);
      });
    });

    const sent = server.sendPairingRequest(remoteDeviceId, initiation);
    expect(sent).to.be.true; // Transport socket MUST be alive and open!

    const reqMsg = await pairingRequestPromise;
    expect(reqMsg.type).to.equal('PAIRING_REQUEST');
    expect(reqMsg.initiationId).to.equal(initiation.initiationId);

    // 4. Worker processes request, derives SAS code, and sends PAIRING_CONFIRM
    const hostPubKey = Buffer.from(reqMsg.hostPublicKeyHex, 'hex');
    const sharedSecret = crypto.diffieHellman({
      privateKey: workerKeys.privateKey,
      publicKey: crypto.createPublicKey({
        key: Buffer.concat([
          Buffer.from('302a300506032b656e032100', 'hex'),
          hostPubKey
        ]),
        format: 'der',
        type: 'spki'
      })
    });
    const sasContext = `swarmx-sas-v1:${reqMsg.hostDeviceId || 'swarmx-host'}:${remoteDeviceId}:${reqMsg.hostPublicKeyHex}:${workerPublicKeyHex}`;
    const sasCode = PairingService.deriveSasCode(sharedSecret, Buffer.from(workerSaltHex, 'hex'), sasContext);

    const pairingSuccessPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'PAIRING_SUCCESS') resolve(msg);
      });
    });

    ws.send(JSON.stringify({
      type: 'PAIRING_CONFIRM',
      initiationId: reqMsg.initiationId,
      workerDeviceId: remoteDeviceId,
      workerDeviceName: remoteDeviceName,
      workerPublicKeyHex,
      workerSaltHex,
      confirmedSasCode: sasCode,
      capabilityProfile: discoveryBeacon.capabilityProfile
    }));

    const successMsg = await pairingSuccessPromise;
    expect(successMsg.type).to.equal('PAIRING_SUCCESS');

    // 5. Worker sends telemetry -> Worker enters READY state
    const directionalKeys = PairingService.deriveDirectionalKeys(sharedSecret, Buffer.from(workerSaltHex, 'hex'));
    const iv = Buffer.alloc(12);
    Buffer.from(successMsg.ivSaltHex || '01020304', 'hex').copy(iv, 0, 0, 4);
    iv.writeBigUInt64BE(BigInt(1), 4);

    const telemetryPayload = Buffer.from(JSON.stringify({
      deviceId: remoteDeviceId,
      timestampMs: Date.now(),
      batteryLevel: 0.98,
      isCharging: true,
      thermalState: 0,
      cpuUtilization: 0.05,
      availableRamMb: 14000,
      isEligible: true
    }), 'utf-8');

    const cipher = crypto.createCipheriv('aes-256-gcm', directionalKeys.workerToHostKey, iv);
    const aad = Buffer.from(`${successMsg.sessionId}:1`, 'utf-8');
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(telemetryPayload), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const encryptedEnvelope = {
      sessionId: successMsg.sessionId,
      sequenceNum: 1,
      ivNonce: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64')
    };

    ws.send(JSON.stringify({
      type: 'ENCRYPTED_TELEMETRY',
      deviceId: remoteDeviceId,
      envelope: encryptedEnvelope
    }));

    // Allow event loop to process telemetry
    await new Promise(r => setTimeout(r, 50));

    // 6. Verify Dashboard State Transitions:
    // - Moved OUT of Discovered Nearby Devices
    const discoveredAfter = server.getDiscoveredWorkers();
    expect(discoveredAfter.length).to.equal(0);

    // - Present in Registered & Eligible Swarm Workers in READY state
    const registered = workerManager.listWorkers();
    expect(registered.length).to.equal(1);
    expect(registered[0].deviceId).to.equal(remoteDeviceId);
    expect(registered[0].isEligible).to.be.true;
    expect(registered[0].liveState?.stage).to.equal('READY');

    ws.close();
  });

  it('Recovers and pairs successfully after transient disconnection and automatic reconnect', async () => {
    const remoteDeviceId = 'macos-worker-RECONNECT-TEST';
    const remoteDeviceName = "MacBook Pro Secondary";
    
    // First connection
    let ws = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    for (const client of (server as any).wss.clients) {
      client._remoteAddress = '172.16.72.160';
    }

    const discoveryBeacon = {
      type: 'DISCOVERY_BEACON',
      deviceId: remoteDeviceId,
      deviceName: remoteDeviceName,
      host: '172.16.72.160',
      port: 50051,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId: remoteDeviceId,
        deviceName: remoteDeviceName,
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 10,
        totalRamMb: 32768,
        hasGpu: true,
        supportedKernels: ['video_frame_analysis_v1']
      }
    };

    let ackPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'DISCOVERY_ACK') resolve(msg);
      });
    });
    ws.send(JSON.stringify(discoveryBeacon));
    await ackPromise;

    // Simulate transient network drop
    ws.close();
    await new Promise(r => setTimeout(r, 60));

    // Reconnection
    ws = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    for (const client of (server as any).wss.clients) {
      client._remoteAddress = '172.16.72.160';
    }

    ackPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'DISCOVERY_ACK') resolve(msg);
      });
    });
    ws.send(JSON.stringify(discoveryBeacon));
    await ackPromise;

    // Pair request on reconnected socket
    const initiation = pairingService.createPairingInitiation(remoteDeviceId);
    const sent = server.sendPairingRequest(remoteDeviceId, initiation);
    expect(sent).to.be.true;

    ws.close();
  });
});
