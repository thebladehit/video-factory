import { and, desc, eq, ne, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import { assets } from '@vf/db';
import type { VideoFormat } from '@vf/shared';
import type { AppDeps } from '../../app';
import { rankExpr } from './search';

/** Мінімальний score для автопідстановки; підібрано на фікстурі assets-match.int.test.ts */
export const LIBRARY_MATCH_MIN = 0.5;
const DEFAULT_LIMIT = 4;

export interface AssetMatch {
  assetId: string;
  score: number;
  kind: 'image' | 'video';
  width: number;
  height: number;
  durationMs: number | null;
}

/** Ранжує готові фото/відео користувача за ключовими словами сцени (кожне окремо й усі разом; score = максимум). */
export async function matchAssets(
  deps: AppDeps,
  userId: string,
  i: { keywords: string[]; format: VideoFormat; exclude: string[]; limit?: number },
): Promise<AssetMatch[]> {
  const words = i.keywords.map((k) => k.trim()).filter((k) => k.length >= 3);
  if (!words.length) return [];
  const queries = [...new Set([...words, words.join(' ')])];
  const score = sql<number>`greatest(${sql.join(queries.map(rankExpr), sql`, `)})`;
  // 9:16 → вертикальні або квадратні, 16:9 → горизонтальні або квадратні
  const orient: SQL =
    i.format === '9:16' ? sql`${assets.height} >= ${assets.width}` : sql`${assets.width} >= ${assets.height}`;
  const where: SQL[] = [
    eq(assets.userId, userId),
    eq(assets.status, 'ready'),
    inArray(assets.kind, ['image', 'video']),
    sql`${assets.width} is not null and ${assets.height} is not null`,
    orient,
    // власні готові рендери (назва «<проєкт> (мова) — дата») збігаються з темою майже ідеально, але не є матеріалом сцени
    ne(assets.source, 'rendered'),
    // чорна заглушка конвеєра («Порожня сцена», pipeline/blank.ts) — не кандидат для сцени
    sql`not (${assets.tags} @> array['заглушка']::text[])`,
  ];
  if (i.exclude.length) where.push(notInArray(assets.id, i.exclude));
  const rows = await deps.db
    .select({
      id: assets.id,
      kind: assets.kind,
      width: assets.width,
      height: assets.height,
      durationMs: assets.durationMs,
      score,
    })
    .from(assets)
    .where(and(...where))
    .orderBy(desc(score), desc(assets.createdAt), desc(assets.id))
    .limit(i.limit ?? DEFAULT_LIMIT);
  return rows
    .filter((r) => Number(r.score) > 0.01)
    .map((r) => ({
      assetId: r.id,
      score: Number(r.score),
      kind: r.kind as 'image' | 'video',
      width: r.width!,
      height: r.height!,
      durationMs: r.durationMs,
    }));
}
