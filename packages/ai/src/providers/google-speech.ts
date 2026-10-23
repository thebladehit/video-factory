import { AppError } from '@vf/shared';
import { TTS_MAX_CHARS, type TTS } from '../types';
import { GEMINI_TTS_TEMPERATURE } from '../delivery';
import { assertTtsLength, requestWithRetry } from './http';
import { pcmToWav, wavDurationMs } from './wav';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface ContentItem {
  type?: string;
  mime_type?: string;
  data?: string;
}

/**
 * Gemini 3.8 Flash TTS через Interactions API. Текст — дослівний транскрипт (модель читає все, що в ньому є),
 * тому стиль іде окремо: анотація `speech_metadata.style`. Відповідь — PCM (L16, 24 кГц) або готовий WAV
 * в `steps[].content[]`; PCM загортаємо в WAV-заголовок.
 */
export function createGeminiTts(opts: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}): TTS {
  const doFetch = opts.fetch ?? fetch;
  return {
    async synthesize({ text, voiceId, instructions, signal }) {
      assertTtsLength(text, TTS_MAX_CHARS);
      const style = instructions?.trim();
      const res = await requestWithRetry(
        'google',
        doFetch,
        `${BASE}/interactions`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': opts.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: opts.model,
            input: [
              {
                type: 'user_input',
                content: [
                  {
                    type: 'text',
                    text,
                    ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}),
                  },
                ],
              },
            ],
            response_format: { type: 'audio' },
            generation_config: { temperature: GEMINI_TTS_TEMPERATURE, speech_config: [{ voice: voiceId }] },
          }),
        },
        { signal, retryDelayMs: opts.retryDelayMs },
      );
      const json = (await res.json()) as { steps?: { type?: string; content?: ContentItem[] }[] };
      const audio = (json.steps ?? [])
        .filter((s) => s.type === 'model_output')
        .flatMap((s) => s.content ?? [])
        .filter((c) => c.type === 'audio' && c.data)
        .at(-1);
      if (!audio?.data)
        throw new AppError('PROVIDER_ERROR', 'google: провайдер не повернув аудіо', { provider: 'google' });
      const raw = new Uint8Array(Buffer.from(audio.data, 'base64'));
      const isWav = raw.length > 12 && Buffer.from(raw.subarray(0, 4)).toString('ascii') === 'RIFF';
      if (isWav) {
        const durationMs = wavDurationMs(raw);
        if (durationMs !== null) return { audio: { bytes: raw, mime: 'audio/wav', durationMs } };
      }
      const rate = Number(/rate=(\d+)/.exec(audio.mime_type ?? '')?.[1] ?? 24000);
      const bytes = pcmToWav(raw, rate);
      return { audio: { bytes, mime: 'audio/wav', durationMs: Math.round((raw.length / 2 / rate) * 1000) } };
    },
  };
}
