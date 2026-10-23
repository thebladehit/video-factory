import { DEFAULT_TRANSFORM, type ClipTransform, type MediaClip, type TimelineDoc } from '@vf/shared';
import { coverRect, findClip, setClipTransform } from '@vf/timeline';
import { useRef } from 'react';
import { useStore } from 'zustand';
import type { PreviewEngine } from '@/editor/preview-engine';
import { isReadOnlyState, type EditorStore, type UiStore } from '@/editor/store';
import { isPresent, type AnyAsset } from '@/editor/types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;

type Gesture = {
  mode: 'move' | 'scale';
  startX: number;
  startY: number;
  start: ClipTransform;
  /** прямокутник кадру на екрані */
  frame: DOMRect;
};

/** Вибраний візуальний кліп під плейхедом. */
function activeClip(doc: TimelineDoc, selected: string[], t: number): MediaClip | null {
  const found = selected.length ? findClip(doc, selected[0]!) : null;
  if (!found || found.track.kind !== 'video') return null;
  const c = found.clip as MediaClip;
  return t >= c.start - 1e-6 && t < c.start + c.duration - 1e-6 ? c : null;
}

/**
 * Рамка вибраного кліпа поверх прев'ю (координати кадру → відсотки полотна): перетягування — позиція,
 * кутова ручка — розмір зі збереженням пропорцій відносно центру. Ефекти (zoom/Ken Burns) не враховуються.
 */
export function TransformOverlay({
  doc,
  ui,
  store,
  assets,
}: {
  engine?: PreviewEngine;
  doc: TimelineDoc;
  ui: UiStore;
  store: EditorStore;
  assets: Record<string, AnyAsset>;
}) {
  const selected = useStore(ui, (s) => s.selected);
  const playhead = useStore(ui, (s) => s.playhead);
  const playing = useStore(ui, (s) => s.playing);
  const readOnly = useStore(store, (s) => isReadOnlyState(s));
  const gesture = useRef<Gesture | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const clip = activeClip(doc, selected, playhead);
  if (!clip || playing || readOnly) return null;
  const asset = assets[clip.assetId];
  if (!isPresent(asset)) return null;
  const src = { width: asset.width ?? doc.width, height: asset.height ?? doc.height };
  const r = coverRect(src, { width: doc.width, height: doc.height }, clip.fit, 1, 0.5, 0.5, clip.transform);
  const cur = clip.transform ?? DEFAULT_TRANSFORM;
  const clipId = clip.id;

  const begin = (mode: Gesture['mode']) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      start: { ...cur },
      frame: root.current!.getBoundingClientRect(),
    };
    store.getState().beginGesture();
  };
  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    let next: ClipTransform;
    if (g.mode === 'move') {
      next = {
        scale: g.start.scale,
        x: clamp(g.start.x + (e.clientX - g.startX) / g.frame.width, 0, 1),
        y: clamp(g.start.y + (e.clientY - g.startY) / g.frame.height, 0, 1),
      };
    } else {
      const cx = g.frame.left + g.start.x * g.frame.width;
      const cy = g.frame.top + g.start.y * g.frame.height;
      const d0 = Math.hypot(g.startX - cx, g.startY - cy) || 1;
      const d1 = Math.hypot(e.clientX - cx, e.clientY - cy);
      next = { ...g.start, scale: clamp(g.start.scale * (d1 / d0), 0.1, 4) };
    }
    store.getState().apply((d) => setClipTransform(d, clipId, next));
  };
  const end = () => {
    if (!gesture.current) return;
    gesture.current = null;
    store.getState().endGesture();
  };

  return (
    <div ref={root} className="pointer-events-none absolute inset-0">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          data-testid="transform-box"
          className="pointer-events-auto absolute cursor-move touch-none border-2 border-primary"
          style={{
            left: `${(r.x / doc.width) * 100}%`,
            top: `${(r.y / doc.height) * 100}%`,
            width: `${(r.w / doc.width) * 100}%`,
            height: `${(r.h / doc.height) * 100}%`,
          }}
          onPointerDown={begin('move')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        ></div>
      </div>
      {CORNERS.map((c) => {
        // ручка — у куті рамки, але в межах кадру (рамка «cover» виходить за кадр)
        const px = clamp(((c.endsWith('w') ? r.x : r.x + r.w) / doc.width) * 100, 0, 100);
        const py = clamp(((c.startsWith('n') ? r.y : r.y + r.h) / doc.height) * 100, 0, 100);
        return (
          <div
            key={c}
            data-testid={`transform-handle-${c}`}
            className={`pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 touch-none border border-primary bg-background ${
              c === 'nw' || c === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'
            }`}
            style={{ left: `${px}%`, top: `${py}%` }}
            onPointerDown={begin('scale')}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        );
      })}
    </div>
  );
}
