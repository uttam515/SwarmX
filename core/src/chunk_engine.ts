/**
 * SwarmX Matrix Multiplication Chunking & Reassembly Subsystem (Phase 5A).
 * 
 * Provides mathematically exact row-wise partitioning of A in A[M x K] * B[K x N] = C[M x N]
 * and deterministic reassembly of independently executed chunk results.
 */

export interface MatrixChunkMetadata {
  parentWorkloadId: string;
  chunkIndex: number;
  totalChunks: number;
  rowStart: number; // inclusive
  rowEnd: number;   // exclusive
  rowCount: number; // M_chunk = rowEnd - rowStart
  M: number;
  K: number;
  N: number;
  dtype: 'FLOAT32';
  inputBytes: number;
  outputBytes: number;
}

export interface MatrixChunkSpec {
  metadata: MatrixChunkMetadata;
  payload: Buffer; // Raw binary payload: A_chunk (rowCount * K * 4) + B (K * N * 4)
}

export interface MatrixChunkResult {
  parentWorkloadId: string;
  chunkIndex: number;
  totalChunks: number;
  rowStart: number;
  rowEnd: number;
  rowCount: number;
  M: number;
  K: number;
  N: number;
  outputBuffer: Buffer; // Raw binary result: C_chunk (rowCount * N * 4)
  workerId?: string;
  executionTimeMs?: number;
}

export class MatrixChunkEngine {
  /**
   * Partitions matrix A[M x K] into `totalChunks` row-wise slices and constructs
   * individual chunk payloads: A_chunk[rowCount x K] + B[K x N].
   *
   * Row partitioning is guaranteed to:
   * - Preserve row ordering
   * - Cover every row exactly once
   * - Never overlap rows or omit rows
   * - Evenly distribute remainder rows across the earliest chunks
   */
  public static partitionMatrixMultiply(
    parentWorkloadId: string,
    M: number,
    K: number,
    N: number,
    totalChunks: number,
    aBuffer: Buffer,
    bBuffer: Buffer
  ): MatrixChunkSpec[] {
    if (M <= 0 || K <= 0 || N <= 0) {
      throw new Error(`Invalid matrix dimensions: M=${M}, K=${K}, N=${N}. All dimensions must be > 0.`);
    }

    if (totalChunks <= 0) {
      throw new Error(`Invalid totalChunks: ${totalChunks}. Must be >= 1.`);
    }

    // Clamp totalChunks to M so no chunk has 0 rows
    const actualChunks = Math.min(totalChunks, M);

    const expectedABytes = M * K * 4;
    const expectedBBytes = K * N * 4;

    if (aBuffer.length !== expectedABytes) {
      throw new Error(
        `Invalid A buffer byte length: expected ${expectedABytes} bytes (${M}x${K} Float32), got ${aBuffer.length} bytes.`
      );
    }

    if (bBuffer.length !== expectedBBytes) {
      throw new Error(
        `Invalid B buffer byte length: expected ${expectedBBytes} bytes (${K}x${N} Float32), got ${bBuffer.length} bytes.`
      );
    }

    const baseRows = Math.floor(M / actualChunks);
    const remainder = M % actualChunks;

    const chunkSpecs: MatrixChunkSpec[] = [];
    let currentRow = 0;

    for (let i = 0; i < actualChunks; i++) {
      const chunkRowCount = baseRows + (i < remainder ? 1 : 0);
      const rowStart = currentRow;
      const rowEnd = currentRow + chunkRowCount;
      currentRow = rowEnd;

      const aOffset = rowStart * K * 4;
      const aChunkBytes = chunkRowCount * K * 4;
      const aSlice = aBuffer.subarray(aOffset, aOffset + aChunkBytes);

      // Memory note: bBuffer is shared across chunks in memory; concatenation produces the exact contiguous worker wire frame.
      const payload = Buffer.concat([aSlice, bBuffer]);
      const outputBytes = chunkRowCount * N * 4;

      const metadata: MatrixChunkMetadata = {
        parentWorkloadId,
        chunkIndex: i,
        totalChunks: actualChunks,
        rowStart,
        rowEnd,
        rowCount: chunkRowCount,
        M,
        K,
        N,
        dtype: 'FLOAT32',
        inputBytes: payload.length,
        outputBytes
      };

      chunkSpecs.push({
        metadata,
        payload
      });
    }

    return chunkSpecs;
  }

