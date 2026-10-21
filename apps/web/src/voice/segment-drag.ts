import type { TimelineDoc } from '@vf/shared';
import { setSegmentBounds, snap, snapTargets } from '@vf/timeline';

/**
 * Межа сегмента тягнеться до `time`: снепінг (допуск у px) до країв кліпів, плейхеда й нуля, далі — межі сусідів
 * і округлення до кадру (`setSegmentBounds`). Чиста: рахується від документа на початку жесту.
 */
export function dragSegmentEdge(
  startDoc: TimelineDoc,
  id: string,
  edge: 'start' | 'end',
  time: number,
  o: { playhead: number; pxPerSec: number; tolerancePx: number },
): { doc: TimelineDoc; snapLine: number | null } {
  const seg = startDoc.segments?.find((s) => s.id === id);
  if (!seg) return { doc: startDoc, snapLine: null };
  const targets = snapTargets(startDoc, { playhead: o.playhead, exclude: [] });
  const s = snap(time, targets, { tolerancePx: o.tolerancePx, pxPerSec: o.pxPerSec });
  const doc =
    edge === 'start'
      ? setSegmentBounds(startDoc, id, s.value, seg.end)
      : setSegmentBounds(startDoc, id, seg.start, s.value);
  return { doc, snapLine: s.target };
}
