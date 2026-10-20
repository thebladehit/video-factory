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
    async generateObject(schema, { prompt, system, signal }) {
      try {
        const res = await generateText({
          model,
          prompt,
          system,
          abortSignal: signal,
          maxRetries: 2,
          output: Output.object({ schema }),
        });
        return res.output;
      } catch (e) {
        throw toProviderError(provider, e);
      }
    },
  };
}
