import { generateImage, type ImageModel } from 'ai';
import type { ProviderId } from '@vf/shared';
import type { CatalogEntry } from '../catalog';
import type { ImageGen } from '../types';
import { toProviderError } from './errors';

/** ImageGen через Vercel AI SDK: розмір з каталогу (OpenAI) або співвідношення сторін (Google). */
export function createAiSdkImageGen(provider: ProviderId, model: ImageModel, entry: CatalogEntry): ImageGen {
  return {
    async generate({ prompt, aspect, n, signal }) {
      const size = entry.sizes?.[aspect];
      try {
        const res = await generateImage({
          model,
          prompt,
          n,
          ...(size ? { size } : { aspectRatio: aspect }),
          maxRetries: 2,
          abortSignal: signal,
        });
        return res.images.map((img) => ({ bytes: img.uint8Array, mime: img.mediaType }));
      } catch (e) {
        throw toProviderError(provider, e);
      }
    },
  };
}
