import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PLATFORM_LABELS, PLATFORMS, type Platform } from '@vf/shared';
import { Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration } from '@/components/library/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useJobFeed } from '@/lib/job-feed';
import { useTRPC } from '@/lib/trpc';
import { PlatformIcon } from './AccountsStrip';
import { PublicationCell } from './PublicationCell';
import type { PublicationRow, VersionRow } from './types';

export interface PublishTarget {
  projectId?: string;
  language?: string;
  platform?: Platform;
}

/** Стани, які змінює тік на сервері без подій задач — їх доопитуємо */
const POLLED = new Set(['scheduled', 'uploading', 'processing']);
const NEEDS_ACTION = new Set(['awaiting_manual', 'failed']);
const cellKey = (projectId: string, language: string, platform: Platform) => `${projectId}:${language}:${platform}`;

/**
 * Матриця «мовна версія × платформа». У комірці — остання публікація на кожен акаунт
 * (старші спроби того самого акаунта ховаються).
 */
export function PublishMatrix({
  onPublish,
  onEdit,
}: {
  onPublish(target: PublishTarget): void;
  onEdit?(p: PublicationRow): void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const versions = useQuery(trpc.publish.versions.queryOptions());
  const list = useQuery({
    ...trpc.publish.list.queryOptions(),
    refetchInterval: (q) => (q.state.data?.some((p) => POLLED.has(p.status)) ? 15_000 : false),
  });
  const [needsAction, setNeedsAction] = useState(false);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const now = useNow(30_000);

  // прогрес завантаження — з подій задач `publish`; зміна стану задачі → свіжий список
  const running = useRef(new Set<string>());
  useJobFeed((e) => {
    const id = e.type === 'publish' ? e.subject.publicationId : undefined;
    if (!id) return;
    if (e.status === 'running') {
      setProgress((prev) => (prev[id] === e.progress ? prev : { ...prev, [id]: e.progress }));
      if (running.current.has(id)) return;
      running.current.add(id);
    } else running.current.delete(id);
    void qc.invalidateQueries({ queryKey: trpc.publish.list.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.publish.pendingCount.queryKey() });
  });

  const cells = useMemo(() => {
    const map = new Map<string, PublicationRow[]>();
    const seenAccounts = new Set<string>();
    // список від нових до старих: перша публікація на (версія, акаунт) — найсвіжіша
    for (const p of list.data ?? []) {
      const key = cellKey(p.projectId, p.language, p.platform);
      if (seenAccounts.has(`${key}:${p.accountId}`)) continue;
      seenAccounts.add(`${key}:${p.accountId}`);
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return map;
  }, [list.data]);

  // рядки матриці — лише мовні версії з готовим рендером; мови без нього видно в діалозі публікації
  const rendered = (versions.data ?? []).filter((v) => v.renderId !== null);
  const rows = rendered.filter(
    (v) =>
      !needsAction ||
      PLATFORMS.some((pl) => cells.get(cellKey(v.projectId, v.language, pl))?.some((p) => NEEDS_ACTION.has(p.status))),
  );

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-medium">Відео</h2>
        <Button
          variant={needsAction ? 'secondary' : 'outline'}
          aria-pressed={needsAction}
          data-testid="filter-needs-action"
          onClick={() => setNeedsAction(!needsAction)}
        >
          Потребують дій
        </Button>
        <Button data-testid="publish-open" onClick={() => onPublish({})}>
          <Send /> Опублікувати…
        </Button>
      </div>
      {versions.isPending || list.isPending ? (
        <Skeleton className="h-40" />
      ) : !rendered.length ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Немає готових відео: зробіть фінальний рендер у редакторі проєкту.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table data-testid="publish-matrix" className="w-full min-w-[56rem] text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="w-72 px-3 py-2 font-medium">Мовна версія</th>
                {PLATFORMS.map((pl) => (
                  <th key={pl} className="px-3 py-2 font-medium">
                    <span className="flex items-center gap-2">
                      <PlatformIcon platform={pl} className="size-5 text-[8px]" />
                      {PLATFORM_LABELS[pl]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={`${v.projectId}:${v.language}`} data-testid="publish-row" className="border-t align-top">
                  <td className="px-3 py-2">
                    <VersionHeader version={v} />
                  </td>
                  {PLATFORMS.map((pl) => (
                    <td key={pl} className="px-3 py-2">
                      <PublicationCell
                        version={v}
                        platform={pl}
                        publications={cells.get(cellKey(v.projectId, v.language, pl)) ?? []}
                        progress={progress}
                        now={now}
                        onPublish={() => onPublish({ projectId: v.projectId, language: v.language, platform: pl })}
                        onEdit={onEdit}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={PLATFORMS.length + 1} className="px-3 py-6 text-center text-muted-foreground">
                    Усе зроблено — немає публікацій, що чекають на вас
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function VersionHeader({ version: v }: { version: VersionRow }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
        {v.thumbUrl && <img src={v.thumbUrl} alt="" className="size-full object-cover" />}
      </div>
      <div className="grid min-w-0 content-start gap-1">
        <Link
          to="/projects/$id"
          params={{ id: v.projectId }}
          className="truncate font-medium hover:underline"
          title={v.projectTitle}
        >
          {v.projectTitle}
        </Link>
        <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <Badge variant="outline">{v.language.toUpperCase()}</Badge>
          <Badge variant="secondary">{v.format}</Badge>
          {v.durationMs !== null && <span className="tabular-nums">{formatDuration(v.durationMs)}</span>}
        </span>
      </div>
    </div>
  );
}

/** Поточний час, що оновлюється — щоб «Заплановано на YouTube» змінилось на «Опубліковано» вчасно */
function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
