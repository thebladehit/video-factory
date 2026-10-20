import { generateText, Output, type LanguageModel } from 'ai';
import type { ProviderId } from '@vf/shared';
import { toProviderError } from './errors';
import type { TextGen } from '../types';

export function createAiSdkTextGen(provider: ProviderId, model: LanguageModel): TextGen {
  return {
    async generateText({ prompt, system, maxOutputTokens, signal }) {
      try {
        const res = await generateText({ model, prompt, system, maxOutputTokens, abortSignal: signal, maxRetries: 2 });
        return res.text;
      } catch (e) {
        throw toProviderError(provider, e);
      }
    },
    async generateObject(schema, { prompt, system, signal, images, onUsage }) {
      try {
        const input = images?.length
          ? {
              messages: [
                {
                  role: 'user' as const,
                  content: [
                    ...images.map((img) => ({ type: 'file' as const, data: img.bytes, mediaType: img.mime })),
                    { type: 'text' as const, text: prompt },
                  ],
                },
              ],
            }
          : { prompt };
        const res = await generateText({
          model,
          ...input,
          system,
          abortSignal: signal,
          maxRetries: 2,
          output: Output.object({ schema }),
        });
        onUsage?.({ inputTokens: res.usage.inputTokens ?? 0, outputTokens: res.usage.outputTokens ?? 0 });
        return res.output;
      } catch (e) {
        throw toProviderError(provider, e);
      }
    },
  };
}
