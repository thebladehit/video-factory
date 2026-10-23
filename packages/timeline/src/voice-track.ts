import type { AudioClip, TimelineDoc, Track } from '@vf/shared';
import { insertTrack } from './ops';
import { LEAD, type VoiceTake } from './localize';
import { quantize, quantizeDown } from './time';

type AudioTrack = Extract<Track, { kind: 'audio' }>;

const isVoice = (t: Track, language: string): t is AudioTrack =>
  t.kind === 'audio' && t.role === 'voiceover' && t.language === language;

/** Доріжка озвучки мови або `null`. */
export function voiceTrackOf(doc: TimelineDoc, language: string): AudioTrack | null {
  return doc.tracks.find((t): t is AudioTrack => isVoice(t, language)) ?? null;
}

/** Прибирає сегмент зі списку вручну видалених («Повернути озвучку»). */
export function restoreSegmentVoice(doc: TimelineDoc, language: string, segmentId: string): TimelineDoc {
  const track = voiceTrackOf(doc, language);
  if (!track?.removedSegments?.includes(segmentId)) return doc;
  const removed = track.removedSegments.filter((s) => s !== segmentId);
  const next: AudioTrack = { ...track };
  if (removed.length) next.removedSegments = removed;
  else delete next.removedSegments;
  return { ...doc, tracks: doc.tracks.map((t) => (t === track ? next : t)) };
}

/**
 * Приводить доріжку озвучки мови у відповідність до готових дублів (спека §3.2).
 * Нічого не змінилось — повертає той самий документ.
 */
export function syncVoiceTrack(
  doc: TimelineDoc,
  opts: { language: string; takes: VoiceTake[]; newId?: () => string },
): { doc: TimelineDoc; changed: boolean } {
  const { language, takes } = opts;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const existing = voiceTrackOf(doc, language);
  if (!existing && !takes.length) return { doc, changed: false };

  const fps = doc.fps;
  const segments = doc.segments ?? [];
  const segById = new Map(segments.map((s) => [s.id, s]));
  const takeBy = new Map(takes.map((t) => [t.segmentId, t]));
  const durationOf = (t: VoiceTake) => Math.max(1 / fps, quantizeDown(t.durationSec, fps));

  const base: AudioTrack = existing ?? { id: newId(), kind: 'audio', role: 'voiceover', language, clips: [] };
  let changed = !existing;
  const removedOld = base.removedSegments ?? [];
  const removed = removedOld.filter((id) => segById.has(id));
  if (removed.length !== removedOld.length) changed = true;

  const clips: AudioClip[] = [];
  const seen = new Set<string>();
  for (const c of base.clips) {
    const seg = c.sceneId ? segById.get(c.sceneId) : undefined;
    if (!c.sceneId) {
      clips.push(c); // кліп без прив'язки до сегмента — користувацький
      continue;
    }
    if (!seg) {
      changed = true;
      continue;
    }
    const take = takeBy.get(c.sceneId);
    if (!take) {
      changed = true;
      continue;
    }
    seen.add(c.sceneId);
    if (c.assetId === take.assetId) clips.push(c);
    else {
      changed = true;
      clips.push({ ...c, assetId: take.assetId, duration: durationOf(take), in: 0 });
    }
  }
  for (const seg of segments) {
    const take = takeBy.get(seg.id);
    if (!take || seen.has(seg.id) || removed.includes(seg.id)) continue;
    changed = true;
    clips.push({
      id: newId(),
      assetId: take.assetId,
      start: quantize(seg.start + LEAD, fps),
      duration: durationOf(take),
      in: 0,
      volume: 1,
      sceneId: seg.id,
    });
  }
  if (!changed) return { doc, changed: false };

  clips.sort((a, b) => a.start - b.start);
  const next: AudioTrack = { ...base, clips };
  if (removed.length) next.removedSegments = removed;
  else delete next.removedSegments;
  const out = existing
    ? { ...doc, tracks: doc.tracks.map((t) => (t === existing ? next : t)) }
    : insertTrack(doc, next);
  return { doc: out, changed: true };
}
