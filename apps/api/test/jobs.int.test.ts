import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@vf/db';
import type { JobEvent } from '@vf/shared';
import { appRouter } from '../src/index';
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

  it('hides jobs of other users', async () => {
    const { caller, deps } = await startApp();
    const { jobId } = await caller.jobs.enqueueDebug({ durationMs: 2000, steps: 2 });
    const other = appRouter.createCaller({ userId: crypto.randomUUID(), deps });
    await expect(other.jobs.get({ id: jobId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.jobs.cancel({ id: jobId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.jobs.retry({ id: jobId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.jobs.events({ id: jobId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await caller.jobs.get({ id: jobId })).status).not.toBe('cancelled');
    await caller.jobs.cancel({ id: jobId });
  });

  it('feed streams only own events', async () => {
    const { caller, deps } = await startApp();
    const [stranger] = await deps.db.insert(users).values({ name: 'Інший' }).returning();
    const other = appRouter.createCaller({ userId: stranger!.id, deps });
    const feed = await caller.jobs.feed();
    const seen: JobEvent[] = [];
    const reading = (async () => {
      for await (const e of feed) {
        seen.push(e);
        if (e.status === 'done') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    const foreign = await other.jobs.enqueueDebug({ durationMs: 100, steps: 1 });
    await new Promise((r) => setTimeout(r, 300));
    const { jobId } = await caller.jobs.enqueueDebug({ durationMs: 100, steps: 1 });
    await reading;
    expect(seen.every((e) => e.jobId === jobId)).toBe(true);
    expect(seen.some((e) => e.jobId === foreign.jobId)).toBe(false);
    expect(seen.at(-1)).toMatchObject({ jobId, status: 'done', type: 'debug.sleep' });
    await deps.db.delete(users).where(eq(users.id, stranger!.id));
  });

  it('error responses carry no stack trace', async () => {
    const { server } = await startApp();
    const res = await server.inject({
      method: 'GET',
      url: `/trpc/jobs.get?input=${encodeURIComponent(JSON.stringify({ id: crypto.randomUUID() }))}`,
    });
    const body = res.json();
    expect(body.error.data.appCode).toBe('NOT_FOUND');
    expect(body.error.data).not.toHaveProperty('stack');
  });
});
