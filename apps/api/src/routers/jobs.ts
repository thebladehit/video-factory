import { z } from 'zod';
import { TERMINAL_STATUSES, type JobEvent, type JobRecord } from '@vf/shared';
import { procedure, router } from '../trpc';

const byId = z.object({ id: z.string() });
const toEvent = (r: JobRecord): JobEvent => ({
  jobId: r.id,
  status: r.status,
  progress: r.progress,
  message: r.message,
  error: r.error,
});

export const jobsRouter = router({
  enqueueDebug: procedure
    .input(z.object({ durationMs: z.number().int().min(100).max(60_000), steps: z.number().int().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => ({
      jobId: await ctx.deps.jobs.queue.enqueue('debug.sleep', input, { userId: ctx.userId }),
    })),

  get: procedure.input(byId).query(({ ctx, input }) => ctx.deps.jobs.queue.get(input.id)),

  cancel: procedure.input(byId).mutation(({ ctx, input }) => ctx.deps.jobs.queue.cancel(input.id)),

  retry: procedure
    .input(byId)
    .mutation(async ({ ctx, input }) => ({ jobId: await ctx.deps.jobs.queue.retry(input.id) })),

  /** Спершу знімок поточного стану, далі події до термінального статусу (SSE). */
  events: procedure.input(byId).subscription(async function* ({ ctx, input, signal }) {
    const buffer: JobEvent[] = [];
    let wake: (() => void) | null = null;
    const off = ctx.deps.jobs.queue.onEvent((e) => {
      if (e.jobId !== input.id) return;
      buffer.push(e);
      wake?.();
    });
    try {
      const snapshot = toEvent(await ctx.deps.jobs.queue.get(input.id));
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
  }),
});
