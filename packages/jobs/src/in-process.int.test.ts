import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, jobs } from '@vf/db';
import { LOCAL_USER_ID, type JobEvent, type JobType } from '@vf/shared';
import { createInProcessJobs, createPgJobStore, type JobDef, type JobQueue, type WorkerRuntime } from './index';

const { db, close } = createDb(process.env.TEST_DATABASE_URL!);
const store = createPgJobStore(db);
afterAll(() => close());

const opts = { userId: LOCAL_USER_ID };
let running = 0;
let maxRunning = 0;
let calls = 0;
let lastSignal: AbortSignal | undefined;

const sleepDef = (concurrency = 1): JobDef<{ steps: number; ms: number; fail?: boolean }, { ok: true }> => ({
  type: 'debug.sleep',
  concurrency,
  async handler({ steps, ms, fail }, ctx) {
    calls++;
    lastSignal = ctx.signal;
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      for (let i = 1; i <= steps; i++) {
        if (ctx.signal.aborted) throw new Error('aborted');
        await new Promise((r) => setTimeout(r, ms));
        await ctx.progress((100 * i) / steps, `Крок ${i}/${steps}`);
      }
      if (fail) throw new Error('boom');
      return { ok: true };
    } finally {
      running--;
    }
  },
});

let queue: JobQueue;
let runtime: WorkerRuntime;
let events: JobEvent[];

function setup(concurrency = 1) {
  ({ queue, runtime } = createInProcessJobs(store));
  runtime.register(sleepDef(concurrency));
  events = [];
  queue.onEvent((e) => events.push(e));
}

