import { and, desc, eq, inArray } from 'drizzle-orm';
import { assets, jobs, renders } from '@vf/db';
import type { Preset } from '@vf/render';
import {
  AppError,
  normalizeDoc,
  TERMINAL_STATUSES,
  type AssetStatus,
  type JobStatus,
  type TimelineDoc,
} from '@vf/shared';
import { docDuration, syncVoiceTrack } from '@vf/timeline';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { languageTimeline, ownProject } from '../projects/service';
import { assertProjectLanguage, buildLocalized } from '../voice/localized';
import { baseTakesOf } from '../voice/takes';

export interface RenderView {
  id: string;
  preset: Preset;
  /** Мова рендеру (`null` — базовий документ) */
  language: string | null;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  createdAt: string;
  output: { assetId: string; durationMs: number | null; downloadUrl: string; status: AssetStatus } | null;
}

export type RenderRow = typeof renders.$inferSelect;

async function ownRender(deps: AppDeps, userId: string, id: string): Promise<RenderRow> {
  const [row] = isUuid(id)
    ? await deps.db
        .select()
        .from(renders)
        .where(and(eq(renders.id, id), eq(renders.userId, userId)))
    : [];
  if (!row) throw new AppError('NOT_FOUND', 'Рендер не знайдено');
  return row;
}

/** Непорожній документ, усі файли існують і готові. */
async function assertRenderable(deps: AppDeps, userId: string, doc: TimelineDoc): Promise<void> {
  const clips: { id: string; assetId: string }[] = [];
  for (const t of doc.tracks) if (t.kind !== 'captions') for (const c of t.clips) clips.push(c);
  if (!clips.length || docDuration(doc) <= 0) throw new AppError('VALIDATION', 'Таймлайн порожній — додайте файли');
  const ids = [...new Set(clips.map((c) => c.assetId).filter(isUuid))];
  const rows = ids.length
    ? await deps.db
        .select({ id: assets.id, status: assets.status })
        .from(assets)
        .where(and(eq(assets.userId, userId), inArray(assets.id, ids)))
    : [];
  const ready = new Set(rows.filter((r) => r.status === 'ready').map((r) => r.id));
  const bad = clips.filter((c) => !ready.has(c.assetId)).map((c) => c.id);
  if (bad.length)
    throw new AppError('VALIDATION', 'Деякі файли видалено або вони ще обробляються — замініть або приберіть їх', {
      clipIds: bad,
    });
}

interface RenderPlan {
  projectId: string;
  preset: Preset;
  doc: TimelineDoc;
  version: number;
  language: string | null;
  subtitles: string | null;
}

async function enqueueRender(
  deps: AppDeps,
  userId: string,
  plan: RenderPlan,
): Promise<{ renderId: string; jobId: string }> {
  const [r] = await deps.db
    .insert(renders)
    .values({
      userId,
      projectId: plan.projectId,
      preset: plan.preset,
      language: plan.language,
      timelineSnapshot: plan.doc,
      timelineVersion: plan.version,
      subtitles: plan.subtitles,
    })
    .returning({ id: renders.id });
  const jobId = await deps.jobs.queue.enqueue('render', { renderId: r!.id }, { userId });
  await deps.db.update(renders).set({ jobId }).where(eq(renders.id, r!.id));
  return { renderId: r!.id, jobId };
}

const notReadyError = (segmentIds: string[], languages: string[]) =>
  new AppError('VALIDATION', 'Є неозвучені або застарілі сегменти', { segmentIds, languages });

/** Документ мови для рендеру: відокремлений або `localize`, разом з ASS (знімок на старті). */
async function languagePlan(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; preset: Preset; language: string },
): Promise<RenderPlan & { notReady: string[] }> {
  const l = await buildLocalized(deps, userId, input.projectId, input.language);
  await assertRenderable(deps, userId, l.timeline);
  return {
    projectId: l.project.id,
    preset: input.preset,
    doc: l.timeline,
    version: l.version,
    language: input.language,
    subtitles: l.subtitles,
    notReady: l.notReady,
  };
}

/**
 * Перевірки перед рендером: версія, непорожній таймлайн, усі файли існують і готові.
 * З `language` — документ мови (версія — базового проєкту або відокремленої мови); неготові рядки → VALIDATION
 * з `segmentIds`, якщо не `force`.
 */
