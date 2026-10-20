import { describe, expect, it } from 'vitest';
import { evalExpr as interpret } from './expr-eval';
import { clipTransform, constant, easeAlpha, lerp, type Law } from './laws';

const points = Array.from({ length: 11 }, (_, k) => k / 10);
const parity = (name: string, law: Law) =>
  it(`${name}: expr == at in 11 points`, () => {
    for (const p of points) expect(interpret(law.expr('p'), { p })).toBeCloseTo(law.at(p), 9);
  });

describe('laws', () => {
  parity('lerp up', lerp(1, 1.15));
  parity('lerp down with negatives', lerp(0.7, -0.25));
  parity('constant', constant(1.2));
  const kb = clipTransform([
    { type: 'kenburns', params: { fromScale: 1, toScale: 1.4, fromX: 0.2, fromY: 0.9, toX: 0.8, toY: 0.1 } },
  ]);
  parity('kenburns scale', kb.scale);
  parity('kenburns cx', kb.cx);
  parity('kenburns cy', kb.cy);
  const zm = clipTransform([{ type: 'zoom', params: { scale: 1.3, x: 0.3, y: 0.6 } }]);
  parity('zoom scale', zm.scale);
  parity('zoom cx', zm.cx);

  it('easeAlpha: expr == at over the clip (local seconds)', () => {
    for (const [fi, fo, d] of [
      [0.3, 0, 2],
      [0, 0.5, 2],
      [0.5, 0.5, 3],
      [0, 0, 1],
      [1.5, 1.5, 2],
    ] as const) {
      const a = easeAlpha(fi, fo, d);
      for (const p of points) expect(interpret(a.expr('T'), { T: p * d })).toBeCloseTo(a.at(p * d), 9);
    }
  });

  it('expressions use only + - * / ( ) , min max and the variable', () => {
    const all = [lerp(1, 1.15).expr('p'), easeAlpha(0.3, 0.2, 2).expr('T'), kb.cx.expr('p')].join(' ');
    expect(all.replace(/min|max|\d|\.|[-+*/(), ]|\bp\b|\bT\b/g, '')).toBe('');
  });

  it('kenburns > zoom > identity', () => {
    const both = clipTransform([
      { type: 'zoom', params: { scale: 2, x: 0.5, y: 0.5 } },
      { type: 'kenburns', params: { fromScale: 1, toScale: 1.15, fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5 } },
    ]);
    expect(both.scale.at(1)).toBeCloseTo(1.15);
    const id = clipTransform([]);
    expect([id.scale.at(0.3), id.cx.at(0.3), id.cy.at(0.3)]).toEqual([1, 0.5, 0.5]);
  });
});
