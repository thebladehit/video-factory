import { useMutation, useQuery } from '@tanstack/react-query';
import type { ModelRef } from '@vf/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { formatUsd } from '@/components/library/format';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc';

/** «🎬 Згенерувати відео» сцени: модель і тривалість з оцінкою; промпт — промпт сцени. */
export function SceneVideoDialog({
  sceneId,
  index,
  open,
  onOpenChange,
  onStarted,
}: {
  sceneId: string;
  index: number;
  open: boolean;
  onOpenChange(open: boolean): void;
  onStarted(): void;
}) {
  const trpc = useTRPC();
  const catalog = useQuery({ ...trpc.ai.catalog.queryOptions(), enabled: open });
  const settings = useQuery({ ...trpc.settings.get.queryOptions(), enabled: open });
  const models = catalog.data?.filter((m) => m.capability === 'video') ?? [];
  const [model, setModel] = useState<ModelRef | ''>('');
  const [durationSec, setDurationSec] = useState<number | undefined>();
  const entry = models.find((m) => m.ref === model);

  useEffect(() => {
    if (!open || model) return;
    const preferred = settings.data?.defaults.video;
    setModel(preferred?.available ? preferred.ref : (models.find((m) => m.available)?.ref ?? ''));
  }, [open, catalog.data, settings.data]);
  useEffect(() => setDurationSec(entry?.durations?.[0]), [entry?.ref]);

  const estimate = useQuery(
    trpc.generate.estimate.queryOptions(
      { capability: 'video', model: model as ModelRef, durationSec },
      { enabled: open && !!model },
    ),
  );
  const start = useMutation(
    trpc.pipeline.generateSceneVideo.mutationOptions({
      onSuccess: () => {
        toast.success('Генерацію відео запущено');
        onStarted();
        onOpenChange(false);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Відео для сцени {index}</DialogTitle>
          <DialogDescription>Опис — промпт сцени. Готове відео замінить поточний візуал.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`scene-video-model-${sceneId}`}>Модель</Label>
            <Select value={model} onValueChange={(v) => setModel(v as ModelRef)}>
              <SelectTrigger id={`scene-video-model-${sceneId}`} className="w-full">
                <SelectValue placeholder="Немає доступних моделей" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.ref} value={m.ref} disabled={!m.available}>
                    {m.label}
                    {!m.available && ' — немає ключа'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {entry?.durations && (
            <div className="grid gap-1.5">
              <Label htmlFor={`scene-video-duration-${sceneId}`}>Тривалість</Label>
              <Select value={String(durationSec ?? '')} onValueChange={(v) => setDurationSec(Number(v))}>
                <SelectTrigger id={`scene-video-duration-${sceneId}`} className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {entry.durations.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d} с
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {entry?.durationRange && (
            <p className="text-sm text-muted-foreground">
              Тривалість обирає модель: {entry.durationRange[0]}–{entry.durationRange[1]} с.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Орієнтовна вартість: {entry?.durationRange ? 'до ' : '≈ '}
            {formatUsd(estimate.data?.usd)}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Закрити
          </Button>
          <Button
            disabled={!model || start.isPending}
            onClick={() => model && start.mutate({ sceneId, model, durationSec })}
          >
            Згенерувати відео
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
