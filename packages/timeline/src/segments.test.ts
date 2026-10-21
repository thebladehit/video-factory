import { describe, expect, it } from 'vitest';
import { emptyTimeline, normalizeDoc, type TimelineDoc } from '@vf/shared';
import {
  addClip,
  deleteSegment,
  groupPhrases,
  mergeSegments,
  segmentsFromSpeech,
  segmentsFromText,
  setSegmentBounds,
  splitSegmentAt,
} from './index';

const seq = () => {
  let i = 0;
  return () => `s${++i}`;
};
// документ тривалістю 10 с при 30 fps
const base = (segments?: { id: string; start: number; end: number }[]): TimelineDoc => {
  const a = addClip(emptyTimeline('9:16'), { id: 'V', kind: 'video', durationSec: 10, hasAudio: false }, { at: 0 });
  return { ...a.doc, ...(segments ? { segments } : {}) };
};
const se = (d: TimelineDoc) => (d.segments ?? []).map((s) => [s.id, s.start, s.end]);

describe('splitSegmentAt', () => {
  it('splits inside a segment', () => {
    const d = splitSegmentAt(base([{ id: 'a', start: 1, end: 5 }]), 3, seq());
    expect(se(d)).toEqual([
      ['a', 1, 3],
      ['s1', 3, 5],
    ]);
    expect(() => normalizeDoc(d)).not.toThrow();
  });
  it('outside creates a segment filling the gap between neighbours', () => {
    const d = splitSegmentAt(
      base([
        { id: 'a', start: 1, end: 2 },
        { id: 'b', start: 6, end: 8 },
      ]),
      4,
      seq(),
    );
    expect(se(d)).toEqual([
      ['a', 1, 2],
      ['s1', 2, 6],
      ['b', 6, 8],
    ]);
  });
  it('with no neighbours uses 0 and docDuration', () => {
    expect(se(splitSegmentAt(base(), 4, seq()))).toEqual([['s1', 0, 10]]);
  });
  it('ignores t at/after doc end and cuts too close to an edge', () => {
    const d = base([{ id: 'a', start: 1, end: 5 }]);
    expect(splitSegmentAt(d, 10, seq())).toBe(d);
    expect(splitSegmentAt(d, 1, seq())).toBe(d);
  });
});

describe('mergeSegments', () => {
  const d = base([
    { id: 'a', start: 0, end: 2 },
    { id: 'b', start: 2, end: 4 },
    { id: 'c', start: 5, end: 6 },
  ]);
  it('merges adjacent, keeps first id', () => {
    expect(se(mergeSegments(d, 'a', 'b'))).toEqual([
      ['a', 0, 4],
      ['c', 5, 6],
    ]);
    expect(se(mergeSegments(d, 'b', 'a'))).toEqual([
      ['a', 0, 4],
      ['c', 5, 6],
    ]);
  });
  it('non-adjacent is a no-op', () => {
    expect(mergeSegments(d, 'a', 'c')).toBe(d);
  });
});

describe('setSegmentBounds', () => {
  const d = base([
    { id: 'a', start: 1, end: 3 },
    { id: 'b', start: 4, end: 6 },
  ]);
  it('clamps to neighbours and [0, docDuration]', () => {
    expect(se(setSegmentBounds(d, 'b', 2, 99))).toEqual([
      ['a', 1, 3],
      ['b', 3, 10],
    ]);
    expect(se(setSegmentBounds(d, 'a', -5, 3.5))).toEqual([
      ['a', 0, 3.5],
      ['b', 4, 6],
    ]);
  });
  it('keeps at least one frame and snaps to frames', () => {
    const r = setSegmentBounds(d, 'a', 2, 2)!.segments![0]!;
    expect(r.end - r.start).toBeCloseTo(1 / 30, 9);
    expect(setSegmentBounds(d, 'a', 1.01, 2.99).segments![0]!.start).toBeCloseTo(1, 9);
  });
  it('result passes normalizeDoc', () => {
    expect(() => normalizeDoc(setSegmentBounds(d, 'b', 3.9, 50))).not.toThrow();
  });
});

