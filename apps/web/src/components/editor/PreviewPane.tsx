import type { TimelineDoc } from '@vf/shared';
import { docDuration } from '@vf/timeline';
import { Pause, Play } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import type { PreviewEngine } from '@/editor/preview-engine';
import type { EditorStore, UiStore } from '@/editor/store';
import type { AnyAsset } from '@/editor/types';
import { TransformOverlay } from './TransformOverlay';

/** `m:ss.ff` — хвилини, секунди, кадри. */
export function formatTimecode(t: number, fps: number): string {
  const frames = Math.round(t * fps);
  const sec = Math.floor(frames / fps);
  const ff = frames % fps;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}.${String(ff).padStart(2, '0')}`;
}

export function PreviewPane({
  engine,
  doc,
  ui,
  onTogglePlay,
  store,
  assets,
}: {
  engine: PreviewEngine;
  doc: TimelineDoc;
  ui: UiStore;
  onTogglePlay(): void;
  /** Редактор: рамка розміру й позиції вибраного кліпа (без стору — лише перегляд) */
  store?: EditorStore;
  assets?: Record<string, AnyAsset>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const playhead = useStore(ui, (s) => s.playhead);
  const playing = useStore(ui, (s) => s.playing);

  useEffect(() => {
    if (canvas.current) engine.attach(canvas.current);
  }, [engine]);

  // внутрішній розмір полотна = відображений × devicePixelRatio
  useEffect(() => {
    const el = box.current;
    const c = canvas.current;
    if (!el || !c) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(2, Math.round(r.width * dpr));
      c.height = Math.max(2, Math.round(r.height * dpr));
      engine.redraw();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [engine, doc.width, doc.height]);

  return (
    <div className="flex min-h-0 min-w-0 flex-col items-center gap-2">
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        <div
          ref={box}
          className="relative max-h-full max-w-full bg-black shadow"
          style={{
            aspectRatio: `${doc.width} / ${doc.height}`,
            height: doc.height > doc.width ? '100%' : undefined,
            width: doc.width >= doc.height ? '100%' : undefined,
          }}
        >
          <canvas ref={canvas} data-testid="preview-canvas" className="block size-full" />
          {store && assets && <TransformOverlay engine={engine} doc={doc} ui={ui} store={store} assets={assets} />}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button size="icon" variant="outline" onClick={onTogglePlay} aria-label={playing ? 'Пауза' : 'Відтворити'}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <span data-testid="timecode" className="font-mono text-sm tabular-nums">
          {formatTimecode(playhead, doc.fps)} / {formatTimecode(docDuration(doc), doc.fps)}
        </span>
      </div>
    </div>
  );
}
