import type { CatalogEntry } from './catalog';

/** Оцінка вартості за цінами каталогу; null — ціни для моделі невідомі. */
export function estimateCost(
  entry: CatalogEntry,
  u: { images?: number; seconds?: number; durationSec?: number; inputTokens?: number; outputTokens?: number },
): number | null {
  if (!entry.pricing?.length) return null;
  let usd = 0;
  for (const p of entry.pricing) {
    if (p.unit === 'image') usd += p.usd * (u.images ?? 0);
    else if (p.unit === 'second') usd += p.usd * (u.seconds ?? 0);
    else if (p.unit === 'minute') usd += (p.usd * (u.durationSec ?? 0)) / 60;
    else if (p.unit === '1M_tokens_in') usd += (p.usd * (u.inputTokens ?? 0)) / 1e6;
    else if (p.unit === '1M_tokens_out') usd += (p.usd * (u.outputTokens ?? 0)) / 1e6;
  }
  return usd;
}
