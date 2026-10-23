import type { Word } from '@vf/shared';
import { tokenize } from './align';

/** Рядки шматка склеюються цим роздільником перед синтезом. */
export const CHUNK_JOIN = '\n\n';
/** Мінімальна тиша в аудіо, щоб різати по ній. */
export const MIN_GAP_MS = 80;
/** Поле перед початком мовлення рядка (у межах середини паузи). */
export const LEAD_IN_MS = 80;
/** Поле після кінця мовлення рядка — згасання голосу тихіше за поріг тиші (у межах середини паузи). */
export const TAIL_OUT_MS = 150;
/** Наскільки далеко від паузи за мітками STT може лежати справжня тиша. */
export const SEARCH_MS = 400;

/** Групує рядки в шматки ≤ `max` символів (з роздільниками); межі лише між рядками. */
export function chunkLines(lines: { id: string; text: string }[], max = 1500): { id: string; text: string }[][] {
  const out: { id: string; text: string }[][] = [];
  let cur: { id: string; text: string }[] = [];
  let len = 0;
  for (const l of lines) {
    const add = cur.length ? CHUNK_JOIN.length + l.text.length : l.text.length;
    if (cur.length && len + add > max) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    len += cur.length ? CHUNK_JOIN.length + l.text.length : l.text.length;
    cur.push(l);
  }
  if (cur.length) out.push(cur);
  return out;
}

interface Range {
  startMs: number;
  endMs: number;
}

/** Інтервали тиші — доповнення `speech` у [0, durationMs]. */
function silences(speech: Range[], durationMs: number): Range[] {
  const sorted = speech.slice().sort((a, b) => a.startMs - b.startMs);
  const out: Range[] = [];
  let pos = 0;
  for (const s of sorted) {
    if (s.startMs > pos) out.push({ startMs: pos, endMs: s.startMs });
    pos = Math.max(pos, s.endMs);
  }
  if (pos < durationMs) out.push({ startMs: pos, endMs: durationMs });
  return out;
}

/**
 * Тиша в аудіо (≥ MIN_GAP_MS), що відповідає паузі між словами за STT [gapStart, gapEnd]: перетинає її або
 * лежить не далі SEARCH_MS; з кількох — найближча серединою до середини паузи. Мітки STT неточні на ±0,1–0,3 с,
 * тому межу визначає тиша, а STT лише каже, в якій із пауз закінчився рядок.
 */
function boundarySilence(gapStart: number, gapEnd: number, quiet: Range[]): Range | null {
  const mid = (gapStart + gapEnd) / 2;
  let best: Range | null = null;
  let bestDist = Infinity;
  for (const s of quiet) {
    if (s.endMs - s.startMs < MIN_GAP_MS) continue;
    const distance = Math.max(0, s.startMs - gapEnd, gapStart - s.endMs);
    if (distance > SEARCH_MS) continue;
    const d = Math.abs((s.startMs + s.endMs) / 2 - mid);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Ріже дубль цілого шматка на рядки по справжніх паузах в аудіо: межа між рядками — тиша, знайдена за паузою STT
 * (`boundarySilence`); вирізка рядка — від початку мовлення − LEAD_IN_MS до кінця + TAIL_OUT_MS, не далі середини
 * паузи. Рядок із ненадійною межею (слово на межі не зіставлене зі STT або поруч немає тиші) — `null`, і так для
 * обох сусідів. Без інтервалів мовлення різати нема за чим — усі рядки `null`.
 */
export function splitTake(input: {
  words: Word[];
  matched: boolean[];
  lineTexts: string[];
  speech: Range[];
  durationMs: number;
}): { lines: ({ startMs: number; endMs: number; words: Word[] } | null)[] } {
  const { words, matched, lineTexts, speech, durationMs } = input;
  const counts = lineTexts.map((t) => tokenize(t).length);
  const total = counts.reduce((s, c) => s + c, 0);
  const n = lineTexts.length;
  if (!speech.length || total !== words.length || counts.some((c) => c === 0)) return { lines: Array(n).fill(null) };

  const offsets: number[] = [];
  let acc = 0;
  for (const c of counts) {
    offsets.push(acc);
    acc += c;
  }

  const sorted = speech.slice().sort((a, b) => a.startMs - b.startMs);
  const quiet = silences(sorted, durationMs);
  // cuts[i] — тиша між рядками i і i+1; null — ненадійна
  const cuts: (Range | null)[] = [];
  for (let i = 0; i < n - 1; i++) {
    const last = offsets[i + 1]! - 1;
    if (!matched[last] || !matched[last + 1]) cuts.push(null);
    else cuts.push(boundarySilence(words[last]!.endMs, words[last + 1]!.startMs, quiet));
  }

  const lines = lineTexts.map((_, i) => {
    const before = i === 0 ? undefined : cuts[i - 1];
    const after = i === n - 1 ? undefined : cuts[i];
    if (before === null || after === null) return null;
    const start = before
      ? Math.max(Math.round((before.startMs + before.endMs) / 2), before.endMs - LEAD_IN_MS)
      : Math.max(0, sorted[0]!.startMs - LEAD_IN_MS);
    const end = after
      ? Math.min(Math.round((after.startMs + after.endMs) / 2), after.startMs + TAIL_OUT_MS)
      : Math.min(durationMs, sorted.at(-1)!.endMs + TAIL_OUT_MS);
    const own = words.slice(offsets[i]!, offsets[i]! + counts[i]!);
    const len = Math.max(0, end - start);
    const clamp = (ms: number) => Math.min(len, Math.max(0, ms - start));
    return {
      startMs: start,
      endMs: Math.max(start, end),
      words: own.map((x) => ({ ...x, startMs: clamp(x.startMs), endMs: clamp(x.endMs) })),
    };
  });
  return { lines };
}
