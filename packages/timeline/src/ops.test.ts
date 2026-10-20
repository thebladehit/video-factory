import { describe, expect, it } from 'vitest';
import { emptyTimeline, type AudioClip, type MediaClip, type TimelineDoc } from '@vf/shared';
import {
  addClip,
  addLinkedAudio,
  deleteClips,
  docDuration,
  findClip,
  moveClip,
  setEffect,
  setFormat,
  setTransition,
  setVolume,
  splitAt,
  trimEnd,
  trimStart,
  unlink,
  type AssetInfo,
} from './index';

let n = 0;
const ids = () => `id${++n}`;
const img: AssetInfo = { id: 'img', kind: 'image' };
const vid: AssetInfo = { id: 'vid', kind: 'video', durationSec: 4, hasAudio: true };
const silent: AssetInfo = { id: 'sil', kind: 'video', durationSec: 4, hasAudio: false };
const song: AssetInfo = { id: 'song', kind: 'audio', durationSec: 10 };
const sources = { vid: 4, sil: 4, song: 10, short: 2.0166 };

const clipOf = (doc: TimelineDoc, id: string) => findClip(doc, id)!.clip;
const media = (doc: TimelineDoc, id: string) => clipOf(doc, id) as MediaClip;
const audio = (doc: TimelineDoc, id: string) => clipOf(doc, id) as AudioClip;
const add = (doc: TimelineDoc, a: AssetInfo, at: number, trackId?: string) => addClip(doc, a, { at, trackId }, ids);

describe('addClip', () => {
  it('image → 5s with default kenburns on a new video track', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), img, 1);
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0]!.kind).toBe('video');
    expect(media(doc, clipIds[0]!)).toMatchObject({
      assetId: 'img',
      start: 1,
      duration: 5,
      in: 0,
      fit: 'cover',
      effects: [
        { type: 'kenburns', params: { fromScale: 1, toScale: 1.15, fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5 } },
      ],
    });
  });

  it("video with hasAudio → linked audio on 'original' track with same start/in/duration and video volume 0", () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), vid, 0);
    expect(clipIds).toHaveLength(2);
    const v = media(doc, clipIds[0]!);
    const a = audio(doc, clipIds[1]!);
    expect(v).toMatchObject({ start: 0, in: 0, duration: 4, volume: 0, effects: [] });
    expect(a).toMatchObject({ start: 0, in: 0, duration: 4, volume: 1, assetId: 'vid', linkId: v.linkId });
    expect(v.linkId).toBeTruthy();
    expect(findClip(doc, a.id)!.track).toMatchObject({ kind: 'audio', role: 'original' });
  });

  it('video without audio → no audio clip, volume 1', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), silent, 0);
    expect(clipIds).toHaveLength(1);
    expect(media(doc, clipIds[0]!).volume).toBe(1);
    expect(doc.tracks).toHaveLength(1);
  });

  it("audio → 'music' track", () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), song, 0);
    expect(findClip(doc, clipIds[0]!)!.track).toMatchObject({ kind: 'audio', role: 'music' });
    expect(audio(doc, clipIds[0]!)).toMatchObject({ duration: 10, volume: 1 });
  });

  it('track order is video…, original, music', () => {
    let doc = add(emptyTimeline('9:16'), song, 0).doc;
    doc = add(doc, vid, 0).doc;
    expect(doc.tracks.map((t) => (t.kind === 'audio' ? t.role : t.kind))).toEqual(['video', 'original', 'music']);
  });

  it('adding onto an occupied place goes flush to the nearest free edge', () => {
    let doc = add(emptyTimeline('9:16'), img, 0).doc;
    const r = add(doc, img, 4);
    doc = r.doc;
    expect(media(doc, r.clipIds[0]!).start).toBe(5);
  });
});

