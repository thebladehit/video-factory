import { useQueryClient } from '@tanstack/react-query';
import type { ProjectView } from '@vf/api';
import { useState } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { useStore } from 'zustand';
import { allClips } from '@vf/timeline';
import { toast } from 'sonner';
import { useTRPC, trpcClient } from '@/lib/trpc';
import { layoutStorage } from '@/editor/layout-storage';
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
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
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

// ширша зона захоплення, ніж видима лінія 1 px
const handleX = 'mx-1.5';
const handleY = 'my-1.5';
// корінь панелі розтягується на всю висоту панелі (у сітці це робив stretch)
const fill = 'grid h-full min-h-0 min-w-0';
const hitSize = { fine: 6, coarse: 20 };

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
  const voice = s.voice;
  const languages = voice?.languages ?? [];
  const separated = voice?.separated ?? [];
  const hasVoice = languages.length > 1 || (voice?.segments.length ?? 0) > 0;
  const mode = useStore(s.store, (st) => st.mode);

  const horizontal = useDefaultLayout({ id: 'editor-h', storage: layoutStorage });
  const vertical = useDefaultLayout({ id: 'editor-v', storage: layoutStorage });

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

  // рядки сітки: тулбар, [банер конвеєра], [банер мови], група панелей, історія
  const rows = [
    'auto',
    ...(s.pipelineLive ? ['auto'] : []),
    ...(mode.kind === 'language' ? ['auto'] : []),
    'minmax(0,1fr)',
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
      <ResizablePanelGroup
        orientation="vertical"
        id="editor-v"
        resizeTargetMinimumSize={hitSize}
        className="min-h-0"
        defaultLayout={vertical.defaultLayout}
        onLayoutChanged={vertical.onLayoutChanged}
      >
        <ResizablePanel id="top" defaultSize="55%" minSize={120}>
          <ResizablePanelGroup
            orientation="horizontal"
            id="editor-h"
            resizeTargetMinimumSize={hitSize}
            defaultLayout={horizontal.defaultLayout}
            onLayoutChanged={horizontal.onLayoutChanged}
          >
            <ResizablePanel
              id="library"
              data-testid="panel-library"
              defaultSize={220}
              minSize={160}
              collapsible
              collapsedSize={0}
              groupResizeBehavior="preserve-pixel-size"
              className="min-w-0"
            >
              <div className={fill}>
                <LibraryPanel onAdd={addAtPlayhead} />
              </div>
            </ResizablePanel>
            <ResizableHandle data-testid="handle-library" className={handleX} />
            <ResizablePanel id="preview" minSize={120} className="min-w-0">
              <div className={fill}>
                <PreviewPane
                  engine={s.engine}
                  doc={s.doc}
                  ui={s.ui}
                  onTogglePlay={s.togglePlay}
                  store={s.store}
                  assets={s.assets}
                />
              </div>
            </ResizablePanel>
            <ResizableHandle data-testid="handle-inspector" className={handleX} />
            <ResizablePanel
              id="inspector"
              data-testid="panel-inspector"
              defaultSize={260}
              minSize={220}
              collapsible
              collapsedSize={0}
              groupResizeBehavior="preserve-pixel-size"
              className="min-w-0"
            >
              <div className={fill}>
                <Inspector store={s.store} ui={s.ui} assets={s.assets} />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle data-testid="handle-timeline" className={handleY} />
        <ResizablePanel id="bottom" defaultSize="45%" minSize={120}>
          <div className="flex h-full min-h-0 flex-col gap-2">
            {mode.kind === 'edit' && hasVoice && (
              <div className="min-w-0 pl-28" data-testid="editor-segment-strip">
                <SegmentStrip
                  store={s.store}
                  ui={s.ui}
                  pxPerSec={pps}
                  onSeek={s.seek}
                  voice={voice && { language: voice.base, takes: voice.baseTakes, pending: voice.basePending }}
                />
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col [&>*]:min-h-0 [&>*]:flex-1">
              <Timeline
                segmentKeys={mode.kind === 'edit' && hasVoice}
                voiceLanguage={mode.kind === 'edit' ? voice?.base : undefined}
                store={s.store}
                ui={s.ui}
                assets={s.assets}
                onSeek={s.seek}
                onTogglePlay={s.togglePlay}
                onDropAssets={(ids, at, trackId) => void s.addAssets(ids, at, trackId)}
                onDropFiles={(files, at, trackId) => void s.addFiles(files, at, trackId)}
              />
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
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
