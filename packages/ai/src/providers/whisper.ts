import type { STT } from '../types';
import { requestWithRetry } from './http';

interface Verbose {
  text?: string;
  language?: string;
  segments?: { start: number; end: number; text: string }[];
  words?: { word: string; start: number; end: number }[];
}

const EXT: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'm4a',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

/** OpenAI whisper-1: multipart `verbose_json` зі словами й сегментами. Файл ≤ 25 МБ. */
export function createWhisperStt(opts: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}): STT {
  const doFetch = opts.fetch ?? fetch;
  return {
    async transcribe({ audio, mime, language, prompt, signal }) {
      const form = new FormData();
      form.append('file', new File([audio as unknown as Blob], `audio.${EXT[mime] ?? 'wav'}`, { type: mime }));
      form.append('model', opts.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
      if (language) form.append('language', language);
      if (prompt) form.append('prompt', prompt);
      const res = await requestWithRetry(
        'openai',
        doFetch,
        'https://api.openai.com/v1/audio/transcriptions',
        { method: 'POST', headers: { authorization: `Bearer ${opts.apiKey}` }, body: form },
        { signal, retryDelayMs: opts.retryDelayMs },
      );
      const v = (await res.json()) as Verbose;
      return {
        text: (v.text ?? '').trim(),
        language: v.language,
        segments: (v.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })),
        words: v.words?.map((w) => ({
          text: w.word.trim(),
          startMs: Math.round(w.start * 1000),
          endMs: Math.round(w.end * 1000),
        })),
      };
    },
  };
}