describe('moveClip', () => {
  it('moves the linked partner', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), vid, 0);
    const moved = moveClip(doc, clipIds[0]!, 2, sources);
    expect(media(moved, clipIds[0]!).start).toBe(2);
    expect(audio(moved, clipIds[1]!).start).toBe(2);
  });

  it('moving onto an occupied place snaps flush to the nearest free edge', () => {
    let doc = add(emptyTimeline('9:16'), img, 0).doc; // [0,5)
    const b = add(doc, img, 10);
    doc = b.doc; // [10,15)
    expect(media(moveClip(doc, b.clipIds[0]!, 4, sources), b.clipIds[0]!).start).toBe(5);
    expect(media(moveClip(doc, b.clipIds[0]!, 0.5, sources), b.clipIds[0]!).start).toBe(5);
  });

  it('flush goes left when the left edge is closer', () => {
    let doc = add(emptyTimeline('9:16'), img, 10).doc; // [10,15)
    const b = add(doc, img, 0);
    doc = b.doc; // [0,5)
    expect(media(moveClip(doc, b.clipIds[0]!, 6, sources), b.clipIds[0]!).start).toBe(5);
  });

  it('start never below 0', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), img, 3);
    expect(media(moveClip(doc, clipIds[0]!, -2, sources), clipIds[0]!).start).toBe(0);
  });

  it('moves between tracks of the same kind only', () => {
    let doc = add(emptyTimeline('9:16'), img, 0).doc;
    doc = { ...doc, tracks: [...doc.tracks, { id: 'v2', kind: 'video', clips: [] }] };
    const s = add(doc, song, 0);
    const imgId = doc.tracks[0]!.clips[0]!.id;
    const toV2 = moveClip(s.doc, imgId, 1, sources, 'v2');
    expect(findClip(toV2, imgId)!.track.id).toBe('v2');
    const musicTrack = findClip(s.doc, s.clipIds[0]!)!.track.id;
    expect(findClip(moveClip(s.doc, imgId, 1, sources, musicTrack), imgId)!.track.kind).toBe('video');
  });

  it('unknown id → doc unchanged', () => {
    const { doc } = add(emptyTimeline('9:16'), img, 0);
    expect(moveClip(doc, 'nope', 3, sources)).toBe(doc);
  });
});

describe('trim', () => {
  it('trimEnd clamps to source length rounded down to a frame', () => {
    const { doc, clipIds } = add(
      emptyTimeline('9:16'),
      { id: 'short', kind: 'video', durationSec: 2.0166, hasAudio: false },
      0,
    );
    expect(media(doc, clipIds[0]!).duration).toBe(2);
    expect(media(trimEnd(doc, clipIds[0]!, 5, sources), clipIds[0]!).duration).toBe(2);
  });

  it('trimEnd shortens video and its linked audio', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), vid, 0);
    const t = trimEnd(doc, clipIds[0]!, 3, sources);
    expect(media(t, clipIds[0]!).duration).toBe(3);
    expect(audio(t, clipIds[1]!).duration).toBe(3);
  });

  it('trimStart keeps in >= 0 and updates in/start/duration', () => {
    const r0 = add(emptyTimeline('9:16'), vid, 2);
    const clipIds = r0.clipIds;
    let doc = r0.doc;
    doc = trimStart(doc, clipIds[0]!, 3, sources);
    expect(media(doc, clipIds[0]!)).toMatchObject({ start: 3, in: 1, duration: 3 });
    expect(audio(doc, clipIds[1]!)).toMatchObject({ start: 3, in: 1, duration: 3 });
    doc = trimStart(doc, clipIds[0]!, 0, sources);
    expect(media(doc, clipIds[0]!)).toMatchObject({ start: 2, in: 0, duration: 4 });
  });

  it('image trim has no source bound', () => {
    const r0 = add(emptyTimeline('9:16'), img, 2);
    const clipIds = r0.clipIds;
    let doc = r0.doc;
    doc = trimEnd(doc, clipIds[0]!, 30, sources);
    expect(media(doc, clipIds[0]!).duration).toBe(28);
    doc = trimStart(doc, clipIds[0]!, 0, sources);
    expect(media(doc, clipIds[0]!)).toMatchObject({ start: 0, in: 0, duration: 30 });
  });

  it('min duration is one frame', () => {
    const r0 = add(emptyTimeline('9:16'), img, 2);
    const clipIds = r0.clipIds;
    let doc = r0.doc;
    doc = trimEnd(doc, clipIds[0]!, 1, sources);
    expect(media(doc, clipIds[0]!).duration).toBeCloseTo(1 / 30, 9);
    const r = add(emptyTimeline('9:16'), img, 2);
    doc = trimStart(r.doc, r.clipIds[0]!, 100, sources);
    expect(media(doc, r.clipIds[0]!)).toMatchObject({ start: 7 - 1 / 30 });
  });

  it('trim stops at the neighbour', () => {
    let doc = add(emptyTimeline('9:16'), img, 0).doc; // [0,5)
    const b = add(doc, img, 8);
    doc = b.doc; // [8,13)
    const a = (doc.tracks[0]!.clips as MediaClip[]).find((c) => c.start === 0)!.id;
    expect(media(trimEnd(doc, a, 10, sources), a).duration).toBe(8);
    expect(media(trimStart(doc, b.clipIds[0]!, 2, sources), b.clipIds[0]!).start).toBe(5);
  });
});

