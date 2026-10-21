import type { Segment, TimelineDoc } from '@vf/shared';
import { docDuration, quantize } from './time';

const defaultId = () => crypto.randomUUID();
const EPS = 1e-6;

const segsOf = (doc: TimelineDoc): Segment[] => [...(doc.segments ?? [])].sort((a, b) => a.start - b.start);
const withSegs = (doc: TimelineDoc, segments: Segment[]): TimelineDoc => ({ ...doc, segments });

/** Розрізає сегмент під `t`; поза сегментами — новий сегмент на весь вільний проміжок між сусідами. */
export function splitSegmentAt(doc: TimelineDoc, t: number, newId: () => string = defaultId): TimelineDoc {
  const fps = doc.fps;
  const frame = 1 / fps;
  const dur = docDuration(doc);
  const at = quantize(t, fps);
  if (at < 0 || at >= dur - EPS) return doc;
  const segs = segsOf(doc);
  const hit = segs.find((s) => at >= s.start - EPS && at < s.end - EPS);
  if (hit) {
    if (at - hit.start < frame - EPS || hit.end - at < frame - EPS) return doc;
    const out = segs.flatMap((s) =>
      s.id === hit.id
        ? [
            { ...s, end: at },
            { id: newId(), start: at, end: s.end },
          ]
        : [s],
    );
    return withSegs(doc, out);
  }
  const prev = [...segs].reverse().find((s) => s.end <= at + EPS);
  const next = segs.find((s) => s.start >= at - EPS);
  const lo = prev ? prev.end : 0;
  const hi = Math.min(next ? next.start : dur, dur);
  if (hi - lo < frame - EPS) return doc;
  return withSegs(
    doc,
    [...segs, { id: newId(), start: lo, end: hi }].sort((a, b) => a.start - b.start),
  );
}

/** Зливає два сусідні сегменти; лишається id першого (за часом). */
export function mergeSegments(doc: TimelineDoc, aId: string, bId: string): TimelineDoc {
  const segs = segsOf(doc);
  const i = segs.findIndex((s) => s.id === aId);
  const j = segs.findIndex((s) => s.id === bId);
  if (i < 0 || j < 0 || Math.abs(i - j) !== 1) return doc;
  const [first, second] = [segs[Math.min(i, j)]!, segs[Math.max(i, j)]!];
  const out = segs.filter((s) => s.id !== second.id).map((s) => (s.id === first.id ? { ...s, end: second.end } : s));
  return withSegs(doc, out);
}

/** Межі сегмента: не заходять на сусідів, у `[0, docDuration]`, не коротші за кадр. */
export function setSegmentBounds(doc: TimelineDoc, id: string, start: number, end: number): TimelineDoc {
  const fps = doc.fps;
  const frame = 1 / fps;
  const segs = segsOf(doc);
  const i = segs.findIndex((s) => s.id === id);
  if (i < 0) return doc;
  const lo = segs[i - 1] ? segs[i - 1]!.end : 0;
  const hi = Math.min(segs[i + 1] ? segs[i + 1]!.start : Infinity, docDuration(doc));
  if (hi - lo < frame - EPS) return doc;
  const s = Math.min(Math.max(quantize(start, fps), lo), hi - frame);
  const e = Math.min(Math.max(quantize(end, fps), s + frame), hi);
  const cur = segs[i]!;
  if (Math.abs(s - cur.start) < EPS && Math.abs(e - cur.end) < EPS) return doc;
  return withSegs(
    doc,
    segs.map((x) => (x.id === id ? { ...x, start: s, end: e } : x)),
  );
}

export function deleteSegment(doc: TimelineDoc, id: string): TimelineDoc {
  const segs = segsOf(doc);
  if (!segs.some((s) => s.id === id)) return doc;
  return withSegs(
    doc,
    segs.filter((s) => s.id !== id),
  );
}

/** `count` рівних суцільних сегментів на `[0, duration]`. */
export function segmentsFromText(
  count: number,
  duration: number,
  fps: number,
  newId: () => string = defaultId,
): Segment[] {
  if (count < 1 || duration <= 0) return [];
  const bound = (i: number) => (i === count ? quantize(duration, fps) : quantize((duration * i) / count, fps));
  return Array.from({ length: count }, (_, i) => ({ id: newId(), start: bound(i), end: bound(i + 1) }));
}

export interface SpeechSegment {
  start: number;
  end: number;
  text: string;
}

const MIN_PHRASE = 2;
const MAX_PHRASE = 15;
const PAUSE = 0.7;
const SENTENCE_END = /[.!?…]["')\]»”]*$/;

/**
 * Сегменти STT → фрази 2–15 с. Розрив на кінці речення або паузі > 0,7 с, але лише коли фраза вже ≥ 2 с
 * (коротші шматки зливаються далі); фраза не росте понад 15 с.
 */
export function groupPhrases(stt: SpeechSegment[]): SpeechSegment[] {
  const out: SpeechSegment[] = [];
  let cur: SpeechSegment | null = null;
  for (const seg of [...stt].sort((a, b) => a.start - b.start)) {
    const text = seg.text.trim();
    if (!text) continue;
    if (cur) {
      const long = cur.end - cur.start >= MIN_PHRASE;
      const brk =
        seg.end - cur.start > MAX_PHRASE ||
        (long && (SENTENCE_END.test(cur.text) || seg.start - cur.end > PAUSE + EPS));
      if (brk) {
        out.push(cur);
        cur = null;
      }
    }
    cur = cur
      ? { start: cur.start, end: Math.max(cur.end, seg.end), text: `${cur.text} ${text}` }
      : { start: seg.start, end: seg.end, text };
  }
  if (cur) out.push(cur);
  return out;
}

/** Межі = початки фраз; `[0, перша фраза)` без тексту (якщо ≥ 1 кадр); останній сегмент — до `duration`. */
export function segmentsFromSpeech(
  stt: SpeechSegment[],
  duration: number,
  fps: number,
  newId: () => string = defaultId,
): { segments: Segment[]; texts: Record<string, string> } {
  const frame = 1 / fps;
  const total = quantize(duration, fps);
  const starts: { start: number; text: string }[] = [];
  for (const p of groupPhrases(stt)) {
    const start = Math.max(0, quantize(p.start, fps));
    if (start > total - frame + EPS) continue;
    const last = starts[starts.length - 1];
    if (last && start - last.start < frame - EPS) last.text = `${last.text} ${p.text}`;
    else starts.push({ start, text: p.text });
  }
  const first = starts[0];
  if (first && first.start < frame - EPS) first.start = 0;
  const bounds: { start: number; text?: string }[] =
    first && first.start === 0 ? starts : first ? [{ start: 0 }, ...starts] : [];
  const segments: Segment[] = [];
  const texts: Record<string, string> = {};
  bounds.forEach((b, i) => {
    const id = newId();
    segments.push({ id, start: b.start, end: i + 1 < bounds.length ? bounds[i + 1]!.start : total });
    if (b.text) texts[id] = b.text;
  });
  return { segments, texts };
}
