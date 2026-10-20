import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { AssetView } from '@vf/api';
import { Download, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useTRPC } from '@/lib/trpc';
import { formatDuration, formatSize, formatUsd } from './format';

function Preview({ asset }: { asset: AssetView }) {
  if (asset.kind === 'video')
    return <video src={asset.url} controls className="max-h-[50vh] w-full rounded-md bg-black" />;
  if (asset.kind === 'audio') return <audio src={asset.url} controls className="w-full" />;
  return <img src={asset.url} alt={asset.title} className="max-h-[50vh] w-full rounded-md object-contain" />;
}

const plural = (n: number) => {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return 'проєкті';
  return 'проєктах';
};

export function AssetSheet({ assetId, onClose }: { assetId: string | null; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: asset } = useQuery(trpc.assets.get.queryOptions({ id: assetId ?? '' }, { enabled: !!assetId }));
  const [title, setTitle] = useState('');
  const [newTag, setNewTag] = useState('');
  const [confirming, setConfirming] = useState(false);
  const usage = useQuery(trpc.assets.usage.queryOptions({ id: assetId ?? '' }, { enabled: !!assetId && confirming }));
  useEffect(() => setTitle(asset?.title ?? ''), [asset?.title]);

  const refresh = () => qc.invalidateQueries({ queryKey: trpc.assets.pathKey() });
  const update = useMutation(trpc.assets.update.mutationOptions({ onSuccess: refresh }));
  const tag = useMutation(
    trpc.assets.tag.mutationOptions({
      onSuccess: () => toast.success('Теги генеруються — з’являться за кілька секунд'),
    }),
  );
  const remove = useMutation(
    trpc.assets.delete.mutationOptions({
      onSuccess: () => {
        onClose();
        void refresh();
      },
    }),
  );

  const saveTitle = () => {
    if (asset && title.trim() !== asset.title) update.mutate({ id: asset.id, title });
  };
  const addTag = () => {
    if (!asset || !newTag.trim()) return;
    update.mutate({ id: asset.id, tags: [...asset.tags, newTag] });
    setNewTag('');
  };

  return (
    <Sheet open={!!assetId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" data-testid="asset-sheet">
        <SheetHeader>
          <SheetTitle className="truncate">{asset?.title || 'Файл'}</SheetTitle>
          <SheetDescription>
            {asset?.source === 'generated' ? 'Згенеровано' : 'Завантажено'}
            {asset && ` · ${new Date(asset.createdAt).toLocaleString('uk-UA')}`}
          </SheetDescription>
        </SheetHeader>
        {asset && (
          <div className="grid gap-5 px-4 pb-6">
            <Preview asset={asset} />

            <div className="grid gap-1.5">
              <Label htmlFor="asset-title">Назва</Label>
              <Input
                id="asset-title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => e.key === 'Enter' && saveTitle()}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="asset-new-tag">Теги</Label>
              <div className="flex flex-wrap gap-1.5" data-testid="asset-tags">
                {asset.tags.map((t) => (
                  <span key={t} className="flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5 text-xs">
                    {t}
                    <button
                      type="button"
                      aria-label={`Прибрати тег ${t}`}
                      className="rounded-full p-0.5 hover:bg-background"
                      onClick={() => update.mutate({ id: asset.id, tags: asset.tags.filter((x) => x !== t) })}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
              <Input
                id="asset-new-tag"
                placeholder="Додати тег і натиснути Enter"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTag()}
              />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Розмір</dt>
              <dd>{formatSize(asset.sizeBytes)}</dd>
              {asset.width && asset.height && (
                <>
                  <dt className="text-muted-foreground">Роздільність</dt>
                  <dd>
                    {asset.width}×{asset.height}
                  </dd>
                </>
              )}
              {asset.durationMs !== null && (
                <>
                  <dt className="text-muted-foreground">Тривалість</dt>
                  <dd>{formatDuration(asset.durationMs)}</dd>
                </>
              )}
              {asset.generation && (
                <>
                  <dt className="text-muted-foreground">Модель</dt>
                  <dd>{asset.generation.model}</dd>
                  <dt className="text-muted-foreground">Вартість</dt>
                  <dd>{formatUsd(asset.generation.costEstimate)}</dd>
                </>
              )}
            </dl>
            {asset.prompt && (
              <div className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Опис</span>
                <p className="whitespace-pre-wrap">{asset.prompt}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={tag.isPending} onClick={() => tag.mutate({ id: asset.id })}>
                <Sparkles /> Згенерувати теги
              </Button>
              <Button variant="outline" asChild>
                <a href={asset.downloadUrl} download>
                  <Download /> Завантажити файл
                </a>
              </Button>
              <AlertDialog open={confirming} onOpenChange={setConfirming}>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">
                    <Trash2 /> Видалити
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent data-testid="delete-dialog">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Видалити файл назавжди?</AlertDialogTitle>
                    {usage.data?.length ? (
                      <AlertDialogDescription data-testid="usage-warning">
                        Файл використано в {usage.data.length} {plural(usage.data.length)}:{' '}
                        {usage.data.map((p, i) => (
                          <span key={p.projectId}>
                            {i > 0 && ', '}
                            <Link to="/projects/$id" params={{ id: p.projectId }} className="underline">
                              «{p.title}»
                            </Link>
                          </span>
                        ))}
                        . Після видалення на таймлайні лишиться заглушка, а рендер буде недоступний, доки ви її не
                        заміните. Видалити все одно?
                      </AlertDialogDescription>
                    ) : (
                      <AlertDialogDescription>Файл буде видалено зі сховища й бібліотеки.</AlertDialogDescription>
                    )}
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Скасувати</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={usage.isPending}
                      onClick={() => remove.mutate({ id: asset.id })}
                    >
                      Видалити
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
