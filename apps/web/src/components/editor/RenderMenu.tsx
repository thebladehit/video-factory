import { ChevronDown, Clapperboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function RenderMenu({
  disabledReason,
  busy,
  onRender,
}: {
  /** Чому рендер недоступний (null — доступний) */
  disabledReason: string | null;
  busy: boolean;
  onRender(preset: 'final' | 'draft'): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={!!disabledReason || busy} title={disabledReason ?? undefined} data-testid="render-menu">
          <Clapperboard /> Рендер <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onRender('final')}>Фінал 1080p</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRender('draft')}>Чернетка 720p</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
