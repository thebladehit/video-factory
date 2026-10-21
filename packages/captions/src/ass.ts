import type { TimelineDoc, Word } from '@vf/shared';
import { fontById } from './fonts';
import { styledPages, type StyledPage, type TranscriptWords } from './pages';
import type { CaptionStyle } from './style';

/** `#RRGGBB` (+ прозорість 0–255, 0 = непрозорий) → `&HAABBGGRR`. */
export function assColor(hex: string, alpha = 0): string {
  const h = hex.replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H${alpha.toString(16).toUpperCase().padStart(2, '0')}${b}${g}${r}`.toUpperCase();
}
/** Колір для тегів `\1c` (без альфи): `&HBBGGRR&`. */
const tagColor = (hex: string) => `&H${assColor(hex).slice(4)}&`;

/**
 * libass не має екрана для `\` (`\\` малюється як два символи), а `\N`/`\n`/`\h` у тексті — керівні. Тому після
 * зворотної скісної ставимо невидимий WORD JOINER (U+2060): `\N` більше не розпізнається, гліф — звичайна `\`.
 * Фігурні дужки libass екранує сам (`\{`, `\}`).
 */
export function assEscape(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\u2060')
    .replace(/[{}]/g, (c) => `\\${c}`);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

const ALIGN = { bottom: 2, middle: 5, top: 8 } as const;

function styleLine(name: string, s: CaptionStyle, height: number): string {
  const fontSize = (s.size / 100) * height;
  const k = height / 1080;
  const karaoke = s.animation === 'karaoke';
  // \kf заливає від SecondaryColour до PrimaryColour: «співане» = активний колір
  const primary = karaoke ? s.activeColor : s.color;
  const secondary = s.color;
  const boxed = s.box.enabled;
  const outlineColor = boxed ? assColor(s.box.color, Math.round((1 - s.box.opacity) * 255)) : assColor(s.outline.color);
  const outline = boxed ? Math.round(fontSize * 0.15) : Math.round(s.outline.width * k * 100) / 100;
  const shadow = Math.round(s.shadow * k * 100) / 100;
  const marginV = Math.round((s.position.marginY / 100) * height);
  return [
    `Style: ${name}`,
    fontById(s.font).family,
    Math.round(fontSize * 100) / 100,
    assColor(primary),
    assColor(secondary),
    outlineColor,
    assColor('#000000', 0x80),
    -1,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    boxed ? 3 : 1,
    outline,
    shadow,
    ALIGN[s.position.align],
    0,
    0,
    marginV,
    1,
  ].join(',');
}

type Ev = { start: number; end: number; style: string; text: string };

const wordText = (w: Word, s: CaptionStyle) => assEscape(s.uppercase ? w.text.toUpperCase() : w.text);

function pageEvents(sp: StyledPage, name: string): Ev[] {
  const { page, style: s } = sp;
  const flat = page.lines.flat();
  const lineOf = new Map<Word, number>();
  page.lines.forEach((l, i) => l.forEach((w) => lineOf.set(w, i)));
  const sep = (i: number) => (i === 0 ? '' : lineOf.get(flat[i]!) !== lineOf.get(flat[i - 1]!) ? '\\N' : ' ');

  if (s.animation === 'none') {
    const text = flat.map((w, i) => sep(i) + wordText(w, s)).join('');
    return [{ start: page.start, end: page.end, style: name, text }];
  }

  if (s.animation === 'karaoke') {
    // кумулятивне округлення до сотих, щоб сума збігалась із тривалістю сторінки
    let prevCs = 0;
    const text = flat
      .map((w, i) => {
        const nextStart = i + 1 < flat.length ? flat[i + 1]!.startMs / 1000 : page.end;
        const cs = Math.max(0, Math.round((nextStart - page.start) * 100));
        const dur = cs - prevCs;
        prevCs = cs;
        return `${sep(i)}{\\kf${dur}}${wordText(w, s)}`;
      })
      .join('');
    return [{ start: page.start, end: page.end, style: name, text }];
  }

  // highlight / pop: окрема подія на кожне слово, активне слово — окремим кольором
  const active =
    s.animation === 'pop'
      ? `{\\1c${tagColor(s.activeColor)}\\t(0,60,\\fscx115\\fscy115)\\t(60,120,\\fscx100\\fscy100)}`
      : `{\\1c${tagColor(s.activeColor)}}`;
  const reset = `{\\1c${tagColor(s.color)}}`;
  return flat.map((_, k) => {
    const start = k === 0 ? page.start : flat[k]!.startMs / 1000;
    const end = k + 1 < flat.length ? flat[k + 1]!.startMs / 1000 : page.end;
    const text = flat
      .map((w, i) => sep(i) + (i === k ? `${active}${wordText(w, s)}${reset}` : wordText(w, s)))
      .join('');
    return { start, end, style: name, text };
  });
}

export function toAss(input: {
  doc: TimelineDoc;
  transcripts: Record<string, TranscriptWords>;
  styles: Record<string, CaptionStyle>;
}): string {
  const { doc } = input;
  const pages = styledPages(doc, input.transcripts, input.styles);
  const names = new Map<string, string>();
  const styleLines: string[] = [];
  for (const p of pages) {
    if (names.has(p.styleId)) continue;
    const name = `S${names.size + 1}`;
    names.set(p.styleId, name);
    styleLines.push(styleLine(name, p.style, doc.height));
  }
  const events = pages.flatMap((p) => pageEvents(p, names.get(p.styleId)!));
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${doc.width}`,
    `PlayResY: ${doc.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`),
    '',
  ].join('\n');
}
