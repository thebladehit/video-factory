import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PreviewPane } from '@/components/editor/PreviewPane';
import { createCanvasPreviewEngine } from '@/editor/preview-engine';
import { createUiStore } from '@/editor/store';
import { useTRPC } from '@/lib/trpc';
import { useLocalized } from '@/voice/use-voice';

/** Прев'ю мови: `voice.localized` (документ, озвучка, ASS) у тому самому рушії, що й редактор. */
export function StudioPreview({ projectId, language }: { projectId: string; language: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [engine] = useState(createCanvasPreviewEngine);
  const [ui] = useState(createUiStore);
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
  useEffect(() => engine.setSubtitles(data?.subtitles ?? null), [engine, data?.subtitles]);

  useEffect(() => {
    const offs = [
      engine.onTime((t) => ui.getState().set({ playhead: t })),
      engine.onEnded(() => ui.getState().set({ playing: false })),
      // протухли підписані URL — нові разом із документом
      engine.onRefresh(() => void qc.invalidateQueries({ queryKey: trpc.voice.localized.pathKey() })),
    ];
    return () => {
      offs.forEach((off) => off());
      engine.destroy();
    };
  }, [engine, ui, qc, trpc]);

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
