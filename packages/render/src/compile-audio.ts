import type { AudioRole, TimelineDoc } from '@vf/shared';
import { num, type AudioItem } from '@vf/timeline';
import type { SourceInfo } from './types';

type Envelope = { t: number; gain: number }[];

/**
 * Гучність `volume × envelope(t − start)` виразом ffmpeg (для `volume=…:eval=frame`): кусково-лінійна
 * інтерполяція між точками як сума відрізків `нахил × (clamp(t, tᵢ, tᵢ₊₁) − tᵢ)`; до першої точки й після
 * останньої — їхній множник. Лише `+ - * / min max`, тож вираз перевіряється `evalExpr`.
 */
export function envelopeExpr(volume: number, env: Envelope, start: number): string {
  if (!env.length) return num(volume);
  const t = start ? `(t-${num(start)})` : 't';
  const parts = [num(env[0]!.gain)];
  for (let i = 1; i < env.length; i++) {
    const a = env[i - 1]!;
    const b = env[i]!;
    if (b.gain === a.gain || b.t <= a.t) continue;
    const slope = (b.gain - a.gain) / (b.t - a.t);
    parts.push(`${num(slope)}*(min(max(${t},${num(a.t)}),${num(b.t)})-${num(a.t)})`);
  }
  return `${num(volume)}*(${parts.join('+')})`;
}

/**
 * Ланцюг одного звуку: вхід `[n:a]` → 48 кГц стерео, темп/тиша в кінці, гучність з огинаючою, fade,
 * зсув на старт кліпу. Вхід уже обрізано до `(duration − hold) × speed` с джерела (`-ss/-t`).
 * `tempo: false` — для голосу озвучки: він ніколи не прискорюється.
 */
export function audioChain(
  item: AudioItem,
  input: number,
  label: string,
  channels?: number,
  opts: { tempo: boolean } = { tempo: true },
): string {
  const D = item.duration;
  const speed = opts.tempo ? item.speed : 1;
  const hold = item.hold;
  const steps = [
    // swr міксує моно в стерео з −3 дБ, а Web Audio у прев'ю — на повну: дублюємо канал явно
    ...(channels === 1 ? ['pan=stereo|c0=c0|c1=c0'] : []),
    'aresample=48000',
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    'asetpts=PTS-STARTPTS',
    `atrim=duration=${num(sourceSpan(item, speed))}`,
    // 0,8–1,25 — у межах одного atempo
    ...(speed !== 1 ? [`atempo=${num(speed)}`] : []),
    ...(hold > 0 ? [`apad=pad_dur=${num(hold)}`] : []),
    ...(speed !== 1 || hold > 0 ? [`atrim=duration=${num(D)}`] : []),
    item.envelope.length
      ? `volume='${envelopeExpr(item.volume, item.envelope, 0)}':eval=frame`
      : `volume=${num(item.volume)}`,
    ...(item.fadeIn > 0 ? [`afade=t=in:st=0:d=${num(Math.min(item.fadeIn, D))}`] : []),
    ...(item.fadeOut > 0
      ? [`afade=t=out:st=${num(Math.max(0, D - item.fadeOut))}:d=${num(Math.min(item.fadeOut, D))}`]
      : []),
    `adelay=${Math.round(item.start * 1000)}:all=1`,
  ];
  return `[${input}:a]${steps.join(',')}[${label}]`;
}

/** Скільки секунд джерела звучить: `(duration − hold) × speed`. */
export function sourceSpan(clip: { duration: number; hold?: number }, speed: number): number {
  return Math.max(0, clip.duration - (clip.hold ?? 0)) * speed;
}

/** Роль звуку за id кліпу; власний звук відео-кліпів — `original`. */
export function soundRoles(doc: TimelineDoc): Map<string, AudioRole> {
  const out = new Map<string, AudioRole>();
  for (const track of doc.tracks)
    if (track.kind === 'audio') for (const c of track.clips) out.set(c.id, track.role);
    else if (track.kind === 'video') for (const c of track.clips) out.set(c.id, 'original');
  return out;
}

/**
 * Входи й граф міксу звуків `[aout]`: тиша на всю тривалість `T` + `amix normalize=0`.
 * Звуки без аудіопотоку в джерелі пропускаються (тиша, а не «Stream specifier ':a' matches no streams»).
 */
export function audioMix(
  doc: TimelineDoc,
  sounds: AudioItem[],
  sources: Map<string, SourceInfo>,
  T: number,
  firstInput: number,
): { args: string[]; graph: string[] } {
  const roles = soundRoles(doc);
  const audible = sounds.filter((a) => sources.get(a.assetId)?.hasAudio);
  const silence = `anullsrc=r=48000:cl=stereo,atrim=duration=${num(T)}`;
  if (!audible.length) return { args: [], graph: [`${silence}[aout]`] };
  const args: string[] = [];
  const graph: string[] = [];
  audible.forEach((item, i) => {
    const src = sources.get(item.assetId)!;
    const tempo = roles.get(item.clipId) !== 'voiceover';
    args.push('-ss', num(item.in), '-t', num(sourceSpan(item, tempo ? item.speed : 1)), '-i', src.path);
    graph.push(audioChain(item, firstInput + i, `a${i}`, src.audioChannels, { tempo }));
  });
  graph.push(`${silence}[asil]`);
  graph.push(
    `[asil]${audible.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audible.length + 1}:normalize=0:duration=first[aout]`,
  );
  return { args, graph };
}
