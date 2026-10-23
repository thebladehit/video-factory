import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { assets, generations } from '@vf/db';
import {
  AppError,
  normalizeTags,
  type AssetKind,
  type AssetSource,
  type AssetStatus,
  type Orientation,
} from '@vf/shared';
import type { AppDeps } from '../../app';
import { ownAsset, type AssetRow } from './service';

export interface AssetView {
  id: string;
  kind: AssetKind;
  source: AssetSource;
  status: AssetStatus;
  error: string | null;
  title: string;
  tags: string[];
  mime: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** null — ще не проаналізовано */
  hasAudio: boolean | null;
  sizeBytes: number | null;
  prompt: string | null;
  url: string;
  /** Те саме, але браузер збереже файл, а не відкриє */
  downloadUrl: string;
  thumbUrl: string | null;
  createdAt: string;
  generation: { model: string; costEstimate: number | null } | null;
}

export interface ListInput {
  q?: string;
  kind?: AssetKind;
  source?: 'uploaded' | 'generated';
  orientation?: Orientation;
  tags?: string[];
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 60;
const TRIGRAM_THRESHOLD = 0.35;
const tagsText = sql`vf_tags_text(${assets.tags})`;

/** Ранг збігу: full-text + trigram-схожість назви/тегів. Спільний для пошуку й підбору під сцени. */
export function rankExpr(q: string): SQL {
  return sql`ts_rank(${assets.search}, websearch_to_tsquery('simple', ${q})) + greatest(word_similarity(${q}, ${assets.title}), word_similarity(${q}, ${tagsText}))`;
}

type Cursor = { o: number } | { c: string; i: string };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(s: string | undefined): Cursor | null {
  if (!s) return null;
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString()) as Cursor;
  } catch {
    throw new AppError('VALIDATION', 'Некоректний курсор');
  }
}

const selection = {
  asset: assets,
  genProvider: generations.provider,
  genModel: generations.model,
  genCost: generations.costEstimate,
  // текстом — щоб курсор не губив мікросекунди
  createdAtText: sql<string>`${assets.createdAt}::text`,
};
type Joined = { asset: AssetRow; genProvider: string | null; genModel: string | null; genCost: string | null };

const downloadName = (a: AssetRow) => {
  if (a.originalName) return a.originalName;
  const ext = a.storageKey.slice(a.storageKey.lastIndexOf('.') + 1);
  return `${(a.title || 'file').slice(0, 80)}.${ext}`;
};

async function toView(deps: AppDeps, r: Joined): Promise<AssetView> {
  const a = r.asset;
  return {
    id: a.id,
    kind: a.kind,
    source: a.source,
    status: a.status,
    error: a.error,
    title: a.title,
    tags: a.tags,
    mime: a.mime,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    hasAudio: a.hasAudio,
    sizeBytes: a.sizeBytes,
    prompt: a.prompt,
    url: await deps.storage.presignGet(a.storageKey),
    downloadUrl: await deps.storage.presignGet(a.storageKey, { downloadName: downloadName(a) }),
    thumbUrl: a.thumbKey ? await deps.storage.presignGet(a.thumbKey) : null,
    createdAt: a.createdAt.toISOString(),
    generation:
      r.genProvider && r.genModel
        ? { model: `${r.genProvider}/${r.genModel}`, costEstimate: r.genCost === null ? null : Number(r.genCost) }
        : null,
  };
}

const joined = (deps: AppDeps) =>
  deps.db.select(selection).from(assets).leftJoin(generations, eq(generations.id, assets.generationId));

