import { useMutation } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useState } from 'react';
import { TERMINAL_STATUSES, type JobEvent, type JobStatus } from '@vf/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { useTRPC } from '@/lib/trpc';

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Очікує',
  running: 'Виконується',
  done: 'Готово',
  failed: 'Помилка',
  cancelled: 'Скасовано',
};

/** Перевірка черги задач: живий прогрес через SSE, скасування, повтор. */
export function DebugJobCard() {
  const trpc = useTRPC();
  const [seconds, setSeconds] = useState(5);
  const [steps, setSteps] = useState(5);
  const [jobId, setJobId] = useState<string | null>(null);
  const [event, setEvent] = useState<JobEvent | null>(null);

  const track = (id: string) => {
    setEvent(null);
    setJobId(id);
  };
  const enqueue = useMutation(trpc.jobs.enqueueDebug.mutationOptions({ onSuccess: (r) => track(r.jobId) }));
  const retry = useMutation(trpc.jobs.retry.mutationOptions({ onSuccess: (r) => track(r.jobId) }));
  const cancel = useMutation(trpc.jobs.cancel.mutationOptions());
  useSubscription(
    trpc.jobs.events.subscriptionOptions({ id: jobId ?? '' }, { enabled: !!jobId, onData: (e) => setEvent(e) }),
  );

  const terminal = event ? TERMINAL_STATUSES.has(event.status) : false;

  return (
    <Card data-testid="debug-job">
      <CardHeader>
        <CardTitle>Тестова задача</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="debug-seconds">Тривалість, с</Label>
            <Input
              id="debug-seconds"
              type="number"
              min={1}
              max={60}
              className="w-28"
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="debug-steps">Кроків</Label>
            <Input
              id="debug-steps"
              type="number"
              min={1}
              max={100}
              className="w-28"
              value={steps}
              onChange={(e) => setSteps(Number(e.target.value))}
            />
          </div>
          <Button
            disabled={enqueue.isPending}
            onClick={() => enqueue.mutate({ durationMs: Math.round(seconds * 1000), steps })}
          >
            Запустити
          </Button>
        </div>

        {event && (
          <div className="grid gap-2">
            <div className="flex items-center gap-3">
              <Badge variant={event.status === 'failed' ? 'destructive' : 'secondary'}>
                {STATUS_LABELS[event.status]}
              </Badge>
              <span className="text-sm tabular-nums">{Math.round(event.progress)}%</span>
              {event.message && <span className="text-sm text-muted-foreground">{event.message}</span>}
            </div>
            <Progress value={event.progress} />
            {event.error && <p className="text-sm text-destructive">{event.error}</p>}
            <div className="flex gap-2">
              {!terminal && (
                <Button variant="outline" onClick={() => cancel.mutate({ id: event.jobId })}>
                  Скасувати
                </Button>
              )}
              {(event.status === 'failed' || event.status === 'cancelled') && (
                <Button variant="outline" onClick={() => retry.mutate({ id: event.jobId })}>
                  Повторити
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
