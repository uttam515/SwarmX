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

export interface ImageChunkMetadata {
  parentWorkloadId: string;
  chunkIndex: number;
  totalChunks: number;
  outRowStart: number; // inclusive
  outRowEnd: number;   // exclusive
  outRowCount: number; // outRowEnd - outRowStart
  inRowStart: number;  // inclusive with top halo
  inRowEnd: number;    // exclusive with bottom halo
  inRowCount: number;  // inRowEnd - inRowStart
  topHalo: number;     // outRowStart - inRowStart
  bottomHalo: number;  // inRowEnd - outRowEnd
  width: number;
  height: number;
  channels: number;
  radius: number;
  mode: string;
}

export interface ImageChunkSpec {
  metadata: ImageChunkMetadata;
  payload: Buffer; // inRowCount * width * channels
}

export interface ImageChunkResult {
  parentWorkloadId: string;
  chunkIndex: number;
  totalChunks: number;
  outRowStart: number;
  outRowEnd: number;
  outRowCount: number;
  inRowStart: number;
  inRowEnd: number;
  inRowCount: number;
  topHalo: number;
  bottomHalo: number;
  width: number;
  height: number;
  channels: number;
  radius: number;
  outputBuffer: Buffer;
  workerId?: string;
  executionTimeMs?: number;
}

export class ImageChunkEngine {
  /**
   * Partitions a 2D planar image into `totalChunks` horizontal slices with radius-sized
   * boundary halos to guarantee mathematically exact convolution/blur results.
   */
  public static partitionImageFilter(
    parentWorkloadId: string,
    width: number,
    height: number,
    channels: number,
    mode: string,
    radius: number,
    totalChunks: number,
    imageBuffer: Buffer
  ): ImageChunkSpec[] {
    if (width <= 0 || height <= 0 || channels <= 0) {
      throw new Error(`Invalid image dimensions: ${width}x${height}, channels=${channels}`);
    }
    const expectedBytes = width * height * channels;
    if (imageBuffer.length !== expectedBytes) {
      throw new Error(`Invalid image buffer byte length: expected ${expectedBytes} bytes, got ${imageBuffer.length} bytes.`);
    }

    const actualChunks = Math.min(totalChunks, height);
    const baseRows = Math.floor(height / actualChunks);
    const remainder = height % actualChunks;
    const bytesPerRow = width * channels;

    const chunkSpecs: ImageChunkSpec[] = [];
    let currentOutRow = 0;

    for (let i = 0; i < actualChunks; i++) {
      const outRowCount = baseRows + (i < remainder ? 1 : 0);
      const outRowStart = currentOutRow;
      const outRowEnd = currentOutRow + outRowCount;
      currentOutRow = outRowEnd;

      const inRowStart = Math.max(0, outRowStart - radius);
      const inRowEnd = Math.min(height, outRowEnd + radius);
      const inRowCount = inRowEnd - inRowStart;

      const topHalo = outRowStart - inRowStart;
      const bottomHalo = inRowEnd - outRowEnd;

      const chunkStartByte = inRowStart * bytesPerRow;
      const chunkEndByte = inRowEnd * bytesPerRow;
      const chunkPayload = Buffer.from(imageBuffer.subarray(chunkStartByte, chunkEndByte));

      chunkSpecs.push({
        metadata: {
          parentWorkloadId,
          chunkIndex: i,
          totalChunks: actualChunks,
          outRowStart,
          outRowEnd,
          outRowCount,
          inRowStart,
          inRowEnd,
          inRowCount,
          topHalo,
          bottomHalo,
          width,
          height,
          channels,
          radius,
          mode
        },
        payload: chunkPayload
      });
    }

    return chunkSpecs;
  }

  /**
   * Reassembles independently computed horizontal image chunks by stripping the halo rows
   * and copying only the valid output regions into the final contiguous image buffer.
   */
  public static assembleImageChunks(
    parentWorkloadId: string,
    width: number,
    height: number,
    channels: number,
    chunkResults: ImageChunkResult[]
  ): Buffer {
    if (chunkResults.length === 0) {
      throw new Error(`Cannot assemble image: received 0 chunk results.`);
    }

    const sorted = [...chunkResults].sort((a, b) => a.chunkIndex - b.chunkIndex);
    const totalOutputBytes = width * height * channels;
    const finalBuffer = Buffer.allocUnsafe(totalOutputBytes);
    const bytesPerRow = width * channels;

    let expectedNextRow = 0;

    for (let i = 0; i < sorted.length; i++) {
      const chunk = sorted[i];

      if (chunk.parentWorkloadId !== parentWorkloadId) {
        throw new Error(`Mismatched parentWorkloadId: expected ${parentWorkloadId}, got ${chunk.parentWorkloadId}.`);
      }

      if (chunk.chunkIndex !== i) {
        throw new Error(`Missing or out-of-order chunk index: expected index ${i}, but got ${chunk.chunkIndex}.`);
      }

      if (chunk.outRowStart !== expectedNextRow) {
        throw new Error(`Row gap/overlap in image chunk ${chunk.chunkIndex}: expected row ${expectedNextRow}, got ${chunk.outRowStart}.`);
      }

      const expectedChunkOutputBytes = chunk.inRowCount * bytesPerRow;
      if (chunk.outputBuffer.length !== expectedChunkOutputBytes) {
        throw new Error(
          `Incorrect output byte length in chunk ${chunk.chunkIndex}: expected ${expectedChunkOutputBytes} bytes (${chunk.inRowCount}x${width}x${channels}), got ${chunk.outputBuffer.length} bytes.`
        );
      }

      // Extract valid rows (skip topHalo, take outRowCount)
      const validStartByte = chunk.topHalo * bytesPerRow;
      const validByteLength = chunk.outRowCount * bytesPerRow;
      const validRowsSlice = chunk.outputBuffer.subarray(validStartByte, validStartByte + validByteLength);

      const destOffset = chunk.outRowStart * bytesPerRow;
      validRowsSlice.copy(finalBuffer, destOffset);

      expectedNextRow = chunk.outRowEnd;
    }

    if (expectedNextRow !== height) {
      throw new Error(`Incomplete image coverage: chunks cover up to row ${expectedNextRow}, but height=${height}.`);
    }

    return finalBuffer;
  }
}

