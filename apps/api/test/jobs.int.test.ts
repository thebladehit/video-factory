import { describe, expect, it } from 'vitest';
import type { JobEvent } from '@vf/shared';
import { startApp } from './helpers';

type Caller = Awaited<ReturnType<typeof startApp>>['caller'];

async function collect(caller: Caller, id: string, onEvent?: (e: JobEvent) => void) {
  const events: JobEvent[] = [];
  for await (const e of await caller.jobs.events({ id })) {
    events.push(e);
    onEvent?.(e);
  }
  return events;
}

describe('jobs', () => {
  it('streams progress until done', async () => {
    const { caller } = await startApp();
    const { jobId } = await caller.jobs.enqueueDebug({ durationMs: 300, steps: 3 });
    const events = await collect(caller, jobId);
    expect(events.at(-1)).toMatchObject({ status: 'done', progress: 100 });
    const progress = events.map((e) => e.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('subscription to a finished job yields one snapshot and completes', async () => {
    const { caller } = await startApp();
    const { jobId } = await caller.jobs.enqueueDebug({ durationMs: 100, steps: 1 });
    await collect(caller, jobId);
    const started = Date.now();
    const events = await collect(caller, jobId);
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe('done');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('cancel ends with cancelled and retry enqueues a new job', async () => {
    const { caller } = await startApp();
    const { jobId } = await caller.jobs.enqueueDebug({ durationMs: 5000, steps: 50 });
    const events = await collect(caller, jobId, (e) => {
      if (e.status === 'running') void caller.jobs.cancel({ id: jobId });
    });
    expect(events.at(-1)!.status).toBe('cancelled');
    const again = await caller.jobs.retry({ id: jobId });
    expect(again.jobId).not.toBe(jobId);
    await caller.jobs.cancel({ id: again.jobId });
  });

  it('get of an unknown job is NOT_FOUND', async () => {
    const { caller } = await startApp();
    await expect(caller.jobs.get({ id: crypto.randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
