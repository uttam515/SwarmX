import { Task, TaskStatus } from './types';
import { TaskResultPayload } from './workload_pipeline';
import { Worker } from 'worker_threads';

export interface SimulationConfig {
  enabled: boolean;
  failureMode: 'NONE' | 'DISCONNECTED' | 'TASK_FAILURE';
  simulatedDelayMs: number;
}

export interface VirtualWorkerDef {
  deviceId: string;
  deviceName: string;
  cpuCores: number;
  totalRamMb: number;
  gpuModel: string;
  speedMultiplier: number;
}

export const VIRTUAL_WORKER_PROFILES: VirtualWorkerDef[] = [
  {
    deviceId: 'sim-worker-virtual-m2-air',
    deviceName: '🧪 Virtual M2 Air (Simulation Mode)',
    cpuCores: 8,
    totalRamMb: 16384,
    gpuModel: 'Apple M2 GPU (8 cores)',
    speedMultiplier: 1.0
  },
  {
    deviceId: 'sim-worker-virtual-m2-pro',
    deviceName: '🧪 Virtual M2 Pro (Simulation Mode)',
    cpuCores: 10,
    totalRamMb: 16384,
    gpuModel: 'Apple M2 Pro GPU (16 cores)',
    speedMultiplier: 1.3
  },
  {
    deviceId: 'sim-worker-virtual-m2-max',
    deviceName: '🧪 Virtual M2 Max (Simulation Mode)',
    cpuCores: 12,
    totalRamMb: 32768,
    gpuModel: 'Apple M2 Max GPU (30 cores)',
    speedMultiplier: 1.7
  },
  {
    deviceId: 'sim-worker-virtual-m3-ultra',
    deviceName: '🧪 Virtual M3 Ultra (Simulation Mode)',
    cpuCores: 24,
    totalRamMb: 65536,
    gpuModel: 'Apple M3 Ultra GPU (60 cores)',
    speedMultiplier: 2.6
  }
];

