import { describe, expect, it } from 'vitest';
import { isPipelineEvent, justFinished, stageSteps, type EventScope, type RunLike } from './stages';

const run = (stage: RunLike['stage'], status: RunLike['status'], stopAfterScript = false): RunLike => ({
  stage,
  status,
  settings: { stopAfterScript },
});
const states = (r: RunLike) => stageSteps(r).map((s) => [s.label, s.state, !!s.skipped]);

describe('stageSteps', () => {
  it('produce without review marks Перевірка skipped and Візуал і озвучка active', () => {
    expect(states(run('produce', 'running'))).toEqual([
      ['Сценарій', 'done', false],
      ['Перевірка', 'todo', true],
      ['Візуал і озвучка', 'active', false],
      ['Збірка', 'todo', false],
      ['Готово', 'todo', false],
    ]);
  });

  it('produce after review marks Перевірка done', () => {
    expect(states(run('produce', 'running', true))[1]).toEqual(['Перевірка', 'done', false]);
  });

  it('script with stopAfterScript keeps Перевірка a regular todo step', () => {
    expect(states(run('script', 'running', true))).toEqual([
      ['Сценарій', 'active', false],
      ['Перевірка', 'todo', false],
      ['Візуал і озвучка', 'todo', false],
      ['Збірка', 'todo', false],
      ['Готово', 'todo', false],
    ]);
  });

  it('script without stopAfterScript already shows Перевірка as skipped', () => {
    expect(states(run('script', 'running'))[1]).toEqual(['Перевірка', 'todo', true]);
  });

  it('awaiting review marks Перевірка active', () => {
    expect(states(run('review', 'awaiting_review', true)).map((s) => s[1])).toEqual([
      'done',
      'active',
      'todo',
      'todo',
      'todo',
    ]);
  });

  it('failed run marks the stage of failure', () => {
    expect(states(run('script', 'failed')).map((s) => s[1])).toEqual(['failed', 'todo', 'todo', 'todo', 'todo']);
    expect(states(run('assemble', 'failed', true)).map((s) => s[1])).toEqual([
      'done',
      'done',
      'done',
      'failed',
      'todo',
    ]);
  });

  it('done run marks every step done (Готово included)', () => {
    expect(states(run('done', 'done', true)).map((s) => s[1])).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('cancelled run keeps the stage it stopped at active', () => {
    expect(states(run('produce', 'cancelled')).map((s) => s[1])).toEqual(['done', 'todo', 'active', 'todo', 'todo']);
  });
});

describe('isPipelineEvent', () => {
  const view: EventScope = {
    project: { id: 'p1' },
    scenes: [
      {
        id: 's1',
        generationId: 'g1',
        visual: { assetId: 'a1' },
        lines: { uk: { id: 'l1' }, en: { id: 'l2' } },
      },
      { id: 's2', generationId: null, visual: null, lines: {} },
    ],
  };

  it('isPipelineEvent matches sceneId, lineId and projectId of this project only', () => {
    expect(isPipelineEvent({ subject: { projectId: 'p1' } }, view)).toBe(true);
    expect(isPipelineEvent({ subject: { sceneId: 's2' } }, view)).toBe(true);
    expect(isPipelineEvent({ subject: { lineId: 'l2' } }, view)).toBe(true);
    expect(isPipelineEvent({ subject: { projectId: 'p2' } }, view)).toBe(false);
    expect(isPipelineEvent({ subject: { sceneId: 'other' } }, view)).toBe(false);
    expect(isPipelineEvent({ subject: { lineId: 'other' } }, view)).toBe(false);
    expect(isPipelineEvent({ subject: {} }, view)).toBe(false);
  });

  it('matches the generation and visual asset of a scene', () => {
    expect(isPipelineEvent({ subject: { generationId: 'g1' } }, view)).toBe(true);
    expect(isPipelineEvent({ subject: { assetId: 'a1' } }, view)).toBe(true);
    expect(isPipelineEvent({ subject: { generationId: 'g2' } }, view)).toBe(false);
    expect(isPipelineEvent({ subject: { assetId: 'a2' } }, view)).toBe(false);
  });

  it('before the first load matches only the project id', () => {
    expect(isPipelineEvent({ subject: { projectId: 'p1' } }, undefined, 'p1')).toBe(true);
    expect(isPipelineEvent({ subject: { sceneId: 's1' } }, undefined, 'p1')).toBe(false);
  });
});

describe('justFinished', () => {
  it('is true only for the first transition of a live run into done', () => {
    expect(justFinished(run('assemble', 'running'), run('done', 'done'))).toBe(true);
    expect(justFinished(run('produce', 'running'), run('done', 'done'))).toBe(true);
    expect(justFinished(undefined, run('done', 'done'))).toBe(false);
    expect(justFinished(run('done', 'done'), run('done', 'done'))).toBe(false);
    expect(justFinished(run('assemble', 'running'), run('assemble', 'failed'))).toBe(false);
  });
});
