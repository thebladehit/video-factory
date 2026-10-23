import { FORMATS, type AudioClip, type MediaClip, type Segment, type TimelineDoc, type VideoFormat } from '@vf/shared';
import { LEAD, TAIL } from './localize';
import { docDuration, quantize, quantizeDown } from './time';

export interface SceneVisual {
  assetId: string;
  kind: 'image' | 'video';
  /** Тривалість відео (с); для фото не потрібна. */
  durationSec?: number;
  width: number;
  height: number;
  /** Чорна заглушка «Порожня сцена»: без Ken Burns. */
  blank?: boolean;
}

export interface AssembleScene {
  segmentId: string;
  estimatedSec: number;
  /** Тривалість озвучки базової мови; `null` — озвучки ще немає. */
  baseVoiceSec: number | null;
  visual: SceneVisual;
}

export interface AssembleInput {
  format: VideoFormat;
  fps: number;
  scenes: AssembleScene[];
  music: { assetId: string; durationSec: number } | null;
}

export const MUSIC_VOLUME = 0.15;
export const MUSIC_FADE_OUT = 1.5;
/** Відношення сторін файлу, що відрізняється від формату більше ніж на стільки, показується з `contain`. */
const ASPECT_TOLERANCE = 0.2;
const CHARS_PER_SEC = 15;
const VIDEO_TRACK_ID = 'v1';
const defaultId = () => crypto.randomUUID();

/** Оцінка тривалості сцени за текстом без озвучки: `LEAD + символи / 15 + TAIL` (не квантована). */
export function estimateSceneSec(text: string): number {
  return LEAD + [...text].length / CHARS_PER_SEC + TAIL;
}

/** Кількість кадрів (≥ 1) для тривалості в секундах. */
const framesOf = (sec: number, fps: number) => Math.max(1, Math.round(quantize(Number.isFinite(sec) ? sec : 0, fps) * fps));

function segmentsOf(scenes: { segmentId: string; estimatedSec: number; baseVoiceSec?: number | null }[], fps: number): Segment[] {
  let at = 0;
  return scenes.map((s) => {
    const sec = s.baseVoiceSec != null ? LEAD + s.baseVoiceSec + TAIL : s.estimatedSec;
    const start = at;
    at += framesOf(sec, fps);
    return { id: s.segmentId, start: start / fps, end: at / fps };
  });
}

/** Каркас чернетки: лише сегменти (для озвучки сцен до збірки), без доріжок. */
export function skeletonDoc(
  format: VideoFormat,
  fps: number,
  scenes: { segmentId: string; estimatedSec: number }[],
): TimelineDoc {
  return { schemaVersion: 1, ...FORMATS[format], fps, tracks: [], segments: segmentsOf(scenes, fps) };
}

function fitFor(v: SceneVisual, width: number, height: number): 'cover' | 'contain' {
  if (!(v.width > 0 && v.height > 0)) return 'cover';
  const ratio = v.width / v.height / (width / height);
  return Math.abs(ratio - 1) > ASPECT_TOLERANCE ? 'contain' : 'cover';
}

/** Кліпи візуалу на `[startFrame, startFrame + frames)`: фото — один кліп з Ken Burns, відео — повтор із `in=0`. */
function visualClips(
  v: SceneVisual,
  startFrame: number,
  frames: number,
  index: number,
  doc: Pick<TimelineDoc, 'width' | 'height' | 'fps'>,
  newId: () => string,
): MediaClip[] {
  const fps = doc.fps;
  const fit = fitFor(v, doc.width, doc.height);
  const base = { assetId: v.assetId, in: 0, fit };
  if (v.kind === 'image') {
    const zoomIn = index % 2 === 0;
    const x = zoomIn ? 0.4 : 0.6;
    return [
      {
        id: newId(),
        ...base,
        start: startFrame / fps,
        duration: frames / fps,
        effects: v.blank
          ? []
          : [
              {
                type: 'kenburns',
                params: { fromScale: zoomIn ? 1 : 1.15, toScale: zoomIn ? 1.15 : 1, fromX: x, toX: x, fromY: 0.5, toY: 0.5 },
              },
            ],
      },
    ];
  }
  // джерело без відомої (або коротшої за кадр) тривалості — один кліп на всю сцену
  const srcFrames = v.durationSec && Number.isFinite(v.durationSec) ? Math.round(quantizeDown(v.durationSec, fps) * fps) : 0;
  const chunk = srcFrames >= 1 ? srcFrames : frames;
  const clips: MediaClip[] = [];
  for (let off = 0; off < frames; off += chunk) {
    const len = Math.min(chunk, frames - off);
    if (len < 1) break;
    clips.push({
      id: newId(),
      ...base,
      start: (startFrame + off) / fps,
      duration: len / fps,
      effects: [],
      volume: 0,
    });
  }
  return clips;
}