const WORKER_THREAD_CODE = `
const { parentPort, threadId } = require('worker_threads');

parentPort.on('message', (msg) => {
  const { taskId, kernelId, params, payloadBuffer, speedMultiplier } = msg;
  const startMs = Date.now();

  try {
    if (kernelId === 'matrix_multiply_v1' || (kernelId && kernelId.includes('matrix_multiply'))) {
      const { M = 0, K = 0, N = 0 } = params;
      const inFloats = new Float32Array(payloadBuffer);
      const aSize = M * K;
      const outFloats = new Float32Array(M * N);

      // Cache-blocked and unrolled Float32 GEMM
      for (let i = 0; i < M; i++) {
        const iA = i * K;
        const iC = i * N;
        for (let k = 0; k < K; k++) {
          const a = inFloats[iA + k];
          const kB = aSize + k * N;
          let j = 0;
          for (; j <= N - 8; j += 8) {
            outFloats[iC + j]     += a * inFloats[kB + j];
            outFloats[iC + j + 1] += a * inFloats[kB + j + 1];
            outFloats[iC + j + 2] += a * inFloats[kB + j + 2];
            outFloats[iC + j + 3] += a * inFloats[kB + j + 3];
            outFloats[iC + j + 4] += a * inFloats[kB + j + 4];
            outFloats[iC + j + 5] += a * inFloats[kB + j + 5];
            outFloats[iC + j + 6] += a * inFloats[kB + j + 6];
            outFloats[iC + j + 7] += a * inFloats[kB + j + 7];
          }
          for (; j < N; j++) {
            outFloats[iC + j] += a * inFloats[kB + j];
          }
        }
      }

      const elapsed = Date.now() - startMs;
      parentPort.postMessage({
        taskId,
        threadId,
        elapsedMs: elapsed,
        outBuffer: outFloats.buffer
      }, [outFloats.buffer]);
    } else if (kernelId === 'video_frame_analysis_v1') {
      const { width = 512, height = 512, mode = 'RGBA', frameCount = 1, startFrameIndex = 0 } = params;
      const channels = mode === 'RGB' ? 3 : (mode === 'L' ? 1 : 4);
      const frameBytes = width * height * channels;
      const input = Buffer.from(payloadBuffer);
      const actualFrames = Math.max(1, Math.min(frameCount, Math.floor(input.length / frameBytes)));
      const results = [];
      let prevFrameOffset = -1;

      for (let f = 0; f < actualFrames; f++) {
        const frameOffset = f * frameBytes;
        const totalPixels = width * height;
        let sumLum = 0.0;
        let sumLumSq = 0.0;
        let sumEdgeEnergy = 0.0;
        let sumMotion = 0.0;

        for (let y = 0; y < height; y++) {
          const rowOffset = frameOffset + y * width * channels;
          const nextRowOffset = frameOffset + Math.min(height - 1, y + 1) * width * channels;

          for (let x = 0; x < width; x++) {
            const px = rowOffset + x * channels;
            const nextPx = rowOffset + Math.min(width - 1, x + 1) * channels;
            const downPx = nextRowOffset + x * channels;

            const r = input[px];
            const g = input[px + Math.min(1, channels - 1)];
            const b = input[px + Math.min(2, channels - 1)];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            sumLum += lum;
            sumLumSq += lum * lum;

            const nextR = input[nextPx];
            const nextG = input[nextPx + Math.min(1, channels - 1)];
            const nextB = input[nextPx + Math.min(2, channels - 1)];
            const nextLum = 0.299 * nextR + 0.587 * nextG + 0.114 * nextB;

            const downR = input[downPx];
            const downG = input[downPx + Math.min(1, channels - 1)];
            const downB = input[downPx + Math.min(2, channels - 1)];
            const downLum = 0.299 * downR + 0.587 * downG + 0.114 * downB;

            sumEdgeEnergy += Math.abs(nextLum - lum) + Math.abs(downLum - lum);

            if (prevFrameOffset >= 0) {
              const prevPx = prevFrameOffset + (y * width + x) * channels;
              const prevR = input[prevPx];
              const prevG = input[prevPx + Math.min(1, channels - 1)];
              const prevB = input[prevPx + Math.min(2, channels - 1)];
              const prevLum = 0.299 * prevR + 0.587 * prevG + 0.114 * prevB;
              sumMotion += Math.abs(lum - prevLum);
            }
          }
        }

        const meanLum = sumLum / totalPixels;
        const varianceLum = Math.max(0.0, (sumLumSq / totalPixels) - (meanLum * meanLum));
        const edgeDensity = sumEdgeEnergy / totalPixels;
        const motionEnergy = prevFrameOffset >= 0 ? (sumMotion / totalPixels) : 0.0;
        const blurScore = Math.sqrt(varianceLum) * (edgeDensity / 10.0);

        results.push({
          frameIndex: startFrameIndex + f,
          luminance: Math.round(meanLum * 100) / 100,
          edgeDensity: Math.round(edgeDensity * 100) / 100,
          motionEnergy: Math.round(motionEnergy * 100) / 100,
          blurScore: Math.round(blurScore * 100) / 100
        });

        prevFrameOffset = frameOffset;
      }

      const jsonStr = JSON.stringify(results);
      const jsonBuf = Buffer.from(jsonStr, 'utf-8');
      const elapsed = Date.now() - startMs;
      parentPort.postMessage({
        taskId,
        threadId,
        elapsedMs: elapsed,
        outBuffer: jsonBuf.buffer
      }, [jsonBuf.buffer]);
    } else {
      // 2D Separable BoxBlur
      const { radius = 2, width = 0, height = 0, mode = 'RGBA' } = params;
      const channels = mode === 'RGB' ? 3 : (mode === 'L' ? 1 : 4);
      const input = Buffer.from(payloadBuffer);
      const totalPixels = width * height;
      const temp = Buffer.alloc(totalPixels * channels);
      const output = Buffer.alloc(totalPixels * channels);
      const windowCount = 2 * radius + 1;

      for (let y = 0; y < height; y++) {
        const rowOffset = y * width * channels;
        for (let c = 0; c < channels; c++) {
          let windowSum = 0;
          for (let k = -radius; k <= radius; k++) {
            const clampedX = Math.max(0, Math.min(width - 1, k));
            windowSum += input[rowOffset + clampedX * channels + c];
          }
          temp[rowOffset + c] = Math.floor(windowSum / windowCount);
          for (let x = 1; x < width; x++) {
            const leftIdx = Math.max(0, Math.min(width - 1, x - radius - 1));
            const rightIdx = Math.max(0, Math.min(width - 1, x + radius));
            windowSum += input[rowOffset + rightIdx * channels + c] - input[rowOffset + leftIdx * channels + c];
            temp[rowOffset + x * channels + c] = Math.floor(windowSum / windowCount);
          }
        }
      }

      for (let x = 0; x < width; x++) {
        const colOffset = x * channels;
        for (let c = 0; c < channels; c++) {
          let windowSum = 0;
          for (let k = -radius; k <= radius; k++) {
            const clampedY = Math.max(0, Math.min(height - 1, k));
            windowSum += temp[clampedY * width * channels + colOffset + c];
          }
          output[colOffset + c] = Math.floor(windowSum / windowCount);
          for (let y = 1; y < height; y++) {
            const topIdx = Math.max(0, Math.min(height - 1, y - radius - 1));
            const botIdx = Math.max(0, Math.min(height - 1, y + radius));
            windowSum += temp[botIdx * width * channels + colOffset + c] - temp[topIdx * width * channels + colOffset + c];
            output[y * width * channels + colOffset + c] = Math.floor(windowSum / windowCount);
          }
        }
      }

      const elapsed = Date.now() - startMs;
      parentPort.postMessage({
        taskId,
        threadId,
        elapsedMs: elapsed,
        outBuffer: output.buffer
      }, [output.buffer]);
    }
  } catch (err) {
    parentPort.postMessage({
      taskId,
      threadId,
      error: err.message,
      elapsedMs: Date.now() - startMs
    });
  }
});
`;

