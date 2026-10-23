import { describe, expect, it } from 'vitest';
import { assetKeys, emptyTimeline, jobSubject, normalizeDoc, timelineDocSchema } from './index';

const validDoc = () => ({
  schemaVersion: 1,
  width: 1080,
  height: 1920,
  fps: 30,
  tracks: [
    {
      id: 't1',
      kind: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a1',
          start: 0,
          duration: 2,
          in: 0,
          fit: 'cover',
          effects: [{ type: 'kenburns', params: {} }],
        },
      ],
    },
  ],
});

describe('timelineDocSchema', () => {
  it('emptyTimeline(9:16) is valid with expected dimensions', () => {
    const doc = timelineDocSchema.parse(emptyTimeline('9:16'));
    expect(doc).toMatchObject({ width: 1080, height: 1920, fps: 30, tracks: [] });
  });

  it('accepts a video track with a clip', () => {
    expect(timelineDocSchema.safeParse(validDoc()).success).toBe(true);
  });

  const mutations: [string, (d: any) => void][] = [
    ['duration 0', (d) => (d.tracks[0].clips[0].duration = 0)],
    ['negative start', (d) => (d.tracks[0].clips[0].start = -1)],
    ['negative in', (d) => (d.tracks[0].clips[0].in = -0.5)],
    ['unknown track kind', (d) => (d.tracks[0].kind = 'subtitle')],
    ['captions track without language', (d) => d.tracks.push({ id: 't2', kind: 'captions', clips: [] })],
    ['schemaVersion 2', (d) => (d.schemaVersion = 2)],
    ['unknown effect', (d) => (d.tracks[0].clips[0].effects = [{ type: 'glitch', params: {} }])],
  ];
  it.each(mutations)('rejects %s', (_name, mutate) => {
    const doc = validDoc();
    mutate(doc);
    expect(timelineDocSchema.safeParse(doc).success).toBe(false);
  });
});

describe('normalizeDoc', () => {
  const clip = (d: any) => d.tracks[0].clips[0];

  it('fills kenburns defaults for params: {}', () => {
    const doc = normalizeDoc(validDoc());
    expect(clip(doc).effects[0]).toEqual({
      type: 'kenburns',
      params: { fromScale: 1, toScale: 1.15, fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5 },
    });
  });

  it('fills defaults for zoom, fade and xfade', () => {
    const d = validDoc();
    clip(d).effects = [
      { type: 'zoom', params: {} },
      { type: 'fade', params: {} },
      { type: 'xfade', params: {} },
    ];
    expect(clip(normalizeDoc(d)).effects.map((e: any) => e.params)).toEqual([
      { scale: 1.2, x: 0.5, y: 0.5 },
      { in: 0.3, out: 0 },
      { duration: 0.5 },
    ]);
  });

  it('keeps explicit params', () => {
    const d = validDoc();
    clip(d).effects = [{ type: 'kenburns', params: { toScale: 1.4, toX: 0.2 } }];
    expect(clip(normalizeDoc(d)).effects[0].params).toMatchObject({ fromScale: 1, toScale: 1.4, toX: 0.2, toY: 0.5 });
  });

  it("accepts linkId, volume and role 'original'", () => {
    const d = validDoc();
    Object.assign(clip(d), { volume: 0, linkId: 'l1' });
    d.tracks.push({
      id: 't2',
      kind: 'audio',
      role: 'original',
      clips: [{ id: 'c2', assetId: 'a1', start: 0, duration: 2, in: 0, volume: 1, linkId: 'l1' }],
    } as any);
    const doc = normalizeDoc(d);
    expect(clip(doc)).toMatchObject({ volume: 0, linkId: 'l1' });
    expect(doc.tracks[1]).toMatchObject({ role: 'original', clips: [{ linkId: 'l1' }] });
  });

  const invalid: [string, (d: any) => void][] = [
    ['volume 2.5', (d) => (clip(d).volume = 2.5)],
    ['kenburns scale <= 0', (d) => (clip(d).effects = [{ type: 'kenburns', params: { toScale: 0 } }])],
    ['zoom focus outside 0..1', (d) => (clip(d).effects = [{ type: 'zoom', params: { x: 1.5 } }])],
    ['negative fade', (d) => (clip(d).effects = [{ type: 'fade', params: { in: -1 } }])],
  ];
  it.each(invalid)('rejects %s with VALIDATION', (_n, mutate) => {
    const d = validDoc();
    mutate(d);
    expect(() => normalizeDoc(d)).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });
});

