import type { Word } from '@vf/shared';
import { fontById } from './fonts';
import type { CaptionStyle } from './style';

/** Сторінка субтитрів: 1–2 рядки слів; `start`/`end` — секунди (за часом слів, що передані). */
export interface Page {
  lines: Word[][];
  start: number;
  end: number;
}

export const PAGE_BREAK_PAUSE = 0.5;
/** Частка ширини кадру, доступна для рядка (решта — поля). */
const LINE_FILL = 0.9;
const UPPERCASE_WIDEN = 1.1;
const SENTENCE_END = /[.?!…]["'”’)»]*$/;

export function layoutWords(words: Word[], style: CaptionStyle, frame: { width: number; height: number }): Page[] {
  const glyph =
    fontById(style.font).avgGlyph * (style.size / 100) * frame.height * (style.uppercase ? UPPERCASE_WIDEN : 1);
  const maxLineWidth = frame.width * LINE_FILL;
  const widthOf = (n: number) => n * glyph;

  const pages: Page[] = [];
  let lines: Word[][] = [];
  let line: Word[] = [];
  let lineChars = 0;

  const flushLine = () => {
    if (line.length) lines.push(line);
    line = [];
    lineChars = 0;
  };
  const flushPage = () => {
    flushLine();
    if (!lines.length) return;
    const all = lines.flat();
    pages.push({ lines, start: all[0]!.startMs / 1000, end: all[all.length - 1]!.endMs / 1000 });
    lines = [];
  };

  let prev: Word | undefined;
  for (const w of words) {
    if (prev && (w.startMs - prev.endMs) / 1000 > PAGE_BREAK_PAUSE) flushPage();
    const chars = [...w.text].length;
    const fits =
      line.length === 0 || (line.length < style.maxWordsPerLine && widthOf(lineChars + 1 + chars) <= maxLineWidth);
    if (!fits) {
      flushLine();
      if (lines.length >= style.maxLines) flushPage();
    }
    line.push(w);
    lineChars += (line.length > 1 ? 1 : 0) + chars;
    if (SENTENCE_END.test(w.text)) flushPage();
    prev = w;
  }
  flushPage();
  return pages;
}
