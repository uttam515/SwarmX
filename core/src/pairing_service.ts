import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { TrustedWorker, EncryptedEnvelope } from './types';

export interface DirectionalSessionKeys {
  hostToWorkerKey: Buffer; // Host encrypts, worker decrypts
  workerToHostKey: Buffer; // Worker encrypts, host decrypts
}

export interface ActiveSession {
  sessionId: string;
  deviceId: string;
  hostToWorkerKey: Buffer;
  workerToHostKey: Buffer;
  sessionKey?: Buffer; // Backward-compatibility alias
  ivSalt: Buffer; // 4-byte session random prefix for IV generation
  sendSequenceNum: number;
  lastReceivedSequenceNum: number;
  createdAtMs: number;
}

export class PairingService {
  private db: Database.Database;
  private activeSessions: Map<string, ActiveSession> = new Map(); // Key: deviceId or sessionId
  private pendingHandshakes: Map<string, {
    hostPrivateKey: crypto.KeyObject;
    hostPublicKeyHex: string;
    hostDeviceId: string;
    workerDeviceId: string;
    expectedSasCode: string;
    sharedSecret: Buffer;
    salt: Buffer;
    createdAtMs: number;
  }> = new Map();

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Generates a host ephemeral X25519 keypair for initiating pairing with a worker.
   */
  public createPairingInitiation(workerDeviceId: string, hostDeviceId: string = 'swarmx-host'): {
    hostDeviceId: string;
    hostPublicKeyHex: string;
    initiationId: string;
  } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const hostPublicKeyRaw = publicKey.export({ type: 'spki', format: 'der' });
    const hostPubkeyBytes = hostPublicKeyRaw.subarray(hostPublicKeyRaw.length - 32);
    const hostPublicKeyHex = hostPubkeyBytes.toString('hex');
    const initiationId = crypto.randomUUID();

    (this as any)[`_pending_init_${initiationId}`] = {
      privateKey,
      hostPublicKeyHex,
      hostDeviceId,
      workerDeviceId,
      createdAtMs: Date.now()
    };

