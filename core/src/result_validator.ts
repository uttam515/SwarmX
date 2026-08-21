import { Task, ValidationResult, IResultValidator } from './types';
import * as crypto from 'crypto';

/**
 * Default pass-through validator for Phase 0.
 */
export class PassThroughValidator implements IResultValidator {
  public validate(_task: Task, _resultData: Buffer | string): ValidationResult {
    return { isValid: true };
  }
}

/**
 * Deterministic hash/string match validator.
 */
export class ExactMatchValidator implements IResultValidator {
  private expectedHashOrOutput: string;
  private isHash: boolean;

  constructor(expectedHashOrOutput: string, isHash: boolean = false) {
    this.expectedHashOrOutput = expectedHashOrOutput;
    this.isHash = isHash;
  }

  public validate(_task: Task, resultData: Buffer | string): ValidationResult {
    const raw = Buffer.isBuffer(resultData) ? resultData.toString('utf-8') : resultData;
    if (this.isHash) {
      const computedHash = crypto.createHash('sha256').update(resultData).digest('hex');
      const matches = computedHash.toLowerCase() === this.expectedHashOrOutput.toLowerCase();
      return {
        isValid: matches,
        reason: matches ? undefined : `Hash mismatch: expected ${this.expectedHashOrOutput}, got ${computedHash}`,
        details: { expectedHash: this.expectedHashOrOutput, actualHash: computedHash }
      };
    } else {
      const matches = raw === this.expectedHashOrOutput;
      return {
        isValid: matches,
        reason: matches ? undefined : 'Output payload does not match expected result string'
      };
    }
  }
}

/**
 * Tolerance-Aware Numeric Validator for heterogeneous hardware:
 * Compares numeric array or object outputs against reference values within epsilon tolerance.
 */
export class ToleranceAwareNumericValidator implements IResultValidator {
  private referenceValues: number[];
  private epsilon: number;

  constructor(referenceValues: number[], epsilon: number = 1e-4) {
    this.referenceValues = referenceValues;
    this.epsilon = epsilon;
  }

  public validate(_task: Task, resultData: Buffer | string): ValidationResult {
    try {
      const str = Buffer.isBuffer(resultData) ? resultData.toString('utf-8') : resultData;
      const parsed = JSON.parse(str);
      const actualValues: number[] = Array.isArray(parsed) ? parsed : (parsed.values || []);

      if (actualValues.length !== this.referenceValues.length) {
        return {
          isValid: false,
          reason: `Dimension mismatch: expected ${this.referenceValues.length} elements, got ${actualValues.length}`
        };
      }

      let maxDiff = 0;
      for (let i = 0; i < this.referenceValues.length; i++) {
        const diff = Math.abs(actualValues[i] - this.referenceValues[i]);
        if (diff > maxDiff) maxDiff = diff;
        if (diff > this.epsilon) {
          return {
            isValid: false,
            reason: `Tolerance exceeded at index ${i}: |${actualValues[i]} - ${this.referenceValues[i]}| = ${diff} > ${this.epsilon}`,
            details: { index: i, expected: this.referenceValues[i], actual: actualValues[i], diff, epsilon: this.epsilon }
          };
        }
      }

      return {
        isValid: true,
        details: { maxDifference: maxDiff, epsilon: this.epsilon }
      };
    } catch (err: any) {
      return {
        isValid: false,
        reason: `Failed to parse numeric output JSON: ${err.message}`
      };
    }
  }
}

/**
 * Cross-Hardware Image Tolerance Validator (Phase 1):
 * Validates image buffers against reference outputs allowing for small rounding/floating-point
 * differences across Apple GPU, Qualcomm DSP, Exynos, and x86 SIMD vector paths.
 */
export class ToleranceAwareImageValidator implements IResultValidator {
  private referencePixels: Buffer | Uint8Array;
  private maxPixelDelta: number; // e.g. 2 (out of 255)
  private maxMse: number;        // e.g. 0.5

  constructor(
    referencePixels: Buffer | Uint8Array,
    maxPixelDelta: number = 2,
    maxMse: number = 0.5
  ) {
    this.referencePixels = referencePixels;
    this.maxPixelDelta = maxPixelDelta;
    this.maxMse = maxMse;
  }

