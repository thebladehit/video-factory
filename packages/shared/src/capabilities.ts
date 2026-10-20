import { AppError } from './errors';

export const CAPABILITIES = ['text', 'image', 'video', 'tts', 'stt'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const PROVIDER_IDS = ['anthropic', 'openai', 'google', 'fake'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** 'provider/model', напр. 'anthropic/claude-sonnet-5-5' */
export type ModelRef = `${ProviderId}/${string}`;

export function parseModelRef(ref: string): { provider: ProviderId; model: string } {
  const slash = ref.indexOf('/');
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  if (slash <= 0 || !model || !(PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw new AppError('VALIDATION', `Некоректне посилання на модель: "${ref}"`, { ref });
  }
  return { provider: provider as ProviderId, model };
}
