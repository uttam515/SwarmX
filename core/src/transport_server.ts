import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import { Bonjour } from 'bonjour-service';
import { PairingService } from './pairing_service';
import { WorkerManager } from './worker_manager';
import { TaskStore } from './db/task_store';
import { DiscoveredWorker, EncryptedEnvelope, Task } from './types';
import { WorkloadPipeline } from './workload_pipeline';
import { Logger } from './logger';

export class TransportServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private bonjour: Bonjour | null = null;
  private bonjourService: any = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private port: number;
  private pairingService: PairingService;
  private workerManager: WorkerManager;
  private taskStore: TaskStore;
  private workloadPipeline?: WorkloadPipeline;
  private discoveredWorkers: Map<string, DiscoveredWorker> = new Map();
  private workerSockets: Map<string, WebSocket> = new Map();

  constructor(
    port: number,
    pairingService: PairingService,
    workerManager: WorkerManager,
    taskStore: TaskStore,
    workloadPipeline?: WorkloadPipeline
  ) {
    this.port = port;
    this.pairingService = pairingService;
    this.workerManager = workerManager;
    this.taskStore = taskStore;
    this.workloadPipeline = workloadPipeline;
  }

  public setWorkloadPipeline(pipeline: WorkloadPipeline): void {
    this.workloadPipeline = pipeline;
  }

  public getConnectedSocketCount(): number {
    return this.workerSockets.size;
  }

  public async start(): Promise<void> {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      let workerDeviceId: string | null = null;
      const remoteAddress = req?.socket?.remoteAddress || '127.0.0.1';
      Logger.transport(`WebSocket accepted from ${remoteAddress}`);

      ws.on('message', async (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString('utf-8'));
          const response = await this.handleWorkerMessage(msg, ws);
          if (response) {
            ws.send(JSON.stringify(response));
          }
          const devId = msg.deviceId || msg.workerDeviceId;
          if (devId) {
            const existingWs = this.workerSockets.get(devId);
            if (existingWs && existingWs !== ws) {
              try { existingWs.close(); } catch (e) {}
            }
            workerDeviceId = devId;
            this.workerSockets.set(workerDeviceId!, ws);
          }
        } catch (err: any) {
          Logger.error(`Transport error handling message from ${workerDeviceId || 'unknown'}: ${err.message}`);
          ws.send(JSON.stringify({ error: err.message }));
        }
      });

      ws.on('close', () => {
        Logger.transport(`WebSocket closed for ${workerDeviceId || remoteAddress}`);
        if (workerDeviceId && this.workerSockets.get(workerDeviceId) === ws) {
          this.workerSockets.delete(workerDeviceId);
          this.workerManager.unregisterWorker(workerDeviceId);
          Logger.workerState(`DISCONNECTED: ${workerDeviceId}`);
          // Worker-loss recovery: Reclaim all in-flight tasks assigned to this disconnected worker
          this.taskStore.recoverWorkerLoss(workerDeviceId);
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        resolve();
      });
    });

    // Start recurring Lease Watchdog timer (every 5 seconds)
    this.watchdogTimer = setInterval(() => {
      this.taskStore.recoverExpiredLeases();
    }, 5000);

    // Advertise discovery via Bonjour / mDNS
    try {
      this.bonjour = new Bonjour();
      const serviceName = `SwarmX Host (${process.env.USER || 'host'})`;
      this.bonjourService = this.bonjour.publish({
        name: serviceName,
        type: 'swarmx',
        port: this.port,
        disableIPv6: true,
        txt: {
          v: '1',
          proto: 'grpc-ws'
        }
      });
      this.bonjourService.on('error', (err: any) => {
        // Suppress benign mDNS service name duplicate warnings in test environments
      });
      Logger.transport(`Bonjour service published: '${serviceName}' (_swarmx._tcp.local) on port ${this.port} (IPv4)`);
    } catch (e) {
      console.warn('mDNS publish warning:', e);
    }
  }

  public addDiscoveredWorker(worker: DiscoveredWorker): void {
    // Canonical device identity deduplication & reconciliation
    const existing = this.discoveredWorkers.get(worker.deviceId);
    this.discoveredWorkers.set(worker.deviceId, {
      ...existing,
      ...worker,
      lastSeenMs: Date.now()
    });
  }

  public getDiscoveredWorkers(): DiscoveredWorker[] {
    const now = Date.now();
    // Auto-purge stale discovered entries not seen for > 30 seconds
    for (const [id, worker] of this.discoveredWorkers.entries()) {
      if (now - worker.lastSeenMs > 30000) {
        this.discoveredWorkers.delete(id);
      }
    }

    // Exclude workers that are already paired & connected
    const connectedIds = new Set(this.workerManager.listWorkers().map(w => w.deviceId));
    return Array.from(this.discoveredWorkers.values()).filter(d => !connectedIds.has(d.deviceId));
  }

  public sendPairingRequest(
    workerDeviceId: string,
    initiation: { initiationId: string; hostPublicKeyHex: string; hostDeviceId: string }
  ): boolean {
    const ws = this.workerSockets.get(workerDeviceId);
    if (!ws || ws.readyState !== ws.OPEN) {
      Logger.error(`Failed to send pairing request: Worker ${workerDeviceId} socket not connected/open`);
      return false;
    }
    Logger.pairing(`Pairing initiated for worker: ${workerDeviceId} (InitiationId: ${initiation.initiationId})`);
    Logger.workerState(`PAIRING: ${workerDeviceId}`);
    ws.send(JSON.stringify({
      type: 'PAIRING_REQUEST',
      initiationId: initiation.initiationId,
      hostDeviceId: initiation.hostDeviceId,
      hostPublicKeyHex: initiation.hostPublicKeyHex
    }));
    return true;
  }

  public sendExecuteTask(
    workerDeviceId: string,
    task: Task,
    inputData?: string,
    itemCount?: number
  ): boolean {
    const ws = this.workerSockets.get(workerDeviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const taskPayload = JSON.stringify({
      taskId: task.id,
      attemptNumber: task.retryCount + 1,
      computationDescriptor: task.computationDescriptor,
      inputRef: task.inputRef,
      inputData: inputData || task.inputRef,
      itemCount: itemCount || 1
    });

    const envelope = this.pairingService.encryptEnvelope(workerDeviceId, taskPayload);
    ws.send(JSON.stringify({
      type: 'EXECUTE_TASK',
      taskId: task.id,
      envelope
    }));
    return true;
  }

  private async handleWorkerMessage(msg: any, ws: WebSocket): Promise<any> {
    if (!msg || typeof msg !== 'object' || !msg.type) {
      Logger.error('Malformed worker message received: Missing message type');
      throw new Error('Malformed worker message: Missing message type');
    }

    switch (msg.type) {
      case 'DISCOVERY_BEACON': {
        const deviceId = msg.deviceId;
        const deviceName = msg.deviceName || 'Unknown';
        Logger.handshake(`Worker identity received: ${deviceId} (${deviceName})`);
        
        if (msg.capabilityProfile) {
          const prof = msg.capabilityProfile;
          Logger.capabilities(
            `Capabilities received for ${deviceId}: ` +
            `OS=${prof.osType || 'darwin'} ${prof.osVersion || ''}, ` +
            `Arch=${prof.cpuArch || 'unknown'}, ` +
            `Cores=${prof.cpuCores || 0}, ` +
            `RAM=${prof.totalRamMb || 0}MB, ` +
            `GPU=${prof.hasGpu ? (prof.gpuModel || 'Yes') : 'No'}`
          );
        }

        this.addDiscoveredWorker({
          deviceId: msg.deviceId,
          deviceName: msg.deviceName,
          host: msg.host || '127.0.0.1',
          port: msg.port || this.port,
          lastSeenMs: Date.now(),
          capabilityProfile: msg.capabilityProfile
        });
        Logger.workerState(`DISCOVERED: ${deviceId}`);
        return { type: 'DISCOVERY_ACK', hostDeviceId: 'swarmx-host' };
      }

      case 'PAIRING_INIT': {
        const { initiationId, workerDeviceId, workerPublicKeyHex, workerSaltHex } = msg;
        Logger.pairing(`Pairing handshake received for ${workerDeviceId}`);
        try {
          const result = this.pairingService.processWorkerHandshake(
            initiationId,
            workerDeviceId,
            workerPublicKeyHex,
            workerSaltHex
          );
          Logger.pairing(`SAS generated: ${result.comparisonCode}`);
          Logger.workerState(`PAIRING: ${workerDeviceId}`);
          return {
            type: 'PAIRING_SAS_READY',
            initiationId,
            workerDeviceId,
            comparisonCode: result.comparisonCode
          };
        } catch (err: any) {
          Logger.error(`PAIRING_INIT failed for ${workerDeviceId}: ${err.message}`);
          Logger.workerState(`REJECTED: ${workerDeviceId}`);
          throw err;
        }
      }

      case 'PAIRING_CONFIRM': {
        const {
          workerDeviceId,
          workerDeviceName,
          workerPublicKeyHex,
          confirmedSasCode,
          capabilityProfile,
          initiationId,
          workerSaltHex
        } = msg;

        Logger.pairing(`Pairing confirmation received for ${workerDeviceId} (SAS: ${confirmedSasCode})`);

        let session;
        try {
          session = this.pairingService.confirmPairing(
            workerDeviceId,
            workerDeviceName,
            workerPublicKeyHex,
            confirmedSasCode,
            initiationId,
            workerSaltHex
          );
          Logger.pairing(`SAS verified successfully for ${workerDeviceId}`);
        } catch (err: any) {
          Logger.error(`Pairing confirmation failed for ${workerDeviceId}: ${err.message}`);
          Logger.workerState(`REJECTED: ${workerDeviceId}`);
          throw err;
        }

        if (capabilityProfile) {
          try {
            this.workerManager.registerWorker(capabilityProfile);
            Logger.registration(`Worker registered: ${workerDeviceId}`);
          } catch (err: any) {
            Logger.error(`Worker capability registration failed for ${workerDeviceId}: ${err.message}`);
            Logger.workerState(`REJECTED: ${workerDeviceId}`);
            throw err;
          }
        }

        const devId = workerDeviceId || msg.deviceId;
        if (devId) {
          this.workerSockets.set(devId, ws);
        }

        Logger.workerState(`CONNECTED: ${workerDeviceId}`);

        return {
          type: 'PAIRING_SUCCESS',
          sessionId: session.sessionId,
          workerDeviceId
        };
      }

      case 'PAIRING_REJECT': {
        const { workerDeviceId, reason } = msg;
        Logger.pairing(`Pairing rejected by worker ${workerDeviceId}: ${reason || 'USER_REJECTED'}`);
        Logger.workerState(`REJECTED: ${workerDeviceId}`);
        return {
          type: 'PAIRING_REJECTED',
          workerDeviceId,
          reason: reason || 'USER_REJECTED'
        };
      }

      case 'ENCRYPTED_TELEMETRY': {
        const decryptedBytes = this.pairingService.decryptEnvelope(msg.envelope);
        const telemetry = JSON.parse(decryptedBytes.toString('utf-8'));
        
        const workerState = this.workerManager.updateTelemetry(telemetry);
        Logger.workerState(
          `${workerState.isEligible ? 'READY' : 'INELIGIBLE'}: ${telemetry.deviceId} ` +
          `(Battery=${Math.round(telemetry.batteryLevel * 100)}%, ` +
          `Thermal=${telemetry.thermalState}, ` +
          `CPU=${Math.round(telemetry.cpuUtilization * 100)}%)`
        );
        
        // Heartbeat renewal: Extends lease on all in-flight tasks assigned to this active worker
        this.taskStore.renewWorkerLeases(telemetry.deviceId);
        
        // Encrypt ACK
        const ackPayload = JSON.stringify({
          serverTimeMs: Date.now(),
          isEligible: workerState.isEligible
        });
        const ackEnvelope = this.pairingService.encryptEnvelope(msg.envelope.sessionId, ackPayload);
        
        return {
          type: 'ENCRYPTED_TELEMETRY_ACK',
          envelope: ackEnvelope
        };
      }

      case 'TASK_RESULT': {
        const decryptedBytes = this.pairingService.decryptEnvelope(msg.envelope);
        const resultPayload = JSON.parse(decryptedBytes.toString('utf-8'));
        const workerHost = resultPayload.workerHostname || msg.workerDeviceId;
        const workerPidStr = resultPayload.workerPid ? ` (PID=${resultPayload.workerPid})` : '';
        Logger.execution(`Result received for task ${resultPayload.taskId || msg.taskId} from ${workerHost}${workerPidStr} in ${resultPayload.executionTimeMs || 0}ms`);
        
        let processingResult = null;
        if (this.workloadPipeline) {
          processingResult = await this.workloadPipeline.handleTaskResult({
            taskId: resultPayload.taskId || msg.taskId,
            workerId: msg.workerDeviceId || (ws as any)._workerDeviceId,
            outputData: resultPayload.outputData,
            executionTimeMs: resultPayload.executionTimeMs || 0,
            attemptNumber: resultPayload.attemptNumber,
            itemCount: resultPayload.itemCount,
            workerHostname: resultPayload.workerHostname,
            workerPid: resultPayload.workerPid
          });
        }

        return {
          type: 'TASK_RESULT_ACK',
          taskId: msg.taskId,
          success: processingResult?.success ?? true
        };
      }

      case 'REVOKE_TRUST': {
        const { deviceId } = msg;
        this.pairingService.revokeWorker(deviceId);
        this.workerManager.unregisterWorker(deviceId);
        this.taskStore.recoverWorkerLoss(deviceId);
        ws.close();
        return null;
      }

      default:
        return { error: `Unhandled message type: ${msg.type}` };
    }
  }

  public async stop(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.bonjourService) {
      try {
        await new Promise<void>((resolve) => {
          try {
            this.bonjourService!.stop(() => resolve());
          } catch (e) {
            resolve();
          }
        });
      } catch (e) {}
      this.bonjourService = null;
    }
    if (this.bonjour) {
      try {
        await new Promise<void>((resolve) => {
          try {
            this.bonjour!.destroy(() => resolve());
          } catch (e) {
            resolve();
          }
        });
      } catch (e) {}
      this.bonjour = null;
    }
    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch (e) {}
      }
      this.wss.close();
    }
    this.workerSockets.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 1000);
        if (typeof (this.server as any).closeAllConnections === 'function') {
          (this.server as any).closeAllConnections();
        }
        this.server!.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }
}
