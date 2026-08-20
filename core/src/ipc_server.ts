import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TaskStore } from './db/task_store';
import { WorkerManager } from './worker_manager';
import { PairingService } from './pairing_service';
import { TransportServer } from './transport_server';
import { WorkloadPipeline } from './workload_pipeline';
import { ScoredScheduler } from './scheduler';
import { DistributionDecisionEngine } from './decision_engine';
import { KernelRegistry } from './kernel_registry';
import { BINARY_FRAME_MAGIC, encodeBinaryFrame, decodeBinaryFrame } from './binary_framing';
import { Task, TaskStatus, WorkloadDescriptor } from './types';
import { Logger } from './logger';

export interface IpcMessage {
  id: string | number;
  method: string;
  params?: any;
}

export interface IpcResponse {
  id: string | number;
  result?: any;
  error?: string;
}

export class IpcServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private taskStore: TaskStore;
  private workerManager: WorkerManager;
  private pairingService: PairingService;
  private transportServer: TransportServer;
  private workloadPipeline?: WorkloadPipeline;
  private scheduler?: ScoredScheduler;
  private decisionEngine: DistributionDecisionEngine;
  private swarmEnabled: boolean = true;

  private activeSockets: Set<net.Socket> = new Set();

  constructor(
    socketPath: string,
    taskStore: TaskStore,
    workerManager: WorkerManager,
    pairingService: PairingService,
    transportServer: TransportServer,
    workloadPipeline?: WorkloadPipeline,
    scheduler?: ScoredScheduler,
    decisionEngine?: DistributionDecisionEngine
  ) {
    this.socketPath = socketPath;
    this.taskStore = taskStore;
    this.workerManager = workerManager;
    this.pairingService = pairingService;
    this.transportServer = transportServer;
    this.workloadPipeline = workloadPipeline;
    this.scheduler = scheduler;
    this.decisionEngine = decisionEngine || new DistributionDecisionEngine();
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Remove stale socket if it exists on Unix
      if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
        try {
          fs.unlinkSync(this.socketPath);
        } catch (e) {
          // ignore
        }
      }

      this.server = net.createServer((socket) => {
        this.activeSockets.add(socket);
        socket.on('close', () => this.activeSockets.delete(socket));

        let rawBuffer = Buffer.alloc(0);

        socket.on('data', async (chunk) => {
          rawBuffer = Buffer.concat([rawBuffer, chunk]);

          // 1. Check for Binary Frame Magic ('SWRM' = 0x5357524D)
          if (rawBuffer.length >= 4 && rawBuffer.readUInt32BE(0) === BINARY_FRAME_MAGIC) {
            try {
              let decoded = decodeBinaryFrame(rawBuffer);
              while (decoded) {
                rawBuffer = rawBuffer.subarray(decoded.totalLength);

                const msg = decoded.metadata;
                // Pass raw binary payload directly into workload data
                if (msg.params?.workload?.data) {
                  msg.params.workload.data.rawPayloadBuffer = decoded.payload;
                  if (!msg.params.workload.data.payloadBase64) {
                    msg.params.workload.data.payloadBase64 = decoded.payload.toString('base64');
                  }
                }

                try {
                  const response = await this.handleMessage(msg);
                  let outBuffer = Buffer.alloc(0);
                  if (response.result?.outputData && Buffer.isBuffer(response.result.outputData)) {
                    outBuffer = response.result.outputData;
                    delete response.result.outputData;
                  } else if (typeof response.result?.outputData === 'string') {
                    outBuffer = Buffer.from(response.result.outputData, 'base64');
                    delete response.result.outputData;
                  }

                  const respFrame = encodeBinaryFrame(response, outBuffer);
                  socket.write(respFrame);
                } catch (err: any) {
                  const errFrame = encodeBinaryFrame({ id: msg.id || null, error: err.message }, Buffer.alloc(0));
                  socket.write(errFrame);
                }

                decoded = rawBuffer.length >= 4 && rawBuffer.readUInt32BE(0) === BINARY_FRAME_MAGIC
                  ? decodeBinaryFrame(rawBuffer)
                  : null;
              }
            } catch (err: any) {
              // Frame corrupted or oversized -> discard buffer and send error frame
              rawBuffer = Buffer.alloc(0);
              const errFrame = encodeBinaryFrame({ id: null, error: `BINARY_FRAME_ERROR: ${err.message}` }, Buffer.alloc(0));
              socket.write(errFrame);
            }
            return;
          }

          // 2. Legacy JSON-RPC Line Protocol
          const text = rawBuffer.toString('utf-8');
          if (text.includes('\n')) {
            const lines = text.split('\n');
            const remainder = lines.pop() || '';
            rawBuffer = Buffer.from(remainder, 'utf-8');

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const msg: IpcMessage = JSON.parse(line);
                const response = await this.handleMessage(msg);
                socket.write(JSON.stringify(response) + '\n');
              } catch (err: any) {
                socket.write(JSON.stringify({ id: null, error: err.message }) + '\n');
              }
            }
          }
        });
      });

      this.server.listen(this.socketPath, () => {
        // Enforce owner-only permissions (0600) on Unix sockets
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.socketPath, 0o600);
          } catch (err) {
            console.error(`Failed to set 0600 permissions on socket: ${err}`);
          }
        }
        resolve();
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  public async handleMessage(msg: IpcMessage): Promise<IpcResponse> {
    try {
      switch (msg.method) {
        case 'getStatus': {
          const tasks = this.taskStore.listTasks();
          const workers = this.workerManager.listWorkers();
          const eligibleWorkers = this.workerManager.listEligibleWorkers();
          const discovered = this.transportServer.getDiscoveredWorkers();
          const trusted = this.pairingService.listTrustedWorkers();
          const socketCount = this.transportServer.getConnectedSocketCount();

          return {
            id: msg.id,
            result: {
              enabled: this.swarmEnabled,
              totalTasks: tasks.length,
              pendingTasks: tasks.filter(t => t.status === 'PENDING').length,
              runningTasks: tasks.filter(t => t.status === 'RUNNING').length,
              completedTasks: tasks.filter(t => t.status === 'COMPLETED').length,
              activeWorkerCount: workers.length,
              eligibleWorkerCount: eligibleWorkers.length,
              connectedWorkers: workers.length,
              discoveredWorkerCount: discovered.length,
              trustedWorkerCount: trusted.length,
              webSocketConnectionCount: socketCount
            }
          };
        }

        case 'listDiscoveredWorkers': {
          const discovered = this.transportServer.getDiscoveredWorkers();
          return { id: msg.id, result: discovered };
        }

        case 'listConnectedWorkers': {
          const workers = this.workerManager.listWorkers();
          return { id: msg.id, result: workers };
        }

        case 'listTrustedWorkers': {
          const trusted = this.pairingService.listTrustedWorkers();
          return { id: msg.id, result: trusted };
        }

        case 'initiatePairing': {
          // params: { workerDeviceId }
          const { workerDeviceId } = msg.params || {};
          if (!workerDeviceId) throw new Error('workerDeviceId is required');
          const initiation = this.pairingService.createPairingInitiation(workerDeviceId);
          const sent = this.transportServer.sendPairingRequest(workerDeviceId, initiation);
          if (!sent) {
            throw new Error(`Worker ${workerDeviceId} is not connected to transport server`);
          }
          return { id: msg.id, result: initiation };
        }

        case 'revokeWorker': {
          // params: { deviceId }
          const { deviceId } = msg.params || {};
          if (!deviceId) throw new Error('deviceId is required');
          const success = this.pairingService.revokeWorker(deviceId);
          this.workerManager.unregisterWorker(deviceId);
          return { id: msg.id, result: { success, deviceId } };
        }

        case 'toggleSwarm': {
          // params: { enabled: boolean }
          if (typeof msg.params?.enabled === 'boolean') {
            this.swarmEnabled = msg.params.enabled;
          } else {
            this.swarmEnabled = !this.swarmEnabled;
          }
          return { id: msg.id, result: { enabled: this.swarmEnabled } };
        }

        case 'listTasks': {
          const tasks = this.taskStore.listTasks();
          return { id: msg.id, result: tasks };
        }

        case 'submitTask': {
          const { task } = msg.params || {};
          if (!task || !task.id) throw new Error('Invalid task definition');
          const created = this.taskStore.createTask(task);
          return { id: msg.id, result: created };
        }

        case 'evaluateWorkload': {
          const { workload } = (msg.params || {}) as { workload?: WorkloadDescriptor };
          if (!workload || !workload.computation || !workload.computation.kernelId) {
            throw new Error('Invalid Workload IR: computation.kernelId is required');
          }
          if (!workload.data || typeof workload.data.totalPayloadBytes !== 'number') {
            throw new Error('Invalid Workload IR: data.totalPayloadBytes is required');
          }

          if (!this.swarmEnabled) {
            return {
              id: msg.id,
              result: {
                decision: 'LOCAL',
                estimatedLocalTimeMs: 0,
                estimatedSwarmTimeMs: Infinity,
                estimatedGain: 0,
                reason: 'SwarmX distribution is disabled by user',
                selectedWorkerCount: 0
              }
            };
          }

          const connectedWorkers = this.workerManager.listWorkers().map(w => ({
            deviceId: w.deviceId,
            capabilityProfile: w.capabilityProfile,
            telemetry: w.latestTelemetry
          }));

          const decision = this.decisionEngine.evaluate(workload, connectedWorkers);
          return { id: msg.id, result: decision };
        }

        case 'executeWorkload': {
          const { workload, forceSwarm } = (msg.params || {}) as { workload?: WorkloadDescriptor; forceSwarm?: boolean };
          if (!workload || !workload.computation || !workload.computation.kernelId) {
            throw new Error('Invalid Workload IR: computation.kernelId is required');
          }

          if (!this.swarmEnabled) {
            return {
              id: msg.id,
              result: { status: 'LOCAL_FALLBACK', reason: 'SwarmX distribution is disabled' }
            };
          }

          // 1. Run deterministic decision gate
          const connectedWorkers = this.workerManager.listWorkers().map(w => ({
            deviceId: w.deviceId,
            capabilityProfile: w.capabilityProfile,
            telemetry: w.latestTelemetry
          }));

          const decision = this.decisionEngine.evaluate(workload, connectedWorkers);

          if (forceSwarm) {
            const eligibleWorkers = this.workerManager.listWorkers().filter(w => w.isEligible);
            if (eligibleWorkers.length === 0) {
              return {
                id: msg.id,
                result: {
                  status: 'FAILED',
                  reason: 'No eligible remote worker available in cluster for forced swarm execution'
                }
              };
            }
            Logger.execution(`Demo forced distributed execution across ${eligibleWorkers.length} remote worker(s)`);
          } else if (decision.decision !== 'SWARM') {
            return {
              id: msg.id,
              result: {
                status: 'LOCAL_FALLBACK',
                reason: decision.reason,
                decisionDetails: decision
              }
            };
          }

          // 2. Create Task in TaskStore
          let taskId = workload.workloadId || `wkl-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          if (this.taskStore.getTask(taskId)) {
            taskId = `${taskId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          }
          const task = this.taskStore.createTask({
            id: taskId,
            inputRef: workload.data.locator?.uri || 'inline_payload',
            computationDescriptor: JSON.stringify({
              kernelId: workload.computation.kernelId,
              parameters: workload.computation.parameters || {}
            }),
            requiredResources: { minCpuCores: 1, minRamMb: 64 },
            dependencies: [],
            executionConstraints: (workload.computation.parameters as any) || {},
            resultDestination: 'memory',
            status: TaskStatus.PENDING
          });

          // 3. Schedule Task via ScoredScheduler
          const scheduleResult = this.scheduler
            ? this.scheduler.scheduleTask(task, this.workerManager.listWorkers(), this.taskStore)
            : { status: 'NO_ELIGIBLE_WORKER', selectedWorker: undefined };

          if (scheduleResult.status !== 'ASSIGNED' || !scheduleResult.selectedWorker) {
            return {
              id: msg.id,
              result: {
                status: forceSwarm ? 'FAILED' : 'LOCAL_FALLBACK',
                reason: `Scheduler could not place task (${scheduleResult.status})`
              }
            };
          }

          const workerId = scheduleResult.selectedWorker.deviceId;
          Logger.execution(`Selected remote worker: ${workerId} (${scheduleResult.selectedWorker.capabilityProfile?.deviceName || 'Worker'})`);
          this.taskStore.assignTask(task.id, workerId, 30000);

          // 4. Await completion from WorkloadPipeline with timeout
          const completionPromise = new Promise<any>((resolve) => {
            const timeoutTimer = setTimeout(() => {
              resolve({ status: 'TIMEOUT', error: 'Workload execution timed out after 30s' });
            }, 30000);

            if (this.workloadPipeline) {
              this.workloadPipeline.onTaskFinished(task.id, (res) => {
                clearTimeout(timeoutTimer);
                resolve({
                  status: res.success ? 'COMPLETED' : 'FAILED',
                  taskId: task.id,
                  outputData: res.task.resultDestination,
                  validationDetails: res.validationDetails,
                  error: res.error
                });
              });
            } else {
              clearTimeout(timeoutTimer);
              resolve({ status: 'COMPLETED', taskId: task.id, outputData: '' });
            }
          });

          // 5. Dispatch via TransportServer
          Logger.execution(`Dispatching task: ${task.id}`);
          Logger.execution(`Remote execution started: ${workerId}`);
          const sent = this.transportServer.sendExecuteTask(
            workerId,
            task,
            workload.data.payloadBase64,
            workload.data.itemCount
          );

          if (!sent) {
            this.taskStore.recordTaskFailure(task.id, workerId, 'TRANSPORT_SEND_FAILED', {});
            return {
              id: msg.id,
              result: {
                status: forceSwarm ? 'FAILED' : 'LOCAL_FALLBACK',
                reason: 'Failed to dispatch to worker transport'
              }
            };
          }

          const executionResult = await completionPromise;
          if (executionResult.status === 'COMPLETED') {
            Logger.execution(`Remote execution completed: ${workerId}`);
            Logger.validation(`Remote result passed pixel validation for task ${task.id}`);
            return {
              id: msg.id,
              result: {
                status: 'COMPLETED',
                taskId: task.id,
                outputData: executionResult.outputData,
                workerId
              }
            };
          } else {
            return {
              id: msg.id,
              result: {
                status: forceSwarm ? 'FAILED' : 'LOCAL_FALLBACK',
                reason: executionResult.error || 'Worker execution failed',
                details: executionResult
              }
            };
          }
        }

        case 'getWorkloadProgress': {
          const { workloadId } = msg.params || {};
          if (!workloadId) throw new Error('workloadId is required');
          const progress = this.workloadPipeline ? this.workloadPipeline.getWorkloadProgress(workloadId) : undefined;
          return { id: msg.id, result: progress || { workloadId, status: 'NOT_FOUND' } };
        }

        case 'cancelWorkload': {
          const { workloadId } = msg.params || {};
          if (!workloadId) throw new Error('workloadId is required');
          const cancelled = this.workloadPipeline ? this.workloadPipeline.cancelWorkload(workloadId) : false;
          return { id: msg.id, result: { success: cancelled, workloadId } };
        }

        case 'listKernels': {
          const registry = KernelRegistry.getInstance();
          return { id: msg.id, result: registry.listKernels() };
        }

        default:
          return { id: msg.id, error: `Unknown method: ${msg.method}` };
      }
    } catch (err: any) {
      return { id: msg.id, error: err.message };
    }
  }

  public async stop(): Promise<void> {
    // Terminate all active client connections immediately
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch (e) {}
    }
    this.activeSockets.clear();

    await new Promise<void>((resolve) => {
      if (this.server) {
        const timeout = setTimeout(() => {
          resolve();
        }, 1000);

        this.server.close(() => {
          clearTimeout(timeout);
          if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
            try {
              fs.unlinkSync(this.socketPath);
            } catch (e) {}
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
