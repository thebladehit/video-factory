import { useMutation, useQueryClient } from '@tanstack/react-query';
import { languageInfo } from '@vf/shared';
import { ChevronDown, Clapperboard } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTRPC } from '@/lib/trpc';

type Preset = 'final' | 'draft';

interface NotReady {
  segmentIds: string[];
  languages: string[];
}

/** Деталі `VALIDATION` «Є неозвучені або застарілі сегменти» (`renders.startAll`). */
export function notReadyDetails(e: unknown): NotReady | null {
  const d = (e as { data?: { details?: Partial<NotReady> } } | null)?.data?.details;
  return Array.isArray(d?.segmentIds) && Array.isArray(d?.languages)
    ? { segmentIds: d.segmentIds, languages: d.languages }
    : null;
}

/** «Рендер ▾»: пресет × мови (усі за замовчуванням) → `renders.startAll`; неготові рядки → «Рендерити все одно?» → `force`. */
export function StudioRenderMenu({
  projectId,
  languages,
  disabledReason,
  prepare,
}: {
  projectId: string;
  languages: string[];
  disabledReason: string | null;
  /** Зберегти документ перед рендером; `false` — не вдалося, рендер не стартує */
  prepare(): Promise<boolean>;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<Preset>('final');
  const [picked, setPicked] = useState<string[] | null>(null);
  const [pending, setPending] = useState<{ preset: Preset; languages: string[]; info: NotReady } | null>(null);
  const chosen = (picked ?? languages).filter((l) => languages.includes(l));

  const start = useMutation(
    trpc.renders.startAll.mutationOptions({
      onSuccess: (r, vars) => {
        setOpen(false);
        setPending(null);
        toast.success(
          `Рендер запущено: ${r.renderIds.length} (${vars.preset === 'final' ? 'Фінал 1080p' : 'Чернетка 720p'})`,
        );
        void qc.invalidateQueries({ queryKey: trpc.renders.list.queryKey({ projectId }) });
      },
      onError: (e, vars) => {
        const info = notReadyDetails(e);
        if (info && !vars.force) {
          setOpen(false);
          setPending({ preset: vars.preset, languages: vars.languages, info });
        } else toast.error(e.message);
      },
    }),
  );

  async function run(p: Preset, langs: string[], force?: boolean) {
    if (!(await prepare())) {
      toast.error('Не вдалося зберегти проєкт — рендер не запущено. Повторіть збереження.');
      return;
    }
    start.mutate({ projectId, preset: p, languages: langs, ...(force ? { force: true } : {}) });
  }

  return (
    <>
      <Button
        disabled={!!disabledReason}
        title={disabledReason ?? undefined}
        data-testid="render-menu"
        onClick={() => setOpen(true)}
      >
        <Clapperboard /> Рендер <ChevronDown />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="render-dialog">
          <DialogHeader>
            <DialogTitle>Рендер</DialogTitle>
            <DialogDescription>Кожна вибрана мова — окремий файл. Прогрес — в історії рендерів.</DialogDescription>
          </DialogHeader>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={preset}
            onValueChange={(v) => v && setPreset(v as Preset)}
          >
            <ToggleGroupItem value="final" data-testid="preset-final">
              Фінал 1080p
            </ToggleGroupItem>
            <ToggleGroupItem value="draft" data-testid="preset-draft">
              Чернетка 720p
            </ToggleGroupItem>
          </ToggleGroup>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-sm font-medium">Мови</legend>
            {languages.map((code) => (
              <label key={code} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid={`render-lang-${code}`}
                  checked={chosen.includes(code)}
                  onChange={(e) => setPicked(e.target.checked ? [...chosen, code] : chosen.filter((c) => c !== code))}
                />
                {languageInfo(code).name} ({code.toUpperCase()})
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Скасувати
            </Button>
            <Button
              data-testid="render-start"
              disabled={!chosen.length || start.isPending}
              onClick={() => void run(preset, chosen)}
            >
              Рендерити{chosen.length ? ` (${chosen.length})` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent data-testid="render-force">
          <AlertDialogHeader>
            <AlertDialogTitle>Рендерити все одно?</AlertDialogTitle>
            <AlertDialogDescription>
              Неозвучених або застарілих сегментів: {pending?.info.segmentIds.length} (мови:{' '}
              {pending?.info.languages.map((l) => l.toUpperCase()).join(', ')}). Вони підуть без голосу, з темпом 1.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Скасувати</AlertDialogCancel>
            <AlertDialogAction
              data-testid="render-force-confirm"
              onClick={() =>
                pending && void run(pending.preset, pending.languages.length ? pending.languages : chosen, true)
              }
            >
              Рендерити все одно
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
