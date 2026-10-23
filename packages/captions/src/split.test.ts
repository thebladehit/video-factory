import { describe, expect, it } from 'vitest';
import { CHUNK_JOIN, MIN_GAP_MS, chunkLines, splitTake } from './index';

const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });
const T = (n: number) => Array(n).fill(true) as boolean[];

describe('chunkLines', () => {
  it('keeps order and splits only between lines at 1500', () => {
    const lines = ['a', 'b', 'c', 'd'].map((id) => ({ id, text: id.repeat(700) }));
    const r = chunkLines(lines);
    expect(r.map((c) => c.map((l) => l.id))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(CHUNK_JOIN).toBe('\n\n');
    for (const c of r) expect(c.map((l) => l.text).join(CHUNK_JOIN).length).toBeLessThanOrEqual(1500);
  });
  it('puts oversize line alone', () => {
    const lines = [
      { id: 'a', text: 'x' },
      { id: 'b', text: 'y'.repeat(2000) },
      { id: 'c', text: 'z' },
    ];
    expect(chunkLines(lines).map((c) => c.map((l) => l.id))).toEqual([['a'], ['b'], ['c']]);
  });
});

describe('splitTake', () => {
  const words = [
    w('Раз', 0, 300),
    w('два', 300, 600),
    w('три', 1000, 1300),
    w('чотири', 1300, 1600),
    w('п’ять', 2200, 2500),
  ];
  const lineTexts = ['Раз два', 'три чотири', 'п’ять'];
  const speech = [
    { startMs: 0, endMs: 600 },
    { startMs: 1000, endMs: 1600 },
    { startMs: 2200, endMs: 2500 },
  ];

  it('three lines with clear pauses → three ranges covering 0..durationMs', () => {
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech, durationMs: 2700 });
    expect(lines.map((l) => l && [l.startMs, l.endMs])).toEqual([
      [0, 800],
      [800, 1900],
      [1900, 2700],
    ]);
  });

  it('boundary snaps to silence interval inside the gap', () => {
    // gap 600..1000, mid 800; speech noise covers 700..900 → silence 600..700 and 900..1000
    const sp = [
      { startMs: 0, endMs: 600 },
      { startMs: 700, endMs: 900 },
      { startMs: 1000, endMs: 1600 },
      { startMs: 2200, endMs: 2500 },
    ];
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech: sp, durationMs: 2700 });
    // nearest silence edge to 800 is 700 or 900 (tie → earlier)
    expect(lines[0]!.endMs).toBe(700);
    expect(lines[1]!.startMs).toBe(700);
  });

  it('unmatched last word of line 1 → lines 1 and 2 are null, line 3 ok', () => {
    const matched = [true, false, true, true, true];
    const { lines } = splitTake({ words, matched, lineTexts, speech, durationMs: 2700 });
    expect(lines[0]).toBeNull();
    expect(lines[1]).toBeNull();
    expect(lines[2]).not.toBeNull();
    expect(lines[2]!.endMs).toBe(2700);
  });

  it('gap 50 ms → both neighbours null', () => {
    expect(MIN_GAP_MS).toBe(80);
    const ws = [w('а', 0, 300), w('б', 350, 600)];
    const { lines } = splitTake({ words: ws, matched: T(2), lineTexts: ['а', 'б'], speech: [], durationMs: 700 });
    expect(lines).toEqual([null, null]);
  });

  it('words shifted to line start', () => {
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech, durationMs: 2700 });
    expect(lines[1]!.words.map((x) => [x.text, x.startMs, x.endMs])).toEqual([
      ['три', 200, 500],
      ['чотири', 500, 800],
    ]);
    expect(lines[2]!.words[0]).toEqual(w('п’ять', 300, 600));
  });
});
