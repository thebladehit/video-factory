import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/lib/trpc';

export function AutoTagToggle() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const set = useMutation(
    trpc.settings.setAutoTag.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Бібліотека</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="flex items-center gap-3">
          <Switch
            id="auto-tag"
            aria-label="Авто-теги для завантажених файлів"
            checked={settings.data?.autoTagUploads ?? false}
            disabled={!settings.data || set.isPending}
            onCheckedChange={(enabled) => set.mutate({ enabled })}
          />
          <Label htmlFor="auto-tag">Авто-теги для завантажених файлів</Label>
        </div>
        <p className="text-sm text-muted-foreground">
          Модель для тегів дивиться на мініатюру й додає 5–10 тегів. ≈ $0.0001–0.0003 за файл на дешевій моделі (напр.
          Claude Haiku 5.5). Згенеровані файли отримують теги з опису завжди.
        </p>
      </CardContent>
    </Card>
  );
}
