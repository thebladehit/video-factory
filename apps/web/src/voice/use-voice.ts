import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TERMINAL_STATUSES } from '@vf/shared';
import { useEffect, useRef } from 'react';
import { useJobFeed } from '@/lib/job-feed';
import { useTRPC } from '@/lib/trpc';

/** Прев'ю мови: документ, ASS і файли — той самий код, що й у рендері. */
export function useLocalized(projectId: string, language: string) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.voice.localized.queryOptions({ projectId, language }), placeholderData: (prev) => prev });
}

/**
 * Стан студії: `voice.get` з інвалідацією за подіями задач проєкту (`subject.projectId`) і його рядків (`subject.lineId`).
 * Прев'ю мови — `useLocalized` (той самий ключ інвалідується разом).
 */
export function useVoice(projectId: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const query = useQuery(trpc.voice.get.queryOptions({ projectId }));
  const lineIds = useRef(new Set<string>());
  lineIds.current = new Set(
    Object.values(query.data?.lines ?? {}).flatMap((byLang) => Object.values(byLang).map((l) => l.id)),
  );
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const languages = useRef<string[]>([]);
  languages.current = query.data?.languages ?? [];
  const refetchGet = () => void qc.invalidateQueries({ queryKey: trpc.voice.get.queryKey({ projectId }) });
  // прев'ю мов цього проєкту
  const refetchLocalized = () => {
    for (const language of languages.current)
      void qc.invalidateQueries({ queryKey: trpc.voice.localized.queryKey({ projectId, language }) });
  };
  const refetch = () => {
    refetchGet();
    refetchLocalized();
  };
  useJobFeed((e) => {
    if (!e.type.startsWith('voice.')) return;
    const mine = e.subject.projectId === projectId || (e.subject.lineId && lineIds.current.has(e.subject.lineId));
    if (!mine) return;
    // прогрес приходить часто — зливаємо в один запит; прев'ю (документ, озвучка) міняється лише коли задача завершилась
    const terminal = TERMINAL_STATUSES.has(e.status);
    clearTimeout(timer.current);
    timer.current = setTimeout(terminal ? refetch : refetchGet, 200);
  });

  return { view: query.data, error: query.error, isPending: query.isPending, refetch };
}
