import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { assets, generations, jobs, pipelineRuns, pipelineScenes, voiceLines } from '@vf/db';
import { isAppError, normalizeDoc } from '@vf/shared';
import type { AppDeps } from '../../app';
import { enqueueSynthesize, enqueueTranslate } from '../voice/service';
import { advance, type Action } from './advance';
import { loadRun, type RunRow } from './snapshot';

/** Межа проходів одного виклику: кожен прохід після дій, що лише змінюють стан, перечитує знімок */
const MAX_PASSES = 5;

/**
 * Виклики для одного запуску в цьому процесі виконуються по черзі. Сцени, рядки, script/assemble захищені ще й
 * умовами в БД, а `enqueueTranslate` — ні (немає рядка, який можна «забрати»): від дубля перекладу захищає лише
 * ця серіалізація, тобто припущення, що API — один процес.
 */
const chains = new Map<string, Promise<void>>();

/**
 * Читає знімок запуску, обчислює `advance` і виконує дії; повторює, поки прохід змінює стан (toProduce, sceneReady…),
 * щоб, наприклад, «сценарій готовий» одразу ставив візуали й озвучку. Видалений запуск — no-op.
 * Помилка дії не зупиняє інші дії проходу й не скасовує перечитування, якщо прохід змінив стан;
 * перша помилка кидається наприкінці.
 */
export function runAdvance(deps: AppDeps, runId: string): Promise<void> {
  const prev = chains.get(runId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => advanceLoop(deps, runId));
  chains.set(runId, next);
  const cleanup = () => {
    if (chains.get(runId) === next) chains.delete(runId);
  };
  next.then(cleanup, cleanup);
  return next;
}

async function advanceLoop(deps: AppDeps, runId: string): Promise<void> {
  let failure: unknown = null;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const loaded = await loadRun(deps, runId);
    if (!loaded) break;
    let changed = false;
    for (const action of advance(loaded.snap)) {
      try {
        if (await executeAction(deps, runId, action)) changed = true;
      } catch (e) {
        failure ??= e;
      }
    }
    if (!changed) break;
  }
  if (failure) throw failure;
}

const now = () => new Date();
const live = ['queued', 'running'] as ('queued' | 'running')[];

/**
 * Виконує одну дію атомарно й ідемпотентно (умовні `update … where`).
 * true — змінено стан, який `advance` має переглянути (перехід етапу, стан сцени); постановка задач — false.
 */
export async function executeAction(deps: AppDeps, runId: string, action: Action): Promise<boolean> {
  switch (action.type) {
    case 'enqueueScript':
      await enqueueRunJob(deps, runId, 'script');
      return false;
    case 'enqueueAssemble':
      await enqueueRunJob(deps, runId, 'assemble');
      return false;
    case 'toReview':
      return moveRun(deps, runId, 'script', { stage: 'review', status: 'awaiting_review' });
    case 'toProduce':
      return moveRun(deps, runId, 'script', { stage: 'produce' });
    case 'markDone':
      return moveRun(deps, runId, 'assemble', { stage: 'done', status: 'done', error: null });
    case 'markFailed':
      return markFailed(deps, runId, action.error);
    case 'enqueueVisual':
      await enqueueVisual(deps, runId, action.sceneId);
      return false;
    case 'linkGenerated':
      return sceneUpdate(
        deps,
        runId,
        action.sceneId,
        { visualAssetId: action.assetId, visualSource: 'generated' },
        isNull(pipelineScenes.visualAssetId),
      );
    case 'sceneReady':
      return sceneUpdate(deps, runId, action.sceneId, { status: 'ready', error: null });
    case 'sceneFailed':
      return sceneUpdate(deps, runId, action.sceneId, {
        status: 'failed',
        error: (await sceneError(deps, action.sceneId)) ?? action.error,
      });
    case 'enqueueTranslate':
      return translate(deps, runId, action.language);
    case 'enqueueSynthesize':
      return synthesize(deps, runId, action.language);
  }
}

async function runRow(deps: AppDeps, runId: string): Promise<RunRow | null> {
  const [run] = await deps.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
  return run ?? null;
}

