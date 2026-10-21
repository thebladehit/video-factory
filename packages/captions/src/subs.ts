import type { Page } from './layout';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function stamp(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}

const text = (p: Page) => p.lines.map((l) => l.map((w) => w.text).join(' ')).join('\n');

export function toSrt(pages: Page[]): string {
  return pages.map((p, i) => `${i + 1}\n${stamp(p.start, ',')} --> ${stamp(p.end, ',')}\n${text(p)}\n`).join('\n');
}

export function toVtt(pages: Page[]): string {
  return `WEBVTT\n\n${pages.map((p) => `${stamp(p.start, '.')} --> ${stamp(p.end, '.')}\n${text(p)}\n`).join('\n')}`;
}
