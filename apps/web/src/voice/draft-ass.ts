import { captionPages, toAss, type CaptionStyle, type TranscriptWords } from '@vf/captions';
import type { TimelineDoc } from '@vf/shared';

const DRAFT_ID = 'draft:live';

/**
 * Живе прев'ю редактора стилю: доріжки `captions` документа мови перебудовуються з чорновим стилем замість
 * збереженого (той самий `toAss`, що й на сервері — слова беруться з `voice.localized`).
 * `null` — у документі немає субтитрів (вимкнені або немає озвучки); `firstStart` — початок першої сторінки (с).
 */
export function draftSubtitles(
  timeline: TimelineDoc,
  transcripts: Record<string, TranscriptWords>,
  style: CaptionStyle,
): { ass: string; firstStart: number | null } | null {
  if (!timeline.tracks.some((t) => t.kind === 'captions' && t.clips.length > 0)) return null;
  const doc: TimelineDoc = {
    ...timeline,
    tracks: timeline.tracks.map((t) =>
      t.kind === 'captions' ? { ...t, clips: t.clips.map((c) => ({ ...c, styleId: DRAFT_ID })) } : t,
    ),
  };
  const styles = { [DRAFT_ID]: style };
  return {
    ass: toAss({ doc, transcripts, styles }),
    firstStart: captionPages(doc, transcripts, styles)[0]?.start ?? null,
  };
}
