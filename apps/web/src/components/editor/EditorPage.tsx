import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectView } from '@vf/api';
import { useState } from 'react';
import { useStore } from 'zustand';
import { allClips } from '@vf/timeline';
import { toast } from 'sonner';
import { useTRPC, trpcClient } from '@/lib/trpc';
import { isPresent } from '@/editor/types';
import { useEditorSession } from '@/editor/use-editor-assets';
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
import { SegmentStrip } from '@/components/voice/SegmentStrip';
import { notReadyDetails } from '@/components/voice/StudioRenderMenu';
import { ConflictDialog } from './ConflictDialog';
import { PipelineBanner } from './PipelineBanner';
import { LanguageBanner } from './LanguageBanner';
import { LanguageSwitch } from './LanguageSwitch';
import { Inspector } from './Inspector';
import { LibraryPanel } from './LibraryPanel';
import { PreviewPane } from './PreviewPane';
import { RenderHistory } from './RenderHistory';
import { RenderMenu } from './RenderMenu';
import { Timeline } from './Timeline';
import { Toolbar } from './Toolbar';

export function EditorPage({ project }: { project: ProjectView }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const s = useEditorSession(project);
  const [starting, setStarting] = useState(false);
  const [forcePending, setForcePending] = useState<{
    preset: 'final' | 'draft';
    language: string;
    count: number;
  } | null>(null);
  const voice = useQuery(trpc.voice.get.queryOptions({ projectId: project.id }));
  const languages = voice.data?.languages ?? [];
  const separated = voice.data?.separated ?? [];
  const hasVoice = languages.length > 1 || (voice.data?.segments.length ?? 0) > 0;
  const mode = useStore(s.store, (st) => st.mode);

  const pps = useStore(s.ui, (st) => st.pxPerSec);
  const clips = allClips(s.doc);
  const missing = clips.some((c) => !isPresent(s.assets[c.assetId]));
  const processing = clips.some((c) => {
    const a = s.assets[c.assetId];
    return isPresent(a) && 'status' in a && a.status !== 'ready';
  });
  const disabledReason = s.pipelineLive
    ? 'Конвеєр ще працює — рендер після збірки'
    : !clips.length
    ? 'Додайте файли на таймлайн'
    : s.pendingUploads || processing
      ? 'Зачекайте, поки файли завантажаться й обробляться'
      : missing
        ? 'Замініть або приберіть кліпи з видаленими файлами'
        : null;

  async function render(preset: 'final' | 'draft', language: string | null, force = false) {
    setStarting(true);
    try {
      // усі документи зберігаються: інакше сервер відрендерить останню збережену версію без свіжих змін
      await Promise.all([...s.saves.values()].map((a) => a.flush()));
      if ([...s.saves.values()].some((a) => a.hasPending())) {
        toast.error('Не вдалося зберегти проєкт — рендер не запущено. Повторіть збереження.');
        return;
      }
      let version = s.autosave.getVersion();
      if (language !== null) {
        // версія документа мови (власного або базового) — з сервера: вона єдина достовірна
        version = (await trpcClient.voice.localized.query({ projectId: project.id, language })).version;
      }
      await trpcClient.renders.start.mutate({
        projectId: project.id,
        preset,
        version,
        ...(language !== null ? { language } : {}),
        ...(force ? { force: true } : {}),
      });
      s.ui.getState().set({ invalidClips: [] });
      setForcePending(null);
      const what = preset === 'final' ? 'Фінал 1080p' : 'Чернетка 720p';
      toast.success(`${language ? `${language.toUpperCase()}: ` : ''}${what} — у черзі`);
      void qc.invalidateQueries({ queryKey: trpc.renders.list.queryKey({ projectId: project.id }) });
    } catch (e) {
      const notReady = language !== null && !force ? notReadyDetails(e) : null;
      if (notReady) {
        setForcePending({ preset, language: language!, count: notReady.segmentIds.length });
        return;
      }
      const details = (e as { data?: { details?: { clipIds?: string[] } } }).data?.details;
      if (details?.clipIds) s.ui.getState().set({ invalidClips: details.clipIds });
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  // рядки сітки: тулбар, [банер конвеєра], [банер мови], прев'ю, [смуга сегментів], таймлайн, історія
  const rows = [
    'auto',
    ...(s.pipelineLive ? ['auto'] : []),
    ...(mode.kind === 'language' ? ['auto'] : []),
    'minmax(0,1fr)',
    ...(mode.kind === 'edit' && hasVoice ? ['auto'] : []),
    'minmax(200px,38%)',
    'auto',
  ];

  const addAtPlayhead = (id: string) => void s.addAssets([id], s.ui.getState().playhead);

  return (
    <div
      className="grid h-[calc(100vh-6rem)] grid-cols-[minmax(0,1fr)] gap-2"
      style={{ gridTemplateRows: rows.join(' ') }}
    >
      <Toolbar
        projectId={project.id}
        title={project.title}
        store={s.store}
        saveState={s.saveState}
        onRetrySave={() => void s.activeAutosave()?.flush()}
        readOnly={s.readOnly}
        hasPipeline={project.pipeline !== null}
        modeSwitch={
          hasVoice && (
            <LanguageSwitch
              mode={mode}
              languages={languages}
              separated={separated}
              disabled={s.switching}
              onChange={(m) => void s.switchTo(m)}
            />
          )
        }
      >
        <RenderMenu
          disabledReason={disabledReason}
          busy={starting}
          languages={hasVoice ? languages : []}
          onRender={(p, l) => void render(p, l)}
        />
      </Toolbar>
      {s.pipelineLive && <PipelineBanner projectId={project.id} />}
      {mode.kind === 'language' && (
        <LanguageBanner
          language={mode.language}
          separated={mode.separated}
          busy={s.switching}
          frozen={s.pipelineLive}
          onSeparate={() => void s.separate((mode as { language: string }).language)}
          onUnseparate={() => void s.unseparate((mode as { language: string }).language)}
        />
      )}
      <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)_260px] gap-3">
        <LibraryPanel onAdd={addAtPlayhead} />
        <PreviewPane engine={s.engine} doc={s.doc} ui={s.ui} onTogglePlay={s.togglePlay} />
        <Inspector store={s.store} ui={s.ui} assets={s.assets} />
      </div>
      {mode.kind === 'edit' && hasVoice && (
        <div className="min-w-0 pl-28" data-testid="editor-segment-strip">
          <SegmentStrip store={s.store} ui={s.ui} pxPerSec={pps} onSeek={s.seek} />
        </div>
      )}
      <div className="flex min-h-0 flex-col [&>*]:min-h-0 [&>*]:flex-1">
        <Timeline
          segmentKeys={mode.kind === 'edit' && hasVoice}
          store={s.store}
          ui={s.ui}
          assets={s.assets}
          onSeek={s.seek}
          onTogglePlay={s.togglePlay}
          onDropAssets={(ids, at, trackId) => void s.addAssets(ids, at, trackId)}
          onDropFiles={(files, at, trackId) => void s.addFiles(files, at, trackId)}
        />
      </div>
      <RenderHistory projectId={project.id} />
      <AlertDialog open={!!forcePending} onOpenChange={(o) => !o && setForcePending(null)}>
        <AlertDialogContent data-testid="render-force">
          <AlertDialogHeader>
            <AlertDialogTitle>Рендерити все одно?</AlertDialogTitle>
            <AlertDialogDescription>
              Неозвучених або застарілих сегментів: {forcePending?.count} (мова {forcePending?.language.toUpperCase()}).
              Вони підуть без голосу, з темпом 1.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Скасувати</AlertDialogCancel>
            <AlertDialogAction
              data-testid="render-force-confirm"
              onClick={() => forcePending && void render(forcePending.preset, forcePending.language, true)}
            >
              Рендерити все одно
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConflictDialog
        open={s.saveState === 'conflict'}
        onReload={() => void s.reload()}
        onOverwrite={() => void s.overwrite()}
      />
    </div>
  );
}
