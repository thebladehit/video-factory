import { z } from 'zod';
import { AppError, TERMINAL_STATUSES, toJobEvent, type JobEvent, type JobRecord } from '@vf/shared';
import { procedure, router, type Context } from '../trpc';

const byId = z.object({ id: z.string() });

/** Задачі іншого користувача поводяться як неіснуючі. */
async function ownJob(ctx: Context, id: string): Promise<JobRecord> {
  const job = await ctx.deps.jobs.queue.get(id);
  if (job.userId !== ctx.userId) throw new AppError('NOT_FOUND', `Задачу не знайдено: ${id}`, { jobId: id });
  return job;
}

/**
 * Потік подій черги, що пройшли фільтр, до abort або поки `stop(e)` не поверне true.
 * Один abort-listener на підписку (а не на кожне очікування).
 */
async function* eventStream(
  ctx: Context,
  filter: (e: JobEvent) => boolean,
  signal: AbortSignal | undefined,
  start?: () => Promise<{ snapshot: JobEvent; done: boolean }>,
): AsyncGenerator<JobEvent> {
  const buffer: JobEvent[] = [];
  let wake: (() => void) | null = null;
  const off = ctx.deps.jobs.queue.onEvent((e) => {
    if (!filter(e)) return;
    buffer.push(e);
    wake?.();
  });
  const onAbort = () => wake?.();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let lastProgress = -1;
    let single = false;
    if (start) {
      single = true;
      const { snapshot, done } = await start();
      yield snapshot;
      if (done) return;
      lastProgress = snapshot.progress;
    }
    while (!signal?.aborted) {
      for (let e = buffer.shift(); e; e = buffer.shift()) {
        const terminal = TERMINAL_STATUSES.has(e.status);
        // події, що прийшли до знімка, можуть бути старішими за нього
        if (single && !terminal && e.progress < lastProgress) continue;
        lastProgress = e.progress;
        yield e;
        if (single && terminal) return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (signal?.aborted) resolve();
      });
      wake = null;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    off();
  }
}

export const jobsRouter = router({
  enqueueDebug: procedure
    .input(z.object({ durationMs: z.number().int().min(100).max(60_000), steps: z.number().int().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => ({
      jobId: await ctx.deps.jobs.queue.enqueue('debug.sleep', input, { userId: ctx.userId }),
    })),

  get: procedure.input(byId).query(({ ctx, input }) => ownJob(ctx, input.id)),

  cancel: procedure.input(byId).mutation(async ({ ctx, input }) => {
    await ownJob(ctx, input.id);
    await ctx.deps.jobs.queue.cancel(input.id);
  }),

  retry: procedure.input(byId).mutation(async ({ ctx, input }) => {
    await ownJob(ctx, input.id);
    return { jobId: await ctx.deps.jobs.queue.retry(input.id) };
  }),

  /** Спершу знімок поточного стану, далі події до термінального статусу (SSE). */
  events: procedure.input(byId).subscription(async ({ ctx, input, signal }) => {
    // перевірка до старту потоку — помилка доходить до клієнта як звичайний NOT_FOUND
    await ownJob(ctx, input.id);
    return eventStream(
      ctx,
      (e) => e.jobId === input.id,
      signal,
      async () => {
        const snapshot = toJobEvent(await ctx.deps.jobs.queue.get(input.id));
        return { snapshot, done: TERMINAL_STATUSES.has(snapshot.status) };
      },
    );
  }),

  /** Усі події задач поточного користувача — одна підписка на застосунок (бібліотека, завантаження). */
  feed: procedure.subscription(({ ctx, signal }) => eventStream(ctx, (e) => e.userId === ctx.userId, signal)),
});
