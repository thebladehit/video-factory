import type { SegmentFit } from '@vf/timeline';

const sec = (v: number) => `${v.toFixed(1).replace('.', ',')} с`;
const speedText = (v: number) => `×${String(Number(v.toFixed(2))).replace('.', ',')}`;

/** «база 4,1 с → EN 5,3 с (темп ×0,8 + стоп-кадр 0,2 с)» */
export function formatFit(fit: SegmentFit, lang: string): string {
  const notes: string[] = [];
  if (Math.abs(fit.speed - 1) > 0.004) notes.push(`темп ${speedText(fit.speed)}`);
  if (fit.hold >= 0.05) notes.push(`стоп-кадр ${sec(fit.hold)}`);
  if (fit.trimmed >= 0.05) notes.push(`обрізано ${sec(fit.trimmed)}`);
  const head = `база ${sec(fit.base)} → ${lang.toUpperCase()} ${sec(fit.target)}`;
  return notes.length ? `${head} (${notes.join(' + ')})` : head;
}

export const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;
