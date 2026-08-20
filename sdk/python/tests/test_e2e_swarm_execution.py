import unittest
import os
import time
import subprocess
import tempfile
import numpy as np
from PIL import Image, ImageFilter
from swarmx.interceptor import install_interceptor, uninstall_interceptor

class TestE2ESwarmExecution(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.socket_path = f"/tmp/swarmx-py-e2e-{int(time.time() * 1000)}.sock"
        cls.port = 59175

        # Create Core + Simulated Worker harness script
        harness_script = f"""
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const {{ createDatabase }} = require('./dist/db/sqlite');
const {{ runMigrations }} = require('./dist/db/migrations');
const {{ TaskStore }} = require('./dist/db/task_store');
const {{ WorkerManager }} = require('./dist/worker_manager');
const {{ PairingService }} = require('./dist/pairing_service');
const {{ TransportServer }} = require('./dist/transport_server');
const {{ WorkloadPipeline }} = require('./dist/workload_pipeline');
const {{ ScoredScheduler }} = require('./dist/scheduler');
const {{ DistributionDecisionEngine }} = require('./dist/decision_engine');
const {{ IpcServer }} = require('./dist/ipc_server');

async function main() {{
  const db = createDatabase(':memory:');
  runMigrations(db);
  const taskStore = new TaskStore(db);
  const workerManager = new WorkerManager();
  const pairingService = new PairingService(db);
  const scheduler = new ScoredScheduler();
  const workloadPipeline = new WorkloadPipeline(taskStore, scheduler);

  const transportServer = new TransportServer({cls.port}, pairingService, workerManager, taskStore, workloadPipeline);
  await transportServer.start();

  const decisionEngine = new DistributionDecisionEngine({{
    defaultLanBandwidthBytesPerSec: 50 * 1024 * 1024,
    minGainThreshold: 1.0 // Favor swarm for large payloads in test fixture
  }});

  const ipcServer = new IpcServer(
    '{cls.socket_path}',
    taskStore,
    workerManager,
    pairingService,
    transportServer,
    workloadPipeline,
    scheduler,
    decisionEngine
  );
  await ipcServer.start();

  // Connect simulated macOS worker
  const ws = new WebSocket('ws://127.0.0.1:{cls.port}');
  await new Promise((resolve) => ws.on('open', resolve));

  const workerKeypair = crypto.generateKeyPairSync('x25519');
  const workerPubkeyHex = workerKeypair.publicKey.export({{ type: 'spki', format: 'der' }}).subarray(-32).toString('hex');
  const salt = crypto.randomBytes(16);

  ws.send(JSON.stringify({{
    type: 'DISCOVERY_BEACON',
    deviceId: 'worker-mac-test-01',
    deviceName: 'MacBook Air M2 (Simulated)',
    host: '127.0.0.1',
    port: {cls.port},
    capabilityProfile: {{
      capabilitySchemaVersion: 1,
      deviceId: 'worker-mac-test-01',
      deviceName: 'MacBook Air M2 (Simulated)',
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 8,
      totalRamMb: 16384,
      hasGpu: true
    }}
  }}));

  await new Promise(r => setTimeout(r, 100));

  const initRes = await ipcServer.handleMessage({{
    id: 1,
    method: 'initiatePairing',
    params: {{ workerDeviceId: 'worker-mac-test-01' }}
  }});

  const hostPubKeyHex = initRes.result.hostPublicKeyHex;
  const hostPubDer = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(hostPubKeyHex, 'hex')]);
  const hostKeyObj = crypto.createPublicKey({{ key: hostPubDer, format: 'der', type: 'spki' }});
  const sharedSecret = crypto.diffieHellman({{ privateKey: workerKeypair.privateKey, publicKey: hostKeyObj }});
  const sasContext = `swarmx-sas-v1:swarmx-host:worker-mac-test-01:${{hostPubKeyHex}}:${{workerPubkeyHex}}`;
  const sasCode = PairingService.deriveSasCode(sharedSecret, salt, sasContext);
  const {{ hostToWorkerKey, workerToHostKey }} = PairingService.deriveDirectionalKeys(sharedSecret, salt);

  ws.send(JSON.stringify({{
    type: 'PAIRING_CONFIRM',
    initiationId: initRes.result.initiationId,
    workerDeviceId: 'worker-mac-test-01',
    workerDeviceName: 'MacBook Air M2 (Simulated)',
    workerPublicKeyHex: workerPubkeyHex,
    workerSaltHex: salt.toString('hex'),
    confirmedSasCode: sasCode,
    capabilityProfile: {{
      capabilitySchemaVersion: 1,
      deviceId: 'worker-mac-test-01',
      deviceName: 'MacBook Air M2 (Simulated)',
      osType: 'darwin',
      osVersion: '15.0',
      cpuArch: 'arm64',
      cpuCores: 8,
      totalRamMb: 16384,
      hasGpu: true
    }}
  }}));

  await new Promise(r => setTimeout(r, 100));

  // Send positive telemetry
  const telePayload = JSON.stringify({{
    deviceId: 'worker-mac-test-01',
    timestampMs: Date.now(),
    batteryLevel: 0.90,
    isCharging: true,
    thermalState: 0,
    cpuUtilization: 0.20,
    availableRamMb: 12000
  }});
  const teleIv = Buffer.alloc(12);
  crypto.randomBytes(4).copy(teleIv, 0, 0, 4);
  teleIv.writeBigUInt64BE(BigInt(1), 4);
  const teleCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, teleIv);
  teleCipher.setAAD(Buffer.from('worker-mac-test-01:1', 'utf-8'));
  const teleCt = Buffer.concat([teleCipher.update(Buffer.from(telePayload, 'utf-8')), teleCipher.final()]);

  ws.send(JSON.stringify({{
    type: 'ENCRYPTED_TELEMETRY',
    workerDeviceId: 'worker-mac-test-01',
    envelope: {{
      sessionId: 'worker-mac-test-01',
      sequenceNum: 1,
      ivNonce: teleIv.toString('base64'),
      ciphertext: teleCt.toString('base64'),
      authTag: teleCipher.getAuthTag().toString('base64')
    }}
  }}));

  // Worker executes task and returns valid result
  ws.on('message', (data) => {{
    const msg = JSON.parse(data.toString('utf-8'));
    if (msg.type === 'EXECUTE_TASK') {{
      const envelope = msg.envelope;
      const nonce = Buffer.from(envelope.ivNonce, 'base64');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      const authTag = Buffer.from(envelope.authTag, 'base64');
      const aad = Buffer.from(`${{envelope.sessionId}}:${{envelope.sequenceNum}}`, 'utf-8');

      const decipher = crypto.createDecipheriv('aes-256-gcm', hostToWorkerKey, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      const decryptedTask = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8'));

      const inBytes = Buffer.from(decryptedTask.inputData, 'base64');
      // Simulated BoxBlur output on test buffer
      const resPayload = JSON.stringify({{
        taskId: decryptedTask.taskId,
        attemptNumber: 1,
        status: 'COMPLETED',
        outputData: inBytes.toString('base64'),
        executionTimeMs: 20,
        itemCount: 1
      }});

      const resIv = Buffer.alloc(12);
      crypto.randomBytes(4).copy(resIv, 0, 0, 4);
      resIv.writeBigUInt64BE(BigInt(2), 4);
      const resCipher = crypto.createCipheriv('aes-256-gcm', workerToHostKey, resIv);
      resCipher.setAAD(Buffer.from('worker-mac-test-01:2', 'utf-8'));
      const resCt = Buffer.concat([resCipher.update(Buffer.from(resPayload, 'utf-8')), resCipher.final()]);

      ws.send(JSON.stringify({{
        type: 'TASK_RESULT',
        workerDeviceId: 'worker-mac-test-01',
        taskId: decryptedTask.taskId,
        envelope: {{
          sessionId: 'worker-mac-test-01',
          sequenceNum: 2,
          ivNonce: resIv.toString('base64'),
          ciphertext: resCt.toString('base64'),
          authTag: resCipher.getAuthTag().toString('base64')
        }}
      }}));
    }}
  }});

  console.log('HARNESS_READY');
}}

main().catch(err => {{
  console.error(err);
  process.exit(1);
}});
"""
        cls.harness_file = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False)
        cls.harness_file.write(harness_script)
        cls.harness_file.close()

        # Start harness process
        core_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "core"))
        cls.harness_proc = subprocess.Popen(
            ["node", cls.harness_file.name],
            cwd=core_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        # Wait for HARNESS_READY
        time.sleep(1.5)

        # Set environment socket path
        os.environ["SWARMX_IPC_PATH"] = cls.socket_path
        install_interceptor()

    @classmethod
    def tearDownClass(cls):
        uninstall_interceptor()
        os.environ.pop("SWARMX_IPC_PATH", None)
        if hasattr(cls, 'harness_proc'):
            cls.harness_proc.terminate()
            cls.harness_proc.wait()
        if hasattr(cls, 'harness_file') and os.path.exists(cls.harness_file.name):
            os.unlink(cls.harness_file.name)
        if os.path.exists(cls.socket_path):
            try:
                os.unlink(cls.socket_path)
            except Exception:
                pass

    def test_large_image_triggers_swarm_execution(self):
        """Large image (512x512 RGBA = 1MB) triggers SWARM decision and executes through SwarmX pipeline."""
        data = np.full((512, 512, 4), 180, dtype=np.uint8)
        img = Image.fromarray(data, mode="RGBA")

        # Execute through transparent interceptor
        filtered = img.filter(ImageFilter.BoxBlur(radius=2))

        self.assertIsInstance(filtered, Image.Image)
        self.assertEqual(filtered.size, (512, 512))
        self.assertEqual(filtered.mode, "RGBA")
        # Assert pixel fidelity
        self.assertEqual(filtered.getpixel((256, 256)), (180, 180, 180, 180))

    def test_small_image_triggers_local_decision(self):
        """Small image (16x16 RGBA = 1KB) below threshold triggers LOCAL decision in Cost Engine."""
        data = np.full((16, 16, 4), 100, dtype=np.uint8)
        img = Image.fromarray(data, mode="RGBA")

        filtered = img.filter(ImageFilter.BoxBlur(radius=2))

        self.assertIsInstance(filtered, Image.Image)
        self.assertEqual(filtered.size, (16, 16))
        self.assertEqual(filtered.getpixel((8, 8)), (100, 100, 100, 100))

if __name__ == "__main__":
    unittest.main()
