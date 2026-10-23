import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABELS } from '@vf/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTRPC } from '@/lib/trpc';
import { MetaFields, metaErrors, withDefaults } from './MetaEditor';
import { timeError, toLocalInput } from './PublishDialog';
import type { PublicationRow } from './types';

/** «Змінити» запланованої чи ручної публікації: метадані й час */
export function EditPublicationDialog({
  publication,
  onOpenChange,
}: {
  publication: PublicationRow | null;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={publication !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {publication && <EditForm key={publication.id} p={publication} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ p, onDone }: { p: PublicationRow; onDone(): void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [meta, setMeta] = useState(() => withDefaults(p.platform, p.metadata));
  const [when, setWhen] = useState<'now' | 'at'>(p.scheduledAt ? 'at' : 'now');
  const [at, setAt] = useState(p.scheduledAt ? toLocalInput(new Date(p.scheduledAt)) : '');
  const update = useMutation(
    trpc.publish.updateMeta.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.publish.pathKey() });
        onDone();
      },
    }),
  );
  const whenError = timeError(when, at, p.platform === 'youtube');
  const invalid = metaErrors(p.platform, meta).all.length > 0 || Boolean(whenError);

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          Змінити публікацію · {p.language.toUpperCase()} · {PLATFORM_LABELS[p.platform]}
        </DialogTitle>
      </DialogHeader>
      <MetaFields idPrefix={`edit-${p.id}`} platform={p.platform} meta={meta} onChange={setMeta} />
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          value={when}
          onValueChange={(v) => {
            if (!v) return;
            setWhen(v as 'now' | 'at');
            if (v === 'at' && !at) setAt(toLocalInput(new Date(Date.now() + 60 * 60_000)));
          }}
        >
          <ToggleGroupItem value="now">Зараз</ToggleGroupItem>
          <ToggleGroupItem value="at">Дата й час</ToggleGroupItem>
        </ToggleGroup>
        {when === 'at' && (
          <Input
            type="datetime-local"
            aria-label="Дата й час публікації"
            className="w-auto"
            value={at}
            min={toLocalInput(new Date())}
            aria-invalid={Boolean(whenError)}
            onChange={(e) => setAt(e.target.value)}
          />
        )}
      </div>
      {whenError && <p className="text-xs text-destructive">{whenError}</p>}
      <DialogFooter>
        <Button
          disabled={invalid || update.isPending}
          onClick={() =>
            update.mutate({ id: p.id, meta, scheduledAt: when === 'at' ? new Date(at).toISOString() : null })
          }
        >
          Зберегти
        </Button>
      </DialogFooter>
    </div>
  );
}
