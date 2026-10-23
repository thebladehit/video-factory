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

  it('three lines with clear pauses → ranges follow the real speech with lead-in/tail margins', () => {
    expect([LEAD_IN_MS, TAIL_OUT_MS]).toEqual([80, 150]);
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech, durationMs: 2700 });
    expect(lines.map((l) => l && [l.startMs, l.endMs])).toEqual([
      [0, 750],
      [920, 1750],
      [2120, 2650],
    ]);
  });

  it('STT timings off by ~100 ms: cuts follow the audio silence, not the word timestamps', () => {
    // живий шматок Gemini + whisper: whisper ставить «A» на 4240 і «smiled.» до 7160, а мовлення — 4093..7282
    const sp = [
      { startMs: 332, endMs: 1652 },
      { startMs: 1960, endMs: 3554 },
      { startMs: 4093, endMs: 6326 },
      { startMs: 6536, endMs: 7282 },
      { startMs: 7957, endMs: 10841 },
    ];
    const ws = [w('The', 0, 500), w('it.', 3320, 3760), w('A', 4240, 4440), w('smiled.', 6780, 7160), w('Then', 8020, 8200), w('everything.', 10180, 10760)];
    const { lines } = splitTake({
      words: ws,
      matched: T(6),
      lineTexts: ['The it.', 'A smiled.', 'Then everything.'],
      speech: sp,
      durationMs: 11160,
    });
    expect(lines.map((l) => l && [l.startMs, l.endMs])).toEqual([
      [252, 3704],
      [4013, 7432],
      [7877, 10991],
    ]);
    // жоден рядок не захоплює мовлення сусіда
    expect(lines[1]!.startMs).toBeGreaterThan(3554);
    expect(lines[1]!.endMs).toBeLessThan(7957);
  });

  it('a pause inside a line far from the STT gap is not taken as the boundary', () => {
    const sp = [
      { startMs: 0, endMs: 300 },
      { startMs: 450, endMs: 600 }, // пауза 300..450 всередині першого рядка
      { startMs: 1000, endMs: 1600 },
      { startMs: 2200, endMs: 2500 },
    ];
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech: sp, durationMs: 2700 });
    expect(lines[0]!.endMs).toBe(750);
    expect(lines[1]!.startMs).toBe(920);
  });

  it('no silence near the STT gap → both neighbours null', () => {
    const sp = [
      { startMs: 0, endMs: 1600 },
      { startMs: 2200, endMs: 2500 },
    ];
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech: sp, durationMs: 2700 });
    expect(lines[0]).toBeNull();
    expect(lines[1]).toBeNull();
    expect(lines[2]).not.toBeNull();
  });

  it('no speech intervals at all → every line null (no audio evidence to cut by)', () => {
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech: [], durationMs: 2700 });
    expect(lines).toEqual([null, null, null]);
  });

  it('unmatched last word of line 1 → lines 1 and 2 are null, line 3 ok', () => {
    const matched = [true, false, true, true, true];
    const { lines } = splitTake({ words, matched, lineTexts, speech, durationMs: 2700 });
    expect(lines[0]).toBeNull();
    expect(lines[1]).toBeNull();
    expect(lines[2]).not.toBeNull();
    expect(lines[2]!.endMs).toBe(2650);
  });

  it('silence shorter than 80 ms is not a boundary → both neighbours null', () => {
    expect(MIN_GAP_MS).toBe(80);
    const sp = [
      { startMs: 0, endMs: 950 },
      { startMs: 1000, endMs: 1600 },
      { startMs: 2200, endMs: 2500 },
    ];
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech: sp, durationMs: 2700 });
    expect(lines[0]).toBeNull();
    expect(lines[1]).toBeNull();
  });

  it('words shifted to line start', () => {
    const { lines } = splitTake({ words, matched: T(5), lineTexts, speech, durationMs: 2700 });
    expect(lines[1]!.words.map((x) => [x.text, x.startMs, x.endMs])).toEqual([
      ['три', 80, 380],
      ['чотири', 380, 680],
    ]);
    expect(lines[2]!.words[0]).toEqual(w('п’ять', 80, 380));
  });
});
