import type { VoiceLineView } from '@vf/api';
import type { Segment } from '@vf/shared';
import type { SegmentFit } from '@vf/timeline';
import { Loader2, Pause, Play, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatFit } from '@/voice/cost';
import { LINE_STATE_DOT, LINE_STATE_LABEL } from './states';

export const MAX_LINE_CHARS = 1500;
const SAVE_DEBOUNCE_MS = 600;

const mmss = (t: number) => {
  const s = Math.round(t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Текст на місці: збереження з debounce 600 мс і одразу при втраті фокуса; чужі зміни — лише коли немає правок. */
function EditableText({
  value,
  label,
  onSave,
}: {
  value: string;
  label: string;
  onSave(text: string): void;
}) {
  const [text, setText] = useState(value);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const save = useRef(onSave);
  save.current = onSave;
  const latest = useRef(text);
  latest.current = text;
  const current = useRef(value);
  current.current = value;

  useEffect(() => {
    if (!dirty.current) setText(value);
    else if (value === latest.current) dirty.current = false;
  }, [value]);
  const flush = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    if (latest.current === current.current) {
      dirty.current = false;
      return;
    }
    save.current(latest.current);
  };
  // розмонтування (зміна мови, вихід зі сторінки) не губить правку
  useEffect(() => () => flush(), []);

  return (
    <div className="grid gap-0.5">
      <Textarea
        aria-label={label}
        value={text}
        rows={2}
        maxLength={MAX_LINE_CHARS}
        className="min-h-0 resize-none text-sm"
        onChange={(e) => {
          setText(e.target.value);
          latest.current = e.target.value;
          dirty.current = true;
          clearTimeout(timer.current);
          timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
        }}
        onBlur={flush}
      />
      {text.length > MAX_LINE_CHARS * 0.9 && (
        <span className="text-right text-[10px] text-muted-foreground">
          {text.length} / {MAX_LINE_CHARS}
        </span>
      )}
    </div>
  );
}

export function SegmentRow({
  index,
  segment,
  base,
  lang,
  baseLine,
  line,
  fit,
  playing,
  canVoice,
  voiceHint,
  onSaveText,
  onPlay,
  onSynthesize,
}: {
  index: number;
  segment: Segment;
  base: string;
  lang: string;
  baseLine?: VoiceLineView;
  line?: VoiceLineView;
  fit?: SegmentFit;
  playing: boolean;
  canVoice: boolean;
  voiceHint: string;
  onSaveText(language: string, text: string): void;
  onPlay(url: string | null): void;
  onSynthesize(): void;
}) {
  const showLang = lang !== base;
  // озвучка рядка вибраної мови (для базової — її власний рядок)
  const voiced = showLang ? line : baseLine;
  const state = voiced?.state ?? 'empty';
  const busy = state === 'queued' || state === 'running';
  const hasText = !!voiced?.text.trim();
  const url = voiced?.audioUrl ?? null;
  const canListen = !!url && (state === 'ready' || state === 'stale');

  return (
    <div
      data-testid="segment-row"
      data-segment-id={segment.id}
      data-state={state}
      className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2 border-b py-2"
    >
      <div className="font-mono text-xs tabular-nums text-muted-foreground">
        <div>#{index + 1}</div>
        <div>
          {mmss(segment.start)}–{mmss(segment.end)}
        </div>
      </div>
      <EditableText
        value={baseLine?.text ?? ''}
        label={`Текст ${base.toUpperCase()}, сегмент ${index + 1}`}
        onSave={(t) => onSaveText(base, t)}
      />
      {showLang ? (
        <EditableText
          value={line?.text ?? ''}
          label={`Текст ${lang.toUpperCase()}, сегмент ${index + 1}`}
          onSave={(t) => onSaveText(lang, t)}
        />
      ) : (
        <div className="self-center text-xs text-muted-foreground">Виберіть іншу мову, щоб бачити переклад</div>
      )}
      <div className="grid w-44 gap-1 text-xs">
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={!canListen}
            aria-label={playing ? 'Зупинити' : 'Прослухати озвучку'}
            onClick={() => onPlay(playing ? null : url)}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={!hasText || busy || !canVoice}
            title={!canVoice ? voiceHint : 'Переозвучити'}
            aria-label="Переозвучити"
            onClick={onSynthesize}
          >
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
          <span data-testid="line-state" className="flex items-center gap-1">
            <span className={`size-2 rounded-full ${LINE_STATE_DOT[state]}`} />
            {LINE_STATE_LABEL[state]}
          </span>
        </div>
        {voiced?.audioDeleted && <span className="text-amber-600">озвучку видалено</span>}
        {state === 'failed' && (
          <div className="grid gap-1">
            {voiced?.error && (
              <span className="line-clamp-3 text-destructive" title={voiced.error}>
                {voiced.error}
              </span>
            )}
            <Button size="sm" variant="outline" className="h-6 w-fit" disabled={!canVoice} onClick={onSynthesize}>
              Повторити
            </Button>
          </div>
        )}
        {showLang && fit && <span className="text-muted-foreground">{formatFit(fit, lang)}</span>}
      </div>
    </div>
  );
}
