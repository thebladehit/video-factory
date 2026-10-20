export const ASSET_STATUSES = ['uploading', 'processing', 'ready', 'failed'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export type AssetSource = 'generated' | 'uploaded' | 'rendered';
export type Orientation = 'vertical' | 'horizontal' | 'square';

const MAX_TAGS = 30;
const MAX_TAG_LENGTH = 40;
const MAX_PROMPT_TITLE = 80;

/** Ключі S3 генерує лише сервер; префікс користувача — для квот і видалення в SaaS */
export const assetKeys = {
  original: (userId: string, assetId: string, ext: string) => `u/${userId}/assets/${assetId}/original.${ext}`,
  thumb: (userId: string, assetId: string) => `u/${userId}/assets/${assetId}/thumb.webp`,
};

export function normalizeTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const tag = t.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (tag) out.add(tag);
    if (out.size === MAX_TAGS) break;
  }
  return [...out];
}

export function titleFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).trim();
}

export function titleFromPrompt(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, ' ');
  if (text.length <= MAX_PROMPT_TITLE) return text;
  const cut = text.slice(0, MAX_PROMPT_TITLE);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
