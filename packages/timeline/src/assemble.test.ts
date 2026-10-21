import { describe, expect, it } from 'vitest';
import { normalizeDoc, timelineDocSchema, type AudioClip, type MediaClip, type TimelineDoc } from '@vf/shared';
import {
  assembleTimeline,
  docDuration,
  estimateSceneSec,
  localize,
  quantize,
  replaceSegmentVisual,
  skeletonDoc,
  LEAD,
  TAIL,
  type AssembleScene,
  type SceneVisual,
} from './index';

const FPS = 30;
const seq = () => {
  let i = 0;
  return () => `n${++i}`;
};
const photo = (assetId = 'p', width = 1080, height = 1920): SceneVisual => ({ assetId, kind: 'image', width, height });
const scene = (n: number, extra: Partial<AssembleScene> = {}): AssembleScene => ({
  segmentId: `s${n}`,
  estimatedSec: 3,
  baseVoiceSec: null,
  visual: photo(`p${n}`),
  ...extra,
});
const build = (scenes: AssembleScene[], music: { assetId: string; durationSec: number } | null = null, format: '9:16' | '16:9' = '9:16') =>
  assembleTimeline({ format, fps: FPS, scenes, music }, seq());
const vclips = (doc: TimelineDoc) => {
  const t = doc.tracks.find((x) => x.kind === 'video');
  return (t?.kind === 'video' ? t.clips : []) as MediaClip[];
};
const musicClips = (doc: TimelineDoc) => {
  const t = doc.tracks.find((x) => x.kind === 'audio' && x.role === 'music');
  return (t?.kind === 'audio' ? t.clips : []) as AudioClip[];
};
const seg = (doc: TimelineDoc, id: string) => doc.segments!.find((s) => s.id === id)!;

describe('estimateSceneSec', () => {
  it('is LEAD + chars/15 + TAIL', () => {
    expect(estimateSceneSec('x'.repeat(30))).toBeCloseTo(LEAD + 2 + TAIL, 9);
  });
});

describe('assembleTimeline durations', () => {
  it('scene with voice 3.0 s lasts quantize(0.15+3.0+0.35)=3.5 s; scene without voice uses quantize(estimatedSec)', () => {
    const doc = build([scene(1, { baseVoiceSec: 3.0 }), scene(2, { estimatedSec: 2.52 })]);
    expect(seg(doc, 's1')).toEqual({ id: 's1', start: 0, end: 3.5 });
    expect(seg(doc, 's2').end - seg(doc, 's2').start).toBeCloseTo(quantize(2.52, FPS), 9);
  });

  it('segments are contiguous from 0 and on the frame grid', () => {
    const doc = build([scene(1, { baseVoiceSec: 2.07 }), scene(2, { estimatedSec: 1.234 }), scene(3, { baseVoiceSec: 0.4 })]);
    const segs = doc.segments!;
    expect(segs[0]!.start).toBe(0);
    segs.forEach((s, i) => {
      if (i > 0) expect(s.start).toBeCloseTo(segs[i - 1]!.end, 9);
      expect(s.start * FPS).toBeCloseTo(Math.round(s.start * FPS), 6);
      expect(s.end * FPS).toBeCloseTo(Math.round(s.end * FPS), 6);
    });
  });

  it('localize of assembled doc for base takes gives speed 1 and hold 0 in every voiced segment', () => {
    const voices = [3.0, 1.37, 5.21];
    const doc = build(voices.map((v, i) => scene(i + 1, { baseVoiceSec: v })));
    const { fits } = localize(doc, {
      language: 'uk',
      takes: voices.map((v, i) => ({ segmentId: `s${i + 1}`, assetId: `a${i}`, durationSec: v, transcriptId: `t${i}` })),
      original: { mode: 'replace', level: 1, duckLevel: 0.2 },
      captions: null,
      newId: seq(),
    });
    expect(fits).toHaveLength(3);
    for (const f of fits) {
      expect(f.speed).toBe(1);
      expect(f.hold).toBe(0);
      expect(f.trimmed).toBe(0);
    }
  });

  it('last scene blank keeps docDuration equal to sum of segments', () => {
    const blank: SceneVisual = { ...photo('blank'), blank: true };
    const doc = build([scene(1, { baseVoiceSec: 2 }), scene(2, { estimatedSec: 4, visual: blank })]);
    const last = doc.segments![doc.segments!.length - 1]!;
    expect(docDuration(doc)).toBeCloseTo(last.end, 9);
    expect(docDuration(doc)).toBeCloseTo(seg(doc, 's1').end + 4, 9);
    const all = build([scene(1, { visual: blank }), scene(2, { visual: blank })]);
    expect(docDuration(all)).toBeCloseTo(6, 9);
  });

  it('outputs pass normalizeDoc / timelineDocSchema', () => {
    const doc = build(
      [scene(1, { baseVoiceSec: 2 }), scene(2, { visual: { assetId: 'v', kind: 'video', durationSec: 1.5, width: 1080, height: 1920 } })],
      { assetId: 'm', durationSec: 2 },
    );
    expect(() => normalizeDoc(doc)).not.toThrow();
    expect(timelineDocSchema.safeParse(doc).success).toBe(true);
    expect(timelineDocSchema.safeParse(skeletonDoc('16:9', FPS, [{ segmentId: 'a', estimatedSec: 3 }])).success).toBe(true);
  });
});

