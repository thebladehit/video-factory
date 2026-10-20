import type { Capability, ModelRef, ProviderId } from '@vf/shared';
import type { Aspect } from './types';

export interface CatalogEntry {
  ref: ModelRef;
  provider: ProviderId;
  capability: Capability;
  label: string;
  pricing?: { unit: '1M_tokens_in' | '1M_tokens_out' | 'image' | 'second' | '1K_chars'; usd: number }[];
  rateLimitPerMin?: number;
  wordTimestamps?: boolean;
  /** image/video: підтримувані формати кадру */
  aspects?: Aspect[];
  /** image: моделі, що приймають розмір, а не співвідношення сторін */
  sizes?: Partial<Record<Aspect, `${number}x${number}`>>;
  /** video: дозволені тривалості, с (немає — тривалість обирає модель у межах durationRange) */
  durations?: number[];
  durationRange?: [number, number];
  /** image: максимум зображень за запит */
  maxN?: number;
  /** text: дешева модель — запасний варіант для тегів */
  cheap?: true;
  /** text: приймає зображення (vision-теги) */
  vision?: true;
}

const entry = (
  ref: ModelRef,
  capability: Capability,
  label: string,
  extra: Partial<CatalogEntry> = {},
): CatalogEntry => ({
  ref,
  provider: ref.split('/')[0] as ProviderId,
  capability,
  label,
  ...extra,
});

const tokens = (inUsd: number, outUsd: number): CatalogEntry['pricing'] => [
  { unit: '1M_tokens_in', usd: inUsd },
  { unit: '1M_tokens_out', usd: outUsd },
];
const perImage = (usd: number): CatalogEntry['pricing'] => [{ unit: 'image', usd }];
const perSecond = (usd: number): CatalogEntry['pricing'] => [{ unit: 'second', usd }];
const ALL_ASPECTS: Aspect[] = ['9:16', '16:9', '1:1'];
const OPENAI_SIZES = { '9:16': '1024x1536', '16:9': '1536x1024', '1:1': '1024x1024' } as const;

/**
 * Каталог моделей — конфіг: нова модель = новий рядок.
 * Id і ціни звірено з документацією провайдерів 2026-10-20 (Anthropic, developers.openai.com/api/docs/pricing,
 * ai.google.dev/gemini-api/docs/pricing). Ціни — оцінка, не рахунок:
 * - gpt-image — токенні ціни, переведені в ціну зображення середньої якості (≈1–1.6 тис. вихідних токенів);
 * - OpenAI Sora (Videos API) вимкнено 2026-09-24, Veo 3.1 preview у Gemini API — 2026-10-22, тому відео — Gemini Omni Flash.
 */
export const CATALOG: readonly CatalogEntry[] = [
  entry('anthropic/claude-opus-5-5', 'text', 'Claude Opus 5.5', { pricing: tokens(4, 20), vision: true }),
  entry('anthropic/claude-sonnet-5-5', 'text', 'Claude Sonnet 5.5', { pricing: tokens(2, 10), vision: true }),
  entry('anthropic/claude-haiku-5-5', 'text', 'Claude Haiku 5.5', {
    pricing: tokens(0.1, 0.5),
    vision: true,
    cheap: true,
  }),
  entry('openai/gpt-5.6-sol', 'text', 'GPT-5.6 Sol', { pricing: tokens(4, 20), vision: true }),
  entry('openai/gpt-5.6-luna', 'text', 'GPT-5.6 Luna', { pricing: tokens(0.2, 1.2), vision: true, cheap: true }),
  entry('google/gemini-3.1-pro-preview', 'text', 'Gemini 3.1 Pro', { pricing: tokens(2, 12), vision: true }),
  entry('google/gemini-3.8-flash', 'text', 'Gemini 3.8 Flash', {
    pricing: tokens(0.75, 3.75),
    vision: true,
    cheap: true,
  }),

  entry('openai/gpt-image-2', 'image', 'GPT Image 2', {
    pricing: perImage(0.04),
    aspects: ALL_ASPECTS,
    sizes: OPENAI_SIZES,
    maxN: 4,
  }),
  entry('openai/gpt-image-1-mini', 'image', 'GPT Image 1 mini', {
    pricing: perImage(0.011),
    aspects: ALL_ASPECTS,
    sizes: OPENAI_SIZES,
    maxN: 4,
  }),
  entry('google/gemini-3.1-flash-image', 'image', 'Gemini 3.1 Flash Image', {
    pricing: perImage(0.067),
    aspects: ALL_ASPECTS,
    maxN: 4,
  }),
  entry('google/gemini-nano-banana-2.1', 'image', 'Nano Banana 2.1', {
    pricing: perImage(0.0336),
    aspects: ALL_ASPECTS,
    maxN: 4,
  }),

  entry('google/gemini-omni-1.1-flash', 'video', 'Gemini Omni Flash', {
    pricing: perSecond(0.1),
    aspects: ['9:16', '16:9'],
    durationRange: [3, 10],
  }),

  entry('fake/text', 'text', 'Fake · текст', { pricing: tokens(0, 0), vision: true, cheap: true }),
  entry('fake/image', 'image', 'Fake · зображення', { pricing: perImage(0), aspects: ALL_ASPECTS, maxN: 4 }),
  entry('fake/video', 'video', 'Fake · відео', { pricing: perSecond(0), aspects: ALL_ASPECTS, durations: [2] }),
  entry('fake/tts', 'tts', 'Fake · озвучка', { wordTimestamps: true }),
  entry('fake/stt', 'stt', 'Fake · розпізнавання', { wordTimestamps: true }),
];
