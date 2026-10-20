import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_SLOTS, type DefaultSlot, type ModelRef } from '@vf/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc';
import { TestModel } from './TestModel';

export const CAPABILITY_LABELS: Record<DefaultSlot, string> = {
  text: 'Текст',
  image: 'Зображення',
  video: 'Відео',
  tts: 'Озвучка',
  stt: 'Розпізнавання мови',
  tagger: 'Модель для тегів',
};

export function ModelDefaults() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const catalog = useQuery(trpc.ai.catalog.queryOptions());
  const settings = useQuery(trpc.settings.get.queryOptions());
  const setDefault = useMutation(
    trpc.settings.setDefault.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Моделі за замовчуванням</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {DEFAULT_SLOTS.map((cap) => {
          // модель для тегів — текстова з підтримкою зображень
          const models =
            catalog.data?.filter((m) =>
              cap === 'tagger' ? m.capability === 'text' && m.vision : m.capability === cap,
            ) ?? [];
          const current = settings.data?.defaults[cap];
          const id = `model-${cap}`;
          return (
            <div key={cap} className="grid gap-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor={id}>{CAPABILITY_LABELS[cap]}</Label>
                {current && !current.available && <Badge variant="destructive">недоступна</Badge>}
              </div>
              {models.length === 0 ? (
                <p className="text-sm text-muted-foreground">Немає моделей (з'являться в наступних підпроєктах)</p>
              ) : (
                <div className="flex items-center gap-2">
                  <Select
                    value={current?.ref ?? ''}
                    onValueChange={(ref) => setDefault.mutate({ capability: cap, ref: ref as ModelRef })}
                  >
                    <SelectTrigger id={id} className="w-80">
                      <SelectValue placeholder="Не вибрано">
                        {current && (models.find((m) => m.ref === current.ref)?.label ?? current.ref)}
                      </SelectValue>
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
                  {cap === 'text' && <TestModel modelRef={current?.available ? current.ref : null} />}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
