import { and, arrayContains, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { assets, pipelineRuns, pipelineScenes, projectLanguageTimelines, projects, renders, voiceLines } from '@vf/db';
import {
  AppError,
  emptyTimeline,
  normalizeDoc,
  type MediaClip,
  type PipelineStage,
  type PipelineStatus,
  type TimelineDoc,
  type VideoFormat,
} from '@vf/shared';
import { docDuration } from '@vf/timeline';
import type { AppDeps } from '../../app';
import { editorAssets, ensureAnalyzed, isUuid, type EditorAsset } from './editor-assets';

export interface ProjectCard {
  id: string;
  title: string;
  format: VideoFormat;
  durationSec: number;
  thumbUrl: string | null;
  updatedAt: string;
  /** Запуск конвеєра: етап і прогрес (сцени ready|failed + рядки мов ready|failed); null — проєкт без запуску */
  pipeline: { stage: PipelineStage; status: PipelineStatus; done: number; total: number } | null;
}

export interface ProjectView {
  id: string;
  title: string;
  format: VideoFormat;
  timeline: TimelineDoc;
  version: number;
  assets: Record<string, EditorAsset>;
}

export type ProjectRow = typeof projects.$inferSelect;

const notFound = () => new AppError('NOT_FOUND', 'Проєкт не знайдено');

export async function ownProject(deps: AppDeps, userId: string, id: string): Promise<ProjectRow> {
  if (!isUuid(id)) throw notFound();
  const [row] = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)));
  if (!row) throw notFound();
  return row;
}

/** Унікальні uuid файлів таймлайну (`local:…` ще не завантажені — не враховуються). */
export function timelineAssetIds(doc: TimelineDoc): string[] {
  const ids = new Set<string>();
  for (const t of doc.tracks)
    if (t.kind !== 'captions') for (const c of t.clips) if (isUuid(c.assetId)) ids.add(c.assetId);
  return [...ids];
}

const formatOf = (doc: TimelineDoc): VideoFormat => (doc.width < doc.height ? '9:16' : '16:9');

/** Перший за часом кліп нижньої відео-доріжки, що має файл. */
export function firstVisualAsset(doc: TimelineDoc): string | null {
  let best: MediaClip | null = null;
  for (const t of doc.tracks)
    if (t.kind === 'video') for (const c of t.clips) if (!best || c.start < best.start) best = c;
  return best?.assetId ?? null;
}

const safeSegments = (doc: unknown) => {
  try {
    return normalizeDoc(doc).segments ?? [];
  } catch {
    return [];
  }
};

/** Прогрес запусків конвеєра проєктів (за сирими статусами сцен і рядків — без підписів URL). */
async function pipelineCards(deps: AppDeps, userId: string, rows: ProjectRow[]) {
  const out = new Map<string, NonNullable<ProjectCard['pipeline']>>();
  const runs = await deps.db
    .select()
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.userId, userId),
        inArray(
          pipelineRuns.projectId,
          rows.map((r) => r.id),
        ),
      ),
    );
  if (!runs.length) return out;
  const scenes = await deps.db
    .select({ runId: pipelineScenes.runId, status: pipelineScenes.status })
    .from(pipelineScenes)
    .where(
      inArray(
        pipelineScenes.runId,
        runs.map((r) => r.id),
      ),
    );
  const lines = await deps.db
    .select({
      projectId: voiceLines.projectId,
      segmentId: voiceLines.segmentId,
      language: voiceLines.language,
      status: voiceLines.status,
    })
    .from(voiceLines)
    .where(
      inArray(
        voiceLines.projectId,
        runs.map((r) => r.projectId),
      ),
    );
  for (const run of runs) {
    const p = rows.find((r) => r.id === run.projectId)!;
    const segIds = new Set(safeSegments(p.timeline).map((s) => s.id));
    const languages = p.languages.includes(p.baseLanguage) ? p.languages : [p.baseLanguage, ...p.languages];
    const own = scenes.filter((s) => s.runId === run.id);
    const terminalLines = lines.filter(
      (l) =>
        l.projectId === p.id &&
        segIds.has(l.segmentId) &&
        languages.includes(l.language) &&
        (l.status === 'ready' || l.status === 'failed'),
    ).length;
    out.set(p.id, {
      stage: run.stage,
      status: run.status,
      done: own.filter((s) => s.status === 'ready' || s.status === 'failed').length + terminalLines,
      total: own.length + segIds.size * languages.length,
    });
  }
  return out;
}