  public validate(_task: Task, resultData: Buffer | string): ValidationResult {
    const actualBytes: Buffer = Buffer.isBuffer(resultData)
      ? resultData
      : Buffer.from(resultData, 'base64');

    if (actualBytes.length !== this.referencePixels.length) {
      return {
        isValid: false,
        reason: `Image buffer size mismatch: expected ${this.referencePixels.length} bytes, got ${actualBytes.length} bytes`,
        details: { expectedBytes: this.referencePixels.length, actualBytes: actualBytes.length }
      };
    }

    let maxDiff = 0;
    let sumSquaredError = 0;
    let exceededPixelsCount = 0;

    for (let i = 0; i < actualBytes.length; i++) {
      const diff = Math.abs(actualBytes[i] - this.referencePixels[i]);
      if (diff > maxDiff) maxDiff = diff;
      sumSquaredError += diff * diff;

      if (diff > this.maxPixelDelta) {
        exceededPixelsCount++;
      }
    }

    const mse = sumSquaredError / actualBytes.length;

    if (maxDiff > this.maxPixelDelta || mse > this.maxMse) {
      return {
        isValid: false,
        reason: `Image tolerance exceeded: maxDelta ${maxDiff} > ${this.maxPixelDelta} or MSE ${mse.toFixed(4)} > ${this.maxMse}`,
        details: {
          maxPixelDelta: maxDiff,
          thresholdDelta: this.maxPixelDelta,
          mse: parseFloat(mse.toFixed(4)),
          thresholdMse: this.maxMse,
          exceededPixelsCount,
          totalPixels: actualBytes.length
        }
      };
    }

    return {
      isValid: true,
      details: {
        maxPixelDelta: maxDiff,
        mse: parseFloat(mse.toFixed(4)),
        totalPixels: actualBytes.length
      }
    };
  }
}

/**
 * Cross-Hardware Tolerance-Aware Matrix / Float32 Validator:
 * Validates binary Float32 buffers against dimensions and numerical tolerance:
 * - Validates exact byte size matching M x N x 4
 * - Verifies all values are finite (no NaN or Inf)
 * - Validates relative and absolute error against reference if provided: |actual - expected| <= atol + rtol * |expected|
 */
export class ToleranceAwareMatrixValidator implements IResultValidator {
  private referenceBytes?: Buffer | Uint8Array;
  private atol: number;
  private rtol: number;

  constructor(
    referenceBytes?: Buffer | Uint8Array,
    atol: number = 1e-4,
    rtol: number = 1e-4
  ) {
    this.referenceBytes = referenceBytes;
    this.atol = atol;
    this.rtol = rtol;
  }

  public validate(task: Task, resultData: Buffer | string): ValidationResult {
    const actualBytes: Buffer = Buffer.isBuffer(resultData)
      ? resultData
      : Buffer.from(resultData, 'base64');

    if (actualBytes.length % 4 !== 0) {
      return {
        isValid: false,
        reason: `Invalid Float32 buffer size: ${actualBytes.length} is not a multiple of 4 bytes`
      };
    }

    let params: { M?: number; N?: number; K?: number } = {};
    try {
      const desc = JSON.parse(task.computationDescriptor);
      if (desc.parameters) params = desc.parameters;
    } catch (e) {}

    const { M, N } = params;
    if (M && N) {
      const expectedLen = M * N * 4;
      if (actualBytes.length !== expectedLen) {
        return {
          isValid: false,
          reason: `Matrix buffer size mismatch: expected ${expectedLen} bytes for ${M}x${N} float32, got ${actualBytes.length} bytes`,
          details: { expectedBytes: expectedLen, actualBytes: actualBytes.length }
        };
      }
    }

    const floatCount = actualBytes.length / 4;
    const floatView = actualBytes.byteOffset % 4 === 0
      ? new Float32Array(actualBytes.buffer, actualBytes.byteOffset, floatCount)
      : new Float32Array(actualBytes.buffer.slice(actualBytes.byteOffset, actualBytes.byteOffset + floatCount * 4));

    // 1. Check finite values
    for (let i = 0; i < floatView.length; i++) {
      if (!Number.isFinite(floatView[i])) {
        return {
          isValid: false,
          reason: `Non-finite float value (NaN/Infinity) encountered at index ${i}`
        };
      }
    }

    // 2. Tolerance comparison against reference
    if (this.referenceBytes) {
      const refCount = this.referenceBytes.length / 4;
      if (floatCount !== refCount) {
        return {
          isValid: false,
          reason: `Element count mismatch: expected ${refCount}, got ${floatCount}`
        };
      }

      const refView = new Float32Array(
        this.referenceBytes.buffer,
        this.referenceBytes.byteOffset,
        refCount
      );

      let maxDiff = 0;
      let sumSquaredError = 0;
      for (let i = 0; i < floatCount; i++) {
        const diff = Math.abs(floatView[i] - refView[i]);
        const tol = this.atol + this.rtol * Math.abs(refView[i]);
        if (diff > maxDiff) maxDiff = diff;
        sumSquaredError += diff * diff;

        if (diff > tol) {
          return {
            isValid: false,
            reason: `Matrix numerical tolerance exceeded at index ${i}: |${floatView[i]} - ${refView[i]}| = ${diff} > ${tol}`,
            details: { index: i, actual: floatView[i], expected: refView[i], diff, tolerance: tol }
          };
        }
      }

      const mse = sumSquaredError / floatCount;
      return {
        isValid: true,
        details: { maxAbsoluteError: maxDiff, mse, elementCount: floatCount }
      };
    }

    return {
      isValid: true,
      details: { elementCount: floatCount, finiteCheck: true, shape: M && N ? `${M}x${N}` : 'N/A' }
    };
  }
}
