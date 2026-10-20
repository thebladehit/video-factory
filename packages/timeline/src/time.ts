import type { TimelineDoc } from '@vf/shared';

/** До найближчого кадру `1/fps`. */
export const quantize = (t: number, fps: number): number => Math.round(t * fps) / fps;

/** До кадру вниз (межі джерела: кадр, що виходить за кінець файлу, не існує). */
export const quantizeDown = (t: number, fps: number): number => Math.floor(t * fps + 1e-6) / fps;

/** Кінець останнього кліпу. */
export function docDuration(doc: TimelineDoc): number {
  let end = 0;
  for (const track of doc.tracks) {
    if (track.kind === 'captions') continue;
    for (const c of track.clips) end = Math.max(end, c.start + c.duration);
  }
  return quantize(end, doc.fps);
}