  /**
   * Reassembles out-of-order chunk results into a contiguous Float32 matrix buffer C[M x N].
   *
   * Strict validation guarantees:
   * - Every expected chunk is present
   * - No duplicate chunks
   * - Zero gaps and zero overlapping row ranges
   * - Exact byte lengths match Float32 specifications
   */
  public static assembleMatrixChunks(
    parentWorkloadId: string,
    M: number,
    K: number,
    N: number,
    results: MatrixChunkResult[]
  ): Buffer {
    if (!results || results.length === 0) {
      throw new Error(`Cannot assemble matrix: no chunk results provided for ${parentWorkloadId}.`);
    }

    const expectedTotal = results[0].totalChunks;
    if (results.length !== expectedTotal) {
      throw new Error(
        `Incomplete chunk set for ${parentWorkloadId}: expected ${expectedTotal} chunks, received ${results.length}.`
      );
    }

    // Sort results by chunkIndex to handle arbitrary arrival ordering
    const sorted = [...results].sort((a, b) => a.chunkIndex - b.chunkIndex);

    const seenIndices = new Set<number>();
    let expectedNextRow = 0;

    // Validate chunk set integrity
    for (let i = 0; i < sorted.length; i++) {
      const chunk = sorted[i];

      if (chunk.parentWorkloadId !== parentWorkloadId) {
        throw new Error(
          `Mismatched parentWorkloadId: expected ${parentWorkloadId}, got ${chunk.parentWorkloadId}.`
        );
      }

      if (chunk.M !== M || chunk.K !== K || chunk.N !== N) {
        throw new Error(
          `Dimension mismatch in chunk ${chunk.chunkIndex}: expected (${M}x${K}x${N}), got (${chunk.M}x${chunk.K}x${chunk.N}).`
        );
      }

      if (seenIndices.has(chunk.chunkIndex)) {
        throw new Error(`Duplicate chunk index detected: ${chunk.chunkIndex}.`);
      }
      seenIndices.add(chunk.chunkIndex);

      if (chunk.chunkIndex !== i) {
        throw new Error(`Missing chunk index: expected index ${i}, but found index ${chunk.chunkIndex}.`);
      }

      if (chunk.rowStart !== expectedNextRow) {
        if (chunk.rowStart < expectedNextRow) {
          throw new Error(
            `Overlapping row range detected in chunk ${chunk.chunkIndex}: starts at row ${chunk.rowStart} but previous ended at ${expectedNextRow}.`
          );
        } else {
          throw new Error(
            `Gap in row range detected before chunk ${chunk.chunkIndex}: expected row ${expectedNextRow}, got row ${chunk.rowStart}.`
          );
        }
      }

      const expectedRowCount = chunk.rowEnd - chunk.rowStart;
      if (chunk.rowCount !== expectedRowCount) {
        throw new Error(
          `Inconsistent rowCount in chunk ${chunk.chunkIndex}: rowCount=${chunk.rowCount}, but rowEnd-rowStart=${expectedRowCount}.`
        );
      }

      const expectedOutputBytes = chunk.rowCount * N * 4;
      if (chunk.outputBuffer.length !== expectedOutputBytes) {
        throw new Error(
          `Incorrect output byte length in chunk ${chunk.chunkIndex}: expected ${expectedOutputBytes} bytes (${chunk.rowCount}x${N} Float32), got ${chunk.outputBuffer.length} bytes.`
        );
      }

      expectedNextRow = chunk.rowEnd;
    }

    if (expectedNextRow !== M) {
      throw new Error(`Incomplete matrix coverage: chunks cover up to row ${expectedNextRow}, but M=${M}.`);
    }

    // Allocate final destination buffer of size M x N x 4 bytes
    const totalOutputBytes = M * N * 4;
    const finalBuffer = Buffer.allocUnsafe(totalOutputBytes);

    for (const chunk of sorted) {
      const destOffset = chunk.rowStart * N * 4;
      chunk.outputBuffer.copy(finalBuffer, destOffset);
    }

    return finalBuffer;
  }
}
