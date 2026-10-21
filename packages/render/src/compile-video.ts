import type { Effect, MediaClip } from '@vf/shared';
import { clipFades, clipTransform, num } from '@vf/timeline';
import type { Size } from './types';

/**
 * Трансформація шару виразами ffmpeg — та сама геометрія, що `coverRect` у `@vf/timeline`:
 * розмір cover/contain × масштаб закону, зсув так, щоб точка фокусу (`cx`, `cy`) лишалась на місці.
 *
 * Обраний варіант (спайк Task 8): `scale=…:eval=frame` (у scale `t` — локальний час кліпу) +
 * `overlay` з виразними `x/y` (глобальний `t`, фактичний `overlay_w/h` після округлення) на чорне полотно.
 * Варіант з `crop` відкинуто: crop тримає `in_w` з конфігурації й при змінному розмірі зсуває кадр
 * (асиметрія 126/255 у середині Ken Burns), до того ж не вміє contain і масштаб < 1. `zoompan` — тремтить.
 * Композиція в yuv444 (overlay у yuv420 округлює позицію до парного пікселя: центр «пилкою» на 1,5 px),
 * для Ken Burns — у 2× з поверненням до розміру виходу (compile.ts).
 * Виміряно (ffmpeg 5.1.9, шахівниця 1200², 720×1280): середня абсолютна різниця з drawFrame
 * 1.24 / 0.71 / 0.60 з 255 (t = 0.1 / 2.5 / 4.9 с), zoom 1.7 / 0.5 / 0.3; крок масштабу клітинки
 * 0…0.30 px/кадр при середньому 0.16 (монотонно), дрейф центру 0.22 px.
 */
export function transformFilter(
  effects: Effect[],
  src: Size,
  out: Size,
  fit: 'cover' | 'contain',
  duration: number,
  start: number,
) {
  const base =
    fit === 'cover'
      ? Math.max(out.width / src.width, out.height / src.height)
      : Math.min(out.width / src.width, out.height / src.height);
  const w0 = src.width * base;
  const h0 = src.height * base;
  const x0 = (out.width - w0) / 2;
  const y0 = (out.height - h0) / 2;
  const tr = clipTransform(effects);
  const local = `min(1,t/${num(duration)})`;
  const global = `min(1,max(0,(t-${num(start)})/${num(duration)}))`;
  const fx = `${tr.cx.expr(global)}*${out.width}`;
  const fy = `${tr.cy.expr(global)}*${out.height}`;
  return {
    w: `max(2,${num(w0)}*${tr.scale.expr(local)})`,
    h: `max(2,${num(h0)}*${tr.scale.expr(local)})`,
    x: `${fx}-(${fx}-${num(x0)})*overlay_w/${num(w0)}`,
    y: `${fy}-(${fy}-${num(y0)})*overlay_h/${num(h0)}`,
  };
}

/** Ланцюг одного візуального кліпу: вхід `[n:v]` → прозорий шар у глобальному часі `[label]` + параметри overlay. */
export function clipChain(
  clip: MediaClip,
  input: number,
  label: string,
  src: Size & { kind: 'image' | 'video' },
  out: Size,
  fps: number,
) {
  const D = num(clip.duration);
  const tf = transformFilter(clip.effects, src, out, clip.fit, clip.duration, clip.start);
  const { fadeIn, fadeOut } = clipFades(clip.effects);
  // фото: `speed`/`hold` не діють — кадр просто показується всю тривалість кліпу
  const speed = src.kind === 'video' ? (clip.speed ?? 1) : 1;
  const hold = src.kind === 'video' ? (clip.hold ?? 0) : 0;
  const play = num(clip.duration - hold);
  const steps = [
    speed !== 1 ? `setpts=(PTS-STARTPTS)/${num(speed)}` : 'setpts=PTS-STARTPTS',
    `fps=${fps}`,
    // джерело трохи коротше за durationMs → тримаємо останній кадр, а не чорне
    ...(src.kind === 'video' ? [`tpad=stop_mode=clone:stop_duration=${play}`] : []),
    // стоп-кадр: останній кадр використаної частини до кінця кліпу
    ...(hold > 0 ? [`trim=duration=${play}`, `tpad=stop_mode=clone:stop_duration=${num(hold)}`] : []),
    `trim=duration=${D}`,
    `scale=w='${tf.w}':h='${tf.h}':eval=frame:flags=bicubic`,
    'format=yuva444p',
    ...(fadeIn > 0 ? [`fade=t=in:st=0:d=${num(Math.min(fadeIn, clip.duration))}:alpha=1`] : []),
    ...(fadeOut > 0
      ? [
          `fade=t=out:st=${num(Math.max(0, clip.duration - fadeOut))}:d=${num(Math.min(fadeOut, clip.duration))}:alpha=1`,
        ]
      : []),
    `setpts=PTS+${num(clip.start)}/TB`,
  ];
  const overlay = `overlay=x='${tf.x}':y='${tf.y}':eval=frame:format=yuv444:eof_action=pass:enable='between(t,${num(clip.start)},${num(clip.start + clip.duration)})'`;
  return { chain: `[${input}:v]${steps.join(',')}[${label}]`, overlay };
}
