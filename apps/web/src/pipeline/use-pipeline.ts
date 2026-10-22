import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { PipelineView } from '@vf/api';
import { pipelineSettingsSchema } from '@vf/shared';
import { useEffect, useRef, useState } from 'react';
import { useJobFeed } from '@/lib/job-feed';
import { useTRPC } from '@/lib/trpc';
import { createEventCoalescer } from '@/voice/coalesce';
import { toSettings, type PipelineForm } from './settings-form';
import { isPipelineEvent, justFinished } from './stages';

const EVENT_COALESCE_MS = 200;
/** Страховка, якщо подію пропущено (напр. advance після кінцевої події завершився пізніше за refetch) */
const LIVE_POLL_MS = 5000;
const OPEN_EDITOR_DELAY_MS = 1500;

/** Значення, що встановлюється через `ms` після останньої зміни. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** `pipeline.estimate` з debounce 300 мс; запит лише коли форма проходить схему (інакше API відповів би VALIDATION). */
export function usePipelineEstimate(form: PipelineForm) {
  const trpc = useTRPC();
  const debounced = useDebounced(form, 300);
  const settings = toSettings(debounced);
  const valid = pipelineSettingsSchema.safeParse(settings).success;
  const query = useQuery({
    ...trpc.pipeline.estimate.queryOptions(settings),
    enabled: valid,
    placeholderData: (prev) => prev,
  });
  return { estimate: valid ? query.data : undefined, pending: valid && (query.isFetching || debounced !== form) };
}

/**
 * Стан сторінки сцен: `pipeline.get` з refetch за подіями задач запуску (об'єднання 200 мс, як у студії)
 * і автоперехід у редактор при першому переході запуску в `done`, поки сторінка відкрита.
 */
export function usePipeline(projectId: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const queryKey = trpc.pipeline.get.queryKey({ projectId });
  const query = useQuery({
    ...trpc.pipeline.get.queryOptions({ projectId }),
    refetchInterval: (q) => (q.state.data?.run.status === 'running' ? LIVE_POLL_MS : false),
  });
  const view = useRef<PipelineView | undefined>(undefined);
  view.current = query.data;

  const refetch = () => void qc.invalidateQueries({ queryKey });
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const [coalescer] = useState(() =>
    createEventCoalescer({
      delayMs: EVENT_COALESCE_MS,
      onProgress: () => refetchRef.current(),
      onTerminal: () => refetchRef.current(),
    }),
  );
  useEffect(() => () => coalescer.dispose(), [coalescer]);
  useJobFeed((e) => {
    if (isPipelineEvent(e, view.current, projectId)) coalescer.push(false);
  });

  // перший перехід у done, побачений цією сторінкою (а не відкриття вже готового запуску)
  const prevRun = useRef<PipelineView['run'] | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  // закешований знімок з попереднього відкриття не рахується: інакше давно готовий запуск «щойно завершився б»
  const run = query.isFetchedAfterMount ? query.data?.run : undefined;
  useEffect(() => {
    if (!run) return;
    const finished = justFinished(prevRun.current, run);
    prevRun.current = run;
    if (finished) setOpening(true);
  }, [run]);
  // коротка пауза, щоб «Готово» встигло з'явитись; вихід зі сторінки скасовує перехід
  useEffect(() => {
    if (!opening) return;
    const t = setTimeout(() => void navigate({ to: '/projects/$id', params: { id: projectId } }), OPEN_EDITOR_DELAY_MS);
    return () => clearTimeout(t);
  }, [opening, navigate, projectId]);

  return { view: query.data, error: query.error, isPending: query.isPending, refetch, opening };
}
