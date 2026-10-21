import type { AudioClip, MediaClip, TimelineDoc, Track } from '@vf/shared';
import {
  addVideoTrack,
  deleteClips,
  docDuration,
  findClip,
  previousClip,
  setTransition,
  snap,
  snapTargets,
  splitAt,
  trimEnd,
  trimStart,
  moveClip,
  splitSegmentAt,
} from '@vf/timeline';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { sourceLengths } from '@/editor/sources';
import type { EditorStore, UiStore } from '@/editor/store';
import type { AnyAsset } from '@/editor/types';
import { TimelineClip, TRACK_HEIGHT, type ClipGesture } from './TimelineClip';

export const ASSET_MIME = 'application/x-vf-asset';
const LABEL_W = 112;
const RULER_H = 24;
const SNAP_PX = 8;
export const MIN_PPS = 10;
export const MAX_PPS = 400;

type ClipTrack = Exclude<Track, { kind: 'captions' }>;

const ROLE_LABEL: Record<string, string> = {
  original: 'Звук відео',
  music: 'Музика',
  voiceover: 'Озвучка',
  sfx: 'Ефекти',
};

/** Зверху вниз: відео-доріжки (верхня перекриває нижню), далі звукові. */
function displayTracks(doc: TimelineDoc): { track: ClipTrack; label: string }[] {
  const video = doc.tracks.filter((t): t is Extract<Track, { kind: 'video' }> => t.kind === 'video');
  const audio = doc.tracks.filter((t): t is Extract<Track, { kind: 'audio' }> => t.kind === 'audio');
  return [
    ...video.map((track, i) => ({ track, label: `Відео ${i + 1}` })).reverse(),
    ...audio.map((track) => ({ track, label: ROLE_LABEL[track.role] ?? track.role })),
  ];
}

/** Кліп і зв'язані з ним — вибираються й рухаються разом. */
function withPartners(doc: TimelineDoc, clipId: string): string[] {
  const f = findClip(doc, clipId);
  if (!f?.clip.linkId) return [clipId];
  const out = [clipId];
  for (const t of doc.tracks)
    if (t.kind !== 'captions')
      for (const c of t.clips as (MediaClip | AudioClip)[])
        if (c.linkId === f.clip.linkId && c.id !== clipId) out.push(c.id);
  return out;
}

function tickStep(pps: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s * pps >= 64) return s;
  return 300;
}
const label = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

