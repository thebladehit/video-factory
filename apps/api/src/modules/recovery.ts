import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { assets, generations, jobs } from '@vf/db';
import { RESTART_ERROR } from '@vf/jobs';
import type { AppDeps } from '../app';

/** Чи є жива (queued/running) задача цього типу для сутності. */
export async function hasLiveJob(deps: AppDeps, type: string, key: 'assetId' | 'generationId', id: string) {
  const [row] = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, type), inArray(jobs.status, ['queued', 'running']), sql`${jobs.payload}->>${key} = ${id}`))
    .limit(1);
  return !!row;
}

/**
 * Після старту: черга позначила перервані задачі «failed (рестарт)», а доменні рядки лишились «в роботі».
 * Обробники ідемпотентні, тож просто ставимо задачі знову: asset.process — для processing без живої задачі,
 * генерації — для перерваних рестартом (відео продовжить опитування збереженої операції, не платячи вдруге).
 */
export async function reconcileAfterRestart(deps: AppDeps): Promise<void> {
  const stuckAssets = await deps.db.select().from(assets).where(eq(assets.status, 'processing'));
  for (const a of stuckAssets) {
    if (!(await hasLiveJob(deps, 'asset.process', 'assetId', a.id))) {
      await deps.jobs.queue.enqueue('asset.process', { assetId: a.id }, { userId: a.userId });
    }
  }

  const interrupted = await deps.db
    .select({ g: generations })
    .from(generations)
    .leftJoin(jobs, eq(jobs.id, generations.jobId))
    .where(
      and(
        inArray(generations.status, ['queued', 'running']),
        inArray(generations.capability, ['image', 'video']),
        or(isNull(jobs.id), and(eq(jobs.status, 'failed'), eq(jobs.error, RESTART_ERROR))),
      ),
    );
  for (const { g } of interrupted) {
    const type = g.capability === 'video' ? 'video.generate' : 'image.generate';
    const jobId = await deps.jobs.queue.enqueue(type, { generationId: g.id }, { userId: g.userId });
    await deps.db.update(generations).set({ jobId }).where(eq(generations.id, g.id));
  }
}
