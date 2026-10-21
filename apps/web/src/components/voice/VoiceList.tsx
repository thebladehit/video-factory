import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { VoiceProjectCard } from '@vf/api';
import { Mic } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc';
import { LANG_STATE_LABEL, LANG_STATE_DOT } from './states';
import { NewVoiceDialog } from './NewVoiceDialog';

export function VoiceList() {
  const trpc = useTRPC();
  const list = useQuery(trpc.voice.list.queryOptions());
  const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto grid max-w-7xl gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Студія озвучки</h1>
        <Button onClick={() => setCreating(true)} data-testid="new-voice">
          <Mic /> Озвучити відео
        </Button>
      </div>
      {list.isPending ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="aspect-video" />
          ))}
        </div>
      ) : list.isError ? (
        <p className="text-destructive">{list.error.message}</p>
      ) : !list.data.length ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-muted-foreground">
          <Mic className="size-10" />
          <p>Озвучте перше відео кількома мовами</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
          {list.data.map((p) => (
            <VoiceCard key={p.id} project={p} />
          ))}
        </div>
      )}
      <NewVoiceDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function VoiceCard({ project }: { project: VoiceProjectCard }) {
  return (
    <Link
      to="/voice/$id"
      params={{ id: project.id }}
      data-testid="voice-card"
      className="block overflow-hidden rounded-lg border bg-card focus-visible:outline-none"
    >
      <div className="flex aspect-video items-center justify-center bg-muted">
        {project.thumbUrl ? (
          <img
            src={project.thumbUrl}
            alt=""
            className={project.format === '9:16' ? 'h-full object-cover' : 'size-full object-cover'}
          />
        ) : (
          <Mic className="size-8 text-muted-foreground" />
        )}
      </div>
      <div className="grid gap-2 p-3">
        <span className="truncate font-medium">{project.title}</span>
        <div className="flex flex-wrap gap-1">
          {project.languages.map((l) => (
            <Badge
              key={l.code}
              variant="secondary"
              title={l.code === project.base ? 'Базова мова' : LANG_STATE_LABEL[l.state]}
              className="gap-1"
            >
              {l.code !== project.base && <span className={`size-2 rounded-full ${LANG_STATE_DOT[l.state]}`} />}
              {l.code.toUpperCase()}
            </Badge>
          ))}
        </div>
      </div>
    </Link>
  );
}
