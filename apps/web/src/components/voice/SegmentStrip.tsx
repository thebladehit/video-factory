import {
  deleteSegment,
  docDuration,
  mergeSegments,
  restoreSegmentVoice,
  splitSegmentAt,
  syncVoiceTrack,
  voiceTrackOf,
  type VoiceTake,
} from '@vf/timeline';
import { Combine, Redo2, Scissors, Trash2, Undo2, Volume2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import type { EditorStore, UiStore } from '@/editor/store';
import { dragSegmentEdge } from '@/voice/segment-drag';

const SNAP_PX = 8;
const MAX_ZOOM = 16;

interface Drag {
  id: string;
  edge: 'start' | 'end';
  startDoc: ReturnType<EditorStore['getState']>['doc'];
}

const label = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Смуга сегментів над шкалою часу: межі тягнуться (снепінг 8 px до країв кліпів і плейхеда), розрізати під плейхедом,
 * злити з наступним, видалити; кліп озвучки сегмента видалено вручну — «Повернути озвучку».
 * Усе — через стор документа (undo/redo — zundo, збереження — автозбереження).
 * Спільна для студії й редактора: `pxPerSec` задано — масштаб редактора; інакше вписується в ширину (з масштабуванням).
 */
export function SegmentStrip({
  store,
  ui,
  pxPerSec,
  onSeek,
  voice,
}: {
  store: EditorStore;
  ui: UiStore;
  pxPerSec?: number;
  onSeek?(t: number): void;
  /** Озвучка базової мови: її готові дублі (для «Повернути озвучку») */
  voice?: { language: string; takes: VoiceTake[]; pending: string[] };
}) {
  const doc = useStore(store, (s) => s.doc);
  const playhead = useStore(ui, (s) => s.playhead);
  const snapLine = useStore(ui, (s) => s.snapLine);
  const canUndo = useStore(store.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(store.temporal, (s) => s.futureStates.length > 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const total = docDuration(doc);
  const segments = [...(doc.segments ?? [])].sort((a, b) => a.start - b.start);
  const pps = pxPerSec ?? (total > 0 ? (Math.max(width, 100) / total) * zoom : 1);
  const contentW = Math.max(total * pps, 1);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // сегмента вже немає (видалено, undo) — вибір скидається
  useEffect(() => {
    if (selected && !segments.some((s) => s.id === selected)) setSelected(null);
  }, [segments, selected]);

  const timeAt = (clientX: number) => {
    const el = box.current!;
    return Math.max(0, (clientX - el.getBoundingClientRect().left + el.scrollLeft) / pps);
  };

  function onHandleDown(e: ReactPointerEvent<HTMLElement>, id: string, edge: 'start' | 'end') {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id, edge, startDoc: store.getState().doc };
    store.getState().beginGesture();
    setSelected(id);
  }
  function onHandleMove(e: ReactPointerEvent<HTMLElement>) {
    const g = drag.current;
    if (!g) return;
    const r = dragSegmentEdge(g.startDoc, g.id, g.edge, timeAt(e.clientX), {
      playhead: ui.getState().playhead,
      pxPerSec: pps,
      tolerancePx: SNAP_PX,
    });
    store.getState().apply(() => r.doc);
    ui.getState().set({ snapLine: r.snapLine });
  }
  function onHandleUp() {
    if (!drag.current) return;
    drag.current = null;
    store.getState().endGesture();
    ui.getState().set({ snapLine: null });
  }

  const idx = segments.findIndex((s) => s.id === selected);
  const next = idx >= 0 ? segments[idx + 1] : undefined;
  const apply = (op: Parameters<ReturnType<EditorStore['getState']>['apply']>[0]) => store.getState().apply(op);
  const voiceRemoved = new Set(voice ? (voiceTrackOf(doc, voice.language)?.removedSegments ?? []) : []);
  /** Сегмент знову озвучується: зі списку вручну видалених і одразу кліп дубля — один крок історії */
  const restoreVoice = (id: string) =>
    voice &&
    apply(
      (d) =>
        syncVoiceTrack(restoreSegmentVoice(d, voice.language, id), {
          language: voice.language,
          takes: voice.takes,
          pending: voice.pending,
        }).doc,
    );

  return (
    <div data-testid="segment-strip" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          data-testid="split-segment"
          title="Розрізати сегмент під плейхедом або створити новий на вільному місці"
          disabled={total <= 0}
          onClick={() => apply((d) => splitSegmentAt(d, ui.getState().playhead))}
        >
          <Scissors /> Розрізати під плейхедом
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="merge-segment"
          disabled={!next}
          title={selected && !next ? 'Це останній сегмент' : undefined}
          onClick={() => selected && next && apply((d) => mergeSegments(d, selected, next.id))}
        >
          <Combine /> Злити з наступним
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="delete-segment"
          disabled={!selected}
          onClick={() => selected && apply((d) => deleteSegment(d, selected))}
        >
          <Trash2 /> Видалити
        </Button>
        {selected && voiceRemoved.has(selected) && (
          <Button
            size="sm"
            variant="outline"
            data-testid="restore-voice"
            title="Кліп озвучки цього сегмента видалено вручну — повернути його на доріжку"
            onClick={() => restoreVoice(selected)}
          >
            <Volume2 /> Повернути озвучку
          </Button>
        )}
        <span className="ml-auto flex items-center">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Скасувати"
            disabled={!canUndo}
            onClick={() => store.temporal.getState().undo()}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Повторити"
            disabled={!canRedo}
            onClick={() => store.temporal.getState().redo()}
          >
            <Redo2 />
          </Button>
          {pxPerSec === undefined && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Зменшити масштаб"
                disabled={zoom <= 1}
                onClick={() => setZoom((z) => Math.max(1, z / 2))}
              >
                <ZoomOut />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Збільшити масштаб"
                disabled={zoom >= MAX_ZOOM}
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 2))}
              >
                <ZoomIn />
              </Button>
            </>
          )}
        </span>
      </div>

      <div ref={box} className="overflow-x-auto rounded-md border bg-muted/30">
        <div
          className="relative h-16 select-none"
          style={{ width: contentW }}
          onPointerDown={(e) => {
            const t = Math.min(timeAt(e.clientX), total);
            setSelected(null);
            ui.getState().set({ playhead: t });
            onSeek?.(t);
          }}
        >
          {/* лінійка */}
          {total > 0 &&
            Array.from({ length: Math.floor(total / tick(pps)) + 1 }, (_, i) => i * tick(pps)).map((t) => (
              <div
                key={t}
                className="absolute top-0 h-4 border-l border-border pl-1 text-[10px] text-muted-foreground"
                style={{ left: t * pps }}
              >
                {label(t)}
              </div>
            ))}
          {/* сегменти */}
          {segments.map((s, i) => (
            <div
              key={s.id}
              data-testid="strip-segment"
              data-id={s.id}
              data-selected={s.id === selected}
              data-voice-removed={voiceRemoved.has(s.id) || undefined}
              title={voiceRemoved.has(s.id) ? 'Озвучку сегмента видалено вручну' : undefined}
              className={`absolute top-4 h-10 overflow-hidden rounded border text-[10px] leading-none ${
                s.id === selected ? 'border-primary bg-primary/30' : 'border-sky-500/60 bg-sky-500/20'
              }`}
              style={{ left: s.start * pps, width: Math.max((s.end - s.start) * pps, 2) }}
              onPointerDown={(e) => {
                e.stopPropagation();
                setSelected(s.id);
                const t = Math.min(timeAt(e.clientX), total);
                ui.getState().set({ playhead: t });
                onSeek?.(t);
              }}
            >
              <span className="pointer-events-none absolute left-2 top-1 truncate">{i + 1}</span>
              {(['start', 'end'] as const).map((edge) => (
                <div
                  key={edge}
                  data-testid={`strip-handle-${edge}`}
                  className={`absolute top-0 h-full w-2 cursor-ew-resize bg-primary/40 hover:bg-primary/70 ${edge === 'start' ? 'left-0' : 'right-0'}`}
                  onPointerDown={(e) => onHandleDown(e, s.id, edge)}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                  onPointerCancel={onHandleUp}
                />
              ))}
            </div>
          ))}
          {snapLine !== null && (
            <div
              className="pointer-events-none absolute top-0 h-full border-l border-dashed border-amber-500"
              style={{ left: snapLine * pps }}
            />
          )}
          <div
            data-testid="strip-playhead"
            className="pointer-events-none absolute top-0 h-full border-l-2 border-red-500"
            style={{ left: Math.min(playhead, total) * pps }}
          />
        </div>
      </div>
      {!segments.length && total > 0 && (
        <p className="text-xs text-muted-foreground">
          Сегментів ще немає — «Вставити текст», «Розпізнати мову оригіналу» або «Розрізати під плейхедом».
        </p>
      )}
    </div>
  );
}

function tick(pps: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s * pps >= 48) return s;
  return 300;
}
