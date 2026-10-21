import { z } from 'zod';
import { languageInfo, type VideoFormat } from '@vf/shared';
import { TTS_MAX_CHARS } from '../types';

/** Версія промптів сценарію — зберігається разом із запуском */
export const SCRIPT_PROMPT_VERSION = 1;

const MAX_SCENES = 60;
/** Понад стільки сцен 16:9 пишеться двома етапами: план розділів, потім сцени розділів */
const TWO_STAGE_MIN_SCENES = 40;
const AVG_SCENE_SEC = { '9:16': 5, '16:9': 15 } as const;
const WORDS_PER_SEC = 2.5;

const sceneShape = {
  narration: z.string().min(1).max(TTS_MAX_CHARS),
  visualPrompt: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1).max(8),
};

/** Схеми розбирає fake-провайдер за ідентичністю — не обгортайте їх у нові об'єкти */
export const sceneSchema = z.object(sceneShape);
export const scriptSchema = z.object({ title: z.string().min(1), scenes: z.array(sceneSchema) });
export const outlineSchema = z.object({
  title: z.string().min(1),
  sections: z.array(z.object({ title: z.string().min(1), summary: z.string(), sec: z.number().positive() })),
});

export type ScriptResult = z.infer<typeof scriptSchema>;
export type OutlineResult = z.infer<typeof outlineSchema>;
export type SceneResult = z.infer<typeof sceneSchema>;

/** Кількість сцен ≈ targetSec / середня довжина (1..60), бюджет слів = targetSec × 2,5. */
export function scenePlan(
  format: VideoFormat,
  targetSec: number,
): { scenes: number; words: number; twoStage: boolean } {
  const scenes = Math.min(MAX_SCENES, Math.max(1, Math.round(targetSec / AVG_SCENE_SEC[format])));
  return {
    scenes,
    words: Math.round(targetSec * WORDS_PER_SEC),
    twoStage: format === '16:9' && scenes > TWO_STAGE_MIN_SCENES,
  };
}

interface Common {
  topic: string;
  language: string;
  channelStyle: string;
  style: string;
}

/** Маркери «Тема/Мова/Кількість сцен/…» читає fake/index.ts — змінюючи формат, оновіть і його */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function styleLines(i: Common): string[] {
  const out: string[] = [];
  if (i.channelStyle.trim()) out.push(`Стиль каналу: ${i.channelStyle.trim()}`);
  if (i.style.trim()) out.push(`Стиль цього відео: ${i.style.trim()}`);
  return out;
}

const langRule = (language: string) =>
  `Мова narration — ${languageInfo(language).name} (${language}); увесь текст дикторського читання пиши лише нею. Поле visualPrompt завжди пиши англійською: конкретний візуальний опис кадру без тексту й підписів у кадрі.`;

const SCENE_RULES = `Кожна сцена: narration (1–${TTS_MAX_CHARS} символів, чистий текст для озвучки без ремарок), visualPrompt (непорожній), keywords (1–8 коротких слів для пошуку відео чи фото).`;

