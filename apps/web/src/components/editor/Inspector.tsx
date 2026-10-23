import {
  EFFECT_DEFAULTS,
  type AudioClip,
  type Effect,
  type EffectType,
  type MediaClip,
  type TimelineDoc,
} from '@vf/shared';
import { findClip, previousClip, removeEffect, setEffect, setTransition, setVolume, unlink } from '@vf/timeline';
import { Unlink } from 'lucide-react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { EditorStore, UiStore } from '@/editor/store';
import { isPresent, type AnyAsset } from '@/editor/types';
import { TransformControls } from './TransformControls';

/** Повзунок, зміни якого за один жест — один крок історії. */
function Range({
  label,
  value,
  min,
  max,
  step,
  format,
  store,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format(v: number): string;
  store: EditorStore;
  onChange(v: number): void;
  testId?: string;
}) {
  return (
    <label className="grid gap-1 text-xs">
      <span className="flex justify-between text-muted-foreground">
        {label} <span className="tabular-nums text-foreground">{format(value)}</span>
      </span>
      <input
        type="range"
        data-testid={testId}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        className="accent-primary"
        onPointerDown={() => store.getState().beginGesture()}
        onPointerUp={() => store.getState().endGesture()}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

const pct = (v: number) => `${Math.round(v * 100)} %`;
const sec = (v: number) => `${v.toFixed(1)} с`;
const frac = (v: number) => v.toFixed(2);

export function Inspector({
  store,
  ui,
  assets,
}: {
  store: EditorStore;
  ui: UiStore;
  assets: Record<string, AnyAsset>;
}) {
  const doc = useStore(store, (s) => s.doc);
  const selected = useStore(ui, (s) => s.selected);
  const found = selected.length ? findClip(doc, selected[0]!) : null;
  if (!found)
    return (
      <aside data-testid="inspector" className="text-sm text-muted-foreground">
        Виберіть кліп на таймлайні
      </aside>
    );
  const { clip, track } = found;
  const asset = assets[clip.assetId];
  const apply = (op: (d: TimelineDoc) => TimelineDoc) => store.getState().apply(op);

  return (
    <aside data-testid="inspector" className="grid min-h-0 content-start gap-4 overflow-y-auto pr-1 text-sm">
      <div>
        <div className="truncate font-medium">{isPresent(asset) ? asset.title : 'Файл видалено'}</div>
        <div className="text-xs text-muted-foreground">
          {track.kind === 'video' ? 'Кліп відео-доріжки' : 'Звуковий кліп'} · {clip.duration.toFixed(2)} с
        </div>
      </div>
      {track.kind === 'video' ? (
        <VideoClipControls
          store={store}
          clip={clip as MediaClip}
          doc={doc}
          isImage={isPresent(asset) && asset.kind === 'image'}
          apply={apply}
        />
      ) : (
        <Range
          label="Гучність"
          testId="volume"
          value={(clip as AudioClip).volume}
          min={0}
          max={2}
          step={0.01}
          format={pct}
          store={store}
          onChange={(v) => apply((d) => setVolume(d, clip.id, v))}
        />
      )}
      {clip.linkId && (
        <Button variant="outline" size="sm" onClick={() => apply((d) => unlink(d, clip.linkId!))}>
          <Unlink /> Від'єднати звук
        </Button>
      )}
    </aside>
  );
}

function EffectBlock({
  title,
  type,
  clip,
  apply,
  children,
}: {
  title: string;
  type: EffectType;
  clip: MediaClip;
  apply(op: (d: TimelineDoc) => TimelineDoc): void;
  children: React.ReactNode;
}) {
  const on = clip.effects.some((e) => e.type === type);
  return (
    <div className="grid gap-2 rounded-md border p-2">
      <div className="flex items-center justify-between">
        <Label>{title}</Label>
        <Switch
          aria-label={title}
          checked={on}
          onCheckedChange={(v) =>
            apply((d) =>
              v
                ? setEffect(d, clip.id, { type, params: { ...EFFECT_DEFAULTS[type] } } as Effect)
                : removeEffect(d, clip.id, type),
            )
          }
        />
      </div>
      {on && children}
    </div>
  );
}

function VideoClipControls({
  store,
  clip,
  doc,
  isImage,
  apply,
}: {
  store: EditorStore;
  clip: MediaClip;
  doc: TimelineDoc;
  isImage: boolean;
  apply(op: (d: TimelineDoc) => TimelineDoc): void;
}) {
  const get = <T extends EffectType>(type: T) =>
    clip.effects.find((e) => e.type === type) as Extract<Effect, { type: T }> | undefined;
  const kb = get('kenburns');
  const zoom = get('zoom');
  const fade = get('fade');
  const xfade = get('xfade');
  const prev = previousClip(doc, clip.id);
  const patch = <T extends EffectType>(type: T, params: Partial<Extract<Effect, { type: T }>['params']>) => {
    const cur = get(type);
    if (cur) apply((d) => setEffect(d, clip.id, { type, params: { ...cur.params, ...params } } as Effect));
  };
  const range = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    on: (v: number) => void,
    testId?: string,
  ) => (
    <Range
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      format={format}
      store={store}
      onChange={on}
      testId={testId}
    />
  );

  return (
    <>
      {!isImage &&
        (clip.linkId ? (
          <p className="text-xs text-muted-foreground">
            Звук цього відео — у зв'язаному кліпі на доріжці «Звук відео».
          </p>
        ) : (
          range('Гучність', clip.volume ?? 0, 0, 2, 0.01, pct, (v) => apply((d) => setVolume(d, clip.id, v)), 'volume')
        ))}
      <EffectBlock title="Ken Burns" type="kenburns" clip={clip} apply={apply}>
        {kb && (
          <>
            {range(
              'Масштаб від',
              kb.params.fromScale,
              0.5,
              2,
              0.01,
              pct,
              (v) => patch('kenburns', { fromScale: v }),
              'kb-from-scale',
            )}
            {range(
              'Масштаб до',
              kb.params.toScale,
              0.5,
              2,
              0.01,
              pct,
              (v) => patch('kenburns', { toScale: v }),
              'kb-to-scale',
            )}
            {range('Фокус від, X', kb.params.fromX, 0, 1, 0.01, frac, (v) => patch('kenburns', { fromX: v }))}
            {range('Фокус від, Y', kb.params.fromY, 0, 1, 0.01, frac, (v) => patch('kenburns', { fromY: v }))}
            {range('Фокус до, X', kb.params.toX, 0, 1, 0.01, frac, (v) => patch('kenburns', { toX: v }))}
            {range('Фокус до, Y', kb.params.toY, 0, 1, 0.01, frac, (v) => patch('kenburns', { toY: v }))}
          </>
        )}
      </EffectBlock>
      <EffectBlock title="Zoom" type="zoom" clip={clip} apply={apply}>
        {zoom && (
          <>
            {range('Масштаб', zoom.params.scale, 0.5, 3, 0.01, pct, (v) => patch('zoom', { scale: v }))}
            {range('Фокус X', zoom.params.x, 0, 1, 0.01, frac, (v) => patch('zoom', { x: v }))}
            {range('Фокус Y', zoom.params.y, 0, 1, 0.01, frac, (v) => patch('zoom', { y: v }))}
          </>
        )}
      </EffectBlock>
      <EffectBlock title="Поява / зникнення" type="fade" clip={clip} apply={apply}>
        {fade && (
          <>
            {range('Поява', fade.params.in, 0, Math.min(5, clip.duration), 0.05, sec, (v) => patch('fade', { in: v }))}
            {range('Зникнення', fade.params.out, 0, Math.min(5, clip.duration), 0.05, sec, (v) =>
              patch('fade', { out: v }),
            )}
          </>
        )}
      </EffectBlock>
      {prev &&
        range(
          'Перехід з попереднім',
          xfade?.params.duration ?? 0,
          0,
          Math.max(0, Math.min(3, prev.duration, clip.duration)),
          1 / doc.fps,
          sec,
          (v) => apply((d) => setTransition(d, clip.id, v)),
          'transition',
        )}
      <TransformControls store={store} clipId={clip.id} />
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          apply((d) => {
            // перехід прибирається разом із перекриттям
            let next = setTransition(d, clip.id, 0);
            for (const e of clip.effects) next = removeEffect(next, clip.id, e.type);
            return isImage
              ? setEffect(next, clip.id, { type: 'kenburns', params: { ...EFFECT_DEFAULTS.kenburns } })
              : next;
          })
        }
      >
        Скинути до замовчувань
      </Button>
    </>
  );
}
