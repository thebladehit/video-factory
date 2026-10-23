import { describe, expect, it } from 'vitest';
import { emptyTimeline, type TimelineDoc } from '@vf/shared';
import { addClip, setClipTransform, setEffect, setTransition, setVolume, trimEnd, type AssetInfo } from './ops';
import { audioPlan, evaluate, sourceTimeAt } from './evaluate';

let n = 0;
const ids = () => `id${++n}`;
const img = (id: string): AssetInfo => ({ id, kind: 'image' });
const kinds = { A: 'image', B: 'image', V: 'video' } as const;
const add = (doc: TimelineDoc, a: AssetInfo, at: number, trackId?: string) => addClip(doc, a, { at, trackId }, ids);

describe('evaluate', () => {
  const one = add(emptyTimeline('9:16'), img('A'), 1); // [1,6)

  it('gap → []', () => {
    expect(evaluate(one.doc, 0.5, kinds)).toEqual([]);
    expect(evaluate(one.doc, 6, kinds)).toEqual([]);
  });

  it('clip interval is [start, start+duration)', () => {
    expect(evaluate(one.doc, 1, kinds)).toHaveLength(1);
    expect(evaluate(one.doc, 5.99, kinds)).toHaveLength(1);
  });

  it('sourceTime = t - start + in', () => {
    const v = add(emptyTimeline('9:16'), { id: 'V', kind: 'video', durationSec: 10, hasAudio: false }, 2);
    const trimmed = trimEnd(v.doc, v.clipIds[0]!, 5, { V: 10 });
    const doc = {
      ...trimmed,
      tracks: trimmed.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, in: 3 })) })),
    } as TimelineDoc;
    expect(evaluate(doc, 2.5, kinds)[0]).toMatchObject({ kind: 'video', sourceTime: 3.5, clipId: v.clipIds[0] });
  });

  it('kenburns scale at start/middle = 1 / 1.075', () => {
    expect(evaluate(one.doc, 1, kinds)[0]!.scale).toBeCloseTo(1, 9);
    expect(evaluate(one.doc, 3.5, kinds)[0]!.scale).toBeCloseTo(1.075, 9);
    expect(evaluate(one.doc, 3.5, kinds)[0]).toMatchObject({ cx: 0.5, cy: 0.5, fit: 'cover', alpha: 1 });
  });

  it('fade in 0.3: alpha(0.15) = 0.5', () => {
    const doc = setEffect(one.doc, one.clipIds[0]!, { type: 'fade', params: { in: 0.3, out: 0 } });
    expect(evaluate(doc, 1.15, kinds)[0]!.alpha).toBeCloseTo(0.5, 9);
    expect(evaluate(doc, 2, kinds)[0]!.alpha).toBe(1);
  });

  it('fade out ramps to 0 at the end', () => {
    const doc = setEffect(one.doc, one.clipIds[0]!, { type: 'fade', params: { in: 0, out: 1 } });
    expect(evaluate(doc, 5.5, kinds)[0]!.alpha).toBeCloseTo(0.5, 9);
  });

  it('xfade: during overlap the later clip alpha rises 0→1 and both layers are present', () => {
    let doc = add(emptyTimeline('9:16'), img('A'), 0).doc; // [0,5)
    const b = add(doc, img('B'), 5);
    doc = setTransition(b.doc, b.clipIds[0]!, 1); // B [4,9)
    const mid = evaluate(doc, 4.5, kinds);
    expect(mid.map((l) => l.assetId)).toEqual(['A', 'B']);
    expect(mid[1]!.alpha).toBeCloseTo(0.5, 9);
    expect(evaluate(doc, 4, kinds)[1]!.alpha).toBeCloseTo(0, 9);
    expect(evaluate(doc, 5.5, kinds).map((l) => [l.assetId, l.alpha])).toEqual([['B', 1]]);
  });

  it('layer order = track order', () => {
    let doc = add(emptyTimeline('9:16'), img('A'), 0).doc;
    doc = { ...doc, tracks: [...doc.tracks, { id: 'top', kind: 'video', clips: [] }] };
    doc = add(doc, img('B'), 0, 'top').doc;
    expect(evaluate(doc, 1, kinds).map((l) => l.assetId)).toEqual(['A', 'B']);
  });

  it('layer carries clip transform', () => {
    const t = { scale: 0.5, x: 0.2, y: 0.8 };
    expect(evaluate(one.doc, 2, kinds)[0]!.transform).toBeUndefined();
    const doc = setClipTransform(one.doc, one.clipIds[0]!, t);
    expect(evaluate(doc, 2, kinds)[0]!.transform).toEqual(t);
  });

  it('skips clips whose asset kind is unknown (missing file)', () => {
    expect(evaluate(one.doc, 2, {})).toEqual([]);
  });
});

