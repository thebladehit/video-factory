import { setTimeout as sleep } from 'node:timers/promises';
import type { JobDef } from '@vf/jobs';

/** Тестова задача для перевірки черги й живого прогресу в UI. */
export const debugSleep: JobDef<{ durationMs: number; steps: number }, { sleptMs: number }> = {
  type: 'debug.sleep',
  concurrency: 2,
  async handler({ durationMs, steps }, ctx) {
    for (let i = 1; i <= steps; i++) {
      await sleep(durationMs / steps, undefined, { signal: ctx.signal });
      await ctx.progress(Math.round((100 * i) / steps), `Крок ${i}/${steps}`);
    }
    return { sleptMs: durationMs };
  },
};
