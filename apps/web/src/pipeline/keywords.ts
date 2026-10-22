export const MAX_KEYWORDS = 8;

/** «а, б ,, а» → ['а', 'б']: trim, без порожніх і повторів, не більше 8 (як перевіряє сервер). */
export function parseKeywords(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_KEYWORDS);
}

export const joinKeywords = (keywords: string[]) => keywords.join(', ');

/**
 * Що зберегти з поля ключових слів: `null` — нічого (порожньо або те саме, що вже відправлено/на сервері).
 * `lastCommitted` — останнє відправлене значення: Enter і наступний blur не дублюють запит.
 */
export function keywordsToSave(text: string, lastCommitted: string): string[] | null {
  const keywords = parseKeywords(text);
  if (!keywords.length || joinKeywords(keywords) === lastCommitted) return null;
  return keywords;
}