function musicTrack(
  music: { assetId: string; durationSec: number },
  total: number,
  fps: number,
  newId: () => string,
): TimelineDoc['tracks'][number] | null {
  const srcFrames = Number.isFinite(music.durationSec) ? Math.round(quantizeDown(music.durationSec, fps) * fps) : 0;
  const totalFrames = Math.round(total * fps);
  if (srcFrames < 1 || totalFrames < 1) return null;
  const clips: AudioClip[] = [];
  for (let off = 0; off < totalFrames; off += srcFrames) {
    const len = Math.min(srcFrames, totalFrames - off);
    clips.push({ id: newId(), assetId: music.assetId, start: off / fps, duration: len / fps, in: 0, volume: MUSIC_VOLUME });
  }
  clips[clips.length - 1]!.fadeOut = MUSIC_FADE_OUT;
  return { id: newId(), kind: 'audio', role: 'music', clips };
}

/**
 * Збірка чернетки: сегменти впритул від 0, одна відео-доріжка (прямі склейки) і, за наявності, музика.
 * Чиста: ідентифікатори — лише через `newId`.
 */
export function assembleTimeline(input: AssembleInput, newId: () => string = defaultId): TimelineDoc {
  const { fps } = input;
  const dims = FORMATS[input.format];
  const segments = segmentsOf(input.scenes, fps);
  const doc = { ...dims, fps };
  const clips = input.scenes.flatMap((s, i) => {
    const seg = segments[i]!;
    const start = Math.round(seg.start * fps);
    return visualClips(s.visual, start, Math.round(seg.end * fps) - start, i, doc, newId);
  });
  const tracks: TimelineDoc['tracks'] = [{ id: VIDEO_TRACK_ID, kind: 'video', clips }];
  const out: TimelineDoc = { schemaVersion: 1, ...dims, fps, tracks, segments };
  if (input.music) {
    const m = musicTrack(input.music, docDuration(out), fps, newId);
    if (m) tracks.push(m);
  }
  return out;
}

/**
 * Точкова заміна візуалу сцени: кліпи візуальних доріжок усередині сегмента видаляються, на їхнє місце
 * ставляться нові за правилами збірки. `sceneIndex` — індекс сцени (чергування Ken Burns як у повній збірці).
 * Сегмента немає → той самий документ.
 */
export function replaceSegmentVisual(
  doc: TimelineDoc,
  segmentId: string,
  visual: SceneVisual,
  sceneIndex: number,
  newId: () => string = defaultId,
): TimelineDoc {
  const segment = doc.segments?.find((s) => s.id === segmentId);
  if (!segment) return doc;
  const fps = doc.fps;
  const eps = 1e-6;
  const inside = (c: { start: number; duration: number }) => c.start >= segment.start - eps && c.start + c.duration <= segment.end + eps;
  const removedLinks = new Set<string>();
  const kept = doc.tracks.map((t) => {
    if (t.kind !== 'video') return t;
    return {
      ...t,
      clips: t.clips.filter((c) => {
        if (!inside(c)) return true;
        if (c.linkId) removedLinks.add(c.linkId);
        return false;
      }),
    };
  });
  const startFrame = Math.round(segment.start * fps);
  const frames = Math.max(1, Math.round(segment.end * fps) - startFrame);
  const fresh = visualClips(visual, startFrame, frames, sceneIndex, doc, newId);
  const tracks = kept.map((t) =>
    t.kind === 'audio' && removedLinks.size ? { ...t, clips: t.clips.filter((c) => !c.linkId || !removedLinks.has(c.linkId)) } : t,
  );
  const target = tracks.findIndex((t) => t.kind === 'video');
  if (target < 0) tracks.unshift({ id: VIDEO_TRACK_ID, kind: 'video', clips: fresh });
  else {
    const t = tracks[target]!;
    if (t.kind === 'video') tracks[target] = { ...t, clips: [...t.clips, ...fresh].sort((a, b) => a.start - b.start) };
  }
  return { ...doc, tracks };
}
