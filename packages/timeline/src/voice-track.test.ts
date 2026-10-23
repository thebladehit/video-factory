import { describe, expect, it } from 'vitest';
import { emptyTimeline, normalizeDoc, type AudioClip, type TimelineDoc } from '@vf/shared';
import { deleteClips, LEAD, quantize, restoreSegmentVoice, syncVoiceTrack, voiceTrackOf, type VoiceTake } from './index';

const seq = () => {
  let i = 0;
  return () => `n${++i}`;
};
const base = (): TimelineDoc => ({
  ...emptyTimeline('9:16'),
  segments: [
    { id: 's1', start: 0, end: 3 },
    { id: 's2', start: 3, end: 6 },
  ],
});
const take = (segmentId: string, durationSec = 2, assetId = `v-${segmentId}`): VoiceTake => ({
  segmentId,
  assetId,
  durationSec,
  transcriptId: `t-${segmentId}`,
});
const sync = (doc: TimelineDoc, takes: VoiceTake[]) => syncVoiceTrack(doc, { language: 'uk', takes, newId: seq() });
const clips = (doc: TimelineDoc) => (voiceTrackOf(doc, 'uk')?.clips ?? []) as AudioClip[];

describe('syncVoiceTrack', () => {
  it('inserts clip at segment.start + LEAD with sceneId', () => {
    const r = sync(base(), [take('s2', 2)]);
    expect(r.changed).toBe(true);
    expect(clips(r.doc)).toEqual([
      expect.objectContaining({ sceneId: 's2', assetId: 'v-s2', start: quantize(3 + LEAD, 30), duration: 2, in: 0, volume: 1 }),
    ]);
    expect(normalizeDoc(r.doc)).toEqual(r.doc);
  });
  it('creates track language=base when absent and takes exist', () => {
    const r = sync(base(), [take('s1')]);
    expect(r.doc.tracks[0]).toMatchObject({ kind: 'audio', role: 'voiceover', language: 'uk' });
  });
  it('no takes and no track → same doc, changed false', () => {
    const doc = base();
    const r = sync(doc, []);
    expect(r.changed).toBe(false);
    expect(r.doc).toBe(doc);
  });
  it('new assetId keeps start, volume, fadeIn, fadeOut, envelope and resets in', () => {
    let doc = sync(base(), [take('s1', 2)]).doc;
    const tr = voiceTrackOf(doc, 'uk')!;
    const env = [{ t: 0.5, gain: 0.5 }];
    const edited = { ...tr.clips[0]!, start: 1, volume: 0.7, fadeIn: 0.1, fadeOut: 0.2, envelope: env, in: 0.4 };
    doc = { ...doc, tracks: [{ ...tr, clips: [edited] }] };
    const r = sync(doc, [take('s1', 1.5, 'new')]);
    expect(r.changed).toBe(true);
    expect(clips(r.doc)[0]).toMatchObject({
      assetId: 'new',
      duration: 1.5,
      in: 0,
      start: 1,
      volume: 0.7,
      fadeIn: 0.1,
      fadeOut: 0.2,
      envelope: env,
    });
  });
  it('same assetId → changed false (referential equality)', () => {
    const doc = sync(base(), [take('s1'), take('s2')]).doc;
    const r = sync(doc, [take('s1'), take('s2')]);
    expect(r.changed).toBe(false);
    expect(r.doc).toBe(doc);
  });
  it('take gone → clip removed', () => {
    const doc = sync(base(), [take('s1'), take('s2')]).doc;
    const r = sync(doc, [take('s2')]);
    expect(clips(r.doc).map((c) => c.sceneId)).toEqual(['s2']);
  });
  it('segment gone → clip removed and id dropped from removedSegments', () => {
    let doc = sync(base(), [take('s1'), take('s2')]).doc;
    const c2 = clips(doc).find((c) => c.sceneId === 's2')!;
    doc = deleteClips(doc, [c2.id]);
    expect(voiceTrackOf(doc, 'uk')!.removedSegments).toEqual(['s2']);
    doc = { ...doc, segments: [{ id: 's1', start: 0, end: 3 }] };
    const r = sync(doc, [take('s1')]);
    expect(r.changed).toBe(true);
    expect(voiceTrackOf(r.doc, 'uk')).not.toHaveProperty('removedSegments');
    const r2 = sync({ ...doc, segments: [{ id: 'x', start: 0, end: 3 }] }, [take('s1')]);
    expect(clips(r2.doc)).toEqual([]);
  });
  it('removed segment is not re-added after new take', () => {
    let doc = sync(base(), [take('s1')]).doc;
    doc = deleteClips(doc, [clips(doc)[0]!.id]);
    const r = sync(doc, [take('s1', 2, 'newer')]);
    expect(r.changed).toBe(false);
    expect(clips(r.doc)).toEqual([]);
  });
  it('restoreSegmentVoice + sync → clip back', () => {
    let doc = sync(base(), [take('s1')]).doc;
    doc = deleteClips(doc, [clips(doc)[0]!.id]);
    doc = restoreSegmentVoice(doc, 'uk', 's1');
    expect(voiceTrackOf(doc, 'uk')).not.toHaveProperty('removedSegments');
    expect(clips(sync(doc, [take('s1')]).doc)).toHaveLength(1);
    expect(restoreSegmentVoice(doc, 'uk', 's1')).toBe(doc);
  });
  it('duration is at least one frame', () => {
    const r = sync(base(), [take('s1', 0.001)]);
    expect(clips(r.doc)[0]!.duration).toBeCloseTo(1 / r.doc.fps);
  });
});