interface ThreadWorkerInstance {
  worker: Worker;
  activeTasks: number;
}

/**
 * 🧪 SimulationWorkerAdapter:
 * Multi-Threaded Virtual Apple Silicon Worker Cluster.
 * Executes genuine pixel and GEMM computations for certified kernels concurrently across
 * real OS background worker threads without blocking the Node.js event loop.
 *
 * NOTE: This adapter is strictly isolated and disabled by default.
 * It NEVER modifies physical networking, WebSocket transport, SAS pairing, or encryption layers.
 */
export class SimulationWorkerAdapter {
  public static readonly DEVICE_ID = 'sim-worker-virtual-m3';
  public static readonly DEVICE_NAME = '🧪 Virtual Worker — Simulation Mode';

  private config: SimulationConfig = {
    enabled: false,
    failureMode: 'NONE',
    simulatedDelayMs: 0
  };

  private threadPool: Map<string, ThreadWorkerInstance> = new Map();

  public setConfig(newConfig: Partial<SimulationConfig>): SimulationConfig {
    this.config = { ...this.config, ...newConfig };
    if (this.config.enabled) {
      this.ensureThreadPool();
    }
    return { ...this.config };
  }

  public getConfig(): SimulationConfig {
    return { ...this.config };
  }

  public get isEnabled(): boolean {
    return this.config.enabled;
  }

  private ensureThreadPool(): void {
    for (const profile of VIRTUAL_WORKER_PROFILES) {
      if (!this.threadPool.has(profile.deviceId)) {
        try {
          const worker = new Worker(WORKER_THREAD_CODE, { eval: true });
          worker.unref(); // Don't prevent Node process exit
          this.threadPool.set(profile.deviceId, { worker, activeTasks: 0 });
        } catch (e) {
          // Fallback to in-process execution if worker_threads cannot be created
        }
      }
    }
  }

