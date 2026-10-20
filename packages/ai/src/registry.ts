import { AppError, type Capability, type ModelRef, type ProviderId } from '@vf/shared';
import { CATALOG, type CatalogEntry } from './catalog';
import type { CredentialStore } from './credentials';
import { fakeImage, fakeStt, fakeText, fakeTts } from './fake';
import { anthropicText } from './providers/anthropic';
import { googleText } from './providers/google';
import { openaiText } from './providers/openai';
import type { ImageGen, STT, TextGen, TTS } from './types';

export interface CatalogItem extends CatalogEntry {
  available: boolean;
}

export interface AiRegistry {
  catalog(userId: string): Promise<CatalogItem[]>;
  text(userId: string, ref: ModelRef): Promise<TextGen>;
  image(userId: string, ref: ModelRef): Promise<ImageGen>;
  tts(userId: string, ref: ModelRef): Promise<TTS>;
  stt(userId: string, ref: ModelRef): Promise<STT>;
}

const TEXT_FACTORIES: Partial<Record<ProviderId, (key: string, model: string) => TextGen>> = {
  anthropic: anthropicText,
  openai: openaiText,
  google: googleText,
  fake: () => fakeText,
};

export function createAiRegistry(deps: {
  credentials: CredentialStore;
  catalog?: readonly CatalogEntry[];
}): AiRegistry {
  const catalog = deps.catalog ?? CATALOG;

  async function resolve(userId: string, ref: ModelRef, capability: Capability) {
    const entry = catalog.find((e) => e.ref === ref && e.capability === capability);
    if (!entry) throw new AppError('MODEL_NOT_FOUND', `Модель ${ref} не знайдено для «${capability}»`, { ref, capability });
    const key = await deps.credentials.get(userId, entry.provider);
    if (!key) throw new AppError('MODEL_UNAVAILABLE', `Немає ключа для провайдера ${entry.provider}`, { ref });
    return { entry, key, model: ref.slice(entry.provider.length + 1) };
  }

  const fakeOnly = async <T>(userId: string, ref: ModelRef, capability: Capability, impl: T): Promise<T> => {
    const { entry } = await resolve(userId, ref, capability);
    if (entry.provider !== 'fake') {
      throw new AppError('MODEL_UNAVAILABLE', `Адаптер ${entry.provider} для «${capability}» ще не підключено`, { ref });
    }
    return impl;
  };

  return {
    async catalog(userId) {
      const keys = new Map<ProviderId, boolean>();
      for (const p of new Set(catalog.map((e) => e.provider))) keys.set(p, !!(await deps.credentials.get(userId, p)));
      return catalog
        .filter((e) => e.provider !== 'fake' || keys.get('fake'))
        .map((e) => ({ ...e, available: keys.get(e.provider) ?? false }));
    },
    async text(userId, ref) {
      const { entry, key, model } = await resolve(userId, ref, 'text');
      return TEXT_FACTORIES[entry.provider]!(key, model);
    },
    image: (userId, ref) => fakeOnly(userId, ref, 'image', fakeImage),
    tts: (userId, ref) => fakeOnly(userId, ref, 'tts', fakeTts),
    stt: (userId, ref) => fakeOnly(userId, ref, 'stt', fakeStt),
  };
}
