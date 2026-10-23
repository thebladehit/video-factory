import type { PipelineView } from '@vf/api';
import { Check, ChevronRight, Loader2, X } from 'lucide-react';
import { Fragment } from 'react';
import { cn } from 'cn';
import { stageSteps, type StepState } from '@/pipeline/stages';

const STEP_CLASS: Record<StepState, string> = {
  done: 'text-foreground',
  active: 'font-medium text-sky-600 dark:text-sky-400',
  todo: 'text-muted-foreground',
  failed: 'font-medium text-destructive',
};

/** Сценарій → Перевірка → Візуал і озвучка N/M → Збірка → Готово; помилка етапу — під смугою. */
export function StageBar({ view }: { view: PipelineView }) {
  const { run, progress } = view;
  const steps = stageSteps(run);
  const live = run.status === 'running';
  return (
    <div className="grid gap-1">
      <ol aria-label="Етапи конвеєра" className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
        {steps.map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 && <ChevronRight aria-hidden className="size-4 text-muted-foreground/60" />}
            <li
              data-testid={`stage-${s.key}`}
              data-state={s.skipped ? 'skipped' : s.state}
              aria-current={s.state === 'active' ? 'step' : undefined}
              className={cn('flex items-center gap-1', STEP_CLASS[s.state], s.skipped && 'line-through opacity-60')}
              title={s.skipped ? 'Пропущено' : undefined}
            >
              {s.state === 'done' && !s.skipped && <Check aria-hidden className="size-3.5 text-emerald-600" />}
              {s.state === 'active' && live && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
              {s.state === 'failed' && <X aria-hidden className="size-3.5" />}
              <span>{s.label}</span>
              {s.key === 'produce' && s.state === 'active' && progress.total > 0 && (
                <span className="tabular-nums" data-testid="pipeline-page-progress">
                  {progress.done}/{progress.total}
                </span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
      {run.status === 'cancelled' && <p className="text-sm text-muted-foreground">Запуск скасовано</p>}
      {run.error && (
        <p role="alert" className="text-sm text-destructive">
          {run.error}
        </p>
      )}
    </div>
  );
}
