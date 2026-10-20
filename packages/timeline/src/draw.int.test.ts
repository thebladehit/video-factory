import { describe, expect, it } from 'vitest';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { coverRect, drawFrame, type FrameSource } from './draw';
import type { Layer } from './evaluate';

const solid = (w: number, h: number, color: string): FrameSource => {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  return { image: c, width: w, height: h };
};

const layer = (assetId: string, extra: Partial<Layer> = {}): Layer => ({
  clipId: assetId,
  assetId,
  kind: 'image',
  sourceTime: 0,
  alpha: 1,
  scale: 1,
  cx: 0.5,
  cy: 0.5,
  fit: 'cover',
  ...extra,
});

function render(layers: Layer[], sources: Record<string, FrameSource>, size = { width: 108, height: 192 }): Canvas {
  const canvas = createCanvas(size.width, size.height);
  drawFrame(canvas.getContext('2d'), size, layers, (l) => sources[l.assetId] ?? null);
  return canvas;
}

const px = (c: Canvas, x: number, y: number) => [...c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)];

describe('drawFrame', () => {
  it('black canvas for no layers', () => {
    expect(px(render([], {}), 50, 90)).toEqual([0, 0, 0]);
  });

  it('cover fills the frame with the source color', () => {
    const c = render([layer('r')], { r: solid(64, 48, '#ff0000') });
    for (const [x, y] of [
      [54, 96],
      [0, 0],
      [107, 0],
      [0, 191],
      [107, 191],
    ] as const)
      expect(px(c, x, y)).toEqual([255, 0, 0]);
  });

  it('contain leaves black bars', () => {
    const c = render([layer('g', { fit: 'contain' })], { g: solid(160, 90, '#00ff00') });
    expect(px(c, 54, 5)).toEqual([0, 0, 0]);
    expect(px(c, 54, 96)).toEqual([0, 255, 0]);
  });

  it('alpha 0.5 blends with black', () => {
    const [r] = px(render([layer('r', { alpha: 0.5 })], { r: solid(64, 48, '#ff0000') }), 54, 96);
    expect(Math.abs(r! - 128)).toBeLessThanOrEqual(3);
  });

  it('top layer covers bottom', () => {
    const c = render([layer('r'), layer('b')], { r: solid(64, 48, '#ff0000'), b: solid(64, 48, '#0000ff') });
    expect(px(c, 54, 96)).toEqual([0, 0, 255]);
  });

  it('missing source is skipped', () => {
    expect(px(render([layer('x')], {}), 54, 96)).toEqual([0, 0, 0]);
  });

  it('scale multiplies the output resolution', () => {
    const canvas = createCanvas(216, 384);
    drawFrame(
      canvas.getContext('2d'),
      { width: 108, height: 192 },
      [layer('r', { fit: 'contain' })],
      () => solid(160, 90, '#ff0000'),
      2,
    );
    expect(px(canvas, 108, 192)).toEqual([255, 0, 0]);
    expect(px(canvas, 108, 10)).toEqual([0, 0, 0]);
  });
});

describe('coverRect', () => {
  const dst = { width: 100, height: 100 };
  it('with scale 1.15 centered at (0.5,0.5) is centered and 15% larger', () => {
    const r = coverRect({ width: 200, height: 200 }, dst, 'cover', 1.15, 0.5, 0.5);
    expect(r.w).toBeCloseTo(115);
    expect(r.h).toBeCloseTo(115);
    expect(r.x).toBeCloseTo(-7.5);
    expect(r.y).toBeCloseTo(-7.5);
  });

  it('focus point (0,0) keeps the top-left corner anchored', () => {
    const r = coverRect({ width: 200, height: 200 }, dst, 'cover', 1.5, 0, 0);
    expect([r.x, r.y]).toEqual([0, 0]);
    expect(r.w).toBeCloseTo(150);
  });

  it('cover of a wide source on a tall frame is centered horizontally', () => {
    const r = coverRect({ width: 160, height: 90 }, { width: 90, height: 160 }, 'cover', 1, 0.5, 0.5);
    expect(r.h).toBeCloseTo(160);
    expect(r.x).toBeCloseTo((90 - r.w) / 2);
  });
});
