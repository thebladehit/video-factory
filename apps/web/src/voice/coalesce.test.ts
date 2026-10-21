import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventCoalescer } from './coalesce';

describe('createEventCoalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const onProgress = vi.fn();
    const onTerminal = vi.fn();
    return { c: createEventCoalescer({ delayMs: 200, onProgress, onTerminal }), onProgress, onTerminal };
  };

  it('coalesces progress events into one progress refetch', () => {
    const { c, onProgress, onTerminal } = make();
    c.push(false);
    c.push(false);
    vi.advanceTimersByTime(200);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('a later progress event does not swallow a pending terminal refetch', () => {
    const { c, onProgress, onTerminal } = make();
    c.push(true);
    vi.advanceTimersByTime(100);
    c.push(false);
    vi.advanceTimersByTime(200);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
    // флаг скидається після виконання
    c.push(false);
    vi.advanceTimersByTime(200);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels the pending call', () => {
    const { c, onProgress, onTerminal } = make();
    c.push(true);
    c.dispose();
    vi.advanceTimersByTime(500);
    expect(onProgress).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });
});
