import type { Platform, PublicationMeta } from '@vf/shared';

export interface PlatformLimits {
  title: number;
  titleRequired: boolean;
  description: number;
  /** Ліміт опису рахується в байтах UTF-8, а не в символах */
  descriptionBytes?: boolean;
  /** Сумарна довжина тегів (YouTube) */
  tagsTotal?: number;
  /** Максимум хештегів (Instagram) */
  hashtags?: number;
}

export const PLATFORM_LIMITS: Record<Platform, PlatformLimits> = {
  youtube: { title: 100, titleRequired: true, description: 5000, descriptionBytes: true, tagsTotal: 500 },
  tiktok: { title: 0, titleRequired: false, description: 2200 },
  instagram: { title: 0, titleRequired: false, description: 2200, hashtags: 30 },
  facebook: { title: 255, titleRequired: false, description: 5000 },
};

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/** Тег без початкового «#» (у БД зберігаємо без нього, але вхід може містити) */
export const normalizeTag = (tag: string): string => tag.trim().replace(/^#+/, '');

/** Довжина тегів разом: YouTube рахує кожен тег із пробілом — беремо суму довжин + роздільники (кома) */
function tagsLength(tags: string[]): number {
  const clean = tags.map(normalizeTag).filter(Boolean);
  return clean.reduce((n, t) => n + t.length, 0) + Math.max(0, clean.length - 1);
}

export function validateMeta(platform: Platform, meta: PublicationMeta): string[] {
  const lim = PLATFORM_LIMITS[platform];
  const errors: string[] = [];
  const title = meta.title.trim();

  if (lim.titleRequired && title.length === 0) errors.push('Назва обов\'язкова');
  if (lim.title > 0 && title.length > lim.title) {
    errors.push(`Назва довша за ${lim.title} символів`);
  }
  if (platform === 'youtube' && /[<>]/.test(meta.title)) {
    errors.push('Назва не може містити символи < та >');
  }

  if (lim.descriptionBytes) {
    if (byteLength(meta.description) > lim.description) {
      errors.push(`Опис довший за ${lim.description} байтів`);
    }
  } else if (meta.description.length > lim.description) {
    errors.push(`Опис довший за ${lim.description} символів`);
  }

  if (lim.tagsTotal !== undefined && tagsLength(meta.tags) > lim.tagsTotal) {
    errors.push(`Теги разом довші за ${lim.tagsTotal} символів`);
  }
  if (lim.hashtags !== undefined) {
    const n = meta.tags.map(normalizeTag).filter(Boolean).length;
    if (n > lim.hashtags) errors.push(`Забагато хештегів: максимум ${lim.hashtags}`);
  }
  return errors;
}

/** Обрізає рядок до `max` символів по останньому пробілу (якщо він є) */
function clampText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut).trimEnd();
}

/** Обрізає рядок до `max` байтів UTF-8 по останньому пробілу, не ламаючи символи */
function clampBytes(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (byteLength(out + ch) > max) break;
    out += ch;
  }
  const sp = out.lastIndexOf(' ');
  return (sp > 0 ? out.slice(0, sp) : out).trimEnd();
}

export function clampMeta(platform: Platform, meta: PublicationMeta): PublicationMeta {
  const lim = PLATFORM_LIMITS[platform];
  let title = platform === 'youtube' ? meta.title.replace(/[<>]/g, '') : meta.title;
  if (lim.title > 0) title = clampText(title, lim.title);
  const description = lim.descriptionBytes
    ? clampBytes(meta.description, lim.description)
    : clampText(meta.description, lim.description);

  let tags = meta.tags.map(normalizeTag).filter(Boolean);
  if (lim.tagsTotal !== undefined) {
    while (tags.length > 0 && tagsLength(tags) > lim.tagsTotal) tags = tags.slice(0, -1);
  }
  if (lim.hashtags !== undefined) tags = tags.slice(0, lim.hashtags);

  return { ...meta, title, description, tags };
}
