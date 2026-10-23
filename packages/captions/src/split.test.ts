import { describe, expect, it } from 'vitest';
import { CHUNK_JOIN, LEAD_IN_MS, MIN_GAP_MS, TAIL_OUT_MS, chunkLines, splitTake } from './index';

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

  it('three lines with clear pauses → ranges trimmed to words inside 0..durationMs', () => {
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech, durationMs: 2700 });
    expect(lines.map((l) => l && [l.startMs, l.endMs])).toEqual([
      [0, 700],
      [940, 1700],
      [2140, 2600],
    ]);
  });

  it('ranges are trimmed to words with 60/100 ms margins inside the midpoint limits', () => {
    expect([LEAD_IN_MS, TAIL_OUT_MS]).toEqual([60, 100]);
    // пауза 600..700: середина 650 обмежує і хвіст першого (700), і вступ другого (640); краї — 0 і durationMs
    const ws = [w('а', 100, 600), w('б', 700, 900)];
    const { lines } = splitTake({ words: ws, matched: T(2), lineTexts: ['а', 'б'], speech: [], durationMs: 950 });
    expect(lines.map((l) => l && [l.startMs, l.endMs])).toEqual([
      [40, 650],
      [650, 950],
    ]);
    expect(lines[0]!.words[0]).toEqual(w('а', 60, 560));
    expect(lines[1]!.words[0]).toEqual(w('б', 50, 250));
  });

  it('boundary snaps to silence interval inside the gap', () => {
    // gap 600..1000, mid 800; speech noise covers 650..950 → silence 600..650 and 950..1000
    const sp = [
      { startMs: 0, endMs: 600 },
      { startMs: 650, endMs: 950 },
      { startMs: 1000, endMs: 1600 },
      { startMs: 2200, endMs: 2500 },
    ];
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech: sp, durationMs: 2700 });
    // nearest silence edge to 800 is 650 or 950 (tie → earlier): the tail (600 + 100) is clamped to it
    expect(lines[0]!.endMs).toBe(650);
    expect(lines[1]!.startMs).toBe(940);
  });

  it('unmatched last word of line 1 → lines 1 and 2 are null, line 3 ok', () => {
    const matched = [true, false, true, true, true];
    const { lines } = splitTake({ words, matched, lineTexts, speech, durationMs: 2700 });
    expect(lines[0]).toBeNull();
    expect(lines[1]).toBeNull();
    expect(lines[2]).not.toBeNull();
    expect(lines[2]!.endMs).toBe(2600);
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
      ['три', 60, 360],
      ['чотири', 360, 660],
    ]);
    expect(lines[2]!.words[0]).toEqual(w('п’ять', 60, 360));
  });
});
