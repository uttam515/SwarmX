import { expect } from 'chai';
import { DagEngine, DagValidationError } from '../src/dag_engine';
import { KernelRegistry } from '../src/kernel_registry';
import { WorkloadDagDescriptor } from '../src/types';

describe('Multi-Stage DAG Execution & Intermediate Artifact Lifecycle (Milestone 2.3)', () => {
  let dagEngine: DagEngine;
  let registry: KernelRegistry;

  beforeEach(() => {
    registry = KernelRegistry.getInstance();
    dagEngine = new DagEngine(registry);
  });

  it('A. Linear 2-stage DAG: BoxBlur -> GaussianBlur executes with dependency ordering', () => {
    const inputBuf = Buffer.alloc(1024, 100);
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-2stage',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW_PLANAR_RGBA_UINT8', sizeBytes: 1024, dataBuffer: inputBuf }],
      stages: [
        {
          stageId: 'stage-box',
          kernelId: 'image_filter_box_blur_v1',
          parameters: { radius: 2 },
          dependencies: [],
          inputArtifactRefs: ['art-in'],
          outputArtifactRef: 'art-stage1-out',
          status: 'PENDING',
          attemptNumber: 0
        },
        {
          stageId: 'stage-gauss',
          kernelId: 'image_filter_gaussian_blur_v1',
          dependencies: ['stage-box'],
          inputArtifactRefs: ['art-stage1-out'],
          outputArtifactRef: 'art-final-out',
          status: 'PENDING',
          attemptNumber: 0
        }
      ],
      outputArtifactRefs: ['art-final-out']
    };

    dagEngine.registerDag(dag);

    // Initial state: Stage 1 is READY, Stage 2 is PENDING
    const ready1 = dagEngine.getNextReadyStages('dag-2stage');
    expect(ready1.length).to.equal(1);
    expect(ready1[0].stageId).to.equal('stage-box');

    // Assign & complete Stage 1 on Worker 1
    dagEngine.assignStage('dag-2stage', 'stage-box', 'worker-1');
    const stage1Out = Buffer.alloc(1024, 110);
    const complete1 = dagEngine.completeStage('dag-2stage', 'stage-box', stage1Out, 'worker-1', 1, 15);

    expect(complete1.success).to.be.true;
    expect(complete1.newlyReadyStages.length).to.equal(1);
    expect(complete1.newlyReadyStages[0].stageId).to.equal('stage-gauss');

    // Assign & complete Stage 2 on Worker 2
    dagEngine.assignStage('dag-2stage', 'stage-gauss', 'worker-2');
    const stage2Out = Buffer.alloc(1024, 120);
    const complete2 = dagEngine.completeStage('dag-2stage', 'stage-gauss', stage2Out, 'worker-2', 1, 20);

    expect(complete2.success).to.be.true;
    const progress = dagEngine.getDagProgress('dag-2stage')!;
    expect(progress.isCompleted).to.be.true;
    expect(progress.percentComplete).to.equal(100.0);
  });

  it('B. Linear 3-stage DAG completes sequentially', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-3stage',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-0', format: 'RAW', sizeBytes: 512, dataBuffer: Buffer.alloc(512) }],
      stages: [
        { stageId: 's1', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-0'], outputArtifactRef: 'art-1', status: 'PENDING', attemptNumber: 0 },
        { stageId: 's2', kernelId: 'image_filter_gaussian_blur_v1', dependencies: ['s1'], inputArtifactRefs: ['art-1'], outputArtifactRef: 'art-2', status: 'PENDING', attemptNumber: 0 },
        { stageId: 's3', kernelId: 'image_filter_box_blur_v1', dependencies: ['s2'], inputArtifactRefs: ['art-2'], outputArtifactRef: 'art-3', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-3']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-3stage', 's1', 'w1');
    dagEngine.completeStage('dag-3stage', 's1', Buffer.alloc(512), 'w1', 1, 10);

    dagEngine.assignStage('dag-3stage', 's2', 'w2');
    dagEngine.completeStage('dag-3stage', 's2', Buffer.alloc(512), 'w2', 1, 10);

    dagEngine.assignStage('dag-3stage', 's3', 'w1');
    dagEngine.completeStage('dag-3stage', 's3', Buffer.alloc(512), 'w1', 1, 10);

    const progress = dagEngine.getDagProgress('dag-3stage')!;
    expect(progress.completedStages).to.equal(3);
    expect(progress.isCompleted).to.be.true;
  });

  it('C. Branching DAG: Independent branches execute concurrently', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-branch',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 1024, dataBuffer: Buffer.alloc(1024) }],
      stages: [
        { stageId: 's-branch-a', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-a-out', status: 'PENDING', attemptNumber: 0 },
        { stageId: 's-branch-b', kernelId: 'image_filter_gaussian_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-b-out', status: 'PENDING', attemptNumber: 0 },
        { stageId: 's-merge', kernelId: 'image_filter_box_blur_v1', dependencies: ['s-branch-a', 's-branch-b'], inputArtifactRefs: ['art-a-out'], outputArtifactRef: 'art-final', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-final']
    };

    dagEngine.registerDag(dag);

    // Both Branch A and Branch B start in READY concurrently
    const ready = dagEngine.getNextReadyStages('dag-branch');
    expect(ready.length).to.equal(2);
    expect(ready.map(s => s.stageId)).to.include('s-branch-a').and.include('s-branch-b');
  });

  it('D. Dependency ordering: Downstream stage cannot start before all parents complete', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-dep',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 1024, dataBuffer: Buffer.alloc(1024) }],
      stages: [
        { stageId: 's1', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-1', status: 'PENDING', attemptNumber: 0 },
        { stageId: 's2', kernelId: 'image_filter_gaussian_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-2', status: 'PENDING', attemptNumber: 0 },
        { stageId: 's3', kernelId: 'image_filter_box_blur_v1', dependencies: ['s1', 's2'], inputArtifactRefs: ['art-1'], outputArtifactRef: 'art-3', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-3']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-dep', 's1', 'w1');
    dagEngine.completeStage('dag-dep', 's1', Buffer.alloc(1024), 'w1', 1, 10);

    // s1 is complete, but s2 is not yet complete -> s3 MUST NOT be READY
    const ready = dagEngine.getNextReadyStages('dag-dep');
    expect(ready.map(s => s.stageId)).to.not.include('s3');
  });

  it('E. Cycle rejection: Throws DagValidationError when DAG contains cycles', () => {
    const cyclicDag: WorkloadDagDescriptor = {
      dagId: 'dag-cycle',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 1024 }],
      stages: [
        { stageId: 'sA', kernelId: 'image_filter_box_blur_v1', dependencies: ['sB'], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-A', status: 'PENDING', attemptNumber: 0 },
        { stageId: 'sB', kernelId: 'image_filter_box_blur_v1', dependencies: ['sA'], inputArtifactRefs: ['art-A'], outputArtifactRef: 'art-B', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-B']
    };

    expect(() => dagEngine.registerDag(cyclicDag)).to.throw(DagValidationError, /Cyclic dependency/);
  });

  it('F. Missing kernel rejection: Throws DagValidationError on uncertified kernel', () => {
    const invalidDag: WorkloadDagDescriptor = {
      dagId: 'dag-invalid-kernel',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 1024 }],
      stages: [
        { stageId: 's1', kernelId: 'unregistered_mystery_kernel_v9', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-1', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-1']
    };

    expect(() => dagEngine.registerDag(invalidDag)).to.throw(DagValidationError, /not certified/);
  });

  it('G. Stage failure and retry: Reclaims only the failed stage for reassignment', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-retry',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 1024, dataBuffer: Buffer.alloc(1024) }],
      stages: [
        { stageId: 's1', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-1', status: 'PENDING', attemptNumber: 0 },
        { stageId: 's2', kernelId: 'image_filter_gaussian_blur_v1', dependencies: ['s1'], inputArtifactRefs: ['art-1'], outputArtifactRef: 'art-2', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-2']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-retry', 's1', 'w1');
    dagEngine.completeStage('dag-retry', 's1', Buffer.alloc(1024, 150), 'w1', 1, 10);

    // Stage 2 fails on worker-flaky
    dagEngine.assignStage('dag-retry', 's2', 'worker-flaky');
    const fail = dagEngine.failStage('dag-retry', 's2', 'GPU Out of Memory', 'worker-flaky', 1);
    expect(fail.status).to.equal('READY');
    expect(fail.canRetry).to.be.true;

    // Stage 2 is re-assigned to worker-backup (attempt 2)
    const assigned2 = dagEngine.assignStage('dag-retry', 's2', 'worker-backup');
    expect(assigned2.attemptNumber).to.equal(2);
    expect(assigned2.status).to.equal('RUNNING');
  });

  it('H. Worker loss during Stage B: Stage B reclaimed to READY, Stage A stays COMPLETED', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-loss',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 1024, dataBuffer: Buffer.alloc(1024) }],
      stages: [
        { stageId: 'sA', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-A', status: 'PENDING', attemptNumber: 0 },
        { stageId: 'sB', kernelId: 'image_filter_gaussian_blur_v1', dependencies: ['sA'], inputArtifactRefs: ['art-A'], outputArtifactRef: 'art-B', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-B']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-loss', 'sA', 'w1');
    dagEngine.completeStage('dag-loss', 'sA', Buffer.alloc(1024), 'w1', 1, 10);

    dagEngine.assignStage('dag-loss', 'sB', 'worker-lost');
    // Worker lost mid-execution
    dagEngine.failStage('dag-loss', 'sB', 'WORKER_DISCONNECTED', 'worker-lost', 1);

    expect(dagEngine.getStage('dag-loss', 'sA')!.status).to.equal('COMPLETED');
    expect(dagEngine.getStage('dag-loss', 'sB')!.status).to.equal('READY');
  });

  it('I. Reuse of Stage A artifact after Stage B failure: Stage A artifact buffer retained', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-reuse',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 1024, dataBuffer: Buffer.alloc(1024) }],
      stages: [
        { stageId: 'sA', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-A', status: 'PENDING', attemptNumber: 0 },
        { stageId: 'sB', kernelId: 'image_filter_gaussian_blur_v1', dependencies: ['sA'], inputArtifactRefs: ['art-A'], outputArtifactRef: 'art-B', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-B']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-reuse', 'sA', 'w1');
    const stageABuf = Buffer.alloc(1024, 188);
    dagEngine.completeStage('dag-reuse', 'sA', stageABuf, 'w1', 1, 10);

    dagEngine.assignStage('dag-reuse', 'sB', 'w2');
    dagEngine.failStage('dag-reuse', 'sB', 'Temporary Error', 'w2', 1);

    // Verify artifact A is still retained with valid data buffer
    const artA = dagEngine.getArtifact('dag-reuse', 'art-A')!;
    expect(artA.isCleanedUp).to.be.false;
    expect(artA.dataBuffer).to.not.be.undefined;
    expect((artA.dataBuffer as Buffer)[0]).to.equal(188);
  });

  it('J. Duplicate stage result: Rejected with DUPLICATE_RESULT_IGNORED', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-dup',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 512, dataBuffer: Buffer.alloc(512) }],
      stages: [{ stageId: 's1', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-1', status: 'PENDING', attemptNumber: 0 }],
      outputArtifactRefs: ['art-1']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-dup', 's1', 'w1');
    const res1 = dagEngine.completeStage('dag-dup', 's1', Buffer.alloc(512), 'w1', 1, 10);
    expect(res1.success).to.be.true;

    const res2 = dagEngine.completeStage('dag-dup', 's1', Buffer.alloc(512), 'w1', 1, 10);
    expect(res2.success).to.be.false;
    expect(res2.error).to.include('DUPLICATE_RESULT_IGNORED');
  });

  it('K. Stale stage result from previous attempt rejected with STALE_ATTEMPT_IGNORED', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-stale',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 512, dataBuffer: Buffer.alloc(512) }],
      stages: [{ stageId: 's1', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-1', status: 'PENDING', attemptNumber: 0 }],
      outputArtifactRefs: ['art-1']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-stale', 's1', 'w1'); // attempt 1
    dagEngine.failStage('dag-stale', 's1', 'Timeout', 'w1', 1);

    dagEngine.assignStage('dag-stale', 's1', 'w2'); // attempt 2

    // w1 returns late result from attempt 1
    const lateRes = dagEngine.completeStage('dag-stale', 's1', Buffer.alloc(512), 'w1', 1, 500);
    expect(lateRes.success).to.be.false;
    expect(lateRes.error).to.include('STALE_ATTEMPT_IGNORED');
  });

  it('L. Cancellation before execution: Marks all stages CANCELLED', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-cancel-early',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 512 }],
      stages: [{ stageId: 's1', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-1', status: 'PENDING', attemptNumber: 0 }],
      outputArtifactRefs: ['art-1']
    };

    dagEngine.registerDag(dag);
    const cancelled = dagEngine.cancelDag('dag-cancel-early');
    expect(cancelled).to.be.true;

    const progress = dagEngine.getDagProgress('dag-cancel-early')!;
    expect(progress.isCancelled).to.be.true;
    expect(dagEngine.getNextReadyStages('dag-cancel-early').length).to.equal(0);
  });

  it('M. Cancellation during execution: Cancels in-flight stages and frees artifact memory', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-cancel-mid',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 1024, dataBuffer: Buffer.alloc(1024) }],
      stages: [
        { stageId: 's1', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-1', status: 'PENDING', attemptNumber: 0 },
        { stageId: 's2', kernelId: 'image_filter_gaussian_blur_v1', dependencies: ['s1'], inputArtifactRefs: ['art-1'], outputArtifactRef: 'art-2', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-2']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-cancel-mid', 's1', 'w1');
    dagEngine.completeStage('dag-cancel-mid', 's1', Buffer.alloc(1024), 'w1', 1, 10);
    dagEngine.assignStage('dag-cancel-mid', 's2', 'w2');

    dagEngine.cancelDag('dag-cancel-mid');

    const progress = dagEngine.getDagProgress('dag-cancel-mid')!;
    expect(progress.isCancelled).to.be.true;

    const art1 = dagEngine.getArtifact('dag-cancel-mid', 'art-1')!;
    expect(art1.isCleanedUp).to.be.true;
    expect(art1.dataBuffer).to.be.undefined;
  });

  it('N. Intermediate artifact cleanup: Frees intermediate buffer when reference count reaches 0', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-cleanup',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 1024, dataBuffer: Buffer.alloc(1024) }],
      stages: [
        { stageId: 's1', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-1', status: 'PENDING', attemptNumber: 0 },
        { stageId: 's2', kernelId: 'image_filter_gaussian_blur_v1', dependencies: ['s1'], inputArtifactRefs: ['art-1'], outputArtifactRef: 'art-2', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-2']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-cleanup', 's1', 'w1');
    dagEngine.completeStage('dag-cleanup', 's1', Buffer.alloc(1024, 200), 'w1', 1, 10);

    // Artifact 1 is created with referenceCount = 1 (consumed by Stage 2)
    const art1Before = dagEngine.getArtifact('dag-cleanup', 'art-1')!;
    expect(art1Before.referenceCount).to.equal(1);
    expect(art1Before.isCleanedUp).to.be.false;

    // Stage 2 consumes Artifact 1 and completes
    dagEngine.assignStage('dag-cleanup', 's2', 'w2');
    dagEngine.completeStage('dag-cleanup', 's2', Buffer.alloc(1024, 210), 'w2', 1, 15);

    // Reference count on Artifact 1 drops to 0 -> Buffer is freed
    const art1After = dagEngine.getArtifact('dag-cleanup', 'art-1')!;
    expect(art1After.referenceCount).to.equal(0);
    expect(art1After.isCleanedUp).to.be.true;
    expect(art1After.dataBuffer).to.be.undefined;
  });

  it('O. Persistent progress tracking reflects stage metrics accurately', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-metrics',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 512 }],
      stages: [
        { stageId: 's1', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-1', status: 'PENDING', attemptNumber: 0 },
        { stageId: 's2', kernelId: 'image_filter_gaussian_blur_v1', dependencies: ['s1'], inputArtifactRefs: ['art-1'], outputArtifactRef: 'art-2', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-2']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-metrics', 's1', 'w1');

    const progRunning = dagEngine.getDagProgress('dag-metrics')!;
    expect(progRunning.totalStages).to.equal(2);
    expect(progRunning.runningStages).to.equal(1);
    expect(progRunning.completedStages).to.equal(0);
    expect(progRunning.percentComplete).to.equal(0);
  });

  it('P. Concurrent independent stages: Branch A and Branch B complete independently', () => {
    const dag: WorkloadDagDescriptor = {
      dagId: 'dag-concurrent',
      version: '1.0.0',
      inputArtifacts: [{ artifactId: 'art-in', format: 'RAW', sizeBytes: 1024, dataBuffer: Buffer.alloc(1024) }],
      stages: [
        { stageId: 'sA', kernelId: 'image_filter_box_blur_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-A', status: 'PENDING', attemptNumber: 0 },
        { stageId: 'sB', kernelId: 'matrix_multiply_v1', dependencies: [], inputArtifactRefs: ['art-in'], outputArtifactRef: 'art-B', status: 'PENDING', attemptNumber: 0 }
      ],
      outputArtifactRefs: ['art-A', 'art-B']
    };

    dagEngine.registerDag(dag);
    dagEngine.assignStage('dag-concurrent', 'sA', 'w-gpu-mac');
    dagEngine.assignStage('dag-concurrent', 'sB', 'w-win-cpu');

    dagEngine.completeStage('dag-concurrent', 'sA', Buffer.alloc(1024), 'w-gpu-mac', 1, 12);
    dagEngine.completeStage('dag-concurrent', 'sB', Buffer.alloc(1024), 'w-win-cpu', 1, 30);

    const progress = dagEngine.getDagProgress('dag-concurrent')!;
    expect(progress.isCompleted).to.be.true;
    expect(progress.completedStages).to.equal(2);
  });
});
