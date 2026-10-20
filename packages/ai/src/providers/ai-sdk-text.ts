import { APICallError, generateText, Output, type LanguageModel } from 'ai';
import { AppError, isAppError, type ProviderId } from '@vf/shared';
import type { TextGen } from '../types';

function toProviderError(provider: ProviderId, e: unknown): AppError {
  if (isAppError(e)) return e;
  // AI SDK обгортає ретраї в RetryError з lastError
  const last = (e as { lastError?: unknown })?.lastError ?? e;
  const status = APICallError.isInstance(last) ? last.statusCode : undefined;
  const message = last instanceof Error ? last.message : String(last);
  return new AppError('PROVIDER_ERROR', `${provider}: ${message}`, { provider, status });
}

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
