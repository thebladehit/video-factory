import { createHash } from 'node:crypto';
import type { Aspect, ImageGen, STT, TextGen, TTS, Word } from '../types';
import { AppError, titleFromPrompt } from '@vf/shared';
import { taggerSchema } from '../prompts/tagger';
import { translateSchema } from '../prompts/translate';
import { outlineSchema, sceneSchema, scriptSchema } from '../prompts/script';
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
    if ((schema as unknown) === scriptSchema) return fakeScript(prompt) as never;
    if ((schema as unknown) === outlineSchema) return fakeOutline(prompt) as never;
    if ((schema as unknown) === sceneSchema) return fakeScene(prompt) as never;
    return fakeValueFor(schema);
  },
};

export const fakeImage: ImageGen = {
  async generate({ prompt, aspect, n }) {
    // маркер для тестів помилки сцени конвеєра
    if (prompt.includes('FAIL')) throw new AppError('PROVIDER_ERROR', 'Fake: відмова', { provider: 'fake' });
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

/** Пауза між абзацами (порожній рядок) у fake-озвучці — як природна пауза справжнього TTS. */
const PARAGRAPH_PAUSE_MS = 600;

/**
 * Fake-TTS: тиша по 0,4 с на слово, між абзацами — пауза 0,6 с.
 * `words: false` — без міток слів (як провайдер, що їх не дає: тоді мітки беруться з whisper чи оцінюються).
 */
export function createFakeTts(o: { words?: boolean } = {}): TTS {
  return {
    async synthesize({ text }) {
      const words: Word[] = [];
      let t = 0;
      for (const para of text.split(/\n\s*\n/)) {
        const parts = para.split(/\s+/).filter(Boolean);
        if (!parts.length) continue;
        if (words.length) t += PARAGRAPH_PAUSE_MS;
        for (const w of parts) {
          words.push({ text: w, startMs: t, endMs: t + WORD_MS });
          t += WORD_MS;
        }
      }
      const durationMs = words.at(-1)?.endMs ?? 0;
      const audio = { bytes: silentWav(durationMs), mime: 'audio/wav', durationMs };
      return o.words === false ? { audio } : { audio, words };
    },
  };
}

export const fakeTts: TTS = createFakeTts();

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

const promptLine = (prompt: string, label: string) => new RegExp(`^${label}: (.*)$`, 'm').exec(prompt)?.[1]?.trim();

/** Сценарій-заглушка: N сцен із маркера «Кількість сцен: N» за темою з «Тема: …». */
function fakeScript(prompt: string) {
  const topic = promptLine(prompt, 'Тема') ?? 'тема';
  const n = Math.max(1, Number(promptLine(prompt, 'Кількість сцен')) || 1);
  const words = topic.split(/\s+/).filter(Boolean);
  const head = words.slice(0, 6).join(' ');
  const keywords = [...new Set(words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean))].slice(
    0,
    8,
  );
  return {
    title: titleFromPrompt(topic),
    scenes: Array.from({ length: n }, (_, i) => ({
      narration: `Сцена ${i + 1}. ${head}`,
      visualPrompt: `scene ${i + 1} ${topic}`,
      keywords: keywords.length ? keywords : ['fake'],
    })),
  };
}

/** План-заглушка: розділи по ~150 с, сума sec = «Тривалість: N с». */
function fakeOutline(prompt: string) {
  const topic = promptLine(prompt, 'Тема') ?? 'тема';
  const total = Math.max(1, Number(/^Тривалість: (\d+)/m.exec(prompt)?.[1]) || 60);
  const count = Math.max(1, Math.round(total / 150));
  const base = Math.floor(total / count);
  return {
    title: titleFromPrompt(topic),
    sections: Array.from({ length: count }, (_, i) => ({
      title: `Розділ ${i + 1}`,
      summary: `Про ${topic}, частина ${i + 1}`,
      sec: i === count - 1 ? total - base * (count - 1) : base,
    })),
  };
}

function fakeScene(prompt: string) {
  const current = promptLine(prompt, 'Поточна сцена') ?? 'сцена';
  return {
    narration: `Нова версія. ${current}`.slice(0, 1500),
    visualPrompt: `new version ${current}`.slice(0, 200),
    keywords: ['fake'],
  };
}
