import type { AudioClip, MediaClip } from '@vf/shared';
import { cn } from 'cn';
import type { PointerEvent } from 'react';
import { isPresent, type AnyAsset } from '@/editor/types';
import { Waveform } from './Waveform';

export type ClipGesture = 'move' | 'trim-l' | 'trim-r' | 'transition';

export const TRACK_HEIGHT = 56;

export function TimelineClip({
  clip,
  trackKind,
  asset,
  pxPerSec,
  selected,
  invalid,
  hasPrevious,
  onPointerDown,
}: {
  clip: MediaClip | AudioClip;
  trackKind: 'video' | 'audio';
  asset: AnyAsset | undefined;
  pxPerSec: number;
  selected: boolean;
  invalid: boolean;
  /** На доріжці є попередній кліп — показати ручку переходу */
  hasPrevious: boolean;
  onPointerDown(e: PointerEvent, kind: ClipGesture): void;
}) {
  const width = Math.max(2, clip.duration * pxPerSec);
  const missing = !asset || asset.missing;
  const present = isPresent(asset) ? asset : null;
  const local = present && 'local' in present ? present : null;
  const thumb = present ? (present.thumbUrl ?? (present.kind === 'image' ? present.url : null)) : null;
  const xfade =
    'effects' in clip
      ? ((clip.effects.find((e) => e.type === 'xfade')?.params as { duration?: number } | undefined)?.duration ?? 0)
      : 0;

  return (
    <div
      data-testid={`clip-${clip.id}`}
      data-clip-id={clip.id}
      data-start={clip.start}
      data-duration={clip.duration}
      data-selected={selected || undefined}
      className={cn(
        'absolute top-1 bottom-1 cursor-grab touch-none overflow-hidden rounded-md border text-xs text-white select-none active:cursor-grabbing',
        trackKind === 'video' ? 'border-sky-700 bg-sky-600' : 'border-emerald-700 bg-emerald-600',
        missing && 'border-red-700 bg-red-600/90',
        selected && 'ring-2 ring-amber-400 ring-offset-1',
        invalid && 'ring-2 ring-red-500 ring-offset-1',
      )}
      style={{ left: clip.start * pxPerSec, width }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
    >
      {thumb && trackKind === 'video' && (
        <div
          className="pointer-events-none absolute inset-0 opacity-80"
          style={{ backgroundImage: `url("${thumb}")`, backgroundRepeat: 'repeat-x', backgroundSize: 'auto 100%' }}
        />
      )}
      {trackKind === 'audio' && present && (
        <Waveform
          peaksUrl={present.peaksUrl}
          sourceIn={clip.in}
          duration={clip.duration}
          width={width}
          height={TRACK_HEIGHT - 10}
        />
      )}
      <span className="pointer-events-none absolute top-0.5 left-1.5 max-w-[calc(100%-12px)] truncate drop-shadow">
        {missing ? 'файл видалено' : local ? `завантаження ${Math.round(local.progress)} %` : present?.title}
      </span>
      <div
        data-testid="clip-handle-l"
        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/30 hover:bg-white/70"
        onPointerDown={(e) => {
          e.stopPropagation();
          onPointerDown(e, 'trim-l');
        }}
      />
      <div
        data-testid="clip-handle-r"
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/30 hover:bg-white/70"
        onPointerDown={(e) => {
          e.stopPropagation();
          onPointerDown(e, 'trim-r');
        }}
      />
      {hasPrevious && trackKind === 'video' && (
        <div
          data-testid="transition-handle"
          title="Перехід: тягніть ліворуч, щоб збільшити перекриття"
          className="absolute top-1/2 z-10 size-3 -translate-y-1/2 rotate-45 cursor-ew-resize border border-white bg-violet-500"
          style={{ left: Math.max(2, xfade * pxPerSec) }}
          onPointerDown={(e) => {
            e.stopPropagation();
            onPointerDown(e, 'transition');
          }}
        />
      )}
    </div>
  );
}
