import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { PipelineView } from '@vf/api';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
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
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/lib/trpc';
import { waitUntilIdle } from '@/pipeline/settle';
import { usePipeline } from '@/pipeline/use-pipeline';
import { SceneRow } from './SceneRow';
import { StageBar } from './StageBar';

const NEW_SCENE_TEXT = 'Нова сцена';

const isConflict = (e: unknown) => (e as { data?: { code?: string } } | null)?.data?.code === 'CONFLICT';

/** Скільки «Продовжити» чекає на збереження правок тексту, перш ніж іти далі */
const SETTLE_TIMEOUT_MS = 10_000;

/** Сторінка сцен конвеєра (спека §6.2). */
export function PipelinePage({ projectId }: { projectId: string }) {
  const { view, error, isPending, refetch, opening } = usePipeline(projectId);
  if (error) return <p className="text-destructive">{error.message}</p>;
  if (isPending || !view) return <p className="text-muted-foreground">Завантаження…</p>;
  return <PipelineContent view={view} refetch={refetch} opening={opening} />;
}

function PipelineContent({ view, refetch, opening }: { view: PipelineView; refetch(): void; opening: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { project, run, scenes } = view;
  const projectId = project.id;
  const onError = (e: { message: string }) => toast.error(e.message);
  const cancel = useMutation(trpc.pipeline.cancel.mutationOptions({ onSuccess: refetch, onError }));
  const retry = useMutation(trpc.pipeline.retry.mutationOptions({ onSuccess: refetch, onError }));
  const cont = useMutation(trpc.pipeline.continue.mutationOptions({ onSuccess: refetch, onError }));
  const add = useMutation(trpc.pipeline.addScene.mutationOptions({ onSuccess: refetch, onError }));
  const move = useMutation(trpc.pipeline.moveScene.mutationOptions({ onSuccess: refetch, onError }));
  const reassemble = useMutation(
    trpc.pipeline.reassemble.mutationOptions({
      onSuccess: () => {
        toast.success('Чернетка перезбирається');
        refetch();
      },
      onError: (e) => toast.error(isConflict(e) ? 'Таймлайн змінено — оновіть сторінку' : e.message),
    }),
  );
  const [confirmReassemble, setConfirmReassemble] = useState(false);
  const [settling, setSettling] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const review = run.stage === 'review';
  const live = run.status === 'running';
  const stopped = run.status === 'failed' || run.status === 'cancelled';
  const ready = run.stage === 'done' && run.status === 'done';
  const base = view.languages.find((l) => l.language === project.baseLanguage);
  const noBaseVoice = ready && !!base && base.total > 0 && base.ready === 0;

  const drop = (targetId: string) => {
    const to = scenes.findIndex((s) => s.id === targetId);
    if (dragId && dragId !== targetId && to >= 0) move.mutate({ sceneId: dragId, position: to });
    setDragId(null);
    setOverId(null);
  };

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-start gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="До проєктів">
          <Link to="/">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h1 className="truncate text-lg font-semibold">{project.title || 'Без назви'}</h1>
          {project.topic && (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer select-none">Тема</summary>
              <p className="mt-1 whitespace-pre-wrap">{project.topic}</p>
            </details>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {live && (
            <Button
              variant="outline"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ projectId })}
            >
              Скасувати
            </Button>
          )}
          {stopped && (
            <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate({ projectId })}>
              Повторити
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link to="/projects/$id" params={{ id: projectId }}>
              Відкрити в редакторі
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/voice/$id" params={{ id: projectId }}>
              Студія озвучки
            </Link>
          </Button>
          {ready && (
            <Button
              variant="outline"
              size="sm"
              disabled={reassemble.isPending}
              onClick={() => setConfirmReassemble(true)}
            >
              Пересібрати
            </Button>
          )}
        </div>
      </header>

      <StageBar view={view} />
      {opening && <p className="text-sm text-muted-foreground">Чернетку зібрано — відкриваємо редактор…</p>}
      {noBaseVoice && (
        <p role="status" className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          Озвучка не вдалася — повторіть у студії
        </p>
      )}

      {scenes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{live ? 'Сценарій створюється…' : 'Сцен немає'}</p>
      ) : (
        <ol className="grid gap-2" onDragEnd={() => (setDragId(null), setOverId(null))}>
          {scenes.map((s, i) => (
            <SceneRow
              key={s.id}
              scene={s}
              index={i + 1}
              count={scenes.length}
              view={view}
              dragOver={!!dragId && overId === s.id && dragId !== s.id}
              onChanged={refetch}
              onDragStart={() => setDragId(s.id)}
              onDragOverRow={() => setOverId(s.id)}
              onDropRow={() => drop(s.id)}
              onMove={(position) => move.mutate({ sceneId: s.id, position })}
            />
          ))}
        </ol>
      )}

      {review && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={add.isPending}
            onClick={() => add.mutate({ projectId, narration: NEW_SCENE_TEXT })}
          >
            + сцена
          </Button>
          <Button
            className="ml-auto"
            disabled={cont.isPending || settling}
            onClick={async () => {
              // blur перед кліком уже поставив `updateScene` — продовжуємо, коли правки збережено
              setSettling(true);
              const mutationKey = trpc.pipeline.updateScene.mutationKey();
              await waitUntilIdle(() => qc.isMutating({ mutationKey }) > 0, {
                stepMs: 50,
                timeoutMs: SETTLE_TIMEOUT_MS,
              });
              setSettling(false);
              cont.mutate({ projectId });
            }}
          >
            Продовжити
          </Button>
        </div>
      )}

      <AlertDialog open={confirmReassemble} onOpenChange={setConfirmReassemble}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Пересібрати чернетку?</AlertDialogTitle>
            <AlertDialogDescription>Ручні зміни таймлайну буде втрачено</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Скасувати</AlertDialogCancel>
            <AlertDialogAction onClick={() => reassemble.mutate({ projectId, version: project.timelineVersion })}>
              Пересібрати
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
