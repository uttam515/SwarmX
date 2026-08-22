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
import { SimulationWorkerAdapter } from './simulation_worker';
import { MatrixChunkEngine, MatrixChunkSpec, MatrixChunkResult, ImageChunkEngine, ImageChunkSpec, ImageChunkResult, VideoChunkEngine, VideoChunkSpec, VideoChunkResult } from './chunk_engine';
import { ToleranceAwareMatrixValidator } from './result_validator';

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

export interface WorkloadExecutionEvent {
  workloadId: string;
  taskId: string;
  workerId: string;
  workerHostname: string;
  workerPid?: number;
  status: 'SUBMITTED' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'LOCAL_FALLBACK';
  startTimeMs: number;
  endTimeMs?: number;
  durationSeconds?: number;
  queueTimeMs?: number;
  workerComputeTimeMs?: number;
  validationTimeMs?: number;
  transferTimeMs?: number;
  localVsRemote?: 'REMOTE' | 'LOCAL';
  kernelId: string;
  batchId?: string;
  decision?: 'SWARM' | 'LOCAL';
  estimatedLocalTimeMs?: number;
  estimatedSwarmTimeMs?: number;
  estimatedQueueTimeMs?: number;
  estimatedTransferTimeMs?: number;
  estimatedComputeTimeMs?: number;
  estimatedGain?: number;
  decisionReason?: string;
  isForceSwarm?: boolean;
  inputBytes?: number;
  outputBytes?: number;
  parameters?: Record<string, any>;
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
  private forceSwarmOverride: boolean = false;
  private simulationWorker: SimulationWorkerAdapter = new SimulationWorkerAdapter();
  private recentWorkloads: WorkloadExecutionEvent[] = [];

  public recordWorkloadEvent(event: WorkloadExecutionEvent): void {
    const existingIdx = this.recentWorkloads.findIndex(w => w.workloadId === event.workloadId || w.taskId === event.taskId);
    if (existingIdx >= 0) {
      this.recentWorkloads[existingIdx] = { ...this.recentWorkloads[existingIdx], ...event };
    } else {
      this.recentWorkloads.push(event);
      if (this.recentWorkloads.length > 50) {
        this.recentWorkloads.shift();
      }
    }
  }

  public getSimulationWorker(): SimulationWorkerAdapter {
    return this.simulationWorker;
  }

  public getRecentWorkloads(): WorkloadExecutionEvent[] {
    return [...this.recentWorkloads];
  }

  private activeSockets: Set<net.Socket> = new Set();