    return {
      hostDeviceId,
      hostPublicKeyHex,
      initiationId
    };
  }

  /**
   * Derives a 4-digit Short Authentication String (SAS) cryptographically bound to the handshake transcript.
   */
  public static deriveSasCode(
    sharedSecret: Buffer,
    salt: Buffer,
    contextInfo: string = 'swarmx-sas-v1'
  ): string {
    const derived = Buffer.from(
      crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from(contextInfo, 'utf-8'), 4)
    );
    const num = (derived.readUInt32BE(0) % 9000) + 1000;
    return num.toString();
  }

  /**
   * Derives separate directional session keys (Host->Worker and Worker->Host) from the shared secret
   * to eliminate AES-GCM nonce-reuse collisions in bidirectional communications.
   */
  public static deriveDirectionalKeys(
    sharedSecret: Buffer,
    salt: Buffer
  ): DirectionalSessionKeys {
    const hostToWorkerKey = Buffer.from(
      crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from('swarmx-host-to-worker-v1', 'utf-8'), 32)
    );
    const workerToHostKey = Buffer.from(
      crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from('swarmx-worker-to-host-v1', 'utf-8'), 32)
    );
    return { hostToWorkerKey, workerToHostKey };
  }

  /**
   * Legacy session key derivation helper (retained for backward compatibility).
   */
  public static deriveSessionKey(
    sharedSecret: Buffer,
    salt: Buffer,
    contextInfo: string = 'swarmx-session-key-v1'
  ): Buffer {
    return Buffer.from(
      crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from(contextInfo, 'utf-8'), 32)
    );
  }

  /**
   * Process worker's ephemeral public key, complete ECDH, and derive the SAS comparison code bound to handshake context.
   */
  public processWorkerHandshake(
    initiationId: string,
    workerDeviceId: string,
    workerPublicKeyHex: string,
    workerSaltHex: string
  ): { comparisonCode: string } {
    const pendingInit = (this as any)[`_pending_init_${initiationId}`];
    if (!pendingInit) {
      throw new Error(`Invalid or expired pairing initiation ${initiationId}`);
    }

    const hostPrivateKey: crypto.KeyObject = pendingInit.privateKey;
    const workerPubkeyBytes = Buffer.from(workerPublicKeyHex, 'hex');
    const salt = Buffer.from(workerSaltHex, 'hex');

    // Reconstruct worker's X25519 public key object from raw 32 bytes
    const workerKeyDer = Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      workerPubkeyBytes
    ]);
    const workerPublicKey = crypto.createPublicKey({
      key: workerKeyDer,
      format: 'der',
      type: 'spki'
    });

    const sharedSecret = crypto.diffieHellman({
      privateKey: hostPrivateKey,
      publicKey: workerPublicKey
    });

    // Bound context string for SAS: binds ephemeral pubkeys and device IDs
    const sasContext = `swarmx-sas-v1:${pendingInit.hostDeviceId}:${workerDeviceId}:${pendingInit.hostPublicKeyHex}:${workerPublicKeyHex}`;
    const comparisonCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);

    this.pendingHandshakes.set(workerDeviceId, {
      hostPrivateKey,
      hostPublicKeyHex: pendingInit.hostPublicKeyHex,
      hostDeviceId: pendingInit.hostDeviceId,
      workerDeviceId,
      expectedSasCode: comparisonCode,
      sharedSecret,
      salt,
      createdAtMs: Date.now()
    });

    delete (this as any)[`_pending_init_${initiationId}`];

    return { comparisonCode };
  }

  /**
   * Confirms pairing when worker user taps Allow with matching SAS code.
   * Persists device trust to SQLite and establishes directional encrypted sessions.
   */
  public confirmPairing(
    workerDeviceId: string,
    workerDeviceName: string,
    workerPublicKeyHex: string,
    confirmedSasCode: string,
    initiationId?: string,
    workerSaltHex?: string
  ): { sessionId: string; sessionKey: Buffer; hostToWorkerKey: Buffer; workerToHostKey: Buffer; ivSalt: Buffer } {
    let handshake = this.pendingHandshakes.get(workerDeviceId);

    if (!handshake && initiationId && workerSaltHex) {
      // Process handshake directly from initiation
      this.processWorkerHandshake(initiationId, workerDeviceId, workerPublicKeyHex, workerSaltHex);
      handshake = this.pendingHandshakes.get(workerDeviceId);
    }

    if (!handshake) {
      throw new Error(`No pending handshake for worker ${workerDeviceId}`);
    }

    if (handshake.expectedSasCode !== confirmedSasCode) {
      throw new Error(`SAS code mismatch! Expected ${handshake.expectedSasCode}, got ${confirmedSasCode}`);
    }

    const { hostToWorkerKey, workerToHostKey } = PairingService.deriveDirectionalKeys(
      handshake.sharedSecret,
      handshake.salt
    );
    const sessionId = crypto.randomUUID();
    const now = Date.now();

    // Persist to SQLite trusted_workers table
    const secretHash = crypto.createHash('sha256').update(handshake.sharedSecret).digest('hex');
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trusted_workers (
        device_id, device_name, public_key, shared_secret_hash, paired_at_ms, last_seen_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(workerDeviceId, workerDeviceName, workerPublicKeyHex, secretHash, now, now);

    const session: ActiveSession = {
      sessionId,
      deviceId: workerDeviceId,
      hostToWorkerKey,
      workerToHostKey,
      sessionKey: hostToWorkerKey,
      ivSalt: crypto.randomBytes(4),
      sendSequenceNum: 0,
      lastReceivedSequenceNum: 0,
      createdAtMs: now
    };

    this.activeSessions.set(workerDeviceId, session);
    this.activeSessions.set(sessionId, session);
    this.pendingHandshakes.delete(workerDeviceId);

    return { sessionId, sessionKey: hostToWorkerKey, hostToWorkerKey, workerToHostKey, ivSalt: session.ivSalt };
  }

  public isWorkerTrusted(deviceId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM trusted_workers WHERE device_id = ?');
    return !!stmt.get(deviceId);
  }

  public getTrustedWorker(deviceId: string): TrustedWorker | null {
    const stmt = this.db.prepare('SELECT * FROM trusted_workers WHERE device_id = ?');
    const row = stmt.get(deviceId) as any;
    if (!row) return null;
    return {
      deviceId: row.device_id,
      deviceName: row.device_name,
      publicKey: row.public_key,
      sharedSecretHash: row.shared_secret_hash,
      pairedAtMs: row.paired_at_ms,
      lastSeenAtMs: row.last_seen_at_ms
    };
  }

  public listTrustedWorkers(): TrustedWorker[] {
    const stmt = this.db.prepare('SELECT * FROM trusted_workers ORDER BY paired_at_ms DESC');
    return (stmt.all() as any[]).map(row => ({
      deviceId: row.device_id,
      deviceName: row.device_name,
      publicKey: row.public_key,
      sharedSecretHash: row.shared_secret_hash,
      pairedAtMs: row.paired_at_ms,
      lastSeenAtMs: row.last_seen_at_ms
    }));
  }

  /**
   * Revocation: Permanently clears trust and terminates session.
   */
  public revokeWorker(deviceId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM trusted_workers WHERE device_id = ?');
    const result = stmt.run(deviceId);

    const session = this.activeSessions.get(deviceId);
    if (session) {
      this.activeSessions.delete(session.sessionId);
      this.activeSessions.delete(deviceId);
    }
    this.pendingHandshakes.delete(deviceId);

    return result.changes > 0;
  }

  /**
   * Constructs a 12-byte deterministic IV to prevent nonce reuse:
   * 4-byte session IV salt + 8-byte big-endian sequence number.
   */
  private constructIv(ivSalt: Buffer, sequenceNum: number): Buffer {
    const iv = Buffer.alloc(12);
    ivSalt.copy(iv, 0, 0, 4);
    iv.writeBigUInt64BE(BigInt(sequenceNum), 4);
    return iv;
  }

  /**
   * Encrypts a payload for an active session using AES-256-GCM.
   * Uses monotonic sequence numbering for deterministic nonces, and authenticates
   * sessionId and sequenceNum as Additional Authenticated Data (AAD).
   */
  public encryptEnvelope(sessionIdOrDeviceId: string, plaintext: Buffer | string): EncryptedEnvelope {
    const session = this.activeSessions.get(sessionIdOrDeviceId);
    if (!session) {
      throw new Error(`No active encrypted session for ${sessionIdOrDeviceId}`);
    }

    session.sendSequenceNum += 1;
    if (session.sendSequenceNum >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`Session sequence number limit reached; session key must be rotated`);
    }

    const iv = this.constructIv(session.ivSalt, session.sendSequenceNum);
    const cipher = crypto.createCipheriv('aes-256-gcm', session.hostToWorkerKey, iv);

    // Authenticate framing metadata as AAD
    const aad = Buffer.from(`${session.sessionId}:${session.sendSequenceNum}`, 'utf-8');
    cipher.setAAD(aad);

    const buffer = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      sessionId: session.sessionId,
      sequenceNum: session.sendSequenceNum,
      ivNonce: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64')
    };
  }

  /**
   * Decrypts an encrypted envelope received from a worker using AES-256-GCM (workerToHostKey).
   * Enforces replay protection and verifies AAD framing metadata.
   */
  public decryptEnvelope(envelope: EncryptedEnvelope): Buffer {
    const session = this.activeSessions.get(envelope.sessionId);
    if (!session) {
      throw new Error(`Unknown session ID ${envelope.sessionId}`);
    }

    // Replay Protection: Reject duplicate or decremented sequence numbers
    if (envelope.sequenceNum <= session.lastReceivedSequenceNum) {
      throw new Error(
        `Replay attack detected: Incoming sequenceNum ${envelope.sequenceNum} <= lastReceived ${session.lastReceivedSequenceNum}`
      );
    }

    const iv = Buffer.from(envelope.ivNonce, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', session.workerToHostKey, iv);

    // Verify AAD matches framing metadata
    const aad = Buffer.from(`${session.sessionId}:${envelope.sequenceNum}`, 'utf-8');
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Update sequence number watermark only upon verified decryption
    session.lastReceivedSequenceNum = envelope.sequenceNum;

    return decrypted;
  }
}
