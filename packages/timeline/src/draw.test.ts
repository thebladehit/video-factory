import { describe, expect, it } from 'vitest';
import { coverRect } from './draw';

const src = { width: 1000, height: 1000 };
const dst = { width: 1080, height: 1920 };
const center = (r: { x: number; y: number; w: number; h: number }) => [r.x + r.w / 2, r.y + r.h / 2];

describe('coverRect', () => {
  it('without transform equals old result', () => {
    const base = coverRect(src, dst, 'contain', 1, 0.5, 0.5);
    expect(base).toEqual({ x: 0, y: 420, w: 1080, h: 1080 });
    expect(coverRect(src, dst, 'contain', 1, 0.5, 0.5, { scale: 1, x: 0.5, y: 0.5 })).toEqual(base);
    expect(coverRect(src, dst, 'cover', 1.5, 0.3, 0.7)).toEqual(coverRect(src, dst, 'cover', 1.5, 0.3, 0.7, undefined));
  });

  it('transform scale 0.5 centered → rect is half of contain rect, centered', () => {
    const r = coverRect(src, dst, 'contain', 1, 0.5, 0.5, { scale: 0.5, x: 0.5, y: 0.5 });
    expect(r).toEqual({ x: 270, y: 690, w: 540, h: 540 });
  });

  it('transform x 0.25 y 0.75 moves center to (270, 1440)', () => {
    const r = coverRect(src, dst, 'contain', 1, 0.5, 0.5, { scale: 0.5, x: 0.25, y: 0.75 });
    expect(center(r)).toEqual([270, 1440]);
  });

  it('zoom scale 2 around focus applies after transform', () => {
    const t = { scale: 0.5, x: 0.25, y: 0.75 };
    const plain = coverRect(src, dst, 'contain', 1, 0.5, 0.5, t);
    // фокус у центрі rect із transform → центр лишається, розмір ×2
    const zoomed = coverRect(src, dst, 'contain', 2, 0.25, 0.75, t);
    expect(center(zoomed)).toEqual(center(plain));
    expect(zoomed.w).toBe(plain.w * 2);
  });
});
