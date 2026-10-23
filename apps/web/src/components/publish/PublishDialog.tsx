import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABELS, PLATFORMS, type Platform, type PublicationMeta } from '@vf/shared';
import { Info, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTRPC } from '@/lib/trpc';
import { AccountDialog } from './AccountDialog';
import { PlatformIcon } from './AccountsStrip';
import { EMPTY_META, MetaEditor, metaErrors, withDefaults, type GenState, type MetaTab } from './MetaEditor';
import type { AccountRow } from './types';

export const AUDIT_HINT =
  'Поки Google-проєкт не пройшов аудит YouTube API, YouTube робить такі відео приватними. Їх можна побачити в YouTube Studio.';

/** YouTube приймає `publishAt` лише з запасом від поточного часу */
const YOUTUBE_MIN_AHEAD_MS = 5 * 60_000;

const two = (n: number) => String(n).padStart(2, '0');
/** Date → значення `datetime-local` у локальному часі */
export const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;

/** «Створено 1 публікацію / 3 публікації / 5 публікацій» */
export function createdToast(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'публікацію'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'публікації'
        : 'публікацій';
  return `Створено ${n} ${word}`;
}

/** Помилка часу публікації; null — усе гаразд */
export function timeError(when: 'now' | 'at', at: string, hasYoutube: boolean, now = Date.now()): string | null {
  if (when === 'now') return null;
  if (!at) return 'Вкажіть дату й час';
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return 'Некоректна дата';
  if (t <= now) return 'Час має бути в майбутньому';
  if (hasYoutube && t < now + YOUTUBE_MIN_AHEAD_MS) return 'Для YouTube — щонайменше через 5 хвилин';
  return null;
}

const targetKey = (language: string, platform: Platform) => `${language}:${platform}`;

