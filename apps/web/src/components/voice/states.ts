import type { VoiceLineView, VoiceView } from '@vf/api';

export type LineState = VoiceLineView['state'];
export type LangState = 'ready' | 'stale' | 'failed' | 'partial' | 'empty';

export const LINE_STATE_LABEL: Record<LineState, string> = {
  empty: 'порожній',
  queued: 'у черзі',
  running: 'озвучується',
  ready: 'готово',
  stale: 'застарілий',
  failed: 'помилка',
};

export const LINE_STATE_DOT: Record<LineState, string> = {
  empty: 'bg-muted-foreground/40',
  queued: 'bg-sky-500',
  running: 'bg-sky-500 animate-pulse',
  ready: 'bg-emerald-500',
  stale: 'bg-amber-500',
  failed: 'bg-destructive',
};

export const LANG_STATE_LABEL: Record<LangState, string> = {
  ready: 'усі готові',
  stale: 'є застарілі',
  failed: 'є помилки',
  partial: 'озвучено частково',
  empty: 'не озвучено',
};

export const LANG_STATE_DOT: Record<LangState, string> = {
  ready: 'bg-emerald-500',
  stale: 'bg-amber-500',
  failed: 'bg-destructive',
  partial: 'bg-sky-500',
  empty: 'bg-muted-foreground/40',
};

/** Стан мови за її рядками з текстом: помилки важливіші за застарілі, застарілі — за часткові. */
export function languageState(view: VoiceView, code: string): { state: LangState; busy: boolean } {
  const lines = view.segments.flatMap((s) => {
    const l = view.lines[s.id]?.[code];
    return l?.text.trim() ? [l] : [];
  });
  const busy = lines.some((l) => l.state === 'queued' || l.state === 'running');
  if (!lines.length) return { state: 'empty', busy };
  if (lines.some((l) => l.state === 'failed')) return { state: 'failed', busy };
  if (lines.some((l) => l.state === 'stale')) return { state: 'stale', busy };
  if (lines.every((l) => l.state === 'ready')) return { state: 'ready', busy };
  return { state: lines.some((l) => l.state === 'ready') ? 'partial' : 'empty', busy };
}
