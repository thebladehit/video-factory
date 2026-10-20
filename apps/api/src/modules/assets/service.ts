import { and, eq } from 'drizzle-orm';
import { assets } from '@vf/db';
import {
  AppError,
  assetKeys,
  MULTIPART_THRESHOLD,
  PART_SIZE,
  titleFromName,
  validateUpload,
  type AssetStatus,
} from '@vf/shared';
import type { AppDeps } from '../../app';

export type AssetRow = typeof assets.$inferSelect;
export type UploadTicket =
  | { assetId: string; mode: 'single'; url: string }
  | { assetId: string; mode: 'multipart'; uploadId: string; partSize: number };

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Asset поточного користувача; чужий, неіснуючий або некоректний id → NOT_FOUND */
export async function ownAsset(deps: AppDeps, userId: string, assetId: string): Promise<AssetRow> {
  const [row] = isUuid(assetId)
    ? await deps.db
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
    : [];
  if (!row) throw new AppError('NOT_FOUND', 'Файл не знайдено', { assetId });
  return row;
}

const uploading = (row: AssetRow) => {
  if (row.status !== 'uploading') throw new AppError('CONFLICT', 'Файл уже завантажено', { status: row.status });
  return row;
};

export async function createUpload(
  deps: AppDeps,
  userId: string,
  i: { name: string; mime: string; size: number },
): Promise<UploadTicket> {
  const { kind, mime, ext } = validateUpload(i);
  await deps.bucket.ensure();
  const id = crypto.randomUUID();
  const storageKey = assetKeys.original(userId, id, ext);
  const multipart = i.size >= MULTIPART_THRESHOLD;
  const uploadId = multipart ? await deps.storage.createMultipart(storageKey, { contentType: mime }) : null;
  await deps.db.insert(assets).values({
    id,
    userId,
    kind,
    source: 'uploaded',
    status: 'uploading',
    storageKey,
    mime,
    sizeBytes: i.size,
    title: titleFromName(i.name),
    originalName: i.name,
    uploadId,
  });
  if (uploadId) return { assetId: id, mode: 'multipart', uploadId, partSize: PART_SIZE };
  return { assetId: id, mode: 'single', url: await deps.storage.presignPut(storageKey, { contentType: mime }) };
}

export async function signParts(
  deps: AppDeps,
  userId: string,
  i: { assetId: string; partNumbers: number[] },
): Promise<{ partNumber: number; url: string }[]> {
  const row = uploading(await ownAsset(deps, userId, i.assetId));
  if (!row.uploadId) throw new AppError('VALIDATION', 'Це не multipart-завантаження');
  return Promise.all(
    i.partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await deps.storage.presignPart(row.storageKey, row.uploadId!, partNumber),
    })),
  );
}

export async function listUploadedParts(deps: AppDeps, userId: string, assetId: string) {
  const row = uploading(await ownAsset(deps, userId, assetId));
  if (!row.uploadId) return [];
  return deps.storage.listParts(row.storageKey, row.uploadId);
}

/** Ідемпотентно: для вже підтвердженого файлу повертає поточний стан і не ставить задачу вдруге. */
export async function completeUpload(
  deps: AppDeps,
  userId: string,
  i: { assetId: string; parts?: { PartNumber: number; ETag: string }[] },
): Promise<{ status: AssetStatus }> {
  const row = await ownAsset(deps, userId, i.assetId);
  if (row.status !== 'uploading') return { status: row.status };
  if (row.uploadId) {
    if (!i.parts?.length) throw new AppError('VALIDATION', 'Не передано частини multipart-завантаження');
    await deps.storage.completeMultipart(row.storageKey, row.uploadId, i.parts);
  }
  const head = await deps.storage.head(row.storageKey);
  if (!head) throw new AppError('VALIDATION', 'Файл не завантажено в сховище');
  if (head.size !== row.sizeBytes) {
    throw new AppError(
      'VALIDATION',
      `Завантажений розмір (${head.size} Б) не збігається із заявленим (${row.sizeBytes} Б)`,
    );
  }
  const [updated] = await deps.db
    .update(assets)
    .set({ status: 'processing', uploadId: null })
    .where(and(eq(assets.id, row.id), eq(assets.status, 'uploading')))
    .returning({ id: assets.id });
  // паралельний complete уже поставив задачу
  if (!updated) return { status: (await ownAsset(deps, userId, row.id)).status };
  await deps.jobs.queue.enqueue('asset.process', { assetId: row.id }, { userId });
  return { status: 'processing' };
}

export async function abortUpload(deps: AppDeps, userId: string, assetId: string): Promise<void> {
  const row = uploading(await ownAsset(deps, userId, assetId));
  if (row.uploadId) await deps.storage.abortMultipart(row.storageKey, row.uploadId);
  await deps.storage.delete(row.storageKey);
  await deps.db.delete(assets).where(eq(assets.id, row.id));
}

/** «Повторити» для файлу з помилкою обробки */
export async function retryProcess(deps: AppDeps, userId: string, assetId: string): Promise<{ jobId: string }> {
  const row = await ownAsset(deps, userId, assetId);
  if (row.status !== 'failed')
    throw new AppError('CONFLICT', 'Повторити можна лише файл з помилкою', { status: row.status });
  await deps.db
    .update(assets)
    .set({ status: 'processing', error: null })
    .where(and(eq(assets.id, row.id), eq(assets.status, 'failed')));
  return { jobId: await deps.jobs.queue.enqueue('asset.process', { assetId: row.id }, { userId }) };
}
