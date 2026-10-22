import { and, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { pipelineRuns, pipelineScenes, projects } from '@vf/db';
import type { JobDef, JobContext } from '@vf/jobs';
import type { AppDeps } from '../../app';
import { LIBRARY_MATCH_MIN, matchAssets } from '../assets/match';
import { generateImage } from '../generate/service';

/** Кандидат на автопідстановку + до 3 підказок */
const MATCH_LIMIT = 4;
const MAX_SUGGESTIONS = 3;

type Source = 'library' | 'generated' | null;

/** Сцена ще належить цій задачі: у роботі (queued|running) і id задачі не записано або він наш. */
const ownedBy = (sceneId: string, ctx: JobContext) =>
  and(
    eq(pipelineScenes.id, sceneId),
    inArray(pipelineScenes.status, ['queued', 'running']),
    or(isNull(pipelineScenes.jobId), eq(pipelineScenes.jobId, ctx.jobId)),
  );

/**
 * pipeline.visual (спека 4.2): сильний збіг у бібліотеці → `visual_source='library'`, `ready`; інакше генерація фото
 * (`generateImage`, n=1, aspect = формат) → `generation_id`, `running`, файл прив'язує координатор (`linkGenerated`).
 * `suggestions` — до 3 наступних збігів у будь-якому разі. `regenerate` («Згенерувати знову») пропускає бібліотеку.
 * Сцена вже має візуал чи генерацію → лише доводить її стан (ідемпотентність). Перед кожним записом перевіряється
 * `ctx.signal` і що сцена ще в роботі цієї задачі: скасування скидає сцени одразу, і задача, що доробляє, нічого
 * не повертає. Сцени/запуску/проєкту немає — `{ source: null }` без винятку.
 */
export function visualJob(deps: AppDeps): JobDef<{ sceneId: string; regenerate?: boolean }, { source: Source }> {
  return {
    type: 'pipeline.visual',
    concurrency: 3,
    async handler({ sceneId, regenerate }, ctx) {
      const none = { source: null };
      const [row] = await deps.db
        .select({ scene: pipelineScenes, run: pipelineRuns, project: projects })
        .from(pipelineScenes)
        .innerJoin(pipelineRuns, eq(pipelineRuns.id, pipelineScenes.runId))
        .innerJoin(projects, eq(projects.id, pipelineRuns.projectId))
        .where(and(eq(pipelineScenes.id, sceneId), eq(pipelineScenes.userId, ctx.userId)));
      if (!row || ctx.signal.aborted) return none;
      const { scene, run, project } = row;
      const now = () => new Date();

      // сцену забрано: без цього кроку advance бачив би queued без генерації після завершення задачі
      const [taken] = await deps.db
        .update(pipelineScenes)
        .set({ status: 'running', updatedAt: now() })
        .where(ownedBy(sceneId, ctx))
        .returning({ id: pipelineScenes.id });
      if (!taken) return none;

      // уже є генерація — її доведе координатор; є лише файл (бібліотека/вибір) — сцена готова
      if (scene.generationId) return { source: 'generated' };
      if (scene.visualAssetId) {
        if (ctx.signal.aborted) return none;
        await deps.db
          .update(pipelineScenes)
          .set({ status: 'ready', error: null, updatedAt: now() })
          .where(ownedBy(sceneId, ctx));
        return { source: scene.visualSource === 'library' ? 'library' : null };
      }

      await ctx.progress(10, 'Шукаю в бібліотеці');
      let suggestions: string[] | undefined;
      if (!regenerate) {
        const hit = await deps.db.transaction(async (tx) => {
          // запуск блокується: паралельні задачі візуалу бачать уже взяті файли (один файл — одна сцена)
          await tx.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.id, run.id)).for('update');
          const taken = await tx
            .select({ id: pipelineScenes.visualAssetId })
            .from(pipelineScenes)
            .where(
              and(
                eq(pipelineScenes.runId, run.id),
                ne(pipelineScenes.id, sceneId),
                isNotNull(pipelineScenes.visualAssetId),
              ),
            );
          // те саме з'єднання транзакції: не тримаємо два з'єднання пулу на задачу
          const matches = await matchAssets({ ...deps, db: tx as unknown as AppDeps['db'] }, run.userId, {
            keywords: scene.keywords,
            format: project.format,
            exclude: taken.map((t) => t.id!),
            limit: MATCH_LIMIT,
          });
          const best = matches[0] && matches[0].score >= LIBRARY_MATCH_MIN ? matches[0] : null;
          suggestions = matches
            .slice(best ? 1 : 0)
            .slice(0, MAX_SUGGESTIONS)
            .map((m) => m.assetId);
          if (!best || ctx.signal.aborted) return false;
          const done = await tx
            .update(pipelineScenes)
            .set({
              visualAssetId: best.assetId,
              visualSource: 'library',
              suggestions,
              status: 'ready',
              error: null,
              updatedAt: now(),
            })
            .where(ownedBy(sceneId, ctx))
            .returning({ id: pipelineScenes.id });
          return done.length > 0;
        });
        if (hit) {
          await ctx.progress(100, 'Знайдено в бібліотеці');
          return { source: 'library' };
        }
      }
      if (ctx.signal.aborted) return none;

      await ctx.progress(30, 'Генерую фото');
      const { generationId, jobId } = await generateImage(deps, run.userId, {
        model: run.settings.imageModel,
        prompt: scene.visualPrompt,
        aspect: project.format,
        n: 1,
      });
      const linked = ctx.signal.aborted
        ? []
        : await deps.db
            .update(pipelineScenes)
            .set({ generationId, ...(suggestions ? { suggestions } : {}), status: 'running', updatedAt: now() })
            .where(ownedBy(sceneId, ctx))
            .returning({ id: pipelineScenes.id });
      if (!linked.length) {
        // сцену скасовано чи перезапущено, поки ставилась генерація — вона вже нікому не потрібна
        await deps.jobs.queue.cancel(jobId).catch(() => undefined);
        return none;
      }
      await ctx.progress(100, 'Фото генерується');
      return { source: 'generated' };
    },
  };
}