interface Gesture {
  kind: ClipGesture;
  clipId: string;
  x0: number;
  startDoc: TimelineDoc;
  origStart: number;
  origEnd: number;
  exclude: string[];
  overlap: number;
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export function Timeline({
  store,
  ui,
  assets,
  onSeek,
  onTogglePlay,
  onDropAssets,
  onDropFiles,
}: {
  store: EditorStore;
  ui: UiStore;
  assets: Record<string, AnyAsset>;
  onSeek(t: number): void;
  onTogglePlay(): void;
  onDropAssets(assetIds: string[], at: number, trackId?: string): void;
  onDropFiles(files: File[], at: number, trackId?: string): void;
}) {
  const doc = useStore(store, (s) => s.doc);
  const pps = useStore(ui, (s) => s.pxPerSec);
  const selected = useStore(ui, (s) => s.selected);
  const snapLine = useStore(ui, (s) => s.snapLine);
  const invalid = useStore(ui, (s) => s.invalidClips);
  const scroller = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const sources = useMemo(() => sourceLengths(assets), [assets]);
  const rows = displayTracks(doc);
  const total = docDuration(doc);
  const contentW = Math.max((total + 30) * pps, (scroller.current?.clientWidth ?? 800) - LABEL_W);

  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + el.scrollLeft - LABEL_W) / pps);
  };
  const trackAt = (clientX: number, clientY: number) =>
    document
      .elementsFromPoint(clientX, clientY)
      .map((el) => (el as HTMLElement).dataset?.trackId)
      .find(Boolean);

  /** Снепінг краю до країв кліпів, плейхеда й нуля (8 px). */
  const snapEdge = (value: number, exclude: string[]) => {
    const r = snap(
      value,
      snapTargets(gesture.current?.startDoc ?? doc, { playhead: ui.getState().playhead, exclude }),
      {
        tolerancePx: SNAP_PX,
        pxPerSec: ui.getState().pxPerSec,
      },
    );
    return r;
  };

  function onClipPointerDown(e: ReactPointerEvent, clip: MediaClip | AudioClip, kind: ClipGesture) {
    if (e.button !== 0) return;
    e.preventDefault();
    const d = store.getState().doc;
    const group = withPartners(d, clip.id);
    const cur = ui.getState().selected;
    ui.getState().set({
      selected: e.shiftKey
        ? cur.includes(clip.id)
          ? cur.filter((id) => !group.includes(id))
          : [...cur, ...group]
        : group,
    });
    const prev = kind === 'transition' ? previousClip(d, clip.id) : null;
    gesture.current = {
      kind,
      clipId: clip.id,
      x0: e.clientX,
      startDoc: d,
      origStart: clip.start,
      origEnd: clip.start + clip.duration,
      exclude: group,
      overlap: prev ? Math.max(0, prev.start + prev.duration - clip.start) : 0,
    };
    store.getState().beginGesture();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  function onMove(e: PointerEvent) {
    const g = gesture.current;
    if (!g) return;
    const pxPerSec = ui.getState().pxPerSec;
    const dt = (e.clientX - g.x0) / pxPerSec;
    let line: number | null = null;
    let next: TimelineDoc = g.startDoc;
    if (g.kind === 'move') {
      let start = g.origStart + dt;
      const dur = g.origEnd - g.origStart;
      const a = snapEdge(start, g.exclude);
      const b = snapEdge(start + dur, g.exclude);
      if (a.target !== null && (b.target === null || Math.abs(a.value - start) <= Math.abs(b.value - start - dur))) {
        start = a.value;
        line = a.target;
      } else if (b.target !== null) {
        start = b.value - dur;
        line = b.target;
      }
      next = moveClip(g.startDoc, g.clipId, start, sources, trackAt(e.clientX, e.clientY));
    } else if (g.kind === 'trim-l' || g.kind === 'trim-r') {
      const edge = (g.kind === 'trim-l' ? g.origStart : g.origEnd) + dt;
      const s = snapEdge(edge, g.exclude);
      line = s.target;
      next =
        g.kind === 'trim-l'
          ? trimStart(g.startDoc, g.clipId, s.value, sources)
          : trimEnd(g.startDoc, g.clipId, s.value, sources);
    } else {
      next = setTransition(g.startDoc, g.clipId, g.overlap - dt);
    }
    store.getState().apply(() => next);
    ui.getState().set({ snapLine: line });
  }

  function onUp() {
    window.removeEventListener('pointermove', onMove);
    gesture.current = null;
    store.getState().endGesture();
    ui.getState().set({ snapLine: null });
  }

  useEffect(() => () => window.removeEventListener('pointermove', onMove), []);

  // зум: Ctrl/⌘ + колесо навколо курсора
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const old = ui.getState().pxPerSec;
      const nextPps = Math.min(MAX_PPS, Math.max(MIN_PPS, old * Math.exp(-e.deltaY * 0.002)));
      const x = e.clientX - el.getBoundingClientRect().left - LABEL_W;
      const t = (el.scrollLeft + x) / old;
      ui.getState().set({ pxPerSec: nextPps });
      requestAnimationFrame(() => (el.scrollLeft = t * nextPps - x));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ui]);

  // клавіші редактора
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;
      const { playhead: ph, selected: sel } = ui.getState();
      const fps = store.getState().doc.fps;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.temporal.getState().redo();
        else store.temporal.getState().undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        store.temporal.getState().redo();
      } else if (mod) {
        return;
      } else if (e.code === 'KeyS' && e.shiftKey) {
        // ⇧S — розрізати сегмент озвучки під плейхедом (лише «Монтаж»; у перегляді мови зміни ігноруються)
        e.preventDefault();
        store.getState().apply((doc) => splitSegmentAt(doc, ph));
      } else if (e.code === 'KeyS') {
        e.preventDefault();
        const d = store.getState().doc;
        const under = (c: { start: number; duration: number }) => ph > c.start && ph < c.start + c.duration;
        const ids = sel.length
          ? sel
          : d.tracks.flatMap((t) => (t.kind === 'video' ? t.clips.filter(under).map((c) => c.id) : []));
        store.getState().apply((doc) => ids.reduce((acc, id) => splitAt(acc, id, ph), doc));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!sel.length) return;
        e.preventDefault();
        store.getState().apply((d) => deleteClips(d, sel));
        ui.getState().set({ selected: [] });
      } else if (e.code === 'Space') {
        e.preventDefault();
        onTogglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 1 / fps;
        onSeek(Math.max(0, ph + (e.key === 'ArrowLeft' ? -step : step)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, ui, onSeek, onTogglePlay]);

  function seekFromRuler(e: ReactPointerEvent<HTMLDivElement>) {
    onSeek(timeAt(e.clientX));
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onSeek(timeAt(ev.clientX));
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
  }

  function onDragOver(e: DragEvent) {
    const types = [...e.dataTransfer.types];
    if (!types.includes(ASSET_MIME) && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function onDrop(e: DragEvent) {
    const raw = e.dataTransfer.getData(ASSET_MIME);
    const files = [...e.dataTransfer.files];
    if (!raw && !files.length) return;
    // без stopPropagation: глобальний DropOverlay має побачити drop (defaultPrevented), щоб сховатися
    e.preventDefault();
    const at = snap(timeAt(e.clientX), snapTargets(doc, { playhead: ui.getState().playhead, exclude: [] }), {
      tolerancePx: SNAP_PX,
      pxPerSec: pps,
    }).value;
    const trackId = trackAt(e.clientX, e.clientY);
    if (raw) {
      try {
        const ids = JSON.parse(raw) as string[];
        if (Array.isArray(ids) && ids.length) onDropAssets(ids, at, trackId);
      } catch {
        // чужі дані — ігноруємо
      }
    } else onDropFiles(files, at, trackId);
  }

  const ticks: number[] = [];
  const step = tickStep(pps);
  for (let s = 0; s * pps < contentW; s += step) ticks.push(s);

  return (
    <div className="flex min-h-0 min-w-0 flex-col rounded-md border bg-background">
      <div className="flex items-center gap-3 border-b px-2 py-1">
        <Button size="sm" variant="ghost" onClick={() => store.getState().apply((d) => addVideoTrack(d))}>
          <Plus /> доріжка відео
        </Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Масштаб
          <input
            data-testid="zoom"
            type="range"
            min={MIN_PPS}
            max={MAX_PPS}
            value={Math.round(pps)}
            onChange={(e) => ui.getState().set({ pxPerSec: Number(e.target.value) })}
            className="w-32"
          />
        </label>
      </div>
      <div
        ref={scroller}
        data-testid="timeline"
        className="relative min-h-0 flex-1 overflow-auto"
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <div className="relative" style={{ width: LABEL_W + contentW }}>
          <div className="sticky top-0 z-20 flex bg-background" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-10 shrink-0 border-r bg-background" style={{ width: LABEL_W }} />
            <div
              data-testid="ruler"
              className="relative flex-1 cursor-pointer border-b text-[10px] text-muted-foreground"
              onPointerDown={seekFromRuler}
            >
              {ticks.map((s) => (
                <span key={s} className="absolute top-0 h-full border-l pl-1" style={{ left: s * pps }}>
                  {label(s)}
                </span>
              ))}
            </div>
          </div>
          {rows.map(({ track, label: name }) => {
            const clips = [...(track.clips as (MediaClip | AudioClip)[])].sort((a, b) => a.start - b.start);
            return (
              <div
                key={track.id}
                data-testid={`track-${track.kind}`}
                data-role={track.kind === 'audio' ? track.role : undefined}
                className="flex border-b"
                style={{ height: TRACK_HEIGHT }}
              >
                <div
                  className="sticky left-0 z-10 flex shrink-0 items-center border-r bg-muted px-2 text-xs font-medium"
                  style={{ width: LABEL_W }}
                >
                  {name}
                </div>
                <div
                  data-track-id={track.id}
                  className="relative flex-1"
                  onPointerDown={(e) => {
                    if (e.target === e.currentTarget) ui.getState().set({ selected: [] });
                  }}
                >
                  {clips.map((clip, i) => (
                    <TimelineClip
                      key={clip.id}
                      clip={clip}
                      trackKind={track.kind}
                      asset={assets[clip.assetId]}
                      pxPerSec={pps}
                      selected={selected.includes(clip.id)}
                      invalid={invalid.includes(clip.id)}
                      hasPrevious={i > 0}
                      onPointerDown={(e, kind) => onClipPointerDown(e, clip, kind)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {!rows.length && (
            <div
              className="flex h-28 items-center justify-center text-sm text-muted-foreground"
              style={{ marginLeft: LABEL_W }}
            >
              Перетягніть сюди файли з бібліотеки або з комп'ютера
            </div>
          )}
          <Playhead ui={ui} pps={pps} />
          {snapLine !== null && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-amber-400"
              style={{ left: LABEL_W + snapLine * pps }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Окремий компонент: під час програвання оновлюється лише лінія, а не всі доріжки й кліпи. */
function Playhead({ ui, pps }: { ui: UiStore; pps: number }) {
  const playhead = useStore(ui, (s) => s.playhead);
  return (
    <div
      data-testid="playhead"
      className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-red-500"
      style={{ left: LABEL_W + playhead * pps }}
    />
  );
}
