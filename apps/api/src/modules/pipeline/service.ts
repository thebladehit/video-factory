import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { CatalogItem } from '@vf/ai';
import { PRESETS } from '@vf/captions';
import { assets, generations, jobs, pipelineRuns, pipelineScenes, projects, voiceLines } from '@vf/db';
import {
  AppError,
  emptyTimeline,
  normalizeDoc,
  pipelineSettingsSchema,
  type ModelRef,
  type PipelineSettings,
  type PipelineStage,
  type PipelineStatus,
  type SceneStatus,
  type VideoFormat,
  type VisualSource,
} from '@vf/shared';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { ownProject } from '../projects/service';
import { assertVoiceChoice, enqueueTranslate, getVoice, parseVoice } from '../voice/service';
import type { LineState } from '../voice/stale';
import { estimatePipeline, type PipelineEstimate } from './estimate';
import { runAdvance } from './run-advance';
import { loadSnapshot, type RunRow } from './snapshot';

export interface SceneView {
  id: string;
  segmentId: string;
  position: number;
  narration: string;
  visualPrompt: string;
  keywords: string[];
  status: SceneStatus;
  error: string | null;
  visual: { assetId: string; thumbUrl: string | null; kind: 'image' | 'video'; source: VisualSource } | null;
  suggestions: { assetId: string; thumbUrl: string | null }[];
  /** Сегмента сцени немає в документі (видалено в редакторі) */
  inTimeline: boolean;
  /** Жива/остання генерація візуалу — щоб сторінка сцен оновлювалась за подіями `image.generate`/`video.generate` */
  generationId: string | null;
  /** Рядки озвучки сцени по мовах (стани — як у студії) */
  lines: Record<string, { id: string; state: LineState }>;
}

export interface PipelineView {
  project: {
    id: string;
    title: string;
    topic: string | null;
    format: VideoFormat;
    baseLanguage: string;
    timelineVersion: number;
  };
  run: {
    stage: PipelineStage;
    status: PipelineStatus;
    error: string | null;
    settings: PipelineSettings;
    assembledVersion: number | null;
  };
  scenes: SceneView[];
  languages: { language: string; ready: number; total: number; failed: number }[];
  /** Сцени в кінцевому стані + рядки мов ready|failed із (сцени + сегменти × мови) */
  progress: { done: number; total: number };
}

const TITLE_CHARS = 80;
const runNotFound = () => new AppError('NOT_FOUND', 'Запуск конвеєра не знайдено');

/** Запуск власного проєкту; чужий/неіснуючий проєкт або проєкт без запуску → NOT_FOUND. */
export async function ownRun(deps: AppDeps, userId: string, projectId: string): Promise<RunRow> {
  const p = await ownProject(deps, userId, projectId);
  const [run] = await deps.db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.projectId, p.id), eq(pipelineRuns.userId, userId)));
  if (!run) throw runNotFound();
  return run;
}

/** Zod-помилки налаштувань → VALIDATION з першим повідомленням (українською зі схеми). */
export function parseSettings(raw: unknown): PipelineSettings {
  const r = pipelineSettingsSchema.safeParse(raw);
  if (!r.success) throw new AppError('VALIDATION', r.error.issues[0]?.message ?? 'Некоректні налаштування запуску');
  return r.data;
}

function requireModel(catalog: CatalogItem[], ref: ModelRef, capability: 'text' | 'image'): void {
  const entry = catalog.find((e) => e.ref === ref && e.capability === capability);
  if (!entry) throw new AppError('MODEL_NOT_FOUND', `Модель ${ref} не підходить для «${capability}»`, { model: ref });
  if (!entry.available)
    throw new AppError('MODEL_UNAVAILABLE', `Немає ключа для провайдера ${entry.provider}`, { model: ref });
}

