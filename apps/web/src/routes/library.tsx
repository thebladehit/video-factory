import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { AssetView } from '@vf/api';
import { useCallback, useState } from 'react';
import { AssetGrid } from '@/components/library/AssetGrid';
import { AssetSheet } from '@/components/library/AssetSheet';
import { GenerateDialog } from '@/components/library/GenerateDialog';
import { LibraryToolbar } from '@/components/library/LibraryToolbar';
import { PendingStrip } from '@/components/library/PendingStrip';
import { validateLibrarySearch, type LibrarySearch } from '@/components/library/search';
import { TagChips } from '@/components/library/TagChips';

export const Route = createFileRoute('/library')({
  validateSearch: validateLibrarySearch,
  component: LibraryPage,
});

function LibraryPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/library' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const onSearch = useCallback(
    (patch: Partial<LibrarySearch>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  );
  const toggleTag = (tag: string) => {
    const tags = search.tags ?? [];
    onSearch({ tags: tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag] });
  };

  return (
    <div className="mx-auto grid max-w-7xl gap-4">
      <h1 className="text-2xl font-semibold">Бібліотека</h1>
      <LibraryToolbar search={search} onSearch={onSearch} onGenerate={() => setGenerating(true)} />
      <TagChips selected={search.tags ?? []} onToggle={toggleTag} />
      <PendingStrip />
      <AssetGrid search={search} onOpen={(a: AssetView) => setOpenId(a.id)} />
      <AssetSheet assetId={openId} onClose={() => setOpenId(null)} />
      <GenerateDialog open={generating} onOpenChange={setGenerating} />
    </div>
  );
}
