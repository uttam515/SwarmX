import {
  WorkloadDagDescriptor,
  DagStage,
  DagStageStatus,
  DagArtifact,
  DagProgress
} from './types';
import { KernelRegistry } from './kernel_registry';
import * as crypto from 'crypto';

export class DagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DagValidationError';
  }
}

export interface DagState {
  descriptor: WorkloadDagDescriptor;
  stages: Map<string, DagStage>;
  artifacts: Map<string, DagArtifact>;
  isCancelled: boolean;
  createdAtMs: number;
  completedAtMs?: number;
}

/**
 * Dependency-Aware Multi-Stage DAG Execution Engine (Milestone 2.3):
 * - Validates acyclic structure, certified kernels, and artifact references
 * - Coordinates stage state transitions (PENDING -> READY -> RUNNING -> COMPLETED)
 * - Manages intermediate artifact lifecycle and reference counting
 * - Preserves exactly-once execution semantics & handles failure recovery
 */
export class DagEngine {
  private dags: Map<string, DagState> = new Map();
  private registry: KernelRegistry;
  private maxStageAttempts: number = 3;

  constructor(registry?: KernelRegistry) {
    this.registry = registry || KernelRegistry.getInstance();
  }

  /**
   * Validates structural integrity, kernel certification, and dependency acyclicity of a DAG.
   */
  public validateDag(dag: WorkloadDagDescriptor): void {
    if (!dag.dagId) throw new DagValidationError('Missing dagId');
    if (!dag.stages || dag.stages.length === 0) {
      throw new DagValidationError('DAG must have at least one stage');
    }

    const stageIds = new Set<string>();
    const producedArtifacts = new Set<string>();

    // Initial input artifacts
    if (dag.inputArtifacts) {
      for (const input of dag.inputArtifacts) {
        producedArtifacts.add(input.artifactId);
      }
    }

    for (const stage of dag.stages) {
      if (!stage.stageId) throw new DagValidationError('Stage missing stageId');
      if (stageIds.has(stage.stageId)) {
        throw new DagValidationError(`Duplicate stageId: ${stage.stageId}`);
      }
      stageIds.add(stage.stageId);

      // Verify kernel is certified
      if (!this.registry.isCertified(stage.kernelId)) {
        throw new DagValidationError(`Kernel '${stage.kernelId}' is not certified in KernelRegistry`);
      }

      if (stage.outputArtifactRef) {
        producedArtifacts.add(stage.outputArtifactRef);
      }
    }

    // Verify dependencies and artifact inputs exist
    for (const stage of dag.stages) {
      for (const dep of stage.dependencies || []) {
        if (!stageIds.has(dep)) {
          throw new DagValidationError(`Stage ${stage.stageId} depends on non-existent stage ${dep}`);
        }
      }

      for (const inputRef of stage.inputArtifactRefs || []) {
        if (!producedArtifacts.has(inputRef)) {
          throw new DagValidationError(`Stage ${stage.stageId} requires artifact '${inputRef}' which is not produced by any upstream stage or input`);
        }
      }
    }

    // Cycle detection via DFS
    this.detectCycles(dag.stages);

    // Verify terminal output artifacts
    for (const outRef of dag.outputArtifactRefs || []) {
      if (!producedArtifacts.has(outRef)) {
        throw new DagValidationError(`Declared terminal output artifact '${outRef}' is not produced by any stage`);
      }
    }
  }

