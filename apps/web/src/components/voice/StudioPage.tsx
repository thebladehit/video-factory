import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ProjectView } from '@vf/api';
import type { CaptionStyle } from '@vf/captions';
import { languageInfo, type ModelRef, type OriginalSound } from '@vf/shared';
import { docDuration } from '@vf/timeline';
import { ArrowLeft, Check, CloudOff, Languages, Loader2, Mic, Pencil, TextCursorInput, Volume2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ConflictDialog } from '@/components/editor/ConflictDialog';
import { RenderHistory } from '@/components/editor/RenderHistory';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createCanvasPreviewEngine } from '@/editor/preview-engine';
import { createUiStore } from '@/editor/store';
import { useDocSession } from '@/editor/use-doc-session';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { formatUsd } from '@/voice/cost';
import { planPaste } from '@/voice/paste-text';
import { useVoice } from '@/voice/use-voice';
import { CaptionsPanel, DEFAULT_STYLE_ID } from './CaptionsPanel';
import { LanguageBar } from './LanguageBar';
import { OriginalSoundPanel } from './OriginalSoundPanel';
import { PasteTextDialog } from './PasteTextDialog';
import { SegmentStrip } from './SegmentStrip';
import { SegmentTable } from './SegmentTable';
import { StudioPreview } from './StudioPreview';
import { StudioRenderMenu } from './StudioRenderMenu';
import { StyleEditor } from './StyleEditor';
import { VoicePicker, type VoiceValue } from './VoicePicker';

const SAVE_LABEL = {
  saved: (
    <>
      <Check className="size-4" /> Збережено
    </>
  ),
  saving: (
    <>
      <Loader2 className="size-4 animate-spin" /> Зберігаю…
    </>
  ),
  error: (
    <>
      <CloudOff className="size-4" /> Не збережено — повторити
    </>
  ),
  conflict: (
    <>
      <CloudOff className="size-4" /> Конфлікт версій
    </>
  ),
};