export async function startRender(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; preset: Preset; version: number; language?: string; force?: boolean },
): Promise<{ renderId: string; jobId: string }> {
  const stale = () => new AppError('CONFLICT', 'Проєкт змінено в іншій вкладці — оновіть сторінку');
  if (input.language !== undefined) {
    // версія — до localize: застаріла вкладка отримує CONFLICT, без зайвої роботи
    const project = await ownProject(deps, userId, input.projectId);
    assertProjectLanguage(project, input.language);
    const sep = await languageTimeline(deps, project.id, input.language);
    if ((sep?.timelineVersion ?? project.timelineVersion) !== input.version) throw stale();
    const plan = await languagePlan(deps, userId, { ...input, language: input.language });
    if (plan.version !== input.version) throw stale();
    if (plan.notReady.length && !input.force) throw notReadyError(plan.notReady, [input.language]);
    return enqueueRender(deps, userId, plan);
  }
  const project = await ownProject(deps, userId, input.projectId);
  if (project.timelineVersion !== input.version) throw stale();
  // озвучка базової мови синхронізується на копії: `projects.timeline` рендер не змінює
  const voiceTakes = await baseTakesOf(deps, userId, project);
  const doc = syncVoiceTrack(normalizeDoc(project.timeline), { language: project.baseLanguage, ...voiceTakes }).doc;
  await assertRenderable(deps, userId, doc);
  return enqueueRender(deps, userId, {
    projectId: project.id,
    preset: input.preset,
    doc,
    version: input.version,
    language: null,
    subtitles: null,
  });
}

/** По рендеру на мову. Спершу перевіряються всі мови — за помилки не стартує жоден. */
export async function startAllRenders(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; preset: Preset; languages: string[]; force?: boolean },
): Promise<{ renderIds: string[] }> {
  const plans = [];
  for (const language of new Set(input.languages))
    plans.push(await languagePlan(deps, userId, { projectId: input.projectId, preset: input.preset, language }));
  const pending = plans.filter((p) => p.notReady.length);
  if (pending.length && !input.force)
    throw notReadyError(
      [...new Set(pending.flatMap((p) => p.notReady))],
      pending.map((p) => p.language!),
    );
  const renderIds: string[] = [];
  for (const plan of plans) renderIds.push((await enqueueRender(deps, userId, plan)).renderId);
  return { renderIds };
}

/** Історія рендерів проєкту. Незавершений рендер бере стан своєї задачі (скасування, рестарт). */
export async function listRenders(deps: AppDeps, userId: string, projectId: string): Promise<RenderView[]> {
  await ownProject(deps, userId, projectId);
  const rows = await deps.db
    .select({
      r: renders,
      job: { status: jobs.status, progress: jobs.progress, message: jobs.message, error: jobs.error },
      a: assets,
    })
    .from(renders)
    .leftJoin(jobs, eq(jobs.id, renders.jobId))
    .leftJoin(assets, eq(assets.id, renders.outputAssetId))
    .where(and(eq(renders.projectId, projectId), eq(renders.userId, userId)))
    .orderBy(desc(renders.createdAt))
    .limit(50);
  return Promise.all(
    rows.map(async ({ r, job, a }) => {
      const fromJob =
        !TERMINAL_STATUSES.has(r.status) && !!job?.status && TERMINAL_STATUSES.has(job.status) && job.status !== 'done';
      const status = fromJob ? job!.status! : r.status;
      return {
        id: r.id,
        preset: r.preset,
        language: r.language,
        status,
        progress: status === 'done' ? 100 : (job?.progress ?? 0),
        message: job?.message ?? null,
        error: fromJob ? (job?.error ?? null) : r.error,
        createdAt: r.createdAt.toISOString(),
        output: a
          ? {
              assetId: a.id,
              durationMs: a.durationMs,
              status: a.status,
              downloadUrl: await deps.storage.presignGet(a.storageKey, { downloadName: `${a.title || 'render'}.mp4` }),
            }
          : null,
      };
    }),
  );
}

export async function cancelRender(deps: AppDeps, userId: string, id: string): Promise<void> {
  const r = await ownRender(deps, userId, id);
  if (r.jobId) await deps.jobs.queue.cancel(r.jobId);
}

/** «Повторити»: новий запуск того самого рендеру (знімок таймлайну той самий). */
export async function retryRender(deps: AppDeps, userId: string, id: string): Promise<{ jobId: string }> {
  const r = await ownRender(deps, userId, id);
  const job = r.jobId ? await deps.jobs.queue.get(r.jobId).catch(() => null) : null;
  const live = job && !TERMINAL_STATUSES.has(job.status);
  if (live || r.status === 'done') throw new AppError('CONFLICT', 'Рендер ще йде або вже готовий');
  const jobId = await deps.jobs.queue.enqueue('render', { renderId: r.id }, { userId });
  await deps.db
    .update(renders)
    .set({ jobId, status: 'queued', error: null, finishedAt: null })
    .where(eq(renders.id, r.id));
  return { jobId };
}
