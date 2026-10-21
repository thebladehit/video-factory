import type { VoiceView } from '@vf/api';
import { useEffect, useRef, useState } from 'react';
import { SegmentRow } from './SegmentRow';

export function SegmentTable({
  view,
  lang,
  canVoice,
  onSaveText,
  onSynthesize,
}: {
  view: VoiceView;
  lang: string;
  canVoice: boolean;
  onSaveText(segmentId: string, language: string, text: string): void;
  onSynthesize(segmentId: string): void;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );

  function play(segmentId: string, url: string | null) {
    audio.current?.pause();
    if (!url) {
      setPlaying(null);
      return;
    }
    const el = new Audio(url);
    el.onended = () => setPlaying((p) => (p === segmentId ? null : p));
    el.onerror = () => setPlaying(null);
    audio.current = el;
    setPlaying(segmentId);
    void el.play().catch(() => setPlaying(null));
  }

  if (!view.segments.length)
    return (
      <p data-testid="no-segments" className="py-6 text-center text-sm text-muted-foreground">
        Сегментів ще немає — розпізнайте мову оригіналу.
      </p>
    );
  const fits = new Map((view.fits[lang] ?? []).map((f) => [f.segmentId, f]));
  return (
    <div data-testid="segment-table">
      <div className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 border-b pb-1 text-xs font-medium text-muted-foreground">
        <span>Час</span>
        <span>{view.base.toUpperCase()} · база</span>
        <span>{lang === view.base ? '—' : lang.toUpperCase()}</span>
        <span className="w-44">Озвучка</span>
      </div>
      {view.segments.map((s, i) => (
        <SegmentRow
          key={s.id}
          index={i}
          segment={s}
          base={view.base}
          lang={lang}
          baseLine={view.lines[s.id]?.[view.base]}
          line={view.lines[s.id]?.[lang]}
          fit={fits.get(s.id)}
          playing={playing === s.id}
          canVoice={canVoice}
          onSaveText={(language, text) => onSaveText(s.id, language, text)}
          onPlay={(url) => play(s.id, url)}
          onSynthesize={() => onSynthesize(s.id)}
        />
      ))}
    </div>
  );
}
