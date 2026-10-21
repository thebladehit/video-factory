import { describe, expect, it } from 'vitest';
import { alignWords, estimateWords, tokenize } from './index';

const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });

describe('tokenize', () => {
  it('splits words, keeps punctuation in text and normalizes norm', () => {
    expect(tokenize('Привіт, Світе! Харків-Сіті п’ять')).toEqual([
      { text: 'Привіт,', norm: 'привіт' },
      { text: 'Світе!', norm: 'світе' },
      { text: 'Харків-Сіті', norm: 'харківсіті' },
      { text: 'п’ять', norm: "п'ять" },
    ]);
  });

  it('attaches tokens without letters or digits (dashes, emoji) to the previous word', () => {
    expect(tokenize('Це 🚀, добре — так')).toEqual([
      { text: 'Це 🚀,', norm: 'це' },
      { text: 'добре —', norm: 'добре' },
      { text: 'так', norm: 'так' },
    ]);
  });

  it('attaches a leading symbol to the next word', () => {
    expect(tokenize('— так')).toEqual([{ text: '— так', norm: 'так' }]);
  });

  it('empty text gives no tokens', () => {
    expect(tokenize('  ')).toEqual([]);
  });
});

describe('alignWords', () => {
  it('exact match takes the STT timings and keeps script text', () => {
    const r = alignWords('Hello, world!', [w('hello', 100, 400), w('world', 500, 900)]);
    expect(r).toEqual([w('Hello,', 100, 400), w('world!', 500, 900)]);
  });

  it('interpolates a word the STT missed between its neighbours', () => {
    const r = alignWords('one two three', [w('one', 0, 300), w('three', 700, 1000)]);
    expect(r.map((x) => x.text)).toEqual(['one', 'two', 'three']);
    expect(r[0]).toEqual(w('one', 0, 300));
    expect(r[2]).toEqual(w('three', 700, 1000));
    expect(r[1]!.startMs).toBeGreaterThanOrEqual(300);
    expect(r[1]!.endMs).toBeLessThanOrEqual(700);
    expect(r[1]!.endMs).toBeGreaterThan(r[1]!.startMs);
  });

  it('ignores an extra STT word', () => {
    const r = alignWords('one three', [w('one', 0, 300), w('two', 350, 600), w('three', 700, 1000)]);
    expect(r).toEqual([w('one', 0, 300), w('three', 700, 1000)]);
  });

  it('a hyphenated script word spans two STT words', () => {
    const r = alignWords('у Харків-Сіті', [w('у', 0, 100), w('харків', 200, 500), w('сіті', 550, 900)]);
    expect(r).toEqual([w('у', 0, 100), w('Харків-Сіті', 200, 900)]);
  });

  it('two script words from one STT word share its span in order', () => {
    const r = alignWords('ab cd end', [w('abcd', 0, 400), w('end', 500, 800)]);
    expect(r).toHaveLength(3);
    expect(r[0]!.startMs).toBe(0);
    expect(r[1]!.endMs).toBe(400);
    expect(r[1]!.startMs).toBeGreaterThanOrEqual(r[0]!.startMs);
    expect(r[2]).toEqual(w('end', 500, 800));
  });

  it('empty STT still returns every word, empty script returns nothing', () => {
    expect(alignWords('a b', [])).toHaveLength(2);
    expect(alignWords('', [w('a', 0, 1)])).toEqual([]);
  });

  it('Review Focus 2: numbers, abbreviations, emoji and hyphens', () => {
    const script = 'У 2026 р. — 5 % зростання 🚀, Харків-Сіті';
    const stt = "у дві тисячі двадцять шостому році п'ять відсотків зростання харків сіті"
      .split(' ')
      .map((t, i) => w(t, 1000 + i * 300, 1000 + i * 300 + 250));
    const r = alignWords(script, stt);
    expect(r).toHaveLength(tokenize(script).length);
    expect(r.some((x) => x.text.trim() === '🚀,')).toBe(false);
    expect(r.find((x) => x.text.includes('🚀'))!.text).toBe('зростання 🚀,');
    const lo = stt[0]!.startMs;
    const hi = stt.at(-1)!.endMs;
    let prev = lo;
    for (const x of r) {
      expect(x.startMs).toBeGreaterThanOrEqual(prev);
      expect(x.endMs).toBeGreaterThanOrEqual(x.startMs);
      expect(x.startMs).toBeGreaterThanOrEqual(lo);
      expect(x.endMs).toBeLessThanOrEqual(hi);
      prev = x.startMs;
    }
    const last = r.at(-1)!;
    expect(last.text).toBe('Харків-Сіті');
    expect(last.endMs).toBe(hi);
  });
});

describe('estimateWords', () => {
  it('distributes words proportionally to length within the speech', () => {
    const r = estimateWords('aa bbbb', 3000, [{ startMs: 0, endMs: 3000 }]);
    expect(r).toEqual([w('aa', 0, 1000), w('bbbb', 1000, 3000)]);
  });

  it('no speech intervals: whole duration is speech', () => {
    const r = estimateWords('aa aa', 1000, []);
    expect(r[0]!.startMs).toBe(0);
    expect(r[1]!.endMs).toBe(1000);
  });

  it('no word falls into a pause between two speech intervals', () => {
    const speech = [
      { startMs: 200, endMs: 1200 },
      { startMs: 3000, endMs: 4000 },
    ];
    const r = estimateWords('one two three four', 4500, speech);
    expect(r).toHaveLength(4);
    for (const x of r) {
      const inside = speech.some((s) => x.startMs >= s.startMs && x.endMs <= s.endMs);
      expect(inside).toBe(true);
      expect(x.endMs).toBeGreaterThanOrEqual(x.startMs);
    }
    expect(r[0]!.startMs).toBe(200);
    expect(r[3]!.endMs).toBe(4000);
    for (let i = 1; i < r.length; i++) expect(r[i]!.startMs).toBeGreaterThanOrEqual(r[i - 1]!.endMs);
  });

  it('empty script gives no words', () => {
    expect(estimateWords('', 1000, [])).toEqual([]);
  });
});
