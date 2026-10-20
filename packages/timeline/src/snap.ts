import type { TimelineDoc } from '@vf/shared';

/** Цілі снепінгу: 0, плейхед і краї всіх кліпів, крім тих, що рухаються. */
export function snapTargets(doc: TimelineDoc, opts: { playhead: number; exclude: string[] }): number[] {
  const out = new Set<number>([0, opts.playhead]);
  for (const track of doc.tracks) {
    if (track.kind === 'captions') continue;
    for (const c of track.clips) {
      if (opts.exclude.includes(c.id)) continue;
      out.add(c.start);
      out.add(c.start + c.duration);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function snap(
  value: number,
  targets: number[],
  opts: { tolerancePx: number; pxPerSec: number },
): { value: number; target: number | null } {
  let best: number | null = null;
  for (const t of targets) {
    const px = Math.abs(value - t) * opts.pxPerSec;
    if (px <= opts.tolerancePx + 1e-9 && (best === null || Math.abs(value - t) < Math.abs(value - best))) best = t;
  }
  return best === null ? { value, target: null } : { value: best, target: best };
}
