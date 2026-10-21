import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { estimateCost, type CatalogItem } from '@vf/ai';
import { generations, userSettings } from '@vf/db';
import { AppError, parseModelRef, type Capability, type ModelRef } from '@vf/shared';
import type { AppDeps } from '../../app';

/**
 * Скасування користувачем або зупинка сервера. Провайдер може повернути «сирий» AbortError
 * або PROVIDER_ERROR — вирішує стан сигналу задачі.
 */
export const isCancelled = (e: unknown, signal: AbortSignal): boolean =>
  signal.aborted || (e as Error | undefined)?.name === 'AbortError';

/** Доступна модель можливості: перша доступна з `preferred`, інакше перша доступна в каталозі; null — немає. */
export async function pickModel(
  deps: AppDeps,
  userId: string,
  capability: Capability,
  preferred: (ModelRef | undefined | null)[] = [],
): Promise<CatalogItem | null> {
  const catalog = (await deps.ai.catalog(userId)).filter((e) => e.capability === capability && e.available);
  for (const ref of preferred) {
    const hit = ref && catalog.find((e) => e.ref === ref);
    if (hit) return hit;
  }
  return catalog[0] ?? null;
}

/** Моделі за замовчуванням користувача (`user_settings.defaults`). */
export async function userDefaults(deps: AppDeps, userId: string) {
  const [s] = await deps.db
    .select({ defaults: userSettings.defaults })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return s?.defaults ?? {};
}

export async function textModel(deps: AppDeps, userId: string): Promise<CatalogItem> {
  const m = await pickModel(deps, userId, 'text', [(await userDefaults(deps, userId)).text]);
  if (!m) throw new AppError('MODEL_UNAVAILABLE', 'Немає доступної текстової моделі для перекладу — додайте ключ');
  return m;
}

/** Запис у `generations` (для історії й оцінки вартості); повертає id. */
export async function startGeneration(
  deps: AppDeps,
  g: { userId: string; capability: Capability; ref: ModelRef; prompt: string; params: object; jobId: string },
): Promise<string> {
  const { provider, model } = parseModelRef(g.ref);
  const [row] = await deps.db
    .insert(generations)
    .values({
      userId: g.userId,
      capability: g.capability,
      provider,
      model,
      prompt: g.prompt,
      params: g.params,
      status: 'running',
      jobId: g.jobId,
    })
    .returning({ id: generations.id });
  return row!.id;
}

export async function finishGeneration(
  deps: AppDeps,
  id: string,
  outcome:
    | { status: 'done'; entry: CatalogItem | undefined; usage: Parameters<typeof estimateCost>[1]; assetIds?: string[] }
    | { status: 'failed'; error: string }
    | { status: 'cancelled' },
): Promise<void> {
  const patch: Partial<typeof generations.$inferInsert> = { status: outcome.status };
  if (outcome.status === 'done') {
    const cost = outcome.entry ? estimateCost(outcome.entry, outcome.usage) : null;
    patch.costEstimate = cost === null ? null : cost.toFixed(6);
    if (outcome.assetIds) patch.assetIds = outcome.assetIds;
  } else if (outcome.status === 'failed') patch.error = outcome.error;
  await deps.db.update(generations).set(patch).where(eq(generations.id, id));
}

/** Об'єкт сховища → локальний файл. */
export async function download(deps: AppDeps, key: string, path: string): Promise<void> {
  const obj = await deps.storage.get(key);
  await pipeline(obj.body, createWriteStream(path));
}
