import type { TimelineDoc, Word } from '@vf/shared';
import { layoutWords, type Page } from './layout';
import { resolveStyle } from './presets';
import type { CaptionStyle } from './style';

export interface TranscriptWords {
  words: Word[];
}

export interface StyledPage {
  styleId: string;
  style: CaptionStyle;
  page: Page;
}

const EPS = 1e-6;

/**
 * Сторінки субтитрів усіх доріжок `captions` у секундах таймлайну. Кожен кліп субтитрів посилається на кліп
 * озвучки (`audioClipId`): слово на таймлайні = `audio.start + word.startMs/1000 − audio.in`, слова поза
 * видимим вікном кліпа `[in, in + duration)` відкидаються, кінець слова обрізається по вікну.
 */
export function styledPages(
  doc: TimelineDoc,
  transcripts: Record<string, TranscriptWords>,
  styles: Record<string, CaptionStyle>,
): StyledPage[] {
  const audio = new Map(doc.tracks.flatMap((t) => (t.kind === 'audio' ? t.clips : [])).map((c) => [c.id, c]));
  const out: StyledPage[] = [];
  for (const track of doc.tracks) {
    if (track.kind !== 'captions') continue;
    for (const cc of track.clips) {
      const clip = audio.get(cc.audioClipId);
      const transcript = transcripts[cc.transcriptId];
      if (!clip || !transcript) continue;
      const style = resolveStyle(cc.styleId, styles);
      const winEnd = clip.in + clip.duration;
      const shift = (clip.start - clip.in) * 1000;
      const words = transcript.words
        .filter((w) => w.startMs / 1000 >= clip.in - EPS && w.startMs / 1000 < winEnd - EPS)
        .map((w) => ({
          text: w.text,
          startMs: w.startMs + shift,
          endMs: Math.min(w.endMs, winEnd * 1000) + shift,
        }));
      for (const page of layoutWords(words, style, doc)) out.push({ styleId: cc.styleId, style, page });
    }
  }
  return out.sort((a, b) => a.page.start - b.page.start);
}

export const captionPages = (
  doc: TimelineDoc,
  transcripts: Record<string, TranscriptWords>,
  styles: Record<string, CaptionStyle>,
): Page[] => styledPages(doc, transcripts, styles).map((p) => p.page);
