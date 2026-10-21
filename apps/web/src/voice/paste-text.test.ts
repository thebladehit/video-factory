import { describe, expect, it } from 'vitest';
import { emptyTimeline, type TimelineDoc } from '@vf/shared';
import { addClip } from '@vf/timeline';
import { planPaste, splitParagraphs } from './paste-text';

const docOf = (seconds: number, segments?: { id: string; start: number; end: number }[]): TimelineDoc => {
  const r = addClip(
    emptyTimeline('9:16'),
    { id: 'v', kind: 'video', durationSec: seconds, hasAudio: false },
    { at: 0 },
  );
  return segments ? { ...r.doc, segments } : r.doc;
};
let n = 0;
const id = () => `n${++n}`;

describe('splitParagraphs', () => {
  it('splits on blank lines, trims, drops empties', () => {
    expect(splitParagraphs('  Один\nрядок \n\n\n Два \r\n\r\n\n  ')).toEqual(['Один\nрядок', 'Два']);
  });
  it('returns [] for blank input', () => {
    expect(splitParagraphs(' \n \n')).toEqual([]);
  });
});

describe('planPaste', () => {
  it('no segments: splits the duration evenly, one paragraph per segment', () => {
    n = 0;
    const plan = planPaste(['a', 'b', 'c'], docOf(9), id);
    expect(plan.doc.segments).toEqual([
      { id: 'n1', start: 0, end: 3 },
      { id: 'n2', start: 3, end: 6 },
      { id: 'n3', start: 6, end: 9 },
    ]);
    expect(plan.assignments).toEqual([
      { segmentId: 'n1', text: 'a' },
      { segmentId: 'n2', text: 'b' },
      { segmentId: 'n3', text: 'c' },
    ]);
    expect(plan.extra).toBe(0);
    expect(plan.dropped).toBe(0);
  });

  it('existing segments: fills in time order, fewer paragraphs leave the tail untouched', () => {
    const segs = [
      { id: 's2', start: 4, end: 6 },
      { id: 's1', start: 0, end: 3 },
    ];
    const doc = docOf(10, segs);
    const plan = planPaste(['x'], doc, id);
    expect(plan.doc).toBe(doc);
    expect(plan.assignments).toEqual([{ segmentId: 's1', text: 'x' }]);
    expect(plan.extra).toBe(0);
  });

  it('extra paragraphs become new segments in the free space after the last one', () => {
    n = 0;
    const doc = docOf(10, [
      { id: 's1', start: 0, end: 2 },
      { id: 's2', start: 2, end: 6 },
    ]);
    const plan = planPaste(['a', 'b', 'c', 'd'], doc, id);
    expect(plan.doc.segments).toEqual([
      { id: 's1', start: 0, end: 2 },
      { id: 's2', start: 2, end: 6 },
      { id: 'n1', start: 6, end: 8 },
      { id: 'n2', start: 8, end: 10 },
    ]);
    expect(plan.assignments.map((a) => a.segmentId)).toEqual(['s1', 's2', 'n1', 'n2']);
    expect(plan.extra).toBe(2);
    expect(plan.dropped).toBe(0);
  });

  it('extra paragraphs that do not fit are dropped and counted', () => {
    n = 0;
    const doc = docOf(10, [{ id: 's1', start: 0, end: 10 }]);
    const plan = planPaste(['a', 'b'], doc, id);
    expect(plan.doc.segments).toEqual([{ id: 's1', start: 0, end: 10 }]);
    expect(plan.assignments).toEqual([{ segmentId: 's1', text: 'a' }]);
    expect(plan.extra).toBe(1);
    expect(plan.dropped).toBe(1);
  });

  it('an empty timeline yields nothing', () => {
    const plan = planPaste(['a'], emptyTimeline('9:16'), id);
    expect(plan.assignments).toEqual([]);
    expect(plan.dropped).toBe(1);
  });
});
