import { z } from 'zod';
import { PLATFORMS, type Platform } from '@vf/shared';

export const PUBLISH_META_PROMPT_VERSION = 1;

/** Скільки символів озвучки передавати моделі (сумарно) */
const NARRATION_MAX_CHARS = 6000;

const variantSchema = z.object({ title: z.string(), description: z.string(), tags: z.array(z.string()) });

/** Метадані для кожної платформи; fake-провайдер розпізнає схему за посиланням — див. fake/index.ts */
export const publishMetaSchema = z.object({
  youtube: variantSchema,
  tiktok: variantSchema,
  instagram: variantSchema,
  facebook: variantSchema,
});
export type PublishMetaResult = z.infer<typeof publishMetaSchema>;

/** Ліміти платформи (структурно сумісні з PlatformLimits з @vf/publish — пакет від нього не залежить) */
export interface PublishMetaLimits {
  title: number;
  titleRequired: boolean;
  description: number;
  descriptionBytes?: boolean;
  tagsTotal?: number;
  hashtags?: number;
}

function limitLine(platform: Platform, l: PublishMetaLimits): string {
  const parts = [
    l.title > 0 ? `назва до ${l.title} символів` : 'без назви (title — порожній рядок)',
    `опис до ${l.description} ${l.descriptionBytes ? 'байтів UTF-8' : 'символів'}`,
  ];
  if (l.tagsTotal !== undefined) parts.push(`теги разом до ${l.tagsTotal} символів`);
  if (l.hashtags !== undefined) parts.push(`до ${l.hashtags} хештегів`);
  return `- ${platform}: ${parts.join(', ')}`;
}

export function buildPublishMetaPrompt(req: {
  title: string;
  topic?: string | null;
  language: string;
  format: string;
  narration: string[];
  channelStyle?: string;
  limits: Record<Platform, PublishMetaLimits>;
}): { system: string; prompt: string } {
  const vertical = req.format === '9:16';
  const system = [
    'Ти SMM-редактор: готуєш метадані для публікації одного відео на чотирьох платформах.',
    `Пиши мовою «${req.language}».`,
    vertical
      ? 'Відео вертикальне (9:16): подавай його як Shorts/Reels.'
      : 'Відео горизонтальне (16:9): подавай його як довге відео.',
    'Правила: YouTube — SEO-назва, опис, у якому перші 2 рядки є хуком, і 8–15 тегів.',
    'TikTok та Instagram — без назви (title порожній), короткий підпис у description і 3–5 хештегів у tags.',
    'Facebook — назва та опис.',
    'Теги й хештеги пиши без символу «#». Не вигадуй фактів, яких немає в тексті відео.',
    `Жорсткі ліміти:\n${PLATFORMS.map((p) => limitLine(p, req.limits[p])).join('\n')}`,
  ].join('\n');

  let narration = req.narration.join('\n');
  if (narration.length > NARRATION_MAX_CHARS) narration = narration.slice(0, NARRATION_MAX_CHARS);
  const lines = [`Назва проєкту: ${req.title}`];
  if (req.topic?.trim()) lines.push(`Тема: ${req.topic.trim()}`);
  lines.push(`Мова відповіді: ${req.language}`, `Формат: ${req.format}`);
  if (req.channelStyle?.trim()) lines.push(`Стиль каналу: ${req.channelStyle.trim()}`);
  lines.push(narration ? `Текст озвучки:\n${narration}` : 'Тексту озвучки немає — спирайся на назву й тему.');
  return { system, prompt: lines.join('\n') };
}