describe('splitAt', () => {
  it('splits both linked clips and gives the right halves a new shared linkId', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), vid, 1);
    const oldLink = media(doc, clipIds[0]!).linkId;
    const s = splitAt(doc, clipIds[0]!, 2.5, ids);
    const v = s.tracks[0]!.clips as MediaClip[];
    const a = s.tracks[1]!.clips as AudioClip[];
    expect(v.map((c) => [c.start, c.in, c.duration])).toEqual([
      [1, 0, 1.5],
      [2.5, 1.5, 2.5],
    ]);
    expect(a.map((c) => [c.start, c.in, c.duration])).toEqual([
      [1, 0, 1.5],
      [2.5, 1.5, 2.5],
    ]);
    expect(v[0]!.linkId).toBe(oldLink);
    expect(a[0]!.linkId).toBe(oldLink);
    expect(v[1]!.linkId).toBeTruthy();
    expect(v[1]!.linkId).not.toBe(oldLink);
    expect(a[1]!.linkId).toBe(v[1]!.linkId);
  });

  it('continues ken burns across the cut', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), img, 0);
    const s = splitAt(doc, clipIds[0]!, 2.5, ids);
    const [l, r] = s.tracks[0]!.clips as MediaClip[];
    expect(l!.effects[0]!.params).toMatchObject({ fromScale: 1, toScale: 1.075 });
    expect(r!.effects[0]!.params).toMatchObject({ fromScale: 1.075, toScale: 1.15 });
  });

  it('split outside the clip is a no-op', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), img, 1);
    expect(splitAt(doc, clipIds[0]!, 0.5, ids)).toBe(doc);
    expect(splitAt(doc, clipIds[0]!, 1, ids)).toBe(doc);
    expect(splitAt(doc, clipIds[0]!, 6, ids)).toBe(doc);
  });
});

describe('delete, unlink, volume, effects', () => {
  it('deleteClips(video) removes its linked audio', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), vid, 0);
    const d = deleteClips(doc, [clipIds[0]!]);
    expect(findClip(d, clipIds[0]!)).toBeNull();
    expect(findClip(d, clipIds[1]!)).toBeNull();
  });

  it('deleteClips(audio) keeps video with volume 0', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), vid, 0);
    const d = deleteClips(doc, [clipIds[1]!]);
    expect(findClip(d, clipIds[1]!)).toBeNull();
    expect(media(d, clipIds[0]!)).toMatchObject({ volume: 0 });
    expect(media(d, clipIds[0]!).linkId).toBeUndefined();
  });

  it('unlink removes linkId from both', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), vid, 0);
    const u = unlink(doc, media(doc, clipIds[0]!).linkId!);
    expect(media(u, clipIds[0]!).linkId).toBeUndefined();
    expect(audio(u, clipIds[1]!).linkId).toBeUndefined();
    expect(media(moveClip(u, clipIds[0]!, 3, sources), clipIds[1]!)).toMatchObject({ start: 0 });
  });

  it('addLinkedAudio moves the video sound into a linked clip', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), { ...vid, hasAudio: null }, 1);
    expect(media(doc, clipIds[0]!).volume).toBe(1);
    const d = addLinkedAudio(doc, clipIds[0]!, ids);
    const v = media(d, clipIds[0]!);
    expect(v.volume).toBe(0);
    const a = d.tracks.find((t) => t.kind === 'audio')!.clips[0] as AudioClip;
    expect(a).toMatchObject({ start: 1, in: 0, duration: 4, volume: 1, linkId: v.linkId });
    expect(addLinkedAudio(d, clipIds[0]!, ids)).toBe(d);
  });

  it('setVolume clamps to 0..2', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), song, 0);
    expect(audio(setVolume(doc, clipIds[0]!, 3), clipIds[0]!).volume).toBe(2);
    expect(audio(setVolume(doc, clipIds[0]!, 0.5), clipIds[0]!).volume).toBe(0.5);
  });

  it('setEffect replaces an effect of the same type', () => {
    const { doc, clipIds } = add(emptyTimeline('9:16'), img, 0);
    const d = setEffect(doc, clipIds[0]!, {
      type: 'kenburns',
      params: { fromScale: 1, toScale: 2, fromX: 0, fromY: 0, toX: 1, toY: 1 },
    });
    expect(media(d, clipIds[0]!).effects).toHaveLength(1);
    expect(media(d, clipIds[0]!).effects[0]!.params).toMatchObject({ toScale: 2 });
  });
});

