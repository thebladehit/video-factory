import type { Effect } from '@vf/shared';

/**
 * Закон ефекту описано один раз: `at` — число для canvas-прев'ю, `expr` — вираз для ffmpeg.
 * `p` — прогрес 0..1 у кліпі. Вирази використовують лише `+ - * / ( ) min max` і змінну.
 */
export interface Law {
  at(p: number): number;
  expr(p: string): string;
}

/** Число без експоненти й хвоста нулів, від'ємні — в дужках. */
export function num(n: number): string {
  const s = n.toFixed(9).replace(/\.?0+$/, '');
  const v = s === '-0' ? '0' : s;
  return v.startsWith('-') ? `(${v})` : v;
}

export const constant = (v: number): Law => ({ at: () => v, expr: () => num(v) });

export const lerp = (a: number, b: number): Law =>
  a === b ? constant(a) : { at: (p) => a + (b - a) * p, expr: (p) => `(${num(a)}+${num(b - a)}*(${p}))` };

/**
 * Альфа кліпу за локальним часом (секунди від початку): лінійна рампа появи `fadeIn` і зникнення `fadeOut`.
 * У ffmpeg та сама рампа — фільтр `fade=…:alpha=1` з тими ж `st/d`.
 */
export function easeAlpha(
  fadeIn: number,
  fadeOut: number,
  duration: number,
): { at(local: number): number; expr(local: string): string } {
  return {
    at(local) {
      let a = 1;
      if (fadeIn > 0) a = Math.min(a, local / fadeIn);
      if (fadeOut > 0) a = Math.min(a, (duration - local) / fadeOut);
      return Math.max(0, a);
    },
    expr(local) {
      let e = '1';
      if (fadeIn > 0) e = `min(${e},(${local})/${num(fadeIn)})`;
      if (fadeOut > 0) e = `min(${e},(${num(duration)}-(${local}))/${num(fadeOut)})`;
      return `max(0,${e})`;
    },
  };
}

export interface ClipTransform {
  scale: Law;
  cx: Law;
  cy: Law;
}

/** Масштаб і точка фокусу кліпу: `kenburns` > `zoom` > без змін. */
export function clipTransform(effects: Effect[]): ClipTransform {
  const kb = effects.find((e) => e.type === 'kenburns');
  if (kb?.type === 'kenburns') {
    const k = kb.params;
    return { scale: lerp(k.fromScale, k.toScale), cx: lerp(k.fromX, k.toX), cy: lerp(k.fromY, k.toY) };
  }
  const zm = effects.find((e) => e.type === 'zoom');
  if (zm?.type === 'zoom')
    return { scale: constant(zm.params.scale), cx: constant(zm.params.x), cy: constant(zm.params.y) };
  return { scale: constant(1), cx: constant(0.5), cy: constant(0.5) };
}

/** Тривалості появи/зникнення кліпу: `xfade` додає вхідну рампу. */
export function clipFades(effects: Effect[]): { fadeIn: number; fadeOut: number } {
  let fadeIn = 0;
  let fadeOut = 0;
  for (const e of effects) {
    if (e.type === 'fade') {
      fadeIn = Math.max(fadeIn, e.params.in);
      fadeOut = Math.max(fadeOut, e.params.out);
    } else if (e.type === 'xfade') fadeIn = Math.max(fadeIn, e.params.duration);
  }
  return { fadeIn, fadeOut };
}
