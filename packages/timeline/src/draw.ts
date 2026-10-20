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
 * Прямокутник джерела в кадрі: cover/contain, потім масштаб `scale` навколо точки фокусу (`cx`, `cy` — частки кадру).
 * Ту саму геометрію виразами повторює `@vf/render` (compile-video).
 */
export function coverRect(src: Size, dst: Size, fit: 'cover' | 'contain', scale: number, cx: number, cy: number) {
  const base =
    fit === 'cover'
      ? Math.max(dst.width / src.width, dst.height / src.height)
      : Math.min(dst.width / src.width, dst.height / src.height);
  const w0 = src.width * base;
  const h0 = src.height * base;
  const x0 = (dst.width - w0) / 2;
  const y0 = (dst.height - h0) / 2;
  const fx = cx * dst.width;
  const fy = cy * dst.height;
  return { x: fx - (fx - x0) * scale, y: fy - (fy - y0) * scale, w: w0 * scale, h: h0 * scale };
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
    const r = coverRect(src, size, layer.fit, layer.scale, layer.cx, layer.cy);
    ctx.globalAlpha = Math.min(1, layer.alpha);
    ctx.drawImage(src.image, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
  }
  ctx.restore();
}
