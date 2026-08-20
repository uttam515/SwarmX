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
