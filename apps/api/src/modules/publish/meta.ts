import { and, eq } from 'drizzle-orm';
import {
  buildPublishMetaPrompt,
  estimateCost,
  PUBLISH_META_PROMPT_VERSION,
  publishMetaSchema,
  type PublishMetaResult,
} from '@vf/ai';
import { generations, publishMetaDrafts, userSettings, voiceLines } from '@vf/db';
import { clampMeta, PLATFORM_LIMITS } from '@vf/publish';
import { AppError, normalizeDoc, parseModelRef, PLATFORMS, type Platform, type PublicationMeta } from '@vf/shared';
import type { AppDeps } from '../../app';
import { ownProject } from '../projects/service';

type Variants = Record<Platform, PublicationMeta>;

/** Обрізає відповідь моделі й додає YouTube-налаштування за замовчуванням */
function finalize(raw: PublishMetaResult): Variants {
  const out = {} as Variants;
  for (const p of PLATFORMS) out[p] = clampMeta(p, raw[p]);
  out.youtube = { ...out.youtube, privacy: 'public', madeForKids: false, categoryId: '22' };
  return out;
}

/**
 * AI-метадані для мовної версії: кеш `publish_meta_drafts`, інакше текстова модель за замовчуванням.
 * Помилка провайдера кидається як є (запис у generations позначено failed).
 */
export async function generateMeta(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; language: string; force?: boolean },
): Promise<{ variants: Variants; model: string; cached: boolean }> {
  const p = await ownProject(deps, userId, input.projectId);
  const key = and(eq(publishMetaDrafts.projectId, p.id), eq(publishMetaDrafts.language, input.language));
  if (!input.force) {
    const [cached] = await deps.db.select().from(publishMetaDrafts).where(key);
    if (cached) return { variants: cached.variants, model: cached.model, cached: true };
  }

  const [settings] = await deps.db.select().from(userSettings).where(eq(userSettings.userId, userId));
  const ref = settings?.defaults.text;
  if (!ref) throw new AppError('VALIDATION', 'Оберіть модель для тексту в налаштуваннях');

  // тексти озвучки цієї мови в порядку сегментів документа
  const order = new Map((normalizeDoc(p.timeline).segments ?? []).map((s, i) => [s.id, i]));
  const lines = await deps.db
    .select({ segmentId: voiceLines.segmentId, text: voiceLines.text })
    .from(voiceLines)
    .where(and(eq(voiceLines.projectId, p.id), eq(voiceLines.language, input.language)));
  const narration = lines
    .filter((l) => order.has(l.segmentId) && l.text.trim())
    .sort((a, b) => order.get(a.segmentId)! - order.get(b.segmentId)!)
    .map((l) => l.text.trim());

  const { system, prompt } = buildPublishMetaPrompt({
    title: p.title,
    topic: p.topic,
    language: input.language,
    format: p.format,
    narration,
    channelStyle: settings?.channelStyle,
    limits: PLATFORM_LIMITS,
  });

  const { provider, model } = parseModelRef(ref);
  const [gen] = await deps.db
    .insert(generations)
    .values({
      userId,
      capability: 'text',
      provider,
      model,
      prompt: `publish-meta v${PUBLISH_META_PROMPT_VERSION}`,
      params: { purpose: 'publish-meta', projectId: p.id, language: input.language },
      status: 'running',
    })
    .returning({ id: generations.id });
  try {
    let usage = { inputTokens: 0, outputTokens: 0 };
    const raw = await (
      await deps.ai.text(userId, ref)
    ).generateObject(publishMetaSchema, { system, prompt, onUsage: (u) => (usage = u) });
    const entry = (await deps.ai.catalog(userId)).find((e) => e.ref === ref);
    const cost = entry ? estimateCost(entry, usage) : null;
    await deps.db
      .update(generations)
      .set({ status: 'done', costEstimate: cost === null ? null : cost.toFixed(6) })
      .where(eq(generations.id, gen!.id));
    const variants = finalize(raw);
    await deps.db
      .insert(publishMetaDrafts)
      .values({ projectId: p.id, language: input.language, variants, model: ref, generationId: gen!.id })
      .onConflictDoUpdate({
        target: [publishMetaDrafts.projectId, publishMetaDrafts.language],
        set: { variants, model: ref, generationId: gen!.id, createdAt: new Date() },
      });
    return { variants, model: ref, cached: false };
  } catch (e) {
    await deps.db
      .update(generations)
      .set({ status: 'failed', error: (e as Error).message })
      .where(eq(generations.id, gen!.id));
    throw e;
  }
}