export function PublishDialog({
  open,
  onOpenChange,
  projectId,
  language,
  platform,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  projectId?: string;
  language?: string;
  platform?: Platform;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="publish-dialog" className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Опублікувати</DialogTitle>
          <DialogDescription>Що, куди, з якими метаданими й коли.</DialogDescription>
        </DialogHeader>
        {/* стан діалогу живе в тілі, що монтується при кожному відкритті */}
        {open && (
          <PublishForm
            initialProjectId={projectId}
            initialLanguage={language}
            initialPlatform={platform}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PublishForm({
  initialProjectId,
  initialLanguage,
  initialPlatform,
  onDone,
}: {
  initialProjectId?: string;
  initialLanguage?: string;
  initialPlatform?: Platform;
  onDone(): void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const versions = useQuery(trpc.publish.versions.queryOptions());
  const accountsQuery = useQuery(trpc.publish.accounts.list.queryOptions());
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  /** null — вибір за замовчуванням (мова з точки входу або всі версії проєкту) */
  const [pickedLangs, setPickedLangs] = useState<string[] | null>(null);
  /** Ручні зміни «публікувати на цю платформу»; без запису — за замовчуванням */
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [chosenAccount, setChosenAccount] = useState<Record<string, string>>({});
  const [metas, setMetas] = useState<Record<string, Partial<Record<Platform, PublicationMeta>>>>({});
  const [generation, setGeneration] = useState<Record<string, GenState | undefined>>({});
  const [when, setWhen] = useState<'now' | 'at'>('now');
  const [at, setAt] = useState('');
  const [adding, setAdding] = useState<{ language: string; platform: Platform } | null>(null);

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const v of versions.data ?? []) if (!seen.has(v.projectId)) seen.set(v.projectId, v.projectTitle);
    return [...seen].map(([id, title]) => ({ id, title }));
  }, [versions.data]);
  const projectVersions = useMemo(
    () => (versions.data ?? []).filter((v) => v.projectId === projectId),
    [versions.data, projectId],
  );
  const langs = useMemo(() => {
    if (pickedLangs) return pickedLangs;
    const all = projectVersions.map((v) => v.language);
    return initialLanguage && all.includes(initialLanguage) ? [initialLanguage] : all;
  }, [pickedLangs, projectVersions, initialLanguage]);

  const accounts = accountsQuery.data?.accounts ?? [];
  const accountsFor = (lang: string, pl: Platform) =>
    accounts.filter((a) => a.language === lang && a.platform === pl && a.status === 'active');
  const accountOf = (lang: string, pl: Platform): AccountRow | undefined => {
    const list = accountsFor(lang, pl);
    return list.find((a) => a.id === chosenAccount[targetKey(lang, pl)]) ?? list[0];
  };
  const isEnabled = (lang: string, pl: Platform) => {
    if (!accountOf(lang, pl)) return false;
    return enabled[targetKey(lang, pl)] ?? (initialPlatform ? pl === initialPlatform : true);
  };

  // AI-метадані для кожної вибраної мови: при відкритті й при виборі нової мови
  const generate = useMutation(trpc.publish.generateMeta.mutationOptions());
  const requested = useRef(new Set<string>());
  const run = (lang: string, force: boolean) => {
    if (!projectId) return;
    const pid = projectId;
    setGeneration((g) => ({ ...g, [lang]: 'loading' }));
    generate
      .mutateAsync({ projectId: pid, language: lang, force })
      .then(({ variants }) => {
        setMetas((m) => ({ ...m, [lang]: variants }));
        setGeneration((g) => ({ ...g, [lang]: 'done' }));
      })
      // текст помилки показує загальний тост мутацій; поля лишаються для ручного заповнення
      .catch(() => setGeneration((g) => ({ ...g, [lang]: 'error' })));
  };
  // повторні запити для тієї самої пари (проєкт, мова) відсікає requested
  useEffect(() => {
    for (const lang of langs) {
      const key = `${projectId}:${lang}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      run(lang, false);
    }
  }, [projectId, langs]);

  const metaOf = (lang: string, pl: Platform) => withDefaults(pl, metas[lang]?.[pl] ?? EMPTY_META);
  const setMeta = (lang: string, pl: Platform, meta: PublicationMeta) =>
    setMetas((m) => ({ ...m, [lang]: { ...m[lang], [pl]: meta } }));

  const targets = langs.flatMap((lang) =>
    PLATFORMS.filter((pl) => isEnabled(lang, pl)).map((pl) => ({ language: lang, platform: pl })),
  );
  const tabs: MetaTab[] = targets.map((t) => ({ ...t, meta: metaOf(t.language, t.platform) }));
  const hasYoutube = targets.some((t) => t.platform === 'youtube');
  const whenError = timeError(when, at, hasYoutube);
  const metaInvalid = tabs.some((t) => metaErrors(t.platform, t.meta).all.length > 0);
  const generating = langs.some((l) => generation[l] === 'loading');
  const showAudit =
    accountsQuery.data?.youtubeAudited === false &&
    targets.some((t) => t.platform === 'youtube' && accountOf(t.language, t.platform)?.method === 'api');

  const create = useMutation(
    trpc.publish.create.mutationOptions({
      onSuccess: (ids) => {
        void qc.invalidateQueries({ queryKey: trpc.publish.pathKey() });
        toast.success(createdToast(ids.length));
        onDone();
      },
    }),
  );
  const submit = () => {
    const scheduledAt = when === 'at' ? new Date(at).toISOString() : undefined;
    const items = targets.map((t) => ({
      renderId: projectVersions.find((v) => v.language === t.language)!.renderId,
      accountId: accountOf(t.language, t.platform)!.id,
      meta: metaOf(t.language, t.platform),
      scheduledAt,
    }));
    create.mutate({ items });
  };
  const canSubmit = targets.length > 0 && !metaInvalid && !whenError && !generating && !create.isPending;

  const toggleLang = (lang: string, on: boolean) =>
    setPickedLangs(on ? [...langs, lang] : langs.filter((l) => l !== lang));

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <h3 className="text-sm font-medium">Що</h3>
        {!initialProjectId && (
          <Select
            value={projectId}
            onValueChange={(id) => {
              setProjectId(id);
              setPickedLangs(null);
            }}
          >
            <SelectTrigger className="w-full" aria-label="Проєкт" data-testid="publish-project">
              <SelectValue placeholder={versions.isPending ? 'Завантаження…' : 'Оберіть відео'} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {projectId && !versions.isPending && !projectVersions.length && (
          <p className="text-sm text-muted-foreground">Немає готового рендеру: зробіть фінальний рендер у редакторі.</p>
        )}
        {projectVersions.length > 0 && (
          <div className="flex flex-wrap gap-4">
            {projectVersions.map((v) => (
              <label key={v.language} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  data-testid="publish-language"
                  data-language={v.language}
                  checked={langs.includes(v.language)}
                  onChange={(e) => toggleLang(v.language, e.target.checked)}
                />
                {v.projectTitle} · {v.language.toUpperCase()} · {v.format}
              </label>
            ))}
          </div>
        )}
      </section>

      {langs.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">Куди</h3>
          <div className="grid gap-2">
            {langs.flatMap((lang) =>
              PLATFORMS.map((pl) => {
                const options = accountsFor(lang, pl);
                const key = targetKey(lang, pl);
                const label = PLATFORM_LABELS[pl];
                return (
                  <div
                    key={key}
                    data-testid="publish-target"
                    data-platform={pl}
                    data-language={lang}
                    className="flex min-h-9 items-center gap-3 text-sm"
                  >
                    <PlatformIcon platform={pl} className="size-6 text-[9px]" />
                    {options.length === 0 ? (
                      <>
                        <span className="text-muted-foreground">
                          Немає акаунта {label} для {lang.toUpperCase()}
                        </span>
                        <Button size="xs" variant="outline" onClick={() => setAdding({ language: lang, platform: pl })}>
                          <Plus /> Додати
                        </Button>
                      </>
                    ) : (
                      <>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            aria-label={`${label} · ${lang.toUpperCase()}`}
                            checked={isEnabled(lang, pl)}
                            onChange={(e) => setEnabled((s) => ({ ...s, [key]: e.target.checked }))}
                          />
                          {label} · {lang.toUpperCase()}
                        </label>
                        {options.length > 1 ? (
                          <Select
                            value={accountOf(lang, pl)!.id}
                            onValueChange={(id) => setChosenAccount((s) => ({ ...s, [key]: id }))}
                          >
                            <SelectTrigger size="sm" aria-label={`Акаунт ${label}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {options.map((a) => (
                                <SelectItem key={a.id} value={a.id}>
                                  {a.name} {a.method === 'api' ? '· API' : '· вручну'}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-muted-foreground">
                            {options[0]!.name} {options[0]!.method === 'api' ? '· API' : '· вручну'}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                );
              }),
            )}
          </div>
        </section>
      )}

      {targets.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">Метадані</h3>
          <MetaEditor tabs={tabs} generation={generation} onChange={setMeta} onRegenerate={(lang) => run(lang, true)} />
        </section>
      )}

      <section className="grid gap-2">
        <h3 className="text-sm font-medium">Коли</h3>
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            type="single"
            variant="outline"
            value={when}
            onValueChange={(v) => {
              if (!v) return;
              setWhen(v as 'now' | 'at');
              if (v === 'at' && !at) setAt(toLocalInput(new Date(Date.now() + 60 * 60_000)));
            }}
          >
            <ToggleGroupItem value="now">Зараз</ToggleGroupItem>
            <ToggleGroupItem value="at">Дата й час</ToggleGroupItem>
          </ToggleGroup>
          {when === 'at' && (
            <Input
              type="datetime-local"
              aria-label="Дата й час публікації"
              className="w-auto"
              value={at}
              min={toLocalInput(new Date())}
              aria-invalid={Boolean(whenError)}
              onChange={(e) => setAt(e.target.value)}
            />
          )}
        </div>
        {whenError && <p className="text-xs text-destructive">{whenError}</p>}
        {when === 'at' && hasYoutube && !whenError && (
          <p className="text-xs text-muted-foreground">
            YouTube опублікує відео сам у вказаний час (завантаження почнеться одразу).
          </p>
        )}
      </section>

      {showAudit && (
        <p className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Info className="size-4 shrink-0" /> {AUDIT_HINT}
        </p>
      )}

      <DialogFooter>
        <Button data-testid="publish-submit" disabled={!canSubmit} onClick={submit}>
          Опублікувати
        </Button>
      </DialogFooter>

      <AccountDialog
        open={adding !== null}
        onOpenChange={(o) => !o && setAdding(null)}
        platform={adding?.platform}
        language={adding?.language}
        onCreated={(a) => {
          // новий акаунт одразу вибраний для цієї мови й платформи
          const key = targetKey(a.language, a.platform);
          setChosenAccount((s) => ({ ...s, [key]: a.id }));
          setEnabled((s) => ({ ...s, [key]: true }));
        }}
      />
    </div>
  );
}
