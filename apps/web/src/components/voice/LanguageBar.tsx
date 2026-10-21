import type { VoiceView } from '@vf/api';
import { LANGUAGES, languageInfo } from '@vf/shared';
import { Loader2, MoreHorizontal, Plus } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LANG_STATE_DOT, LANG_STATE_LABEL, languageState } from './states';

export function LanguageBar({
  view,
  selected,
  onSelect,
  onChange,
}: {
  view: VoiceView;
  selected: string;
  onSelect(code: string): void;
  onChange(next: { base: string; languages: string[] }): void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const free = LANGUAGES.filter((l) => !view.languages.includes(l.code));
  return (
    <div data-testid="language-bar" className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Мови:</span>
      {view.languages.map((code) => {
        const isBase = code === view.base;
        const { state, busy } = languageState(view, code);
        return (
          <div
            key={code}
            data-testid="language-chip"
            data-lang={code}
            data-state={isBase ? 'base' : state}
            className={`flex items-center rounded-md border text-sm ${code === selected ? 'border-primary bg-accent' : ''}`}
          >
            <button
              type="button"
              className="flex items-center gap-1.5 px-2 py-1"
              onClick={() => onSelect(code)}
              title={`${languageInfo(code).name} — ${isBase ? 'базова мова' : LANG_STATE_LABEL[state]}`}
            >
              <span className="font-medium">{code.toUpperCase()}</span>
              {isBase ? (
                <span className="text-xs text-muted-foreground">база</span>
              ) : busy ? (
                <Loader2 className="size-3.5 animate-spin" aria-label="Озвучується" />
              ) : (
                <span className={`size-2 rounded-full ${LANG_STATE_DOT[state]}`} />
              )}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-6" aria-label={`Дії з мовою ${code.toUpperCase()}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {!isBase && (
                  <DropdownMenuItem onSelect={() => onChange({ base: code, languages: view.languages })}>
                    Зробити базовою
                  </DropdownMenuItem>
                )}
                {!isBase && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  variant="destructive"
                  disabled={isBase}
                  onSelect={() => setRemoving(code)}
                >
                  Прибрати мову
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={!free.length} data-testid="add-language">
            <Plus /> мова
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          {free.map((l) => (
            <DropdownMenuItem
              key={l.code}
              data-testid={`add-language-${l.code}`}
              onSelect={() => onChange({ base: view.base, languages: [...view.languages, l.code] })}
            >
              {l.name} ({l.code.toUpperCase()})
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Прибрати мову {removing?.toUpperCase()}?</AlertDialogTitle>
            <AlertDialogDescription>Мову буде прибрано з проєкту, її тексти й озвучка не показуватимуться.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Скасувати</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing)
                  onChange({ base: view.base, languages: view.languages.filter((c) => c !== removing) });
                setRemoving(null);
              }}
            >
              Прибрати
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
