import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABELS, PLATFORMS, type Platform, type PublicationMeta } from '@vf/shared';
import { Info, Plus, RefreshCw } from 'lucide-react';
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
import { useConnectYoutube } from './ConnectYoutubeDialog';
import { blockingPublication, changedFields, mergeGenerated } from './dialog-state';
import { EMPTY_META, MetaEditor, metaErrors, withDefaults, type GenState, type MetaTab } from './MetaEditor';
import { statusLabel } from './status';
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
/** Метадані й стан генерації — окремо для кожної пари (проєкт, мова) */
const metaKey = (projectId: string, language: string) => `${projectId}:${language}`;

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
  /** Ключ — metaKey(проєкт, мова) */
  const [metas, setMetas] = useState<Record<string, Partial<Record<Platform, PublicationMeta>>>>({});
  const [generation, setGeneration] = useState<Record<string, GenState | undefined>>({});
  /** Поля, які користувач змінив вручну: пізня відповідь AI їх не перезапише */
  const edited = useRef<Record<string, Partial<Record<Platform, Set<string>>>>>({});
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
  /** Мови з готовим фінальним рендером — лише їх можна вибрати */
  const ready = useMemo(() => projectVersions.filter((v) => v.renderId !== null), [projectVersions]);
  const langs = useMemo(() => {
    if (pickedLangs) return pickedLangs;
    const all = ready.map((v) => v.language);
    return initialLanguage && all.includes(initialLanguage) ? [initialLanguage] : all;
  }, [pickedLangs, ready, initialLanguage]);

  // наявні публікації проєкту: версію вдруге на той самий акаунт не пропонуємо
  const publicationsQuery = useQuery({
    ...trpc.publish.list.queryOptions({ projectId }),
    enabled: Boolean(projectId),
  });
  const renderOf = (lang: string) => ready.find((v) => v.language === lang)?.renderId ?? null;
  const blockerOf = (lang: string, account: AccountRow | undefined) => {
    const renderId = renderOf(lang);
    if (!account || !renderId) return undefined;
    return blockingPublication(publicationsQuery.data ?? [], renderId, account.id);
  };

  const accounts = accountsQuery.data?.accounts ?? [];
  const accountsFor = (lang: string, pl: Platform) =>
    accounts.filter((a) => a.language === lang && a.platform === pl && a.status === 'active');
  const lostFor = (lang: string, pl: Platform) =>
    accounts.filter((a) => a.language === lang && a.platform === pl && a.status === 'reauth_required');
  const accountOf = (lang: string, pl: Platform): AccountRow | undefined => {
    const list = accountsFor(lang, pl);
    return (
      list.find((a) => a.id === chosenAccount[targetKey(lang, pl)]) ?? list.find((a) => !blockerOf(lang, a)) ?? list[0]
    );
  };
  const isEnabled = (lang: string, pl: Platform) => {
    const account = accountOf(lang, pl);
    // поки список публікацій вантажиться, не знаємо, чи пара вже зайнята
    if (!account || publicationsQuery.isPending || blockerOf(lang, account)) return false;
    return enabled[targetKey(lang, pl)] ?? (initialPlatform ? pl === initialPlatform : true);
  };
  const reconnect = useConnectYoutube();

  // AI-метадані для кожної вибраної мови: при відкритті й при виборі нової мови
  const generate = useMutation(trpc.publish.generateMeta.mutationOptions());
  const requested = useRef(new Set<string>());
  /** Номер останнього запиту для ключа: відповідь застарілого запиту відкидається */
  const latest = useRef<Record<string, number>>({});
  const run = (lang: string, force: boolean) => {
    if (!projectId) return;
    // відповідь пишеться лише під свій (проєкт, мова) — на інший проєкт вона не потрапить
    const key = metaKey(projectId, lang);
    const seq = (latest.current[key] ?? 0) + 1;
    latest.current[key] = seq;
    setGeneration((g) => ({ ...g, [key]: 'loading' }));
    generate
      .mutateAsync({ projectId, language: lang, force })
      .then(({ variants }) => {
        if (latest.current[key] !== seq) return;
        // «Згенерувати знову» — свідомий запит: перезаписує й ручні правки
        if (force) edited.current[key] = {};
        setMetas((m) => ({ ...m, [key]: mergeGenerated(variants, m[key], edited.current[key] ?? {}) }));
        setGeneration((g) => ({ ...g, [key]: 'done' }));
      })
      // текст помилки показує загальний тост мутацій; поля лишаються для ручного заповнення
      .catch(() => {
        if (latest.current[key] === seq) setGeneration((g) => ({ ...g, [key]: 'error' }));
      });
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

  const metaOf = (lang: string, pl: Platform) => withDefaults(pl, metas[metaKey(projectId, lang)]?.[pl] ?? EMPTY_META);
  const setMeta = (lang: string, pl: Platform, meta: PublicationMeta) => {
    const key = metaKey(projectId, lang);
    const fields = ((edited.current[key] ??= {})[pl] ??= new Set());
    for (const f of changedFields(metaOf(lang, pl), meta)) fields.add(f);
    setMetas((m) => ({ ...m, [key]: { ...m[key], [pl]: meta } }));
  };
  /** Стан генерації поточного проєкту за мовою — як його чекає MetaEditor */
  const generationByLang = Object.fromEntries(langs.map((l) => [l, generation[metaKey(projectId, l)]]));

  const targets = langs.flatMap((lang) =>
    PLATFORMS.filter((pl) => isEnabled(lang, pl)).map((pl) => ({ language: lang, platform: pl })),
  );
  const tabs: MetaTab[] = targets.map((t) => ({ ...t, meta: metaOf(t.language, t.platform) }));
  const hasYoutube = targets.some((t) => t.platform === 'youtube');
  const whenError = timeError(when, at, hasYoutube);
  const metaInvalid = tabs.some((t) => metaErrors(t.platform, t.meta).all.length > 0);
  const generating = langs.some((l) => generationByLang[l] === 'loading');
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
      renderId: renderOf(t.language)!,
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
        {projectId && !versions.isPending && !ready.length && (
          <p className="text-sm text-muted-foreground">Немає готового рендеру: зробіть фінальний рендер у редакторі.</p>
        )}
        {projectVersions.length > 0 && (
          <div className="flex flex-wrap gap-4">
            {projectVersions.map((v) => {
              const disabled = v.renderId === null;
              return (
                <label
                  key={v.language}
                  className={`flex items-center gap-2 text-sm ${disabled ? 'text-muted-foreground' : ''}`}
                  title={disabled ? 'Немає готового рендеру' : undefined}
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    data-testid="publish-language"
                    data-language={v.language}
                    disabled={disabled}
                    checked={!disabled && langs.includes(v.language)}
                    onChange={(e) => toggleLang(v.language, e.target.checked)}
                  />
                  {v.projectTitle} · {v.language.toUpperCase()} · {v.format}
                  {disabled && <span className="text-xs">· Немає готового рендеру</span>}
                </label>
              );
            })}
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
                const lost = lostFor(lang, pl)[0];
                const key = targetKey(lang, pl);
                const label = PLATFORM_LABELS[pl];
                const current = accountOf(lang, pl);
                const blocker = blockerOf(lang, current);
                return (
                  <div
                    key={key}
                    data-testid="publish-target"
                    data-platform={pl}
                    data-language={lang}
                    className="flex min-h-9 items-center gap-3 text-sm"
                  >
                    <PlatformIcon platform={pl} className="size-6 text-[9px]" />
                    {options.length === 0 && lost ? (
                      <>
                        <span className="text-muted-foreground" data-testid="publish-target-reauth">
                          {label} · {lang.toUpperCase()} · {lost.name} — Потребує перепідключення
                        </span>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={reconnect.isPending}
                          onClick={() => reconnect.mutate({ platform: 'youtube', language: lost.language })}
                        >
                          <RefreshCw /> Перепідключити
                        </Button>
                      </>
                    ) : options.length === 0 ? (
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
                            disabled={Boolean(blocker)}
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
                        {blocker && (
                          <span className="text-xs text-muted-foreground" data-testid="publish-target-busy">
                            Уже є: {statusLabel(blocker, new Date())}
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
          <MetaEditor
            tabs={tabs}
            generation={generationByLang}
            onChange={setMeta}
            onRegenerate={(lang) => run(lang, true)}
          />
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