const Section = ({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) => (
  <section className="grid gap-1.5" data-testid={testId}>
    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
    {children}
  </section>
);

/** Свіжий знімок проєкту для старту сесії (далі джерело правди — стор документа), як у маршруті редактора. */
export function StudioPage({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const project = useQuery({
    ...trpc.projects.get.queryOptions({ id: projectId }),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  if (project.isError) return <p className="text-destructive">{project.error.message}</p>;
  if (!project.data || !project.isFetchedAfterMount) return <p className="text-muted-foreground">Завантаження…</p>;
  return <Studio project={project.data} />;
}

function Studio({ project }: { project: ProjectView }) {
  const projectId = project.id;
  const trpc = useTRPC();
  const { view, error, refetch } = useVoice(projectId);
  const session = useDocSession(project, refetch);
  const { store, autosave } = session;
  const [engine] = useState(createCanvasPreviewEngine);
  const [previewUi] = useState(createUiStore);
  const [stripUi] = useState(createUiStore);
  const settings = useQuery(trpc.settings.get.queryOptions());
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [editing, setEditing] = useState<{ initial: CaptionStyle; savedId: string | null; savedName?: string } | null>(
    null,
  );
  const [draft, setDraft] = useState<CaptionStyle | null>(null);
  const catalog = useQuery(trpc.ai.catalog.queryOptions());
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirmTranscribe, setConfirmTranscribe] = useState(false);

  const lang =
    view && chosen && view.languages.includes(chosen)
      ? chosen
      : view
        ? (view.languages.find((l) => l !== view.base) ?? view.base)
        : '';
  const isBase = !!view && lang === view.base;

  const baseRef = useBaseRef(isBase);
  // годинник прев'ю → UI-стор прев'ю; плейхед смуги збігається з ним лише в базовій мові (в інших час прев'ю — мовний)
  useEffect(() => {
    const offs = [
      engine.onTime((t) => {
        previewUi.getState().set({ playhead: t });
        if (baseRef.current) stripUi.getState().set({ playhead: t });
      }),
      engine.onEnded(() => previewUi.getState().set({ playing: false })),
    ];
    return () => {
      offs.forEach((off) => off());
      engine.destroy();
    };
  }, [engine, previewUi, stripUi]);

  // задача на сервері змінила сегменти (розпізнавання) — підтягнути документ, якщо локальних змін немає
  const serverVersion = view?.version ?? 0;
  const reloadDoc = session.reload;
  useEffect(() => {
    if (serverVersion > autosave.getVersion() && !autosave.hasPending())
      reloadDoc({ onlyIfClean: true }).catch((e: Error) => toast.error(`Не вдалося оновити сегменти: ${e.message}`));
  }, [serverVersion, autosave, reloadDoc]);

  // інша мова — редактор стилю закрити (він про стиль конкретної мови)
  useEffect(() => {
    setEditing(null);
    setDraft(null);
  }, [lang]);

  const onError = (e: { message: string }) => toast.error(e.message);
  const setLanguages = useMutation(trpc.voice.setLanguages.mutationOptions({ onSuccess: refetch, onError }));
  const setText = useMutation(trpc.voice.setText.mutationOptions({ onSuccess: refetch, onError }));
  const setVoice = useMutation(trpc.voice.setVoice.mutationOptions({ onSuccess: refetch, onError }));
  const setOriginal = useMutation(trpc.voice.setOriginal.mutationOptions({ onSuccess: refetch, onError }));
  const setCaptions = useMutation(trpc.voice.setCaptions.mutationOptions({ onSuccess: refetch, onError }));
  const transcribe = useMutation(
    trpc.voice.transcribe.mutationOptions({
      onSuccess: () => {
        toast.success('Розпізнавання запущено');
        refetch();
      },
      onError,
    }),
  );
  const translate = useMutation(
    trpc.voice.translate.mutationOptions({
      onSuccess: () => {
        toast.success('Переклад запущено');
        refetch();
      },
      onError,
    }),
  );
  const synthesize = useMutation(trpc.voice.synthesize.mutationOptions({ onSuccess: refetch, onError }));

  /** Сервер бачить сегменти лише із збереженого документа — спершу зберегти локальні правки. */
  async function saved(): Promise<boolean> {
    await autosave.flush();
    return !autosave.hasPending();
  }
  async function afterSave(run: () => void) {
    if (await saved()) run();
    else toast.error('Не вдалося зберегти проєкт — спробуйте ще раз');
  }

  async function applyPaste(paragraphs: string[]) {
    if (!view) return;
    const plan = planPaste(paragraphs, store.getState().doc);
    if (!plan.assignments.length) return;
    setPasting(true);
    try {
      if (plan.doc !== store.getState().doc) store.getState().apply(() => plan.doc);
      if (!(await saved())) {
        toast.error('Не вдалося зберегти сегменти — текст не вставлено');
        return;
      }
      for (const a of plan.assignments)
        await trpcClient.voice.setText.mutate({ projectId, segmentId: a.segmentId, language: view.base, text: a.text });
      refetch();
      setPasteOpen(false);
      if (plan.dropped > 0) toast.warning(`Для ${plan.dropped} абзаців не було місця — їх не вставлено`);
      else if (plan.extra > 0) toast.warning(`Абзаців було більше, ніж сегментів: додано ${plan.extra} нових в кінці`);
      else toast.success(`Вставлено абзаців: ${plan.assignments.length}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPasting(false);
    }
  }

  if (error) return <p className="text-destructive">{error.message}</p>;
  if (!view) return <p className="text-muted-foreground">Завантаження…</p>;

  const available = (cap: string) => catalog.data?.some((m) => m.capability === cap && m.available) ?? false;
  const hasTts = available('tts');
  const hasStt = available('stt');
  const hasText = available('text');
  const ttsHint = 'Немає ключа моделі озвучки — додайте його в «Налаштуваннях»';
  const sttHint = 'Немає ключа для розпізнавання мови (OpenAI або Google) — додайте його в «Налаштуваннях»';
  const textHint = 'Немає ключа текстової моделі для перекладу — додайте його в «Налаштуваннях»';

  // підказки видимі завжди: `title` на вимкненій кнопці не показується (pointer-events: none)
  const hints = catalog.data
    ? [!hasTts && ttsHint, !hasStt && sttHint, !hasText && textHint].filter((h): h is string => !!h)
    : [];
  const baseHasText = view.segments.some((s) => view.lines[s.id]?.[view.base]?.text.trim());
  const hasContent = view.segments.length > 0;
  const estimate = view.estimate[lang];
  const busy = Object.values(view.lines).some((byLang) =>
    Object.values(byLang).some((l) => l.state === 'queued' || l.state === 'running'),
  );
  const total = docDuration(session.doc);
  const voiceChoice = (view.voice.languages[lang]?.voice ?? null) as VoiceValue | null;
  const defaultVoice = (settings.data?.voices[lang] ?? null) as VoiceValue | null;
  const captionsCfg = view.voice.languages[lang]?.captions ?? { enabled: false, styleId: DEFAULT_STYLE_ID };
  const renderDisabled =
    session.saveState === 'conflict' ? 'Розв’яжіть конфлікт версій' : total <= 0 ? 'У відео немає що рендерити' : null;

  function openStyleEditor() {
    const found = view!.styles.find((s) => s.id === captionsCfg.styleId) ?? view!.styles[0]!;
    const isPreset = found.id.startsWith('preset:');
    setEditing({ initial: found.style, savedId: isPreset ? null : found.id, savedName: found.name });
    setDraft(found.style);
  }
  const closeStyleEditor = () => {
    setEditing(null);
    setDraft(null);
  };

  return (
    <div className="grid h-[calc(100vh-6rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label="До списку">
          <Link to="/voice">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="max-w-xs truncate text-lg font-semibold" title={project.title}>
          {project.title}
        </h1>
        <LanguageBar
          view={view}
          selected={lang}
          onSelect={setChosen}
          onChange={(next) => setLanguages.mutate({ projectId, ...next })}
        />
        <button
          type="button"
          data-testid="save-state"
          data-state={session.saveState}
          disabled={session.saveState !== 'error'}
          onClick={() => void autosave.flush()}
          className={`ml-auto flex items-center gap-1 text-sm ${session.saveState === 'error' || session.saveState === 'conflict' ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {SAVE_LABEL[session.saveState]}
        </button>
        <Button variant="outline" size="sm" asChild>
          <Link to="/projects/$id" params={{ id: projectId }}>
            <Pencil /> Відкрити в редакторі
          </Link>
        </Button>
        <StudioRenderMenu
          projectId={projectId}
          languages={view.languages}
          disabledReason={renderDisabled}
          prepare={saved}
        />
      </div>

      <div className="grid min-h-0 grid-cols-[minmax(320px,440px)_minmax(0,1fr)] gap-4">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1" data-testid="studio-left">
          <section className="grid gap-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Прев’ю:</span>
              <Select value={lang} onValueChange={setChosen}>
                <SelectTrigger size="sm" className="w-44" aria-label="Мова прев’ю">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {view.languages.map((c) => (
                    <SelectItem key={c} value={c}>
                      {languageInfo(c).name} ({c.toUpperCase()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="h-72 shrink-0">
              <StudioPreview projectId={projectId} language={lang} engine={engine} ui={previewUi} draft={draft} />
            </div>
          </section>

          <Section title="Сегменти" testId="strip-section">
            <SegmentStrip
              store={store}
              ui={stripUi}
              onSeek={(t) => {
                if (isBase) engine.seek(t);
              }}
            />
            {!isBase && (
              <p className="text-xs text-muted-foreground">
                Плейхед смуги — час базового відео; прев’ю мови {lang.toUpperCase()} має власний час.
              </p>
            )}
          </Section>

          {editing ? (
            <Section title="Редактор стилю">
              {!captionsCfg.enabled && (
                <p className="text-xs text-amber-700 dark:text-amber-500">
                  Увімкніть субтитри мови, щоб бачити зміни стилю в прев’ю.
                </p>
              )}
              <StyleEditor
                key={editing.savedId ?? editing.initial.font + captionsCfg.styleId}
                initial={editing.initial}
                savedId={editing.savedId}
                {...(editing.savedName ? { savedName: editing.savedName } : {})}
                onDraft={setDraft}
                onClose={closeStyleEditor}
                onSaved={(styleId) => {
                  setCaptions.mutate({ projectId, language: lang, enabled: captionsCfg.enabled, styleId });
                  closeStyleEditor();
                }}
              />
            </Section>
          ) : (
            <>
              <Section title="Оригінальний звук">
                <OriginalSoundPanel
                  value={view.voice.original as OriginalSound}
                  onChange={(original) => setOriginal.mutateAsync({ projectId, original }).then(() => undefined)}
                />
              </Section>
              <Section title={`Голос мови ${lang.toUpperCase()}`}>
                <VoicePicker
                  idPrefix="studio"
                  language={lang}
                  value={voiceChoice}
                  fallback={defaultVoice}
                  withInstructions
                  onChange={(voice) =>
                    setVoice.mutate({
                      projectId,
                      language: lang,
                      voice: voice ? { ...voice, model: voice.model as ModelRef } : null,
                    })
                  }
                />
              </Section>
              <Section title={`Субтитри мови ${lang.toUpperCase()}`}>
                <CaptionsPanel
                  projectId={projectId}
                  view={view}
                  lang={lang}
                  editing={false}
                  onEditStyle={openStyleEditor}
                  onChanged={refetch}
                />
              </Section>
            </>
          )}
        </div>

        <section className="flex min-h-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="paste-text-open"
              disabled={total <= 0}
              onClick={() => setPasteOpen(true)}
            >
              <TextCursorInput /> Вставити текст
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="transcribe"
              disabled={!hasStt || transcribe.isPending}
              title={hasStt ? undefined : sttHint}
              onClick={() =>
                hasContent && baseHasText
                  ? setConfirmTranscribe(true)
                  : void afterSave(() => transcribe.mutate({ projectId, language: view.base }))
              }
            >
              <Mic /> Розпізнати мову оригіналу
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="translate-all"
              disabled={isBase || !baseHasText || !hasText || translate.isPending}
              title={
                isBase
                  ? 'Виберіть мову, на яку перекладати'
                  : !baseHasText
                    ? 'Спершу з’являться тексти базової мови'
                    : hasText
                      ? undefined
                      : textHint
              }
              onClick={() => void afterSave(() => translate.mutate({ projectId, language: lang }))}
            >
              <Languages /> Перекласти все
            </Button>
            <Button
              size="sm"
              data-testid="voice-all"
              disabled={!hasTts || synthesize.isPending || !estimate?.chars}
              title={hasTts ? (estimate?.chars ? undefined : 'Немає текстів для озвучки') : ttsHint}
              onClick={() => void afterSave(() => synthesize.mutate({ projectId, language: lang }))}
            >
              <Volume2 /> Озвучити все{estimate?.chars ? ` ≈ ${formatUsd(estimate.usd)}` : ''}
            </Button>
            {busy && <span className="text-xs text-muted-foreground">Виконується…</span>}
          </div>
          {hints.length > 0 && (
            <ul data-testid="key-hints" className="grid gap-0.5 text-xs text-amber-700 dark:text-amber-500">
              {hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <SegmentTable
              view={view}
              lang={lang}
              canVoice={hasTts}
              onSaveText={(segmentId, language, text) => setText.mutate({ projectId, segmentId, language, text })}
              onSynthesize={(segmentId) =>
                void afterSave(() => synthesize.mutate({ projectId, language: lang, segmentIds: [segmentId] }))
              }
            />
          </div>
        </section>
      </div>

      <RenderHistory projectId={projectId} />

      <PasteTextDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        doc={session.doc}
        language={view.base}
        busy={pasting}
        onApply={(paragraphs) => void applyPaste(paragraphs)}
      />

      <ConflictDialog
        open={session.saveState === 'conflict'}
        onReload={() => void session.reload().catch((e: Error) => toast.error(e.message))}
        onOverwrite={() => void session.overwrite()}
      />

      <AlertDialog open={confirmTranscribe} onOpenChange={setConfirmTranscribe}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Замінити наявні сегменти й тексти?</AlertDialogTitle>
            <AlertDialogDescription>
              Розпізнавання перезапише сегменти й тексти базової мови. Переклади лишаться, але стануть застарілими.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Скасувати</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmTranscribe(false);
                void afterSave(() => transcribe.mutate({ projectId, language: view.base }));
              }}
            >
              Замінити
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Актуальне значення для обробників, підписаних один раз. */
function useBaseRef(value: boolean) {
  const [ref] = useState({ current: value });
  ref.current = value;
  return ref;
}
