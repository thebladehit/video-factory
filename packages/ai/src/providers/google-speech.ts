import { AppError } from '@vf/shared';
import { TTS_MAX_CHARS, type TTS } from '../types';
import { GEMINI_TTS_TEMPERATURE } from '../delivery';
import { assertTtsLength, requestWithRetry } from './http';
import { pcmToWav, wavDurationMs } from './wav';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface Part {
  inlineData?: { mimeType?: string; data?: string };
}

/**
 * Gemini 3.8 Flash TTS: `generateContent` з `responseModalities: ['AUDIO']`. Відповідь — PCM (L16, 24 кГц)
 * або готовий WAV; PCM загортаємо в WAV-заголовок. Стиль додається до тексту як вказівка («Say cheerfully: …»).
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
      const input = instructions ? `Say in this style (${instructions}): ${text}` : text;
      const res = await requestWithRetry(
        'google',
        doFetch,
        `${BASE}/models/${encodeURIComponent(opts.model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': opts.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: input }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              temperature: GEMINI_TTS_TEMPERATURE,
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } } },
            },
          }),
        },
        { signal, retryDelayMs: opts.retryDelayMs },
      );
      const json = (await res.json()) as { candidates?: { content?: { parts?: Part[] } }[] };
      const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
      if (!inline?.data)
        throw new AppError('PROVIDER_ERROR', 'google: провайдер не повернув аудіо', { provider: 'google' });
      const raw = new Uint8Array(Buffer.from(inline.data, 'base64'));
      const isWav = raw.length > 12 && Buffer.from(raw.subarray(0, 4)).toString('ascii') === 'RIFF';
      if (isWav) {
        const durationMs = wavDurationMs(raw);
        if (durationMs !== null) return { audio: { bytes: raw, mime: 'audio/wav', durationMs } };
      }
      const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1] ?? 24000);
      const bytes = pcmToWav(raw, rate);
      return { audio: { bytes, mime: 'audio/wav', durationMs: Math.round((raw.length / 2 / rate) * 1000) } };
    },
  };
}
