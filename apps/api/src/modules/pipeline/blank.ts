import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { solidPng } from '@vf/ai';
import { assets } from '@vf/db';
import { assetKeys, FORMATS, type VideoFormat } from '@vf/shared';
import type { SceneVisual } from '@vf/timeline';
import type { AppDeps } from '../../app';
import { PIPELINE_TAG } from './run-advance';

/** Тег і назва чорної заглушки сцени без візуалу */
export const BLANK_TAG = 'заглушка';
export const BLANK_TITLE = 'Порожня сцена';

/**
 * Чорна заглушка «Порожня сцена» розміру формату — одна на користувача й формат. Немає — PNG у сховище й рядок
 * `assets` одразу `ready` (без asset.process: розміри відомі, мініатюра не потрібна). Паралельні виклики не
 * створюють двох: пошук і створення — під `pg_advisory_xact_lock` на користувача й формат.
 */
export async function ensureBlankAsset(deps: AppDeps, userId: string, format: VideoFormat): Promise<SceneVisual> {
  const { width, height } = FORMATS[format];
  const assetId = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pipeline-blank:${userId}:${format}`}, 0))`);
    const [found] = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.userId, userId),
          eq(assets.kind, 'image'),
          eq(assets.status, 'ready'),
          eq(assets.width, width),
          eq(assets.height, height),
          sql`${assets.tags} @> array[${BLANK_TAG}]::text[]`,
        ),
      )
      .limit(1);
    if (found) return found.id;
    const id = randomUUID();
    const bytes = solidPng(width, height, [0, 0, 0]);
    const storageKey = assetKeys.original(userId, id, 'png');
    await deps.storage.put(storageKey, bytes, { contentType: 'image/png' });
    await tx.insert(assets).values({
      id,
      userId,
      kind: 'image',
      source: 'generated',
      status: 'ready',
      storageKey,
      mime: 'image/png',
      width,
      height,
      sizeBytes: bytes.length,
      title: BLANK_TITLE,
      tags: [BLANK_TAG, PIPELINE_TAG],
    });
    return id;
  });
  return { assetId, kind: 'image', width, height, blank: true };
}
