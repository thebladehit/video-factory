import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { VideoFormat } from '@vf/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTRPC } from '@/lib/trpc';

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('Новий проєкт');
  const [format, setFormat] = useState<VideoFormat>('9:16');
  useEffect(() => {
    if (open) setTitle('Новий проєкт');
  }, [open]);
  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: ({ id }) => {
        void qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
        onOpenChange(false);
        void navigate({ to: '/projects/$id', params: { id } });
      },
    }),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate({ title: title.trim(), format });
          }}
        >
          <DialogHeader>
            <DialogTitle>Новий проєкт</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="project-title">Назва</Label>
            <Input
              id="project-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label>Формат</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={format}
              onValueChange={(v) => v && setFormat(v as VideoFormat)}
              className="justify-start"
            >
              <ToggleGroupItem value="9:16" aria-label="9:16">
                9:16 · Shorts
              </ToggleGroupItem>
              <ToggleGroupItem value="16:9" aria-label="16:9">
                16:9 · YouTube
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!title.trim() || create.isPending}>
              Створити
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