const safeDuration = (doc: unknown) => {
  try {
    return docDuration(normalizeDoc(doc));
  } catch {
    return 0;
  }
};

export async function listProjects(deps: AppDeps, userId: string): Promise<ProjectCard[]> {
  const rows = await deps.db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt));
  if (!rows.length) return [];
  // мініатюра: останній готовий рендер, інакше перший візуальний кліп
  const done = await deps.db
    .select({ projectId: renders.projectId, assetId: renders.outputAssetId, createdAt: renders.createdAt })
    .from(renders)
    .where(
      and(
        inArray(
          renders.projectId,
          rows.map((r) => r.id),
        ),
        eq(renders.status, 'done'),
        isNotNull(renders.outputAssetId),
      ),
    )
    .orderBy(desc(renders.createdAt));
  const lastRender = new Map<string, string>();
  for (const r of done) if (r.assetId && !lastRender.has(r.projectId)) lastRender.set(r.projectId, r.assetId);
  const wanted = new Map<string, string | null>();
  for (const p of rows) {
    // пошкоджений документ не має валити весь список
    let first: string | null = null;
    try {
      first = firstVisualAsset(normalizeDoc(p.timeline));
    } catch {
      first = null;
    }
    wanted.set(p.id, lastRender.get(p.id) ?? (first && isUuid(first) ? first : null));
  }
  const ids = [...new Set([...wanted.values()].filter((v): v is string => !!v))];
  const thumbs = ids.length
    ? await deps.db
        .select({ id: assets.id, thumbKey: assets.thumbKey })
        .from(assets)
        .where(and(eq(assets.userId, userId), inArray(assets.id, ids)))
    : [];
  const thumbKey = new Map(thumbs.map((t) => [t.id, t.thumbKey]));
  const pipelines = await pipelineCards(deps, userId, rows);
  return Promise.all(
    rows.map(async (p) => {
      const key = thumbKey.get(wanted.get(p.id) ?? '') ?? null;
      return {
        id: p.id,
        title: p.title,
        format: p.format,
        durationSec: safeDuration(p.timeline),
        thumbUrl: key ? await deps.storage.presignGet(key) : null,
        updatedAt: p.updatedAt.toISOString(),
        pipeline: pipelines.get(p.id) ?? null,
      };
    }),
  );
}

export async function createProject(deps: AppDeps, userId: string, input: { title: string; format: VideoFormat }) {
  const [row] = await deps.db
    .insert(projects)
    .values({ userId, title: input.title, format: input.format, timeline: emptyTimeline(input.format) })
    .returning({ id: projects.id });
  return { id: row!.id };
}

/** Проєкт або (з `language`) відокремлена мовна версія його документа — зі своєю версією. */
export async function getProject(deps: AppDeps, userId: string, id: string, language?: string): Promise<ProjectView> {
  const p = await ownProject(deps, userId, id);
  let raw: unknown = p.timeline;
  let version = p.timelineVersion;
  if (language !== undefined) {
    const row = await languageRow(deps, p.id, language);
    raw = row.timeline;
    version = row.timelineVersion;
  }
  const timeline = normalizeDoc(raw);
  const ids = [
    ...new Set(timeline.tracks.flatMap((t) => (t.kind === 'captions' ? [] : t.clips.map((c) => c.assetId)))),
  ];
  const list = await editorAssets(deps, userId, ids);
  await ensureAnalyzed(deps, userId, list);
  return { id: p.id, title: p.title, format: p.format, timeline, version, assets: list };
}

