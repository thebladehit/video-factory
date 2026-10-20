import { useQueryClient } from '@tanstack/react-query';
import type { ProjectView } from '@vf/api';
import { useState } from 'react';
import { allClips } from '@vf/timeline';
import { toast } from 'sonner';
import { useTRPC, trpcClient } from '@/lib/trpc';
import { isPresent } from '@/editor/types';
import { useEditorSession } from '@/editor/use-editor-assets';
import { ConflictDialog } from './ConflictDialog';
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

  const clips = allClips(s.doc);
  const missing = clips.some((c) => !isPresent(s.assets[c.assetId]));
  const processing = clips.some((c) => {
    const a = s.assets[c.assetId];
    return isPresent(a) && 'status' in a && a.status !== 'ready';
  });
  const disabledReason = !clips.length
    ? 'Додайте файли на таймлайн'
    : s.pendingUploads || processing
      ? 'Зачекайте, поки файли завантажаться й обробляться'
      : missing
        ? 'Замініть або приберіть кліпи з видаленими файлами'
        : null;

  async function render(preset: 'final' | 'draft') {
    setStarting(true);
    try {
      await s.autosave.flush();
      // інакше сервер відрендерить останню збережену версію без свіжих змін
      if (s.autosave.hasPending()) {
        toast.error('Не вдалося зберегти проєкт — рендер не запущено. Повторіть збереження.');
        return;
      }
      await trpcClient.renders.start.mutate({ projectId: project.id, preset, version: s.autosave.getVersion() });
      s.ui.getState().set({ invalidClips: [] });
      toast.success(preset === 'final' ? 'Фінал 1080p — у черзі' : 'Чернетка 720p — у черзі');
      void qc.invalidateQueries({ queryKey: trpc.renders.list.queryKey({ projectId: project.id }) });
    } catch (e) {
      const details = (e as { data?: { details?: { clipIds?: string[] } } }).data?.details;
      if (details?.clipIds) s.ui.getState().set({ invalidClips: details.clipIds });
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const addAtPlayhead = (id: string) => void s.addAssets([id], s.ui.getState().playhead);

  return (
    <div className="grid h-[calc(100vh-6rem)] grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_minmax(200px,38%)_auto] gap-2">
      <Toolbar
        projectId={project.id}
        title={project.title}
        store={s.store}
        saveState={s.saveState}
        onRetrySave={() => void s.autosave.flush()}
      >
        <RenderMenu disabledReason={disabledReason} busy={starting} onRender={(p) => void render(p)} />
      </Toolbar>
      <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)_260px] gap-3">
        <LibraryPanel onAdd={addAtPlayhead} />
        <PreviewPane engine={s.engine} doc={s.doc} ui={s.ui} onTogglePlay={s.togglePlay} />
        <Inspector store={s.store} ui={s.ui} assets={s.assets} />
      </div>
      <Timeline
        store={s.store}
        ui={s.ui}
        assets={s.assets}
        onSeek={s.seek}
        onTogglePlay={s.togglePlay}
        onDropAssets={(ids, at, trackId) => void s.addAssets(ids, at, trackId)}
        onDropFiles={(files, at, trackId) => void s.addFiles(files, at, trackId)}
      />
      <RenderHistory projectId={project.id} />
      <ConflictDialog
        open={s.saveState === 'conflict'}
        onReload={() => void s.reload()}
        onOverwrite={() => void s.overwrite()}
      />
    </div>
  );
}
