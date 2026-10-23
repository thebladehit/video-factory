import type { Word } from '@vf/shared';
import { tokenize } from './align';

/** Рядки шматка склеюються цим роздільником перед синтезом. */
export const CHUNK_JOIN = '\n\n';
/** Мінімальна пауза між словами на межі рядків, щоб різати по ній. */
export const MIN_GAP_MS = 80;
/** Тиша перед першим словом рядка у вирізці (у межах середини паузи). */
export const LEAD_IN_MS = 60;
/** Тиша після останнього слова рядка у вирізці (у межах середини паузи). */
export const TAIL_OUT_MS = 100;

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

/** Середина паузи; якщо вона в мовленні — зсув до найближчої тиші, що перетинає паузу. */
function cutPoint(gapStart: number, gapEnd: number, speech: Range[], durationMs: number): number {
  const mid = Math.round((gapStart + gapEnd) / 2);
  let best = mid;
  let bestDist = Infinity;
  for (const s of silences(speech, durationMs)) {
    const a = Math.max(s.startMs, gapStart);
    const b = Math.min(s.endMs, gapEnd);
    if (b < a) continue;
    const p = Math.min(b, Math.max(a, mid));
    const d = Math.abs(p - mid);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Ріже дубль цілого шматка на рядки по паузах між словами: середина паузи — зовнішня межа, вирізка рядка —
 * від першого слова − LEAD_IN_MS до останнього + TAIL_OUT_MS у цих межах. Рядок із ненадійною межею
 * (слово на межі не зіставлене зі STT або пауза < MIN_GAP_MS) — `null`, і так для обох сусідів.
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
  if (total !== words.length || counts.some((c) => c === 0)) return { lines: Array(n).fill(null) };

  const offsets: number[] = [];
  let acc = 0;
  for (const c of counts) {
    offsets.push(acc);
    acc += c;
  }

  // cuts[i] — межа між рядками i і i+1; null — ненадійна
  const cuts: (number | null)[] = [];
  for (let i = 0; i < n - 1; i++) {
    const last = offsets[i + 1]! - 1;
    const prev = words[last]!;
    const next = words[last + 1]!;
    const gap = next.startMs - prev.endMs;
    if (!matched[last] || !matched[last + 1] || gap < MIN_GAP_MS) cuts.push(null);
    else cuts.push(cutPoint(prev.endMs, next.startMs, speech, durationMs));
  }

  // межі пауз (середини) — зовнішні; вирізка — слова рядка з полями LEAD_IN_MS / TAIL_OUT_MS усередині них
  const lines = lineTexts.map((_, i) => {
    const outerStart = i === 0 ? 0 : cuts[i - 1];
    const outerEnd = i === n - 1 ? durationMs : cuts[i];
    if (outerStart === null || outerEnd === null || outerStart === undefined || outerEnd === undefined) return null;
    const own = words.slice(offsets[i]!, offsets[i]! + counts[i]!);
    const start = Math.min(outerEnd, Math.max(outerStart, own[0]!.startMs - LEAD_IN_MS));
    const end = Math.max(start, Math.min(outerEnd, own.at(-1)!.endMs + TAIL_OUT_MS));
    return {
      startMs: start,
      endMs: end,
      words: own.map((x) => ({ ...x, startMs: x.startMs - start, endMs: x.endMs - start })),
    };
  });
  return { lines };
}
