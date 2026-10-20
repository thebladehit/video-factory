import { eq } from 'drizzle-orm';
import { estimateCost, taggerPrompt, taggerSchema, TAGGER_PROMPT_VERSION, type GeneratedFile } from '@vf/ai';
import { assets, generations, userSettings } from '@vf/db';
import { normalizeTags, parseModelRef, type ModelRef } from '@vf/shared';
import type { AppDeps } from '../../app';
import type { AssetRow } from './service';

/** Модель для тегів: налаштування «tagger» → текстова за замовчуванням → перша дешева vision-модель; null — немає. */
export async function resolveTagger(deps: AppDeps, userId: string): Promise<ModelRef | null> {
  const catalog = (await deps.ai.catalog(userId)).filter((e) => e.capability === 'text' && e.available);
  const [settings] = await deps.db.select().from(userSettings).where(eq(userSettings.userId, userId));
  for (const ref of [settings?.defaults.tagger, settings?.defaults.text]) {
    if (ref && catalog.some((e) => e.ref === ref && e.vision)) return ref;
  }
  return catalog.find((e) => e.cheap && e.vision)?.ref ?? null;
}

async function bytesOf(deps: AppDeps, key: string): Promise<Uint8Array> {
  const obj = await deps.storage.get(key);
  const chunks: Buffer[] = [];
  for await (const c of obj.body) chunks.push(c as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Теги через текстову модель (з промпту генерації або з мініатюри — vision).
 * Кожен виклик пишеться в generations з оцінкою вартості. Назву не змінює.
 * Кидає помилку провайдера (запис у generations уже позначено failed).
 */
async function runTagger(deps: AppDeps, asset: AssetRow, mode: 'prompt' | 'image', signal?: AbortSignal) {
  const ref = await resolveTagger(deps, asset.userId);
  if (!ref) return;
  const { provider, model } = parseModelRef(ref);
  const [gen] = await deps.db
    .insert(generations)
    .values({
      userId: asset.userId,
      capability: 'text',
      provider,
      model,
      prompt: `tagger v${TAGGER_PROMPT_VERSION}`,
      params: { assetId: asset.id, mode },
      status: 'running',
    })
    .returning();
  try {
    const images: GeneratedFile[] =
      mode === 'image' && asset.thumbKey ? [{ bytes: await bytesOf(deps, asset.thumbKey), mime: 'image/webp' }] : [];
    const { system, prompt } = taggerPrompt({ mode, prompt: asset.prompt ?? undefined });
    let usage = { inputTokens: 0, outputTokens: 0 };
    const result = await (
      await deps.ai.text(asset.userId, ref)
    ).generateObject(taggerSchema, {
      system,
      prompt,
      images,
      signal,
      onUsage: (u) => (usage = u),
    });
    // свіжі теги з БД: користувач міг додати свої, поки працювала модель
    const [current] = await deps.db.select({ tags: assets.tags }).from(assets).where(eq(assets.id, asset.id));
    if (current) {
      await deps.db
        .update(assets)
        .set({ tags: normalizeTags([...current.tags, ...result.tags]) })
        .where(eq(assets.id, asset.id));
    }
    const entry = (await deps.ai.catalog(asset.userId)).find((e) => e.ref === ref);
    const cost = entry ? estimateCost(entry, usage) : null;
    await deps.db
      .update(generations)
      .set({ status: 'done', costEstimate: cost === null ? null : cost.toFixed(6) })
      .where(eq(generations.id, gen!.id));
  } catch (e) {
    await deps.db
      .update(generations)
      .set({ status: 'failed', error: (e as Error).message })
      .where(eq(generations.id, gen!.id));
    throw e;
  }
}

/** Після asset.process: згенеровані — теги з промпту; завантажені — vision, якщо увімкнено. Помилки не валять asset. */
export async function tagAfterProcess(deps: AppDeps, asset: AssetRow): Promise<void> {
  try {
    if (asset.source === 'generated' && asset.prompt) return await runTagger(deps, asset, 'prompt');
    if (asset.source !== 'uploaded' || !asset.thumbKey) return;
    const [settings] = await deps.db.select().from(userSettings).where(eq(userSettings.userId, asset.userId));
    if (settings?.autoTagUploads) await runTagger(deps, asset, 'image');
  } catch {
    // помилку вже записано в generations; файл лишається ready
  }
}

/** Ручне «Згенерувати теги»: vision для фото/відео, для аудіо зі згенерованим промптом — з промпту. */
export async function tagWithVision(
  deps: AppDeps,
  asset: AssetRow,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  if (asset.thumbKey) return runTagger(deps, asset, 'image', opts.signal);
  if (asset.prompt) return runTagger(deps, asset, 'prompt', opts.signal);
}
