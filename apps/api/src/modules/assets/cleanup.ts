import { and, eq, lt } from 'drizzle-orm';
import { assets } from '@vf/db';
import type { AppDeps } from '../../app';

const DAY_MS = 86_400_000;

/** Видаляє «завислі» завантаження (вкладку закрили посеред завантаження): рядок, multipart і об'єкт. */
export async function cleanupStaleUploads(deps: AppDeps, olderThanMs = DAY_MS): Promise<number> {
  const stale = await deps.db
    .select()
    .from(assets)
    .where(and(eq(assets.status, 'uploading'), lt(assets.createdAt, new Date(Date.now() - olderThanMs))));
  for (const row of stale) {
    if (row.uploadId) await deps.storage.abortMultipart(row.storageKey, row.uploadId);
    await deps.storage.delete(row.storageKey);
    await deps.db.delete(assets).where(and(eq(assets.id, row.id), eq(assets.status, 'uploading')));
  }
  return stale.length;
}
