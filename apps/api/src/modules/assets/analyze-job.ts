import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, eq, isNull } from 'drizzle-orm';
import { assets } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import { MediaToolError, peaks, probe } from '@vf/media';
import { assetKeys, isAppError } from '@vf/shared';
import type { AppDeps } from '../../app';
import type { AssetRow } from './service';

const unreadable = (e: unknown) =>
  (e instanceof MediaToolError && e.reason === 'exit') || (isAppError(e) && e.code === 'VALIDATION');

/**
 * Звук файлу: чи є аудіопотік і, якщо є, піки хвилі у сховищі.
 * Нечитабельний звук — `hasAudio: false` (файл лишається придатним, аналіз не повторюється при кожному старті).
 */
export async function analyzeAsset(
  deps: AppDeps,
  row: Pick<AssetRow, 'id' | 'userId' | 'kind'>,
  local: string,
  signal: AbortSignal,
): Promise<{ hasAudio: boolean; peaksKey: string | null }> {
  if (row.kind === 'image') return { hasAudio: false, peaksKey: null };
  let data: Uint8Array;
  try {
    const meta = await probe(deps.media, local, { signal });
    if (!meta.hasAudio) return { hasAudio: false, peaksKey: null };
    data = await peaks(deps.media, local, { signal });
  } catch (e) {
    if (unreadable(e)) return { hasAudio: false, peaksKey: null };
    throw e;
  }
  const peaksKey = assetKeys.peaks(row.userId, row.id);
  await deps.storage.put(peaksKey, data, { contentType: 'application/octet-stream' });
  return { hasAudio: true, peaksKey };
}

/**
 * asset.analyze: для файлів, оброблених до появи аналізу звуку (`has_audio is null`).
 * Ідемпотентна: працює лише з ready-відео/аудіо без результату; запис — умовний.
 */
export function assetAnalyzeJob(deps: AppDeps): JobDef<{ assetId: string }, { assetId: string }> {
  return {
    type: 'asset.analyze',
    concurrency: 2,
    async handler({ assetId }, ctx) {
      const [row] = await deps.db.select().from(assets).where(eq(assets.id, assetId));
      if (!row || row.status !== 'ready' || row.hasAudio !== null || row.kind === 'image') return { assetId };
      const dir = await mkdtemp(join(tmpdir(), 'vf-analyze-'));
      try {
        const obj = await deps.storage.get(row.storageKey).catch((e) => {
          if (isAppError(e) && e.code === 'NOT_FOUND') return null;
          throw e;
        });
        let result: { hasAudio: boolean; peaksKey: string | null } = { hasAudio: false, peaksKey: null };
        if (obj) {
          const local = join(dir, 'original');
          await pipeline(obj.body, createWriteStream(local));
          result = await analyzeAsset(deps, row, local, ctx.signal);
        }
        const [updated] = await deps.db
          .update(assets)
          .set(result)
          .where(and(eq(assets.id, assetId), isNull(assets.hasAudio)))
          .returning({ id: assets.id });
        if (!updated && result.peaksKey) {
          // файл видалили, поки аналізували
          const [still] = await deps.db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId));
          if (!still) await deps.storage.delete(result.peaksKey);
        }
        return { assetId };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
