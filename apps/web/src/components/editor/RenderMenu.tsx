import { ChevronDown, Clapperboard } from 'lucide-react';
import { Fragment } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function RenderMenu({
  disabledReason,
  busy,
  languages = [],
  onRender,
}: {
  /** Чому рендер недоступний (null — доступний) */
  disabledReason: string | null;
  busy: boolean;
  /** Мови проєкту (порожньо — один варіант «Монтаж»), для кожної — окремі пункти */
  languages?: string[];
  /** `language` — `null` для «Монтажу» (базовий документ) */
  onRender(preset: 'final' | 'draft', language: string | null): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={!!disabledReason || busy} title={disabledReason ?? undefined} data-testid="render-menu">
          <Clapperboard /> Рендер <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onRender('final', null)}>Фінал 1080p</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRender('draft', null)}>Чернетка 720p</DropdownMenuItem>
        {languages.length > 0 && <DropdownMenuSeparator />}
        {languages.map((l) => (
          <Fragment key={l}>
            <DropdownMenuItem data-testid={`render-${l}-final`} onSelect={() => onRender('final', l)}>
              {l.toUpperCase()} — Фінал 1080p
            </DropdownMenuItem>
            <DropdownMenuItem data-testid={`render-${l}-draft`} onSelect={() => onRender('draft', l)}>
              {l.toUpperCase()} — Чернетка 720p
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