/** Перевірки моделей, голосів і музики — до створення проєкту. */
async function checkStart(deps: AppDeps, userId: string, s: PipelineSettings): Promise<void> {
  const catalog = await deps.ai.catalog(userId);
  requireModel(catalog, s.textModel, 'text');
  requireModel(catalog, s.imageModel, 'image');
  for (const language of s.languages) {
    const voice = s.voices[language]!;
    const entry = await assertVoiceChoice(deps, userId, voice);
    if (!entry.available)
      throw new AppError('MODEL_UNAVAILABLE', `Модель озвучки ${voice.model} недоступна — додайте ключ`, {
        model: voice.model,
      });
  }
  if (s.musicAssetId) {
    const [a] = await deps.db
      .select()
      .from(assets)
      .where(and(eq(assets.id, s.musicAssetId), eq(assets.userId, userId)));
    if (!a) throw new AppError('NOT_FOUND', 'Файл музики не знайдено');
    if (a.kind !== 'audio' || a.status !== 'ready')
      throw new AppError('VALIDATION', 'Музика має бути готовим аудіофайлом із бібліотеки');
  }
}

/**
 * `runAdvance` після вже збереженої зміни стану: помилку лише журналюємо — інакше клієнт повторив би запит
 * (дубль проєкту), а запуск далі доведе слухач подій або advance на старті API.
 */
export async function advanceQuietly(deps: AppDeps, runId: string): Promise<void> {
  try {
    await runAdvance(deps, runId);
  } catch (e) {
    deps.log.error({ err: e, runId }, 'pipeline: advance після зміни стану не вдався');
  }
}

/** «Відео з теми»: проєкт (назва — початок теми до генерації назви) + запуск на етапі script + задача сценарію. */
export async function startPipeline(deps: AppDeps, userId: string, raw: unknown): Promise<{ projectId: string }> {
  const s = parseSettings(raw);
  await checkStart(deps, userId, s);
  const voice = parseVoice({});
  // голоси мов — у проєкт: їх бере наявна озвучка (voiceForLanguage); субтитри вмикає збірка
  for (const language of s.languages)
    voice.languages[language] = { voice: s.voices[language]!, captions: { enabled: false, styleId: PRESETS[0]!.id } };
  const doc = emptyTimeline(s.format);
  const { projectId, runId } = await deps.db.transaction(async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({
        userId,
        title: s.topic.trim().slice(0, TITLE_CHARS),
        format: s.format,
        fps: doc.fps,
        timeline: doc,
        topic: s.topic,
        baseLanguage: s.baseLanguage,
        languages: s.languages,
        voice,
      })
      .returning({ id: projects.id });
    const [run] = await tx
      .insert(pipelineRuns)
      .values({ userId, projectId: p!.id, settings: s })
      .returning({ id: pipelineRuns.id });
    return { projectId: p!.id, runId: run!.id };
  });
  await advanceQuietly(deps, runId);
  return { projectId };
}

export async function estimate(deps: AppDeps, userId: string, raw: unknown): Promise<PipelineEstimate> {
  return estimatePipeline(parseSettings(raw), await deps.ai.catalog(userId));
}

/** «Продовжити» після перевірки сценарію: review → produce, далі `advance` ставить візуали й озвучку. */
export async function continuePipeline(deps: AppDeps, userId: string, projectId: string): Promise<void> {
  const run = await ownRun(deps, userId, projectId);
  const [moved] = await deps.db
    .update(pipelineRuns)
    .set({ stage: 'produce', status: 'running', updatedAt: new Date() })
    .where(
      and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.stage, 'review'), eq(pipelineRuns.status, 'awaiting_review')),
    )
    .returning({ id: pipelineRuns.id });
  if (!moved) throw new AppError('VALIDATION', 'Продовжити можна лише на перевірці сценарію');
  await advanceQuietly(deps, run.id);
}

const live = ['queued', 'running'] as ('queued' | 'running')[];

/**
 * «Скасувати»: запуск, що працює → cancelled (спершу стан — події скасованих задач уже не зрушать запуск), потім
 * скасовуються живі задачі: сценарій, збірка, візуали й перегенерація тексту сцен, генерації фото/відео сцен,
 * переклади мов проєкту, озвучка рядків (рядки звільняє наявний `releaseOnCancel`); скасований переклад
 * «Повторити» ставить знову. Сцени в роботі → empty; генерація, що не завершилась, відв'язується.
 */
