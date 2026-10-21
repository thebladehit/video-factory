import type { TimelineDoc } from '@vf/shared';
import { clipFades, clipTransform, easeAlpha } from './laws';

export interface Layer {
  clipId: string;
  assetId: string;
  kind: 'image' | 'video';
  sourceTime: number;
  alpha: number;
  scale: number;
  cx: number;
  cy: number;
  fit: 'cover' | 'contain';
}

const EPS = 1e-9;

/** Час у джерелі: `in + min(t − start, duration − hold) × speed` (у зоні `hold` — останній кадр джерела). */
export function sourceTimeAt(
  clip: { start: number; duration: number; in: number; speed?: number; hold?: number },
  t: number,
): number {
  const local = Math.max(0, t - clip.start);
  return clip.in + Math.min(local, clip.duration - (clip.hold ?? 0)) * (clip.speed ?? 1);
}

/**
 * Шари кадру в момент `t` у порядку малювання (перша відео-доріжка — найнижча).
 * Кліпи, тип файлу яких невідомий (`kinds` не містить asset — файл видалено), пропускаються.
 */
export function evaluate(doc: TimelineDoc, t: number, kinds: Record<string, 'image' | 'video'>): Layer[] {
  const out: Layer[] = [];
  for (const track of doc.tracks) {
    if (track.kind !== 'video') continue;
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    for (const c of clips) {
      if (t < c.start - EPS || t >= c.start + c.duration - EPS) continue;
      const kind = kinds[c.assetId];
      if (!kind) continue;
      const local = Math.max(0, t - c.start);
      const p = Math.min(1, local / c.duration);
      const tr = clipTransform(c.effects);
      const { fadeIn, fadeOut } = clipFades(c.effects);
      out.push({
        clipId: c.id,
        assetId: c.assetId,
        kind,
        sourceTime: sourceTimeAt(c, t),
        alpha: easeAlpha(fadeIn, fadeOut, c.duration).at(local),
        scale: tr.scale.at(p),
        cx: tr.cx.at(p),
        cy: tr.cy.at(p),
        fit: c.fit,
      });
    }
  }
  return out;
}

export interface AudioItem {
  clipId: string;
  assetId: string;
  start: number;
  in: number;
  duration: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  speed: number;
  hold: number;
  envelope: { t: number; gain: number }[];
}

/** Що звучить: аудіокліпи + власний звук відео-кліпів з `volume > 0` (фото `volume` не мають). */
export function audioPlan(doc: TimelineDoc): AudioItem[] {
  const out: AudioItem[] = [];
  for (const track of doc.tracks) {
    if (track.kind === 'audio') {
      for (const c of track.clips)
        if (c.volume > 0)
          out.push({
            clipId: c.id,
            assetId: c.assetId,
            start: c.start,
            in: c.in,
            duration: c.duration,
            volume: c.volume,
            fadeIn: c.fadeIn ?? 0,
            fadeOut: c.fadeOut ?? 0,
            speed: c.speed ?? 1,
            hold: c.hold ?? 0,
            envelope: c.envelope ?? [],
          });
    } else if (track.kind === 'video') {
      for (const c of track.clips) {
        if (!c.volume) continue;
        const fade = c.effects.find((e) => e.type === 'fade');
        out.push({
          clipId: c.id,
          assetId: c.assetId,
          start: c.start,
          in: c.in,
          duration: c.duration,
          volume: c.volume,
          fadeIn: fade?.type === 'fade' ? fade.params.in : 0,
          fadeOut: fade?.type === 'fade' ? fade.params.out : 0,
          speed: c.speed ?? 1,
          hold: c.hold ?? 0,
          envelope: [],
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
