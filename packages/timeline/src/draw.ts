import { DEFAULT_TRANSFORM, type ClipTransform } from '@vf/shared';
import type { Layer } from './evaluate';

/** Мінімальний 2D-контекст: браузерний canvas і `@napi-rs/canvas` обидва його задовольняють. */
export interface Ctx2D {
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  globalAlpha: number;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: 'low' | 'medium' | 'high';
  /** HTMLImageElement / HTMLVideoElement / napi Image */
  drawImage(img: any, dx: number, dy: number, dw: number, dh: number): void;
}

export interface FrameSource {
  image: unknown;
  width: number;
  height: number;
}

interface Size {
  width: number;
  height: number;
}

/**
 * Прямокутник джерела в кадрі. Порядок: `fit` (cover/contain) → `transform` → масштаб ефекту `scale` навколо фокусу
 * (`cx`, `cy` — частки кадру). `transform`: прямокутник `fit` (w0×h0) множиться на `transform.scale`, а його центр
 * стає в (`x`·W, `y`·H). Без `transform` (≡ scale 1, x 0.5, y 0.5) результат як раніше.
 * Ту саму геометрію виразами повторює `@vf/render` (compile-video).
 */
export function coverRect(
  src: Size,
  dst: Size,
  fit: 'cover' | 'contain',
  scale: number,
  cx: number,
  cy: number,
  transform?: ClipTransform,
) {
  const base =
    fit === 'cover'
      ? Math.max(dst.width / src.width, dst.height / src.height)
      : Math.min(dst.width / src.width, dst.height / src.height);
  const t = transform ?? DEFAULT_TRANSFORM;
  const w1 = src.width * base * t.scale;
  const h1 = src.height * base * t.scale;
  const x1 = t.x * dst.width - w1 / 2;
  const y1 = t.y * dst.height - h1 / 2;
  const fx = cx * dst.width;
  const fy = cy * dst.height;
  return { x: fx - (fx - x1) * scale, y: fy - (fy - y1) * scale, w: w1 * scale, h: h1 * scale };
}

/** Чорне полотно і шари знизу вгору. `scale` — множник роздільності (прев'ю × devicePixelRatio). */
export function drawFrame(
  ctx: Ctx2D,
  size: Size,
  layers: Layer[],
  sources: (l: Layer) => FrameSource | null,
  scale = 1,
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size.width * scale, size.height * scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (const layer of layers) {
    const src = sources(layer);
    if (!src || !src.width || !src.height || layer.alpha <= 0) continue;
    const r = coverRect(src, size, layer.fit, layer.scale, layer.cx, layer.cy, layer.transform);
    ctx.globalAlpha = Math.min(1, layer.alpha);
    ctx.drawImage(src.image, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
  }
  ctx.restore();
}