export async function cancelPipeline(deps: AppDeps, userId: string, projectId: string): Promise<void> {
  const run = await ownRun(deps, userId, projectId);
  const [moved] = await deps.db
    .update(pipelineRuns)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, 'running')))
    .returning({
      id: pipelineRuns.id,
      scriptJobId: pipelineRuns.scriptJobId,
      assembleJobId: pipelineRuns.assembleJobId,
    });
  if (!moved) throw new AppError('VALIDATION', 'Скасувати можна лише запуск, що працює');

  const scenes = await deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.runId, run.id));
  const sceneIds = scenes.map((sc) => sc.id);
  const genIds = scenes.flatMap((sc) => (sc.generationId ? [sc.generationId] : []));
  const gens = genIds.length
    ? await deps.db
        .select({ id: generations.id, status: generations.status, jobId: generations.jobId })
        .from(generations)
        .where(inArray(generations.id, genIds))
    : [];
  const sceneTextJobs = sceneIds.length
    ? await deps.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, 'pipeline.scene'),
            inArray(jobs.status, live),
            inArray(sql<string>`${jobs.payload}->>'sceneId'`, sceneIds),
          ),
        )
    : [];
  const translateJobs = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, 'voice.translate'),
        inArray(jobs.status, live),
        sql`${jobs.payload}->>'projectId' = ${run.projectId}`,
      ),
    );
  const lineJobs = await deps.db
    .select({ jobId: voiceLines.jobId })
    .from(voiceLines)
    .where(and(eq(voiceLines.projectId, run.projectId), inArray(voiceLines.status, live)));
  const toCancel = new Set(
    [
      moved.scriptJobId, // з оновлення стану: задача, поставлена між читанням запуску й зміною стану, теж скасується
      moved.assembleJobId,
      ...scenes.map((sc) => sc.jobId),
      ...sceneTextJobs.map((j) => j.id),
      ...gens.filter((g) => live.includes(g.status as 'queued')).map((g) => g.jobId),
      ...lineJobs.map((l) => l.jobId),
      ...translateJobs.map((j) => j.id),
    ].filter((id): id is string => !!id),
  );
  for (const id of toCancel) {
    try {
      await deps.jobs.queue.cancel(id);
    } catch (e) {
      deps.log.error({ err: e, jobId: id }, 'pipeline: не вдалося скасувати задачу');
    }
  }

  const unfinished = new Set(gens.filter((g) => g.status !== 'done').map((g) => g.id));
  const detach = scenes.filter((sc) => sc.generationId && unfinished.has(sc.generationId)).map((sc) => sc.id);
  if (detach.length)
    await deps.db
      .update(pipelineScenes)
      .set({ generationId: null })
      .where(and(inArray(pipelineScenes.id, detach), inArray(pipelineScenes.status, live)));
  await deps.db
    .update(pipelineScenes)
    .set({ status: 'empty', jobId: null, error: null, updatedAt: new Date() })
    .where(and(eq(pipelineScenes.runId, run.id), inArray(pipelineScenes.status, live)));
}

/**
 * «Повторити»: failed|cancelled → running (на review — awaiting_review). Задача етапу, що не завершилась успіхом,
 * обнуляється (`advance` поставить її знову); невдала збірка повертає етап на produce, щоб спершу повторились
 * невдалі сцени й рядки. Сцени failed → empty (невдала генерація й її файл відв'язуються); рядки failed → empty;
 * переклад мови, що впав (задачею чи постановкою), ставиться знову.
 * Порядок важливий: переклади ставляться й скидання робляться, поки запуск ще failed|cancelled (advance із
 * паралельних подій нічого не робить), а скидання й зміна стану — однією транзакцією під блокуванням рядка запуску;
 * інакше advance міг би побачити «все кінцеве» й поставити збірку до скидання. Далі — `runAdvance`.
 */
