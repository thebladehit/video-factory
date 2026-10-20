import { eq } from 'drizzle-orm';
import type { GeneratedFile } from '@vf/ai';
import { assets, generations } from '@vf/db';
import { assetKeys, kindForMime, titleFromPrompt } from '@vf/shared';
import type { AppDeps } from '../../app';

type GenerationRow = typeof generations.$inferSelect;
const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/**
 * Результати генерації → assets (processing) + generations.asset_ids однією транзакцією, потім S3 і asset.process
 * для кожного файлу. Якщо збій на середині — asset_ids уже записані, тож повтор не звертається до провайдера
 * (і не платить удруге): файл, що не встиг потрапити в сховище, отримає «failed» з поясненням.
 * URL провайдерів тимчасові, тож байти зберігаємо одразу.
 */
export async function storeGeneratedFiles(deps: AppDeps, g: GenerationRow, files: GeneratedFile[]): Promise<string[]> {
  const rows = files.map((file) => {
    const kind = kindForMime(file.mime);
    if (!kind) throw new Error(`Провайдер повернув непідтримуваний тип файлу: ${file.mime}`);
    const id = crypto.randomUUID();
    return {
      file,
      row: {
        id,
        userId: g.userId,
        kind,
        source: 'generated' as const,
        status: 'processing' as const,
        storageKey: assetKeys.original(g.userId, id, EXT[file.mime] ?? 'bin'),
        mime: file.mime,
        sizeBytes: file.bytes.length,
        title: titleFromPrompt(g.prompt ?? ''),
        prompt: g.prompt,
        generationId: g.id,
      },
    };
  });
  const ids = rows.map((r) => r.row.id);
  await deps.db.transaction(async (tx) => {
    if (rows.length) await tx.insert(assets).values(rows.map((r) => r.row));
    await tx.update(generations).set({ assetIds: ids }).where(eq(generations.id, g.id));
  });
  for (const { file, row } of rows) {
    await deps.storage.put(row.storageKey, file.bytes, { contentType: file.mime });
    await deps.jobs.queue.enqueue('asset.process', { assetId: row.id }, { userId: g.userId });
  }
  return ids;
}

export const setGenerationStatus = (deps: AppDeps, id: string, patch: Partial<typeof generations.$inferInsert>) =>
  deps.db.update(generations).set(patch).where(eq(generations.id, id));
