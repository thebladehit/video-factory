import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORIGINAL,
  normalizeDoc,
  type AudioClip,
  type CaptionClip,
  type MediaClip,
  type Segment,
  type TimelineDoc,
  type Track,
} from '@vf/shared';
import { clipFades, clipTransform, fitSegment, localize, type LocalizeOptions, type VoiceTake } from './index';

const seq = () => {
  let i = 0;
  return () => `n${++i}`;
};

const KB = { fromScale: 1, toScale: 1.4, fromX: 0.3, fromY: 0.5, toX: 0.7, toY: 0.6 };

function mkDoc(fps: number, tracks: Track[], segments?: Segment[]): TimelineDoc {
  return normalizeDoc({ schemaVersion: 1, width: 1080, height: 1920, fps, tracks, ...(segments ? { segments } : {}) });
}
const video = (id: string, start: number, duration: number, extra: Partial<MediaClip> = {}): MediaClip => ({
  id,
  assetId: `asset-${id}`,
  start,
  duration,
  in: 0,
  fit: 'cover',
  effects: [],
  ...extra,
});
const sound = (id: string, start: number, duration: number, extra: Partial<AudioClip> = {}): AudioClip => ({
  id,
  assetId: `asset-${id}`,
  start,
  duration,
  in: 0,
  volume: 1,
  ...extra,
});
const vTrack = (id: string, clips: MediaClip[]): Track => ({ id, kind: 'video', clips });
const aTrack = (id: string, role: 'original' | 'music' | 'sfx' | 'voiceover', clips: AudioClip[]): Track => ({
  id,
  kind: 'audio',
  role,
  clips,
});
const take = (segmentId: string, durationSec: number): VoiceTake => ({
  segmentId,
  assetId: `voice-${segmentId}`,
  durationSec,
  transcriptId: `tr-${segmentId}`,
});
const opts = (takes: VoiceTake[], extra: Partial<LocalizeOptions> = {}): LocalizeOptions => ({
  language: 'en',
  takes,
  original: { ...DEFAULT_ORIGINAL },
  captions: null,
  newId: seq(),
  ...extra,
});

const clipsOf = (doc: TimelineDoc, trackId: string) =>
  [...((doc.tracks.find((t) => t.id === trackId)?.clips ?? []) as (MediaClip | AudioClip)[])].sort(
    (a, b) => a.start - b.start,
  );
const kbParams = (c: MediaClip) => c.effects.find((e) => e.type === 'kenburns')!.params as typeof KB;
const xfadeOf = (c: MediaClip) => (c.effects.find((e) => e.type === 'xfade')?.params as { duration: number })?.duration;

/** Документ валідний, без `segments`, усі часи на сітці кадрів, відтворення кожного кліпа ≥ 1 кадр. */
function expectValid(doc: TimelineDoc) {
  expect(doc).not.toHaveProperty('segments');
  expect(normalizeDoc(doc)).toEqual(doc);
  const frame = 1 / doc.fps;
  const onGrid = (t: number) => expect(Math.abs(t * doc.fps - Math.round(t * doc.fps))).toBeLessThan(1e-6);
  for (const track of doc.tracks) {
    if (track.kind === 'captions') continue;
    for (const c of track.clips as (MediaClip | AudioClip)[]) {
      onGrid(c.start);
      onGrid(c.duration);
      onGrid(c.hold ?? 0);
      expect(c.duration - (c.hold ?? 0)).toBeGreaterThanOrEqual(frame - 1e-9);
    }
  }
}