describe('deleteSegment', () => {
  it('removes by id', () => {
    const d = base([
      { id: 'a', start: 0, end: 1 },
      { id: 'b', start: 1, end: 2 },
    ]);
    expect(se(deleteSegment(d, 'a'))).toEqual([['b', 1, 2]]);
    expect(() => normalizeDoc(deleteSegment(d, 'a'))).not.toThrow();
    expect(deleteSegment(d, 'zz')).toBe(d);
  });
});

describe('segmentsFromText', () => {
  it('equal contiguous parts', () => {
    const r = segmentsFromText(3, 9, 30, seq());
    expect(r.map((s) => [s.start, s.end])).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
    ]);
  });
  it('caps count so every segment is at least one frame', () => {
    const r = segmentsFromText(10, 0.1, 30, seq());
    expect(r).toHaveLength(3);
    expect(() => normalizeDoc({ ...base(), segments: r })).not.toThrow();
  });
  it('stays contiguous when parts do not land on frames', () => {
    const r = segmentsFromText(3, 10, 30, seq());
    expect(r[0]!.start).toBe(0);
    expect(r[2]!.end).toBeCloseTo(10, 9);
    expect(r[1]!.start).toBe(r[0]!.end);
    expect(r[2]!.start).toBe(r[1]!.end);
  });
});

describe('groupPhrases', () => {
  it('merges short chunks up to sentence end', () => {
    const r = groupPhrases([
      { start: 0, end: 1, text: 'Привіт' },
      { start: 1.1, end: 2.2, text: 'усім,' },
      { start: 2.3, end: 3.5, text: 'це тест.' },
      { start: 3.6, end: 5.6, text: 'Друге речення.' },
    ]);
    expect(r).toEqual([
      { start: 0, end: 3.5, text: 'Привіт усім, це тест.' },
      { start: 3.6, end: 5.6, text: 'Друге речення.' },
    ]);
  });
  it('breaks on pause > 0.7 once the phrase is >= 2 s', () => {
    const r = groupPhrases([
      { start: 0, end: 2.5, text: 'один' },
      { start: 3.4, end: 5.5, text: 'два' },
    ]);
    expect(r).toHaveLength(2);
  });
  it('a pause >= 2 s breaks even a short phrase', () => {
    const r = groupPhrases([
      { start: 0, end: 0.5, text: 'Так.' },
      { start: 8.5, end: 10, text: 'Далі.' },
    ]);
    expect(r).toHaveLength(2);
  });
  it('does not exceed 15 s', () => {
    const stt = Array.from({ length: 10 }, (_, i) => ({ start: i * 3, end: i * 3 + 3, text: 'слово' }));
    const r = groupPhrases(stt);
    expect(r.length).toBeGreaterThan(1);
    for (const p of r) expect(p.end - p.start).toBeLessThanOrEqual(15);
  });
});

describe('segmentsFromSpeech', () => {
  it('leading segment without text when first phrase starts at 1.2 s', () => {
    const { segments, texts } = segmentsFromSpeech(
      [
        { start: 1.2, end: 4, text: 'Перша.' },
        { start: 4.1, end: 7, text: 'Друга.' },
      ],
      10,
      30,
      seq(),
    );
    expect(segments.map((s) => [s.start, s.end])).toEqual([
      [0, 1.2],
      [1.2, 4.1],
      [4.1, 10],
    ]);
    expect(texts).toEqual({ s2: 'Перша.', s3: 'Друга.' });
    expect(texts[segments[0]!.id]).toBeUndefined();
  });
  it('first phrase at 0 produces no leading segment', () => {
    const { segments } = segmentsFromSpeech([{ start: 0, end: 3, text: 'Так.' }], 5, 30, seq());
    expect(segments.map((s) => [s.start, s.end])).toEqual([[0, 5]]);
  });
  it('empty speech gives nothing', () => {
    expect(segmentsFromSpeech([], 5, 30, seq())).toEqual({ segments: [], texts: {} });
  });
});
