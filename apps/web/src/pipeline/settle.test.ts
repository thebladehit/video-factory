import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitUntilIdle } from './settle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('waitUntilIdle', () => {
  it('resolves true once busy turns false', async () => {
    let busy = true;
    const p = waitUntilIdle(() => busy, { stepMs: 50, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(120);
    busy = false;
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBe(true);
  });

  it('gives up after the timeout instead of waiting forever', async () => {
    const p = waitUntilIdle(() => true, { stepMs: 50, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    await expect(p).resolves.toBe(false);
  });
});