describe('assembleTimeline visuals', () => {
  it('photo gets kenburns 1→1.15 on even index and 1.15→1 on odd, focus x 0.4/0.6', () => {
    const doc = build([scene(1), scene(2)]);
    const [a, b] = vclips(doc);
    expect(a!.effects).toEqual([
      { type: 'kenburns', params: { fromScale: 1, toScale: 1.15, fromX: 0.4, toX: 0.4, fromY: 0.5, toY: 0.5 } },
    ]);
    expect(b!.effects).toEqual([
      { type: 'kenburns', params: { fromScale: 1.15, toScale: 1, fromX: 0.6, toX: 0.6, fromY: 0.5, toY: 0.5 } },
    ]);
    expect(a).toMatchObject({ start: 0, duration: 3, in: 0 });
  });

  it('blank visual gets no effects', () => {
    const doc = build([scene(1, { visual: { ...photo('blank'), blank: true } })]);
    expect(vclips(doc)[0]!.effects).toEqual([]);
  });

  it('video 10 s in 3.5 s scene → one clip in=0 duration 3.5', () => {
    const doc = build([scene(1, { baseVoiceSec: 3, visual: { assetId: 'v', kind: 'video', durationSec: 10, width: 1080, height: 1920 } })]);
    const cs = vclips(doc);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ in: 0, duration: 3.5, start: 0 });
  });

  it('video 1.5 s in 3.5 s scene → clips 1.5+1.5+0.5', () => {
    const doc = build([scene(1, { baseVoiceSec: 3, visual: { assetId: 'v', kind: 'video', durationSec: 1.5, width: 1080, height: 1920 } })]);
    const cs = vclips(doc);
    expect(cs.map((c) => c.duration)).toEqual([1.5, 1.5, 0.5]);
    expect(cs.map((c) => c.start)).toEqual([0, 1.5, 3]);
    expect(cs.every((c) => c.in === 0)).toBe(true);
  });

  it('remainder shorter than a frame is dropped', () => {
    // 0.7 s clips exactly fill a 3.5 s scene: no zero-length sixth clip
    const exact = build([scene(1, { baseVoiceSec: 3, visual: { assetId: 'v', kind: 'video', durationSec: 0.7, width: 1080, height: 1920 } })]);
    expect(vclips(exact).map((c) => c.duration)).toEqual([0.7, 0.7, 0.7, 0.7, 0.7]);
    // unaligned source length: 1.49 s → 44 frames; sub-frame leftover never becomes a clip
    const odd = build([scene(1, { baseVoiceSec: 3, visual: { assetId: 'v', kind: 'video', durationSec: 1.49, width: 1080, height: 1920 } })]);
    for (const c of vclips(odd)) expect(c.duration).toBeGreaterThanOrEqual(1 / FPS - 1e-9);
    expect(docDuration(odd)).toBeCloseTo(3.5, 9);
  });

  it('video clips have volume 0 and no linked audio', () => {
    const doc = build([scene(1, { visual: { assetId: 'v', kind: 'video', durationSec: 1, width: 1080, height: 1920 } })]);
    for (const c of vclips(doc)) {
      expect(c.volume).toBe(0);
      expect(c.linkId).toBeUndefined();
    }
    expect(doc.tracks.filter((t) => t.kind === 'audio')).toHaveLength(0);
  });

  it('square image in 9:16 → contain; 1080×1920 → cover; 1920×1080 in 9:16 → contain', () => {
    const doc = build([
      scene(1, { visual: photo('a', 1000, 1000) }),
      scene(2, { visual: photo('b', 1080, 1920) }),
      scene(3, { visual: photo('c', 1920, 1080) }),
    ]);
    expect(vclips(doc).map((c) => c.fit)).toEqual(['contain', 'cover', 'contain']);
    const wide = build([scene(1, { visual: photo('a', 1920, 1080) }), scene(2, { visual: photo('b', 1080, 1920) })], null, '16:9');
    expect(vclips(wide).map((c) => c.fit)).toEqual(['cover', 'contain']);
  });
});

