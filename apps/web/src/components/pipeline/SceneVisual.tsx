import { useMutation, useQuery } from '@tanstack/react-query';
import type { PipelineView, SceneView } from '@vf/api';
import type { VisualSource } from '@vf/shared';
import { Clapperboard, Film, Image as ImageIcon, Library, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTRPC } from '@/lib/trpc';
import { SceneVideoDialog } from './SceneVideoDialog';

const SOURCE_LABEL: Record<VisualSource, string> = {
  library: 'бібліотека',
  generated: 'згенеровано',
  manual: 'вручну',
};

/** Які дії з візуалом дозволяє сервер на цьому етапі (див. `checkVisualStage`) */
export function visualActions(run: PipelineView['run']): { generate: boolean; choose: boolean } {
  const stopped = run.status === 'failed' || run.status === 'cancelled';
  const stageOk = run.stage !== 'script' && run.stage !== 'assemble';
  return {
    generate: !stopped && stageOk && run.stage !== 'review',
    choose: !stopped && stageOk,
  };
}

/** Мініатюра візуалу сцени, джерело, ↻ / 🎬 / 📚 і підказки з бібліотеки. */
export function SceneVisual({
  scene,
  index,
  view,
  onChanged,
}: {
  scene: SceneView;
  index: number;
  view: PipelineView;
  onChanged(): void;
}) {
  const trpc = useTRPC();
  const [videoOpen, setVideoOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const can = visualActions(view.run);
  const onError = (e: { message: string }) => toast.error(e.message);
  const regenerate = useMutation(trpc.pipeline.regenerateScene.mutationOptions({ onSuccess: onChanged, onError }));
  const choose = useMutation(
    trpc.pipeline.setSceneVisual.mutationOptions({
      onSuccess: () => {
        setPickOpen(false);
        onChanged();
      },
      onError,
    }),
  );
  const busy = scene.status === 'queued' || scene.status === 'running';
  const aspect = view.project.format === '9:16' ? 'aspect-[9/16] w-20' : 'aspect-video w-36';

  return (
    <div className="grid content-start gap-1.5">
      <div className={`relative overflow-hidden rounded-md border bg-muted ${aspect}`} data-testid="scene-thumb">
        {scene.visual?.thumbUrl ? (
          <img src={scene.visual.thumbUrl} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            {busy ? (
              <Loader2 aria-label="Візуал готується" className="size-5 animate-spin" />
            ) : scene.visual?.kind === 'video' ? (
              <Film className="size-5" />
            ) : (
              <ImageIcon className="size-5" />
            )}
          </div>
        )}
        {busy && scene.visual?.thumbUrl && (
          <Loader2 className="absolute top-1 right-1 size-4 animate-spin text-white drop-shadow" />
        )}
      </div>
      <span className="text-xs text-muted-foreground">
        {scene.visual ? SOURCE_LABEL[scene.visual.source] : busy ? 'готується…' : 'немає візуалу'}
      </span>
      {scene.status === 'failed' && scene.error && <span className="text-xs text-destructive">{scene.error}</span>}
      {view.run.stage === 'done' && !scene.inTimeline && (
        <span className="text-xs text-amber-600">немає в таймлайні</span>
      )}
      <div className="flex gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Згенерувати візуал сцени ${index} знову`}
          title="Згенерувати знову"
          disabled={!can.generate || regenerate.isPending}
          onClick={() => regenerate.mutate({ sceneId: scene.id, part: 'visual' })}
        >
          <RefreshCw />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Згенерувати відео для сцени ${index}`}
          title="Згенерувати відео"
          disabled={!can.generate}
          onClick={() => setVideoOpen(true)}
        >
          <Clapperboard />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Вибрати з бібліотеки для сцени ${index}`}
          title="Вибрати з бібліотеки"
          disabled={!can.choose}
          onClick={() => setPickOpen(true)}
        >
          <Library />
        </Button>
      </div>
      {scene.suggestions.length > 0 && (
        <div className="grid gap-0.5">
          <span className="text-[10px] text-muted-foreground">підказки:</span>
          <div className="flex gap-1">
            {scene.suggestions.map((s) => (
              <button
                key={s.assetId}
                type="button"
                aria-label={`Підказка для сцени ${index}`}
                disabled={!can.choose || choose.isPending}
                onClick={() => choose.mutate({ sceneId: scene.id, assetId: s.assetId })}
                className="size-8 overflow-hidden rounded border bg-muted disabled:opacity-50"
              >
                {s.thumbUrl && <img src={s.thumbUrl} alt="" className="size-full object-cover" />}
              </button>
            ))}
          </div>
        </div>
      )}
      <SceneVideoDialog
        sceneId={scene.id}
        index={index}
        open={videoOpen}
        onOpenChange={setVideoOpen}
        onStarted={onChanged}
      />
      <LibraryPickDialog
        open={pickOpen}
        onOpenChange={setPickOpen}
        title={`Візуал для сцени ${index}`}
        pending={choose.isPending}
        onPick={(assetId) => choose.mutate({ sceneId: scene.id, assetId })}
      />
    </div>
  );
}

/** Простий пошук готових фото й відео в бібліотеці. */
function LibraryPickDialog({
  open,
  onOpenChange,
  title,
  pending,
  onPick,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  pending: boolean;
  onPick(assetId: string): void;
}) {
  const trpc = useTRPC();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useQuery({
    ...trpc.assets.list.queryOptions({ q: debounced || undefined, limit: 60 }),
    enabled: open,
  });
  const items = (list.data?.items ?? []).filter((a) => a.status === 'ready' && a.kind !== 'audio');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Готові фото й відео з бібліотеки.</DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Пошук у бібліотеці"
          placeholder="Пошук у бібліотеці"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="grid max-h-[60vh] auto-rows-max grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2 overflow-y-auto">
          {items.map((a) => (
            <button
              key={a.id}
              type="button"
              data-testid="pick-asset"
              aria-label={`Вибрати «${a.title}»`}
              title={a.title}
              disabled={pending}
              onClick={() => onPick(a.id)}
              className="aspect-square overflow-hidden rounded-md border bg-muted hover:ring-2 hover:ring-ring disabled:opacity-50"
            >
              {a.thumbUrl ? (
                <img src={a.thumbUrl} alt="" className="size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-muted-foreground">
                  {a.kind === 'video' ? <Film className="size-5" /> : <ImageIcon className="size-5" />}
                </span>
              )}
            </button>
          ))}
          {!list.isPending && !items.length && (
            <p className="col-span-full text-sm text-muted-foreground">Нічого не знайдено</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
