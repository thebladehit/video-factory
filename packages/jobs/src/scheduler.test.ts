import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntervalScheduler } from './scheduler';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('IntervalScheduler', () => {
  it('runs on start and every interval', async () => {
    const s = createIntervalScheduler();
    const fn = vi.fn(async () => {});
    s.every('x', 1000, fn, { runOnStart: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(4);
    s.stop();
  });

  it('does not overlap a slow run', async () => {
    const s = createIntervalScheduler();
    let active = 0;
    let maxActive = 0;
    const fn = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 2500));
      active--;
    });
    s.every('slow', 1000, fn);
    await vi.advanceTimersByTimeAsync(6000);
    expect(maxActive).toBe(1);
    s.stop();
  });

  it('stop() clears timers', async () => {
    const s = createIntervalScheduler();
    const fn = vi.fn(async () => {});
    s.every('x', 1000, fn);
    s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('logs errors and keeps running', async () => {
    const log = vi.fn();
    const s = createIntervalScheduler(log);
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    s.every('bad', 1000, fn);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bad'), expect.any(Error));
    s.stop();
  });
});
