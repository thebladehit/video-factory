import { eq, or, sql } from 'drizzle-orm';
import { generations, pipelineRuns, pipelineScenes, voiceLines } from '@vf/db';
import { TERMINAL_STATUSES, type JobEvent, type JobSubject, type JobType } from '@vf/shared';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { releaseCancelledLines } from '../voice/synthesize-job';
import { runAdvance } from './run-advance';

/** Задачі, кінцеві події яких можуть зрушити запуск (спека 3.2) */
const WATCHED: ReadonlySet<JobType> = new Set<JobType>([
  'pipeline.script',
  'pipeline.scene',
  'pipeline.visual',
  'pipeline.assemble',
  'voice.translate',
  'voice.synthesize',
  'image.generate',
  'video.generate',
  'asset.process',
]);

/** Запуски, яких стосується подія: projectId → запуск; sceneId → сцена; lineId → проєкт рядка; generationId/assetId → сцени. */
export async function runIdsFor(deps: AppDeps, subject: JobSubject): Promise<string[]> {
  const ids = new Set<string>();
  const add = (rows: { runId: string }[]) => rows.forEach((r) => ids.add(r.runId));
  const { projectId, sceneId, lineId, generationId, assetId } = subject;
  if (projectId && isUuid(projectId))
    add(
      await deps.db.select({ runId: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId)),
    );
  if (sceneId && isUuid(sceneId))
    add(
      await deps.db.select({ runId: pipelineScenes.runId }).from(pipelineScenes).where(eq(pipelineScenes.id, sceneId)),
    );
  if (lineId && isUuid(lineId))
    add(
      await deps.db
        .select({ runId: pipelineRuns.id })
        .from(voiceLines)
        .innerJoin(pipelineRuns, eq(pipelineRuns.projectId, voiceLines.projectId))
        .where(eq(voiceLines.id, lineId)),
    );
  if (generationId && isUuid(generationId))
    add(
      await deps.db
        .select({ runId: pipelineScenes.runId })
        .from(pipelineScenes)
        .where(eq(pipelineScenes.generationId, generationId)),
    );
  if (assetId && isUuid(assetId))
    add(
      await deps.db
        .selectDistinct({ runId: pipelineScenes.runId })
        .from(pipelineScenes)
        .leftJoin(generations, eq(generations.id, pipelineScenes.generationId))
        .where(
          or(eq(pipelineScenes.visualAssetId, assetId), sql`${generations.assetIds} @> array[${assetId}]::uuid[]`),
        ),
    );
  return [...ids];
}

/**
 * Обробка однієї події черги: кінцева подія задачі, що стосується запуску → `runAdvance`. Ніколи не кидає —
 * помилки журналюються (`deps.log.error`), бо слухач викликається синхронно з черги.
 */
export async function handlePipelineEvent(deps: AppDeps, e: JobEvent): Promise<void> {
  if (!TERMINAL_STATUSES.has(e.status) || !WATCHED.has(e.type)) return;
  try {
    // слухач `releaseOnCancel` працює паралельно — звільняємо рядок тут теж (ідемпотентно), щоб advance бачив його
    if (e.type === 'voice.synthesize' && e.status === 'cancelled' && e.subject.lineId && isUuid(e.subject.lineId))
      await releaseCancelledLines(deps, [e.subject.lineId], e.jobId);
    for (const runId of await runIdsFor(deps, e.subject)) {
      try {
        await runAdvance(deps, runId);
      } catch (err) {
        deps.log.error({ err, runId, jobId: e.jobId, type: e.type }, 'pipeline: advance за подією задачі не вдався');
      }
    }
  } catch (err) {
    deps.log.error({ err, jobId: e.jobId, type: e.type }, 'pipeline: не вдалося обробити подію задачі');
  }
}

/** Слухач `queue.onEvent`: запускає обробку й не чекає її. */
export const pipelineEvents =
  (deps: AppDeps) =>
  (e: JobEvent): void => {
    void handlePipelineEvent(deps, e);
  };
