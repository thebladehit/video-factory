import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { languageInfo } from '@vf/shared';
import { ArrowLeft, Languages, Mic, Pencil, Volume2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
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
import { useTRPC } from '@/lib/trpc';
import { formatUsd } from '@/voice/cost';
import { useVoice } from '@/voice/use-voice';
import { LanguageBar } from './LanguageBar';
import { SegmentTable } from './SegmentTable';
import { StudioPreview } from './StudioPreview';

export function StudioPage({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const { view, error, refetch } = useVoice(projectId);
  const cards = useQuery(trpc.voice.list.queryOptions());
  const catalog = useQuery(trpc.ai.catalog.queryOptions());
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirmTranscribe, setConfirmTranscribe] = useState(false);

  const onError = (e: { message: string }) => toast.error(e.message);
  const setLanguages = useMutation(trpc.voice.setLanguages.mutationOptions({ onSuccess: refetch, onError }));
  const setText = useMutation(trpc.voice.setText.mutationOptions({ onSuccess: refetch, onError }));
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

  if (error) return <p className="text-destructive">{error.message}</p>;
  if (!view) return <p className="text-muted-foreground">Завантаження…</p>;

  const title = cards.data?.find((c) => c.id === projectId)?.title ?? 'Озвучка';
  const lang =
    chosen && view.languages.includes(chosen) ? chosen : (view.languages.find((l) => l !== view.base) ?? view.base);
  const isBase = lang === view.base;

  const available = (cap: string) => catalog.data?.some((m) => m.capability === cap && m.available) ?? false;
  const hasTts = available('tts');
  const hasStt = available('stt');
  const hasText = available('text');
  const ttsHint = 'Немає ключа моделі озвучки — додайте його в «Налаштуваннях»';
  const sttHint = 'Немає ключа для розпізнавання мови (OpenAI або Google) — додайте його в «Налаштуваннях»';
  const textHint = 'Немає ключа текстової моделі для перекладу — додайте його в «Налаштуваннях»';

  // підказки видимі завжди: `title` на вимкненій кнопці не показується (pointer-events: none)
  const hints = catalog.data ? [!hasTts && ttsHint, !hasStt && sttHint, !hasText && textHint].filter((h): h is string => !!h) : [];
  const baseHasText = view.segments.some((s) => view.lines[s.id]?.[view.base]?.text.trim());
  const hasContent = view.segments.length > 0;
  const estimate = view.estimate[lang];
  const busy = Object.values(view.lines).some((byLang) =>
    Object.values(byLang).some((l) => l.state === 'queued' || l.state === 'running'),
  );

  return (
    <div className="grid h-[calc(100vh-6rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label="До списку">
          <Link to="/voice">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="max-w-xs truncate text-lg font-semibold" title={title}>
          {title}
        </h1>
        <LanguageBar
          view={view}
          selected={lang}
          onSelect={setChosen}
          onChange={(next) => setLanguages.mutate({ projectId, ...next })}
        />
        <Button variant="outline" size="sm" asChild className="ml-auto">
          <Link to="/projects/$id" params={{ id: projectId }}>
            <Pencil /> Відкрити в редакторі
          </Link>
        </Button>
      </div>

      <div className="grid min-h-0 grid-cols-[minmax(260px,360px)_minmax(0,1fr)] gap-4">
        <section className="flex min-h-0 flex-col gap-2">
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
          <div className="min-h-0 flex-1">
            <StudioPreview projectId={projectId} language={lang} />
          </div>
        </section>

        <section className="flex min-h-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="transcribe"
              disabled={!hasStt || transcribe.isPending}
              title={hasStt ? undefined : sttHint}
              onClick={() =>
                hasContent && baseHasText
                  ? setConfirmTranscribe(true)
                  : transcribe.mutate({ projectId, language: view.base })
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
              onClick={() => translate.mutate({ projectId, language: lang })}
            >
              <Languages /> Перекласти все
            </Button>
            <Button
              size="sm"
              data-testid="voice-all"
              disabled={!hasTts || synthesize.isPending || !estimate?.chars}
              title={hasTts ? (estimate?.chars ? undefined : 'Немає текстів для озвучки') : ttsHint}
              onClick={() => synthesize.mutate({ projectId, language: lang })}
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
              onSynthesize={(segmentId) => synthesize.mutate({ projectId, language: lang, segmentIds: [segmentId] })}
            />
          </div>
        </section>
      </div>

      <RenderHistory projectId={projectId} />

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
                transcribe.mutate({ projectId, language: view.base });
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
