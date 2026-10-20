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

/** Результати генерації → S3 + assets (processing) → asset.process. URL провайдерів тимчасові, тож зберігаємо одразу. */
export async function storeGeneratedFiles(deps: AppDeps, g: GenerationRow, files: GeneratedFile[]): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) {
    const kind = kindForMime(file.mime);
    if (!kind) throw new Error(`Провайдер повернув непідтримуваний тип файлу: ${file.mime}`);
    const id = crypto.randomUUID();
    const storageKey = assetKeys.original(g.userId, id, EXT[file.mime] ?? 'bin');
    await deps.storage.put(storageKey, file.bytes, { contentType: file.mime });
    await deps.db.insert(assets).values({
      id,
      userId: g.userId,
      kind,
      source: 'generated',
      status: 'processing',
      storageKey,
      mime: file.mime,
      sizeBytes: file.bytes.length,
      title: titleFromPrompt(g.prompt ?? ''),
      prompt: g.prompt,
      generationId: g.id,
    });
    ids.push(id);
  }
  await deps.db.update(generations).set({ assetIds: ids }).where(eq(generations.id, g.id));
  for (const id of ids) await deps.jobs.queue.enqueue('asset.process', { assetId: id }, { userId: g.userId });
  return ids;
}

export const setGenerationStatus = (deps: AppDeps, id: string, patch: Partial<typeof generations.$inferInsert>) =>
  deps.db.update(generations).set(patch).where(eq(generations.id, id));
