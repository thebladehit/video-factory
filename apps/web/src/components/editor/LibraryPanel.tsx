import { useQuery } from '@tanstack/react-query';
import type { AssetKind } from '@vf/shared';
import { Film, Image as ImageIcon, Music, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDuration } from '@/components/library/format';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTRPC } from '@/lib/trpc';
import { ASSET_MIME } from './Timeline';

const ICON = { image: ImageIcon, video: Film, audio: Music } as const;

export function LibraryPanel({ onAdd }: { onAdd(assetId: string): void }) {
  const trpc = useTRPC();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState<AssetKind | ''>('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useQuery(
    trpc.assets.list.queryOptions({ q: debounced || undefined, kind: kind || undefined, limit: 60 }),
  );
  const items = (list.data?.items ?? []).filter((a) => a.status === 'ready');

  return (
    <aside data-testid="library-panel" className="flex min-h-0 flex-col gap-2">
      <Input placeholder="Пошук у бібліотеці" value={q} onChange={(e) => setQ(e.target.value)} className="h-8" />
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={kind}
        onValueChange={(v) => setKind(v as AssetKind | '')}
      >
        <ToggleGroupItem value="image" aria-label="Фото">
          <ImageIcon />
        </ToggleGroupItem>
        <ToggleGroupItem value="video" aria-label="Відео">
          <Film />
        </ToggleGroupItem>
        <ToggleGroupItem value="audio" aria-label="Аудіо">
          <Music />
        </ToggleGroupItem>
      </ToggleGroup>
      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-2 overflow-y-auto pr-1">
        {items.map((a) => {
          const Icon = ICON[a.kind];
          return (
            <div
              key={a.id}
              data-testid="library-item"
              data-asset-id={a.id}
              data-kind={a.kind}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(ASSET_MIME, JSON.stringify([a.id]));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              className="group relative aspect-square cursor-grab overflow-hidden rounded-md border bg-muted"
              title={a.title}
            >
              {a.thumbUrl ? (
                <img src={a.thumbUrl} alt="" className="size-full object-cover" draggable={false} />
              ) : (
                <div className="flex size-full items-center justify-center text-muted-foreground">
                  <Icon className="size-6" />
                </div>
              )}
              {a.durationMs !== null && (
                <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[10px] text-white">
                  {formatDuration(a.durationMs)}
                </span>
              )}
              <button
                type="button"
                aria-label={`Додати «${a.title}» під плейхед`}
                onClick={() => onAdd(a.id)}
                className="absolute top-1 right-1 rounded bg-black/70 p-0.5 text-white opacity-0 group-hover:opacity-100 focus:opacity-100"
              >
                <Plus className="size-4" />
              </button>
            </div>
          );
        })}
        {!items.length && <p className="col-span-2 text-xs text-muted-foreground">Нічого не знайдено</p>}
      </div>
    </aside>
  );
}
