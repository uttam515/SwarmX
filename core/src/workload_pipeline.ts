import { TaskStore } from './db/task_store';
import { Task, TaskStatus, IResultValidator } from './types';
import { PassThroughValidator, ToleranceAwareMatrixValidator } from './result_validator';
import { ScoredScheduler } from './scheduler';

export interface TaskResultPayload {
  taskId: string;
  workerId: string;
  outputData: Buffer | string;
  executionTimeMs: number;
  attemptNumber?: number; // 1-indexed generation/attempt counter
  itemCount?: number;
  workerHostname?: string;
  workerPid?: number;
}

export interface TaskProcessingResult {
  success: boolean;
  status: TaskStatus;
  task: Task;
  outputData?: Buffer | string;
  error?: string;
  validationDetails?: any;
  workerHostname?: string;
  workerPid?: number;
  executionTimeMs?: number;
}

export interface WorkloadProgress {
  workloadId: string;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  inFlightChunks: number;
  percentComplete: number;
  isCancelled: boolean;
  elapsedMs: number;
}

interface ActiveWorkloadState {
  workloadId: string;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  inFlightTaskIds: Set<string>;
  isCancelled: boolean;
  createdAtMs: number;
}

/**
 * Workload Pipeline (Phase J: Production Workload Pipeline):
 * - Ingests streaming task results and executes tolerance-aware validation per task
 * - Handles chunk streaming, progress tracking, and bounded backpressure
 * - Supports cancellation/abandonment without state corruption
 * - Updates adaptive scheduler throughput telemetry via EMA
 */
export class WorkloadPipeline {
  private taskStore: TaskStore;
  private scheduler: ScoredScheduler;
  private validators: Map<string, IResultValidator> = new Map(); // Key: taskId or taskType
  private defaultValidator: IResultValidator = new PassThroughValidator();
  private completionListeners: Map<string, (result: TaskProcessingResult) => void> = new Map();
  private activeWorkloads: Map<string, ActiveWorkloadState> = new Map();

  constructor(taskStore: TaskStore, scheduler: ScoredScheduler) {
    this.taskStore = taskStore;
    this.scheduler = scheduler;
  }

  public registerWorkload(workloadId: string, totalChunks: number): void {
    this.activeWorkloads.set(workloadId, {
      workloadId,
      totalChunks,
      completedChunks: 0,
      failedChunks: 0,
      inFlightTaskIds: new Set(),
      isCancelled: false,
      createdAtMs: Date.now()
    });
  }

  public trackTaskInWorkload(workloadId: string, taskId: string): void {
    const state = this.activeWorkloads.get(workloadId);
    if (state) {
      state.inFlightTaskIds.add(taskId);
    }
  }

  public cancelWorkload(workloadId: string): boolean {
    const state = this.activeWorkloads.get(workloadId);
    if (!state) return false;

    state.isCancelled = true;
    for (const taskId of state.inFlightTaskIds) {
      try {
        const task = this.taskStore.getTask(taskId);
        if (task && (task.status === TaskStatus.PENDING || task.status === TaskStatus.ASSIGNED || task.status === TaskStatus.RUNNING)) {
          // Abandon in-flight task safely
          const listener = this.completionListeners.get(taskId);
          if (listener) {
            this.completionListeners.delete(taskId);
            listener({
              success: false,
              status: TaskStatus.ABANDONED,
              task,
              error: 'WORKLOAD_CANCELLED'
            });
          }
        }
      } catch (e) {}
    }
    state.inFlightTaskIds.clear();
    return true;
  }

  public getWorkloadProgress(workloadId: string): WorkloadProgress | undefined {
    const state = this.activeWorkloads.get(workloadId);
    if (!state) return undefined;

    const inFlightChunks = state.inFlightTaskIds.size;
    const percentComplete = state.totalChunks > 0
      ? Number(((state.completedChunks / state.totalChunks) * 100).toFixed(1))
      : 100;

    return {
      workloadId: state.workloadId,
      totalChunks: state.totalChunks,
      completedChunks: state.completedChunks,
      failedChunks: state.failedChunks,
      inFlightChunks,
      percentComplete,
      isCancelled: state.isCancelled,
      elapsedMs: Date.now() - state.createdAtMs
    };
  }

  public onTaskFinished(taskId: string, listener: (result: TaskProcessingResult) => void): void {
    this.completionListeners.set(taskId, listener);
  }

  public registerValidator(key: string, validator: IResultValidator): void {
    this.validators.set(key, validator);
  }

  public getValidator(taskId: string, taskType?: string): IResultValidator {
    if (this.validators.has(taskId)) {
      return this.validators.get(taskId)!;
    }
    if (taskType && this.validators.has(taskType)) {
      return this.validators.get(taskType)!;
    }
    if (taskType && taskType.includes('matrix_multiply')) {
      return new ToleranceAwareMatrixValidator();
    }
    return this.defaultValidator;
  }

