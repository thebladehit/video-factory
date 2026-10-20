import { createHash } from 'node:crypto';
import type { Aspect, ImageGen, STT, TextGen, TTS, Word } from '../types';
import { titleFromPrompt } from '@vf/shared';
import { taggerSchema } from '../prompts/tagger';
import { fakeValueFor } from './fake-object';
import { solidPng } from './png';
import { silentWav } from './wav';

const SIZES: Record<Aspect, [number, number]> = { '9:16': [540, 960], '16:9': [960, 540], '1:1': [768, 768] };
const WORD_MS = 300;

export const fakeText: TextGen = {
  async generateText({ prompt }) {
    return `[fake] ${prompt}`;
  },
  async generateObject(schema, { prompt, onUsage }) {
    onUsage?.({ inputTokens: 0, outputTokens: 0 });
    if ((schema as unknown) === taggerSchema) return fakeTags(prompt) as never;
    return fakeValueFor(schema);
  },
};

export const fakeImage: ImageGen = {
  async generate({ prompt, aspect, n }) {
    const [width, height] = SIZES[aspect];
    const h = createHash('sha1').update(prompt).digest();
    return Array.from({ length: n }, (_, i) => ({
      bytes: solidPng(width, height, [h[0]! ^ i, h[1]!, h[2]!]),
      mime: 'image/png',
      width,
      height,
    }));
  },
};

export const fakeTts: TTS = {
  async listVoices(language) {
    return [{ id: 'fake-voice', name: 'Fake', language: language ?? 'uk' }];
  },
  async synthesize({ text }) {
    const words: Word[] = text
      .split(/\s+/)
      .filter(Boolean)
      .map((w, i) => ({ text: w, startMs: i * WORD_MS, endMs: (i + 1) * WORD_MS }));
    const durationMs = words.at(-1)?.endMs ?? 0;
    return { audio: { bytes: silentWav(durationMs), mime: 'audio/wav', durationMs }, words };
  },
};

export const fakeStt: STT = {
  async transcribe() {
    const text = 'це тестова транскрипція';
    const words = text.split(' ').map((w, i) => ({ text: w, startMs: i * WORD_MS, endMs: (i + 1) * WORD_MS }));
    return { text, words };
  },
};

const FALLBACK_TAGS = ['fake', 'image', 'test', 'media', 'tag'];

/** Детерміновані теги: перші 5–10 унікальних слів опису (≥ 3 літер), інакше — заглушка. */
function fakeTags(prompt: string) {
  const description = prompt.split('\n').slice(1, -1).join(' ') || '';
  const words = [...new Set(description.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 10);
  const tags = [...new Set([...words, ...FALLBACK_TAGS])].slice(0, Math.max(5, words.length));
  return { title: titleFromPrompt(description || 'Fake-зображення'), tags };
}