export async function retryPipeline(deps: AppDeps, userId: string, projectId: string): Promise<void> {
  const run = await ownRun(deps, userId, projectId);
  const notRetryable = () => new AppError('VALIDATION', 'Повторити можна лише запуск з помилкою або скасований');
  if (run.status !== 'failed' && run.status !== 'cancelled') throw notRetryable();
  const ids = [run.scriptJobId, run.assembleJobId].filter((id): id is string => !!id);
  const done = new Set(
    ids.length
      ? (
          await deps.db
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(inArray(jobs.id, ids), eq(jobs.status, 'done')))
        ).map((j) => j.id)
      : [],
  );
  const keep = (id: string | null) => (id && done.has(id) ? id : null);
  const stageAfter = (r: RunRow): PipelineStage =>
    r.stage === 'assemble' && !keep(r.assembleJobId) ? 'produce' : r.stage;

  // переклад, що впав або скасований: нова задача поки запуск ще не працює — знімок далі бачить мову live
  if (stageAfter(run) === 'produce') {
    const snap = await loadSnapshot(deps, run.id);
    for (const lang of snap?.langs ?? [])
      if (!lang.isBase && lang.translate === 'failed') {
        try {
          await enqueueTranslate(deps, run.userId, { projectId: run.projectId, language: lang.language });
        } catch (e) {
          // не вдалося поставити — після скидання рядків advance спробує ще раз і позначить мову failed
          deps.log.error({ err: e, runId: run.id }, 'pipeline: не вдалося повторити переклад');
        }
      }
  }

  await deps.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id)).for('update');
    if (!locked || (locked.status !== 'failed' && locked.status !== 'cancelled')) throw notRetryable();
    await resetFailedScenes(tx, run.id);
    await tx
      .update(voiceLines)
      .set({ status: 'empty', error: null, updatedAt: new Date() })
      .where(and(eq(voiceLines.projectId, locked.projectId), eq(voiceLines.status, 'failed')));
    const stage = stageAfter(locked);
    await tx
      .update(pipelineRuns)
      .set({
        stage,
        status: stage === 'review' ? 'awaiting_review' : stage === 'done' ? 'done' : 'running',
        error: null,
        scriptJobId: keep(locked.scriptJobId),
        assembleJobId: keep(locked.assembleJobId),
        updatedAt: new Date(),
      })
      .where(eq(pipelineRuns.id, run.id));
  });
  await advanceQuietly(deps, run.id);
}

/**
 * «Пересібрати чернетку»: лише після `done`; `version` ≠ поточній версії документа → CONFLICT (ручні правки, яких
 * користувач не бачив). Нова задача `pipeline.assemble` (етап лишається done; пише лише вона — `assemble_job_id`).
 * Збірка, що вже йде, повертається та сама.
 */
export async function reassemble(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; version: number },
): Promise<{ jobId: string }> {
  const run = await ownRun(deps, userId, input.projectId);
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id)).for('update');
    if (!locked || locked.stage !== 'done' || locked.status !== 'done')
      throw new AppError('VALIDATION', 'Пересібрати можна лише готову чернетку');
    const [p] = await tx
      .select({ version: projects.timelineVersion })
      .from(projects)
      .where(eq(projects.id, locked.projectId));
    if (!p || p.version !== input.version) throw new AppError('CONFLICT', 'Таймлайн змінено — оновіть сторінку');
    if (locked.assembleJobId) {
      const [j] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, locked.assembleJobId));
      if (j && live.includes(j.status as 'queued')) return { jobId: locked.assembleJobId };
    }
    const jobId = await deps.jobs.queue.enqueue('pipeline.assemble', { projectId: locked.projectId }, { userId });
    await tx
      .update(pipelineRuns)
      .set({ assembleJobId: jobId, updatedAt: new Date() })
      .where(eq(pipelineRuns.id, locked.id));
    return { jobId };
  });
}

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];

