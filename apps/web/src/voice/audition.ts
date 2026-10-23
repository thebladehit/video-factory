import type { ModelRef } from '@vf/shared';

/** Оцінка тривалості озвучки (як `CHARS_PER_SEC` в API) */
export const CHARS_PER_SEC = 15;
/** Дублів на кандидата */
export const AUDITION_TAKES = 2;
/** Запитів одночасно */
export const AUDITION_CONCURRENCY = 3;
export const AUDITION_MAX_CHARS = 300;

export interface AuditionCandidate {
  model: ModelRef;
  voiceId: string;
}

export const AUDITION_CANDIDATES: AuditionCandidate[] = [
  ...['marin', 'cedar', 'ash', 'coral'].map((voiceId) => ({ model: 'openai/gpt-4o-mini-tts' as ModelRef, voiceId })),
  ...['Autonoe', 'Vindemiatrix', 'Kore', 'Charon'].map((voiceId) => ({
    model: 'google/gemini-3.8-flash-tts' as ModelRef,
    voiceId,
  })),
];

export interface TtsCatalogEntry {
  ref: string;
  capability: string;
  available: boolean;
  voices?: { id: string; name: string }[];
  pricing?: { unit: string; usd: number }[];
}

/**
 * Кандидати діалогу: `AUDITION_CANDIDATES` у моделях, доступних користувачу; якщо таких немає —
 * до 4 голосів першої доступної tts-моделі (наприклад `fake/tts`).
 */
export function pickCandidates(catalog: TtsCatalogEntry[]): AuditionCandidate[] {
  const tts = catalog.filter((m) => m.capability === 'tts' && m.available);
  const listed = AUDITION_CANDIDATES.filter((c) =>
    tts.some((m) => m.ref === c.model && (!m.voices || m.voices.some((v) => v.id === c.voiceId))),
  );
  if (listed.length) return listed;
  const first = tts.find((m) => m.voices?.length);
  return (first?.voices ?? []).slice(0, 4).map((v) => ({ model: first!.ref as ModelRef, voiceId: v.id }));
}

/** Вартість порівняння: символи / CHARS_PER_SEC → хвилини × ціна за хвилину × дублі × кандидати. */
export function estimateAudition(catalog: TtsCatalogEntry[], candidates: AuditionCandidate[], chars: number): number {
  const sec = chars / CHARS_PER_SEC;
  let usd = 0;
  for (const c of candidates) {
    const perMin = catalog.find((m) => m.ref === c.model)?.pricing?.find((p) => p.unit === 'minute')?.usd ?? 0;
    usd += ((sec * perMin) / 60) * AUDITION_TAKES;
  }
  return usd;
}

/**
 * Виконує задачі, не більше `limit` одночасно; кожна задача сама обробляє свою помилку.
 * `shouldContinue` false — нові задачі не беруться (розпочаті завершуються).
 */
export async function runQueue<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
  opts: { shouldContinue?: () => boolean } = {},
): Promise<void> {
  let next = 0;
  const go = opts.shouldContinue ?? (() => true);
  const worker = async () => {
    while (next < items.length && go()) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