const waitFor = async (id: string, statuses = ['done', 'failed', 'cancelled']) => {
  for (let i = 0; i < 200; i++) {
    const j = await queue.get(id);
    if (statuses.includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`job ${id} did not reach ${statuses}`);
};

beforeEach(async () => {
  await db.delete(jobs);
  running = maxRunning = calls = 0;
  lastSignal = undefined;
});
afterEach(() => runtime?.stop());

describe('InProcessQueue', () => {
  it('runs a job to done with ordered progress events', async () => {
    setup();
    await runtime.start();
    const id = await queue.enqueue('debug.sleep', { steps: 3, ms: 5 }, opts);
    const job = await waitFor(id);
    expect(job).toMatchObject({ status: 'done', progress: 100, attempts: 1, result: { ok: true } });
    const statuses = events.filter((e) => e.jobId === id).map((e) => e.status);
    expect(statuses[0]).toBe('queued');
    expect(statuses[1]).toBe('running');
    expect(statuses.at(-1)).toBe('done');
    const progress = events.filter((e) => e.jobId === id).map((e) => e.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it.each([1, 2])('respects concurrency %i', async (concurrency) => {
    setup(concurrency);
    await runtime.start();
    const ids = await Promise.all([1, 2, 3].map(() => queue.enqueue('debug.sleep', { steps: 2, ms: 20 }, opts)));
    await Promise.all(ids.map((id) => waitFor(id)));
    expect(maxRunning).toBe(concurrency);
  });

  it('marks a throwing handler as failed with its message', async () => {
    setup();
    await runtime.start();
    const id = await queue.enqueue('debug.sleep', { steps: 1, ms: 1, fail: true }, opts);
    expect(await waitFor(id)).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('cancels a running job via its abort signal', async () => {
    setup();
    await runtime.start();
    const id = await queue.enqueue('debug.sleep', { steps: 50, ms: 10 }, opts);
    await waitFor(id, ['running']);
    await queue.cancel(id);
    expect((await waitFor(id)).status).toBe('cancelled');
    expect(lastSignal?.aborted).toBe(true);
  });

  it('cancels a queued job so it never runs', async () => {
    setup();
    const id = await queue.enqueue('debug.sleep', { steps: 1, ms: 1 }, opts);
    await queue.cancel(id);
    await runtime.start();
    await new Promise((r) => setTimeout(r, 50));
    expect((await queue.get(id)).status).toBe('cancelled');
    expect(calls).toBe(0);
  });

  it('recovers after restart: running → failed, queued → executed', async () => {
    const stale = await store.insert({ userId: LOCAL_USER_ID, type: 'debug.sleep', payload: { steps: 1, ms: 1 } });
    await store.claim(stale.id);
    const pending = await store.insert({ userId: LOCAL_USER_ID, type: 'debug.sleep', payload: { steps: 1, ms: 1 } });
    setup();
    await runtime.start();
    expect(await queue.get(stale.id)).toMatchObject({ status: 'failed', error: 'Перервано перезапуском сервера' });
    expect((await waitFor(pending.id)).status).toBe('done');
  });

  it('rejects unknown job types and non-serializable payloads without inserting', async () => {
    setup();
    await expect(queue.enqueue('nope' as JobType, {}, opts)).rejects.toMatchObject({ code: 'UNKNOWN_JOB_TYPE' });
    await expect(queue.enqueue('debug.sleep', { b: Buffer.from('x') }, opts)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it('retry re-enqueues failed jobs and refuses done ones', async () => {
    setup();
    await runtime.start();
    const failed = await queue.enqueue('debug.sleep', { steps: 1, ms: 1, fail: true }, opts);
    await waitFor(failed);
    const again = await queue.retry(failed);
    expect(again).not.toBe(failed);
    expect((await queue.get(again)).payload).toEqual({ steps: 1, ms: 1, fail: true });
    const ok = await queue.enqueue('debug.sleep', { steps: 1, ms: 1 }, opts);
    await waitFor(ok);
    await expect(queue.retry(ok)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('survives a store error during execution without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    let failClaim = true;
    const flaky = {
      ...store,
      claim: async (id: string) => {
        if (failClaim) {
          failClaim = false;
          throw new Error('connection terminated');
        }
        return store.claim(id);
      },
    };
    ({ queue, runtime } = createInProcessJobs(flaky));
    runtime.register(sleepDef());
    await runtime.start();
    await queue.enqueue('debug.sleep', { steps: 1, ms: 1 }, opts);
    const ok = await queue.enqueue('debug.sleep', { steps: 1, ms: 1 }, opts);
    expect((await waitFor(ok)).status).toBe('done');
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('stop() marks running jobs as interrupted by restart, not cancelled', async () => {
    setup();
    await runtime.start();
    const id = await queue.enqueue('debug.sleep', { steps: 50, ms: 10 }, opts);
    await waitFor(id, ['running']);
    await runtime.stop();
    expect(await queue.get(id)).toMatchObject({ status: 'failed', error: 'Перервано перезапуском сервера' });
  });

  it('get of an unknown id throws NOT_FOUND', async () => {
    setup();
    await expect(queue.get(crypto.randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('InProcessQueue hardening', () => {
  function setupWith(handler: JobDef['handler']) {
    ({ queue, runtime } = createInProcessJobs(store));
    runtime.register({ type: 'debug.sleep', concurrency: 1, handler });
    events = [];
    queue.onEvent((e) => events.push(e));
  }

  it('cancel between claim and handler start ends cancelled', async () => {
    // вікно гонки: claim уже закомічено в БД (running), а контролер скасування ще не створено
    let claimedInDb!: () => void;
    const claimed = new Promise<void>((r) => (claimedInDb = r));
    const slowClaimStore = {
      ...store,
      claim: async (id: string) => {
        const r = await store.claim(id);
        claimedInDb();
        await new Promise((res) => setTimeout(res, 200));
        return r;
      },
    };
    let seenAborted: boolean | undefined;
    ({ queue, runtime } = createInProcessJobs(slowClaimStore));
    runtime.register({
      type: 'debug.sleep',
      concurrency: 1,
      handler: async (_p, ctx) => {
        seenAborted = ctx.signal.aborted;
        return { ok: true };
      },
    });
    await runtime.start();
    const id = await queue.enqueue('debug.sleep', {}, opts);
    await claimed;
    await queue.cancel(id);
    const job = await waitFor(id);
    expect(job.status).toBe('cancelled');
    expect(seenAborted).toBe(true);
  });

  it('cancel of a queued job that is claimed concurrently never runs the handler', async () => {
    let handlerCalls = 0;
    setupWith(async () => {
      handlerCalls++;
      return { ok: true };
    });
    const job = await store.insert({ userId: LOCAL_USER_ID, type: 'debug.sleep', payload: {} });
    // задача вже «взята» іншим воркером у той момент, коли користувач натиснув «Скасувати»
    expect(await store.requestCancel(job.id)).not.toBeNull();
    expect(await store.claim(job.id)).toBeNull();
    expect((await store.get(job.id))!.status).toBe('cancelled');
    await runtime.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(handlerCalls).toBe(0);
  });

  it('late progress after cancel does not change status', async () => {
    const job = await store.insert({ userId: LOCAL_USER_ID, type: 'debug.sleep', payload: {} });
    await store.claim(job.id);
    await store.finish(job.id, 'cancelled', {});
    expect(await store.progress(job.id, 90, 'x')).toBeNull();
    expect(await store.finish(job.id, 'done', { result: 1 })).toBeNull();
    const after = (await store.get(job.id))!;
    expect(after.status).toBe('cancelled');
    expect(after.progress).not.toBe(90);
  });

  it('stop() resolves within 10s even if a handler ignores abort', async () => {
    setupWith(() => new Promise(() => {}));
    await runtime.start();
    const id = await queue.enqueue('debug.sleep', {}, opts);
    await waitFor(id, ['running']);
    const started = Date.now();
    await runtime.stop();
    expect(Date.now() - started).toBeLessThan(10_500);
    ({ runtime } = createInProcessJobs(store)); // afterEach не має чекати завислий обробник удруге
  }, 15_000);

  it('events carry userId, type and subject from payload', async () => {
    setupWith(async () => ({ ok: true }));
    await runtime.start();
    const assetId = crypto.randomUUID();
    const id = await queue.enqueue('debug.sleep', { assetId }, opts);
    await waitFor(id);
    const e = events.find((x) => x.jobId === id && x.status === 'done')!;
    expect(e).toMatchObject({ userId: LOCAL_USER_ID, type: 'debug.sleep', subject: { assetId } });
  });
});