const notSeparated = () => new AppError('NOT_FOUND', 'Мовну версію не відокремлено');

/** Відокремлена мовна версія документа (`null` — мова не відокремлена). */
export async function languageTimeline(deps: AppDeps, projectId: string, language: string) {
  const [row] = await deps.db
    .select()
    .from(projectLanguageTimelines)
    .where(and(eq(projectLanguageTimelines.projectId, projectId), eq(projectLanguageTimelines.language, language)));
  return row ?? null;
}

async function languageRow(deps: AppDeps, projectId: string, language: string) {
  const row = await languageTimeline(deps, projectId, language);
  if (!row) throw notSeparated();
  return row;
}

const conflict = () => new AppError('CONFLICT', 'Проєкт змінено в іншій вкладці');

/** Оптимістичне збереження: пише лише поверх `baseVersion`, інакше CONFLICT. З `language` — відокремлена мова. */
export async function saveProject(
  deps: AppDeps,
  userId: string,
  input: { id: string; language?: string; timeline: unknown; baseVersion: number },
): Promise<{ version: number }> {
  const doc = normalizeDoc(input.timeline);
  if (!isUuid(input.id)) throw notFound();
  if (input.language !== undefined) {
    const p = await ownProject(deps, userId, input.id);
    const [row] = await deps.db
      .update(projectLanguageTimelines)
      .set({ timeline: doc, timelineVersion: input.baseVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(projectLanguageTimelines.projectId, p.id),
          eq(projectLanguageTimelines.language, input.language),
          eq(projectLanguageTimelines.timelineVersion, input.baseVersion),
        ),
      )
      .returning({ version: projectLanguageTimelines.timelineVersion });
    if (row) return { version: row.version };
    await languageRow(deps, p.id, input.language);
    throw conflict();
  }
  const [row] = await deps.db
    .update(projects)
    .set({
      timeline: doc,
      timelineVersion: input.baseVersion + 1,
      assetIds: timelineAssetIds(doc),
      format: formatOf(doc),
      fps: doc.fps,
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, input.id), eq(projects.userId, userId), eq(projects.timelineVersion, input.baseVersion)))
    .returning({ version: projects.timelineVersion });
  if (row) return { version: row.version };
  await ownProject(deps, userId, input.id);
  throw conflict();
}

export async function renameProject(
  deps: AppDeps,
  userId: string,
  input: { id: string; title: string },
): Promise<void> {
  await ownProject(deps, userId, input.id);
  await deps.db
    .update(projects)
    .set({ title: input.title, updatedAt: new Date() })
    .where(and(eq(projects.id, input.id), eq(projects.userId, userId)));
}

export async function duplicateProject(deps: AppDeps, userId: string, id: string): Promise<{ id: string }> {
  const p = await ownProject(deps, userId, id);
  const [row] = await deps.db
    .insert(projects)
    .values({
      userId,
      title: `${p.title} (копія)`,
      format: p.format,
      fps: p.fps,
      timeline: p.timeline,
      assetIds: p.assetIds,
      topic: p.topic,
      baseLanguage: p.baseLanguage,
      languages: p.languages,
    })
    .returning({ id: projects.id });
  return { id: row!.id };
}

/** Рендери видаляються каскадом, їхні файли в бібліотеці лишаються. */
export async function deleteProject(deps: AppDeps, userId: string, id: string): Promise<void> {
  await ownProject(deps, userId, id);
  await deps.db.delete(projects).where(and(eq(projects.id, id), eq(projects.userId, userId)));
}

/** Проєкти, де використано файл — для попередження перед видаленням. */
export async function assetUsage(
  deps: AppDeps,
  userId: string,
  assetId: string,
): Promise<{ projectId: string; title: string }[]> {
  if (!isUuid(assetId)) return [];
  return deps.db
    .select({ projectId: projects.id, title: projects.title })
    .from(projects)
    .where(and(eq(projects.userId, userId), arrayContains(projects.assetIds, [assetId])))
    .orderBy(desc(projects.updatedAt));
}
