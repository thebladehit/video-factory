import { AppError } from '@vf/shared';
import { TTS_MAX_CHARS, type TTS } from '../types';
import { assertTtsLength, requestWithRetry } from './http';
import { wavDurationMs } from './wav';

/** OpenAI gpt-4o-mini-tts: POST /v1/audio/speech → WAV (без міток слів). */
export function createOpenAiTts(opts: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}): TTS {
  const doFetch = opts.fetch ?? fetch;
  return {
    async synthesize({ text, voiceId, instructions, signal }) {
      assertTtsLength(text, TTS_MAX_CHARS);
      const res = await requestWithRetry(
        'openai',
        doFetch,
        'https://api.openai.com/v1/audio/speech',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: opts.model,
            voice: voiceId,
            input: text,
            ...(instructions ? { instructions } : {}),
            response_format: 'wav',
          }),
        },
        { signal, retryDelayMs: opts.retryDelayMs },
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      const durationMs = wavDurationMs(bytes);
      if (durationMs === null)
        throw new AppError('PROVIDER_ERROR', 'openai: відповідь не є WAV', { provider: 'openai' });
      return { audio: { bytes, mime: 'audio/wav', durationMs } };
    },
  };
}