/** Перехід етапу лише з очікуваного етапу запуску, що працює. */
async function moveRun(
  deps: AppDeps,
  runId: string,
  from: RunRow['stage'],
  patch: Partial<Pick<RunRow, 'stage' | 'status' | 'error'>>,
): Promise<boolean> {
  const rows = await deps.db
    .update(pipelineRuns)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.stage, from), eq(pipelineRuns.status, 'running')))
    .returning({ id: pipelineRuns.id });
  return rows.length > 0;
}

/**
 * `pipeline.script` на етапі script / `pipeline.assemble` на produce|assemble: рядок запуску блокується (`for update`),
 * задача ставиться лише якщо `*_job_id is null`, і id записується в тій самій транзакції — паралельний виклик
 * чекає блокування й бачить уже записаний id. Для збірки етап produce → assemble змінюється разом з id.
 */
async function enqueueRunJob(deps: AppDeps, runId: string, kind: 'script' | 'assemble'): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [run] = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).for('update');
    if (!run || run.status !== 'running') return;
    const payload = { projectId: run.projectId };
    if (kind === 'script') {
      if (run.stage !== 'script' || run.scriptJobId) return;
      const jobId = await deps.jobs.queue.enqueue('pipeline.script', payload, { userId: run.userId });
      await tx.update(pipelineRuns).set({ scriptJobId: jobId, updatedAt: now() }).where(eq(pipelineRuns.id, runId));
    } else {
      if ((run.stage !== 'produce' && run.stage !== 'assemble') || run.assembleJobId) return;
      const jobId = await deps.jobs.queue.enqueue('pipeline.assemble', payload, { userId: run.userId });
      await tx
        .update(pipelineRuns)
        .set({ stage: 'assemble', assembleJobId: jobId, updatedAt: now() })
        .where(eq(pipelineRuns.id, runId));
    }
  });
}

/** Як `enqueueSynthesize`: сцена забирається умовно (empty|failed → queued), потім задача, потім її id. */
async function enqueueVisual(deps: AppDeps, runId: string, sceneId: string): Promise<void> {
  const [won] = await deps.db
    .update(pipelineScenes)
    .set({ status: 'queued', jobId: null, error: null, updatedAt: now() })
    .where(
      and(
        eq(pipelineScenes.id, sceneId),
        eq(pipelineScenes.runId, runId),
        inArray(pipelineScenes.status, ['empty', 'failed']),
      ),
    )
    .returning({ userId: pipelineScenes.userId });
  if (!won) return;
  const jobId = await deps.jobs.queue.enqueue('pipeline.visual', { sceneId }, { userId: won.userId });
  await deps.db
    .update(pipelineScenes)
    .set({ jobId })
    // обробник може забрати сцену (running) ще всередині enqueue — id пишемо й тоді
    .where(and(eq(pipelineScenes.id, sceneId), inArray(pipelineScenes.status, live), isNull(pipelineScenes.jobId)));
}

/** Зміна сцени, що ще в роботі (queued|running): кінцеві стани не перезаписуються. */
async function sceneUpdate(
  deps: AppDeps,
  runId: string,
  sceneId: string,
  patch: Partial<typeof pipelineScenes.$inferInsert>,
  extra?: SQL,
): Promise<boolean> {
  const rows = await deps.db
    .update(pipelineScenes)
    .set({ ...patch, updatedAt: now() })
    .where(
      and(eq(pipelineScenes.id, sceneId), eq(pipelineScenes.runId, runId), inArray(pipelineScenes.status, live), extra),
    )
    .returning({ id: pipelineScenes.id });
  return rows.length > 0;
}

