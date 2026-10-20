import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc';

export function HealthCard() {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.health.check.queryOptions(undefined, { refetchInterval: 10_000 }));
  const down = data && (data.db === 'down' || data.storage === 'down');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Інфраструктура</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        {!data ? (
          <span className="text-muted-foreground">Перевіряю…</span>
        ) : (
          <>
            <Badge variant={data.db === 'up' ? 'secondary' : 'destructive'}>
              База даних: {data.db === 'up' ? 'працює' : 'недоступна'}
            </Badge>
            <Badge variant={data.storage === 'up' ? 'secondary' : 'destructive'}>
              Сховище: {data.storage === 'up' ? 'працює' : 'недоступне'}
            </Badge>
          </>
        )}
        {down && (
          <p className="w-full text-sm text-muted-foreground">
            Запустіть <code>docker compose up -d</code>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