describe('assembleTimeline music', () => {
  const scenes = () => [scene(1, { estimatedSec: 10 }), scene(2, { estimatedSec: 10 })];

  it('music 100 s on 20 s doc → one clip 20 s, volume 0.15, fadeOut 1.5', () => {
    const cs = musicClips(build(scenes(), { assetId: 'm', durationSec: 100 }));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ assetId: 'm', start: 0, duration: 20, in: 0, volume: 0.15, fadeOut: 1.5 });
  });

  it('music 8 s on 20 s doc → clips 8+8+4, fadeOut only on last', () => {
    const cs = musicClips(build(scenes(), { assetId: 'm', durationSec: 8 }));
    expect(cs.map((c) => c.duration)).toEqual([8, 8, 4]);
    expect(cs.map((c) => c.start)).toEqual([0, 8, 16]);
    expect(cs.map((c) => c.fadeOut)).toEqual([undefined, undefined, 1.5]);
    expect(cs.every((c) => c.volume === 0.15)).toBe(true);
  });

  it('music shorter than a frame → no music track', () => {
    const doc = build(scenes(), { assetId: 'm', durationSec: 0.01 });
    expect(doc.tracks.some((t) => t.kind === 'audio')).toBe(false);
    expect(() => normalizeDoc(doc)).not.toThrow();
  });

  it('non-finite music duration → no music track', () => {
    const doc = build(scenes(), { assetId: 'm', durationSec: Number.NaN });
    expect(doc.tracks.some((t) => t.kind === 'audio')).toBe(false);
  });
});

describe('skeletonDoc', () => {
  it('has segments only and no clips', () => {
    const doc = skeletonDoc('16:9', FPS, [
      { segmentId: 'a', estimatedSec: 2.5 },
      { segmentId: 'b', estimatedSec: 4 },
    ]);
    expect(doc.tracks).toEqual([]);
    expect(doc.segments).toEqual([
      { id: 'a', start: 0, end: 2.5 },
      { id: 'b', start: 2.5, end: 6.5 },
    ]);
    expect([doc.width, doc.height]).toEqual([1920, 1080]);
  });
});

describe('replaceSegmentVisual', () => {
  const base = () =>
    build([
      scene(1, { baseVoiceSec: 3 }),
      scene(2, { baseVoiceSec: 2 }),
      scene(3, { estimatedSec: 3 }),
    ]);

  it("swaps photo for video inside segment only, other segments' clips unchanged", () => {
    const doc = base();
    const before = vclips(doc);
    const video: SceneVisual = { assetId: 'vid', kind: 'video', durationSec: 1, width: 1080, height: 1920 };
    const out = replaceSegmentVisual(doc, 's2', video, 1, seq());
    const after = vclips(out);
    const s2 = seg(doc, 's2');
    expect(after.filter((c) => c.start < s2.start - 1e-9)).toEqual(before.filter((c) => c.start < s2.start - 1e-9));
    expect(after.filter((c) => c.start >= s2.end - 1e-9)).toEqual(before.filter((c) => c.start >= s2.end - 1e-9));
    const inside = after.filter((c) => c.start >= s2.start - 1e-9 && c.start < s2.end - 1e-9);
    expect(inside.every((c) => c.assetId === 'vid' && c.volume === 0)).toBe(true);
    expect(inside.reduce((a, c) => a + c.duration, 0)).toBeCloseTo(s2.end - s2.start, 9);
    expect(docDuration(out)).toBe(docDuration(doc));
    expect(out.segments).toEqual(doc.segments);
    expect(() => normalizeDoc(out)).not.toThrow();
  });

  it('uses sceneIndex for kenburns alternation and does not mutate input', () => {
    const doc = base();
    const snapshot = JSON.stringify(doc);
    const out = replaceSegmentVisual(doc, 's1', photo('new'), 1, seq());
    expect(vclips(out)[0]!.effects[0]).toMatchObject({ params: { fromScale: 1.15, toScale: 1, fromX: 0.6 } });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('works on a skeleton doc without video track', () => {
    const sk = skeletonDoc('9:16', FPS, [{ segmentId: 'a', estimatedSec: 2 }]);
    const out = replaceSegmentVisual(sk, 'a', photo('x'), 0, seq());
    expect(vclips(out)).toHaveLength(1);
    expect(docDuration(out)).toBe(2);
  });

  it('on missing segment returns the same doc', () => {
    const doc = base();
    expect(replaceSegmentVisual(doc, 'nope', photo('x'), 0, seq())).toBe(doc);
  });
});