export interface VideoChunkMetadata {
  parentWorkloadId: string;
  chunkIndex: number;
  totalChunks: number;
  startFrameIndex: number;
  frameCount: number;
  width: number;
  height: number;
  channels: number;
  mode: string;
}

export interface VideoChunkSpec {
  metadata: VideoChunkMetadata;
  payload: Buffer; // frameCount * width * height * channels
}

export interface VideoChunkResult {
  parentWorkloadId: string;
  chunkIndex: number;
  totalChunks: number;
  startFrameIndex: number;
  frameCount: number;
  outputData: string | any[];
  workerId?: string;
  executionTimeMs?: number;
}

export class VideoChunkEngine {
  /**
   * Partitions sequential video frames into independent chunks for distributed analysis.
   */
  public static partitionVideoFrames(
    parentWorkloadId: string,
    width: number,
    height: number,
    channels: number,
    mode: string,
    totalFrames: number,
    chunkSize: number,
    videoBuffer: Buffer
  ): VideoChunkSpec[] {
    if (width <= 0 || height <= 0 || channels <= 0 || totalFrames <= 0) {
      throw new Error(`Invalid video dimensions: ${width}x${height}x${channels}, totalFrames=${totalFrames}`);
    }
    const frameBytes = width * height * channels;
    const expectedBytes = totalFrames * frameBytes;
    if (videoBuffer.length < expectedBytes) {
      throw new Error(`Invalid video buffer byte length: expected ${expectedBytes} bytes, got ${videoBuffer.length} bytes.`);
    }

    const actualChunkSize = Math.max(1, chunkSize);
    const totalChunks = Math.ceil(totalFrames / actualChunkSize);
    const specs: VideoChunkSpec[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const startFrame = i * actualChunkSize;
      const framesInChunk = Math.min(actualChunkSize, totalFrames - startFrame);
      const startByte = startFrame * frameBytes;
      const endByte = startByte + (framesInChunk * frameBytes);
      const chunkPayload = Buffer.from(videoBuffer.subarray(startByte, endByte));

      specs.push({
        metadata: {
          parentWorkloadId,
          chunkIndex: i,
          totalChunks,
          startFrameIndex: startFrame,
          frameCount: framesInChunk,
          width,
          height,
          channels,
          mode
        },
        payload: chunkPayload
      });
    }

    return specs;
  }

  /**
   * Reassembles and sorts independent per-chunk frame analysis results into a single sequential frame array.
   */
  public static assembleVideoAnalysis(
    parentWorkloadId: string,
    chunkResults: VideoChunkResult[]
  ): any[] {
    if (chunkResults.length === 0) {
      throw new Error('Cannot assemble video analysis: received 0 chunk results.');
    }

    const sorted = [...chunkResults].sort((a, b) => a.chunkIndex - b.chunkIndex);
    const aggregated: any[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const chunk = sorted[i];
      if (chunk.parentWorkloadId !== parentWorkloadId) {
        throw new Error(`Mismatched parentWorkloadId: expected ${parentWorkloadId}, got ${chunk.parentWorkloadId}`);
      }
      if (chunk.chunkIndex !== i) {
        throw new Error(`Missing or out-of-order chunk index: expected index ${i}, got ${chunk.chunkIndex}`);
      }

      let parsedMetrics: any[] = [];
      if (typeof chunk.outputData === 'string') {
        try {
          parsedMetrics = JSON.parse(chunk.outputData);
        } catch {
          try {
            parsedMetrics = JSON.parse(Buffer.from(chunk.outputData, 'base64').toString('utf-8'));
          } catch {
            parsedMetrics = [];
          }
        }
      } else if (Array.isArray(chunk.outputData)) {
        parsedMetrics = chunk.outputData;
      }

      for (const m of parsedMetrics) {
        aggregated.push(m);
      }
    }

    return aggregated;
  }
}
