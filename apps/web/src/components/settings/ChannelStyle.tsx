import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc';

export function ChannelStyle() {
  const trpc = useTRPC();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const [text, setText] = useState('');
  const save = useMutation(trpc.settings.setChannelStyle.mutationOptions());
  useEffect(() => {
    if (settings.data) setText(settings.data.channelStyle);
  }, [settings.data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Стиль каналу</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Label htmlFor="channel-style" className="sr-only">
          Стиль каналу
        </Label>
        <Textarea
          id="channel-style"
          value={text}
          maxLength={4000}
          placeholder="Тон, аудиторія, заборонені теми — додається до промптів сценарію"
          onChange={(e) => {
            setText(e.target.value);
            save.reset();
          }}
        />
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate({ text })} disabled={save.isPending}>
            Зберегти
          </Button>
          {save.isSuccess && <span className="text-sm text-muted-foreground">Збережено</span>}
        </div>
      </CardContent>
    </Card>
  );
}
