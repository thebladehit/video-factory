import type { Capability, ModelRef, ProviderId } from '@vf/shared';

export interface CatalogEntry {
  ref: ModelRef;
  provider: ProviderId;
  capability: Capability;
  label: string;
  pricing?: { unit: '1M_tokens_in' | '1M_tokens_out' | 'image' | 'second' | '1K_chars'; usd: number }[];
  rateLimitPerMin?: number;
  wordTimestamps?: boolean;
}

const entry = (ref: ModelRef, capability: Capability, label: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  ref,
  provider: ref.split('/')[0] as ProviderId,
  capability,
  label,
  ...extra,
});

/**
 * Каталог моделей — конфіг: нова модель = новий рядок.
 * Id OpenAI/Google взято з документації провайдерів станом на 2026-10-20; перевіряються `pnpm test:live`.
 */
export const CATALOG: readonly CatalogEntry[] = [
  entry('anthropic/claude-opus-5-5', 'text', 'Claude Opus 5.5'),
  entry('anthropic/claude-sonnet-5-5', 'text', 'Claude Sonnet 5.5'),
  entry('anthropic/claude-haiku-5-5', 'text', 'Claude Haiku 5.5'),
  entry('openai/gpt-5.6-sol', 'text', 'GPT-5.6 Sol'),
  entry('openai/gpt-5.6-luna', 'text', 'GPT-5.6 Luna'),
  entry('google/gemini-3.1-pro-preview', 'text', 'Gemini 3.1 Pro'),
  entry('google/gemini-3.8-flash', 'text', 'Gemini 3.8 Flash'),
  entry('fake/text', 'text', 'Fake · текст'),
  entry('fake/image', 'image', 'Fake · зображення'),
  entry('fake/tts', 'tts', 'Fake · озвучка', { wordTimestamps: true }),
  entry('fake/stt', 'stt', 'Fake · розпізнавання', { wordTimestamps: true }),
];
