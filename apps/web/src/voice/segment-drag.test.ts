import { describe, expect, it } from 'vitest';
import { emptyTimeline, type TimelineDoc } from '@vf/shared';
import { addClip } from '@vf/timeline';
import { dragSegmentEdge } from './segment-drag';

const doc = (): TimelineDoc => {
  let d = addClip(emptyTimeline('9:16'), { id: 'v', kind: 'video', durationSec: 20, hasAudio: false }, { at: 0 }).doc;
  d = {
    ...d,
    segments: [
      { id: 'a', start: 2, end: 6 },
      { id: 'b', start: 8, end: 12 },
    ],
  };
  return d;
};
const seg = (d: TimelineDoc, id: string) => d.segments!.find((s) => s.id === id)!;
const opts = { playhead: 0, pxPerSec: 10, tolerancePx: 8 };

describe('dragSegmentEdge', () => {
  it('moves the end edge freely, frame-rounded', () => {
    const r = dragSegmentEdge(doc(), 'a', 'end', 6.5, opts);
    expect(seg(r.doc, 'a').end).toBeCloseTo(6.5, 5);
    expect(r.snapLine).toBeNull();
  });

  it('snaps to the playhead within 8 px', () => {
    // 10 px/s: 0.7 s = 7 px away
    const r = dragSegmentEdge(doc(), 'a', 'end', 7.2, { ...opts, playhead: 7.9 });
    expect(seg(r.doc, 'a').end).toBeCloseTo(7.9, 1);
    expect(r.snapLine).toBe(7.9);
  });

  it('snaps to clip edges and does not snap beyond tolerance', () => {
    const far = dragSegmentEdge(doc(), 'a', 'start', 3.5, opts);
    expect(far.snapLine).toBeNull();
    expect(seg(far.doc, 'a').start).toBeCloseTo(3.5, 5);
    const near = dragSegmentEdge(doc(), 'a', 'start', 0.5, opts);
    expect(seg(near.doc, 'a').start).toBe(0);
    expect(near.snapLine).toBe(0);
  });

  it('never crosses neighbours', () => {
    const r = dragSegmentEdge(doc(), 'a', 'end', 11, { ...opts, pxPerSec: 1000 });
    expect(seg(r.doc, 'a').end).toBeCloseTo(8, 5);
  });

  it('keeps at least one frame', () => {
    const r = dragSegmentEdge(doc(), 'a', 'end', 1, { ...opts, pxPerSec: 1000 });
    const s = seg(r.doc, 'a');
    expect(s.end - s.start).toBeCloseTo(1 / 30, 5);
  });
});
