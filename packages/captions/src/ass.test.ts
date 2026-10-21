import { describe, expect, it } from 'vitest';
import { emptyTimeline, type TimelineDoc } from '@vf/shared';
import { PRESETS, toAss, type CaptionStyle } from './index';

const words = (texts: string[], t0 = 0) =>
  texts.map((text, i) => ({ text, startMs: t0 + i * 400, endMs: t0 + i * 400 + 350 }));

// озвучка стартує на 10 с таймлайну, береться з 1 с транскрипту, видно 2 с
const docWith = (styleId: string): TimelineDoc => ({
  ...emptyTimeline('9:16'),
  tracks: [
    {
      id: 'v',
      kind: 'audio',
      role: 'voiceover',
      language: 'en',
      clips: [{ id: 'a1', assetId: 'x', start: 10, duration: 2, in: 1, volume: 1 }],
    },
    {
      id: 'c',
      kind: 'captions',
      language: 'en',
      clips: [{ id: 'c1', audioClipId: 'a1', transcriptId: 't1', styleId }],
    },
  ],
});
// слова: 0,0 .. 3,2 с (8 слів по 0,4 с); видно [1, 3)
const tr = { t1: { words: words(['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']) } };
const dialogues = (ass: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
const custom = (over: Partial<CaptionStyle>): Record<string, CaptionStyle> => ({
  s: { ...PRESETS[3]!.style, maxWordsPerLine: 8, maxLines: 1, ...over },
});

describe('toAss', () => {
  it('header has PlayRes of the doc and WrapStyle 2', () => {
    const ass = toAss({ doc: docWith('preset:classic'), transcripts: tr, styles: {} });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('WrapStyle: 2');
  });

  it('style line: font, ABGR colors, outline, alignment; box -> BorderStyle 3', () => {
    const styles = custom({
      font: 'oswald',
      color: '#112233',
      activeColor: '#445566',
      outline: { color: '#AABBCC', width: 6 },
      box: { enabled: false, color: '#000000', opacity: 1 },
      position: { align: 'top', marginY: 10 },
      animation: 'none',
    });
    const line = toAss({ doc: docWith('s'), transcripts: tr, styles })
      .split('\n')
      .find((l) => l.startsWith('Style:'))!;
    const f = line.replace('Style: ', '').split(',');
    expect(f[1]).toBe('Oswald');
    expect(f[3]).toBe('&H00332211');
    expect(f[5]).toBe('&H00CCBBAA');
    expect(f[15]).toBe('1'); // BorderStyle
    expect(f[16]).toBe('10.67'); // Outline, 1080p -> PlayRes
    expect(f[18]).toBe('8'); // top
    expect(f[21]).toBe('192'); // MarginV 10 %

    const box = toAss({ doc: docWith('preset:classic'), transcripts: tr, styles: {} })
      .split('\n')
      .find((l) => l.startsWith('Style:'))!;
    const b = box.replace('Style: ', '').split(',');
    expect(b[15]).toBe('3');
    expect(b[5]).toBe('&H66000000'); // 60 % непрозорості
  });

  it('word timing = clip.start + word.startMs/1000 - clip.in; words outside the clip window are dropped', () => {
    const ass = toAss({
      doc: docWith('s'),
      transcripts: tr,
      styles: custom({ animation: 'none', maxWordsPerLine: 8 }),
    });
    const d = dialogues(ass);
    // слова з початком у [1, 3): w3 (1,2) w4 (1,6) w5 (2,0) w6 (2,4) w7 (2,8); w0..w2 раніше
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('w3 w4 w5 w6 w7');
    expect(d[0]).not.toContain('w2');
    // w3 на 1,2 с транскрипту -> 10 + 0,2 = 10,2 с; кінець w7 (3,15 с) обрізано вікном кліпа -> 3,0 -> 12,0 с
    expect(d[0]).toContain('Dialogue: 0,0:00:10.20,0:00:12.00,');
  });

  it('highlight: one Dialogue per word with the active colour on that word only', () => {
    const d = dialogues(
      toAss({
        doc: docWith('s'),
        transcripts: tr,
        styles: custom({ animation: 'highlight', activeColor: '#FF0000', color: '#00FF00' }),
      }),
    );
    expect(d).toHaveLength(5);
    expect(d[0]).toContain('{\\1c&H0000FF&}w3{\\1c&H00FF00&} w4 w5 w6 w7');
    expect(d[1]).toContain('w3 {\\1c&H0000FF&}w4{\\1c&H00FF00&} w5');
    // активне слово триває до початку наступного
    expect(d[0]).toContain('0:00:10.20,0:00:10.60');
  });

  it('pop: scale animation on the active word', () => {
    const d = dialogues(toAss({ doc: docWith('s'), transcripts: tr, styles: custom({ animation: 'pop' }) }));
    expect(d).toHaveLength(5);
    expect(d[0]).toContain('\\t(0,60,\\fscx115\\fscy115)\\t(60,120,\\fscx100\\fscy100)');
  });

  it('pop: scale is reset after the active word so the following words stay normal', () => {
    const d = dialogues(toAss({ doc: docWith('s'), transcripts: tr, styles: custom({ animation: 'pop' }) }));
    // the tag block after the active word resets the scale (a block with the bare reset, not the \\t one)
    expect(d[0]).toMatch(/\{[^}]*\\1c[^}]*\\fscx100\\fscy100\}/);
  });

  it('karaoke: \\kf durations in centiseconds, primary/secondary swapped', () => {
    const ass = toAss({
      doc: docWith('s'),
      transcripts: tr,
      styles: custom({ animation: 'karaoke', color: '#FFFFFF', activeColor: '#FF0000' }),
    });
    const d = dialogues(ass);
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('{\\kf40}w3 {\\kf40}w4 {\\kf40}w5 {\\kf40}w6 {\\kf20}w7');
    const f = ass
      .split('\n')
      .find((l) => l.startsWith('Style:'))!
      .replace('Style: ', '')
      .split(',');
    expect(f[3]).toBe('&H000000FF'); // Primary = активний
    expect(f[4]).toBe('&H00FFFFFF');
  });

  it('uppercase is applied in the text; two lines are joined with \\N', () => {
    const d = dialogues(
      toAss({
        doc: docWith('s'),
        transcripts: tr,
        styles: custom({ animation: 'none', uppercase: true, maxWordsPerLine: 2, maxLines: 2 }),
      }),
    );
    expect(d[0]).toContain('W3 W4\\NW5 W6');
  });

  it('escapes braces and backslashes in text', () => {
    const t = { t1: { words: [{ text: 'a{b}c\\Nd', startMs: 1000, endMs: 1400 }] } };
    const d = dialogues(toAss({ doc: docWith('s'), transcripts: t, styles: custom({ animation: 'none' }) }));
    // `{`/`}` -> `\{`/`\}`; `\` + WORD JOINER, щоб `\N` у тексті не став переносом
    expect(d[0]).toMatch(/,a\\\{b\\\}c\\\u2060Nd$/);
  });

  it('skips caption clips with a missing transcript or audio clip', () => {
    expect(dialogues(toAss({ doc: docWith('s'), transcripts: {}, styles: custom({}) }))).toHaveLength(0);
  });
});