describe('fitSegment', () => {
  it('voice slightly longer → slow down to 0.8, no hold', () => {
    expect(fitSegment(4, 4.5, 30)).toMatchObject({ base: 4, target: 5, speed: 0.8, used: 4, hold: 0, trimmed: 0 });
  });
  it('voice much longer → 0.8 + freeze frame', () => {
    const f = fitSegment(4, 6, 30);
    expect(f.speed).toBe(0.8);
    expect(f.hold).toBeCloseTo(1.5, 9);
    expect(f.target).toBeCloseTo(6.5, 9);
  });
  it('voice much shorter → 1.25 and trimmed tail', () => {
    // 4,375 с = 175 кадрів при 40 fps; при 30 fps `used` округлюється вниз до кадру (131/30)
    const f = fitSegment(10, 3, 40);
    expect(f.speed).toBe(1.25);
    expect(f.used).toBeCloseTo(4.375, 9);
    expect(f.trimmed).toBeCloseTo(5.625, 9);
    expect(fitSegment(10, 3, 30).used).toBeCloseTo(131 / 30, 9);
  });
  it('in-range speed → whole segment, no trim or hold (fix r1 #2)', () => {
    expect(fitSegment(29 / 24, 0.5, 24)).toMatchObject({ trimmed: 0, hold: 0, used: 29 / 24 });
    for (const fps of [20, 24, 25, 30, 60])
      for (let f = 1; f <= fps * 30; f += 7) {
        const D = f / fps;
        for (let V = 0.3; V < 40; V += 0.173) {
          const r = fitSegment(D, V, fps);
          if (D / r.target >= 0.8 && D / r.target <= 1.25) {
            expect(r.trimmed).toBe(0);
            expect(r.hold).toBe(0);
            expect(r.used).toBe(D);
          }
          expect(r.target - r.hold).toBeGreaterThanOrEqual(1 / fps - 1e-9);
        }
      }
  });
  it('no voice → unchanged', () => {
    expect(fitSegment(4, null, 30)).toEqual({ base: 4, target: 4, speed: 1, used: 4, hold: 0, trimmed: 0 });
  });
  it('one-frame segment with long voice (Review Focus 5)', () => {
    const f = fitSegment(1 / 30, 3, 30);
    expect(f.target).toBeCloseTo(3.5, 9);
    expect(f.speed).toBe(0.8);
    expect(f.used).toBeCloseTo(1 / 30, 9);
    expect(f.hold).toBeGreaterThan(0);
    // кадр відтворення + стоп-кадр = ціль, усе на сітці
    expect(f.target - f.hold).toBeCloseTo(1 / 30, 9);
    expect(Math.abs(f.hold * 30 - Math.round(f.hold * 30))).toBeLessThan(1e-6);
  });
});

