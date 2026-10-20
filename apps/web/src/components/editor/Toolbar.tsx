import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { VideoFormat } from '@vf/shared';
import { setFormat } from '@vf/timeline';
import { ArrowLeft, Check, CloudOff, Loader2, Redo2, Undo2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { SaveState } from '@/editor/autosave';
import type { EditorStore } from '@/editor/store';
import { useTRPC } from '@/lib/trpc';

const SAVE_LABEL: Record<SaveState, ReactNode> = {
  saved: (
    <>
      <Check className="size-4" /> Збережено
    </>
  ),
  saving: (
    <>
      <Loader2 className="size-4 animate-spin" /> Зберігаю…
    </>
  ),
  error: (
    <>
      <CloudOff className="size-4" /> Не збережено — повторити
    </>
  ),
  conflict: (
    <>
      <CloudOff className="size-4" /> Конфлікт версій
    </>
  ),
};

export function Toolbar({
  projectId,
  title,
  store,
  saveState,
  onRetrySave,
  children,
}: {
  projectId: string;
  title: string;
  store: EditorStore;
  saveState: SaveState;
  onRetrySave(): void;
  children?: ReactNode;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(title);
  const rename = useMutation(
    trpc.projects.rename.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.projects.pathKey() }),
    }),
  );
  const doc = useStore(store, (s) => s.doc);
  const canUndo = useStore(store.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(store.temporal, (s) => s.futureStates.length > 0);
  const format: VideoFormat = doc.width < doc.height ? '9:16' : '16:9';
  const commit = () => {
    setEditing(false);
    if (name.trim() && name.trim() !== title) rename.mutate({ id: projectId, title: name.trim() });
    else setName(title);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b pb-2">
      <Button asChild variant="ghost" size="icon" aria-label="До проєктів">
        <Link to="/">
          <ArrowLeft />
        </Link>
      </Button>
      {editing ? (
        <Input
          aria-label="Назва проєкту"
          className="h-8 w-64"
          value={name}
          autoFocus
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setName(title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="truncate text-lg font-semibold hover:underline"
          onClick={() => setEditing(true)}
        >
          {name}
        </button>
      )}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={format}
        onValueChange={(v) => v && store.getState().apply((d) => setFormat(d, v as VideoFormat))}
      >
        <ToggleGroupItem value="9:16">9:16</ToggleGroupItem>
        <ToggleGroupItem value="16:9">16:9</ToggleGroupItem>
      </ToggleGroup>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Скасувати"
        disabled={!canUndo}
        onClick={() => store.temporal.getState().undo()}
      >
        <Undo2 />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Повторити"
        disabled={!canRedo}
        onClick={() => store.temporal.getState().redo()}
      >
        <Redo2 />
      </Button>
      <button
        type="button"
        data-testid="save-state"
        data-state={saveState}
        disabled={saveState !== 'error'}
        onClick={onRetrySave}
        className={`flex items-center gap-1 text-sm ${saveState === 'error' || saveState === 'conflict' ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {SAVE_LABEL[saveState]}
      </button>
      <div className="ml-auto">{children}</div>
    </div>
  );
}
