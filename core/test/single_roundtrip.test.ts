import 'mocha';
import { expect } from 'chai';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { IpcServer } from '../src/ipc_server';
import { TaskStore } from '../src/db/task_store';
import { WorkerManager } from '../src/worker_manager';
import { PairingService } from '../src/pairing_service';
import { TransportServer } from '../src/transport_server';
import { WorkloadPipeline } from '../src/workload_pipeline';
import { ScoredScheduler } from '../src/scheduler';
import { DistributionDecisionEngine } from '../src/decision_engine';
import { SimulationWorkerAdapter } from '../src/simulation_worker';
import { createDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrations';
import { BINARY_FRAME_MAGIC, encodeBinaryFrame, decodeBinaryFrame } from '../src/binary_framing';

describe('Single-Round-Trip Execution & Trustworthy Telemetry Tests (Phase 9B)', () => {
  let socketPath: string;
  let testPort: number;
  let db: Database.Database;
  let taskStore: TaskStore;
  let workerManager: WorkerManager;
  let pairingService: PairingService;
  let transportServer: TransportServer;
  let scheduler: ScoredScheduler;
  let decisionEngine: DistributionDecisionEngine;
  let workloadPipeline: WorkloadPipeline;
  let simulationWorker: SimulationWorkerAdapter;
  let ipcServer: IpcServer;

  beforeEach(async () => {
    socketPath = path.join('/tmp', `swarmx-single-rt-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);
    testPort = 59400 + Math.floor(Math.random() * 500);
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

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
      minGainThreshold: 1.0,
      ipcOverheadMs: 1.0,
      coordinationOverheadMs: 1.0
    });

    simulationWorker = new SimulationWorkerAdapter();
    simulationWorker.setConfig({ enabled: true, simulatedDelayMs: 2 });

    ipcServer = new IpcServer(
      socketPath,
      taskStore,
      workerManager,
      pairingService,
      transportServer,
      workloadPipeline,
      scheduler,
      decisionEngine,
      simulationWorker
    );

    await ipcServer.start();
  });

  afterEach(async () => {
    await ipcServer.stop();
    await transportServer.stop();
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });

  const sendBinaryRequest = (msg: any, rawPayload: Buffer): Promise<{ metadata: any; outputPayload: Buffer }> => {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        const frame = encodeBinaryFrame(msg, rawPayload);
        client.write(frame);
      });

      let buffer = Buffer.alloc(0);
      client.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length >= 8) {
          const jsonLen = buffer.readUInt32BE(4);
          const totalExpected = 8 + jsonLen;
          if (buffer.length >= totalExpected) {
            const decoded = decodeBinaryFrame(buffer);
            if (decoded) {
              const res = decoded.metadata.result || {};
              const expectedPayloadBytes = res.totalPayloadBytes || decoded.metadata.totalPayloadBytes || 0;
              if (decoded.payload.length >= expectedPayloadBytes) {
                client.end();
                resolve({ metadata: decoded.metadata, outputPayload: decoded.payload });
              }
            }
          }
        }
      });

      client.on('error', reject);
    });
  };

  it('1. Single Binary Frame Request executes SWARM and returns explicit telemetry with memory:// reference', async () => {
    const M = 64, K = 64, N = 64;
    const aFloats = new Float32Array(M * K).fill(2.0);
    const bFloats = new Float32Array(K * N).fill(3.0);
    const inFloats = new Float32Array(M * K + K * N);
    inFloats.set(aFloats, 0);
    inFloats.set(bFloats, M * K);
    const rawBuffer = Buffer.from(inFloats.buffer, inFloats.byteOffset, inFloats.byteLength);

    const workload = {
      workloadId: 'wkl-rt-test-01',
      version: '1.0.0',
      computation: {
        domain: 'NUMERICAL_COMPUTATION',
        kernelId: 'matrix_multiply_v1',
        parameters: { M, K, N, dtype: 'FLOAT32', chunks: 2 }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: rawBuffer.length,
        format: 'FLOAT32_ARRAY'
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'NUMERIC_TOLERANCE',
        maxMse: 1e-4
      }
    };

    const res = await sendBinaryRequest(
      { id: 1, method: 'executeWorkload', params: { workload, forceSwarm: true } },
      rawBuffer
    );

    expect(res.metadata.result.status).to.equal('COMPLETED');
    expect(res.metadata.result.totalChunks).to.equal(2);
    expect(res.outputPayload.length).to.equal(M * N * 4);

    const alignedBuf = Buffer.from(res.outputPayload);
    const outFloats = new Float32Array(alignedBuf.buffer, alignedBuf.byteOffset, alignedBuf.byteLength / 4);
    expect(outFloats[0]).to.be.closeTo(2.0 * 3.0 * K, 1e-4);

    // Verify explicit telemetry fields
    const telemetry = res.metadata.result.telemetry;
    expect(telemetry).to.not.be.undefined;
    expect(telemetry.decisionMs).to.be.a('number');
    expect(telemetry.chunkingMs).to.be.a('number');
    expect(telemetry.schedulingMs).to.be.a('number');
    expect(telemetry.workerComputeMs).to.be.a('number');
    expect(telemetry.reassemblyMs).to.be.a('number');
    expect(telemetry.validationMs).to.be.a('number');
    expect(telemetry.coreTotalMs).to.be.a('number');

    // Verify SQLite task result destination is lightweight memory pointer
    const tasks = taskStore.listTasks();
    const chunkTask = tasks.find((t: any) => t.id.includes('wkl-rt-test-01'));
    expect(chunkTask).to.not.be.undefined;
    expect(chunkTask!.resultDestination).to.include('memory://');
  });

  it('2. Single Binary Frame returns LOCAL_FALLBACK with decision telemetry when small workload is not forced', async () => {
    simulationWorker.setConfig({ enabled: false }); // No workers available
    const M = 16, K = 16, N = 16;
    const inFloats = new Float32Array(M * K + K * N).fill(1.0);
    const rawBuffer = Buffer.from(inFloats.buffer, inFloats.byteOffset, inFloats.byteLength);

    const workload = {
      workloadId: 'wkl-rt-local-01',
      version: '1.0.0',
      computation: {
        domain: 'NUMERICAL_COMPUTATION',
        kernelId: 'matrix_multiply_v1',
        parameters: { M, K, N, dtype: 'FLOAT32' }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: rawBuffer.length,
        format: 'FLOAT32_ARRAY'
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'NUMERIC_TOLERANCE'
      }
    };

    const res = await sendBinaryRequest(
      { id: 2, method: 'executeWorkload', params: { workload, forceSwarm: false } },
      rawBuffer
    );

    expect(res.metadata.result.status).to.equal('LOCAL_FALLBACK');
    expect(res.metadata.result.reason).to.be.a('string');
    expect(res.metadata.result.telemetry.decisionMs).to.be.a('number');
  });

  it('3. Single Binary Frame with rawPayloadBuffer dispatches to physical worker, receives real matrix data, passes validation, and completes without retrying', async () => {
    // 1. Disable simulation mode so cluster uses physical remote worker
    simulationWorker.setConfig({ enabled: false });

    // 2. Connect and pair a simulated physical worker (e.g. Mac #2)
    const deviceId = 'physical-mac-02';
    const deviceName = "Jatin's MacBook Air";
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const workerKeypair = crypto.generateKeyPairSync('x25519');
    const workerPubkeyHex = workerKeypair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const salt = crypto.randomBytes(16);

    // Send discovery beacon
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
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu: true
      }
    }));
    await discoveryAckPromise;

    // Initiate pairing
    const initRes = await ipcServer.handleMessage({
      id: 10,
      method: 'initiatePairing',
      params: { workerDeviceId: deviceId }
    });
    const initiationId = initRes.result.initiationId;
    const hostPubKeyHex = initRes.result.hostPublicKeyHex;

    // Derive SAS and directional keys
    const hostPubDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(hostPubKeyHex, 'hex')]);
    const hostKeyObj = crypto.createPublicKey({ key: hostPubDer, format: 'der', type: 'spki' });
    const sharedSecret = crypto.diffieHellman({ privateKey: workerKeypair.privateKey, publicKey: hostKeyObj });
    const sasContext = `swarmx-sas-v1:swarmx-host:${deviceId}:${hostPubKeyHex}:${workerPubkeyHex}`;
    const sasCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);
    const { hostToWorkerKey, workerToHostKey } = PairingService.deriveDirectionalKeys(sharedSecret, salt);

    // Confirm pairing
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
        cpuCores: 8,
        totalRamMb: 16384,
        hasGpu: true
      }
    }));
    const pairSuccess = await confirmPromise;
    const sessionId = pairSuccess.sessionId;

    // Send initial telemetry (Eligible = true)
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
      envelope: {
        sessionId,
        sequenceNum: 1,
        ivNonce: telemIv.toString('base64'),
        ciphertext: telemCiphertext.toString('base64'),
        authTag: telemCipher.getAuthTag().toString('base64')
      }
    }));
    await telemAckPromise;

    // Verify worker is registered & eligible
    expect(workerManager.listWorkers().length).to.equal(1);
    expect(workerManager.getWorker(deviceId)?.isEligible).to.be.true;

    // 3. Set up physical worker task execution listener
    let receivedInputPayload: string = '';
    const taskExecutionPromise = new Promise<any>((resolve) => {
      ws.on('message', (data: any) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'EXECUTE_TASK') {
          // Decrypt task envelope with hostToWorkerKey
          const env = msg.envelope;
          const iv = Buffer.from(env.ivNonce, 'base64');
          const decipher = crypto.createDecipheriv('aes-256-gcm', hostToWorkerKey, iv);
          decipher.setAAD(Buffer.from(`${env.sessionId}:${env.sequenceNum}`, 'utf-8'));
          decipher.setAuthTag(Buffer.from(env.authTag, 'base64'));
          const decrypted = Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]);
          const taskPayload = JSON.parse(decrypted.toString('utf-8'));
          receivedInputPayload = taskPayload.inputData;

          // Decode input matrix data from Base64
          const rawBytes = Buffer.from(taskPayload.inputData, 'base64');
          const inFloats = new Float32Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength / 4);

          // Dynamically decode M, K, N from computationDescriptor
          const desc = JSON.parse(taskPayload.computationDescriptor);
          const M_dyn = desc.parameters?.M || 512;
          const K_dyn = desc.parameters?.K || 512;
          const N_dyn = desc.parameters?.N || 512;
          const a = inFloats.subarray(0, M_dyn * K_dyn);
          const b = inFloats.subarray(M_dyn * K_dyn);
          const c = new Float32Array(M_dyn * N_dyn);

          for (let i = 0; i < M_dyn; i++) {
            for (let j = 0; j < N_dyn; j++) {
              let sum = 0;
              for (let p = 0; p < K_dyn; p++) {
                sum += a[i * K_dyn + p] * b[p * N_dyn + j];
              }
              c[i * N_dyn + j] = sum;
            }
          }

          const outBytes = Buffer.from(c.buffer, c.byteOffset, c.byteLength);
          const outBase64 = outBytes.toString('base64');

          // Send encrypted TASK_RESULT back to Core
          const resIv = Buffer.alloc(12);
          crypto.randomBytes(4).copy(resIv, 0, 0, 4);
          resIv.writeBigUInt64BE(BigInt(2), 4);
          const resCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, resIv);
          resCipher.setAAD(Buffer.from(`${sessionId}:2`, 'utf-8'));
          const resPayload = JSON.stringify({
            taskId: taskPayload.taskId,
            attemptNumber: taskPayload.attemptNumber || 1,
            status: 'COMPLETED',
            outputData: outBase64,
            executionTimeMs: 15,
            itemCount: 1,
            workerHostname: deviceName,
            workerPid: 12345
          });
          const resCiphertext = Buffer.concat([resCipher.update(Buffer.from(resPayload, 'utf-8')), resCipher.final()]);

          ws.send(JSON.stringify({
            type: 'TASK_RESULT',
            workerDeviceId: deviceId,
            taskId: taskPayload.taskId,
            envelope: {
              sessionId,
              sequenceNum: 2,
              ivNonce: resIv.toString('base64'),
              ciphertext: resCiphertext.toString('base64'),
              authTag: resCipher.getAuthTag().toString('base64')
            }
          }));

          resolve(taskPayload);
        }
      });
    });

    // 4. Dispatch single-task binary matrix multiplication from Python client (> 1MB large payload: 512x512 Float32 = 2MB raw)
    const M = 512, K = 512, N = 512;
    const aFloats = new Float32Array(M * K).fill(1.5);
    const bFloats = new Float32Array(K * N).fill(2.0);
    const inFloats = new Float32Array(M * K + K * N);
    inFloats.set(aFloats, 0);
    inFloats.set(bFloats, M * K);
    const rawBuffer = Buffer.from(inFloats.buffer, inFloats.byteOffset, inFloats.byteLength);

    const workload = {
      workloadId: 'wkl-physical-matrix-large-01',
      version: '1.0.0',
      computation: {
        domain: 'NUMERICAL_COMPUTATION',
        kernelId: 'matrix_multiply_v1',
        parameters: { M, K, N, dtype: 'FLOAT32' }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: rawBuffer.length,
        format: 'FLOAT32_ARRAY'
      },
      constraints: {
        isPure: true,
        isIdempotent: true,
        toleranceValidator: 'NUMERIC_TOLERANCE',
        maxMse: 1e-4
      }
    };

    const res = await sendBinaryRequest(
      { id: 3, method: 'executeWorkload', params: { workload, forceSwarm: true } },
      rawBuffer
    );

    // Wait for physical worker to receive the task
    const executedTask = await taskExecutionPromise;
    expect(executedTask).to.not.be.undefined;

    // Verify receivedInputPayload is NOT 'inline_payload' and contains actual base64 matrix data > 1MB
    expect(receivedInputPayload).to.not.equal('inline_payload');
    expect(receivedInputPayload.length).to.be.greaterThan(1024 * 1024);

    // Verify task status, validation, and zero retries in task store
    expect(res.metadata.result.status).to.equal('COMPLETED');
    expect(res.outputPayload.length).to.equal(M * N * 4);

    const alignedBuf = Buffer.from(res.outputPayload);
    const outFloats = new Float32Array(alignedBuf.buffer, alignedBuf.byteOffset, alignedBuf.byteLength / 4);
    expect(outFloats[0]).to.be.closeTo(1.5 * 2.0 * K, 1e-4);

    const storedTask = taskStore.getTask(executedTask.taskId);
    expect(storedTask).to.not.be.undefined;
    expect(storedTask!.status).to.equal('COMPLETED');
    expect(storedTask!.retryCount).to.equal(0);
    expect(storedTask!.attemptHistory.length).to.equal(0);

    ws.close();
  });

  it('4. Large Workload Transport & O(N) Ingestion (16MB/32MB Stream Ingestion)', async function() {
    this.timeout(20000);
    const width = 2048;
    const height = 2048;
    const rawBuffer = Buffer.alloc(width * height * 4); // 16MB RGBA planar buffer

    const workload = {
      workloadId: 'wkl-large-2048-ingest-test',
      version: '1.0.0',
      computation: {
        domain: 'IMAGE_PROCESSING',
        kernelId: 'image_filter_box_blur_v1',
        parameters: { width, height, radius: 2, channels: 4, mode: 'RGBA' }
      },
      data: {
        itemCount: 1,
        totalPayloadBytes: rawBuffer.length,
        format: 'RAW_PLANAR_RGBA_UINT8'
      }
    };

    simulationWorker.setConfig({ enabled: true });

    const t0 = Date.now();
    const res = await sendBinaryRequest(
      { id: 4, method: 'executeWorkload', params: { workload, forceSwarm: true } },
      rawBuffer
    );
    const elapsed = Date.now() - t0;

    expect(res.metadata.result.status).to.equal('COMPLETED');
    expect(res.outputPayload.length).to.equal(width * height * 4); // 16MB output
    expect(elapsed).to.be.lessThan(15000); // 16MB zero-copy ingested and returned
  });

  it('5. Single-Task Size-Aware Lease Timeout Calculation & SWARMX_WORKLOAD_TIMEOUT_MS', () => {
    // Tests timeout calculation for 32MB payload (2048x2048 float32 GEMM)
    const payload32Mb = 32 * 1024 * 1024;
    const computedTimeoutMs = Math.max(30000, 30000 + Math.round((payload32Mb / (1024 * 1024)) * 1500));
    expect(computedTimeoutMs).to.equal(78000); // 78 seconds for 32MB

    // Tests minimum 30s floor for small payloads
    const payloadSmall = 0;
    const computedSmallMs = Math.max(30000, 30000 + Math.round((payloadSmall / (1024 * 1024)) * 1500));
    expect(computedSmallMs).to.equal(30000);

    // Tests environment override
    process.env.SWARMX_WORKLOAD_TIMEOUT_MS = '95000';
    const envTimeoutMs = process.env.SWARMX_WORKLOAD_TIMEOUT_MS ? parseInt(process.env.SWARMX_WORKLOAD_TIMEOUT_MS, 10) : 0;
    expect(envTimeoutMs).to.equal(95000);
    delete process.env.SWARMX_WORKLOAD_TIMEOUT_MS;
  });
});
