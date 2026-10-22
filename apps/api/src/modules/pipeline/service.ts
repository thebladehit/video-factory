import { and, asc, eq, inArray } from 'drizzle-orm';
import type { CatalogItem } from '@vf/ai';
import { PRESETS } from '@vf/captions';
import { assets, pipelineRuns, pipelineScenes, projects, voiceLines } from '@vf/db';
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
  type VisualSource,
} from '@vf/shared';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { ownProject } from '../projects/service';
import { assertVoiceChoice, getVoice, parseVoice } from '../voice/service';
import { estimatePipeline, type PipelineEstimate } from './estimate';
import { runAdvance } from './run-advance';
import type { RunRow } from './snapshot';

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
}

export interface PipelineView {
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
async function advanceQuietly(deps: AppDeps, runId: string): Promise<void> {
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
    };
  });

  // стани рядків — як у студії озвучки (з урахуванням «застарілих»)
  const voice = await getVoice(deps, userId, p.id);
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