export function buildScriptPrompt(i: {
  topic: string;
  format: VideoFormat;
  targetSec: number;
  language: string;
  channelStyle: string;
  style: string;
  section?: { title: string; summary: string; sec: number; previous: string[] };
  errors?: string[];
}): { system: string; prompt: string } {
  const sec = i.section?.sec ?? i.targetSec;
  const plan = scenePlan(i.format, sec);
  const shape =
    i.format === '9:16'
      ? 'Формат — вертикальне коротке відео. Перша сцена — хук у перші 1–2 секунди, що одразу чіпляє. Без вступу-привітання. Сцени по 3–8 с. Заклик наприкінці — лише якщо цього вимагає стиль.'
      : i.section
        ? 'Формат — горизонтальне відео; ти пишеш один розділ цілого відео. Сцени по 8–25 с. Не повторюй сказане в попередніх сценах і не підсумовуй відео, якщо це не останній розділ.'
        : 'Формат — горизонтальне відео: вступ, розділи, висновок. Сцени по 8–25 с.';
  const system = [
    'Ти сценарист відео. Пиши за темою готовий сценарій із послідовних сцен.',
    shape,
    `Бюджет слів — приблизно ${plan.words} у сумі по всіх сценах; кількість сцен — приблизно ${plan.scenes}.`,
    SCENE_RULES,
    langRule(i.language),
    ...styleLines(i),
  ].join('\n');

  const lines = [
    `Тема: ${oneLine(i.topic)}`,
    `Мова: ${i.language}`,
    `Кількість сцен: ${plan.scenes}`,
    `Бюджет слів: ${plan.words}`,
  ];
  if (i.section) {
    lines.push(`Розділ: ${i.section.title}`, `Зміст розділу: ${i.section.summary}`);
    if (i.section.previous.length)
      lines.push(
        'Останні сцени попереднього тексту (лише контекст, не повторюй):',
        ...i.section.previous.map((p) => `- ${p}`),
      );
  }
  if (i.errors?.length)
    lines.push('Попередня відповідь була невалідною. Виправ помилки:', ...i.errors.map((e) => `- ${e}`));
  return { system, prompt: lines.join('\n') };
}

export function buildOutlinePrompt(i: Common & { targetSec: number }): { system: string; prompt: string } {
  const system = [
    'Ти сценарист довгих відео. Склади план: назва відео та розділи (вступ, основні розділи, висновок).',
    'Для кожного розділу: title, summary (1–2 речення, що в ньому буде), sec — тривалість у секундах; сума sec дорівнює заданій тривалості.',
    langRule(i.language),
    ...styleLines(i),
  ].join('\n');
  const prompt = [`Тема: ${oneLine(i.topic)}`, `Мова: ${i.language}`, `Тривалість: ${i.targetSec} с`].join('\n');
  return { system, prompt };
}

export function buildScenePrompt(
  i: Common & { format: VideoFormat; previous?: string; next?: string; current: string },
): {
  system: string;
  prompt: string;
} {
  const system = [
    'Ти сценарист відео. Перепиши одну сцену інакше, зберігши зміст і приблизну довжину, щоб вона природно стикувалася із сусідніми.',
    i.format === '9:16' ? 'Формат вертикальний: сцени короткі, динамічні.' : 'Формат горизонтальний.',
    SCENE_RULES,
    langRule(i.language),
    ...styleLines(i),
  ].join('\n');
  const lines = [`Тема: ${oneLine(i.topic)}`, `Мова: ${i.language}`];
  if (i.previous) lines.push(`Попередня сцена: ${i.previous}`);
  if (i.next) lines.push(`Наступна сцена: ${i.next}`);
  lines.push(`Поточна сцена: ${i.current}`);
  return { system, prompt: lines.join('\n') };
}

/** `plan` лишено для сумісності підпису: кількість сцен лише наближена, тож жорстко за планом не перевіряється. */
/** Порожній масив — сценарій валідний; інакше перелік помилок для повторної спроби. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function validateScript(s: ScriptResult, _plan: { scenes: number }): string[] {
  const errors: string[] = [];
  if (s.scenes.length < 1 || s.scenes.length > MAX_SCENES)
    errors.push(`Кількість сцен ${s.scenes.length}: потрібно від 1 до ${MAX_SCENES}`);
  s.scenes.forEach((sc, idx) => {
    const n = idx + 1;
    const len = sc.narration.trim().length;
    if (len < 1 || len > TTS_MAX_CHARS)
      errors.push(`Сцена ${n}: narration має бути від 1 до ${TTS_MAX_CHARS} символів (зараз ${len})`);
    if (!sc.visualPrompt.trim()) errors.push(`Сцена ${n}: порожній visualPrompt`);
    if (sc.keywords.length < 1 || sc.keywords.length > 8)
      errors.push(`Сцена ${n}: keywords має містити від 1 до 8 слів (зараз ${sc.keywords.length})`);
  });
  return errors;
}
