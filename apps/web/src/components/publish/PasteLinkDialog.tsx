import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parsePostUrl } from '@vf/publish/client';
import { PLATFORM_LABELS, type Platform } from '@vf/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTRPC } from '@/lib/trpc';

/** «Вставити посилання» для ручної публікації: URL посту → `published` */
export function PasteLinkDialog({
  open,
  onOpenChange,
  publicationId,
  platform,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  publicationId: string;
  platform: Platform;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* форма монтується при кожному відкритті — поле щоразу порожнє */}
        {open && <PasteLinkForm publicationId={publicationId} platform={platform} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function PasteLinkForm({
  publicationId,
  platform,
  onDone,
}: {
  publicationId: string;
  platform: Platform;
  onDone(): void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const mark = useMutation(
    trpc.publish.markPublished.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.publish.pathKey() });
        toast.success('Публікацію позначено опублікованою');
        onDone();
      },
    }),
  );
  const label = PLATFORM_LABELS[platform];
  const trimmed = url.trim();
  // перевірка на клієнті — лише підказка; остаточно перевіряє сервер
  const foreign = Boolean(trimmed) && !parsePostUrl(platform, trimmed);

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed && !foreign) mark.mutate({ id: publicationId, url: trimmed });
      }}
    >
      <DialogHeader>
        <DialogTitle>Вставити посилання</DialogTitle>
        <DialogDescription>Посилання на опублікований пост у {label}.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1">
        <Input
          data-testid="paste-link-input"
          aria-label="Посилання на пост"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://"
          aria-invalid={foreign}
          autoFocus
        />
        {foreign && <p className="text-xs text-destructive">Це не посилання на {label}</p>}
      </div>
      <DialogFooter>
        <Button data-testid="paste-link-submit" type="submit" disabled={!trimmed || foreign || mark.isPending}>
          Зберегти
        </Button>
      </DialogFooter>
    </form>
  );
}