/** Справжній текст помилки сцени: генерація → її файл → задача сцени; null — немає. */
async function sceneError(deps: AppDeps, sceneId: string): Promise<string | null> {
  const [s] = await deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, sceneId));
  if (!s) return null;
  if (s.generationId) {
    const [g] = await deps.db.select().from(generations).where(eq(generations.id, s.generationId));
    if (g?.error) return g.error;
    const assetId = s.visualAssetId ?? g?.assetIds[0];
    if (assetId) {
      const [a] = await deps.db.select({ error: assets.error }).from(assets).where(eq(assets.id, assetId));
      if (a?.error) return a.error;
    }
  }
  if (s.jobId) {
    const [j] = await deps.db.select({ error: jobs.error }).from(jobs).where(eq(jobs.id, s.jobId));
    if (j?.error) return j.error;
  }
  return null;
}

/** Запуск failed з помилкою задачі поточного етапу (сценарій/збірка), інакше — з загальним текстом. */
async function markFailed(deps: AppDeps, runId: string, fallback: string): Promise<boolean> {
  const run = await runRow(deps, runId);
  if (!run || run.status !== 'running') return false;
  const jobId = run.stage === 'script' ? run.scriptJobId : run.stage === 'assemble' ? run.assembleJobId : null;
  let error = fallback;
  if (jobId) {
    const [j] = await deps.db.select({ error: jobs.error }).from(jobs).where(eq(jobs.id, jobId));
    if (j?.error) error = j.error;
  }
  return moveRun(deps, runId, run.stage, { status: 'failed', error });
}

/**
 * Озвучка рядків мови, що ще «не озвучено» (як бачить `advance`: status empty з текстом).
 * Не вдалося поставити (немає голосу чи ключа) — ці рядки failed з текстом помилки, щоб запуск не чекав їх вічно.
 */
async function synthesize(deps: AppDeps, runId: string, language: string): Promise<boolean> {
  const loaded = await loadRun(deps, runId);
  if (!loaded) return false;
  const { run, project } = loaded;
  const segIds = new Set((normalizeDoc(project.timeline).segments ?? []).map((s) => s.id));
  const empty = (
    await deps.db
      .select({ id: voiceLines.id, segmentId: voiceLines.segmentId, text: voiceLines.text })
      .from(voiceLines)
      .where(
        and(eq(voiceLines.projectId, project.id), eq(voiceLines.language, language), eq(voiceLines.status, 'empty')),
      )
  ).filter((l) => segIds.has(l.segmentId) && l.text.trim());
  if (!empty.length) return false;
  try {
    await enqueueSynthesize(deps, run.userId, {
      projectId: project.id,
      language,
      segmentIds: empty.map((l) => l.segmentId),
    });
    return false;
  } catch (e) {
    if (!isAppError(e)) throw e;
    await deps.db
      .update(voiceLines)
      .set({ status: 'failed', error: e.message, updatedAt: now() })
      .where(
        and(
          inArray(
            voiceLines.id,
            empty.map((l) => l.id),
          ),
          eq(voiceLines.status, 'empty'),
        ),
      );
    return true;
  }
}

/**
 * Переклад мови. Не вдалося поставити (немає текстової моделі чи ключа) — рядки мови в сегментах, що ще «не озвучено»,
 * стають failed з текстом помилки (рядків ще немає — створюються порожні failed); знімок тоді вважає переклад
 * мови невдалим (кінцевим), і збірка не чекає його вічно.
 */
async function translate(deps: AppDeps, runId: string, language: string): Promise<boolean> {
  const loaded = await loadRun(deps, runId);
  if (!loaded) return false;
  const { run, project } = loaded;
  try {
    await enqueueTranslate(deps, run.userId, { projectId: project.id, language });
    return false;
  } catch (e) {
    if (!isAppError(e)) throw e;
    const segments = normalizeDoc(project.timeline).segments ?? [];
    if (!segments.length) return false;
    const failed = { status: 'failed' as const, error: e.message, updatedAt: now() };
    await deps.db
      .insert(voiceLines)
      .values(
        segments.map((sg) => ({ userId: run.userId, projectId: project.id, segmentId: sg.id, language, ...failed })),
      )
      .onConflictDoUpdate({
        target: [voiceLines.projectId, voiceLines.segmentId, voiceLines.language],
        set: failed,
        setWhere: eq(voiceLines.status, 'empty'),
      });
    return true;
  }
}
