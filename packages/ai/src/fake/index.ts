import { createHash } from 'node:crypto';
import type { Aspect, ImageGen, STT, TextGen, TTS, Word } from '../types';
import { titleFromPrompt } from '@vf/shared';
import { taggerSchema } from '../prompts/tagger';
import { translateSchema } from '../prompts/translate';
import { fakeValueFor } from './fake-object';
import { solidPng } from './png';
import { silentWav } from './wav';

const SIZES: Record<Aspect, [number, number]> = { '9:16': [540, 960], '16:9': [960, 540], '1:1': [768, 768] };
const WORD_MS = 400;
const STT_PHRASES = [
  { start: 0, end: 1.2, text: 'це перша тестова фраза' },
  { start: 2, end: 3.5, text: 'а це друга фраза' },
  { start: 4, end: 5.5, text: 'і наприкінці третя' },
];

export const fakeText: TextGen = {
  async generateText({ prompt }) {
    return `[fake] ${prompt}`;
  },
  async generateObject(schema, { prompt, onUsage }) {
    onUsage?.({ inputTokens: 0, outputTokens: 0 });
    if ((schema as unknown) === taggerSchema) return fakeTags(prompt) as never;
    if ((schema as unknown) === translateSchema) return fakeTranslate(prompt) as never;
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
    const words: Word[] = STT_PHRASES.flatMap((p) => {
      const parts = p.text.split(' ');
      const step = ((p.end - p.start) * 1000) / parts.length;
      return parts.map((w, i) => ({
        text: w,
        startMs: Math.round(p.start * 1000 + i * step),
        endMs: Math.round(p.start * 1000 + (i + 1) * step),
      }));
    });
    return { text: STT_PHRASES.map((p) => p.text).join(' '), language: 'uk', segments: STT_PHRASES, words };
  },
};

/** Переклад-заглушка: `[to] text` для кожної фрази з промпту buildTranslatePrompt. */
function fakeTranslate(prompt: string) {
  const to = /^Цільова мова: (\S+)/m.exec(prompt)?.[1] ?? 'xx';
  const items = prompt
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { id: string; text: string })
    .map((i) => ({ id: i.id, text: `[${to}] ${i.text}` }));
  return { items };
}

const FALLBACK_TAGS = ['fake', 'image', 'test', 'media', 'tag'];

/** Детерміновані теги: перші 5–10 унікальних слів опису (≥ 3 літер), інакше — заглушка. */
function fakeTags(prompt: string) {
  const description = prompt.split('\n').slice(1, -1).join(' ') || '';
  const words = [...new Set(description.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 10);
  const tags = [...new Set([...words, ...FALLBACK_TAGS])].slice(0, Math.max(5, words.length));
  return { title: titleFromPrompt(description || 'Fake-зображення'), tags };
}
