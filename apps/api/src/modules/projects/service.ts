import { and, arrayContains, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { assets, projects, renders } from '@vf/db';
import { AppError, emptyTimeline, normalizeDoc, type MediaClip, type TimelineDoc, type VideoFormat } from '@vf/shared';
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
function firstVisualAsset(doc: TimelineDoc): string | null {
  let best: MediaClip | null = null;
  for (const t of doc.tracks)
    if (t.kind === 'video') for (const c of t.clips) if (!best || c.start < best.start) best = c;
  return best?.assetId ?? null;
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
    const first = firstVisualAsset(p.timeline);
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

export async function getProject(deps: AppDeps, userId: string, id: string): Promise<ProjectView> {
  const p = await ownProject(deps, userId, id);
  const timeline = normalizeDoc(p.timeline);
  const ids = [
    ...new Set(timeline.tracks.flatMap((t) => (t.kind === 'captions' ? [] : t.clips.map((c) => c.assetId)))),
  ];
  const list = await editorAssets(deps, userId, ids);
  await ensureAnalyzed(deps, userId, list);
  return { id: p.id, title: p.title, format: p.format, timeline, version: p.timelineVersion, assets: list };
}

/** Оптимістичне збереження: пише лише поверх `baseVersion`, інакше CONFLICT. */
export async function saveProject(
  deps: AppDeps,
  userId: string,
  input: { id: string; timeline: unknown; baseVersion: number },
): Promise<{ version: number }> {
  const doc = normalizeDoc(input.timeline);
  if (!isUuid(input.id)) throw notFound();
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
  throw new AppError('CONFLICT', 'Проєкт змінено в іншій вкладці');
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
