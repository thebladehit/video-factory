import { normalizeTag, PLATFORM_LIMITS, validateMeta } from '@vf/publish/client';
import { PLATFORM_LABELS, type Platform, type PublicationMeta } from '@vf/shared';
import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/** Основні категорії YouTube (id з videoCategories) */
export const YOUTUBE_CATEGORIES: { id: string; label: string }[] = [
  { id: '22', label: 'Люди й блоги' },
  { id: '27', label: 'Освіта' },
  { id: '24', label: 'Розваги' },
  { id: '28', label: 'Наука й техніка' },
  { id: '10', label: 'Музика' },
  { id: '20', label: 'Ігри' },
  { id: '17', label: 'Спорт' },
  { id: '26', label: 'Стиль і поради' },
];

const PRIVACY: { id: NonNullable<PublicationMeta['privacy']>; label: string }[] = [
  { id: 'public', label: 'Публічне' },
  { id: 'unlisted', label: 'За посиланням' },
  { id: 'private', label: 'Приватне' },
];

export const EMPTY_META: PublicationMeta = { title: '', description: '', tags: [] };

/** YouTube-поля з типовими значеннями (приватність public, не для дітей, «Люди й блоги») */
export function withDefaults(platform: Platform, meta: PublicationMeta): PublicationMeta {
  if (platform !== 'youtube') return meta;
  return {
    ...meta,
    privacy: meta.privacy ?? 'public',
    madeForKids: meta.madeForKids ?? false,
    categoryId: meta.categoryId ?? '22',
  };
}

const encoder = new TextEncoder();
const cleanTags = (tags: string[]) => tags.map(normalizeTag).filter(Boolean);

/** Помилки `validateMeta`, розкладені під поля */
export function metaErrors(platform: Platform, meta: PublicationMeta) {
  const all = validateMeta(platform, meta);
  return {
    all,
    title: all.filter((e) => e.startsWith('Назва')),
    description: all.filter((e) => e.startsWith('Опис')),
    tags: all.filter((e) => !e.startsWith('Назва') && !e.startsWith('Опис')),
  };
}

const parseTags = (text: string) => text.split(/[,\n]/).map(normalizeTag).filter(Boolean);

/** Теги через кому; власний текст поля, щоб кома й пробіл не зникали під час набору */
function TagsInput({
  id,
  tags,
  onChange,
  invalid,
}: {
  id: string;
  tags: string[];
  onChange(tags: string[]): void;
  invalid: boolean;
}) {
  const [text, setText] = useState(() => tags.join(', '));
  useEffect(() => {
    // теги змінились ззовні (нова генерація) — показати їх
    if (parseTags(text).join('\n') !== cleanTags(tags).join('\n')) setText(tags.join(', '));
  }, [tags]);
  return (
    <Input
      id={id}
      value={text}
      aria-invalid={invalid}
      placeholder="тег, ще тег"
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseTags(e.target.value));
      }}
    />
  );
}

const Counter = ({ value, max, unit = '' }: { value: number; max: number; unit?: string }) => (
  <span className={`text-xs tabular-nums ${value > max ? 'text-destructive' : 'text-muted-foreground'}`}>
    {value}/{max}
    {unit}
  </span>
);

const Errors = ({ errors }: { errors: string[] }) =>
  errors.length ? <p className="text-xs text-destructive">{errors.join('. ')}</p> : null;