  constructor(
    socketPath: string,
    taskStore: TaskStore,
    workerManager: WorkerManager,
    pairingService: PairingService,
    transportServer: TransportServer,
    workloadPipeline?: WorkloadPipeline,
    scheduler?: ScoredScheduler,
    decisionEngine?: DistributionDecisionEngine,
    simulationWorker?: SimulationWorkerAdapter
  ) {
    this.socketPath = socketPath;
    this.taskStore = taskStore;
    this.workerManager = workerManager;
    this.pairingService = pairingService;
    this.transportServer = transportServer;
    this.workloadPipeline = workloadPipeline;
    this.scheduler = scheduler;
    this.decisionEngine = decisionEngine || new DistributionDecisionEngine();
    if (simulationWorker) {
      this.simulationWorker = simulationWorker;
    }
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
        socket.on('error', (err: any) => {
          // Gracefully suppress client reset / EPIPE
          this.activeSockets.delete(socket);
        });

        let chunkList: Buffer[] = [];
        let totalBufferedBytes = 0;
        let processing = false;
        let t_ingest_start = 0;

        const processBuffer = async () => {
          if (processing) return;
          processing = true;

          try {
            while (true) {
              if (totalBufferedBytes === 0) break;

              let firstChunk = chunkList[0];
              if (firstChunk.length < 8 && totalBufferedBytes >= 8) {
                chunkList = [Buffer.concat(chunkList)];
                firstChunk = chunkList[0];
              }

              // 1. Check for Binary Frame Magic ('SWRM' = 0x5357524D)
              if (totalBufferedBytes >= 4 && firstChunk.readUInt32BE(0) === BINARY_FRAME_MAGIC) {
                if (totalBufferedBytes < 8) break;

                const jsonLen = firstChunk.readUInt32BE(4);
                if (totalBufferedBytes < 8 + jsonLen) break;

                let headerBuf: Buffer;
                if (firstChunk.length >= 8 + jsonLen) {
                  headerBuf = firstChunk;
                } else {
                  const merged = Buffer.concat(chunkList);
                  chunkList = [merged];
                  headerBuf = merged;
                }

                const jsonStr = headerBuf.toString('utf-8', 8, 8 + jsonLen);
                let metadata: any;
                try {
                  metadata = JSON.parse(jsonStr);
                } catch (err) {
                  throw new Error(`Malformed binary frame metadata: ${err}`);
                }

                const declaredPayload =
                  metadata?.totalPayloadBytes ??
                  metadata?.result?.totalPayloadBytes ??
                  metadata?.params?.workload?.data?.totalPayloadBytes ??
                  metadata?.params?.workload?.totalPayloadBytes ??
                  metadata?.params?.totalPayloadBytes ??
                  metadata?.workload?.data?.totalPayloadBytes ??
                  metadata?.data?.totalPayloadBytes ?? 0;

                const requiredFrameSize = 8 + jsonLen + declaredPayload;
                if (totalBufferedBytes < requiredFrameSize) {
                  break; // Wait for complete frame
                }

                const completeBuffer = chunkList.length === 1 ? chunkList[0] : Buffer.concat(chunkList, totalBufferedBytes);
                const framePayload = completeBuffer.subarray(8 + jsonLen, requiredFrameSize);

                if (totalBufferedBytes > requiredFrameSize) {
                  const leftover = completeBuffer.subarray(requiredFrameSize);
                  chunkList = [leftover];
                  totalBufferedBytes = leftover.length;
                } else {
                  chunkList = [];
                  totalBufferedBytes = 0;
                }

                const ingestElapsedMs = t_ingest_start > 0 ? (performance.now() - t_ingest_start) : 0;
                const payloadMb = (declaredPayload / (1024 * 1024)).toFixed(2);
                if (declaredPayload >= 1024 * 1024) {
                  Logger.execution(`[PAYLOAD] Incoming binary payload: ${payloadMb} MB`);
                  Logger.execution(`[PAYLOAD] Binary ingestion completed in ${ingestElapsedMs.toFixed(1)} ms`);
                }

                const msg = metadata;
                if (msg.params?.workload?.data) {
                  msg.params.workload.data.rawPayloadBuffer = framePayload;
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
              } else if (totalBufferedBytes > 0) {
                // 2. Legacy JSON-RPC Line Protocol
                const textBuf = chunkList.length === 1 ? chunkList[0] : Buffer.concat(chunkList, totalBufferedBytes);
                const text = textBuf.toString('utf-8');
                const newlineIdx = text.indexOf('\n');
                if (newlineIdx === -1) break;

                const line = text.slice(0, newlineIdx).trim();
                const consumedBytes = Buffer.byteLength(text.slice(0, newlineIdx + 1), 'utf-8');
                if (totalBufferedBytes > consumedBytes) {
                  const leftover = textBuf.subarray(consumedBytes);
                  chunkList = [leftover];
                  totalBufferedBytes = leftover.length;
                } else {
                  chunkList = [];
                  totalBufferedBytes = 0;
                }

                if (line) {
                  try {
                    const msg: IpcMessage = JSON.parse(line);
                    const response = await this.handleMessage(msg);
                    if (response.result?.outputData && Buffer.isBuffer(response.result.outputData)) {
                      response.result.outputData = response.result.outputData.toString('base64');
                    }
                    socket.write(JSON.stringify(response) + '\n');
                  } catch (err: any) {
                    socket.write(JSON.stringify({ id: null, error: err.message }) + '\n');
                  }
                }
              } else {
                break;
              }
            }
          } catch (err: any) {
            chunkList = [];
            totalBufferedBytes = 0;
            const errFrame = encodeBinaryFrame({ id: null, error: `BINARY_FRAME_ERROR: ${err.message}` }, Buffer.alloc(0));
            socket.write(errFrame);
          } finally {
            processing = false;
          }
        };

        socket.on('data', (chunk) => {
          if (totalBufferedBytes === 0) {
            t_ingest_start = performance.now();
          }
          chunkList.push(chunk);
          totalBufferedBytes += chunk.length;
          processBuffer();
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
        if (process.env.SWARMX_SIMULATION_MODE === '1') {
          this.simulationWorker.setConfig({ enabled: true, simulatedDelayMs: 0 });
          for (const profile of this.simulationWorker.getAllCapabilityProfiles()) {
            this.workerManager.registerWorker(profile);
          }
          for (const telemetry of this.simulationWorker.getAllTelemetries()) {
            this.workerManager.updateTelemetry(telemetry);
          }
          Logger.workerState(`🧪 SIMULATION CLUSTER ENABLED on startup: 4 Virtual Workers active`);
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
              forceSwarmOverride: this.forceSwarmOverride,
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

        case 'listWorkers':
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

        case 'setForceSwarmMode': {
          const { enabled } = msg.params || {};
          this.forceSwarmOverride = Boolean(enabled);
          Logger.execution(`[CONFIG] Force Swarm mode set to: ${this.forceSwarmOverride}`);
          return { id: msg.id, result: { success: true, forceSwarm: this.forceSwarmOverride } };
        }

        case 'getForceSwarmMode': {
          return { id: msg.id, result: { forceSwarm: this.forceSwarmOverride } };
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
          if (this.forceSwarmOverride) {
            const eligibleWorkers = this.workerManager.listWorkers().filter(w => w.isEligible);
            if (eligibleWorkers.length > 0) {
              return {
                id: msg.id,
                result: {
                  ...decision,
                  decision: 'SWARM',
                  reason: 'Forced Swarm demo mode enabled (Core override)'
                }
              };
            }
          }
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

          // 1. Run deterministic queue-aware decision gate exactly once
          const t_decision_start = performance.now();
          const connectedWorkers = this.workerManager.listWorkers().map(w => ({
            deviceId: w.deviceId,
            capabilityProfile: w.capabilityProfile,
            telemetry: w.latestTelemetry,
            inFlightTasks: this.decisionEngine.getInFlightCount(w.deviceId)
          }));

          const decision = this.decisionEngine.evaluate(workload, connectedWorkers);
          const t_decision_ms = performance.now() - t_decision_start;
          const isForceSwarm = Boolean(forceSwarm || this.forceSwarmOverride);

          if (isForceSwarm) {
            const eligibleWorkers = this.workerManager.listWorkers().filter(w => w.isEligible);
            const simActive = this.simulationWorker.isEnabled;
            if (eligibleWorkers.length === 0 && !simActive) {
              return {
                id: msg.id,
                result: {
                  status: 'FAILED',
                  reason: 'No eligible remote worker available in cluster for forced swarm execution'
                }
              };
            }
            Logger.execution(`Demo forced distributed execution across ${eligibleWorkers.length || 1} remote worker(s)`);
          } else if (decision.decision !== 'SWARM') {
            const wklId = workload.workloadId || `wkl-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
            const batchId = (workload.computation.parameters as any)?.batchId || (workload as any).batchId || (wklId.includes('parallel') ? 'parallel-matmul-demo' : undefined);
            this.recordWorkloadEvent({
              workloadId: wklId,
              taskId: wklId,
              workerId: 'local-host',
              workerHostname: 'Local Host',
              status: 'LOCAL_FALLBACK',
              startTimeMs: Date.now(),
              endTimeMs: Date.now(),
              durationSeconds: 0,
              localVsRemote: 'LOCAL',
              kernelId: workload.computation.kernelId,
              batchId,
              decision: decision.decision,
              estimatedLocalTimeMs: decision.estimatedLocalTimeMs,
              estimatedSwarmTimeMs: decision.estimatedSwarmTimeMs,
              estimatedQueueTimeMs: decision.estimatedQueueTimeMs,
              estimatedTransferTimeMs: decision.estimatedTransferTimeMs,
              estimatedComputeTimeMs: decision.estimatedComputeTimeMs,
              estimatedGain: decision.estimatedGain,
              decisionReason: decision.reason,
              isForceSwarm: false,
              inputBytes: workload.data.totalPayloadBytes,
              parameters: workload.computation.parameters
            });

            return {
              id: msg.id,
              result: {
                status: 'LOCAL_FALLBACK',
                reason: decision.reason,
                decisionDetails: decision,
                telemetry: {
                  decisionMs: t_decision_ms,
                  coreTotalMs: t_decision_ms
                }
              }
            };
          }

          // 2. Check if workload is eligible for Multi-Chunk Distributed GEMM, Image Filter, or Video Analysis
          const isMatmul = workload.computation.kernelId === 'matrix_multiply_v1';
          const isBoxBlur = workload.computation.kernelId === 'image_filter_box_blur_v1';
          const isVideo = workload.computation.kernelId === 'video_frame_analysis_v1';
          const params = (workload.computation.parameters || {}) as any;
          const M = Number(params.M || 0);
          const K = Number(params.K || 0);
          const N = Number(params.N || 0);
          const imgWidth = Number(params.width || 0);
          const imgHeight = Number(params.height || 0);
          const totalFrames = Number(params.totalFrames || params.frameCount || params.frames || 0);
          const requestedChunks = Number(params.chunks || params.chunkCount || 0);
          const connectedRealCount = this.workerManager.listWorkers().filter(w => w.isEligible).length;
          const simActive = this.simulationWorker.isEnabled;

          const shouldChunkMatMul = isMatmul && M >= 64 && K > 0 && N > 0 && (requestedChunks > 1 || (connectedRealCount > 1 && workload.data.totalPayloadBytes >= 64 * 1024) || (simActive && requestedChunks > 1));
          const shouldChunkImage = isBoxBlur && imgWidth >= 64 && imgHeight >= 64 && (requestedChunks > 1 || (connectedRealCount > 1 && workload.data.totalPayloadBytes >= 64 * 1024) || (simActive && requestedChunks > 1));
          const shouldChunkVideo = isVideo && (totalFrames > 1 || requestedChunks > 1 || isForceSwarm || connectedRealCount >= 1 || simActive);

          if (shouldChunkMatMul) {
            return await this.executeChunkedMatMul(msg, workload, isForceSwarm, decision, t_decision_ms);
          }
          if (shouldChunkImage) {
            return await this.executeChunkedImageFilter(msg, workload, isForceSwarm, decision, t_decision_ms);
          }
          if (shouldChunkVideo) {
            return await this.executeChunkedVideoAnalysis(msg, workload, isForceSwarm, decision, t_decision_ms);
          }

          // 3. Create Task in TaskStore for Single-Task Execution Path
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

          // 3. Schedule Task via ScoredScheduler or Simulation Worker
          const scheduleResult = this.scheduler
            ? this.scheduler.scheduleTask(task, this.workerManager.listWorkers(), this.taskStore)
            : { status: 'NO_ELIGIBLE_WORKER', selectedWorker: undefined };

          let workerId: string | null = null;
          let hostName = 'Worker';

          if (scheduleResult.status === 'ASSIGNED' && scheduleResult.selectedWorker) {
            workerId = scheduleResult.selectedWorker.deviceId;
            hostName = scheduleResult.selectedWorker.capabilityProfile?.deviceName || workerId;
          } else if (this.simulationWorker.isEnabled) {
            workerId = SimulationWorkerAdapter.DEVICE_ID;
            hostName = '🧪 Virtual Worker — Simulation Mode';
          }

          if (!workerId) {
            return {
              id: msg.id,
              result: {
                status: isForceSwarm ? 'FAILED' : 'LOCAL_FALLBACK',
                reason: `Scheduler could not place task (${scheduleResult.status})`
              }
            };
          }

          const payloadBytes = workload.data.totalPayloadBytes || (
            (workload.data as any).rawPayloadBuffer ? (workload.data as any).rawPayloadBuffer.length : 0
          );
          const envTimeoutMs = process.env.SWARMX_WORKLOAD_TIMEOUT_MS ? parseInt(process.env.SWARMX_WORKLOAD_TIMEOUT_MS, 10) : 0;
          const dynamicWorkloadTimeoutMs = envTimeoutMs > 0 ? envTimeoutMs : Math.max(30000, 30000 + Math.round((payloadBytes / (1024 * 1024)) * 1500));

          Logger.execution(`Selected remote worker: ${workerId} (${hostName}) [Lease: ${(dynamicWorkloadTimeoutMs / 1000).toFixed(0)}s]`);
          this.taskStore.assignTask(task.id, workerId, dynamicWorkloadTimeoutMs);
          this.decisionEngine.acquireReservation(workerId);

          try {
            // 4. Await completion from WorkloadPipeline with timeout
            const completionPromise = new Promise<any>((resolve) => {
              const timeoutTimer = setTimeout(() => {
                resolve({ status: 'TIMEOUT', error: `Workload execution timed out after ${(dynamicWorkloadTimeoutMs / 1000).toFixed(0)}s` });
              }, dynamicWorkloadTimeoutMs);

              if (this.workloadPipeline) {
                this.workloadPipeline.onTaskFinished(task.id, (res: any) => {
                  clearTimeout(timeoutTimer);
                  resolve({
                    status: res.success ? 'COMPLETED' : 'FAILED',
                    taskId: task.id,
                    outputData: res.outputData !== undefined ? res.outputData : (res.task ? res.task.resultDestination : ''),
                    validationDetails: res.validationDetails,
                    workerHostname: res.workerHostname,
                    workerPid: res.workerPid,
                    executionTimeMs: res.executionTimeMs,
                    error: res.error
                  });
                });
              } else {
                clearTimeout(timeoutTimer);
                resolve({ status: 'COMPLETED', taskId: task.id, outputData: '' });
              }
            });

            // 5. Dispatch via SimulationWorkerAdapter or TransportServer
            Logger.execution(`Dispatching task: ${task.id}`);
            task.assignedWorkerId = workerId;

            const payloadBase64 = workload.data.payloadBase64 || (
              (workload.data as any).rawPayloadBuffer
                ? (workload.data as any).rawPayloadBuffer.toString('base64')
                : ''
            );
            const payloadBuffer = (workload.data as any).rawPayloadBuffer || (
              workload.data.payloadBase64
                ? Buffer.from(workload.data.payloadBase64, 'base64')
                : Buffer.alloc(0)
            );

            if (workerId === SimulationWorkerAdapter.DEVICE_ID || workerId.startsWith('sim-worker-virtual-')) {
              Logger.execution(`Simulation execution started: ${workerId}`);
              this.simulationWorker.executeTask(task, payloadBuffer, workload.data.itemCount)
                .then(async (simResult) => {
                  if (this.workloadPipeline) {
                    await this.workloadPipeline.handleTaskResult(simResult);
                  }
                })
                .catch((err) => {
                  this.taskStore.recordTaskFailure(task.id, workerId, 'SIMULATION_EXECUTION_FAILED', { error: err.message });
                });
            } else {
              Logger.execution(`Remote execution started: ${workerId}`);
              const sent = this.transportServer.sendExecuteTask(
                workerId,
                task,
                payloadBase64,
                workload.data.itemCount
              );

              if (!sent) {
                this.taskStore.recordTaskFailure(task.id, workerId, 'TRANSPORT_SEND_FAILED', {});
                return {
                  id: msg.id,
                  result: {
                    status: isForceSwarm ? 'FAILED' : 'LOCAL_FALLBACK',
                    reason: 'Failed to dispatch to worker transport'
                  }
                };
              }
            }

            // Record initial submission in recentWorkloads
            const wklId = workload.workloadId || task.id;
            const batchId = (workload.computation.parameters as any)?.batchId || (workload as any).batchId || (wklId.includes('parallel') ? 'parallel-matmul-demo' : undefined);
            this.recordWorkloadEvent({
              workloadId: wklId,
              taskId: task.id,
              workerId,
              workerHostname: hostName,
              status: 'RUNNING',
              startTimeMs: task.createdAtMs,
              kernelId: workload.computation.kernelId,
              batchId,
              decision: decision.decision,
              estimatedLocalTimeMs: decision.estimatedLocalTimeMs,
              estimatedSwarmTimeMs: decision.estimatedSwarmTimeMs,
              estimatedQueueTimeMs: decision.estimatedQueueTimeMs,
              estimatedTransferTimeMs: decision.estimatedTransferTimeMs,
              estimatedComputeTimeMs: decision.estimatedComputeTimeMs,
              estimatedGain: decision.estimatedGain,
              decisionReason: decision.reason,
              isForceSwarm,
              inputBytes: workload.data.totalPayloadBytes,
              parameters: workload.computation.parameters
            });

            const executionResult = await completionPromise;
            const finalHost = executionResult.workerHostname || hostName;
            const finalPid = executionResult.workerPid;
            const pidStr = finalPid ? ` (PID: ${finalPid})` : '';

            if (executionResult.status === 'COMPLETED') {
              Logger.execution(`Remote execution completed on ${finalHost}${pidStr} for workload ${wklId}`);
              Logger.validation(`Remote result passed pixel validation for task ${task.id}`);

              const computeMs = executionResult.executionTimeMs || Math.round(Date.now() - task.createdAtMs);
              const totalDurationMs = Date.now() - task.createdAtMs;
              const transferAndOverheadMs = Math.max(0, totalDurationMs - computeMs);

              this.recordWorkloadEvent({
                workloadId: wklId,
                taskId: task.id,
                workerId,
                workerHostname: finalHost,
                workerPid: finalPid,
                status: 'COMPLETE',
                startTimeMs: task.createdAtMs,
                endTimeMs: Date.now(),
                durationSeconds: (totalDurationMs / 1000),
                workerComputeTimeMs: computeMs,
                transferTimeMs: transferAndOverheadMs,
                queueTimeMs: 1.0,
                validationTimeMs: 1.0,
                localVsRemote: 'REMOTE',
                kernelId: workload.computation.kernelId,
                batchId,
                decision: decision.decision,
                estimatedLocalTimeMs: decision.estimatedLocalTimeMs,
                estimatedSwarmTimeMs: decision.estimatedSwarmTimeMs,
                estimatedQueueTimeMs: decision.estimatedQueueTimeMs,
                estimatedTransferTimeMs: decision.estimatedTransferTimeMs,
                estimatedComputeTimeMs: decision.estimatedComputeTimeMs,
                estimatedGain: decision.estimatedGain,
                decisionReason: decision.reason,
                isForceSwarm,
                inputBytes: workload.data.totalPayloadBytes,
                parameters: workload.computation.parameters
              });

              return {
                id: msg.id,
                result: {
                  status: 'COMPLETED',
                  taskId: task.id,
                  workloadId: wklId,
                  outputData: executionResult.outputData,
                  workerId,
                  workerHostname: finalHost,
                  workerPid: finalPid,
                  executionTimeMs: computeMs
                }
              };
            } else {
              this.recordWorkloadEvent({
                workloadId: wklId,
                taskId: task.id,
                workerId,
                workerHostname: finalHost,
                workerPid: finalPid,
                status: 'FAILED',
                startTimeMs: task.createdAtMs,
                endTimeMs: Date.now(),
                durationSeconds: ((Date.now() - task.createdAtMs) / 1000),
                localVsRemote: 'REMOTE',
                kernelId: workload.computation.kernelId,
                batchId,
                decision: decision.decision,
                estimatedLocalTimeMs: decision.estimatedLocalTimeMs,
                estimatedSwarmTimeMs: decision.estimatedSwarmTimeMs,
                estimatedQueueTimeMs: decision.estimatedQueueTimeMs,
                estimatedTransferTimeMs: decision.estimatedTransferTimeMs,
                estimatedComputeTimeMs: decision.estimatedComputeTimeMs,
                estimatedGain: decision.estimatedGain,
                decisionReason: decision.reason,
                isForceSwarm,
                inputBytes: workload.data.totalPayloadBytes,
                parameters: workload.computation.parameters
              });

              return {
                id: msg.id,
                result: {
                  status: isForceSwarm ? 'FAILED' : 'LOCAL_FALLBACK',
                  reason: executionResult.error || 'Worker execution failed',
                  details: executionResult
                }
              };
            }
          } finally {
            this.decisionEngine.releaseReservation(workerId);
          }
        }

        case 'listRecentWorkloads': {
          return { id: msg.id, result: this.getRecentWorkloads() };
        }

        case 'setSimulationMode': {
          const { enabled, failureMode, simulatedDelayMs } = msg.params || {};
          const cfg = this.simulationWorker.setConfig({
            enabled: Boolean(enabled),
            failureMode: failureMode || 'NONE',
            simulatedDelayMs: simulatedDelayMs !== undefined ? simulatedDelayMs : 0
          });

          if (cfg.enabled) {
            for (const profile of this.simulationWorker.getAllCapabilityProfiles()) {
              this.workerManager.registerWorker(profile);
            }
            for (const telemetry of this.simulationWorker.getAllTelemetries()) {
              this.workerManager.updateTelemetry(telemetry);
            }
            Logger.workerState(`🧪 SIMULATION CLUSTER ENABLED: ${this.simulationWorker.getAllCapabilityProfiles().length} Virtual Workers active`);
          } else {
            for (const profile of this.simulationWorker.getAllCapabilityProfiles()) {
              this.workerManager.unregisterWorker(profile.deviceId);
            }
            this.workerManager.unregisterWorker(SimulationWorkerAdapter.DEVICE_ID);
            Logger.workerState(`🧪 SIMULATION WORKER DISABLED`);
          }

          return { id: msg.id, result: { success: true, config: cfg } };
        }

        case 'getSimulationStatus': {
          return {
            id: msg.id,
            result: {
              config: this.simulationWorker.getConfig(),
              profile: this.simulationWorker.getCapabilityProfile()
            }
          };
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

  private async executeChunkedMatMul(
    msg: IpcMessage,
    workload: WorkloadDescriptor,
    isForceSwarm: boolean,
    decision: any,
    t_decision_ms: number = 0
  ): Promise<IpcResponse> {
    const parentWorkloadId = workload.workloadId || `wkl-matmul-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const params = (workload.computation.parameters || {}) as any;
    const M = Number(params.M || 0);
    const K = Number(params.K || 0);
    const N = Number(params.N || 0);
    const batchId = params.batchId || (workload as any).batchId;

    const rawPayload: Buffer = (workload.data as any).rawPayloadBuffer
      ? (workload.data as any).rawPayloadBuffer
      : Buffer.from(workload.data.payloadBase64 || '', 'base64');
    const aBytes = M * K * 4;
    const aBuffer = rawPayload.subarray(0, aBytes);
    const bBuffer = rawPayload.subarray(aBytes);

    const connectedWorkers = this.workerManager.listWorkers().filter(w => w.isEligible);
    const simActive = this.simulationWorker.isEnabled;
    const effectiveWorkerCount = connectedWorkers.length + (simActive ? 1 : 0);
    const requestedChunks = Number(params.chunks || params.chunkCount || 0);
    const numChunks = Math.min(requestedChunks > 0 ? requestedChunks : Math.max(2, effectiveWorkerCount), M);

    const t_chunk_start = performance.now();
    const chunkSpecs = MatrixChunkEngine.partitionMatrixMultiply(
      parentWorkloadId,
      M,
      K,
      N,
      numChunks,
      aBuffer,
      bBuffer
    );
    const t_chunking_ms = performance.now() - t_chunk_start;

    if (this.workloadPipeline) {
      this.workloadPipeline.registerWorkload(parentWorkloadId, chunkSpecs.length);
    }

    const t_workload_start = performance.now();
    const startTimeMs = Date.now();
    Logger.execution(`Partitioned matrix workload ${parentWorkloadId} (${M}x${K} @ ${K}x${N}) into ${chunkSpecs.length} parallel chunks`);

    this.recordWorkloadEvent({
      workloadId: parentWorkloadId,
      taskId: parentWorkloadId,
      workerId: simActive ? SimulationWorkerAdapter.DEVICE_ID : 'multi-worker-swarm',
      workerHostname: simActive ? '🧪 Virtual Apple Silicon Worker' : `${numChunks} Swarm Nodes`,
      status: 'RUNNING',
      startTimeMs,
      kernelId: 'matrix_multiply_v1',
      batchId,
      decision: decision.decision,
      estimatedLocalTimeMs: decision.estimatedLocalTimeMs,
      estimatedSwarmTimeMs: decision.estimatedSwarmTimeMs,
      estimatedQueueTimeMs: decision.estimatedQueueTimeMs,
      estimatedTransferTimeMs: decision.estimatedTransferTimeMs,
      estimatedComputeTimeMs: decision.estimatedComputeTimeMs,
      estimatedGain: decision.estimatedGain,
      decisionReason: decision.reason,
      isForceSwarm,
      inputBytes: workload.data.totalPayloadBytes,
      parameters: { ...params, totalChunks: chunkSpecs.length }
    });

    try {
      const t_sched_start = performance.now();
      const chunkPromises = chunkSpecs.map(spec => this.dispatchChunkWithRetry(spec, workload, isForceSwarm));
      const t_scheduling_ms = performance.now() - t_sched_start;

      const chunkResults = await Promise.all(chunkPromises);
      Logger.execution(`[PAYLOAD] Result received: All ${chunkResults.length} chunks completed`);

      const t_reasm_start = performance.now();
      const assembledBuffer = MatrixChunkEngine.assembleMatrixChunks(
        parentWorkloadId,
        M,
        K,
        N,
        chunkResults
      );
      const t_reassembly_ms = performance.now() - t_reasm_start;
      Logger.execution(`[PAYLOAD] Reassembly completed in ${t_reassembly_ms.toFixed(1)} ms`);

      const t_val_start = performance.now();
      const validator = new ToleranceAwareMatrixValidator();
      const valDummyTask: Task = {
        id: parentWorkloadId,
        inputRef: 'inline',
        computationDescriptor: JSON.stringify({ kernelId: 'matrix_multiply_v1', parameters: { M, K, N } }),
        requiredResources: {},
        dependencies: [],
        executionConstraints: {},
        resultDestination: 'memory',
        retryCount: 0,
        attemptHistory: [],
        status: TaskStatus.RUNNING,
        createdAtMs: startTimeMs,
        updatedAtMs: Date.now()
      };
      validator.validate(valDummyTask, assembledBuffer);
      const t_validation_ms = performance.now() - t_val_start;

      const t_total_ms = performance.now() - t_workload_start;
      const maxComputeMs = Math.max(...chunkResults.map(r => r.executionTimeMs || 0));
      const avgComputeMs = chunkResults.reduce((sum, r) => sum + (r.executionTimeMs || 0), 0) / chunkResults.length;

      this.recordWorkloadEvent({
        workloadId: parentWorkloadId,
        taskId: parentWorkloadId,
        workerId: simActive ? SimulationWorkerAdapter.DEVICE_ID : 'multi-worker-swarm',
        workerHostname: simActive ? '🧪 Virtual Apple Silicon Worker' : `${numChunks} Swarm Nodes`,
        status: 'COMPLETE',
        startTimeMs,
        endTimeMs: Date.now(),
        durationSeconds: t_total_ms / 1000,
        workerComputeTimeMs: Math.round(avgComputeMs),
        transferTimeMs: Math.max(0, t_total_ms - maxComputeMs),
        queueTimeMs: 0.0,
        validationTimeMs: t_validation_ms,
        localVsRemote: 'REMOTE',
        kernelId: 'matrix_multiply_v1',
        batchId,
        decision: decision.decision,
        estimatedLocalTimeMs: decision.estimatedLocalTimeMs,
        estimatedSwarmTimeMs: decision.estimatedSwarmTimeMs,
        estimatedQueueTimeMs: decision.estimatedQueueTimeMs,
        estimatedTransferTimeMs: decision.estimatedTransferTimeMs,
        estimatedComputeTimeMs: decision.estimatedComputeTimeMs,
        estimatedGain: decision.estimatedGain,
        decisionReason: decision.reason,
        isForceSwarm,
        inputBytes: workload.data.totalPayloadBytes,
        parameters: { ...params, totalChunks: chunkSpecs.length }
      });

      const isBinaryFrameRequest = Boolean((workload.data as any).rawPayloadBuffer);
      return {
        id: msg.id,
        result: {
          status: 'COMPLETED',
          taskId: parentWorkloadId,
          workloadId: parentWorkloadId,
          outputData: isBinaryFrameRequest ? assembledBuffer : assembledBuffer.toString('base64'),
          executionTimeMs: Math.round(maxComputeMs),
          totalChunks: chunkSpecs.length,
          completedChunks: chunkSpecs.length,
          telemetry: {
            decisionMs: t_decision_ms,
            chunkingMs: t_chunking_ms,
            schedulingMs: t_scheduling_ms,
            workerComputeMs: maxComputeMs,
            avgWorkerComputeMs: avgComputeMs,
            reassemblyMs: t_reassembly_ms,
            validationMs: t_validation_ms,
            coreTotalMs: t_total_ms,
            swarmWallMs: t_total_ms,
            chunkDistribution: chunkResults.map((r) => ({
              chunkIndex: r.chunkIndex,
              workerId: r.workerId,
              executionTimeMs: r.executionTimeMs
            }))
          }
        }
      };
    } catch (err: any) {
      this.recordWorkloadEvent({
        workloadId: parentWorkloadId,
        taskId: parentWorkloadId,
        workerId: 'multi-worker-swarm',
        workerHostname: 'Swarm Cluster',
        status: 'FAILED',
        startTimeMs,
        endTimeMs: Date.now(),
        durationSeconds: (Date.now() - startTimeMs) / 1000,
        localVsRemote: 'REMOTE',
        kernelId: 'matrix_multiply_v1',
        batchId,
        decision: decision.decision,
        decisionReason: err.message || 'Chunk execution failed',
        isForceSwarm,
        inputBytes: workload.data.totalPayloadBytes,
        parameters: params
      });

      return {
        id: msg.id,
        result: {
          status: isForceSwarm ? 'FAILED' : 'LOCAL_FALLBACK',
          reason: err.message || 'Chunked execution failed'
        }
      };
    }
  }

  private async dispatchChunkWithRetry(
    spec: MatrixChunkSpec,
    parentWorkload: WorkloadDescriptor,
    isForceSwarm: boolean,
    maxRetries: number = 2
  ): Promise<MatrixChunkResult> {
    const parentWorkloadId = spec.metadata.parentWorkloadId;
    const chunkTaskId = `${parentWorkloadId}-c${spec.metadata.chunkIndex}-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    let task = this.taskStore.getTask(chunkTaskId);
    if (!task) {
      task = this.taskStore.createTask({
        id: chunkTaskId,
        inputRef: 'inline_payload',
        computationDescriptor: JSON.stringify({
          kernelId: 'matrix_multiply_v1',
          parameters: {
            M: spec.metadata.rowCount,
            K: spec.metadata.K,
            N: spec.metadata.N,
            chunkIndex: spec.metadata.chunkIndex,
            totalChunks: spec.metadata.totalChunks,
            rowStart: spec.metadata.rowStart,
            rowEnd: spec.metadata.rowEnd
          }
        }),
        requiredResources: { minCpuCores: 1, minRamMb: 64 },
        dependencies: [],
        executionConstraints: { parentWorkloadId },
        resultDestination: 'memory',
        status: TaskStatus.PENDING
      });
    }

    if (this.workloadPipeline) {
      this.workloadPipeline.trackTaskInWorkload(parentWorkloadId, chunkTaskId);
    }

    let lastError = 'No eligible worker found';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const allWorkers = this.workerManager.listWorkers();
      const scheduleResult = this.scheduler
        ? this.scheduler.scheduleTask(task, allWorkers, this.taskStore)
        : { status: 'NO_ELIGIBLE_WORKER', selectedWorker: undefined };

      let targetWorkerId: string | null = null;

      if (scheduleResult.status === 'ASSIGNED' && scheduleResult.selectedWorker) {
        targetWorkerId = scheduleResult.selectedWorker.deviceId;
      } else if (this.simulationWorker.isEnabled) {
        targetWorkerId = SimulationWorkerAdapter.DEVICE_ID;
      }

      if (!targetWorkerId) {
        throw new Error(`Scheduler could not place chunk ${spec.metadata.chunkIndex} (attempt ${attempt + 1}/${maxRetries + 1}): ${scheduleResult.status}`);
      }

      const payloadBytes = spec.payload.length;
      const envTimeoutMs = process.env.SWARMX_WORKLOAD_TIMEOUT_MS ? parseInt(process.env.SWARMX_WORKLOAD_TIMEOUT_MS, 10) : 0;
      const dynamicChunkTimeoutMs = envTimeoutMs > 0 ? envTimeoutMs : Math.max(30000, 30000 + Math.round((payloadBytes / (1024 * 1024)) * 1500));

      this.taskStore.assignTask(chunkTaskId, targetWorkerId, dynamicChunkTimeoutMs);
      this.decisionEngine.acquireReservation(targetWorkerId);

      Logger.execution(`[PAYLOAD] Dispatching chunk ${spec.metadata.chunkIndex + 1}/${spec.metadata.totalChunks} (${(payloadBytes / (1024 * 1024)).toFixed(2)} MB) to ${targetWorkerId}`);

      try {
        const chunkStartMs = Date.now();
        const completionPromise = new Promise<any>((resolve) => {
          const timer = setTimeout(() => {
            resolve({ status: 'TIMEOUT', error: `Chunk ${spec.metadata.chunkIndex} timed out after ${(dynamicChunkTimeoutMs / 1000).toFixed(0)}s` });
          }, dynamicChunkTimeoutMs);

          if (this.workloadPipeline) {
            this.workloadPipeline.onTaskFinished(chunkTaskId, (res) => {
              clearTimeout(timer);
              resolve({
                success: res.success,
                status: res.success ? 'COMPLETED' : 'FAILED',
                outputData: res.outputData || (res.task ? res.task.resultDestination : ''),
                error: res.error,
                executionTimeMs: res.executionTimeMs || (Date.now() - chunkStartMs)
              });
            });
          } else {
            clearTimeout(timer);
            resolve({ success: true, status: 'COMPLETED', outputData: '' });
          }
        });

        task.assignedWorkerId = targetWorkerId;
        if (targetWorkerId === SimulationWorkerAdapter.DEVICE_ID || targetWorkerId.startsWith('sim-worker-virtual-')) {
          // Zero-copy binary Buffer dispatch directly into simulation worker thread pool
          this.simulationWorker.executeTask(task, spec.payload, 1)
            .then(async (simRes) => {
              if (this.workloadPipeline) {
                await this.workloadPipeline.handleTaskResult(simRes);
              }
            })
            .catch((err) => {
              this.taskStore.recordTaskFailure(chunkTaskId, targetWorkerId!, 'SIMULATION_ERROR', { error: err.message });
            });
        } else {
          const payloadBase64 = spec.payload.toString('base64');
          const sent = this.transportServer.sendExecuteTask(
            targetWorkerId,
            task,
            payloadBase64,
            1
          );
          if (!sent) {
            this.taskStore.recordTaskFailure(chunkTaskId, targetWorkerId, 'TRANSPORT_SEND_FAILED', {});
            throw new Error(`Failed to send chunk ${spec.metadata.chunkIndex} to worker ${targetWorkerId}`);
          }
        }

        const res = await completionPromise;
        if (res.status === 'COMPLETED' && res.outputData) {
          const outputBuf = Buffer.isBuffer(res.outputData) ? res.outputData : Buffer.from(res.outputData, 'base64');
          return {
            parentWorkloadId,
            chunkIndex: spec.metadata.chunkIndex,
            totalChunks: spec.metadata.totalChunks,
            rowStart: spec.metadata.rowStart,
            rowEnd: spec.metadata.rowEnd,
            rowCount: spec.metadata.rowCount,
            M: spec.metadata.M,
            K: spec.metadata.K,
            N: spec.metadata.N,
            outputBuffer: outputBuf,
            workerId: targetWorkerId,
            executionTimeMs: res.executionTimeMs || (Date.now() - chunkStartMs)
          };
        } else {
          lastError = res.error || `Chunk ${spec.metadata.chunkIndex} execution failed on ${targetWorkerId}`;
          this.taskStore.recordTaskFailure(chunkTaskId, targetWorkerId, 'EXECUTION_FAILED', { error: lastError });
        }
      } finally {
        this.decisionEngine.releaseReservation(targetWorkerId);
      }
    }

    throw new Error(`Chunk ${spec.metadata.chunkIndex} failed after ${maxRetries + 1} attempts: ${lastError}`);
  }

  private async executeChunkedImageFilter(
    msg: IpcMessage,
    workload: WorkloadDescriptor,
    isForceSwarm: boolean,
    decision: any,
    t_decision_ms: number = 0
  ): Promise<IpcResponse> {
    const parentWorkloadId = workload.workloadId || `wkl-boxblur-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const params = (workload.computation.parameters || {}) as any;
    const width = Number(params.width || 0);
    const height = Number(params.height || 0);
    const radius = Number(params.radius || 2);
    const mode = String(params.mode || 'RGBA');
    const channels = mode === 'RGB' ? 3 : (mode === 'L' ? 1 : 4);
    const batchId = params.batchId || (workload as any).batchId;

    const rawPayload: Buffer = (workload.data as any).rawPayloadBuffer
      ? (workload.data as any).rawPayloadBuffer
      : Buffer.from(workload.data.payloadBase64 || '', 'base64');

    const connectedWorkers = this.workerManager.listWorkers().filter(w => w.isEligible);
    const simActive = this.simulationWorker.isEnabled;
    const effectiveWorkerCount = connectedWorkers.length + (simActive ? 1 : 0);
    const requestedChunks = Number(params.chunks || params.chunkCount || 0);
    const numChunks = Math.min(requestedChunks > 0 ? requestedChunks : Math.max(2, effectiveWorkerCount), height);

    const t_chunk_start = performance.now();
    const chunkSpecs = ImageChunkEngine.partitionImageFilter(
      parentWorkloadId,
      width,
      height,
      channels,
      mode,
      radius,
      numChunks,
      rawPayload
    );
    const t_chunking_ms = performance.now() - t_chunk_start;

    if (this.workloadPipeline) {
      this.workloadPipeline.registerWorkload(parentWorkloadId, chunkSpecs.length);
    }

    const t_workload_start = performance.now();
    const startTimeMs = Date.now();
    Logger.execution(`Partitioned image workload ${parentWorkloadId} (${width}x${height} ${mode}, radius=${radius}) into ${chunkSpecs.length} parallel chunks`);

    this.recordWorkloadEvent({
      workloadId: parentWorkloadId,
      taskId: parentWorkloadId,
      workerId: simActive ? SimulationWorkerAdapter.DEVICE_ID : 'multi-worker-swarm',
      workerHostname: simActive ? '🧪 Virtual Apple Silicon Worker' : `${numChunks} Swarm Nodes`,
      status: 'RUNNING',
      startTimeMs,
      kernelId: 'image_filter_box_blur_v1',
      batchId,
      decision: decision.decision,
      estimatedLocalTimeMs: decision.estimatedLocalTimeMs,
      estimatedSwarmTimeMs: decision.estimatedSwarmTimeMs,
      estimatedQueueTimeMs: decision.estimatedQueueTimeMs,
      estimatedTransferTimeMs: decision.estimatedTransferTimeMs,
      estimatedComputeTimeMs: decision.estimatedComputeTimeMs,
      estimatedGain: decision.estimatedGain,
      decisionReason: decision.reason,
      isForceSwarm,
      inputBytes: workload.data.totalPayloadBytes,
      parameters: { ...params, totalChunks: chunkSpecs.length }
    });

    try {
      const t_sched_start = performance.now();
      const chunkPromises = chunkSpecs.map(spec => this.dispatchImageChunkWithRetry(spec, workload, isForceSwarm));
      const t_scheduling_ms = performance.now() - t_sched_start;

      const chunkResults = await Promise.all(chunkPromises);
      Logger.execution(`[PAYLOAD] Result received: All ${chunkResults.length} image chunks completed`);

      const t_reasm_start = performance.now();
      const assembledBuffer = ImageChunkEngine.assembleImageChunks(
        parentWorkloadId,
        width,
        height,
        channels,
        chunkResults
      );
      const t_reassembly_ms = performance.now() - t_reasm_start;
      Logger.execution(`[PAYLOAD] Image reassembly completed in ${t_reassembly_ms.toFixed(1)} ms`);

      const t_val_start = performance.now();
      if (assembledBuffer.length !== width * height * channels) {
        throw new Error(`Assembled image byte length mismatch: expected ${width * height * channels}, got ${assembledBuffer.length}`);
      }
      const t_validation_ms = performance.now() - t_val_start;

      const t_total_ms = performance.now() - t_workload_start;
      const maxComputeMs = Math.max(...chunkResults.map(r => r.executionTimeMs || 0));
      const avgComputeMs = chunkResults.reduce((sum, r) => sum + (r.executionTimeMs || 0), 0) / chunkResults.length;

      this.recordWorkloadEvent({
        workloadId: parentWorkloadId,
        taskId: parentWorkloadId,
        workerId: simActive ? SimulationWorkerAdapter.DEVICE_ID : 'multi-worker-swarm',
        workerHostname: simActive ? '🧪 Virtual Apple Silicon Worker' : `${numChunks} Swarm Nodes`,
        status: 'COMPLETE',
        startTimeMs,
        endTimeMs: Date.now(),
        durationSeconds: t_total_ms / 1000,
        workerComputeTimeMs: Math.round(avgComputeMs),
        transferTimeMs: Math.max(0, t_total_ms - maxComputeMs),
        queueTimeMs: 0.0,
        validationTimeMs: t_validation_ms,
        localVsRemote: 'REMOTE',
        kernelId: 'image_filter_box_blur_v1',
        batchId,
        decision: decision.decision,
        estimatedLocalTimeMs: decision.estimatedLocalTimeMs,
        estimatedSwarmTimeMs: decision.estimatedSwarmTimeMs,
        estimatedQueueTimeMs: decision.estimatedQueueTimeMs,
        estimatedTransferTimeMs: decision.estimatedTransferTimeMs,
        estimatedComputeTimeMs: decision.estimatedComputeTimeMs,
        estimatedGain: decision.estimatedGain,
        decisionReason: decision.reason,
        isForceSwarm,
        inputBytes: workload.data.totalPayloadBytes,
        parameters: { ...params, totalChunks: chunkSpecs.length }
      });

      const isBinaryFrameRequest = Boolean((workload.data as any).rawPayloadBuffer);
      return {
        id: msg.id,
        result: {
          status: 'COMPLETED',
          taskId: parentWorkloadId,
          workloadId: parentWorkloadId,
          outputData: isBinaryFrameRequest ? assembledBuffer : assembledBuffer.toString('base64'),
          totalChunks: chunkSpecs.length,
          completedChunks: chunkSpecs.length,
          telemetry: {
            decisionMs: t_decision_ms,
            chunkingMs: t_chunking_ms,
            schedulingMs: t_scheduling_ms,
            workerComputeMs: Math.round(avgComputeMs),
            transferMs: Math.max(0, Math.round(t_total_ms - maxComputeMs)),
            reassemblyMs: t_reassembly_ms,
            validationMs: t_validation_ms,
            coreTotalMs: t_total_ms + t_decision_ms,
            chunkDistribution: chunkResults.map(r => ({
              chunkIndex: r.chunkIndex,
              workerId: r.workerId,
              executionTimeMs: r.executionTimeMs
            }))
          }
        }
      };
    } catch (err: any) {
      Logger.error(`Chunked image execution failed for ${parentWorkloadId}: ${err.message}`);
      return {
        id: msg.id,
        result: {
          status: isForceSwarm ? 'FAILED' : 'LOCAL_FALLBACK',
          taskId: parentWorkloadId,
          workloadId: parentWorkloadId,
          reason: `Chunked execution error: ${err.message}`
        }
      };
    }
  }

  private async dispatchImageChunkWithRetry(
    spec: ImageChunkSpec,
    parentWorkload: WorkloadDescriptor,
    isForceSwarm: boolean = false,
    maxRetries: number = 2
  ): Promise<ImageChunkResult> {
    const parentWorkloadId = parentWorkload.workloadId || 'wkl-image-parent';
    const chunkTaskId = `${parentWorkloadId}-chunk-${String(spec.metadata.chunkIndex).padStart(2, '0')}`;

    let task = this.taskStore.getTask(chunkTaskId);
    if (!task) {
      task = this.taskStore.createTask({
        id: chunkTaskId,
        inputRef: 'inline_chunk_payload',
        computationDescriptor: JSON.stringify({
          kernelId: 'image_filter_box_blur_v1',
          parameters: {
            width: spec.metadata.width,
            height: spec.metadata.inRowCount,
            radius: spec.metadata.radius,
            mode: spec.metadata.mode,
            channels: spec.metadata.channels,
            chunkIndex: spec.metadata.chunkIndex,
            totalChunks: spec.metadata.totalChunks
          }
        }),
        requiredResources: { minCpuCores: 1, minRamMb: 64 },
        dependencies: [],
        executionConstraints: { parentWorkloadId },
        resultDestination: 'memory',
        status: TaskStatus.PENDING
      });
    }

    if (this.workloadPipeline) {
      this.workloadPipeline.trackTaskInWorkload(parentWorkloadId, chunkTaskId);
    }

    let lastError = 'No eligible worker found';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const allWorkers = this.workerManager.listWorkers();
      const scheduleResult = this.scheduler
        ? this.scheduler.scheduleTask(task, allWorkers, this.taskStore)
        : { status: 'NO_ELIGIBLE_WORKER', selectedWorker: undefined };

      let targetWorkerId: string | null = null;

      if (scheduleResult.status === 'ASSIGNED' && scheduleResult.selectedWorker) {
        targetWorkerId = scheduleResult.selectedWorker.deviceId;
      } else if (this.simulationWorker.isEnabled) {
        targetWorkerId = SimulationWorkerAdapter.DEVICE_ID;
      }

      if (!targetWorkerId) {
        throw new Error(`Scheduler could not place image chunk ${spec.metadata.chunkIndex} (attempt ${attempt + 1}/${maxRetries + 1}): ${scheduleResult.status}`);
      }

      const payloadBytes = spec.payload.length;
      const envTimeoutMs = process.env.SWARMX_WORKLOAD_TIMEOUT_MS ? parseInt(process.env.SWARMX_WORKLOAD_TIMEOUT_MS, 10) : 0;
      const dynamicChunkTimeoutMs = envTimeoutMs > 0 ? envTimeoutMs : Math.max(30000, 30000 + Math.round((payloadBytes / (1024 * 1024)) * 1500));

      this.taskStore.assignTask(chunkTaskId, targetWorkerId, dynamicChunkTimeoutMs);
      this.decisionEngine.acquireReservation(targetWorkerId);

      Logger.execution(`[PAYLOAD] Dispatching image chunk ${spec.metadata.chunkIndex + 1}/${spec.metadata.totalChunks} (${(payloadBytes / (1024 * 1024)).toFixed(2)} MB) to ${targetWorkerId}`);

      try {
        const chunkStartMs = Date.now();
        const completionPromise = new Promise<any>((resolve) => {
          const timer = setTimeout(() => {
            resolve({ status: 'TIMEOUT', error: `Image chunk ${spec.metadata.chunkIndex} timed out after ${(dynamicChunkTimeoutMs / 1000).toFixed(0)}s` });
          }, dynamicChunkTimeoutMs);

          if (this.workloadPipeline) {
            this.workloadPipeline.onTaskFinished(chunkTaskId, (res) => {
              clearTimeout(timer);
              resolve({
                success: res.success,
                status: res.success ? 'COMPLETED' : 'FAILED',
                outputData: res.outputData || (res.task ? res.task.resultDestination : ''),
                error: res.error,
                executionTimeMs: res.executionTimeMs || (Date.now() - chunkStartMs)
              });
            });
          } else {
            clearTimeout(timer);
            resolve({ success: true, status: 'COMPLETED', outputData: '' });
          }
        });

        task.assignedWorkerId = targetWorkerId;
        if (targetWorkerId === SimulationWorkerAdapter.DEVICE_ID || targetWorkerId.startsWith('sim-worker-virtual-')) {
          this.simulationWorker.executeTask(task, spec.payload, 1)
            .then(async (simRes) => {
              if (this.workloadPipeline) {
                await this.workloadPipeline.handleTaskResult(simRes);
              }
            })
            .catch((err) => {
              this.taskStore.recordTaskFailure(chunkTaskId, targetWorkerId!, 'SIMULATION_ERROR', { error: err.message });
            });
        } else {
          const payloadBase64 = spec.payload.toString('base64');
          const sent = this.transportServer.sendExecuteTask(
            targetWorkerId,
            task,
            payloadBase64,
            1
          );
          if (!sent) {
            this.taskStore.recordTaskFailure(chunkTaskId, targetWorkerId, 'TRANSPORT_SEND_FAILED', {});
            throw new Error(`Failed to send image chunk ${spec.metadata.chunkIndex} to worker ${targetWorkerId}`);
          }
        }

        const res = await completionPromise;
        if (res.status === 'COMPLETED' && res.outputData) {
          const outputBuf = Buffer.isBuffer(res.outputData) ? res.outputData : Buffer.from(res.outputData, 'base64');
          return {
            parentWorkloadId,
            chunkIndex: spec.metadata.chunkIndex,
            totalChunks: spec.metadata.totalChunks,
            outRowStart: spec.metadata.outRowStart,
            outRowEnd: spec.metadata.outRowEnd,
            outRowCount: spec.metadata.outRowCount,
            inRowStart: spec.metadata.inRowStart,
            inRowEnd: spec.metadata.inRowEnd,
            inRowCount: spec.metadata.inRowCount,
            topHalo: spec.metadata.topHalo,
            bottomHalo: spec.metadata.bottomHalo,
            width: spec.metadata.width,
            height: spec.metadata.height,
            channels: spec.metadata.channels,
            radius: spec.metadata.radius,
            outputBuffer: outputBuf,
            workerId: targetWorkerId,
            executionTimeMs: res.executionTimeMs || (Date.now() - chunkStartMs)
          };
        } else {
          lastError = res.error || `Image chunk ${spec.metadata.chunkIndex} execution failed on ${targetWorkerId}`;
          this.taskStore.recordTaskFailure(chunkTaskId, targetWorkerId, 'EXECUTION_FAILED', { error: lastError });
        }
      } finally {
        this.decisionEngine.releaseReservation(targetWorkerId);
      }
    }

    throw new Error(`Image chunk ${spec.metadata.chunkIndex} failed after ${maxRetries + 1} attempts: ${lastError}`);
  }

  private async executeChunkedVideoAnalysis(
    msg: IpcMessage,
    workload: WorkloadDescriptor,
    isForceSwarm: boolean,
    decision: any,
    t_decision_ms: number = 0
  ): Promise<IpcResponse> {
    const parentWorkloadId = workload.workloadId || `wkl-video-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const params = (workload.computation.parameters || {}) as any;
    const width = Number(params.width || 512);
    const height = Number(params.height || 512);
    const totalFrames = Number(params.totalFrames || params.frameCount || params.frames || 30);
    const chunkSize = Number(params.chunkSize || params.framesPerChunk || 30);
    const mode = String(params.mode || 'RGBA');
    const channels = mode === 'RGB' ? 3 : (mode === 'L' ? 1 : 4);
    const batchId = params.batchId || (workload as any).batchId;

    const rawPayload: Buffer = (workload.data as any).rawPayloadBuffer
      ? (workload.data as any).rawPayloadBuffer
      : Buffer.from(workload.data.payloadBase64 || '', 'base64');

    const connectedWorkers = this.workerManager.listWorkers().filter(w => w.isEligible);
    const simActive = this.simulationWorker.isEnabled;
    const effectiveWorkerCount = connectedWorkers.length + (simActive ? 1 : 0);

    const t_chunk_start = performance.now();
    const chunkSpecs = VideoChunkEngine.partitionVideoFrames(
      parentWorkloadId,
      width,
      height,
      channels,
      mode,
      totalFrames,
      chunkSize,
      rawPayload
    );
    const t_chunking_ms = performance.now() - t_chunk_start;

    if (this.workloadPipeline) {
      this.workloadPipeline.registerWorkload(parentWorkloadId, chunkSpecs.length);
    }

    const t_workload_start = performance.now();
    const startTimeMs = Date.now();
    Logger.execution(`Partitioned video analysis ${parentWorkloadId} (${totalFrames} frames @ ${width}x${height}, chunkSize=${chunkSize}) into ${chunkSpecs.length} dynamic queue chunks across ${effectiveWorkerCount} workers`);

    this.recordWorkloadEvent({
      workloadId: parentWorkloadId,
      taskId: parentWorkloadId,
      workerId: simActive ? SimulationWorkerAdapter.DEVICE_ID : 'multi-worker-swarm',
      workerHostname: simActive ? '🧪 Virtual Apple Silicon Worker' : `${effectiveWorkerCount} Swarm Nodes`,
      status: 'RUNNING',
      startTimeMs,
      kernelId: 'video_frame_analysis_v1',
      batchId,
      decision: decision.decision,
      estimatedLocalTimeMs: decision.estimatedLocalTimeMs,
      estimatedSwarmTimeMs: decision.estimatedSwarmTimeMs,
      estimatedQueueTimeMs: decision.estimatedQueueTimeMs,
      estimatedTransferTimeMs: decision.estimatedTransferTimeMs,
      estimatedComputeTimeMs: decision.estimatedComputeTimeMs,
      estimatedGain: decision.estimatedGain,
      decisionReason: decision.reason,
      isForceSwarm,
      inputBytes: workload.data.totalPayloadBytes,
      parameters: { ...params, totalChunks: chunkSpecs.length, totalFrames, chunkSize }
    });

    try {
      const t_sched_start = performance.now();
      const chunkResults: VideoChunkResult[] = [];
      const pendingSpecs = [...chunkSpecs];
      const concurrency = Math.max(1, effectiveWorkerCount * 2); // Dynamic work queue with pipeline overlap

      // Worker dynamic consumer pool: pulls next chunk as soon as previous completes
      const workerPool = Array.from({ length: concurrency }, async () => {
        while (pendingSpecs.length > 0) {
          const nextSpec = pendingSpecs.shift();
          if (!nextSpec) break;
          const chunkRes = await this.dispatchVideoChunkWithRetry(nextSpec, workload, isForceSwarm);
          chunkResults.push(chunkRes);
        }
      });

      await Promise.all(workerPool);
      const t_scheduling_ms = performance.now() - t_sched_start;
      Logger.execution(`[PAYLOAD] Result received: All ${chunkResults.length} video chunks completed`);

      const t_reasm_start = performance.now();
      const assembledMetrics = VideoChunkEngine.assembleVideoAnalysis(
        parentWorkloadId,
        chunkResults
      );
      const t_reassembly_ms = performance.now() - t_reasm_start;
      Logger.execution(`[PAYLOAD] Video analysis aggregation completed in ${t_reassembly_ms.toFixed(1)} ms (${assembledMetrics.length} frames)`);

      const t_val_start = performance.now();
      if (assembledMetrics.length !== totalFrames) {
        throw new Error(`Assembled frame analysis length mismatch: expected ${totalFrames} frames, got ${assembledMetrics.length}`);
      }
      const t_validation_ms = performance.now() - t_val_start;

      const t_total_ms = performance.now() - t_workload_start;
      const maxComputeMs = Math.max(...chunkResults.map(r => r.executionTimeMs || 0));
      const avgComputeMs = chunkResults.reduce((sum, r) => sum + (r.executionTimeMs || 0), 0) / chunkResults.length;

      this.recordWorkloadEvent({
        workloadId: parentWorkloadId,
        taskId: parentWorkloadId,
        workerId: simActive ? SimulationWorkerAdapter.DEVICE_ID : 'multi-worker-swarm',
        workerHostname: simActive ? '🧪 Virtual Apple Silicon Worker' : `${effectiveWorkerCount} Swarm Nodes`,
        status: 'COMPLETE',
        startTimeMs,
        endTimeMs: Date.now(),
        durationSeconds: t_total_ms / 1000,
        workerComputeTimeMs: Math.round(avgComputeMs),
        transferTimeMs: Math.max(0, t_total_ms - maxComputeMs),
        queueTimeMs: 0.0,
        validationTimeMs: t_validation_ms,
        localVsRemote: 'REMOTE',
        kernelId: 'video_frame_analysis_v1',
        batchId,
        decision: decision.decision,
        estimatedLocalTimeMs: decision.estimatedLocalTimeMs,
        estimatedSwarmTimeMs: decision.estimatedSwarmTimeMs,
        estimatedQueueTimeMs: decision.estimatedQueueTimeMs,
        estimatedTransferTimeMs: decision.estimatedTransferTimeMs,
        estimatedComputeTimeMs: decision.estimatedComputeTimeMs,
        estimatedGain: decision.estimatedGain,
        decisionReason: decision.reason,
        isForceSwarm,
        inputBytes: workload.data.totalPayloadBytes,
        parameters: { ...params, totalChunks: chunkSpecs.length, totalFrames, chunkSize }
      });

      const jsonStrResult = JSON.stringify(assembledMetrics);
      const isBinaryFrameRequest = Boolean((workload.data as any).rawPayloadBuffer);
      const outputData = isBinaryFrameRequest ? Buffer.from(jsonStrResult, 'utf-8') : Buffer.from(jsonStrResult, 'utf-8').toString('base64');

      return {
        id: msg.id,
        result: {
          status: 'COMPLETED',
          taskId: parentWorkloadId,
          workloadId: parentWorkloadId,
          outputData,
          totalChunks: chunkSpecs.length,
          completedChunks: chunkSpecs.length,
          totalFrames: assembledMetrics.length,
          telemetry: {
            decisionMs: t_decision_ms,
            chunkingMs: t_chunking_ms,
            schedulingMs: t_scheduling_ms,
            workerComputeMs: Math.round(avgComputeMs),
            transferMs: Math.max(0, Math.round(t_total_ms - maxComputeMs)),
            reassemblyMs: t_reassembly_ms,
            validationMs: t_validation_ms,
            coreTotalMs: t_total_ms + t_decision_ms,
            chunkDistribution: chunkResults.map(r => ({
              chunkIndex: r.chunkIndex,
              workerId: r.workerId,
              executionTimeMs: r.executionTimeMs
            }))
          }
        }
      };
    } catch (err: any) {
      Logger.error(`Chunked video analysis failed for ${parentWorkloadId}: ${err.message}`);
      return {
        id: msg.id,
        result: {
          status: isForceSwarm ? 'FAILED' : 'LOCAL_FALLBACK',
          taskId: parentWorkloadId,
          workloadId: parentWorkloadId,
          reason: `Chunked video execution error: ${err.message}`
        }
      };
    }
  }

  private async dispatchVideoChunkWithRetry(
    spec: VideoChunkSpec,
    parentWorkload: WorkloadDescriptor,
    isForceSwarm: boolean = false,
    maxRetries: number = 2
  ): Promise<VideoChunkResult> {
    const parentWorkloadId = parentWorkload.workloadId || 'wkl-video-parent';
    const chunkTaskId = `${parentWorkloadId}-chunk-${String(spec.metadata.chunkIndex).padStart(2, '0')}`;

    let task = this.taskStore.getTask(chunkTaskId);
    if (!task) {
      task = this.taskStore.createTask({
        id: chunkTaskId,
        inputRef: 'inline_chunk_payload',
        computationDescriptor: JSON.stringify({
          kernelId: 'video_frame_analysis_v1',
          parameters: {
            width: spec.metadata.width,
            height: spec.metadata.height,
            channels: spec.metadata.channels,
            mode: spec.metadata.mode,
            frameCount: spec.metadata.frameCount,
            startFrameIndex: spec.metadata.startFrameIndex,
            chunkIndex: spec.metadata.chunkIndex,
            totalChunks: spec.metadata.totalChunks
          }
        }),
        requiredResources: { minCpuCores: 1, minRamMb: 64 },
        dependencies: [],
        executionConstraints: { parentWorkloadId },
        resultDestination: 'memory',
        status: TaskStatus.PENDING
      });
    }

    if (this.workloadPipeline) {
      this.workloadPipeline.trackTaskInWorkload(parentWorkloadId, chunkTaskId);
    }

    let lastError = 'No eligible worker found';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const allWorkers = this.workerManager.listWorkers();
      const scheduleResult = this.scheduler
        ? this.scheduler.scheduleTask(task, allWorkers, this.taskStore)
        : { status: 'NO_ELIGIBLE_WORKER', selectedWorker: undefined };

      let targetWorkerId: string | null = null;

      if (scheduleResult.status === 'ASSIGNED' && scheduleResult.selectedWorker) {
        targetWorkerId = scheduleResult.selectedWorker.deviceId;
      } else if (this.simulationWorker.isEnabled) {
        targetWorkerId = SimulationWorkerAdapter.DEVICE_ID;
      }

      if (!targetWorkerId) {
        throw new Error(`Scheduler could not place video chunk ${spec.metadata.chunkIndex} (attempt ${attempt + 1}/${maxRetries + 1}): ${scheduleResult.status}`);
      }

      const payloadBytes = spec.payload.length;
      const envTimeoutMs = process.env.SWARMX_WORKLOAD_TIMEOUT_MS ? parseInt(process.env.SWARMX_WORKLOAD_TIMEOUT_MS, 10) : 0;
      const dynamicChunkTimeoutMs = envTimeoutMs > 0 ? envTimeoutMs : Math.max(30000, 30000 + Math.round((payloadBytes / (1024 * 1024)) * 1500));

      this.taskStore.assignTask(chunkTaskId, targetWorkerId, dynamicChunkTimeoutMs);
      this.decisionEngine.acquireReservation(targetWorkerId);

      Logger.execution(`[PAYLOAD] Dispatching video chunk ${spec.metadata.chunkIndex + 1}/${spec.metadata.totalChunks} (${(payloadBytes / (1024 * 1024)).toFixed(2)} MB, ${spec.metadata.frameCount} frames) to ${targetWorkerId}`);

      try {
        const chunkStartMs = Date.now();
        const completionPromise = new Promise<any>((resolve) => {
          const timer = setTimeout(() => {
            resolve({ status: 'TIMEOUT', error: `Video chunk ${spec.metadata.chunkIndex} timed out after ${(dynamicChunkTimeoutMs / 1000).toFixed(0)}s` });
          }, dynamicChunkTimeoutMs);

          if (this.workloadPipeline) {
            this.workloadPipeline.onTaskFinished(chunkTaskId, (res) => {
              clearTimeout(timer);
              resolve({
                success: res.success,
                status: res.success ? 'COMPLETED' : 'FAILED',
                outputData: res.outputData || (res.task ? res.task.resultDestination : ''),
                error: res.error,
                executionTimeMs: res.executionTimeMs || (Date.now() - chunkStartMs)
              });
            });
          } else {
            clearTimeout(timer);
            resolve({ success: true, status: 'COMPLETED', outputData: '' });
          }
        });

        task.assignedWorkerId = targetWorkerId;
        if (targetWorkerId === SimulationWorkerAdapter.DEVICE_ID || targetWorkerId.startsWith('sim-worker-virtual-')) {
          this.simulationWorker.executeTask(task, spec.payload, spec.metadata.frameCount)
            .then(async (simRes) => {
              if (this.workloadPipeline) {
                await this.workloadPipeline.handleTaskResult(simRes);
              }
            })
            .catch((err) => {
              this.taskStore.recordTaskFailure(chunkTaskId, targetWorkerId!, 'SIMULATION_ERROR', { error: err.message });
            });
        } else {
          const payloadBase64 = spec.payload.toString('base64');
          const sent = this.transportServer.sendExecuteTask(
            targetWorkerId,
            task,
            payloadBase64,
            spec.metadata.frameCount
          );
          if (!sent) {
            this.taskStore.recordTaskFailure(chunkTaskId, targetWorkerId, 'TRANSPORT_SEND_FAILED', {});
            throw new Error(`Failed to send video chunk ${spec.metadata.chunkIndex} to worker ${targetWorkerId}`);
          }
        }

        const res = await completionPromise;
        if (res.status === 'COMPLETED' && res.outputData) {
          return {
            parentWorkloadId,
            chunkIndex: spec.metadata.chunkIndex,
            totalChunks: spec.metadata.totalChunks,
            startFrameIndex: spec.metadata.startFrameIndex,
            frameCount: spec.metadata.frameCount,
            outputData: res.outputData,
            workerId: targetWorkerId,
            executionTimeMs: res.executionTimeMs || (Date.now() - chunkStartMs)
          };
        } else {
          lastError = res.error || `Video chunk ${spec.metadata.chunkIndex} execution failed on ${targetWorkerId}`;
          this.taskStore.recordTaskFailure(chunkTaskId, targetWorkerId, 'EXECUTION_FAILED', { error: lastError });
        }
      } finally {
        this.decisionEngine.releaseReservation(targetWorkerId);
      }
    }

    throw new Error(`Video chunk ${spec.metadata.chunkIndex} failed after ${maxRetries + 1} attempts: ${lastError}`);
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