describe('localize — time map', () => {
  // 20 fps: LEAD 0,15 = 3 кадри; s1 [0,4] V=4.5 → 5 с (×0,8); проміжок [4,6]; s2 [6,8] V=1.1 → 1,6 с (×1,25)
  const base = mkDoc(
    20,
    [vTrack('V', [video('v', 0, 10)])],
    [
      { id: 's1', start: 0, end: 4 },
      { id: 's2', start: 6, end: 8 },
    ],
  );
  const out = localize(base, opts([take('s1', 4.5), take('s2', 1.1)]));

  it('gap shifts by the first segment difference; map(segStart) = language segment start', () => {
    expect(out.map(0)).toBe(0);
    expect(out.map(4)).toBeCloseTo(5, 9);
    expect(out.map(5)).toBeCloseTo(6, 9);
    expect(out.map(6)).toBeCloseTo(7, 9);
    expect(out.map(8)).toBeCloseTo(8.6, 9);
    expect(out.map(10)).toBeCloseTo(10.6, 9);
    expect(out.fits.map((f) => [f.segmentId, f.speed, f.target])).toEqual([
      ['s1', 0.8, 5],
      ['s2', 1.25, 1.6],
    ]);
  });

  it('map is monotone', () => {
    let prev = -Infinity;
    for (let t = 0; t <= 12; t += 0.01) {
      const v = out.map(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('video is cut at segment bounds with per-region speed', () => {
    const v = clipsOf(out.doc, 'V') as MediaClip[];
    expect(v.map((c) => [c.start, c.duration, c.in, c.speed])).toEqual([
      [0, 5, 0, 0.8],
      [5, 2, 4, undefined],
      [7, 1.6, 6, 1.25],
      [8.6, 2, 8, undefined],
    ]);
    expect(v[0]!.id).toBe('v');
    expectValid(out.doc);
  });
});

describe('localize — clip across a segment boundary', () => {
  // s1 [0,4] V=4.5 → ×0,8, 5 с; s2 [4,8] V=1.9 → T=2,4, ×1,25, used 3, хвіст [7,8] обрізано
  const segs = [
    { id: 's1', start: 0, end: 4 },
    { id: 's2', start: 4, end: 8 },
  ];
  const base = mkDoc(
    20,
    [
      vTrack('V', [video('v', 0, 7, { volume: 0, linkId: 'L' }), video('w', 7, 1)]),
      aTrack('O', 'original', [sound('o', 0, 7, { linkId: 'L' })]),
    ],
    segs,
  );
  const out = localize(base, opts([take('s1', 4.5), take('s2', 1.9)]));

  it('splits video into pieces with different speeds; second in = end of used source of the first', () => {
    const v = clipsOf(out.doc, 'V') as MediaClip[];
    expect(v).toHaveLength(2);
    const [a, b] = v as [MediaClip, MediaClip];
    expect([a.start, a.duration, a.speed]).toEqual([0, 5, 0.8]);
    expect([b.start, b.duration, b.speed]).toEqual([5, 2.4, 1.25]);
    expect(b.in).toBeCloseTo(a.in + (a.duration - (a.hold ?? 0)) * a.speed!, 9);
    expect(b.in).toBeCloseTo(4, 9);
  });

  it('linked original is split the same way, link pairs kept', () => {
    const v = clipsOf(out.doc, 'V') as MediaClip[];
    const o = clipsOf(out.doc, 'O') as AudioClip[];
    expect(o.map((c) => [c.start, c.duration, c.in, c.speed])).toEqual(
      v.map((c) => [c.start, c.duration, c.in, c.speed]),
    );
    expect(o.map((c) => c.linkId)).toEqual(v.map((c) => c.linkId));
    expect(new Set(v.map((c) => c.linkId)).size).toBe(2);
    expect(v[0]!.linkId).toBe('L');
  });

  it('pieces in the trimmed tail are removed', () => {
    expect(clipsOf(out.doc, 'V').some((c) => c.id === 'w')).toBe(false);
    expectValid(out.doc);
  });
});

describe('localize — effects (Review Focus 1)', () => {
  const segs = [
    { id: 's1', start: 0, end: 4 },
    { id: 's2', start: 4, end: 8 },
  ];
  it('Ken Burns pieces match the base law at piece bounds; fade in first, out last', () => {
    const base = mkDoc(
      20,
      [
        vTrack('V', [
          video('p', 0, 8, {
            effects: [
              { type: 'kenburns', params: KB },
              { type: 'fade', params: { in: 0.5, out: 0.5 } },
            ],
          }),
        ]),
      ],
      segs,
    );
    const out = localize(base, opts([take('s1', 4.5), take('s2', 1.9)]));
    const law = clipTransform((base.tracks[0]!.clips[0] as MediaClip).effects);
    const pieces = clipsOf(out.doc, 'V') as MediaClip[];
    expect(pieces).toHaveLength(2);
    const bounds = [
      [0, 4 / 8],
      [4 / 8, 7 / 8],
    ];
    pieces.forEach((c, i) => {
      const tr = clipTransform(c.effects);
      const [p0, p1] = bounds[i]!;
      for (const k of ['scale', 'cx', 'cy'] as const) {
        expect(Math.abs(tr[k].at(0) - law[k].at(p0!))).toBeLessThan(1e-6);
        expect(Math.abs(tr[k].at(1) - law[k].at(p1!))).toBeLessThan(1e-6);
      }
    });
    expect(clipFades(pieces[0]!.effects)).toEqual({ fadeIn: 0.5, fadeOut: 0 });
    expect(clipFades(pieces[1]!.effects)).toEqual({ fadeIn: 0, fadeOut: 0.5 });
    expect(kbParams(pieces[1]!).fromScale).toBeCloseTo(1.2, 6);
    expectValid(out.doc);
  });

  it('zoom is kept unchanged on every piece', () => {
    const zoom = { type: 'zoom' as const, params: { scale: 1.3, x: 0.4, y: 0.6 } };
    const base = mkDoc(20, [vTrack('V', [video('p', 0, 8, { effects: [zoom] })])], segs);
    const out = localize(base, opts([take('s1', 4.5), take('s2', 1.9)]));
    for (const c of clipsOf(out.doc, 'V') as MediaClip[]) expect(c.effects).toEqual([zoom]);
  });

  it('xfade across a segment boundary is trimmed to the boundary', () => {
    // 40 fps; s1 [0,4.5] V=5.125 → T=5,625, ×0,8; A [0,5], B [4,8] з xfade 1 → межа 4,5 посеред переходу
    const base = mkDoc(
      40,
      [vTrack('V', [video('A', 0, 5), video('B', 4, 4, { effects: [{ type: 'xfade', params: { duration: 1 } }] })])],
      [{ id: 's1', start: 0, end: 4.5 }],
    );
    const out = localize(base, opts([take('s1', 5.125)]));
    const v = clipsOf(out.doc, 'V') as MediaClip[];
    const a = v.filter((c) => c.assetId === 'asset-A');
    const b = v.filter((c) => c.assetId === 'asset-B');
    expect(a.map((c) => [c.start, c.duration])).toEqual([[0, 5.625]]);
    expect(b.map((c) => [c.start, c.duration])).toEqual([
      [5, 0.625],
      [5.625, 3.5],
    ]);
    expect(xfadeOf(b[0]!)).toBeCloseTo(0.625, 9);
    expect(xfadeOf(b[1]!)).toBeUndefined();
    expectValid(out.doc);
  });

  it('xfade inside one segment is kept (stretched with the segment)', () => {
    // s1 [0,8] V=9.5 → T=10, ×0,8
    const base = mkDoc(
      20,
      [vTrack('V', [video('A', 0, 5), video('B', 4, 4, { effects: [{ type: 'xfade', params: { duration: 1 } }] })])],
      [{ id: 's1', start: 0, end: 8 }],
    );
    const out = localize(base, opts([take('s1', 9.5)]));
    const [a, b] = clipsOf(out.doc, 'V') as [MediaClip, MediaClip];
    expect([a.start, a.duration, b.start, b.duration]).toEqual([0, 6.25, 5, 5]);
    expect(xfadeOf(b)).toBeCloseTo(1.25, 9);
    expect(a.start + a.duration - b.start).toBeCloseTo(xfadeOf(b), 9);
  });
});

describe('localize — hold, short segments, music', () => {
  it('photo in a segment with hold is simply longer (Review Focus 5)', () => {
    // s1 [0,2] V=3 → T=3,5, ×0,8 → 2,5 с відтворення + 1 с стоп-кадру
    const base = mkDoc(
      20,
      [vTrack('V', [video('p', 0, 2, { effects: [{ type: 'kenburns', params: KB }] })])],
      [{ id: 's1', start: 0, end: 2 }],
    );
    const out = localize(base, opts([take('s1', 3)]));
    const [p] = clipsOf(out.doc, 'V') as [MediaClip];
    expect([p.start, p.duration, p.in, p.hold]).toEqual([0, 3.5, 0, 1]);
    expect(kbParams(p)).toMatchObject({ fromScale: 1, toScale: 1.4 });
    expectValid(out.doc);
  });

  it('one-frame segment with long voice → valid doc with freeze frame (Review Focus 5)', () => {
    const base = mkDoc(30, [vTrack('V', [video('v', 0, 3)])], [{ id: 's1', start: 1, end: 1 + 1 / 30 }]);
    const out = localize(base, opts([take('s1', 3)]));
    expectValid(out.doc);
    const v = clipsOf(out.doc, 'V') as MediaClip[];
    expect(v).toHaveLength(3);
    const mid = v[1]!;
    expect(mid.start).toBeCloseTo(1, 9);
    expect(mid.duration).toBeCloseTo(3.5, 9);
    expect(mid.hold).toBeCloseTo(3.5 - 1 / 30, 9);
    expect(v[2]!.start).toBeCloseTo(4.5, 9);
    expect(v[2]!.in).toBeCloseTo(1 + 1 / 30, 9);
  });

  it('music keeps positions and is cut at the new duration', () => {
    // 40 fps; s1 [0,10] V=3 → T=3,5, ×1,25, used 4,375; нова тривалість 12 − 6,5 = 5,5
    const base = mkDoc(
      40,
      [
        vTrack('V', [video('v', 0, 10)]),
        aTrack('M', 'music', [sound('m', 2, 10, { fadeOut: 1 }), sound('late', 6, 2)]),
      ],
      [{ id: 's1', start: 0, end: 10 }],
    );
    const out = localize(base, opts([take('s1', 3)]));
    const v = clipsOf(out.doc, 'V') as MediaClip[];
    expect(v.map((c) => [c.start, c.duration, c.speed])).toEqual([[0, 3.5, 1.25]]);
    const m = clipsOf(out.doc, 'M') as AudioClip[];
    expect(m.map((c) => [c.id, c.start, c.duration, c.fadeOut])).toEqual([['m', 2, 3.5, 1]]);
    expectValid(out.doc);
  });
});

describe('localize — own video sound (fix r1 #3)', () => {
  it('video with own sound under duck → linked original clip with envelope under the voice; fades carried', () => {
    const base = mkDoc(
      20,
      [vTrack('V', [video('v', 0, 8, { volume: 1, effects: [{ type: 'fade', params: { in: 0.5, out: 1 } }] })])],
      [{ id: 's1', start: 0, end: 4 }],
    );
    const out = localize(base, opts([take('s1', 4.5)]));
    const v = out.doc.tracks.find((t) => t.kind === 'video')!.clips as MediaClip[];
    const orig = out.doc.tracks.find((t) => t.kind === 'audio' && t.role === 'original')!.clips as AudioClip[];
    for (const c of v) expect(c.volume).toBe(0);
    expect(orig.map((c) => [c.start, c.duration, c.volume, c.fadeIn, c.fadeOut])).toEqual([
      [0, 5, 0.25, 0.5, undefined],
      [5, 4, 0.25, undefined, 1],
    ]);
    expect(orig.map((c) => c.linkId)).toEqual(v.map((c) => c.linkId));
    expect(Math.min(...orig[0]!.envelope!.map((p) => p.gain))).toBeCloseTo(0.08 / 0.25, 9);
    expectValid(out.doc);
  });

  it('replace mutes the materialized original clip', () => {
    const base = mkDoc(20, [vTrack('V', [video('v', 0, 8, { volume: 1 })])], [{ id: 's1', start: 0, end: 4 }]);
    const out = localize(
      base,
      opts([take('s1', 4.5)], { original: { mode: 'replace', level: 0.25, duckLevel: 0.08 } }),
    );
    const orig = out.doc.tracks.find((t) => t.kind === 'audio' && t.role === 'original')!.clips as AudioClip[];
    expect(orig.length).toBeGreaterThan(0);
    for (const c of orig) expect(c.volume).toBe(0);
  });
});

describe('localize — adjacent segments after a freeze frame (fix r1 #1)', () => {
  it('next voice starts after the hold; voices do not overlap; map(s2.start) = s2 language start', () => {
    // 20 fps; s1 [0,4] V=6 → T=6,5 (×0,8: 5 с + 1,5 с стоп-кадру); s2 [4,8] V=3 → T=3,5
    const base = mkDoc(
      20,
      [vTrack('V', [video('v', 0, 8)])],
      [
        { id: 's1', start: 0, end: 4 },
        { id: 's2', start: 4, end: 8 },
      ],
    );
    const out = localize(base, opts([take('s1', 6), take('s2', 3)], { captions: { enabled: true, styleId: 'st' } }));
    expect(out.map(4)).toBeCloseTo(6.5, 9);
    const voice = out.doc.tracks.find((t) => t.kind === 'audio' && t.role === 'voiceover')!.clips as AudioClip[];
    expect(voice.map((c) => c.start)).toEqual([0.15, 6.65]);
    expect(voice[0]!.start + voice[0]!.duration).toBeLessThanOrEqual(voice[1]!.start);
    const v = clipsOf(out.doc, 'V') as MediaClip[];
    expect(v.map((c) => [c.start, c.duration, c.hold])).toEqual([
      [0, 6.5, 1.5],
      [6.5, 3.5, undefined],
    ]);
    expectValid(out.doc);
  });
});

describe('localize — voiceover, original sound, captions', () => {
  const segs = [
    { id: 's1', start: 0, end: 4 },
    { id: 's2', start: 6, end: 8 },
  ];
  const base = mkDoc(
    20,
    [
      vTrack('V', [video('v', 0, 10, { volume: 0, linkId: 'L' }), video('own', 10, 2, { volume: 1 })]),
      aTrack('O', 'original', [sound('o', 0, 10, { linkId: 'L' })]),
    ],
    segs,
  );

  it('voiceover track with language; clip at segStartLang + LEAD, duration V, no speed', () => {
    const out = localize(base, opts([take('s1', 4.5), take('s2', 1.1)]));
    const track = out.doc.tracks.find((t) => t.kind === 'audio' && t.role === 'voiceover');
    expect(track).toMatchObject({ kind: 'audio', role: 'voiceover', language: 'en' });
    const clips = track!.clips as AudioClip[];
    expect(clips.map((c) => [c.assetId, c.start, c.duration, c.in, c.volume])).toEqual([
      ['voice-s1', 0.15, 4.5, 0, 1],
      ['voice-s2', 7.15, 1.1, 0, 1],
    ]);
    for (const c of clips) {
      expect(c.speed).toBeUndefined();
      expect(c.hold).toBeUndefined();
    }
    expectValid(out.doc);
  });

  it('replace → original and video sound muted', () => {
    const out = localize(
      base,
      opts([take('s1', 4.5)], { original: { mode: 'replace', level: 0.25, duckLevel: 0.08 } }),
    );
    for (const c of clipsOf(out.doc, 'O') as AudioClip[]) expect(c.volume).toBe(0);
    for (const c of clipsOf(out.doc, 'V') as MediaClip[]) expect(c.volume).toBe(0);
  });

  it('duck → volume = level, envelope dips to duckLevel/level under each voice clip with 0.2 s ramps', () => {
    const out = localize(base, opts([take('s1', 4.5), take('s2', 1.1)]));
    const o = clipsOf(out.doc, 'O') as AudioClip[];
    for (const c of o) expect(c.volume).toBe(0.25);
    // власний звук відео винесено в зв'язаний кліп `original`
    const own = (clipsOf(out.doc, 'V') as MediaClip[]).find((c) => c.assetId === 'asset-own')!;
    expect(own.volume).toBe(0);
    expect(o.find((c) => c.assetId === 'asset-own')).toMatchObject({ linkId: own.linkId, volume: 0.25 });
    const r = 0.08 / 0.25;
    // кліп оригіналу [0,5]: голос [0,15; 4,65] → рампа −0,05…0,15 (на 0 вже 0,83), рампа вгору 4,65…4,85
    const first = o[0]!;
    expect(first.start).toBe(0);
    const env = first.envelope!;
    const pts = env.map((p) => [Number(p.t.toFixed(6)), Number(p.gain.toFixed(6))]);
    expect(pts).toEqual([
      [0, Number((1 - (1 - r) * 0.25).toFixed(6))],
      [0.15, r],
      [4.65, r],
      [4.85, 1],
      [5, 1],
    ]);
    const edge = Number((1 - (1 - r) * 0.25).toFixed(6));
    // проміжок [5,7]: рампа другого голосу починається на 6,95
    expect(o[1]!.envelope!.map((p) => [Number(p.t.toFixed(6)), Number(p.gain.toFixed(6))])).toEqual([
      [0, 1],
      [1.95, 1],
      [2, edge],
    ]);
    // другий голос [7,15; 8,25] під шматком [7; 8,6]
    expect(o[2]!.envelope!.map((p) => [Number(p.t.toFixed(6)), Number(p.gain.toFixed(6))])).toEqual([
      [0, edge],
      [0.15, r],
      [1.25, r],
      [1.45, 1],
      [1.6, 1],
    ]);
    expectValid(out.doc);
  });

  it('captions track gets one clip per voice clip; none when disabled or null', () => {
    const on = localize(base, opts([take('s1', 4.5), take('s2', 1.1)], { captions: { enabled: true, styleId: 'st' } }));
    const voice = on.doc.tracks.find((t) => t.kind === 'audio' && t.role === 'voiceover')!.clips as AudioClip[];
    const caps = on.doc.tracks.find((t) => t.kind === 'captions');
    expect(caps).toMatchObject({ kind: 'captions', language: 'en' });
    expect((caps!.clips as CaptionClip[]).map((c) => [c.audioClipId, c.transcriptId, c.styleId])).toEqual([
      [voice[0]!.id, 'tr-s1', 'st'],
      [voice[1]!.id, 'tr-s2', 'st'],
    ]);
    expectValid(on.doc);
    for (const captions of [null, { enabled: false, styleId: 'st' }]) {
      const off = localize(base, opts([take('s1', 4.5)], { captions }));
      expect(off.doc.tracks.some((t) => t.kind === 'captions')).toBe(false);
    }
  });
});

describe('localize — voice track in the doc (spec §3.3)', () => {
  const segs = [
    { id: 's1', start: 0, end: 4 },
    { id: 's2', start: 6, end: 8 },
  ];
  // кліп s1 зсунуто вручну з 0,15 на 1; `extra` — кліп без дубля
  const voTrack = (language: string): Track => ({
    id: 'VO',
    kind: 'audio',
    role: 'voiceover',
    language,
    clips: [
      sound('c1', 1, 4.5, { assetId: 'voice-s1', sceneId: 's1' }),
      sound('c2', 7.15, 1.1, { assetId: 'voice-s2', sceneId: 's2' }),
      sound('extra', 9, 0.5, { assetId: 'free' }),
    ],
  });
  const withTrack = (language: string) =>
    mkDoc(
      20,
      [
        vTrack('V', [video('v', 0, 10, { volume: 0, linkId: 'L' })]),
        aTrack('O', 'original', [sound('o', 0, 10, { linkId: 'L' })]),
        voTrack(language),
      ],
      segs,
    );
  const takes = [take('s1', 4.5), take('s2', 1.1)];

  it('base language with voice track: no fitting, clips kept as is (moved clip stays moved)', () => {
    const base = withTrack('en');
    const out = localize(base, opts(takes));
    expect(out.fits.map((f) => [f.segmentId, f.speed, f.hold, f.trimmed])).toEqual([
      ['s1', 1, 0, 0],
      ['s2', 1, 0, 0],
    ]);
    const voices = out.doc.tracks.filter((t) => t.kind === 'audio' && t.role === 'voiceover');
    expect(voices).toEqual([base.tracks.find((t) => t.id === 'VO')]);
    expect((clipsOf(out.doc, 'V') as MediaClip[]).map((c) => [c.start, c.duration, c.speed])).toEqual([
      [0, 10, undefined],
    ]);
    expect(out.map(6)).toBe(6);
    expectValid(out.doc);
  });

  it('base with track: captions reference track clip ids and take transcriptIds', () => {
    const out = localize(withTrack('en'), opts(takes, { captions: { enabled: true, styleId: 'st' } }));
    const caps = out.doc.tracks.find((t) => t.kind === 'captions');
    expect(caps).toMatchObject({ language: 'en' });
    expect((caps!.clips as CaptionClip[]).map((c) => [c.audioClipId, c.transcriptId, c.styleId])).toEqual([
      ['c1', 'tr-s1', 'st'],
      ['c2', 'tr-s2', 'st'],
    ]);
    expectValid(out.doc);
  });

  it('base with track: duck curve follows track clips', () => {
    const out = localize(withTrack('en'), opts(takes));
    const o = clipsOf(out.doc, 'O') as AudioClip[];
    expect(o).toHaveLength(1);
    const r = Number((0.08 / 0.25).toFixed(6));
    expect(o[0]!.envelope!.map((p) => [Number(p.t.toFixed(6)), Number(p.gain.toFixed(6))])).toEqual([
      [0, 1],
      [0.8, 1],
      [1, r],
      [5.5, r],
      [5.7, 1],
      [6.95, 1],
      [7.15, r],
      [8.25, r],
      [8.45, 1],
      [8.8, 1],
      [9, r],
      [9.5, r],
      [9.7, 1],
      [10, 1],
    ]);
  });

  it('other language: base voice track removed, own track added, single voiceover track in result', () => {
    const out = localize(withTrack('uk'), opts(takes));
    const voices = out.doc.tracks.filter((t) => t.kind === 'audio' && t.role === 'voiceover');
    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({ language: 'en' });
    expect((voices[0]!.clips as AudioClip[]).map((c) => c.assetId)).toEqual(['voice-s1', 'voice-s2']);
    // підгонка відбулася (s1: 4 с → 5 с)
    expect(out.fits[0]).toMatchObject({ segmentId: 's1', speed: 0.8 });
    expectValid(out.doc);
  });
});

describe('localize — missing segments (Review Focus 4)', () => {
  it('ignores takes of segments that no longer exist', () => {
    const base = mkDoc(20, [vTrack('V', [video('v', 0, 10)])], [{ id: 's1', start: 0, end: 4 }]);
    const out = localize(
      base,
      opts([take('s1', 4.5), take('gone', 3)], { captions: { enabled: true, styleId: 'st' } }),
    );
    const voice = out.doc.tracks.find((t) => t.kind === 'audio' && t.role === 'voiceover')!.clips as AudioClip[];
    expect(voice.map((c) => c.assetId)).toEqual(['voice-s1']);
    expect(out.fits.map((f) => f.segmentId)).toEqual(['s1']);
    expectValid(out.doc);
  });

  it('doc without segments → input unchanged except original volume', () => {
    const base = mkDoc(20, [
      vTrack('V', [
        video('v', 0, 5, { volume: 0, linkId: 'L', effects: [{ type: 'kenburns', params: KB }] }),
        video('B', 4, 3, {
          effects: [
            { type: 'xfade', params: { duration: 1 } },
            { type: 'fade', params: { in: 0, out: 0.5 } },
          ],
        }),
      ]),
      aTrack('O', 'original', [sound('o', 0, 5, { linkId: 'L' })]),
      aTrack('M', 'music', [sound('m', 0, 7)]),
    ]);
    const out = localize(base, opts([take('s1', 3)]));
    const expected = structuredClone(base);
    (expected.tracks[1]!.clips[0] as AudioClip).volume = 0.25;
    expect(out.doc).toEqual(expected);
    expect(out.fits).toEqual([]);
    expect(out.map(3.3)).toBeCloseTo(3.3, 9);
  });

  it('segments beyond the doc duration are clamped/ignored; input is not mutated', () => {
    const base = mkDoc(
      20,
      [vTrack('V', [video('v', 0, 5)])],
      [
        { id: 's1', start: 3, end: 7 },
        { id: 's2', start: 8, end: 9 },
      ],
    );
    const snapshot = structuredClone(base);
    const out = localize(base, opts([take('s1', 2), take('s2', 1)]));
    expect(base).toEqual(snapshot);
    expect(out.fits.map((f) => [f.segmentId, f.base])).toEqual([['s1', 2]]);
    expectValid(out.doc);
  });
});
