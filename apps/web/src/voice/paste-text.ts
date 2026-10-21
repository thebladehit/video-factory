import type { Segment, TimelineDoc } from '@vf/shared';
import { docDuration, quantize, segmentsFromText } from '@vf/timeline';

/** Абзаци — блоки тексту, розділені порожніми рядками; зайві пробіли й порожні блоки відкидаються. */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export interface PastePlan {
  /** Документ з новими сегментами (той самий об'єкт, якщо нічого не додано) */
  doc: TimelineDoc;
  /** Абзац → сегмент (за порядком у часі) */
  assignments: { segmentId: string; text: string }[];
  /** Абзаців понад наявні сегменти (стали новими сегментами в кінці, якщо вистачило місця) */
  extra: number;
  /** Абзаців, для яких не знайшлося місця на таймлайні (не вставлені) */
  dropped: number;
}

const EPS = 1e-6;

/**
 * Абзаци → сегменти. Немає сегментів: рівномірне розбиття тривалості (`segmentsFromText`).
 * Є сегменти: по порядку в наявні; зайві абзаци — нові сегменти в кінці, у вільному місці після останнього
 * (рівномірно); що не вмістилось — `dropped`.
 */
export function planPaste(paragraphs: string[], doc: TimelineDoc, newId?: () => string): PastePlan {
  const existing = [...(doc.segments ?? [])].sort((a, b) => a.start - b.start);
  const duration = docDuration(doc);

  if (!existing.length) {
    const segments = segmentsFromText(paragraphs.length, duration, doc.fps, newId);
    return {
      doc: segments.length ? { ...doc, segments } : doc,
      assignments: segments.map((s, i) => ({ segmentId: s.id, text: paragraphs[i]! })),
      extra: 0,
      dropped: paragraphs.length - segments.length,
    };
  }

  const assignments = existing.slice(0, paragraphs.length).map((s, i) => ({ segmentId: s.id, text: paragraphs[i]! }));
  const extra = Math.max(0, paragraphs.length - existing.length);
  if (!extra) return { doc, assignments, extra: 0, dropped: 0 };

  const from = existing[existing.length - 1]!.end;
  const free = Math.max(0, quantize(duration, doc.fps) - from);
  const added: Segment[] =
    free > EPS
      ? segmentsFromText(extra, free, doc.fps, newId).map((s) => ({ ...s, start: from + s.start, end: from + s.end }))
      : [];
  added.forEach((s, i) => assignments.push({ segmentId: s.id, text: paragraphs[existing.length + i]! }));
  return {
    doc: added.length ? { ...doc, segments: [...existing, ...added] } : doc,
    assignments,
    extra,
    dropped: extra - added.length,
  };
}
