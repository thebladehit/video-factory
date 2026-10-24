import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { assets, generations, jobs, pipelineRuns, publications, renders, voiceLines } from '@vf/db';
import { RESTART_ERROR } from '@vf/jobs';
import type { AppDeps } from '../app';
import { runAdvance } from './pipeline/run-advance';
import { releaseCancelledLines } from './voice/synthesize-job';

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
 * asset.analyze — для ready-відео/аудіо без аналізу звуку,
 * генерації — для перерваних рестартом (відео продовжить опитування збереженої операції, не платячи вдруге);
 * рядки озвучки з перерваною задачею — «failed» з поясненням;
 * запуски конвеєра, що працюють, — `runAdvance` (перервана задача сценарію/збірки → запуск failed з її помилкою
 * «Перервано перезапуском сервера»; сцени й рядки — за звичайними правилами);
 * публікації `uploading` з неживою задачею — знову `scheduled` (тік поставить задачу, яка продовжить `upload_session`).
 */
export async function reconcileAfterRestart(deps: AppDeps): Promise<void> {
  const stuckAssets = await deps.db.select().from(assets).where(eq(assets.status, 'processing'));
  for (const a of stuckAssets) {
    if (!(await hasLiveJob(deps, 'asset.process', 'assetId', a.id))) {
      await deps.jobs.queue.enqueue('asset.process', { assetId: a.id }, { userId: a.userId });
    }
  }

  // файли, оброблені до появи аналізу звуку
  const unanalyzed = await deps.db
    .select({ id: assets.id, userId: assets.userId })
    .from(assets)
    .where(and(eq(assets.status, 'ready'), isNull(assets.hasAudio), inArray(assets.kind, ['video', 'audio'])));
  for (const a of unanalyzed) {
    if (!(await hasLiveJob(deps, 'asset.analyze', 'assetId', a.id))) {
      await deps.jobs.queue.enqueue('asset.analyze', { assetId: a.id }, { userId: a.userId });
    }
  }

  // рендер, перерваний рестартом, — failed («Повторити» = новий запуск того самого рендеру)
  const stuckRenders = await deps.db
    .select({ id: renders.id, jobStatus: jobs.status, error: jobs.error })
    .from(renders)
    .leftJoin(jobs, eq(jobs.id, renders.jobId))
    .where(
      and(
        inArray(renders.status, ['queued', 'running']),
        or(isNull(jobs.id), inArray(jobs.status, ['failed', 'cancelled'])),
      ),
    );
  for (const r of stuckRenders)
    await deps.db
      .update(renders)
      .set(
        r.jobStatus === 'cancelled'
          ? { status: 'cancelled', finishedAt: new Date() }
          : { status: 'failed', error: r.error ?? RESTART_ERROR, finishedAt: new Date() },
      )
      .where(eq(renders.id, r.id));

  // рядок озвучки, чия задача перервана рестартом (або зникла), — failed; скасована — звільняється
  const stuckLines = await deps.db
    .select({ id: voiceLines.id, jobStatus: jobs.status, error: jobs.error })
    .from(voiceLines)
    .leftJoin(jobs, eq(jobs.id, voiceLines.jobId))
    .where(
      and(
        inArray(voiceLines.status, ['queued', 'running']),
        or(isNull(jobs.id), inArray(jobs.status, ['failed', 'cancelled'])),
      ),
    );
  await releaseCancelledLines(
    deps,
    stuckLines.filter((l) => l.jobStatus === 'cancelled').map((l) => l.id),
  );
  for (const l of stuckLines.filter((x) => x.jobStatus !== 'cancelled'))
    await deps.db
      .update(voiceLines)
      .set({ status: 'failed', error: l.error ?? RESTART_ERROR, updatedAt: new Date() })
      .where(eq(voiceLines.id, l.id));

  // завантаження, перерване рестартом: scheduled_at не змінюється; скасована задача — скасована публікація
  const stuckUploads = await deps.db
    .select({ id: publications.id, jobStatus: jobs.status })
    .from(publications)
    .leftJoin(jobs, eq(jobs.id, publications.jobId))
    .where(
      and(
        eq(publications.status, 'uploading'),
        or(isNull(jobs.id), inArray(jobs.status, ['done', 'failed', 'cancelled'])),
      ),
    );
  for (const p of stuckUploads)
    await deps.db
      .update(publications)
      .set({ status: p.jobStatus === 'cancelled' ? 'cancelled' : 'scheduled', updatedAt: new Date() })
      .where(and(eq(publications.id, p.id), eq(publications.status, 'uploading')));

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

  // останнім: advance бачить уже виправлені рядки озвучки й перезапущені генерації
  const runs = await deps.db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.status, 'running'));
  for (const r of runs) {
    try {
      await runAdvance(deps, r.id);
    } catch (e) {
      deps.log.error({ err: e, runId: r.id }, 'pipeline: advance після рестарту не вдався');
    }
  }
}
