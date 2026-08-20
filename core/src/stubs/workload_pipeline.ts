/**
 * ============================================================================
 * PHASE 0 STUB — WORKLOAD PIPELINE INTERFACE
 * ============================================================================
 * Out of scope for Phase 0.
 * In Phase 1 & 2, this pipeline handles workload detection, static analysis,
 * graph decomposition into Task DAGs, and result aggregation/validation.
 * ============================================================================
 */

import { Task } from '../types';

export interface WorkloadDescriptor {
  sourceType: string;
  sourceUri: string;
  parameters: Record<string, any>;
}

export interface IWorkloadPipeline {
  decomposeWorkload(descriptor: WorkloadDescriptor): Task[];
  validateResult(taskId: string, resultData: Buffer): boolean;
  aggregateResults(completedTasks: Task[]): any;
}

export class WorkloadPipelineStub implements IWorkloadPipeline {
  public decomposeWorkload(_descriptor: WorkloadDescriptor): Task[] {
    // PHASE 0 STUB: Workload decomposition implemented in Phase 1
    return [];
  }

  public validateResult(_taskId: string, _resultData: Buffer): boolean {
    // PHASE 0 STUB: Result validation pass-through
    return true;
  }

  public aggregateResults(_completedTasks: Task[]): any {
    // PHASE 0 STUB: Result aggregation implemented in Phase 1
    return { status: 'aggregated_stub', count: _completedTasks.length };
  }
}
