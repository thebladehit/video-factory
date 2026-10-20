import { z } from 'zod';
import { AppError, TERMINAL_STATUSES, type JobEvent, type JobRecord } from '@vf/shared';
import { procedure, router, type Context } from '../trpc';

const byId = z.object({ id: z.string() });
const toEvent = (r: JobRecord): JobEvent => ({
  jobId: r.id,
  status: r.status,
  progress: r.progress,
  message: r.message,
  error: r.error,
});

/** Задачі іншого користувача поводяться як неіснуючі. */
async function ownJob(ctx: Context, id: string): Promise<JobRecord> {
  const job = await ctx.deps.jobs.queue.get(id);
  if (job.userId !== ctx.userId) throw new AppError('NOT_FOUND', `Задачу не знайдено: ${id}`, { jobId: id });
  return job;
}

async function* jobEvents(ctx: Context, id: string, signal: AbortSignal | undefined): AsyncGenerator<JobEvent> {
  const buffer: JobEvent[] = [];
  let wake: (() => void) | null = null;
  const off = ctx.deps.jobs.queue.onEvent((e) => {
    if (e.jobId !== id) return;
    buffer.push(e);
    wake?.();
  });
  try {
    const snapshot = toEvent(await ctx.deps.jobs.queue.get(id));
    yield snapshot;
    if (TERMINAL_STATUSES.has(snapshot.status)) return;
    let lastProgress = snapshot.progress;
    while (!signal?.aborted) {
      for (let e = buffer.shift(); e; e = buffer.shift()) {
        const terminal = TERMINAL_STATUSES.has(e.status);
        // події, що прийшли до знімка, можуть бути старішими за нього
        if (!terminal && e.progress < lastProgress) continue;
        lastProgress = e.progress;
        yield e;
        if (terminal) return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      wake = null;
    }
  } finally {
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
    return jobEvents(ctx, input.id, signal);
  }),
});
