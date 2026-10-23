import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatForCopy } from '@vf/publish/client';
import type { Platform } from '@vf/shared';
import { Copy, Download, ExternalLink, Link2, Pencil, Plus, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/lib/trpc';
import { PasteLinkDialog } from './PasteLinkDialog';
import { statusLabel, statusTone } from './status';
import type { PublicationRow, VersionRow } from './types';

/** Комірка матриці: публікації мовної версії на одній платформі (зазвичай одна) або «+» */
export function PublicationCell({
  version,
  platform,
  publications,
  progress,
  now,
  onPublish,
  onEdit,
}: {
  version: VersionRow;
  platform: Platform;
  publications: PublicationRow[];
  progress: Record<string, number>;
  now: Date;
  onPublish(): void;
  onEdit?(p: PublicationRow): void;
}) {
  return (
    <div
      data-testid="publication-cell"
      data-platform={platform}
      data-language={version.language}
      data-project={version.projectId}
      className="grid min-h-12 content-start gap-2"
    >
      {publications.length === 0 ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label="Опублікувати"
          data-testid="cell-publish"
          onClick={onPublish}
        >
          <Plus />
        </Button>
      ) : (
        publications.map((p) => (
          <PublicationItem key={p.id} p={p} progress={progress[p.id]} now={now} onEdit={onEdit} />
        ))
      )}
    </div>
  );
}

function PublicationItem({
  p,
  progress,
  now,
  onEdit,
}: {
  p: PublicationRow;
  progress: number | undefined;
  now: Date;
  onEdit?(p: PublicationRow): void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.publish.pathKey() });
  const [pasting, setPasting] = useState(false);
  const download = useMutation(
    trpc.publish.downloadUrl.mutationOptions({ onSuccess: ({ url }) => window.location.assign(url) }),
  );
  const cancel = useMutation(trpc.publish.cancel.mutationOptions({ onSuccess: refresh }));
  const retry = useMutation(trpc.publish.retry.mutationOptions({ onSuccess: refresh }));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatForCopy(p.platform, p.metadata));
      toast.success('Метадані скопійовано');
    } catch {
      toast.error('Не вдалося скопіювати — браузер не дав доступу до буфера обміну');
    }
  };
  const editable = p.status === 'scheduled' || p.status === 'awaiting_manual';

  return (
    <div data-testid="publication" data-status={p.status} className="grid gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant={statusTone(p.status)} data-testid="publication-status">
          {statusLabel({ ...p, progress }, now)}
        </Badge>
        {p.url && (
          <a
            href={p.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Відкрити публікацію"
            data-testid="publication-link"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {p.status === 'failed' && p.error && (
        <p className="line-clamp-3 text-xs text-destructive" title={p.error}>
          {p.error}
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {p.status === 'awaiting_manual' && (
          <>
            <Button
              size="xs"
              variant="outline"
              data-testid="download-mp4"
              disabled={download.isPending}
              onClick={() => download.mutate({ id: p.id })}
            >
              <Download /> Завантажити MP4
            </Button>
            <Button size="xs" variant="outline" data-testid="copy-meta" onClick={() => void copy()}>
              <Copy /> Скопіювати метадані
            </Button>
          </>
        )}
        {p.method === 'manual' && (p.status === 'awaiting_manual' || p.status === 'scheduled') && (
          <Button size="xs" variant="outline" data-testid="paste-link" onClick={() => setPasting(true)}>
            <Link2 /> Вставити посилання
          </Button>
        )}
        {p.status === 'failed' && (
          <Button size="xs" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate({ id: p.id })}>
            <RotateCcw /> Повторити
          </Button>
        )}
        {editable && onEdit && (
          <Button size="xs" variant="ghost" onClick={() => onEdit(p)}>
            <Pencil /> Змінити
          </Button>
        )}
        {editable && (
          <Button size="xs" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: p.id })}>
            <X /> Скасувати
          </Button>
        )}
      </div>
      {p.method === 'manual' && (
        <PasteLinkDialog open={pasting} onOpenChange={setPasting} publicationId={p.id} platform={p.platform} />
      )}
    </div>
  );
}
