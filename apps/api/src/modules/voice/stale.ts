import { createHash } from 'node:crypto';
import type { VoiceChoice } from '@vf/shared';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Хеш тексту (для `source_hash`: на який базовий текст зроблено переклад). */
export const textHash = (text: string): string => sha1(text);

/** Хеш `текст + голос` (для `voiced_hash`: з чим озвучено рядок). */
export const voicedHash = (text: string, voice: VoiceChoice): string =>
  sha1(JSON.stringify([text, voice.model, voice.voiceId, voice.instructions ?? '']));

export type LineState = 'empty' | 'queued' | 'running' | 'ready' | 'failed' | 'stale';

export interface LineFacts {
  text: string;
  status: 'empty' | 'queued' | 'running' | 'ready' | 'failed';
  voice: VoiceChoice | null;
  voicedHash: string | null;
  sourceHash: string | null;
  audioAssetId: string | null;
}

/** Переклад застарів: базовий текст змінено після перекладу (`source_hash` ≠ хешу поточного базового тексту). */
export const translationStale = (line: Pick<LineFacts, 'sourceHash'>, baseText: string | undefined): boolean =>
  !!line.sourceHash && baseText !== undefined && line.sourceHash !== textHash(baseText);

/**
 * Обчислюваний стан рядка. `ready` стає `stale`, якщо текст чи голос змінено після озвучки
 * (`currentVoice` — голос мови зараз; без нього береться голос, яким озвучено) або базовий текст змінено після перекладу.
 * Видалений файл озвучки → `empty`.
 */
export function lineState(line: LineFacts, baseText: string | undefined, currentVoice?: VoiceChoice | null): LineState {
  if (line.status !== 'ready') return line.status;
  if (!line.audioAssetId) return 'empty';
  const voice = currentVoice ?? line.voice;
  if (voice && line.voicedHash !== voicedHash(line.text, voice)) return 'stale';
  if (translationStale(line, baseText)) return 'stale';
  return 'ready';
}
