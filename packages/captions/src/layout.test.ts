import { describe, expect, it } from 'vitest';
import type { Word } from '@vf/shared';
import { PRESETS, layoutWords, resolveStyle, captionStyleSchema, FONTS, type CaptionStyle } from './index';

const frame = { width: 1080, height: 1920 };
const base: CaptionStyle = { ...PRESETS[3]!.style, maxWordsPerLine: 3, maxLines: 1, uppercase: false };
// слова по 0,3 с із проміжком gap
const mk = (texts: string[], gap = 0.05): Word[] =>
  texts.map((text, i) => ({
    text,
    startMs: Math.round(i * (0.3 + gap) * 1000),
    endMs: Math.round((i * (0.3 + gap) + 0.3) * 1000),
  }));
const txt = (p: { lines: Word[][] }) => p.lines.map((l) => l.map((w) => w.text).join(' '));

describe('layoutWords', () => {
  it('maxWordsPerLine 3, maxLines 1 -> pages of 3 words', () => {
    const pages = layoutWords(mk(['a', 'b', 'c', 'd', 'e', 'f', 'g']), base, frame);
    expect(pages.map((p) => txt(p))).toEqual([['a b c'], ['d e f'], ['g']]);
    expect(pages[0]!.start).toBe(0);
    expect(pages[0]!.end).toBeCloseTo(1.0, 5);
  });

  it('two lines per page when maxLines 2', () => {
    const pages = layoutWords(mk(['a', 'b', 'c', 'd', 'e']), { ...base, maxLines: 2 }, frame);
    expect(pages.map((p) => txt(p))).toEqual([['a b c', 'd e']]);
  });

  it('a pause longer than 0.5 s starts a new page; exactly 0.5 s does not', () => {
    const w = mk(['a', 'b']);
    const longGap = [w[0]!, { ...w[1]!, startMs: w[0]!.endMs + 600, endMs: w[0]!.endMs + 900 }];
    expect(layoutWords(longGap, base, frame)).toHaveLength(2);
    const edge = [w[0]!, { ...w[1]!, startMs: w[0]!.endMs + 500, endMs: w[0]!.endMs + 800 }];
    expect(layoutWords(edge, base, frame)).toHaveLength(1);
  });

  it('. and ? end the page', () => {
    const pages = layoutWords(mk(['Hi.', 'what', 'now?', 'ok']), base, frame);
    expect(pages.map((p) => txt(p))).toEqual([['Hi.'], ['what now?'], ['ok']]);
  });

  it('a word that does not fit the width gets its own line', () => {
    const long = 'Конституційноправовий';
    const pages = layoutWords(mk(['a', long, 'b']), { ...base, maxLines: 2, size: 8 }, frame);
    expect(pages.map((p) => txt(p))).toEqual([['a', long], ['b']]);
  });

  it('uppercase does not change timing', () => {
    const w = mk(['a', 'b', 'c', 'd']);
    const a = layoutWords(w, base, frame).map((p) => [p.start, p.end]);
    const b = layoutWords(w, { ...base, uppercase: true }, frame).map((p) => [p.start, p.end]);
    expect(b).toEqual(a);
  });
});

describe('styles', () => {
  it('presets validate against the schema and use bundled fonts', () => {
    for (const p of PRESETS) {
      expect(captionStyleSchema.safeParse(p.style).success).toBe(true);
      expect(FONTS.some((f) => f.id === p.style.font)).toBe(true);
    }
    expect(PRESETS.map((p) => p.id)).toEqual(['preset:shorts', 'preset:pop', 'preset:karaoke', 'preset:classic']);
  });
  it('resolveStyle: preset, saved, unknown -> shorts', () => {
    const saved = { s1: { ...base, size: 5 } };
    expect(resolveStyle('preset:pop', saved)).toBe(PRESETS[1]!.style);
    expect(resolveStyle('s1', saved).size).toBe(5);
    expect(resolveStyle('nope', saved)).toBe(PRESETS[0]!.style);
  });
  it('schema rejects bad values', () => {
    expect(captionStyleSchema.safeParse({ ...base, size: 20 }).success).toBe(false);
    expect(captionStyleSchema.safeParse({ ...base, color: 'red' }).success).toBe(false);
  });
});
