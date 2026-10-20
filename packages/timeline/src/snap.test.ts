import { describe, expect, it } from 'vitest';
import { emptyTimeline } from '@vf/shared';
import { addClip, snap, snapTargets } from './index';

const opts = { tolerancePx: 8, pxPerSec: 100 };

describe('snap', () => {
  it('snaps within 8px', () => {
    expect(snap(2.07, [0, 2], opts)).toEqual({ value: 2, target: 2 });
    expect(snap(1.93, [0, 2], opts)).toEqual({ value: 2, target: 2 });
  });

  it('does not snap at 9px', () => {
    expect(snap(2.09, [0, 2], opts)).toEqual({ value: 2.09, target: null });
  });

  it('picks the nearest target', () => {
    expect(snap(1.03, [1, 1.05], opts).target).toBe(1.05);
  });

  it('targets include playhead and 0 and exclude moving clips', () => {
    let n = 0;
    const ids = () => `c${++n}`;
    let r = addClip(emptyTimeline('9:16'), { id: 'a', kind: 'image' }, { at: 1 }, ids);
    const first = r.clipIds[0]!;
    r = addClip(r.doc, { id: 'b', kind: 'image' }, { at: 10 }, ids);
    const targets = snapTargets(r.doc, { playhead: 3.5, exclude: [r.clipIds[0]!] });
    expect(targets).toEqual([0, 1, 3.5, 6]);
    expect(snapTargets(r.doc, { playhead: 0, exclude: [first] })).toEqual([0, 10, 15]);
  });
});
