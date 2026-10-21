import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { EditorMode } from '@/editor/store';

/** «Монтаж / UK / EN / EN (відокремлена)»: мова без власного документа — перегляд, відокремлена — редагування. */
export function LanguageSwitch({
  mode,
  languages,
  separated,
  disabled,
  onChange,
}: {
  mode: EditorMode;
  languages: string[];
  separated: string[];
  disabled: boolean;
  onChange(mode: EditorMode): void;
}) {
  const value = mode.kind === 'edit' ? 'edit' : mode.language;
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label="Режим редактора"
      data-testid="mode-switch"
      value={value}
      disabled={disabled}
      onValueChange={(v) => {
        if (!v || v === value) return;
        onChange(v === 'edit' ? { kind: 'edit' } : { kind: 'language', language: v, separated: separated.includes(v) });
      }}
    >
      <ToggleGroupItem value="edit" data-testid="mode-edit">
        Монтаж
      </ToggleGroupItem>
      {languages.map((l) => (
        <ToggleGroupItem key={l} value={l} data-testid={`mode-${l}`}>
          {l.toUpperCase()}
          {separated.includes(l) ? ' (відокремлена)' : ''}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
