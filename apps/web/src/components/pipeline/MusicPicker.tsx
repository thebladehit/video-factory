import { useQuery } from '@tanstack/react-query';
import { Music, Pause, Play, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDebounced } from '@/pipeline/use-pipeline';
import { useTRPC } from '@/lib/trpc';

/** Фонова музика: пошук серед аудіо бібліотеки, ▶ прослуховування, «Без музики». */
export function MusicPicker({ value, onChange }: { value: string | null; onChange(assetId: string | null): void }) {
  const trpc = useTRPC();
  const [q, setQ] = useState('');
  const search = useDebounced(q.trim(), 300);
  const list = useQuery(trpc.assets.list.queryOptions({ kind: 'audio', limit: 20, ...(search ? { q: search } : {}) }));
  const selected = useQuery({ ...trpc.assets.get.queryOptions({ id: value ?? '' }), enabled: !!value });
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );

  function toggle(id: string, url: string) {
    audio.current?.pause();
    if (playing === id) return setPlaying(null);
    const el = new Audio(url);
    el.onended = () => setPlaying(null);
    el.onerror = () => setPlaying(null);
    audio.current = el;
    setPlaying(id);
    void el.play().catch(() => setPlaying(null));
  }

  const items = (list.data?.items ?? []).filter((a) => a.status === 'ready');
  return (
    <div className="grid gap-2" data-testid="music-picker">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={value ? 'outline' : 'secondary'}
          aria-pressed={!value}
          onClick={() => onChange(null)}
        >
          <X /> Без музики
        </Button>
        {value && (
          <span className="flex items-center gap-1 truncate text-sm">
            <Music className="size-4 shrink-0" /> {selected.data?.title ?? '…'}
          </span>
        )}
      </div>
      <Input
        aria-label="Пошук музики"
        placeholder="Пошук аудіо в бібліотеці"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="grid max-h-40 gap-1 overflow-y-auto">
        {items.map((a) => (
          <li
            key={a.id}
            className={`flex items-center gap-2 rounded border px-2 py-1 text-sm ${a.id === value ? 'border-primary' : ''}`}
          >
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={playing === a.id ? `Зупинити «${a.title}»` : `Прослухати «${a.title}»`}
              onClick={() => toggle(a.id, a.url)}
            >
              {playing === a.id ? <Pause /> : <Play />}
            </Button>
            <span className="min-w-0 flex-1 truncate">{a.title}</span>
            <Button
              type="button"
              size="sm"
              variant={a.id === value ? 'secondary' : 'outline'}
              onClick={() => onChange(a.id)}
            >
              {a.id === value ? 'Вибрано' : 'Вибрати'}
            </Button>
          </li>
        ))}
        {!list.isPending && items.length === 0 && <li className="text-sm text-muted-foreground">Аудіо не знайдено</li>}
      </ul>
    </div>
  );
}