  public async stop(): Promise<void> {
    for (const [id, instance] of this.threadPool.entries()) {
      try {
        await instance.worker.terminate();
      } catch (e) {}
    }
    this.threadPool.clear();
  }

  public getAllCapabilityProfiles() {
    return VIRTUAL_WORKER_PROFILES.map((def) => ({
      capabilitySchemaVersion: 1,
      deviceId: def.deviceId,
      deviceName: def.deviceName,
      osType: 'darwin' as const,
      osVersion: '15.0 (Virtual)',
      cpuArch: 'arm64',
      cpuCores: def.cpuCores,
      totalRamMb: def.totalRamMb,
      hasGpu: true,
      gpuModel: def.gpuModel,
      gpuAccelerationType: 'Metal (Virtual)',
      supportedKernels: ['image_filter_box_blur_v1', 'matrix_multiply_v1'],
      isSimulated: true
    }));
  }

  public getAllTelemetries() {
    return VIRTUAL_WORKER_PROFILES.map((def) => ({
      deviceId: def.deviceId,
      timestampMs: Date.now(),
      batteryLevel: 0.95,
      isCharging: true,
      thermalState: 0, // Nominal
      cpuUtilization: 0.10,
      availableRamMb: Math.round(def.totalRamMb * 0.8),
      isEligible: this.config.failureMode !== 'DISCONNECTED'
    }));
  }

  public getCapabilityProfile(deviceId?: string) {
    const target = VIRTUAL_WORKER_PROFILES.find((p) => p.deviceId === deviceId) || VIRTUAL_WORKER_PROFILES[0];
    return {
      capabilitySchemaVersion: 1,
      deviceId: target.deviceId,
      deviceName: target.deviceName,
      osType: 'darwin' as const,
      osVersion: '15.0 (Virtual)',
      cpuArch: 'arm64',
      cpuCores: target.cpuCores,
      totalRamMb: target.totalRamMb,
      hasGpu: true,
      gpuModel: target.gpuModel,
      gpuAccelerationType: 'Metal (Virtual)',
      supportedKernels: ['image_filter_box_blur_v1', 'matrix_multiply_v1'],
      isSimulated: true
    };
  }

  public getTelemetry(deviceId?: string) {
    const target = VIRTUAL_WORKER_PROFILES.find((p) => p.deviceId === deviceId) || VIRTUAL_WORKER_PROFILES[0];
    return {
      deviceId: target.deviceId,
      timestampMs: Date.now(),
      batteryLevel: 0.95,
      isCharging: true,
      thermalState: 0, // Nominal
      cpuUtilization: 0.10,
      availableRamMb: Math.round(target.totalRamMb * 0.8),
      isEligible: this.config.failureMode !== 'DISCONNECTED'
    };
  }

