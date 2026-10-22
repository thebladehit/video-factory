import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { PipelineView, SceneView } from '@vf/api';
import { ArrowDown, ArrowUp, GripVertical, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LINE_STATE_DOT, LINE_STATE_LABEL } from '@/components/voice/states';
import { useTRPC } from '@/lib/trpc';
import { createTextDraft } from '@/voice/text-draft';
import { SceneVisual } from './SceneVisual';

const SAVE_DEBOUNCE_MS = 600;
export const MAX_NARRATION_CHARS = 1500;
export const SCENE_MIME = 'application/x-vf-scene';

/** Текст на місці: debounce-збереження і одразу при втраті фокуса; зміни з сервера — лише коли немає правки. */
function DraftField({
  value,
  label,
  maxLength,
  rows,
  disabled,
  onSave,
}: {
  value: string;
  label: string;
  maxLength: number;
  rows: number;
  disabled?: boolean;
  onSave(text: string): void;
}) {
  const [text, setText] = useState(value);
  const save = useRef(onSave);
  save.current = onSave;
  // порожній текст сервер відхилив би — не зберігаємо
  const [draft] = useState(() =>
    createTextDraft({ value, save: (t) => t.trim() && save.current(t), delayMs: SAVE_DEBOUNCE_MS }),
  );
  useEffect(() => {
    const next = draft.sync(value);
    if (next !== null) setText(next);
  }, [draft, value]);
  useEffect(() => () => draft.dispose(), [draft]);
  return (
    <Textarea
      aria-label={label}
      value={text}
      rows={rows}
      maxLength={maxLength}
      disabled={disabled}
      className="min-h-0 resize-y text-sm"
      onChange={(e) => {
        setText(e.target.value);
        draft.change(e.target.value);
      }}
      onBlur={draft.flush}
    />
  );
}

/** Ключові слова через кому; зберігаються при втраті фокуса або Enter. */
function KeywordsField({
  value,
  label,
  disabled,
  onSave,
}: {
  value: string[];
  label: string;
  disabled?: boolean;
  onSave(k: string[]): void;
}) {
  const joined = value.join(', ');
  const [text, setText] = useState(joined);
  useEffect(() => setText(joined), [joined]);
  const commit = () => {
    const keywords = [
      ...new Set(
        text
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
      ),
    ].slice(0, 8);
    if (!keywords.length) return setText(joined);
    if (keywords.join(', ') !== joined) onSave(keywords);
  };
  return (
    <Input
      aria-label={label}
      value={text}
      disabled={disabled}
      className="h-7 text-xs"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

export function SceneRow({
  scene,
  index,
  count,
  view,
  dragOver,
  onChanged,
  onDragStart,
  onDragOverRow,
  onDropRow,
  onMove,
}: {
  scene: SceneView;
  /** номер сцени з 1 */
  index: number;
  count: number;
  view: PipelineView;
  dragOver: boolean;
  onChanged(): void;
  onDragStart(): void;
  onDragOverRow(): void;
  onDropRow(): void;
  onMove(position: number): void;
}) {
  const trpc = useTRPC();
  const onError = (e: { message: string }) => toast.error(e.message);
  const update = useMutation(trpc.pipeline.updateScene.mutationOptions({ onSuccess: onChanged, onError }));
  const regenerateText = useMutation(
    trpc.pipeline.regenerateScene.mutationOptions({
      onSuccess: () => {
        toast.success(`Текст сцени ${index} перегенеровується`);
        onChanged();
      },
      onError,
    }),
  );
  const remove = useMutation(trpc.pipeline.deleteScene.mutationOptions({ onSuccess: onChanged, onError }));
  const { run, project } = view;
  const review = run.stage === 'review';
  const editable = run.stage !== 'script';
  const languages = run.settings.languages;

  return (
    <li
      data-testid="scene-row"
      data-scene-id={scene.id}
      onDragOver={(e) => {
        if (!review || !e.dataTransfer.types.includes(SCENE_MIME)) return;
        e.preventDefault();
        onDragOverRow();
      }}
      onDrop={(e) => {
        if (!review || !e.dataTransfer.types.includes(SCENE_MIME)) return;
        e.preventDefault();
        onDropRow();
      }}
      className={cn(
        'grid grid-cols-[1.5rem_auto_minmax(0,1fr)] gap-3 rounded-lg border p-3 md:grid-cols-[1.5rem_auto_minmax(0,1fr)_auto_auto]',
        dragOver && 'border-sky-500 bg-sky-500/5',
      )}
    >
      <div className="flex flex-col items-center gap-1 pt-1">
        <span className="text-sm font-medium tabular-nums">{index}</span>
        {review && (
          <span
            draggable
            aria-hidden
            title="Перетягніть, щоб змінити порядок"
            onDragStart={(e) => {
              e.dataTransfer.setData(SCENE_MIME, scene.id);
              e.dataTransfer.effectAllowed = 'move';
              onDragStart();
            }}
            className="cursor-grab text-muted-foreground"
          >
            <GripVertical className="size-4" />
          </span>
        )}
      </div>
      <SceneVisual scene={scene} index={index} view={view} onChanged={onChanged} />
      <div className="grid min-w-0 content-start gap-1.5">
        <DraftField
          label={`Текст сцени ${index}`}
          value={scene.narration}
          maxLength={MAX_NARRATION_CHARS}
          rows={3}
          disabled={!editable}
          onSave={(narration) => update.mutate({ sceneId: scene.id, narration })}
        />
        <DraftField
          label={`Промпт сцени ${index}`}
          value={scene.visualPrompt}
          maxLength={4000}
          rows={1}
          disabled={!editable}
          onSave={(visualPrompt) => update.mutate({ sceneId: scene.id, visualPrompt })}
        />
        <KeywordsField
          label={`Ключові слова сцени ${index}`}
          value={scene.keywords}
          disabled={!editable}
          onSave={(keywords) => update.mutate({ sceneId: scene.id, keywords })}
        />
      </div>
      <div
        className="col-start-3 flex flex-wrap content-start gap-2 md:col-start-auto"
        aria-label={`Озвучка сцени ${index}`}
      >
        {languages.map((lang) => {
          const state = scene.lines[lang]?.state ?? 'empty';
          return (
            <Link
              key={lang}
              to="/voice/$id"
              params={{ id: project.id }}
              title={`${lang.toUpperCase()}: ${LINE_STATE_LABEL[state]}`}
              data-testid={`scene-lang-${lang}`}
              data-state={state}
              className="flex items-center gap-1 text-xs text-muted-foreground uppercase hover:text-foreground"
            >
              <span className={cn('size-2 rounded-full', LINE_STATE_DOT[state])} />
              {lang}
            </Link>
          );
        })}
      </div>
      <div className="col-start-3 flex flex-wrap content-start gap-1 md:col-start-auto md:flex-col">
        <Button
          variant="ghost"
          size="sm"
          disabled={!editable || regenerateText.isPending}
          aria-label={`Перегенерувати текст сцени ${index}`}
          onClick={() => regenerateText.mutate({ sceneId: scene.id, part: 'text' })}
        >
          <RefreshCw /> текст
        </Button>
        {review && (
          <>
            <div className="flex gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Перемістити сцену ${index} вгору`}
                disabled={index === 1}
                onClick={() => onMove(index - 2)}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Перемістити сцену ${index} вниз`}
                disabled={index === count}
                onClick={() => onMove(index)}
              >
                <ArrowDown />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              aria-label={`Видалити сцену ${index}`}
              disabled={count <= 1 || remove.isPending}
              onClick={() => remove.mutate({ sceneId: scene.id })}
            >
              <Trash2 /> видалити
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
