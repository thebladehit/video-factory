import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Aspect, CatalogItem } from '@vf/ai';
import { estimateCost } from '@vf/ai';
import { generations, jobs } from '@vf/db';
import { AppError, parseModelRef, type JobStatus, type ModelRef } from '@vf/shared';
import type { AppDeps } from '../../app';

export interface GenerationView {
  id: string;
  capability: 'image' | 'video';
  model: ModelRef;
  prompt: string;
  status: JobStatus;
  error: string | null;
  jobId: string | null;
  progress: number;
  createdAt: string;
}

const MAX_PROMPT = 4000;

async function modelEntry(
  deps: AppDeps,
  userId: string,
  capability: 'image' | 'video',
  model: ModelRef,
): Promise<CatalogItem> {
  const entry = (await deps.ai.catalog(userId)).find((e) => e.ref === model && e.capability === capability);
  if (!entry) throw new AppError('MODEL_NOT_FOUND', `Модель ${model} не підходить для «${capability}»`, { model });
  if (!entry.available)
    throw new AppError('MODEL_UNAVAILABLE', `Немає ключа для провайдера ${entry.provider}`, { model });
  return entry;
}

function checkCommon(entry: CatalogItem, prompt: string, aspect: Aspect) {
  if (!prompt.trim() || prompt.length > MAX_PROMPT) {
    throw new AppError('VALIDATION', `Опис має бути від 1 до ${MAX_PROMPT} символів`);
  }
  if (entry.aspects && !entry.aspects.includes(aspect)) {
    throw new AppError('VALIDATION', `Модель ${entry.label} не підтримує формат ${aspect}`, { aspects: entry.aspects });
  }
}

/** Секунди для оцінки: задана тривалість або верхня межа діапазону моделі. */
const secondsFor = (entry: CatalogItem, durationSec?: number) =>
  durationSec ?? entry.durationRange?.[1] ?? entry.durations?.[0] ?? 0;

export async function generateImage(
  deps: AppDeps,
  userId: string,
  i: { model: ModelRef; prompt: string; aspect: Aspect; n: number },
): Promise<{ generationId: string; jobId: string }> {
  const entry = await modelEntry(deps, userId, 'image', i.model);
  checkCommon(entry, i.prompt, i.aspect);
  if (!Number.isInteger(i.n) || i.n < 1 || i.n > (entry.maxN ?? 1)) {
    throw new AppError('VALIDATION', `Кількість — від 1 до ${entry.maxN ?? 1}`);
  }
  const { provider, model } = parseModelRef(i.model);
  const [g] = await deps.db
    .insert(generations)
    .values({
      userId,
      capability: 'image',
      provider,
      model,
      prompt: i.prompt.trim(),
      params: { aspect: i.aspect, n: i.n },
    })
    .returning();
  const jobId = await deps.jobs.queue.enqueue('image.generate', { generationId: g!.id }, { userId });
  await deps.db.update(generations).set({ jobId }).where(eq(generations.id, g!.id));
  return { generationId: g!.id, jobId };
}

export async function generateVideo(
  deps: AppDeps,
  userId: string,
  i: { model: ModelRef; prompt: string; aspect: Aspect; durationSec?: number },
): Promise<{ generationId: string; jobId: string }> {
  const entry = await modelEntry(deps, userId, 'video', i.model);
  checkCommon(entry, i.prompt, i.aspect);
  if (entry.durations && (i.durationSec === undefined || !entry.durations.includes(i.durationSec))) {
    throw new AppError('VALIDATION', `Тривалість для ${entry.label}: ${entry.durations.join(', ')} с`);
  }
  const { provider, model } = parseModelRef(i.model);
  const [g] = await deps.db
    .insert(generations)
    .values({
      userId,
      capability: 'video',
      provider,
      model,
      prompt: i.prompt.trim(),
      params: { aspect: i.aspect, durationSec: i.durationSec ?? null },
    })
    .returning();
  const jobId = await deps.jobs.queue.enqueue('video.generate', { generationId: g!.id }, { userId });
  await deps.db.update(generations).set({ jobId }).where(eq(generations.id, g!.id));
  return { generationId: g!.id, jobId };
}

export async function estimate(
  deps: AppDeps,
  userId: string,
  i: { capability: 'image' | 'video'; model: ModelRef; n?: number; durationSec?: number },
): Promise<{ usd: number | null }> {
  const entry = (await deps.ai.catalog(userId)).find((e) => e.ref === i.model && e.capability === i.capability);
  if (!entry) throw new AppError('MODEL_NOT_FOUND', `Модель ${i.model} не знайдено`);
  const usd =
    i.capability === 'image'
      ? estimateCost(entry, { images: i.n ?? 1 })
      : estimateCost(entry, { seconds: secondsFor(entry, i.durationSec) });
  return { usd };
}

/** Блок «В роботі»: активні й невдалі генерації за 7 днів. Незавершена генерація бере стан своєї задачі. */
export async function listGenerations(deps: AppDeps, userId: string): Promise<GenerationView[]> {
  const rows = await deps.db
    .select({ g: generations, progress: jobs.progress, jobStatus: jobs.status, jobError: jobs.error })
    .from(generations)
    .leftJoin(jobs, eq(jobs.id, generations.jobId))
    .where(
      and(
        eq(generations.userId, userId),
        inArray(generations.capability, ['image', 'video']),
        inArray(generations.status, ['queued', 'running', 'failed']),
        gt(generations.createdAt, new Date(Date.now() - 7 * 86_400_000)),
      ),
    )
    .orderBy(desc(generations.createdAt))
    .limit(50);
  return rows
    .map(({ g, progress, jobStatus, jobError }) => {
      // задачу скасували або перервали до того, як обробник оновив генерацію
      const fromJob = g.status !== 'failed' && (jobStatus === 'cancelled' || jobStatus === 'failed');
      return {
        id: g.id,
        capability: g.capability as 'image' | 'video',
        model: `${g.provider}/${g.model}` as ModelRef,
        prompt: g.prompt ?? '',
        status: fromJob ? jobStatus! : g.status,
        error: fromJob ? jobError : g.error,
        jobId: g.jobId,
        progress: progress ?? 0,
        createdAt: g.createdAt.toISOString(),
      };
    })
    .filter((g) => g.status !== 'cancelled');
}
