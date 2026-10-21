import type { VOICE_LINE_STATUSES } from '@vf/db';
import type { AssetStatus, JobStatus, PipelineStage, PipelineStatus, SceneStatus } from '@vf/shared';

type VoiceLineStatus = (typeof VOICE_LINE_STATUSES)[number];

export interface SceneSnap {
  id: string;
  status: SceneStatus;
  hasVisual: boolean;
  generation: { status: JobStatus; assetId: string | null; assetStatus: AssetStatus | null } | null;
}

export interface LangSnap {
  language: string;
  isBase: boolean;
  translate: 'none' | 'live' | 'done' | 'failed';
  lines: { status: VoiceLineStatus; hasText: boolean }[];
}

export interface RunSnap {
  stage: PipelineStage;
  status: PipelineStatus;
  stopAfterScript: boolean;
  scriptJob: JobStatus | null;
  assembleJob: JobStatus | null;
  scenesWritten: boolean;
  scenes: SceneSnap[];
  langs: LangSnap[];
}

export type Action =
  | { type: 'enqueueScript' }
  | { type: 'toReview' }
  | { type: 'toProduce' }
  | { type: 'enqueueVisual'; sceneId: string }
  | { type: 'linkGenerated'; sceneId: string; assetId: string }
  | { type: 'sceneReady'; sceneId: string }
  | { type: 'sceneFailed'; sceneId: string; error: string }
  | { type: 'enqueueTranslate'; language: string }
  | { type: 'enqueueSynthesize'; language: string }
  | { type: 'enqueueAssemble' }
  | { type: 'markDone' }
  | { type: 'markFailed'; error: string };

// Загальні тексти; runAdvance підставляє справжню помилку задачі/генерації з БД, якщо вона є
export const SCRIPT_FAILED = 'Не вдалося створити сценарій';
export const VISUAL_FAILED = 'Не вдалося згенерувати візуал';
export const ASSEMBLE_FAILED = 'Не вдалося зібрати відео';

/** Чиста машина станів запуску: знімок → дії. Порядок дій стабільний: етап, сцени, мови (за порядком масивів) */
export function advance(s: RunSnap): Action[] {
  if (s.status !== 'running') return [];
  switch (s.stage) {
    case 'script':
      return script(s);
    case 'produce':
      return produce(s);
    case 'assemble':
      if (s.assembleJob === 'done') return [{ type: 'markDone' }];
      if (s.assembleJob === 'failed') return [{ type: 'markFailed', error: ASSEMBLE_FAILED }];
      return [];
    default:
      return [];
  }
}

function script(s: RunSnap): Action[] {
  if (s.scriptJob === null) return [{ type: 'enqueueScript' }];
  if (s.scriptJob === 'failed') return [{ type: 'markFailed', error: SCRIPT_FAILED }];
  if (s.scriptJob === 'done' && s.scenesWritten) return [{ type: s.stopAfterScript ? 'toReview' : 'toProduce' }];
  return [];
}

function produce(s: RunSnap): Action[] {
  const actions: Action[] = [];
  let scenesTerminal = true;

  for (const sc of s.scenes) {
    if (sc.status === 'ready' || sc.status === 'failed') continue;
    scenesTerminal = false;
    if (sc.status === 'empty') {
      actions.push({ type: 'enqueueVisual', sceneId: sc.id });
      continue;
    }
    // queued | running: після скасування/відновлення генерація могла вже завершитись
    const g = sc.generation;
    if (!g) continue;
    if (g.status === 'failed' || g.status === 'cancelled' || g.assetStatus === 'failed') {
      actions.push({ type: 'sceneFailed', sceneId: sc.id, error: VISUAL_FAILED });
      continue;
    }
    let linked = sc.hasVisual;
    if (g.status === 'done' && g.assetId && !linked) {
      actions.push({ type: 'linkGenerated', sceneId: sc.id, assetId: g.assetId });
      linked = true;
    }
    // asset уже ready — окремої події не буде, тож готовність сцени — в тому ж проході
    if (linked && g.assetStatus === 'ready') actions.push({ type: 'sceneReady', sceneId: sc.id });
  }

  let langsTerminal = true;
  for (const l of s.langs) {
    if (l.lines.some((ln) => ln.status === 'queued' || ln.status === 'running')) langsTerminal = false;
    const translated = l.isBase || l.translate === 'done';
    if (!l.isBase && (l.translate === 'none' || l.translate === 'live')) langsTerminal = false;
    if (!l.isBase && l.translate === 'none') {
      actions.push({ type: 'enqueueTranslate', language: l.language });
    } else if (translated && l.lines.some((ln) => ln.status === 'empty' && ln.hasText)) {
      actions.push({ type: 'enqueueSynthesize', language: l.language });
    }
  }

  // Збірка — лише коли в цьому проході більше нічого не запускається
  if (actions.length === 0 && scenesTerminal && langsTerminal && s.assembleJob === null) {
    actions.push({ type: 'enqueueAssemble' });
  }
  return actions;
}