/** Пошук: full-text (title + теги + промпт) АБО trigram-схожість назви/тегів; фільтри; курсорна пагінація. */
export async function listAssets(
  deps: AppDeps,
  userId: string,
  i: ListInput,
): Promise<{ items: AssetView[]; nextCursor: string | null }> {
  const limit = Math.min(i.limit ?? DEFAULT_LIMIT, 100);
  const q = i.q?.trim() || null;
  const where: SQL[] = [eq(assets.userId, userId), eq(assets.status, 'ready')];
  if (i.kind) where.push(eq(assets.kind, i.kind));
  if (i.source) where.push(eq(assets.source, i.source));
  if (i.orientation === 'vertical') where.push(sql`${assets.height} > ${assets.width}`);
  if (i.orientation === 'horizontal') where.push(sql`${assets.width} > ${assets.height}`);
  if (i.orientation === 'square') where.push(sql`${assets.width} = ${assets.height}`);
  const tags = normalizeTags(i.tags ?? []);
  if (tags.length)
    where.push(
      sql`${assets.tags} @> ARRAY[${sql.join(
        tags.map((t) => sql`${t}`),
        sql`, `,
      )}]::text[]`,
    );
  const cursor = decodeCursor(i.cursor);

  if (q) {
    const tsq = sql`websearch_to_tsquery('simple', ${q})`;
    const fuzzy = sql`greatest(word_similarity(${q}, ${assets.title}), word_similarity(${q}, ${tagsText}))`;
    where.push(sql`(${assets.search} @@ ${tsq} or ${fuzzy} > ${TRIGRAM_THRESHOLD})`);
    const offset = cursor && 'o' in cursor ? cursor.o : 0;
    const rows = await joined(deps)
      .where(and(...where))
      .orderBy(sql`${rankExpr(q)} desc`, desc(assets.createdAt), desc(assets.id))
      .limit(limit + 1)
      .offset(offset);
    const items = await Promise.all(rows.slice(0, limit).map((r) => toView(deps, r)));
    return { items, nextCursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null };
  }

  if (cursor && 'c' in cursor)
    where.push(sql`(${assets.createdAt}, ${assets.id}) < (${cursor.c}::timestamptz, ${cursor.i}::uuid)`);
  const rows = await joined(deps)
    .where(and(...where))
    .orderBy(desc(assets.createdAt), desc(assets.id))
    .limit(limit + 1);
  const items = await Promise.all(rows.slice(0, limit).map((r) => toView(deps, r)));
  const last = rows[limit - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor({ c: last.createdAtText, i: last.asset.id }) : null,
  };
}

/** Блок «В роботі»: uploading / processing / failed */
export async function pendingAssets(deps: AppDeps, userId: string): Promise<AssetView[]> {
  const rows = await joined(deps)
    .where(and(eq(assets.userId, userId), inArray(assets.status, ['uploading', 'processing', 'failed'])))
    .orderBy(desc(assets.createdAt), desc(assets.id))
    .limit(50);
  return Promise.all(rows.map((r) => toView(deps, r)));
}

export async function getAsset(deps: AppDeps, userId: string, id: string): Promise<AssetView> {
  const row = await ownAsset(deps, userId, id);
  const [r] = await joined(deps).where(eq(assets.id, row.id));
  return toView(deps, r!);
}

export async function updateAsset(
  deps: AppDeps,
  userId: string,
  i: { id: string; title?: string; tags?: string[] },
): Promise<AssetView> {
  const row = await ownAsset(deps, userId, i.id);
  const patch: Partial<typeof assets.$inferInsert> = {};
  if (i.title !== undefined) patch.title = i.title.trim();
  if (i.tags !== undefined) patch.tags = normalizeTags(i.tags);
  if (Object.keys(patch).length) await deps.db.update(assets).set(patch).where(eq(assets.id, row.id));
  return getAsset(deps, userId, row.id);
}

export async function deleteAsset(deps: AppDeps, userId: string, id: string): Promise<void> {
  const row = await ownAsset(deps, userId, id);
  if (row.uploadId) await deps.storage.abortMultipart(row.storageKey, row.uploadId);
  await deps.storage.delete(row.storageKey);
  if (row.thumbKey) await deps.storage.delete(row.thumbKey);
  if (row.peaksKey) await deps.storage.delete(row.peaksKey);
  await deps.db.delete(assets).where(eq(assets.id, row.id));
}

export async function topTags(deps: AppDeps, userId: string, limit = 20): Promise<{ tag: string; count: number }[]> {
  const rows = await deps.db.execute<{ tag: string; count: number }>(sql`
    select tag, count(*)::int as count
    from ${assets}, unnest(${assets.tags}) as tag
    where ${assets.userId} = ${userId} and ${assets.status} = 'ready'
    group by tag
    order by count desc, tag asc
    limit ${limit}`);
  return rows.map((r) => ({ tag: r.tag, count: r.count }));
}