describe('jobSubject', () => {
  it('extracts renderId and projectId', () => {
    expect(jobSubject({ renderId: 'r1', projectId: 'p1', x: 1 })).toEqual({ renderId: 'r1', projectId: 'p1' });
  });
});

describe('assetKeys.peaks', () => {
  it('is next to the original', () => {
    expect(assetKeys.peaks('u1', 'a1')).toBe('u/u1/assets/a1/peaks.bin');
  });
});

describe('segments, speed, hold, envelope', () => {
  const withAudio = () => {
    const d: any = validDoc();
    d.tracks.push({
      id: 't2',
      kind: 'audio',
      role: 'voiceover',
      clips: [{ id: 'a', assetId: 'x', start: 0, duration: 2, in: 0, volume: 1 }],
    });
    return d;
  };
  const aclip = (d: any) => d.tracks[1].clips[0];
  const seg = (id: string, start: number, end: number) => ({ id, start, end });

  it('accepts doc with segments, speed, hold, envelope', () => {
    const d = withAudio();
    d.segments = [seg('s1', 0, 1), seg('s2', 1, 2)];
    d.tracks[0].clips[0].speed = 0.8;
    d.tracks[0].clips[0].hold = 0.5;
    Object.assign(aclip(d), {
      speed: 1.25,
      hold: 0,
      envelope: [
        { t: 0, gain: 1 },
        { t: 0.2, gain: 0.08 },
      ],
    });
    expect(normalizeDoc(d).segments).toHaveLength(2);
  });

  it('old doc without new fields still normalizes', () => {
    const doc = normalizeDoc(validDoc());
    expect(doc.segments).toBeUndefined();
  });

  const bad: [string, (d: any) => void][] = [
    ['overlapping segments', (d) => (d.segments = [seg('s1', 0, 1), seg('s2', 0.5, 2)])],
    ['unordered segments', (d) => (d.segments = [seg('s1', 1, 2), seg('s2', 0, 0.5)])],
    ['segment shorter than one frame', (d) => (d.segments = [seg('s1', 0, 0.02)])],
    ['speed 1.5', (d) => (d.tracks[0].clips[0].speed = 1.5)],
    ['speed 0.5', (d) => (d.tracks[0].clips[0].speed = 0.5)],
    ['negative hold', (d) => (d.tracks[0].clips[0].hold = -1)],
    ['audio speed 2', (d) => (aclip(d).speed = 2)],
    [
      'envelope with decreasing t',
      (d) =>
        (aclip(d).envelope = [
          { t: 1, gain: 1 },
          { t: 0.5, gain: 1 },
        ]),
    ],
    [
      'envelope with equal t',
      (d) =>
        (aclip(d).envelope = [
          { t: 1, gain: 1 },
          { t: 1, gain: 0 },
        ]),
    ],
    ['envelope gain 3', (d) => (aclip(d).envelope = [{ t: 0, gain: 3 }])],
    ['envelope negative t', (d) => (aclip(d).envelope = [{ t: -1, gain: 1 }])],
  ];
  it.each(bad)('rejects %s', (_n, mutate) => {
    const d = withAudio();
    mutate(d);
    expect(() => normalizeDoc(d)).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });
});

describe('clip transform', () => {
  const withTransform = (t: unknown) => {
    const d = validDoc();
    (d.tracks[0]!.clips[0] as Record<string, unknown>).transform = t;
    return d;
  };
  it('accepts clip without transform and keeps it absent after normalizeDoc', () => {
    const clip = normalizeDoc(validDoc()).tracks[0]!.clips[0]!;
    expect('transform' in clip).toBe(false);
  });
  it('accepts a valid transform', () => {
    expect(() => normalizeDoc(withTransform({ scale: 4, x: 0, y: 1 }))).not.toThrow();
  });
  it.each([
    { scale: 0.05, x: 0.5, y: 0.5 },
    { scale: 5, x: 0.5, y: 0.5 },
    { scale: 1, x: -0.1, y: 0.5 },
    { scale: 1, x: 0.5, y: 1.1 },
  ])('rejects transform %j', (t) => {
    expect(() => normalizeDoc(withTransform(t))).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });
});

describe('jobSubject lineId', () => {
  it('extracts lineId', () => {
    expect(jobSubject({ lineId: 'l1' })).toEqual({ lineId: 'l1' });
  });
});
