import { useInfiniteQuery } from '@tanstack/react-query';
import type { AssetView } from '@vf/api';
import { ImagePlus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc';
import { AssetCard } from './AssetCard';
import type { LibrarySearch } from './search';

export function AssetGrid({ search, onOpen }: { search: LibrarySearch; onOpen: (a: AssetView) => void }) {
  const trpc = useTRPC();
  const query = useInfiniteQuery(
    trpc.assets.list.infiniteQueryOptions(search, { getNextPageParam: (page) => page.nextCursor ?? undefined }),
  );
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!(search.q || search.kind || search.source || search.orientation || search.tags?.length);

  if (query.isPending) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="aspect-square rounded-lg" />
        ))}
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-center text-muted-foreground">
        <ImagePlus className="size-10" />
        {filtered ? 'Нічого не знайдено' : 'Перетягніть файли сюди або згенеруйте перше зображення'}
      </div>
    );
  }
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3" data-testid="asset-grid">
        {items.map((a) => (
          <AssetCard key={a.id} asset={a} onOpen={() => onOpen(a)} />
        ))}
      </div>
      <div ref={sentinel} className="h-8" />
    </>
  );
}