  /**
   * Executes a simulated computation for certified kernels concurrently across worker threads.
   */
  public async executeTask(
    task: Task,
    payloadInput?: Buffer | string,
    itemCount: number = 1
  ): Promise<TaskResultPayload> {
    if (!this.config.enabled) {
      throw new Error('Simulation worker is currently disabled');
    }

    if (this.config.failureMode === 'DISCONNECTED') {
      throw new Error('Simulation worker is in simulated DISCONNECTED failure state');
    }

    const startTime = Date.now();

    if (this.config.simulatedDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.simulatedDelayMs));
    }

    if (this.config.failureMode === 'TASK_FAILURE') {
      return {
        taskId: task.id,
        workerId: task.assignedWorkerId || SimulationWorkerAdapter.DEVICE_ID,
        workerHostname: '🧪 Simulated Mac (Virtual Environment)',
        workerPid: process.pid,
        outputData: '',
        executionTimeMs: Date.now() - startTime,
        status: 'FAILED',
        itemCount
      } as any;
    }

    const targetWorker = VIRTUAL_WORKER_PROFILES.find((p) => p.deviceId === task.assignedWorkerId) || VIRTUAL_WORKER_PROFILES[0];

    let inputBuffer: Buffer = Buffer.alloc(0);
    if (payloadInput) {
      inputBuffer = Buffer.isBuffer(payloadInput)
        ? payloadInput
        : Buffer.from(payloadInput, 'base64');
    }

    let kernelId = 'image_filter_box_blur_v1';
    let params: any = {};
    try {
      const desc = JSON.parse(task.computationDescriptor);
      if (desc.kernelId) kernelId = desc.kernelId;
      if (desc.parameters) params = desc.parameters;
    } catch (e) {}

    let outputPayload: Buffer | string = '';
    let executionTimeMs = 0;

    // Check if worker thread instance exists for this virtual worker
    this.ensureThreadPool();
    const threadInstance = this.threadPool.get(targetWorker.deviceId);

    if (threadInstance && inputBuffer.length > 0) {
      try {
        const threadResult = await new Promise<{ outBuffer?: ArrayBuffer; elapsedMs: number; error?: string }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            threadInstance.worker.off('message', handler);
            reject(new Error(`Worker thread timeout for task ${task.id}`));
          }, 30000);

          const handler = (msg: any) => {
            if (msg.taskId === task.id) {
              clearTimeout(timeout);
              threadInstance.worker.off('message', handler);
              threadInstance.activeTasks = Math.max(0, threadInstance.activeTasks - 1);
              if (msg.error) {
                reject(new Error(msg.error));
              } else {
                resolve(msg);
              }
            }
          };

          threadInstance.worker.on('message', handler);
          threadInstance.activeTasks++;

          // Copy input buffer into ArrayBuffer for thread transfer
          const arrayBuf = inputBuffer.buffer.slice(
            inputBuffer.byteOffset,
            inputBuffer.byteOffset + inputBuffer.byteLength
          );

          threadInstance.worker.postMessage({
            taskId: task.id,
            kernelId,
            params,
            payloadBuffer: arrayBuf,
            speedMultiplier: targetWorker.speedMultiplier
          }, [arrayBuf as ArrayBuffer]);
        });

        if (threadResult.outBuffer) {
          outputPayload = Buffer.from(threadResult.outBuffer);
        }
        executionTimeMs = threadResult.elapsedMs;
      } catch (err) {
        // Fall back to in-process execution on thread error
        outputPayload = this.computeInProcess(kernelId, params, inputBuffer);
        executionTimeMs = Date.now() - startTime;
      }
    } else if (inputBuffer.length > 0) {
      outputPayload = this.computeInProcess(kernelId, params, inputBuffer);
      executionTimeMs = Date.now() - startTime;
    }

    const isInputBuffer = Buffer.isBuffer(payloadInput);
    const finalOutput = isInputBuffer
      ? outputPayload
      : (Buffer.isBuffer(outputPayload) ? outputPayload.toString('base64') : outputPayload);

    return {
      taskId: task.id,
      workerId: task.assignedWorkerId || targetWorker.deviceId,
      workerHostname: targetWorker.deviceName,
      workerPid: process.pid,
      outputData: finalOutput as any,
      executionTimeMs: Math.max(1, executionTimeMs || (Date.now() - startTime)),
      itemCount
    };
  }

  private computeInProcess(kernelId: string, params: any, inputBuffer: Buffer): Buffer {
    if (kernelId.includes('matrix_multiply')) {
      const M = params.M || 0;
      const K = params.K || 0;
      const N = params.N || 0;
      return this.computeMatrixMultiply(inputBuffer, M, K, N);
    } else {
      const { radius = 2, width = 0, height = 0, mode = 'RGBA' } = params;
      const channels = mode === 'RGB' ? 3 : (mode === 'L' ? 1 : 4);
      if (width > 0 && height > 0 && inputBuffer.length >= width * height * channels) {
        return this.computeBoxBlur(inputBuffer, width, height, channels, radius);
      }
      return inputBuffer;
    }
  }

  private computeMatrixMultiply(input: Buffer, M: number, K: number, N: number): Buffer {
    const floatCount = Math.floor(input.length / 4);
    if (M <= 0 || K <= 0 || N <= 0) {
      const side = Math.max(1, Math.floor(Math.sqrt(floatCount / 2)));
      M = side;
      K = side;
      N = side;
    }

    const aSize = M * K;
    const cSize = M * N;

    const inFloats = input.byteOffset % 4 === 0
      ? new Float32Array(input.buffer, input.byteOffset, floatCount)
      : new Float32Array(input.buffer.slice(input.byteOffset, input.byteOffset + floatCount * 4));

    const outBuffer = Buffer.alloc(cSize * 4);
    const outFloats = new Float32Array(outBuffer.buffer, outBuffer.byteOffset, cSize);

    for (let i = 0; i < M; i++) {
      const iOffsetA = i * K;
      const iOffsetC = i * N;
      for (let k = 0; k < K; k++) {
        const a_ik = inFloats[iOffsetA + k];
        const kOffsetB = aSize + k * N;
        let j = 0;
        for (; j <= N - 8; j += 8) {
          outFloats[iOffsetC + j]     += a_ik * inFloats[kOffsetB + j];
          outFloats[iOffsetC + j + 1] += a_ik * inFloats[kOffsetB + j + 1];
          outFloats[iOffsetC + j + 2] += a_ik * inFloats[kOffsetB + j + 2];
          outFloats[iOffsetC + j + 3] += a_ik * inFloats[kOffsetB + j + 3];
          outFloats[iOffsetC + j + 4] += a_ik * inFloats[kOffsetB + j + 4];
          outFloats[iOffsetC + j + 5] += a_ik * inFloats[kOffsetB + j + 5];
          outFloats[iOffsetC + j + 6] += a_ik * inFloats[kOffsetB + j + 6];
          outFloats[iOffsetC + j + 7] += a_ik * inFloats[kOffsetB + j + 7];
        }
        for (; j < N; j++) {
          outFloats[iOffsetC + j] += a_ik * inFloats[kOffsetB + j];
        }
      }
    }

    return outBuffer;
  }

  private computeBoxBlur(input: Buffer, width: number, height: number, channels: number, radius: number): Buffer {
    const totalPixels = width * height;
    const temp = Buffer.alloc(totalPixels * channels);
    const output = Buffer.alloc(totalPixels * channels);
    const windowCount = 2 * radius + 1;

    for (let y = 0; y < height; y++) {
      const rowOffset = y * width * channels;
      for (let c = 0; c < channels; c++) {
        let windowSum = 0;
        for (let k = -radius; k <= radius; k++) {
          const clampedX = Math.max(0, Math.min(width - 1, k));
          windowSum += input[rowOffset + clampedX * channels + c];
        }
        temp[rowOffset + c] = Math.floor(windowSum / windowCount);
        for (let x = 1; x < width; x++) {
          const leftIdx = Math.max(0, Math.min(width - 1, x - radius - 1));
          const rightIdx = Math.max(0, Math.min(width - 1, x + radius));
          windowSum += input[rowOffset + rightIdx * channels + c] - input[rowOffset + leftIdx * channels + c];
          temp[rowOffset + x * channels + c] = Math.floor(windowSum / windowCount);
        }
      }
    }

    for (let x = 0; x < width; x++) {
      const colOffset = x * channels;
      for (let c = 0; c < channels; c++) {
        let windowSum = 0;
        for (let k = -radius; k <= radius; k++) {
          const clampedY = Math.max(0, Math.min(height - 1, k));
          windowSum += temp[clampedY * width * channels + colOffset + c];
        }
        output[colOffset + c] = Math.floor(windowSum / windowCount);
        for (let y = 1; y < height; y++) {
          const topIdx = Math.max(0, Math.min(height - 1, y - radius - 1));
          const botIdx = Math.max(0, Math.min(height - 1, y + radius));
          windowSum += temp[botIdx * width * channels + colOffset + c] - temp[topIdx * width * channels + colOffset + c];
          output[y * width * channels + colOffset + c] = Math.floor(windowSum / windowCount);
        }
      }
    }

    return output;
  }
}
