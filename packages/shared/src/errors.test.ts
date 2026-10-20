import { describe, expect, it } from 'vitest';
import { AppError, isAppError, parseModelRef } from './index';

describe('AppError', () => {
  it('serializes code, message and details', () => {
    expect(new AppError('MODEL_NOT_FOUND', 'x', { ref: 'a/b' }).toJSON()).toEqual({
      code: 'MODEL_NOT_FOUND',
      message: 'x',
      details: { ref: 'a/b' },
    });
  });

  it('isAppError distinguishes plain errors', () => {
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(new AppError('INTERNAL', 'x'))).toBe(true);
  });
});

describe('parseModelRef', () => {
  it('splits provider and model', () => {
    expect(parseModelRef('anthropic/claude-sonnet-5-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it.each(['nope', 'groq/x', 'anthropic/'])('rejects %s with VALIDATION', (ref) => {
    expect(() => parseModelRef(ref)).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });
});
