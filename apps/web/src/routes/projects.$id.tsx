import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { ProjectView } from '@vf/api';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { PreviewPane } from '@/components/editor/PreviewPane';
import { createCanvasPreviewEngine } from '@/editor/preview-engine';
import { createEditorStore, createUiStore } from '@/editor/store';
import { useTRPC } from '@/lib/trpc';

export const Route = createFileRoute('/projects/$id')({ component: ProjectPage });

function ProjectPage() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const project = useQuery(trpc.projects.get.queryOptions({ id }));
  if (!project.data) return <p className="text-muted-foreground">Завантаження…</p>;
  return <PreviewOnly project={project.data} />;
}

// тимчасово (Task 12): лише прев'ю; редактор цілком — Task 14
function PreviewOnly({ project }: { project: ProjectView }) {
  const [store] = useState(() => createEditorStore(project.timeline));
  const [ui] = useState(createUiStore);
  const [engine] = useState(createCanvasPreviewEngine);
  const doc = useStore(store, (s) => s.doc);
  useEffect(() => engine.setDoc(doc, project.assets), [engine, doc, project.assets]);
  useEffect(() => {
    const offTime = engine.onTime((t) => ui.getState().set({ playhead: t }));
    const offEnd = engine.onEnded(() => ui.getState().set({ playing: false }));
    return () => {
      offTime();
      offEnd();
      engine.destroy();
    };
  }, [engine, ui]);
  const toggle = () => {
    const playing = !ui.getState().playing;
    if (playing) engine.play();
    else engine.pause();
    ui.getState().set({ playing });
  };
  return (
    <div className="grid h-[70vh] gap-2">
      <h1 className="text-xl font-semibold">{project.title}</h1>
      <PreviewPane engine={engine} doc={doc} ui={ui} onTogglePlay={toggle} />
      <input
        type="range"
        min={0}
        max={7}
        step={0.01}
        aria-label="seek"
        onChange={(e) => engine.seek(Number(e.target.value))}
      />
    </div>
  );
}
