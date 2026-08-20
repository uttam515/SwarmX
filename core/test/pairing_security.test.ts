import { expect } from 'chai';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations';
import { PairingService } from '../src/pairing_service';
import { IpcServer } from '../src/ipc_server';
import { TaskStore } from '../src/db/task_store';
import { WorkerManager } from '../src/worker_manager';
import { TransportServer } from '../src/transport_server';

describe('Pairing, Transport Security & Hardening Tests', () => {
  let db: Database.Database;
  let pairingService: PairingService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    pairingService = new PairingService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('IPC Socket Hardening: /tmp/swarmx.sock must be created with owner-only permissions (0600)', async () => {
    const testSocketPath = path.join('/tmp', `swarmx-test-${Date.now()}.sock`);
    const taskStore = new TaskStore(db);
    const workerManager = new WorkerManager();
    const transportServer = new TransportServer(0, pairingService, workerManager, taskStore);
    const ipcServer = new IpcServer(testSocketPath, taskStore, workerManager, pairingService, transportServer);

    try {
      await ipcServer.start();
      expect(fs.existsSync(testSocketPath)).to.be.true;

      if (process.platform !== 'win32') {
        const stats = fs.statSync(testSocketPath);
        const mode = stats.mode & 0o777;
        expect(mode.toString(8)).to.equal('600');
      }
    } finally {
      await ipcServer.stop();
      if (fs.existsSync(testSocketPath)) {
        try { fs.unlinkSync(testSocketPath); } catch (e) {}
      }
    }
  });

  it('Bound Comparison Code (SAS): Host & Worker derive identical 4-digit SAS bound to handshake transcript', () => {
    const workerDeviceId = 'macbook-worker-01';
    const hostDeviceId = 'swarmx-host';

    // 1. Host initiates pairing
    const hostInit = pairingService.createPairingInitiation(workerDeviceId, hostDeviceId);

    // 2. Worker generates its X25519 keypair and salt
    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyRaw = workerKeypair.publicKey.export({ type: 'spki', format: 'der' });
    const workerPubkeyBytes = workerPubkeyRaw.subarray(workerPubkeyRaw.length - 32);
    const workerPublicKeyHex = workerPubkeyBytes.toString('hex');
    const salt = crypto.randomBytes(16);

    // 3. Worker computes shared secret locally
    const hostPubkeyBytes = Buffer.from(hostInit.hostPublicKeyHex, 'hex');
    const hostKeyDer = Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      hostPubkeyBytes
    ]);
    const hostPublicKeyObj = crypto.createPublicKey({ key: hostKeyDer, format: 'der', type: 'spki' });
    const workerSharedSecret = crypto.diffieHellman({
      privateKey: workerKeypair.privateKey,
      publicKey: hostPublicKeyObj
    });

    const sasContext = `swarmx-sas-v1:${hostDeviceId}:${workerDeviceId}:${hostInit.hostPublicKeyHex}:${workerPublicKeyHex}`;
    const workerDerivedSas = PairingService.deriveSasCode(workerSharedSecret, salt, sasContext);

    // 4. Host processes Worker's public key & salt
    const hostHandshake = pairingService.processWorkerHandshake(
      hostInit.initiationId,
      workerDeviceId,
      workerPublicKeyHex,
      salt.toString('hex')
    );

    // 5. Assert matching SAS codes bound to context
    expect(hostHandshake.comparisonCode).to.equal(workerDerivedSas);
    expect(hostHandshake.comparisonCode).to.match(/^\d{4}$/);

    // 6. Confirm pairing
    const session = pairingService.confirmPairing(
      workerDeviceId,
      'MacBook Worker',
      workerPublicKeyHex,
      workerDerivedSas
    );
    expect(session.sessionId).to.be.a('string');
    expect(pairingService.isWorkerTrusted(workerDeviceId)).to.be.true;
  });

  it('Session Encryption & AAD: Framing metadata is authenticated and payload is ciphertext', () => {
    const workerDeviceId = 'macbook-worker-02';
    const hostInit = pairingService.createPairingInitiation(workerDeviceId);
    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyRaw = workerKeypair.publicKey.export({ type: 'spki', format: 'der' });
    const workerPublicKeyHex = workerPubkeyRaw.subarray(workerPubkeyRaw.length - 32).toString('hex');
    const salt = crypto.randomBytes(16);

    const { comparisonCode } = pairingService.processWorkerHandshake(
      hostInit.initiationId,
      workerDeviceId,
      workerPublicKeyHex,
      salt.toString('hex')
    );

    const session = pairingService.confirmPairing(
      workerDeviceId,
      'MacBook Worker 2',
      workerPublicKeyHex,
      comparisonCode
    );

    const secretTaskPayload = JSON.stringify({
      taskId: 'task-secret-999',
      command: 'distributed_matrix_multiplication_sensitive_data',
      inputDataset: 'https://internal-storage.lan/dataset-private.bin'
    });

    // 1. Host encrypts payload for worker using hostToWorkerKey
    const hostEnvelope = pairingService.encryptEnvelope(session.sessionId, secretTaskPayload);

    // Verify envelope fields
    expect(hostEnvelope.sessionId).to.equal(session.sessionId);
    expect(hostEnvelope.sequenceNum).to.equal(1);
    expect(hostEnvelope.ciphertext).to.be.a('string');

    // Passive capture inspection: No plaintext in ciphertext
    const rawCiphertext = Buffer.from(hostEnvelope.ciphertext, 'base64').toString('utf-8');
    expect(rawCiphertext).to.not.include('task-secret-999');

    // Worker decrypts using hostToWorkerKey
    const workerDecipher = crypto.createDecipheriv(
      'aes-256-gcm',
      session.hostToWorkerKey,
      Buffer.from(hostEnvelope.ivNonce, 'base64')
    );
    workerDecipher.setAAD(Buffer.from(`${hostEnvelope.sessionId}:${hostEnvelope.sequenceNum}`, 'utf-8'));
    workerDecipher.setAuthTag(Buffer.from(hostEnvelope.authTag, 'base64'));
    const workerDecrypted = Buffer.concat([
      workerDecipher.update(Buffer.from(hostEnvelope.ciphertext, 'base64')),
      workerDecipher.final()
    ]);
    expect(workerDecrypted.toString('utf-8')).to.equal(secretTaskPayload);

    // 2. Worker encrypts telemetry for host using workerToHostKey
    const workerTelemetryPayload = JSON.stringify({ battery: 0.95, cpu: 0.12 });
    const workerIv = Buffer.alloc(12);
    session.ivSalt.copy(workerIv, 0, 0, 4);
    workerIv.writeBigUInt64BE(BigInt(1), 4);
    const workerCipher = crypto.createCipheriv('aes-256-gcm', session.workerToHostKey, workerIv);
    workerCipher.setAAD(Buffer.from(`${session.sessionId}:1`, 'utf-8'));
    const workerCiphertext = Buffer.concat([
      workerCipher.update(Buffer.from(workerTelemetryPayload, 'utf-8')),
      workerCipher.final()
    ]);
    const workerEnvelope = {
      sessionId: session.sessionId,
      sequenceNum: 1,
      ivNonce: workerIv.toString('base64'),
      ciphertext: workerCiphertext.toString('base64'),
      authTag: workerCipher.getAuthTag().toString('base64')
    };

    // Host decrypts worker envelope using workerToHostKey
    const hostDecrypted = pairingService.decryptEnvelope(workerEnvelope);
    expect(hostDecrypted.toString('utf-8')).to.equal(workerTelemetryPayload);

    // 3. Cross-Direction Rejection: Host attempting to decrypt hostEnvelope (encrypted with hostToWorkerKey) must fail
    expect(() => pairingService.decryptEnvelope(hostEnvelope)).to.throw();

    // AAD Tamper check: Altering sequenceNum in envelope must fail tag verification
    const tamperedEnvelope = { ...workerEnvelope, sequenceNum: 99 };
    expect(() => pairingService.decryptEnvelope(tamperedEnvelope)).to.throw();
  });

  it('Directional Key Separation: Host-to-Worker and Worker-to-Host keys are distinct and independently derived', () => {
    const sharedSecret = crypto.randomBytes(32);
    const salt = crypto.randomBytes(16);

    const { hostToWorkerKey, workerToHostKey } = PairingService.deriveDirectionalKeys(sharedSecret, salt);

    expect(hostToWorkerKey).to.have.lengthOf(32);
    expect(workerToHostKey).to.have.lengthOf(32);
    expect(hostToWorkerKey.equals(workerToHostKey)).to.be.false;
  });

  it('TaskStore Durable Exclusion Derivation: getExcludedWorkerIds extracts failed workers from attempt history', () => {
    const taskStore = new TaskStore(db);
    const task = taskStore.createTask({
      id: 'task-exclusion-test-01',
      inputRef: '/tmp/img1.png',
      computationDescriptor: 'sobel_filter',
      requiredResources: {},
      dependencies: [],
      executionConstraints: {},
      resultDestination: '/tmp/img1_out.png'
    });

    expect(taskStore.getExcludedWorkerIds(task.id)).to.deep.equal([]);

    // 1. Record validation tolerance failure on Worker A
    taskStore.recordTaskFailure(task.id, 'worker-mac-01', 'VALIDATION_TOLERANCE_EXCEEDED', { maxDiff: 5.2 });
    expect(taskStore.getExcludedWorkerIds(task.id)).to.deep.equal(['worker-mac-01']);

    // 2. Record execution failure on Worker B
    taskStore.recordTaskFailure(task.id, 'worker-win-02', 'EXECUTION_ERROR', { error: 'OOM' });
    expect(taskStore.getExcludedWorkerIds(task.id)).to.have.members(['worker-mac-01', 'worker-win-02']);

    // 3. Unrelated reason (e.g. host crash recovery) does not add to exclusion
    taskStore.recordTaskFailure(task.id, 'worker-mac-03', 'HOST_CRASH_RECOVERY');
    expect(taskStore.getExcludedWorkerIds(task.id)).to.have.members(['worker-mac-01', 'worker-win-02']);
  });

  it('Replay Attack Protection: Replayed or out-of-order sequence numbers are rejected', () => {
    const workerDeviceId = 'macbook-worker-replay';
    const hostInit = pairingService.createPairingInitiation(workerDeviceId);
    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPublicKeyHex = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const salt = crypto.randomBytes(16);

    const { comparisonCode } = pairingService.processWorkerHandshake(hostInit.initiationId, workerDeviceId, workerPublicKeyHex, salt.toString('hex'));
    const session = pairingService.confirmPairing(workerDeviceId, 'Worker', workerPublicKeyHex, comparisonCode);

    const createWorkerEnvelope = (seq: number, msg: string) => {
      const iv = Buffer.alloc(12);
      session.ivSalt.copy(iv, 0, 0, 4);
      iv.writeBigUInt64BE(BigInt(seq), 4);
      const cipher = crypto.createCipheriv('aes-256-gcm', session.workerToHostKey, iv);
      cipher.setAAD(Buffer.from(`${session.sessionId}:${seq}`, 'utf-8'));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(msg, 'utf-8')), cipher.final()]);
      return {
        sessionId: session.sessionId,
        sequenceNum: seq,
        ivNonce: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64')
      };
    };

    // Send envelope 1
    const env1 = createWorkerEnvelope(1, 'Message 1');
    pairingService.decryptEnvelope(env1); // Processed seq 1

    // Send envelope 2
    const env2 = createWorkerEnvelope(2, 'Message 2');
    pairingService.decryptEnvelope(env2); // Processed seq 2

    // Replay attack: Attacker resends env1 (seq 1)
    expect(() => pairingService.decryptEnvelope(env1)).to.throw(/Replay attack detected/);

    // Replay attack: Resend env2 (seq 2)
    expect(() => pairingService.decryptEnvelope(env2)).to.throw(/Replay attack detected/);
  });

  it('Persisted Trust Revocation: Revocation clears DB row, terminates session, and forces full re-pairing', () => {
    const workerDeviceId = 'worker-to-revoke';
    const hostInit = pairingService.createPairingInitiation(workerDeviceId);
    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPublicKeyHex = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const salt = crypto.randomBytes(16);

    const { comparisonCode } = pairingService.processWorkerHandshake(hostInit.initiationId, workerDeviceId, workerPublicKeyHex, salt.toString('hex'));
    const session = pairingService.confirmPairing(workerDeviceId, 'Worker To Revoke', workerPublicKeyHex, comparisonCode);

    expect(pairingService.isWorkerTrusted(workerDeviceId)).to.be.true;

    // Revoke
    const revoked = pairingService.revokeWorker(workerDeviceId);
    expect(revoked).to.be.true;

    expect(pairingService.isWorkerTrusted(workerDeviceId)).to.be.false;
    expect(pairingService.getTrustedWorker(workerDeviceId)).to.be.null;

    expect(() => {
      pairingService.encryptEnvelope(session.sessionId, 'test-msg');
    }).to.throw(/No active encrypted session/);
  });

  it('End-to-End Pairing Flow: IPC initiatePairing sends PAIRING_REQUEST over WebSocket to Worker and completes pairing', async () => {
    const testPort = 59123;
    const taskStore = new TaskStore(db);
    const workerManager = new WorkerManager();
    const transportServer = new TransportServer(testPort, pairingService, workerManager, taskStore);
    const testSocketPath = path.join('/tmp', `swarmx-e2e-${Date.now()}.sock`);
    const ipcServer = new IpcServer(testSocketPath, taskStore, workerManager, pairingService, transportServer);

    await transportServer.start();
    await ipcServer.start();

    const WebSocket = require('ws');
    const workerWs = new WebSocket(`ws://127.0.0.1:${testPort}`);
    const workerDeviceId = 'mac-worker-e2e-01';

    let receivedPairingRequest: any = null;

    await new Promise<void>((resolve) => {
      workerWs.on('open', () => {
        // Send discovery beacon
        workerWs.send(JSON.stringify({
          type: 'DISCOVERY_BEACON',
          deviceId: workerDeviceId,
          deviceName: 'E2E MacBook',
          capabilityProfile: {
            capabilitySchemaVersion: 1,
            deviceId: workerDeviceId,
            deviceName: 'E2E MacBook',
            osType: 'darwin',
            osVersion: '15.0',
            cpuArch: 'arm64',
            cpuCores: 8,
            totalRamMb: 16384,
            hasGpu: true
          }
        }));
      });

      workerWs.on('message', (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'DISCOVERY_ACK') {
          resolve();
        } else if (msg.type === 'PAIRING_REQUEST') {
          receivedPairingRequest = msg;
        }
      });
    });

    // 1. VS Code calls IPC initiatePairing
    const ipcResponse = await ipcServer.handleMessage({
      id: 1,
      method: 'initiatePairing',
      params: { workerDeviceId }
    });

    expect(ipcResponse.result).to.not.be.undefined;
    expect(ipcResponse.result.initiationId).to.be.a('string');

    // Wait for worker to receive PAIRING_REQUEST over WebSocket
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedPairingRequest).to.not.be.null;
    expect(receivedPairingRequest.type).to.equal('PAIRING_REQUEST');
    expect(receivedPairingRequest.initiationId).to.equal(ipcResponse.result.initiationId);

    // 2. Worker computes SAS and replies with PAIRING_CONFIRM
    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyBytes = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const workerPublicKeyHex = workerPubkeyBytes.toString('hex');
    const salt = crypto.randomBytes(16);

    const hostPubkeyBytes = Buffer.from(receivedPairingRequest.hostPublicKeyHex, 'hex');
    const hostKeyDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), hostPubkeyBytes]);
    const hostPublicKeyObj = crypto.createPublicKey({ key: hostKeyDer, format: 'der', type: 'spki' });
    const sharedSecret = crypto.diffieHellman({ privateKey: workerKeypair.privateKey, publicKey: hostPublicKeyObj });

    const sasContext = `swarmx-sas-v1:${receivedPairingRequest.hostDeviceId}:${workerDeviceId}:${receivedPairingRequest.hostPublicKeyHex}:${workerPublicKeyHex}`;
    const workerSas = PairingService.deriveSasCode(sharedSecret, salt, sasContext);

    // Step 2: Worker directly sends PAIRING_CONFIRM with initiationId and workerSaltHex
    const confirmResPromise = new Promise<any>((resolve) => {
      workerWs.once('message', (data: any) => resolve(JSON.parse(data.toString('utf-8'))));
    });
    workerWs.send(JSON.stringify({
      type: 'PAIRING_CONFIRM',
      initiationId: receivedPairingRequest.initiationId,
      workerDeviceId,
      workerDeviceName: 'E2E MacBook',
      workerPublicKeyHex,
      workerSaltHex: salt.toString('hex'),
      confirmedSasCode: workerSas,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId: workerDeviceId,
        deviceName: 'E2E MacBook',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu: true
      }
    }));
    const confirmRes = await confirmResPromise;
    expect(confirmRes.type).to.equal('PAIRING_SUCCESS');
    expect(confirmRes.sessionId).to.be.a('string');

    // 3. Assert worker is now registered and trusted in Core
    expect(pairingService.isWorkerTrusted(workerDeviceId)).to.be.true;
    const connected = workerManager.listWorkers();
    expect(connected.some(w => w.deviceId === workerDeviceId)).to.be.true;

    // 4. Assert IPC listConnectedWorkers query returns worker immediately
    const ipcConnectedRes = await ipcServer.handleMessage({
      id: 2,
      method: 'listConnectedWorkers'
    });
    expect(ipcConnectedRes.result).to.have.lengthOf(1);
    expect(ipcConnectedRes.result[0].deviceId).to.equal(workerDeviceId);
    expect(ipcConnectedRes.result[0].capabilityProfile.deviceName).to.equal('E2E MacBook');

    // 5. Worker streams encrypted telemetry -> Core updates telemetry state & eligibility
    const telemetryPayload = {
      deviceId: workerDeviceId,
      batteryLevel: 0.85,
      isCharging: false,
      thermalState: 0,
      cpuUtilization: 0.15,
      timestampMs: Date.now()
    };
    
    // Worker encrypts with workerToHostKey
    const { hostToWorkerKey, workerToHostKey } = PairingService.deriveDirectionalKeys(sharedSecret, salt);
    const workerIv = Buffer.alloc(12);
    crypto.randomBytes(4).copy(workerIv, 0, 0, 4);
    workerIv.writeBigUInt64BE(BigInt(1), 4);
    const workerCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, workerIv);
    workerCipher.setAAD(Buffer.from(`${confirmRes.sessionId}:1`, 'utf-8'));
    const telemCiphertext = Buffer.concat([
      workerCipher.update(Buffer.from(JSON.stringify(telemetryPayload), 'utf-8')),
      workerCipher.final()
    ]);
    const envelope = {
      sessionId: confirmRes.sessionId,
      sequenceNum: 1,
      ivNonce: workerIv.toString('base64'),
      ciphertext: telemCiphertext.toString('base64'),
      authTag: workerCipher.getAuthTag().toString('base64')
    };
    
    const telemAckPromise = new Promise<any>((resolve) => {
      workerWs.once('message', (data: any) => resolve(JSON.parse(data.toString('utf-8'))));
    });
    workerWs.send(JSON.stringify({
      type: 'ENCRYPTED_TELEMETRY',
      deviceId: workerDeviceId,
      envelope
    }));
    const telemAck = await telemAckPromise;
    expect(telemAck.type).to.equal('ENCRYPTED_TELEMETRY_ACK');
    expect(telemAck.envelope).to.not.be.undefined;

    // Worker decrypts ACK using hostToWorkerKey
    const ackDecipher = crypto.createDecipheriv(
      'aes-256-gcm',
      hostToWorkerKey,
      Buffer.from(telemAck.envelope.ivNonce, 'base64')
    );
    ackDecipher.setAAD(Buffer.from(`${telemAck.envelope.sessionId}:${telemAck.envelope.sequenceNum}`, 'utf-8'));
    ackDecipher.setAuthTag(Buffer.from(telemAck.envelope.authTag, 'base64'));
    const ackDecrypted = Buffer.concat([
      ackDecipher.update(Buffer.from(telemAck.envelope.ciphertext, 'base64')),
      ackDecipher.final()
    ]);
    const parsedAck = JSON.parse(ackDecrypted.toString('utf-8'));
    expect(parsedAck.isEligible).to.be.true;

    // 6. Assert IPC getStatus returns eligible worker count = 1
    const statusRes = await ipcServer.handleMessage({ id: 3, method: 'getStatus' });
    expect(statusRes.result.activeWorkerCount).to.equal(1);
    expect(statusRes.result.eligibleWorkerCount).to.equal(1);

    // Cleanup
    await new Promise((r) => {
      workerWs.on('close', r);
      workerWs.close();
    });
    await ipcServer.stop();
    await transportServer.stop();
  });

  it('Pairing Rejection: When worker user rejects connection, no trust or session is established', async () => {
    const testPort = 59124;
    const taskStore = new TaskStore(db);
    const workerManager = new WorkerManager();
    const transportServer = new TransportServer(testPort, pairingService, workerManager, taskStore);
    const testSocketPath = path.join('/tmp', `swarmx-reject-${Date.now()}.sock`);
    const ipcServer = new IpcServer(testSocketPath, taskStore, workerManager, pairingService, transportServer);

    await transportServer.start();
    await ipcServer.start();

    const WebSocket = require('ws');
    const workerWs = new WebSocket(`ws://127.0.0.1:${testPort}`);
    const workerDeviceId = 'mac-worker-reject-01';

    let receivedPairingRequest: any = null;

    await new Promise<void>((resolve) => {
      workerWs.on('open', () => {
        workerWs.send(JSON.stringify({
          type: 'DISCOVERY_BEACON',
          deviceId: workerDeviceId,
          deviceName: 'Reject MacBook',
          capabilityProfile: {
            capabilitySchemaVersion: 1,
            deviceId: workerDeviceId,
            deviceName: 'Reject MacBook',
            osType: 'darwin',
            osVersion: '15.0',
            cpuArch: 'arm64',
            cpuCores: 8,
            totalRamMb: 16384,
            hasGpu: true
          }
        }));
      });

      workerWs.on('message', (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'DISCOVERY_ACK') {
          resolve();
        } else if (msg.type === 'PAIRING_REQUEST') {
          receivedPairingRequest = msg;
        }
      });
    });

    // 1. Host initiates pairing
    await ipcServer.handleMessage({
      id: 1,
      method: 'initiatePairing',
      params: { workerDeviceId }
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(receivedPairingRequest).to.not.be.null;

    // 2. Worker user rejects [y/N] prompt -> sends PAIRING_REJECT
    const rejectResPromise = new Promise<any>((resolve) => {
      workerWs.once('message', (data: any) => resolve(JSON.parse(data.toString('utf-8'))));
    });
    workerWs.send(JSON.stringify({
      type: 'PAIRING_REJECT',
      workerDeviceId,
      reason: 'USER_REJECTED'
    }));
    const rejectRes = await rejectResPromise;
    expect(rejectRes.type).to.equal('PAIRING_REJECTED');

    // 3. Assert device is NOT trusted in Core and has NO active session
    expect(pairingService.isWorkerTrusted(workerDeviceId)).to.be.false;
    expect(workerManager.listWorkers().some(w => w.deviceId === workerDeviceId)).to.be.false;

    // Cleanup
    await new Promise((r) => {
      workerWs.on('close', r);
      workerWs.close();
    });
    await ipcServer.stop();
    await transportServer.stop();
  });

  it('Discovery Deduplication & State Reconciliation: Repeated discovery of same deviceId yields exactly one entry and excludes connected workers', async () => {
    const taskStore = new TaskStore(db);
    const workerManager = new WorkerManager();
    const transportServer = new TransportServer(59125, pairingService, workerManager, taskStore);

    const canonicalDeviceId = 'mac-worker-dedup-01';

    // 1. First discovery beacon arrives
    transportServer.addDiscoveredWorker({
      deviceId: canonicalDeviceId,
      deviceName: 'Uttam MacBook Air',
      host: '192.168.1.10',
      port: 50051,
      lastSeenMs: Date.now() - 5000,
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId: canonicalDeviceId,
        deviceName: 'Uttam MacBook Air',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 8192,
        hasGpu: true
      }
    });

    expect(transportServer.getDiscoveredWorkers()).to.have.lengthOf(1);
    expect(transportServer.getDiscoveredWorkers()[0].host).to.equal('192.168.1.10');

    // 2. Second discovery beacon arrives for the SAME canonical deviceId with updated IP/port
    transportServer.addDiscoveredWorker({
      deviceId: canonicalDeviceId,
      deviceName: 'Uttam MacBook Air',
      host: '192.168.1.25', // Updated IP
      port: 50051,
      lastSeenMs: Date.now(),
      capabilityProfile: {
        capabilitySchemaVersion: 1,
        deviceId: canonicalDeviceId,
        deviceName: 'Uttam MacBook Air',
        osType: 'darwin',
        osVersion: '15.0',
        cpuArch: 'arm64',
        cpuCores: 8,
        totalRamMb: 8192,
        hasGpu: true
      }
    });

    // Proves: Exactly 1 entry, reconciled with latest host IP
    const discovered = transportServer.getDiscoveredWorkers();
    expect(discovered).to.have.lengthOf(1);
    expect(discovered[0].deviceId).to.equal(canonicalDeviceId);
    expect(discovered[0].host).to.equal('192.168.1.25');

    // 3. Worker completes pairing and becomes connected
    workerManager.registerWorker({
      capabilitySchemaVersion: 1,
      deviceId: canonicalDeviceId,
      deviceName: 'Uttam MacBook Air',
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 8,
      totalRamMb: 8192,
      hasGpu: true
    });

    // Proves: Once connected, the worker is automatically excluded from Discovered Nearby Devices
    expect(transportServer.getDiscoveredWorkers()).to.have.lengthOf(0);
    expect(workerManager.listWorkers()).to.have.lengthOf(1);

    // 4. Repeated discovery while connected does not remove or duplicate connected state
    transportServer.addDiscoveredWorker({
      deviceId: canonicalDeviceId,
      deviceName: 'Uttam MacBook Air',
      host: '192.168.1.25',
      port: 50051,
      lastSeenMs: Date.now()
    });

    expect(transportServer.getDiscoveredWorkers()).to.have.lengthOf(0); // Still hidden from discovery list
    expect(workerManager.listWorkers()).to.have.lengthOf(1); // Still active connected worker
  });

  it('Graceful Shutdown Lifecycle: Closes active IPC and WebSocket connections cleanly without hanging', async () => {
    const testPort = 59126;
    const testSocketPath = path.join('/tmp', `swarmx-shutdown-${Date.now()}.sock`);
    const taskStore = new TaskStore(db);
    const workerManager = new WorkerManager();
    const transportServer = new TransportServer(testPort, pairingService, workerManager, taskStore);
    const ipcServer = new IpcServer(testSocketPath, taskStore, workerManager, pairingService, transportServer);

    await transportServer.start();
    await ipcServer.start();

    // 1. Establish persistent IPC client connection (simulating VS Code extension)
    const net = require('net');
    const ipcClientSocket = net.createConnection(testSocketPath);
    await new Promise<void>((resolve) => ipcClientSocket.on('connect', resolve));

    // 2. Establish persistent WebSocket connection (simulating macOS worker)
    const WebSocket = require('ws');
    const workerWs = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await new Promise<void>((resolve) => workerWs.on('open', resolve));

    // 3. Initiate shutdown while both clients are actively connected
    const startShutdownTime = Date.now();
    await Promise.all([
      ipcServer.stop(),
      transportServer.stop()
    ]);
    const durationMs = Date.now() - startShutdownTime;

    // Asserts shutdown completed in bounded time (< 1500ms) without hanging
    expect(durationMs).to.be.lessThan(1500);

    // Asserts socket file was cleaned up
    expect(fs.existsSync(testSocketPath)).to.be.false;
  });
});
