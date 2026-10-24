import type { Platform, PublicationMeta } from '@vf/shared';
import { normalizeTag } from './limits';

/** Текст для «Скопіювати метадані» при ручній публікації */
export function formatForCopy(platform: Platform, meta: PublicationMeta): string {
  const tags = meta.tags.map(normalizeTag).filter(Boolean);
  const parts: string[] = [];

  if (platform === 'youtube') {
    parts.push(meta.title, meta.description);
    if (tags.length > 0) parts.push(`Теги: ${tags.join(', ')}`);
    return parts.join('\n\n');
  }

  // Facebook має назву — додаємо її, якщо заповнена
  if (platform === 'facebook' && meta.title.trim()) parts.push(meta.title);
  parts.push(meta.description);
  if (tags.length > 0) parts.push(tags.map((t) => `#${t}`).join(' '));
  return parts.filter((p) => p.length > 0).join('\n\n');
}