/** Поля метаданих однієї платформи: лічильники з `PLATFORM_LIMITS`, помилки під полями */
export function MetaFields({
  idPrefix,
  platform,
  meta,
  onChange,
}: {
  idPrefix: string;
  platform: Platform;
  meta: PublicationMeta;
  onChange(meta: PublicationMeta): void;
}) {
  const lim = PLATFORM_LIMITS[platform];
  const errors = metaErrors(platform, meta);
  const set = (patch: Partial<PublicationMeta>) => onChange({ ...meta, ...patch });
  const tags = cleanTags(meta.tags);
  const caption = platform === 'tiktok' || platform === 'instagram';

  return (
    <div className="grid gap-3">
      {lim.title > 0 && (
        <div className="grid gap-1">
          <div className="flex items-center justify-between">
            <Label htmlFor={`${idPrefix}-title`}>Назва</Label>
            <Counter value={meta.title.trim().length} max={lim.title} />
          </div>
          <Input
            id={`${idPrefix}-title`}
            data-testid="meta-title"
            value={meta.title}
            aria-invalid={errors.title.length > 0}
            onChange={(e) => set({ title: e.target.value })}
          />
          <Errors errors={errors.title} />
        </div>
      )}
      <div className="grid gap-1">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${idPrefix}-description`}>{caption ? 'Підпис' : 'Опис'}</Label>
          {lim.descriptionBytes ? (
            <Counter value={encoder.encode(meta.description).length} max={lim.description} unit=" байтів" />
          ) : (
            <Counter value={meta.description.length} max={lim.description} />
          )}
        </div>
        <Textarea
          id={`${idPrefix}-description`}
          data-testid="meta-description"
          className="max-h-60"
          value={meta.description}
          aria-invalid={errors.description.length > 0}
          onChange={(e) => set({ description: e.target.value })}
        />
        <Errors errors={errors.description} />
      </div>
      <div className="grid gap-1">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${idPrefix}-tags`}>{platform === 'youtube' ? 'Теги' : 'Хештеги (без #)'}</Label>
          {lim.tagsTotal !== undefined && (
            <Counter
              value={tags.reduce((n, t) => n + t.length, 0) + Math.max(0, tags.length - 1)}
              max={lim.tagsTotal}
            />
          )}
          {lim.hashtags !== undefined && <Counter value={tags.length} max={lim.hashtags} />}
        </div>
        <TagsInput
          id={`${idPrefix}-tags`}
          tags={meta.tags}
          invalid={errors.tags.length > 0}
          onChange={(t) => set({ tags: t })}
        />
        <Errors errors={errors.tags} />
      </div>
      {platform === 'youtube' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-privacy`}>Приватність</Label>
            <Select
              value={meta.privacy ?? 'public'}
              onValueChange={(v) => set({ privacy: v as PublicationMeta['privacy'] })}
            >
              <SelectTrigger id={`${idPrefix}-privacy`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIVACY.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Для дітей</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              className="justify-start"
              value={meta.madeForKids ? 'yes' : 'no'}
              onValueChange={(v) => v && set({ madeForKids: v === 'yes' })}
            >
              <ToggleGroupItem value="yes">Так</ToggleGroupItem>
              <ToggleGroupItem value="no">Ні</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-category`}>Категорія</Label>
            <Select value={meta.categoryId ?? '22'} onValueChange={(v) => set({ categoryId: v })}>
              <SelectTrigger id={`${idPrefix}-category`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {YOUTUBE_CATEGORIES.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

export interface MetaTab {
  language: string;
  platform: Platform;
  meta: PublicationMeta;
}

export type GenState = 'loading' | 'done' | 'error';

/** Вкладки «мова × платформа»; «Згенерувати знову» перегенеровує всі платформи мови */
export function MetaEditor({
  tabs,
  generation,
  onChange,
  onRegenerate,
}: {
  tabs: MetaTab[];
  generation: Record<string, GenState | undefined>;
  onChange(language: string, platform: Platform, meta: PublicationMeta): void;
  onRegenerate(language: string): void;
}) {
  const keyOf = (t: MetaTab) => `${t.language}:${t.platform}`;
  const [active, setActive] = useState<string | undefined>(undefined);
  if (!tabs.length) return <p className="text-sm text-muted-foreground">Оберіть, куди публікувати.</p>;
  const current = tabs.find((t) => keyOf(t) === active) ?? tabs[0]!;

  return (
    <Tabs value={keyOf(current)} onValueChange={setActive}>
      <TabsList className="h-auto flex-wrap">
        {tabs.map((t) => {
          const invalid = metaErrors(t.platform, t.meta).all.length > 0 && generation[t.language] !== 'loading';
          return (
            <TabsTrigger key={keyOf(t)} value={keyOf(t)} className={invalid ? 'text-destructive' : ''}>
              {t.language.toUpperCase()} · {PLATFORM_LABELS[t.platform]}
            </TabsTrigger>
          );
        })}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={keyOf(t)} value={keyOf(t)} className="grid gap-3">
          <GenStatus state={generation[t.language]} onRegenerate={() => onRegenerate(t.language)} />
          <MetaFields
            idPrefix={`meta-${t.language}-${t.platform}`}
            platform={t.platform}
            meta={t.meta}
            onChange={(m) => onChange(t.language, t.platform, m)}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function GenStatus({ state, onRegenerate }: { state: GenState | undefined; onRegenerate(): void }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      {state === 'loading' ? (
        <>
          <Loader2 className="size-4 animate-spin" /> AI готує метадані…
        </>
      ) : state === 'error' ? (
        <span>Не вдалося згенерувати — заповніть вручну або спробуйте ще раз.</span>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="ml-auto"
        disabled={state === 'loading'}
        onClick={onRegenerate}
      >
        <Sparkles /> Згенерувати знову
      </Button>
    </div>
  );
}