  private detectCycles(stages: DagStage[]): void {
    const adj = new Map<string, string[]>();
    for (const s of stages) {
      adj.set(s.stageId, [...(s.dependencies || [])]);
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();

    const checkCycle = (node: string): boolean => {
      visited.add(node);
      recStack.add(node);

      for (const parent of adj.get(node) || []) {
        if (!visited.has(parent)) {
          if (checkCycle(parent)) return true;
        } else if (recStack.has(parent)) {
          return true;
        }
      }

      recStack.delete(node);
      return false;
    };

    for (const stage of stages) {
      if (!visited.has(stage.stageId)) {
        if (checkCycle(stage.stageId)) {
          throw new DagValidationError(`Cyclic dependency detected in DAG involving stage ${stage.stageId}`);
        }
      }
    }
  }

  /**
   * Registers and initializes a validated DAG for execution.
   */
  public registerDag(dag: WorkloadDagDescriptor): DagProgress {
    this.validateDag(dag);

    const stagesMap = new Map<string, DagStage>();
    const artifactsMap = new Map<string, DagArtifact>();
    const now = Date.now();

    // Register initial inputs
    for (const input of dag.inputArtifacts || []) {
      const buf = input.dataBuffer ? (Buffer.isBuffer(input.dataBuffer) ? input.dataBuffer : Buffer.from(input.dataBuffer)) : undefined;
      const checksum = buf ? crypto.createHash('sha256').update(buf).digest('hex') : undefined;

      artifactsMap.set(input.artifactId, {
        artifactId: input.artifactId,
        producingStageId: '__INPUT__',
        sizeBytes: input.sizeBytes,
        format: input.format,
        checksumSha256: checksum,
        dataBuffer: buf,
        referenceCount: 0,
        isCleanedUp: false,
        createdAtMs: now
      });
    }

    // Compute artifact reference counts
    for (const stage of dag.stages) {
      for (const inputRef of stage.inputArtifactRefs || []) {
        const art = artifactsMap.get(inputRef);
        if (art) {
          art.referenceCount++;
        }
      }
    }

    // Initialize stages: 0 dependencies -> READY; else PENDING
    for (const stage of dag.stages) {
      const hasDeps = stage.dependencies && stage.dependencies.length > 0;
      stagesMap.set(stage.stageId, {
        ...stage,
        dependencies: stage.dependencies || [],
        inputArtifactRefs: stage.inputArtifactRefs || [],
        status: hasDeps ? 'PENDING' : 'READY',
        attemptNumber: 0
      });
    }

    this.dags.set(dag.dagId, {
      descriptor: dag,
      stages: stagesMap,
      artifacts: artifactsMap,
      isCancelled: false,
      createdAtMs: now
    });

    return this.getDagProgress(dag.dagId)!;
  }

  /**
   * Retrieves all stages in the DAG that are currently in the READY state.
   */
  public getNextReadyStages(dagId: string): DagStage[] {
    const dagState = this.dags.get(dagId);
    if (!dagState || dagState.isCancelled) return [];

    return Array.from(dagState.stages.values()).filter(s => s.status === 'READY');
  }

  /**
   * Assigns a ready stage to a worker and marks it RUNNING.
   */
  public assignStage(dagId: string, stageId: string, workerId: string): DagStage {
    const dagState = this.dags.get(dagId);
    if (!dagState) throw new Error(`DAG ${dagId} not found`);
    if (dagState.isCancelled) throw new Error(`DAG ${dagId} has been cancelled`);

    const stage = dagState.stages.get(stageId);
    if (!stage) throw new Error(`Stage ${stageId} not found in DAG ${dagId}`);
    if (stage.status !== 'READY') {
      throw new Error(`Cannot assign stage ${stageId} in status ${stage.status}`);
    }

    stage.status = 'RUNNING';
    stage.assignedWorkerId = workerId;
    stage.attemptNumber++;

    return { ...stage };
  }

  /**
   * Completes a stage, saves its intermediate artifact, updates reference counts,
   * and promotes downstream dependent stages to READY.
   */
  public completeStage(
    dagId: string,
    stageId: string,
    outputBuffer: Buffer | string,
    workerId: string,
    attemptNumber: number,
    executionTimeMs: number
  ): { success: boolean; error?: string; newlyReadyStages: DagStage[] } {
    const dagState = this.dags.get(dagId);
    if (!dagState) return { success: false, error: `DAG ${dagId} not found`, newlyReadyStages: [] };

    const stage = dagState.stages.get(stageId);
    if (!stage) return { success: false, error: `Stage ${stageId} not found`, newlyReadyStages: [] };

    // Invariant: Reject duplicate or stale attempts
    if (stage.status === 'COMPLETED') {
      return { success: false, error: `DUPLICATE_RESULT_IGNORED: Stage ${stageId} already completed`, newlyReadyStages: [] };
    }
    if (stage.assignedWorkerId && stage.assignedWorkerId !== workerId) {
      return { success: false, error: `STALE_ATTEMPT_IGNORED: Stage assigned to ${stage.assignedWorkerId}, got result from ${workerId}`, newlyReadyStages: [] };
    }
    if (stage.attemptNumber !== attemptNumber) {
      return { success: false, error: `STALE_ATTEMPT_IGNORED: Result attempt ${attemptNumber} does not match active attempt ${stage.attemptNumber}`, newlyReadyStages: [] };
    }

    // Save intermediate artifact
    const buf = Buffer.isBuffer(outputBuffer) ? outputBuffer : Buffer.from(outputBuffer);
    const checksum = crypto.createHash('sha256').update(buf).digest('hex');
    const now = Date.now();

    // Compute downstream consumers of this stage's output
    let downstreamConsumerCount = 0;
    for (const s of dagState.stages.values()) {
      if (s.inputArtifactRefs && s.inputArtifactRefs.includes(stage.outputArtifactRef)) {
        downstreamConsumerCount++;
      }
    }

    dagState.artifacts.set(stage.outputArtifactRef, {
      artifactId: stage.outputArtifactRef,
      producingStageId: stageId,
      sizeBytes: buf.length,
      format: 'RAW_BINARY',
      checksumSha256: checksum,
      dataBuffer: buf,
      referenceCount: downstreamConsumerCount,
      isCleanedUp: false,
      createdAtMs: now
    });

    stage.status = 'COMPLETED';
    stage.executionTimeMs = executionTimeMs;

    // Decrement reference count on consumed inputs
    for (const inputRef of stage.inputArtifactRefs) {
      const art = dagState.artifacts.get(inputRef);
      if (art && art.producingStageId !== '__INPUT__') {
        art.referenceCount = Math.max(0, art.referenceCount - 1);
        if (art.referenceCount === 0) {
          art.isCleanedUp = true;
          art.dataBuffer = undefined; // Free memory buffer
        }
      }
    }

    // Check downstream stages whose dependencies are now all COMPLETED
    const newlyReadyStages: DagStage[] = [];
    for (const s of dagState.stages.values()) {
      if (s.status === 'PENDING') {
        const allDepsCompleted = s.dependencies.every(depId => {
          const depStage = dagState.stages.get(depId);
          return depStage && depStage.status === 'COMPLETED';
        });

        if (allDepsCompleted) {
          s.status = 'READY';
          newlyReadyStages.push({ ...s });
        }
      }
    }

    // Check if entire DAG is now complete
    const allCompleted = Array.from(dagState.stages.values()).every(s => s.status === 'COMPLETED');
    if (allCompleted) {
      dagState.completedAtMs = now;
    }

    return { success: true, newlyReadyStages };
  }

  /**
   * Handles stage failure or worker dropout:
   * Reclaims stage to READY for retry without re-running completed parent stages.
   */
  public failStage(
    dagId: string,
    stageId: string,
    error: string,
    workerId: string,
    attemptNumber: number
  ): { status: DagStageStatus; canRetry: boolean } {
    const dagState = this.dags.get(dagId);
    if (!dagState) return { status: 'FAILED', canRetry: false };

    const stage = dagState.stages.get(stageId);
    if (!stage || stage.status === 'COMPLETED') return { status: 'FAILED', canRetry: false };

    stage.error = error;
    if (stage.attemptNumber < this.maxStageAttempts) {
      // Reclaim to READY for reassignment to another worker
      stage.status = 'READY';
      stage.assignedWorkerId = undefined;
      return { status: 'READY', canRetry: true };
    } else {
      stage.status = 'FAILED';
      return { status: 'FAILED', canRetry: false };
    }
  }

  /**
   * Cancels a DAG in-flight, marks active/pending stages CANCELLED, and cleans up intermediate artifacts.
   */
  public cancelDag(dagId: string): boolean {
    const dagState = this.dags.get(dagId);
    if (!dagState) return false;

    dagState.isCancelled = true;
    for (const stage of dagState.stages.values()) {
      if (stage.status === 'PENDING' || stage.status === 'READY' || stage.status === 'RUNNING') {
        stage.status = 'CANCELLED';
      }
    }

    // Clean up all non-terminal intermediate artifact buffers
    for (const art of dagState.artifacts.values()) {
      art.isCleanedUp = true;
      art.dataBuffer = undefined;
    }

    return true;
  }

  public getDagProgress(dagId: string): DagProgress | undefined {
    const dagState = this.dags.get(dagId);
    if (!dagState) return undefined;

    const stages = Array.from(dagState.stages.values());
    const totalStages = stages.length;
    const completedStages = stages.filter(s => s.status === 'COMPLETED').length;
    const runningStages = stages.filter(s => s.status === 'RUNNING').length;
    const pendingStages = stages.filter(s => s.status === 'PENDING' || s.status === 'READY').length;
    const failedStages = stages.filter(s => s.status === 'FAILED').length;

    const percentComplete = totalStages > 0
      ? Number(((completedStages / totalStages) * 100).toFixed(1))
      : 100;

    return {
      dagId,
      totalStages,
      completedStages,
      runningStages,
      pendingStages,
      failedStages,
      percentComplete,
      isCancelled: dagState.isCancelled,
      isCompleted: completedStages === totalStages
    };
  }

  public getArtifact(dagId: string, artifactId: string): DagArtifact | undefined {
    const dagState = this.dags.get(dagId);
    return dagState ? dagState.artifacts.get(artifactId) : undefined;
  }

  public getStage(dagId: string, stageId: string): DagStage | undefined {
    const dagState = this.dags.get(dagId);
    return dagState ? dagState.stages.get(stageId) : undefined;
  }
}