/** Сцени failed → empty; генерація, що не дала готового файлу, і згенерований візуал відв'язуються. */
async function resetFailedScenes(tx: Tx, runId: string): Promise<void> {
  const failed = await tx
    .select()
    .from(pipelineScenes)
    .where(and(eq(pipelineScenes.runId, runId), eq(pipelineScenes.status, 'failed')));
  for (const sc of failed) {
    let dropGeneration = false;
    if (sc.generationId) {
      const [g] = await tx.select().from(generations).where(eq(generations.id, sc.generationId));
      const assetId = sc.visualAssetId ?? g?.assetIds[0];
      const [a] = assetId ? await tx.select({ status: assets.status }).from(assets).where(eq(assets.id, assetId)) : [];
      dropGeneration = !g || g.status !== 'done' || !a || a.status === 'failed';
    }
    const dropVisual = dropGeneration && sc.visualSource === 'generated';
    await tx
      .update(pipelineScenes)
      .set({
        status: 'empty',
        jobId: null,
        error: null,
        ...(dropGeneration ? { generationId: null } : {}),
        ...(dropVisual ? { visualAssetId: null, visualSource: null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(pipelineScenes.id, sc.id), eq(pipelineScenes.status, 'failed')));
  }
}

async function thumbs(deps: AppDeps, userId: string, ids: string[]) {
  const wanted = [...new Set(ids.filter(isUuid))];
  const rows = wanted.length
    ? await deps.db
        .select({ id: assets.id, kind: assets.kind, thumbKey: assets.thumbKey })
        .from(assets)
        .where(and(eq(assets.userId, userId), inArray(assets.id, wanted)))
    : [];
  const out = new Map<string, { kind: (typeof rows)[number]['kind']; thumbUrl: string | null }>();
  for (const r of rows)
    out.set(r.id, { kind: r.kind, thumbUrl: r.thumbKey ? await deps.storage.presignGet(r.thumbKey) : null });
  return out;
}

export async function getPipeline(deps: AppDeps, userId: string, projectId: string): Promise<PipelineView> {
  const run = await ownRun(deps, userId, projectId);
  const p = await ownProject(deps, userId, projectId);
  const scenes = await deps.db
    .select()
    .from(pipelineScenes)
    .where(eq(pipelineScenes.runId, run.id))
    .orderBy(asc(pipelineScenes.position));
  // текст сцени — з рядка базової мови навіть для сегмента, якого вже немає в документі
  const baseLines = await deps.db
    .select({ segmentId: voiceLines.segmentId, text: voiceLines.text })
    .from(voiceLines)
    .where(and(eq(voiceLines.projectId, p.id), eq(voiceLines.language, p.baseLanguage)));
  const narration = new Map(baseLines.map((l) => [l.segmentId, l.text]));
  const segIds = new Set((normalizeDoc(p.timeline).segments ?? []).map((s) => s.id));
  const files = await thumbs(
    deps,
    userId,
    scenes.flatMap((s) => [...(s.visualAssetId ? [s.visualAssetId] : []), ...s.suggestions]),
  );

  // стани рядків — як у студії озвучки (з урахуванням «застарілих»)
  const voice = await getVoice(deps, userId, p.id);
  const views: SceneView[] = scenes.map((s) => {
    const file = s.visualAssetId ? files.get(s.visualAssetId) : undefined;
    return {
      id: s.id,
      segmentId: s.segmentId,
      position: s.position,
      narration: narration.get(s.segmentId) ?? '',
      visualPrompt: s.visualPrompt,
      keywords: s.keywords,
      status: s.status,
      error: s.error,
      visual:
        s.visualAssetId && file && file.kind !== 'audio'
          ? {
              assetId: s.visualAssetId,
              thumbUrl: file.thumbUrl,
              kind: file.kind,
              source: s.visualSource ?? 'manual',
            }
          : null,
      suggestions: s.suggestions.flatMap((id) => {
        const f = files.get(id);
        return f ? [{ assetId: id, thumbUrl: f.thumbUrl }] : [];
      }),
      inTimeline: segIds.has(s.segmentId),
      generationId: s.generationId,
      lines: Object.fromEntries(
        Object.entries(voice.lines[s.segmentId] ?? {}).map(([lang, l]) => [lang, { id: l.id, state: l.state }]),
      ),
    };
  });

  const languages = voice.languages.map((language) => {
    let ready = 0;
    let failed = 0;
    for (const seg of voice.segments) {
      const state = voice.lines[seg.id]?.[language]?.state;
      if (state === 'ready') ready++;
      else if (state === 'failed') failed++;
    }
    return { language, ready, total: voice.segments.length, failed };
  });
  const terminal: SceneStatus[] = ['ready', 'failed'];
  const done =
    scenes.filter((s) => terminal.includes(s.status)).length +
    languages.reduce((sum, l) => sum + l.ready + l.failed, 0);
  const total = scenes.length + languages.reduce((sum, l) => sum + l.total, 0);

  return {
    project: {
      id: p.id,
      title: p.title,
      topic: p.topic,
      format: p.format,
      baseLanguage: p.baseLanguage,
      timelineVersion: p.timelineVersion,
    },
    run: {
      stage: run.stage,
      status: run.status,
      error: run.error,
      settings: run.settings,
      assembledVersion: run.assembledVersion,
    },
    scenes: views,
    languages,
    progress: { done, total },
  };
}
