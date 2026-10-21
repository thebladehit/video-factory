import { AppError, type AudioRole, type TimelineDoc } from '@vf/shared';
import { audioPlan, docDuration, num } from '@vf/timeline';
import { audioMix, soundRoles } from './compile-audio';
import type { Compiled, SourceInfo } from './types';

/**
 * Мікс звуків заданих ролей для розпізнавання мовлення: моно 16 кГц, Opus 32 кбіт/с у WebM, без відео.
 * Роль `original` включає власний звук відео-кліпів (`volume > 0`). Тривалість — `docDuration`.
 */
export function compileAudioOnly(input: {
  doc: TimelineDoc;
  sources: Map<string, SourceInfo>;
  roles: AudioRole[];
  outPath: string;
  filterScriptPath: string;
}): Compiled {
  const { doc, sources } = input;
  const T = Math.max(docDuration(doc), 1 / doc.fps);
  const roles = soundRoles(doc);
  const sounds = audioPlan(doc).filter((a) => input.roles.includes(roles.get(a.clipId)!));
  const missing = sounds.filter((a) => !sources.has(a.assetId)).map((a) => a.clipId);
  if (missing.length) throw new AppError('VALIDATION', 'Деякі файли проєкту недоступні', { clipIds: missing });
  const mix = audioMix(doc, sounds, sources, T, 0);
  return {
    args: [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-nostats',
      '-progress',
      'pipe:1',
      ...mix.args,
      '-filter_complex_script',
      input.filterScriptPath,
      '-map',
      '[aout]',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-t',
      num(T),
      '-f',
      'webm',
      input.outPath,
    ],
    filterScript: mix.graph.join(';\n') + '\n',
    durationSec: T,
    width: 0,
    height: 0,
  };
}