  public async handleTaskResult(payload: TaskResultPayload): Promise<TaskProcessingResult> {
    const task = this.taskStore.getTask(payload.taskId);
    if (!task) {
      throw new Error(`Task ${payload.taskId} not found`);
    }

    // Invariant: Reject duplicate result if task is already completed
    if (task.status === TaskStatus.COMPLETED) {
      return {
        success: false,
        status: task.status,
        task,
        error: `DUPLICATE_RESULT_IGNORED: Task ${task.id} has already been completed`
      };
    }

    // Invariant: Reject stale results from superseded worker assignments
    if (task.assignedWorkerId && task.assignedWorkerId !== payload.workerId) {
      return {
        success: false,
        status: task.status,
        task,
        error: `STALE_ATTEMPT_IGNORED: Result from worker ${payload.workerId} rejected; task is currently assigned to ${task.assignedWorkerId}`
      };
    }

    // Invariant: Reject stale attempts with mismatched generation counters
    if (payload.attemptNumber !== undefined) {
      const currentAttempt = task.retryCount + 1;
      if (payload.attemptNumber !== currentAttempt) {
        return {
          success: false,
          status: task.status,
          task,
          error: `STALE_ATTEMPT_IGNORED: Result attempt ${payload.attemptNumber} does not match current task attempt ${currentAttempt}`
        };
      }
    }

    const validator = this.getValidator(task.id, task.computationDescriptor);
    const validation = await validator.validate(task, payload.outputData);

    let processingResult: TaskProcessingResult;
    if (validation.isValid) {
      // 1. Successful Validation: Complete Task
      // Store lightweight reference in SQLite to avoid multi-megabyte DB payload allocations
      const isBuffer = Buffer.isBuffer(payload.outputData);
      let resultDestinationRef: string;
      if (isBuffer) {
        resultDestinationRef = `memory://${task.id}`;
      } else if (typeof payload.outputData === 'string' && payload.outputData.length > 1024) {
        resultDestinationRef = `memory://${task.id}`;
      } else if (typeof payload.outputData === 'string') {
        resultDestinationRef = payload.outputData;
      } else {
        resultDestinationRef = `memory://${task.id}`;
      }

      const completedTask = this.taskStore.completeTask(task.id, resultDestinationRef);

      // Calibrate worker throughput telemetry on scheduler using EMA
      if (payload.itemCount && payload.executionTimeMs > 0) {
        const itemsPerSec = (payload.itemCount / payload.executionTimeMs) * 1000;
        this.scheduler.updateWorkerThroughputEma(payload.workerId, itemsPerSec);
      }

      // Update progress state
      for (const [wklId, state] of this.activeWorkloads.entries()) {
        if (state.inFlightTaskIds.has(task.id)) {
          state.inFlightTaskIds.delete(task.id);
          state.completedChunks++;
        }
      }

      processingResult = {
        success: true,
        status: TaskStatus.COMPLETED,
        task: completedTask,
        outputData: payload.outputData,
        validationDetails: validation.details,
        workerHostname: payload.workerHostname,
        workerPid: payload.workerPid,
        executionTimeMs: payload.executionTimeMs
      };
    } else {
      // 2. Tolerance Validation Failure: Record failure with worker exclusion
      const failedTask = this.taskStore.recordTaskFailure(
        task.id,
        payload.workerId,
        'VALIDATION_TOLERANCE_EXCEEDED',
        {
          reason: validation.reason,
          details: validation.details,
          executionTimeMs: payload.executionTimeMs
        }
      );

      // Increment worker instability penalty
      this.scheduler.recordWorkerFailure(payload.workerId);

      for (const [wklId, state] of this.activeWorkloads.entries()) {
        if (state.inFlightTaskIds.has(task.id)) {
          state.inFlightTaskIds.delete(task.id);
          state.failedChunks++;
        }
      }

      processingResult = {
        success: false,
        status: failedTask.status,
        task: failedTask,
        error: validation.reason || 'VALIDATION_TOLERANCE_EXCEEDED',
        validationDetails: validation.details
      };
    }

    const listener = this.completionListeners.get(task.id);
    if (listener) {
      this.completionListeners.delete(task.id);
      listener(processingResult);
    }

    return processingResult;
  }

  public handleExecutionError(taskId: string, workerId: string, error: string): Task {
    const failedTask = this.taskStore.recordTaskFailure(
      taskId,
      workerId,
      'EXECUTION_ERROR',
      { error }
    );
    this.scheduler.recordWorkerFailure(workerId);
    return failedTask;
  }
}
