import type { JobEvent, PipelineStage, PipelineStatus } from '@vf/shared';

export type StepState = 'done' | 'active' | 'todo' | 'failed';
export interface StageStep {
  key: PipelineStage;
  label: string;
  state: StepState;
  /** «Перевірка» без `stopAfterScript` — етап пропускається */
  skipped?: true;
}

export interface RunLike {
  stage: PipelineStage;
  status: PipelineStatus;
  settings: { stopAfterScript: boolean };
}

export const STAGE_LABEL: Record<PipelineStage, string> = {
  script: 'Сценарій',
  review: 'Перевірка',
  produce: 'Візуал і озвучка',
  assemble: 'Збірка',
  done: 'Готово',
};
const ORDER: PipelineStage[] = ['script', 'review', 'produce', 'assemble', 'done'];

/** Кроки смуги етапів: пройдені — done, поточний — active (failed, якщо запуск упав на ньому), далі — todo. */
export function stageSteps(run: RunLike): StageStep[] {
  const current = ORDER.indexOf(run.stage);
  return ORDER.map((key, i) => {
    const label = STAGE_LABEL[key];
    if (key === 'review' && !run.settings.stopAfterScript) return { key, label, state: 'todo', skipped: true };
    let state: StepState;
    if (i < current || run.stage === 'done') state = 'done';
    else if (i > current) state = 'todo';
    else state = run.status === 'failed' ? 'failed' : 'active';
    return { key, label, state };
  });
}

/** Що з перегляду потрібно, щоб упізнати події запуску */
export interface EventScope {
  project: { id: string };
  scenes: {
    id: string;
    generationId: string | null;
    visual: { assetId: string } | null;
    lines: Record<string, { id: string }>;
  }[];
}

/**
 * Подія задачі стосується запуску: проєкт, його сцени, рядки озвучки, генерація чи файл візуалу сцени.
 * До першого завантаження (`view` немає) — лише за `projectId`.
 */
export function isPipelineEvent(
  e: Pick<JobEvent, 'subject'>,
  view: EventScope | undefined,
  projectId?: string,
): boolean {
  const s = e.subject;
  const pid = view?.project.id ?? projectId;
  if (s.projectId && s.projectId === pid) return true;
  if (!view) return false;
  return view.scenes.some(
    (sc) =>
      (!!s.sceneId && sc.id === s.sceneId) ||
      (!!s.generationId && sc.generationId === s.generationId) ||
      (!!s.assetId && sc.visual?.assetId === s.assetId) ||
      (!!s.lineId && Object.values(sc.lines).some((l) => l.id === s.lineId)),
  );
}

/** Перший перехід живого запуску в `done` (після нього — автоперехід у редактор). */
export function justFinished(prev: RunLike | undefined, next: RunLike | undefined): boolean {
  return !!prev && !!next && prev.stage !== 'done' && next.stage === 'done' && next.status === 'done';
}
