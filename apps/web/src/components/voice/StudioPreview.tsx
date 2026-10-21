import { useQueryClient } from '@tanstack/react-query';
import type { CaptionStyle } from '@vf/captions';
import { useEffect, useMemo, useRef } from 'react';
import { PreviewPane } from '@/components/editor/PreviewPane';
import type { PreviewEngine } from '@/editor/preview-engine';
import type { UiStore } from '@/editor/store';
import { useTRPC } from '@/lib/trpc';
import { draftSubtitles } from '@/voice/draft-ass';
import { useLocalized } from '@/voice/use-voice';

/**
 * Прев'ю мови: `voice.localized` (документ, озвучка, ASS) у тому самому рушії, що й редактор.
 * `draft` — стиль із редактора стилю: ASS перебудовується з ним (живе прев'ю на поточному кадрі).
 */
export function StudioPreview({
  projectId,
  language,
  engine,
  ui,
  draft,
}: {
  projectId: string;
  language: string;
  engine: PreviewEngine;
  ui: UiStore;
  draft: CaptionStyle | null;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const localized = useLocalized(projectId, language);
  const data = localized.data;

  // той самий документ і ті самі URL (структурно) — рушій не чіпаємо, щоб не збивати відтворення
  const applied = useRef('');
  useEffect(() => {
    if (!data) return;
    const sig = JSON.stringify([data.timeline, data.assets]);
    if (sig === applied.current) return;
    applied.current = sig;
    engine.setDoc(data.timeline, data.assets);
  }, [engine, data]);

  const drafted = useMemo(
    () => (data && draft ? draftSubtitles(data.timeline, data.transcripts, draft) : null),
    [data, draft],
  );
  const ass = draft ? (drafted?.ass ?? null) : (data?.subtitles ?? null);
  useEffect(() => engine.setSubtitles(ass), [engine, ass]);

  // редактор стилю відкрито: показати кадр, де субтитри є
  const hasDraft = draft !== null;
  const firstStart = drafted?.firstStart ?? null;
  const seeked = useRef(false);
  useEffect(() => {
    if (!hasDraft) seeked.current = false;
    else if (!seeked.current && firstStart !== null) {
      seeked.current = true;
      engine.pause();
      ui.getState().set({ playing: false });
      engine.seek(firstStart + 0.05);
    }
  }, [engine, ui, hasDraft, firstStart]);

  useEffect(() => {
    // протухли підписані URL — нові разом із документом
    return engine.onRefresh(() => void qc.invalidateQueries({ queryKey: trpc.voice.localized.pathKey() }));
  }, [engine, qc, trpc]);

  // зміна мови: документ інший — зупинити
  useEffect(() => {
    engine.pause();
    ui.getState().set({ playing: false });
  }, [engine, ui, language]);

  if (localized.isError) return <p className="text-sm text-destructive">{localized.error.message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Завантаження прев’ю…</p>;
  return (
    <PreviewPane
      engine={engine}
      doc={data.timeline}
      ui={ui}
      onTogglePlay={() => {
        const playing = !ui.getState().playing;
        if (playing) engine.play();
        else engine.pause();
        ui.getState().set({ playing });
      }}
    />
  );
}
