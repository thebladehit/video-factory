import type { AssetView } from '@vf/api';
import { Music } from 'lucide-react';
import { useState } from 'react';
import { formatDuration } from './format';

export function AssetCard({ asset, onOpen }: { asset: AssetView; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid="asset-card"
      aria-label={asset.title || 'Без назви'}
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="group relative aspect-square overflow-hidden rounded-lg border bg-muted text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {asset.kind === 'video' && hover ? (
        <video src={asset.url} muted loop autoPlay playsInline className="size-full object-cover" />
      ) : asset.thumbUrl ? (
        <img src={asset.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <Music className="size-10" />
        </div>
      )}
      {asset.durationMs !== null && (
        <span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white tabular-nums">
          {formatDuration(asset.durationMs)}
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pt-6 pb-1.5 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
        {asset.title}
      </span>
    </button>
  );
}
