import { num, type AudioItem } from '@vf/timeline';

/** Ланцюг одного звуку: вхід `[n:a]` → 48 кГц стерео, гучність, fade, зсув на старт кліпу. */
export function audioChain(item: AudioItem, input: number, label: string, channels?: number): string {
  const D = item.duration;
  const steps = [
    // swr міксує моно в стерео з −3 дБ, а Web Audio у прев'ю — на повну: дублюємо канал явно
    ...(channels === 1 ? ['pan=stereo|c0=c0|c1=c0'] : []),
    'aresample=48000',
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    'asetpts=PTS-STARTPTS',
    `atrim=duration=${num(D)}`,
    `volume=${num(item.volume)}`,
    ...(item.fadeIn > 0 ? [`afade=t=in:st=0:d=${num(Math.min(item.fadeIn, D))}`] : []),
    ...(item.fadeOut > 0
      ? [`afade=t=out:st=${num(Math.max(0, D - item.fadeOut))}:d=${num(Math.min(item.fadeOut, D))}`]
      : []),
    `adelay=${Math.round(item.start * 1000)}:all=1`,
  ];
  return `[${input}:a]${steps.join(',')}[${label}]`;
}
