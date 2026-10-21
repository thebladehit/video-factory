import type { OriginalSound } from '@vf/shared';
import { useEffect, useRef, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const DEBOUNCE_MS = 400;
const pct = (v: number) => `${Math.round(v * 100)} %`;

function Slider({
  label,
  value,
  disabled,
  testId,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  testId: string;
  onChange(v: number): void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <input
        type="range"
        data-testid={testId}
        min={0}
        max={100}
        step={1}
        disabled={disabled}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="min-w-0 flex-1 accent-primary"
      />
      <span className="w-10 text-right tabular-nums">{pct(value)}</span>
    </label>
  );
}

/** Оригінальний звук: «Замінити» (мовчить) / «Приглушити» (рівень, а під голосом — нижчий); повзунки зберігаються з debounce. */
export function OriginalSoundPanel({
  value,
  onChange,
}: {
  value: OriginalSound;
  /** Відхилений проміс (помилка збереження) — повзунки повертаються до значення з сервера */
  onChange(next: OriginalSound): void | Promise<void>;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirty = useRef(false);
  const latest = useRef(value);
  const current = useRef(value);
  current.current = value;
  const save = useRef(onChange);
  save.current = onChange;
  const commit = (next: OriginalSound) => {
    dirty.current = false;
    Promise.resolve(save.current(next)).catch(() => setLocal(current.current));
  };
  // чужі зміни показуємо лише коли немає незбереженої правки
  useEffect(() => {
    if (!dirty.current) setLocal(value);
  }, [value]);
  // розмонтування не губить правку, яка ще чекає debounce
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (dirty.current) {
        dirty.current = false;
        void save.current(latest.current);
      }
    },
    [],
  );

  function update(next: OriginalSound, immediate = false) {
    setLocal(next);
    latest.current = next;
    dirty.current = true;
    clearTimeout(timer.current);
    if (immediate) commit(next);
    else timer.current = setTimeout(() => commit(next), DEBOUNCE_MS);
  }

  return (
    <div className="grid gap-2" data-testid="original-panel">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={local.mode}
        onValueChange={(mode) => mode && update({ ...local, mode: mode as OriginalSound['mode'] }, true)}
      >
        <ToggleGroupItem value="replace" data-testid="original-replace">
          Замінити
        </ToggleGroupItem>
        <ToggleGroupItem value="duck" data-testid="original-duck">
          Приглушити
        </ToggleGroupItem>
      </ToggleGroup>
      <Slider
        label="Рівень оригіналу"
        testId="original-level"
        value={local.level}
        disabled={local.mode === 'replace'}
        onChange={(level) => update({ ...local, level })}
      />
      <Slider
        label="Під голосом"
        testId="original-duck-level"
        value={local.duckLevel}
        disabled={local.mode === 'replace'}
        onChange={(duckLevel) => update({ ...local, duckLevel })}
      />
      {local.mode === 'replace' && (
        <p className="text-xs text-muted-foreground">У мові оригінальний звук вимкнено (лишається лише озвучка).</p>
      )}
    </div>
  );
}
