import { DEFAULT_TRANSFORM, type ClipTransform, type MediaClip } from '@vf/shared';
import { setClipTransform } from '@vf/timeline';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import type { EditorStore } from '@/editor/store';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Група «Розмір і позиція»: розмір 10–400 %, центр кліпа X/Y у відсотках кадру. */
export function TransformControls({ store, clipId }: { store: EditorStore; clipId: string }) {
  const clip = useStore(store, (s) => {
    for (const t of s.doc.tracks) {
      if (t.kind === 'captions') continue;
      const c = t.clips.find((x) => x.id === clipId);
      if (c) return c as MediaClip;
    }
    return undefined;
  });
  if (!clip) return null;
  const t: ClipTransform = clip.transform ?? DEFAULT_TRANSFORM;
  const set = (patch: Partial<ClipTransform>) =>
    store.getState().apply((d) => setClipTransform(d, clipId, { ...t, ...patch }));
  const num = (raw: string, lo: number, hi: number) => {
    if (raw.trim() === '' || Number.isNaN(Number(raw))) return null;
    return clamp(Number(raw), lo, hi) / 100;
  };
  const field = (label: string, testId: string, value: number, key: 'x' | 'y') => (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}, %
      <input
        type="number"
        data-testid={testId}
        aria-label={label}
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        className="h-8 rounded-md border bg-background px-2 text-foreground"
        onChange={(e) => {
          const v = num(e.target.value, 0, 100);
          if (v !== null) set({ [key]: v });
        }}
      />
    </label>
  );

  return (
    <div className="grid gap-2 rounded-md border p-2" data-testid="transform-controls">
      <div className="text-sm font-medium">Розмір і позиція</div>
      <label className="grid gap-1 text-xs">
        <span className="flex justify-between text-muted-foreground">
          Розмір <span className="tabular-nums text-foreground">{Math.round(t.scale * 100)} %</span>
        </span>
        <input
          type="range"
          data-testid="transform-scale"
          aria-label="Розмір"
          min={10}
          max={400}
          step={1}
          value={Math.round(t.scale * 100)}
          className="accent-primary"
          onPointerDown={() => store.getState().beginGesture()}
          onPointerUp={() => store.getState().endGesture()}
          onChange={(e) => set({ scale: clamp(Number(e.target.value), 10, 400) / 100 })}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {field('X', 'transform-x', t.x, 'x')}
        {field('Y', 'transform-y', t.y, 'y')}
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          data-testid="transform-center"
          onClick={() => set({ x: DEFAULT_TRANSFORM.x, y: DEFAULT_TRANSFORM.y })}
        >
          По центру
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="transform-reset"
          onClick={() => store.getState().apply((d) => setClipTransform(d, clipId, null))}
        >
          Скинути
        </Button>
      </div>
    </div>
  );
}