describe('setTransition', () => {
  it('creates an overlap equal to duration and clamps to the shorter clip', () => {
    let doc = add(emptyTimeline('9:16'), img, 0).doc; // [0,5)
    doc = trimEnd(doc, doc.tracks[0]!.clips[0]!.id, 2, sources); // [0,2)
    const b = add(doc, img, 2);
    doc = b.doc; // [2,7)
    const t = setTransition(doc, b.clipIds[0]!, 0.5);
    expect(media(t, b.clipIds[0]!).start).toBe(1.5);
    expect(media(t, b.clipIds[0]!).effects.find((e) => e.type === 'xfade')!.params).toEqual({ duration: 0.5 });
    const big = setTransition(doc, b.clipIds[0]!, 10);
    expect(media(big, b.clipIds[0]!).start).toBeCloseTo(1 / 30, 9);
    const none = setTransition(t, b.clipIds[0]!, 0);
    expect(media(none, b.clipIds[0]!).start).toBe(2);
    expect(media(none, b.clipIds[0]!).effects.some((e) => e.type === 'xfade')).toBe(false);
  });

  it('a moved clip may keep its transition overlap', () => {
    let doc = add(emptyTimeline('9:16'), img, 0).doc;
    const b = add(doc, img, 5);
    doc = setTransition(b.doc, b.clipIds[0]!, 0.5); // b [4.5, 9.5)
    expect(media(moveClip(doc, b.clipIds[0]!, 4.5, sources), b.clipIds[0]!).start).toBe(4.5);
  });
});

describe('format and duration', () => {
  it('setFormat swaps width/height', () => {
    const d = setFormat(emptyTimeline('9:16'), '16:9');
    expect([d.width, d.height]).toEqual([1920, 1080]);
  });

  it('docDuration is the end of the last clip', () => {
    let doc = add(emptyTimeline('9:16'), img, 0).doc;
    doc = add(doc, song, 2).doc;
    expect(docDuration(doc)).toBe(12);
    expect(docDuration(emptyTimeline('9:16'))).toBe(0);
  });
});

describe('quantization', () => {
  it('all times are multiples of 1/30', () => {
    let rnd = 42;
    const random = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
    let doc = add(emptyTimeline('9:16'), vid, 0.123).doc;
    doc = add(doc, img, 7.77).doc;
    doc = add(doc, song, 1.01).doc;
    const clipIdsAll = () => doc.tracks.flatMap((t) => t.clips.map((c) => c.id));
    const ops = [
      (id: string) => moveClip(doc, id, random() * 20, sources),
      (id: string) => trimStart(doc, id, random() * 20, sources),
      (id: string) => trimEnd(doc, id, random() * 20, sources),
    ];
    const onFrame = (t: number) => Math.abs(t * 30 - Math.round(t * 30)) < 1e-9;
    for (let i = 0; i < 200; i++) {
      const all = clipIdsAll();
      doc = ops[Math.floor(random() * 3)]!(all[Math.floor(random() * all.length)]!);
      for (const t of doc.tracks)
        for (const c of t.clips as (MediaClip | AudioClip)[]) {
          expect(onFrame(c.start) && onFrame(c.in) && onFrame(c.duration)).toBe(true);
          expect(c.duration).toBeGreaterThanOrEqual(1 / 30 - 1e-9);
          expect(c.start).toBeGreaterThanOrEqual(0);
        }
    }
  });
});
