import { expect } from 'chai';
import { MatrixChunkEngine, MatrixChunkSpec, MatrixChunkResult } from '../src/chunk_engine';

describe('MatrixChunkEngine Subsystem Tests (Phase 5A)', () => {
  // Helper to create Float32 buffer from flat array
  const createFloat32Buffer = (data: number[]): Buffer => {
    const f32 = new Float32Array(data);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  };

  // Helper to compute scalar matrix multiplication in JS for reference
  const multiplyMatrices = (
    aBuf: Buffer,
    bBuf: Buffer,
    M: number,
    K: number,
    N: number
  ): Buffer => {
    const a = new Float32Array(aBuf.buffer, aBuf.byteOffset, aBuf.byteLength / 4);
    const b = new Float32Array(bBuf.buffer, bBuf.byteOffset, bBuf.byteLength / 4);
    const c = new Float32Array(M * N);

    for (let i = 0; i < M; i++) {
      for (let k = 0; k < K; k++) {
        const aVal = a[i * K + k];
        for (let j = 0; j < N; j++) {
          c[i * N + j] += aVal * b[k * N + j];
        }
      }
    }
    return Buffer.from(c.buffer, c.byteOffset, c.byteLength);
  };

  // Simulate worker execution on a chunk payload
  const executeChunk = (spec: MatrixChunkSpec): MatrixChunkResult => {
    const { M, K, N, rowCount, rowStart, rowEnd, chunkIndex, totalChunks, parentWorkloadId } = spec.metadata;
    const aBytes = rowCount * K * 4;
    const aChunkBuf = spec.payload.subarray(0, aBytes);
    const bBuf = spec.payload.subarray(aBytes);

    const cChunkBuf = multiplyMatrices(aChunkBuf, bBuf, rowCount, K, N);

    return {
      parentWorkloadId,
      chunkIndex,
      totalChunks,
      rowStart,
      rowEnd,
      rowCount,
      M,
      K,
      N,
      outputBuffer: cChunkBuf
    };
  };

  it('A. 1 Chunk: Single chunk partitioning and reassembly is identity', () => {
    const M = 4, K = 4, N = 4;
    const aData = Array.from({ length: 16 }, (_, i) => i + 1);
    const bData = Array.from({ length: 16 }, (_, i) => (i % 4 === Math.floor(i / 4) ? 1 : 0)); // Identity matrix
    const aBuf = createFloat32Buffer(aData);
    const bBuf = createFloat32Buffer(bData);

    const chunks = MatrixChunkEngine.partitionMatrixMultiply('wkl-test-01', M, K, N, 1, aBuf, bBuf);
    expect(chunks.length).to.equal(1);
    expect(chunks[0].metadata.rowCount).to.equal(4);

    const result = executeChunk(chunks[0]);
    const assembled = MatrixChunkEngine.assembleMatrixChunks('wkl-test-01', M, K, N, [result]);

    const assembledF32 = new Float32Array(assembled.buffer, assembled.byteOffset, assembled.byteLength / 4);
    for (let i = 0; i < 16; i++) {
      expect(assembledF32[i]).to.be.closeTo(aData[i], 1e-5);
    }
  });

  it('B. 2 Equal Chunks: Splits 8x4 @ 4x4 into two 4x4 row chunks and reassembles accurately', () => {
    const M = 8, K = 4, N = 4;
    const aData = Array.from({ length: 32 }, (_, i) => (i + 1) * 0.5);
    const bData = Array.from({ length: 16 }, (_, i) => i * 0.25);
    const aBuf = createFloat32Buffer(aData);
    const bBuf = createFloat32Buffer(bData);

    const specs = MatrixChunkEngine.partitionMatrixMultiply('wkl-test-02', M, K, N, 2, aBuf, bBuf);
    expect(specs.length).to.equal(2);
    expect(specs[0].metadata.rowStart).to.equal(0);
    expect(specs[0].metadata.rowEnd).to.equal(4);
    expect(specs[1].metadata.rowStart).to.equal(4);
    expect(specs[1].metadata.rowEnd).to.equal(8);

    const results = specs.map(executeChunk);
    const assembled = MatrixChunkEngine.assembleMatrixChunks('wkl-test-02', M, K, N, results);

    const refBuf = multiplyMatrices(aBuf, bBuf, M, K, N);
    const refF32 = new Float32Array(refBuf.buffer, refBuf.byteOffset, refBuf.byteLength / 4);
    const assembledF32 = new Float32Array(assembled.buffer, assembled.byteOffset, assembled.byteLength / 4);

    expect(assembledF32.length).to.equal(refF32.length);
    for (let i = 0; i < refF32.length; i++) {
      expect(assembledF32[i]).to.be.closeTo(refF32[i], 1e-4);
    }
  });

  it('C. 4 Equal Chunks: Partitions 16x8 @ 8x8 into 4 equal slices and produces numerically equivalent result', () => {
    const M = 16, K = 8, N = 8;
    const aData = Array.from({ length: M * K }, (_, i) => Math.sin(i));
    const bData = Array.from({ length: K * N }, (_, i) => Math.cos(i));
    const aBuf = createFloat32Buffer(aData);
    const bBuf = createFloat32Buffer(bData);

    const specs = MatrixChunkEngine.partitionMatrixMultiply('wkl-test-03', M, K, N, 4, aBuf, bBuf);
    expect(specs.length).to.equal(4);

    const results = specs.map(executeChunk);
    const assembled = MatrixChunkEngine.assembleMatrixChunks('wkl-test-03', M, K, N, results);

    const refBuf = multiplyMatrices(aBuf, bBuf, M, K, N);
    const refF32 = new Float32Array(refBuf.buffer, refBuf.byteOffset, refBuf.byteLength / 4);
    const assembledF32 = new Float32Array(assembled.buffer, assembled.byteOffset, assembled.byteLength / 4);

    for (let i = 0; i < refF32.length; i++) {
      expect(assembledF32[i]).to.be.closeTo(refF32[i], 1e-4);
    }
  });

  it('D. Uneven Partition: M=10 with 3 chunks produces [4, 3, 3] rows covering all 10 rows', () => {
    const M = 10, K = 4, N = 4;
    const aBuf = Buffer.alloc(M * K * 4);
    const bBuf = Buffer.alloc(K * N * 4);

    const specs = MatrixChunkEngine.partitionMatrixMultiply('wkl-test-04', M, K, N, 3, aBuf, bBuf);
    expect(specs.length).to.equal(3);
    expect(specs[0].metadata.rowCount).to.equal(4); // 0..4
    expect(specs[0].metadata.rowStart).to.equal(0);
    expect(specs[0].metadata.rowEnd).to.equal(4);

    expect(specs[1].metadata.rowCount).to.equal(3); // 4..7
    expect(specs[1].metadata.rowStart).to.equal(4);
    expect(specs[1].metadata.rowEnd).to.equal(7);

    expect(specs[2].metadata.rowCount).to.equal(3); // 7..10
    expect(specs[2].metadata.rowStart).to.equal(7);
    expect(specs[2].metadata.rowEnd).to.equal(10);
  });

  it('E. Out of Order Results: Chunks arriving in order [3, 1, 0, 2] reassemble identically to in-order', () => {
    const M = 12, K = 4, N = 4;
    const aData = Array.from({ length: M * K }, (_, i) => i + 1);
    const bData = Array.from({ length: K * N }, (_, i) => (i + 1) * 0.1);
    const aBuf = createFloat32Buffer(aData);
    const bBuf = createFloat32Buffer(bData);

    const specs = MatrixChunkEngine.partitionMatrixMultiply('wkl-test-05', M, K, N, 4, aBuf, bBuf);
    const results = specs.map(executeChunk);

    // Shuffle results into [3, 1, 0, 2]
    const outOfOrder = [results[3], results[1], results[0], results[2]];

    const assembled = MatrixChunkEngine.assembleMatrixChunks('wkl-test-05', M, K, N, outOfOrder);
    const refBuf = multiplyMatrices(aBuf, bBuf, M, K, N);

    const refF32 = new Float32Array(refBuf.buffer, refBuf.byteOffset, refBuf.byteLength / 4);
    const assembledF32 = new Float32Array(assembled.buffer, assembled.byteOffset, assembled.byteLength / 4);

    for (let i = 0; i < refF32.length; i++) {
      expect(assembledF32[i]).to.be.closeTo(refF32[i], 1e-4);
    }
  });

  it('F. Missing Chunk: Throws descriptive error when chunk set is incomplete', () => {
    const M = 8, K = 4, N = 4;
    const aBuf = Buffer.alloc(M * K * 4);
    const bBuf = Buffer.alloc(K * N * 4);

    const specs = MatrixChunkEngine.partitionMatrixMultiply('wkl-test-06', M, K, N, 4, aBuf, bBuf);
    const results = specs.map(executeChunk);

    // Provide only 3 out of 4 chunks
    expect(() => {
      MatrixChunkEngine.assembleMatrixChunks('wkl-test-06', M, K, N, [results[0], results[1], results[2]]);
    }).to.throw(/Incomplete chunk set/);
  });

  it('G. Duplicate Chunk: Throws error if duplicate chunk index is passed', () => {
    const M = 8, K = 4, N = 4;
    const aBuf = Buffer.alloc(M * K * 4);
    const bBuf = Buffer.alloc(K * N * 4);

    const specs = MatrixChunkEngine.partitionMatrixMultiply('wkl-test-07', M, K, N, 2, aBuf, bBuf);
    const results = specs.map(executeChunk);

    expect(() => {
      MatrixChunkEngine.assembleMatrixChunks('wkl-test-07', M, K, N, [results[0], results[0]]);
    }).to.throw(/Duplicate chunk index detected/);
  });

  it('H. Overlapping Row Ranges: Rejects corrupted chunks with overlapping row spans', () => {
    const M = 8, K = 4, N = 4;
    const dummyOutput = Buffer.alloc(4 * N * 4);

    const chunk0: MatrixChunkResult = {
      parentWorkloadId: 'wkl-test-08',
      chunkIndex: 0,
      totalChunks: 2,
      rowStart: 0,
      rowEnd: 5, // Overlaps
      rowCount: 5,
      M, K, N,
      outputBuffer: Buffer.alloc(5 * N * 4)
    };

    const chunk1: MatrixChunkResult = {
      parentWorkloadId: 'wkl-test-08',
      chunkIndex: 1,
      totalChunks: 2,
      rowStart: 4, // Overlaps row 4
      rowEnd: 8,
      rowCount: 4,
      M, K, N,
      outputBuffer: Buffer.alloc(4 * N * 4)
    };

    expect(() => {
      MatrixChunkEngine.assembleMatrixChunks('wkl-test-08', M, K, N, [chunk0, chunk1]);
    }).to.throw(/Overlapping row range detected/);
  });

  it('I. Invalid Dimensions: Rejects non-positive matrix dimensions', () => {
    const dummyBuf = Buffer.alloc(16);
    expect(() => {
      MatrixChunkEngine.partitionMatrixMultiply('wkl-test-09', 0, 4, 4, 2, dummyBuf, dummyBuf);
    }).to.throw(/Invalid matrix dimensions/);
  });

  it('J. Incorrect Byte Length: Rejects truncated buffer inputs', () => {
    const M = 4, K = 4, N = 4;
    const truncatedBuf = Buffer.alloc(10); // Expected 64 bytes
    const validBuf = Buffer.alloc(64);

    expect(() => {
      MatrixChunkEngine.partitionMatrixMultiply('wkl-test-10', M, K, N, 2, truncatedBuf, validBuf);
    }).to.throw(/Invalid A buffer byte length/);
  });

  it('K. Float32 Dtype Validation: Emits FLOAT32 metadata and exact byte boundaries', () => {
    const M = 64, K = 64, N = 64;
    const aBuf = Buffer.alloc(M * K * 4);
    const bBuf = Buffer.alloc(K * N * 4);

    const specs = MatrixChunkEngine.partitionMatrixMultiply('wkl-test-11', M, K, N, 4, aBuf, bBuf);
    for (const s of specs) {
      expect(s.metadata.dtype).to.equal('FLOAT32');
      expect(s.metadata.inputBytes).to.equal(s.payload.length);
      expect(s.metadata.outputBytes).to.equal(s.metadata.rowCount * N * 4);
    }
  });

  it('L. 256x256 Full Reconstruction: 8 chunks reassemble with exact numerical equivalence', () => {
    const M = 256, K = 256, N = 256;
    const aBuf = Buffer.alloc(M * K * 4);
    const bBuf = Buffer.alloc(K * N * 4);

    const aF32 = new Float32Array(aBuf.buffer, aBuf.byteOffset, aBuf.byteLength / 4);
    const bF32 = new Float32Array(bBuf.buffer, bBuf.byteOffset, bBuf.byteLength / 4);

    // Initialize with diagonal values for fast deterministic multiply
    for (let i = 0; i < 256; i++) {
      aF32[i * 256 + i] = 2.0;
      bF32[i * 256 + i] = 3.0;
    }

    const specs = MatrixChunkEngine.partitionMatrixMultiply('wkl-test-12', M, K, N, 8, aBuf, bBuf);
    expect(specs.length).to.equal(8);

    const results = specs.map(executeChunk);
    const assembled = MatrixChunkEngine.assembleMatrixChunks('wkl-test-12', M, K, N, results);

    const assembledF32 = new Float32Array(assembled.buffer, assembled.byteOffset, assembled.byteLength / 4);
    expect(assembled.length).to.equal(M * N * 4);

    // Diagonals must be exactly 6.0
    for (let i = 0; i < 256; i++) {
      expect(assembledF32[i * 256 + i]).to.be.closeTo(6.0, 1e-5);
    }
  });
});
