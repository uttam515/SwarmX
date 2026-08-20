import { expect } from 'chai';
import { ExactMatchValidator, ToleranceAwareNumericValidator, PassThroughValidator } from '../src/result_validator';
import { Task, TaskStatus } from '../src/types';

describe('Result Validator Abstraction Tests', () => {
  const dummyTask: Task = {
    id: 'test-task-1',
    inputRef: 'data://input',
    computationDescriptor: 'test',
    requiredResources: {},
    dependencies: [],
    executionConstraints: {},
    resultDestination: 'data://out',
    retryCount: 0,
    attemptHistory: [],
    status: TaskStatus.RUNNING,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now()
  };

  it('PassThroughValidator: Accepts any result data in Phase 0', () => {
    const validator = new PassThroughValidator();
    const result = validator.validate(dummyTask, 'canned-success');
    expect(result.isValid).to.be.true;
  });

  it('ExactMatchValidator: Verifies exact raw output and deterministic SHA256 hashes', () => {
    const rawValidator = new ExactMatchValidator('exact_output_42');
    expect(rawValidator.validate(dummyTask, 'exact_output_42').isValid).to.be.true;
    expect(rawValidator.validate(dummyTask, 'wrong_output').isValid).to.be.false;

    const expectedPayload = 'deterministic matrix calculation result';
    const crypto = require('crypto');
    const expectedHash = crypto.createHash('sha256').update(expectedPayload).digest('hex');

    const hashValidator = new ExactMatchValidator(expectedHash, true);
    expect(hashValidator.validate(dummyTask, expectedPayload).isValid).to.be.true;
    expect(hashValidator.validate(dummyTask, 'tampered payload').isValid).to.be.false;
  });

  it('ToleranceAwareNumericValidator: Validates numerical results within float epsilon for heterogeneous workers', () => {
    const reference = [1.000, 2.500, 3.1415, 100.0];
    const validator = new ToleranceAwareNumericValidator(reference, 0.01); // 1% tolerance

    // Within tolerance (e.g. slight floating point diff between Apple Silicon and Intel CPU)
    const slightDiff = JSON.stringify([1.002, 2.499, 3.1419, 100.005]);
    const validResult = validator.validate(dummyTask, slightDiff);
    expect(validResult.isValid).to.be.true;

    // Exceeds tolerance
    const badDiff = JSON.stringify([1.000, 2.500, 3.2000, 100.0]);
    const invalidResult = validator.validate(dummyTask, badDiff);
    expect(invalidResult.isValid).to.be.false;
    expect(invalidResult.reason).to.include('Tolerance exceeded');

    // Dimension mismatch
    const wrongLength = JSON.stringify([1.0, 2.5]);
    expect(validator.validate(dummyTask, wrongLength).isValid).to.be.false;
  });
});