describe('audioPlan', () => {
  it('includes video clip with volume 0.5 and excludes volume 0', () => {
    const v = add(emptyTimeline('9:16'), { id: 'V', kind: 'video', durationSec: 4, hasAudio: true }, 1);
    // зв'язане аудіо (volume 1) є, відео (volume 0) — ні
    expect(audioPlan(v.doc).map((a) => a.clipId)).toEqual([v.clipIds[1]]);
    const loud = setVolume(v.doc, v.clipIds[0]!, 0.5);
    expect(audioPlan(loud)).toContainEqual({
      clipId: v.clipIds[0],
      assetId: 'V',
      start: 1,
      in: 0,
      duration: 4,
      volume: 0.5,
      fadeIn: 0,
      fadeOut: 0,
      speed: 1,
      hold: 0,
      envelope: [],
    });
  });

  it('photos have no sound', () => {
    expect(audioPlan(add(emptyTimeline('9:16'), img('A'), 0).doc)).toEqual([]);
  });

  it('audio clip fades are passed through', () => {
    const s = add(emptyTimeline('9:16'), { id: 'S', kind: 'audio', durationSec: 8 }, 0);
    const doc = {
      ...s.doc,
      tracks: s.doc.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, fadeIn: 1, fadeOut: 2 })) })),
    } as TimelineDoc;
    expect(audioPlan(doc)[0]).toMatchObject({ fadeIn: 1, fadeOut: 2, volume: 1, duration: 8 });
  });
});

describe('clip speed / hold', () => {
  const clip = { start: 2, duration: 5, in: 1 };
  it('sourceTimeAt without speed/hold = in + (t - start)', () => {
    expect(sourceTimeAt(clip, 3)).toBeCloseTo(2, 9);
  });
  it('speed 0.8 scales source progress', () => {
    expect(sourceTimeAt({ ...clip, speed: 0.8 }, 4)).toBeCloseTo(1 + 2 * 0.8, 9);
  });
  it('hold freezes on the last source frame', () => {
    const c = { ...clip, speed: 0.8, hold: 0.5 };
    const last = 1 + 4.5 * 0.8;
    expect(sourceTimeAt(c, 6.5)).toBeCloseTo(last, 9);
    expect(sourceTimeAt(c, 6.9)).toBeCloseTo(last, 9);
  });
  it('evaluate uses sourceTimeAt', () => {
    const a = addClip(
      emptyTimeline('9:16'),
      { id: 'V', kind: 'video', durationSec: 10, hasAudio: false },
      { at: 0 },
      ids,
    );
    const doc = {
      ...a.doc,
      tracks: a.doc.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, speed: 1.25, hold: 1 })) })),
    } as TimelineDoc;
    expect(evaluate(doc, 2, kinds)[0]!.sourceTime).toBeCloseTo(2.5, 9);
    expect(evaluate(doc, 4.5, kinds)[0]!.sourceTime).toBeCloseTo(4.5 * 1.25, 9);
    expect(evaluate(doc, 9.5, kinds)[0]!.sourceTime).toBeCloseTo(9 * 1.25, 9);
  });
  it('audioPlan defaults and carries speed/hold/envelope', () => {
    const m = addClip(emptyTimeline('9:16'), { id: 'M', kind: 'audio', durationSec: 4 }, { at: 0 }, ids);
    expect(audioPlan(m.doc)[0]).toMatchObject({ speed: 1, hold: 0, envelope: [] });
    const env = [
      { t: 0, gain: 1 },
      { t: 1, gain: 0.08 },
    ];
    const doc = {
      ...m.doc,
      tracks: m.doc.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => ({ ...c, speed: 1.1, hold: 0.5, envelope: env })),
      })),
    } as TimelineDoc;
    expect(audioPlan(doc)[0]).toMatchObject({ speed: 1.1, hold: 0.5, envelope: env });
  });
});
