import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModelRef } from '@vf/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTRPC } from '@/lib/trpc';
import { formatUsd } from './format';

type Capability = 'image' | 'video';
type Aspect = '9:16' | '16:9' | '1:1';
const ASPECT_LABELS: Record<Aspect, string> = {
  '9:16': '9:16 · вертикальне',
  '16:9': '16:9 · горизонтальне',
  '1:1': '1:1',
};

export function GenerateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const catalog = useQuery(trpc.ai.catalog.queryOptions());
  const settings = useQuery(trpc.settings.get.queryOptions());
  const [capability, setCapability] = useState<Capability>('image');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<ModelRef | ''>('');
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [n, setN] = useState(1);
  const [durationSec, setDurationSec] = useState<number | undefined>();

  const models = catalog.data?.filter((m) => m.capability === capability) ?? [];
  const entry = models.find((m) => m.ref === model);

  // модель за замовчуванням з налаштувань (або перша доступна) при зміні вкладки
  useEffect(() => {
    const preferred = settings.data?.defaults[capability];
    const fallback = models.find((m) => m.available)?.ref ?? '';
    setModel(preferred?.available ? preferred.ref : fallback);
  }, [capability, catalog.data, settings.data]);

  useEffect(() => {
    if (!entry) return;
    if (entry.aspects && !entry.aspects.includes(aspect)) setAspect(entry.aspects[0]!);
    if (n > (entry.maxN ?? 1)) setN(1);
    setDurationSec(entry.durations?.[0]);
  }, [entry?.ref]);

  const estimate = useQuery(
    trpc.generate.estimate.queryOptions(
      { capability, model: model as ModelRef, n: capability === 'image' ? n : undefined, durationSec },
      { enabled: !!model },
    ),
  );
  const onStarted = () => {
    toast.success('Генерацію запущено');
    void qc.invalidateQueries({ queryKey: trpc.generate.list.queryKey() });
    setPrompt('');
    onOpenChange(false);
  };
  const image = useMutation(trpc.generate.image.mutationOptions({ onSuccess: onStarted }));
  const video = useMutation(trpc.generate.video.mutationOptions({ onSuccess: onStarted }));
  const pending = image.isPending || video.isPending;

  const submit = () => {
    if (!model || !prompt.trim()) return;
    if (capability === 'image') image.mutate({ model, prompt, aspect, n });
    else video.mutate({ model, prompt, aspect, durationSec });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Згенерувати</DialogTitle>
          <DialogDescription>Результат з’явиться в бібліотеці й знаходитиметься за словами з опису.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Tabs value={capability} onValueChange={(v) => setCapability(v as Capability)}>
            <TabsList>
              <TabsTrigger value="image">Фото</TabsTrigger>
              <TabsTrigger value="video">Відео</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="grid gap-1.5">
            <Label htmlFor="gen-prompt">Опис</Label>
            <Textarea
              id="gen-prompt"
              rows={4}
              maxLength={4000}
              placeholder="Напр.: рудий кіт у скафандрі на тлі Землі, кінематографічне світло"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="gen-model">Модель</Label>
            <Select value={model} onValueChange={(v) => setModel(v as ModelRef)}>
              <SelectTrigger id="gen-model" className="w-full">
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
          {entry?.aspects && (
            <div className="grid gap-1.5">
              <Label>Формат</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                value={aspect}
                onValueChange={(v) => v && setAspect(v as Aspect)}
                aria-label="Формат"
              >
                {entry.aspects.map((a) => (
                  <ToggleGroupItem key={a} value={a} aria-label={a}>
                    {ASPECT_LABELS[a]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          )}
          {capability === 'image' && (entry?.maxN ?? 1) > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor="gen-n">Кількість</Label>
              <Select value={String(n)} onValueChange={(v) => setN(Number(v))}>
                <SelectTrigger id="gen-n" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: entry?.maxN ?? 1 }, (_, i) => (
                    <SelectItem key={i} value={String(i + 1)}>
                      {i + 1}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {capability === 'video' && entry?.durations && (
            <div className="grid gap-1.5">
              <Label htmlFor="gen-duration">Тривалість</Label>
              <Select value={String(durationSec ?? '')} onValueChange={(v) => setDurationSec(Number(v))}>
                <SelectTrigger id="gen-duration" className="w-28">
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
          {capability === 'video' && entry?.durationRange && (
            <p className="text-sm text-muted-foreground">
              Тривалість обирає модель: {entry.durationRange[0]}–{entry.durationRange[1]} с.
            </p>
          )}
          <p className="text-sm text-muted-foreground" data-testid="gen-estimate">
            Орієнтовна вартість: {entry?.durationRange ? 'до ' : '≈ '}
            {formatUsd(estimate.data?.usd)}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Скасувати
          </Button>
          <Button disabled={!model || !prompt.trim() || pending} onClick={submit}>
            Згенерувати
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
