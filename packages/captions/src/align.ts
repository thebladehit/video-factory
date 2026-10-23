import type { Word } from '@vf/shared';

export interface Token {
  text: string;
  norm: string;
}

const HAS_LETTER = /[\p{L}\p{N}]/u;

const normalize = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[’ʼ`]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, '')
    .replace(/^'+|'+$/g, '');

/**
 * Слова тексту з пунктуацією. `norm` — нижній регістр без пунктуації й дефісів, апострофи → '.
 * Шматки без літер і цифр (емодзі, тире, «%») приклеюються до попереднього слова (початкові — до наступного).
 */
export function tokenize(text: string): Token[] {
  const raw = text.split(/\s+/).filter(Boolean);
  const out: Token[] = [];
  let lead = '';
  for (const r of raw) {
    if (!HAS_LETTER.test(r)) {
      if (out.length) out[out.length - 1]!.text += ` ${r}`;
      else lead = lead ? `${lead} ${r}` : r;
      continue;
    }
    out.push({ text: lead ? `${lead} ${r}` : r, norm: normalize(r) });
    lead = '';
  }
  if (!out.length && lead) return raw.map((r) => ({ text: r, norm: '' }));
  return out;
}

function lev(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

const MAX_MERGE = 4;
const FUZZY = 0.34;

type Step =
  | { kind: 'del' }
  | { kind: 'skip' }
  | { kind: 'match'; k: number } // токен ↔ k слів STT
  | { kind: 'split'; k: number }; // k токенів ↔ слово STT

interface Span {
  startMs: number;
  endMs: number;
  /** індекси слів STT, що дали мітку */
  from: number;
  to: number;
}

const weight = (t: Token) => Math.max(1, Array.from(t.norm || t.text).length);

/** Ділить [startMs, endMs] між токенами пропорційно довжині; межі округлюються кумулятивно. */
function spread(tokens: Token[], startMs: number, endMs: number): { startMs: number; endMs: number }[] {
  const total = tokens.reduce((s, t) => s + weight(t), 0);
  let acc = 0;
  return tokens.map((t) => {
    const a = Math.round(startMs + ((endMs - startMs) * acc) / total);
    acc += weight(t);
    const b = Math.round(startMs + ((endMs - startMs) * acc) / total);
    return { startMs: a, endMs: b };
  });
}

/**
 * Слова тексту (з пунктуацією) з мітками STT: DP Levenshtein на `norm` (збіг, майже збіг,
 * злиття кількох слів STT в одне слово тексту й навпаки); незіставлені слова отримують
 * інтерпольовані мітки між сусідами. Результат монотонний і лежить у межах мовлення STT.
 */
export function alignWords(script: string, stt: Word[]): Word[] {
  return alignWordsDetailed(script, stt).words;
}

/** Як `alignWords`, але `matched[i]` = false для слів з інтерпольованими мітками (не зіставлених зі STT). */
export function alignWordsDetailed(script: string, stt: Word[]): { words: Word[]; matched: boolean[] } {
  const tokens = tokenize(script);
  const n = tokens.length;
  const m = stt.length;
  if (!n) return { words: [], matched: [] };
  const sn = stt.map((w) => normalize(w.text));

  const f: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(Infinity));
  const back: (Step | undefined)[][] = Array.from({ length: n + 1 }, () => Array<Step | undefined>(m + 1));
  f[0]![0] = 0;
  const relax = (i: number, j: number, cost: number, step: Step) => {
    if (cost < f[i]![j]!) {
      f[i]![j] = cost;
      back[i]![j] = step;
    }
  };
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = f[i]![j]!;
      if (c === Infinity) continue;
      if (i < n) relax(i + 1, j, c + 1, { kind: 'del' });
      if (j < m) relax(i, j + 1, c + (sn[j] ? 1 : 0), { kind: 'skip' });
      if (i < n && j < m && tokens[i]!.norm && sn[j]) {
        const a = tokens[i]!.norm;
        const b = sn[j]!;
        const ratio = a === b ? 0 : lev(a, b) / Math.max(Array.from(a).length, Array.from(b).length);
        if (ratio <= FUZZY) relax(i + 1, j + 1, c + 2 * ratio, { kind: 'match', k: 1 });
      }
      if (i < n && tokens[i]!.norm) {
        let cat = '';
        for (let k = 1; k <= MAX_MERGE && j + k <= m; k++) {
          cat += sn[j + k - 1]!;
          if (k > 1 && cat === tokens[i]!.norm) relax(i + 1, j + k, c, { kind: 'match', k });
        }
      }
      if (j < m && sn[j]) {
        let cat = '';
        for (let k = 1; k <= 3 && i + k <= n; k++) {
          cat += tokens[i + k - 1]!.norm;
          if (k > 1 && cat === sn[j]) relax(i + k, j + 1, c, { kind: 'split', k });
        }
      }
    }
  }

  // відновлення шляху
  const spans: (Span | null)[] = Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const s = back[i]![j]!;
    if (s.kind === 'del') i -= 1;
    else if (s.kind === 'skip') j -= 1;
    else if (s.kind === 'match') {
      spans[i - 1] = { startMs: stt[j - s.k]!.startMs, endMs: stt[j - 1]!.endMs, from: j - s.k, to: j - 1 };
      i -= 1;
      j -= s.k;
    } else {
      const part = spread(tokens.slice(i - s.k, i), stt[j - 1]!.startMs, stt[j - 1]!.endMs);
      part.forEach((p, q) => (spans[i - s.k + q] = { ...p, from: j - 1, to: j - 1 }));
      i -= s.k;
      j -= 1;
    }
  }

  const matched = spans.map((sp) => sp !== null);

  // інтерполяція незіставлених між сусідами
  const lo = m ? stt[0]!.startMs : 0;
  const hi = m ? stt[m - 1]!.endMs : 0;
  let a = 0;
  while (a < n) {
    if (spans[a]) {
      a += 1;
      continue;
    }
    let b = a;
    while (b < n && !spans[b]) b += 1;
    const prev = a > 0 ? spans[a - 1]! : null;
    const next = b < n ? spans[b]! : null;
    const firstFree = prev ? prev.to + 1 : 0;
    const lastFree = next ? next.from - 1 : m - 1;
    let start: number;
    let end: number;
    if (m && firstFree <= lastFree) {
      start = stt[firstFree]!.startMs;
      end = stt[lastFree]!.endMs;
    } else {
      start = prev ? prev.endMs : lo;
      end = next ? next.startMs : hi;
    }
    if (end < start) end = start;
    const part = spread(tokens.slice(a, b), start, end);
    part.forEach((p, q) => (spans[a + q] = { ...p, from: firstFree, to: firstFree - 1 }));
    a = b;
  }

  // монотонність і межі
  let prevStart = lo;
  const words = tokens.map((t, q) => {
    const s = spans[q]!;
    const startMs = Math.min(hi, Math.max(prevStart, lo, s.startMs));
    const endMs = Math.min(hi, Math.max(startMs, s.endMs));
    prevStart = startMs;
    return { text: t.text, startMs, endMs };
  });
  return { words, matched };
}

/**
 * Приблизні мітки без STT: слова розподіляються пропорційно довжині в межах інтервалів мовлення.
 * Слово ціле потрапляє в один інтервал (за серединою), у паузи слова не потрапляють.
 */
export function estimateWords(
  script: string,
  durationMs: number,
  speech: { startMs: number; endMs: number }[],
): Word[] {
  const tokens = tokenize(script);
  if (!tokens.length) return [];
  let iv = speech
    .map((s) => ({ startMs: Math.max(0, s.startMs), endMs: Math.min(durationMs, s.endMs) }))
    .filter((s) => s.endMs > s.startMs)
    .sort((x, y) => x.startMs - y.startMs);
  if (!iv.length) iv = [{ startMs: 0, endMs: durationMs }];
  const speechTotal = iv.reduce((s, x) => s + (x.endMs - x.startMs), 0);
  const total = tokens.reduce((s, t) => s + weight(t), 0);

  const groups: Token[][] = iv.map(() => []);
  let acc = 0;
  for (const t of tokens) {
    const mid = ((acc + weight(t) / 2) / total) * speechTotal;
    acc += weight(t);
    let k = 0;
    let edge = iv[0]!.endMs - iv[0]!.startMs;
    while (k < iv.length - 1 && mid >= edge) {
      k += 1;
      edge += iv[k]!.endMs - iv[k]!.startMs;
    }
    groups[k]!.push(t);
  }
  const out: Word[] = [];
  groups.forEach((g, k) => {
    if (!g.length) return;
    const parts = spread(g, iv[k]!.startMs, iv[k]!.endMs);
    g.forEach((t, q) => out.push({ text: t.text, ...parts[q]! }));
  });
  return out;
}
