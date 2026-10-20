import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageIcon, Loader2, RotateCcw, Trash2, Video } from 'lucide-react';
import { useState } from 'react';
import { TERMINAL_STATUSES } from '@vf/shared';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useJobFeed } from '@/lib/job-feed';
import { useTRPC } from '@/lib/trpc';

/** Завантаження, що «висить» довше, — швидше за все, вкладку закрили: даємо прибрати вручну */
const STALE_UPLOAD_MS = 5 * 60_000;
const LIBRARY_JOBS = new Set(['asset.process', 'image.generate', 'video.generate', 'assets.tag']);
const ASSET_STATUS = {
  uploading: 'Завантажується',
  processing: 'Обробка…',
  failed: 'Помилка',
  ready: 'Готово',
} as const;

/** «В роботі»: файли, що вантажаться/обробляються, і генерації — з живим прогресом. */
export function PendingStrip() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const pending = useQuery(trpc.assets.pending.queryOptions());
  const gens = useQuery(trpc.generate.list.queryOptions());
  const [progress, setProgress] = useState<Record<string, number>>({});
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.assets.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.generate.list.queryKey() });
  };
  const retryAsset = useMutation(trpc.assets.retryProcess.mutationOptions({ onSuccess: invalidate }));
  const deleteAsset = useMutation(trpc.assets.delete.mutationOptions({ onSuccess: invalidate }));
  const abortUpload = useMutation(trpc.assets.abort.mutationOptions({ onSuccess: invalidate }));
  const retryJob = useMutation(trpc.jobs.retry.mutationOptions({ onSuccess: invalidate }));

  useJobFeed((e) => {
    if (!LIBRARY_JOBS.has(e.type)) return;
    setProgress((p) => ({ ...p, [e.jobId]: e.progress }));
    if (e.status === 'running' || TERMINAL_STATUSES.has(e.status)) invalidate();
  });

  const assets = pending.data ?? [];
  const generations = gens.data ?? [];
  if (!assets.length && !generations.length) return null;

  return (
    <section data-testid="pending" className="grid gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">В роботі</h2>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
        {generations.map((g) => (
          <li key={g.id} className="grid gap-1.5 rounded-lg border p-3 text-sm" data-testid="pending-generation">
            <div className="flex items-center gap-2">
              {g.capability === 'video' ? <Video className="size-4" /> : <ImageIcon className="size-4" />}
              <span className="min-w-0 flex-1 truncate" title={g.prompt}>
                {g.prompt}
              </span>
            </div>
            {g.status === 'failed' ? (
              <>
                <p className="line-clamp-2 text-xs text-destructive">{g.error}</p>
                {g.jobId && (
                  <Button size="sm" variant="outline" onClick={() => retryJob.mutate({ id: g.jobId! })}>
                    <RotateCcw /> Повторити
                  </Button>
                )}
              </>
            ) : (
              <>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Генерується · {g.model}
                </span>
                <Progress value={progress[g.jobId ?? ''] ?? g.progress} className="h-1" />
              </>
            )}
          </li>
        ))}
        {assets.map((a) => (
          <li key={a.id} className="grid gap-1.5 rounded-lg border p-3 text-sm" data-testid="pending-asset">
            <span className="truncate" title={a.title}>
              {a.title || 'Без назви'}
            </span>
            <span className={a.status === 'failed' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {a.status === 'failed' ? a.error : ASSET_STATUS[a.status]}
            </span>
            {a.status === 'uploading' && Date.now() - Date.parse(a.createdAt) > STALE_UPLOAD_MS && (
              <Button size="sm" variant="ghost" onClick={() => abortUpload.mutate({ assetId: a.id })}>
                <Trash2 /> Скасувати
              </Button>
            )}
            {a.status === 'failed' && (
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={() => retryAsset.mutate({ id: a.id })}>
                  <RotateCcw /> Повторити
                </Button>
                <Button size="sm" variant="ghost" onClick={() => deleteAsset.mutate({ id: a.id })}>
                  <Trash2 /> Видалити
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
