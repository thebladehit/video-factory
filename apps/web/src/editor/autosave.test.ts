import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyTimeline, type TimelineDoc } from '@vf/shared';
import { addClip } from '@vf/timeline';
import { Autosave, type SaveState } from './autosave';

const doc = (n: number): TimelineDoc => ({ ...emptyTimeline('9:16'), fps: 30, width: 1080 + n * 2 });

function setup(save: (doc: TimelineDoc, base: number) => Promise<{ version: number }>) {
  const states: SaveState[] = [];
  const a = new Autosave({ save, debounceMs: 1500, version: 1, onState: (s) => states.push(s) });
  return { a, states };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Autosave', () => {
  it('saves once 1.5s after the last change', async () => {
    const save = vi.fn(async (_d: TimelineDoc, base: number) => ({ version: base + 1 }));
    const { a, states } = setup(save);
    a.change(doc(1));
    await vi.advanceTimersByTimeAsync(1000);
    a.change(doc(2));
    await vi.advanceTimersByTimeAsync(1499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(doc(2), 1);
    expect(states).toEqual(['saving', 'saved']);
    expect(a.hasPending()).toBe(false);
  });

  it('change during an in-flight save triggers one more save with the version returned by the first', async () => {
    let release!: () => void;
    const calls: [TimelineDoc, number][] = [];
    const save = vi.fn(async (d: TimelineDoc, base: number) => {
      calls.push([d, base]);
      if (calls.length === 1) await new Promise<void>((r) => (release = r));
      return { version: base + 1 };
    });
    const { a } = setup(save);
    a.change(doc(1));
    await vi.advanceTimersByTimeAsync(1500);
    a.change(doc(2));
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(a.hasPending()).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([
      [doc(1), 1],
      [doc(2), 2],
    ]);
    expect(a.hasPending()).toBe(false);
  });

  it('CONFLICT → state conflict and no retry loop', async () => {
    const save = vi.fn(async () => {
      throw Object.assign(new Error('Проєкт змінено в іншій вкладці'), { data: { code: 'CONFLICT' } });
    });
    const { a, states } = setup(save);
    a.change(doc(1));
    await vi.advanceTimersByTimeAsync(1500);
    a.change(doc(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('conflict');
    expect(a.hasPending()).toBe(true);
  });

  it('overwrite after conflict: setVersion + flush saves the latest doc', async () => {
    let fail = true;
    const save = vi.fn(async (_d: TimelineDoc, base: number) => {
      if (fail) throw Object.assign(new Error('c'), { data: { code: 'CONFLICT' } });
      return { version: base + 1 };
    });
    const { a, states } = setup(save);
    a.change(doc(1));
    await vi.advanceTimersByTimeAsync(1500);
    fail = false;
    a.setVersion(7);
    await a.flush();
    expect(save).toHaveBeenLastCalledWith(doc(1), 7);
    expect(states.at(-1)).toBe('saved');
  });

  it('network error → state error, next change retries', async () => {
    let fail = true;
    const save = vi.fn(async (_d: TimelineDoc, base: number) => {
      if (fail) throw new Error('fetch failed');
      return { version: base + 1 };
    });
    const { a, states } = setup(save);
    a.change(doc(1));
    await vi.advanceTimersByTimeAsync(1500);
    expect(states.at(-1)).toBe('error');
    expect(a.hasPending()).toBe(true);
    fail = false;
    a.change(doc(2));
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenLastCalledWith(doc(2), 1);
    expect(states.at(-1)).toBe('saved');
  });

  it('flush saves immediately', async () => {
    const save = vi.fn(async (_d: TimelineDoc, base: number) => ({ version: base + 1 }));
    const { a } = setup(save);
    a.change(doc(1));
    await a.flush();
    expect(save).toHaveBeenCalledWith(doc(1), 1);
    expect(a.hasPending()).toBe(false);
  });

  it('does not save while the doc has local: asset ids', async () => {
    const save = vi.fn(async (_d: TimelineDoc, base: number) => ({ version: base + 1 }));
    const { a } = setup(save);
    const local = addClip(emptyTimeline('9:16'), { id: 'local:u1', kind: 'image' }, { at: 0 }).doc;
    a.change(local);
    await vi.advanceTimersByTimeAsync(5000);
    await a.flush();
    expect(save).not.toHaveBeenCalled();
    expect(a.hasPending()).toBe(true);
  });
});
