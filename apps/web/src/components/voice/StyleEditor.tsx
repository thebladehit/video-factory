import { useMutation, useQueryClient } from '@tanstack/react-query';
import { captionStyleSchema, FONTS, type CaptionStyle } from '@vf/captions';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/lib/trpc';

const ANIMATIONS: Record<CaptionStyle['animation'], string> = {
  none: 'Без анімації',
  highlight: 'Підсвітка слова',
  pop: 'Pop по слову',
  karaoke: 'Караоке',
};
const ALIGNS: Record<CaptionStyle['position']['align'], string> = {
  bottom: 'Знизу',
  middle: 'По центру',
  top: 'Зверху',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Range({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange(v: number): void;
}) {
  return (
    <Field label={label}>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-primary"
      />
      <span className="w-12 text-right tabular-nums">
        {value}
        {unit}
      </span>
    </Field>
  );
}

function Color({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }) {
  return (
    <Field label={label}>
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-12 cursor-pointer rounded border bg-transparent"
      />
      <span className="font-mono text-[10px] text-muted-foreground">{value}</span>
    </Field>
  );
}

function Pick<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange(v: T): void;
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={(v) => onChange(v as T)}>
        <SelectTrigger size="sm" className="w-48" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([k, v]) => (
            <SelectItem key={k} value={k}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * Редактор стилю субтитрів (поля §3.1). Кожна зміна одразу йде в `onDraft` — прев'ю перебудовує ASS з чорновим стилем
 * на поточному кадрі. «Зберегти як…» → `captionStyles.create`; для збереженого стилю — «Оновити».
 */
export function StyleEditor({
  initial,
  savedId,
  savedName,
  onDraft,
  onClose,
  onSaved,
}: {
  initial: CaptionStyle;
  /** Збережений (не пресет) стиль, який редагується */
  savedId: string | null;
  savedName?: string;
  onDraft(style: CaptionStyle): void;
  onClose(): void;
  /** Стиль збережено: id, який слід призначити мові */
  onSaved(styleId: string): void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [style, setStyle] = useState(initial);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const set = (patch: Partial<CaptionStyle>) => {
    const next = { ...style, ...patch };
    setStyle(next);
    onDraft(next);
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.voice.get.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.voice.localized.pathKey() });
  };
  const onError = (e: { message: string }) => toast.error(e.message);
  const create = useMutation(
    trpc.captionStyles.create.mutationOptions({
      onSuccess: (s) => {
        toast.success(`Стиль «${s.name}» збережено`);
        setNaming(false);
        refresh();
        onSaved(s.id);
      },
      onError,
    }),
  );
  const update = useMutation(
    trpc.captionStyles.update.mutationOptions({
      onSuccess: (s) => {
        toast.success(`Стиль «${s.name}» оновлено`);
        refresh();
        onSaved(s.id);
      },
      onError,
    }),
  );
  const valid = captionStyleSchema.safeParse(style).success;
  const submitNew = () => name.trim() && valid && create.mutate({ name, style });

  return (
    <div data-testid="style-editor" className="grid gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Стиль субтитрів</h3>
        <Button size="icon" variant="ghost" className="ml-auto" aria-label="Закрити редактор стилю" onClick={onClose}>
          <X />
        </Button>
      </div>

      <Pick
        label="Шрифт"
        value={style.font}
        options={FONTS.map((f) => [f.id, f.family])}
        onChange={(font) => set({ font })}
      />
      <Range
        label="Розмір"
        value={style.size}
        min={3}
        max={12}
        step={0.5}
        unit=" %"
        onChange={(size) => set({ size })}
      />
      <Color label="Колір" value={style.color} onChange={(color) => set({ color })} />
      <Color label="Активне слово" value={style.activeColor} onChange={(activeColor) => set({ activeColor })} />
      <Color
        label="Контур"
        value={style.outline.color}
        onChange={(color) => set({ outline: { ...style.outline, color } })}
      />
      <Range
        label="Товщина контуру"
        value={style.outline.width}
        min={0}
        max={20}
        unit=" px"
        onChange={(width) => set({ outline: { ...style.outline, width } })}
      />
      <Range label="Тінь" value={style.shadow} min={0} max={20} onChange={(shadow) => set({ shadow })} />
      <Field label="Плашка">
        <Switch
          aria-label="Плашка"
          checked={style.box.enabled}
          onCheckedChange={(enabled) => set({ box: { ...style.box, enabled } })}
        />
      </Field>
      {style.box.enabled && (
        <>
          <Color
            label="Колір плашки"
            value={style.box.color}
            onChange={(color) => set({ box: { ...style.box, color } })}
          />
          <Range
            label="Прозорість плашки"
            value={Math.round(style.box.opacity * 100)}
            min={0}
            max={100}
            unit=" %"
            onChange={(v) => set({ box: { ...style.box, opacity: v / 100 } })}
          />
        </>
      )}
      <Pick
        label="Позиція"
        value={style.position.align}
        options={Object.entries(ALIGNS) as [CaptionStyle['position']['align'], string][]}
        onChange={(align) => set({ position: { ...style.position, align } })}
      />
      <Range
        label="Відступ"
        value={style.position.marginY}
        min={0}
        max={50}
        unit=" %"
        onChange={(marginY) => set({ position: { ...style.position, marginY } })}
      />
      <Range
        label="Слів у рядку"
        value={style.maxWordsPerLine}
        min={1}
        max={8}
        onChange={(maxWordsPerLine) => set({ maxWordsPerLine })}
      />
      <Pick
        label="Рядків"
        value={String(style.maxLines) as '1' | '2'}
        options={[
          ['1', '1'],
          ['2', '2'],
        ]}
        onChange={(v) => set({ maxLines: v === '1' ? 1 : 2 })}
      />
      <Field label="Великі літери">
        <Switch
          aria-label="Великі літери"
          checked={style.uppercase}
          onCheckedChange={(uppercase) => set({ uppercase })}
        />
      </Field>
      <Pick
        label="Анімація"
        value={style.animation}
        options={Object.entries(ANIMATIONS) as [CaptionStyle['animation'], string][]}
        onChange={(animation) => set({ animation })}
      />

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {naming ? (
          <>
            <Input
              autoFocus
              aria-label="Назва стилю"
              data-testid="style-name"
              className="h-8 w-44"
              maxLength={100}
              value={name}
              placeholder="Назва стилю"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNew();
                if (e.key === 'Escape') setNaming(false);
              }}
            />
            <Button
              size="sm"
              data-testid="style-save-confirm"
              disabled={!name.trim() || !valid || create.isPending}
              onClick={submitNew}
            >
              Зберегти
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
              Скасувати
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" data-testid="style-save-as" disabled={!valid} onClick={() => setNaming(true)}>
              Зберегти як…
            </Button>
            {savedId && (
              <Button
                size="sm"
                variant="outline"
                disabled={!valid || update.isPending}
                onClick={() => update.mutate({ id: savedId, style })}
              >
                Оновити «{savedName}»
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStyle(initial);
                onDraft(initial);
              }}
            >
              Скинути зміни
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
