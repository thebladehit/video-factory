import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ProjectCard } from '@vf/api';
import { Clapperboard, Copy, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc';

const rtf = new Intl.RelativeTimeFormat('uk', { numeric: 'auto' });
export function changedAgo(iso: string): string {
  const sec = (Date.parse(iso) - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
  ];
  let v = sec;
  for (const [unit, size] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return rtf.format(Math.round(v), 'year');
}

export const formatSec = (sec: number) => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function ProjectGrid() {
  const trpc = useTRPC();
  const list = useQuery(trpc.projects.list.queryOptions());
  if (list.isPending)
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="aspect-video" />
        ))}
      </div>
    );
  if (!list.data?.length)
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-muted-foreground">
        <Clapperboard className="size-10" />
        <p>Створіть перший проєкт</p>
      </div>
    );
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
      {list.data.map((p) => (
        <ProjectCardView key={p.id} project={p} />
      ))}
    </div>
  );
}

function ProjectCardView({ project }: { project: ProjectCard }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [title, setTitle] = useState(project.title);
  const rename = useMutation(trpc.projects.rename.mutationOptions({ onSuccess: refresh }));
  const duplicate = useMutation(trpc.projects.duplicate.mutationOptions({ onSuccess: refresh }));
  const remove = useMutation(trpc.projects.delete.mutationOptions({ onSuccess: refresh }));

  return (
    <div data-testid="project-card" className="group relative overflow-hidden rounded-lg border bg-card">
      <Link to="/projects/$id" params={{ id: project.id }} className="block focus-visible:outline-none">
        <div className="flex aspect-video items-center justify-center bg-muted">
          {project.thumbUrl ? (
            <img
              src={project.thumbUrl}
              alt=""
              className={project.format === '9:16' ? 'h-full object-cover' : 'size-full object-cover'}
            />
          ) : (
            <div
              className={`rounded border-2 border-dashed border-muted-foreground/30 ${project.format === '9:16' ? 'h-3/4 aspect-[9/16]' : 'w-3/4 aspect-video'}`}
            />
          )}
        </div>
        <div className="grid gap-1 p-3">
          <span className="truncate pr-8 font-medium">{project.title}</span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{project.format}</Badge>
            <span className="tabular-nums">{formatSec(project.durationSec)}</span>
            <span>· змінено {changedAgo(project.updatedAt)}</span>
          </span>
        </div>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="absolute right-1 bottom-9" aria-label="Дії з проєктом">
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setTitle(project.title);
              setRenaming(true);
            }}
          >
            <Pencil /> Перейменувати
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => duplicate.mutate({ id: project.id })}>
            <Copy /> Дублювати
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2 /> Видалити
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-md">
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!title.trim()) return;
              rename.mutate({ id: project.id, title: title.trim() }, { onSuccess: () => setRenaming(false) });
            }}
          >
            <DialogHeader>
              <DialogTitle>Перейменувати проєкт</DialogTitle>
            </DialogHeader>
            <Input
              aria-label="Назва"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              autoFocus
            />
            <DialogFooter>
              <Button type="submit" disabled={!title.trim() || rename.isPending}>
                Зберегти
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Видалити проєкт «{project.title}»?</AlertDialogTitle>
            <AlertDialogDescription>Готові рендери лишаться в бібліотеці.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Скасувати</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate({ id: project.id })}>
              Видалити
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
