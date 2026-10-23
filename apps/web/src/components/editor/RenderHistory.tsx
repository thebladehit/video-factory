import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { RenderView } from '@vf/api';
import { ChevronDown, ChevronUp, Download, Send } from 'lucide-react';
import { useState } from 'react';
import { formatDuration } from '@/components/library/format';
import { PublishDialog } from '@/components/publish/PublishDialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useJobFeed } from '@/lib/job-feed';
import { useTRPC } from '@/lib/trpc';

const STATUS: Record<RenderView['status'], string> = {
  queued: 'У черзі',
  running: 'Рендериться',
  done: 'Готово',
  failed: 'Помилка',
  cancelled: 'Скасовано',
};

/** `baseLanguage` — мова рендеру без явної мови (базовий документ проєкту) */
export function RenderHistory({ projectId, baseLanguage }: { projectId: string; baseLanguage?: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  /** Мова рендеру, з якого відкрито діалог публікації; undefined — діалог закрито */
  const [publishLang, setPublishLang] = useState<string | null | undefined>(undefined);
  const key = trpc.renders.list.queryKey({ projectId });
  const list = useQuery(trpc.renders.list.queryOptions({ projectId }));
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const ids = new Set(list.data?.map((r) => r.id));
  useJobFeed((e) => {
    if (
      (e.type === 'render' && e.subject.renderId && ids.has(e.subject.renderId)) ||
      (e.type === 'asset.process' && e.subject.assetId && ids.has(e.subject.assetId))
    )
      void refresh();
  });
  const cancel = useMutation(trpc.renders.cancel.mutationOptions({ onSuccess: refresh }));
  const retry = useMutation(trpc.renders.retry.mutationOptions({ onSuccess: refresh }));
  const items = list.data ?? [];

  return (
    <section data-testid="render-history" className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm font-medium"
        onClick={() => setOpen(!open)}
      >
        Історія рендерів ({items.length}) {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
      </button>
      {open && (
        <ul className="grid max-h-40 gap-1 overflow-y-auto px-3 pb-2 text-sm">
          {!items.length && <li className="text-muted-foreground">Ще немає рендерів</li>}
          {items.map((r) => (
            <li key={r.id} data-testid="render-item" data-status={r.status} className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-muted-foreground">
                {new Date(r.createdAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })} ·{' '}
                {r.preset === 'final' ? '1080p' : '720p'}
                {r.language ? ` · ${r.language.toUpperCase()}` : ''}
              </span>
              <span className="w-24 shrink-0">{STATUS[r.status]}</span>
              {(r.status === 'queued' || r.status === 'running') && (
                <>
                  <Progress value={r.progress} className="w-40" />
                  <span className="tabular-nums">{Math.round(r.progress)} %</span>
                  <Button size="sm" variant="ghost" onClick={() => cancel.mutate({ id: r.id })}>
                    Скасувати
                  </Button>
                </>
              )}
              {r.status === 'done' && r.output && (
                <>
                  {r.output.status !== 'ready' ? (
                    <span className="text-muted-foreground">обробка файлу…</span>
                  ) : (
                    <span className="tabular-nums">{formatDuration(r.output.durationMs)}</span>
                  )}
                  <Button size="sm" variant="ghost" asChild>
                    <a href={r.output.downloadUrl}>
                      <Download /> Завантажити
                    </a>
                  </Button>
                  <Button size="sm" variant="ghost" asChild>
                    <Link to="/library" search={{ open: r.output.assetId }}>
                      Відкрити в бібліотеці
                    </Link>
                  </Button>
                  {r.preset === 'final' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="render-publish"
                      onClick={() => setPublishLang(r.language ?? baseLanguage ?? null)}
                    >
                      <Send /> Опублікувати…
                    </Button>
                  )}
                </>
              )}
              {(r.status === 'failed' || r.status === 'cancelled') && (
                <>
                  {r.error && (
                    <span className="truncate text-destructive" title={r.error}>
                      {r.error}
                    </span>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => retry.mutate({ id: r.id })}>
                    Повторити
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <PublishDialog
        open={publishLang !== undefined}
        onOpenChange={(o) => !o && setPublishLang(undefined)}
        projectId={projectId}
        language={publishLang ?? undefined}
      />
    </section>
  );
}
