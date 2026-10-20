import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { useTRPC } from '@/lib/trpc';

export function TagChips({ selected, onToggle }: { selected: string[]; onToggle: (tag: string) => void }) {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.assets.tags.queryOptions());
  const tags = [...new Set([...selected, ...(data ?? []).map((t) => t.tag)])];
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Теги">
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          aria-pressed={selected.includes(tag)}
          onClick={() => onToggle(tag)}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
            selected.includes(tag) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
          )}
        >
          #{tag}
        </button>
      ))}
    </div>
  );
}
