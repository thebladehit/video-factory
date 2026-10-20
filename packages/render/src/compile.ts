import { AppError, type MediaClip, type TimelineDoc } from '@vf/shared';
import { audioPlan, docDuration, num } from '@vf/timeline';
import { audioChain } from './compile-audio';
import { clipChain } from './compile-video';
import type { CompileInput, Compiled, Preset, Size } from './types';

const DRAFT_LONG_SIDE = 1280;
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** `final` — розмір документа; `draft` — довша сторона 1280, обидві сторони парні. */
export function outputSize(doc: TimelineDoc, preset: Preset): Size {
  if (preset === 'final') return { width: even(doc.width), height: even(doc.height) };
  const k = DRAFT_LONG_SIDE / Math.max(doc.width, doc.height);
  return { width: even(doc.width * k), height: even(doc.height * k) };
}

const ENCODE: Record<Preset, string[]> = {
  final: ['-preset', 'medium', '-crf', '20'],
  draft: ['-preset', 'veryfast', '-crf', '26'],
};

/**
 * Таймлайн → аргументи ffmpeg і граф фільтрів (пишеться у файл: довгі проєкти не влазять у командний рядок).
 * Відео: чорне полотно + по шару на кліп (overlay з enable). Аудіо: тиша на всю тривалість + amix звуків.
 */
export function compileFfmpeg(input: CompileInput): Compiled {
  const { doc, preset, sources } = input;
  const { width, height } = outputSize(doc, preset);
  const fps = doc.fps;
  const T = Math.max(docDuration(doc), 1 / fps);

  const missing: string[] = [];
  const visual: { clip: MediaClip; src: Size & { kind: 'image' | 'video'; path: string } }[] = [];
  for (const track of doc.tracks) {
    if (track.kind === 'video') {
      for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
        const s = sources.get(clip.assetId);
        if (!s || s.kind === 'audio' || !s.width || !s.height) missing.push(clip.id);
        else visual.push({ clip, src: { kind: s.kind, path: s.path, width: s.width, height: s.height } });
      }
    } else if (track.kind === 'audio') {
      for (const clip of track.clips) if (!sources.has(clip.assetId)) missing.push(clip.id);
    }
  }
  if (missing.length) throw new AppError('VALIDATION', 'Деякі файли проєкту недоступні', { clipIds: missing });

  const args: string[] = [];
  const graph: string[] = [`color=c=black:s=${width}x${height}:r=${fps}:d=${num(T)},format=yuv420p[base]`];
  let n = 0;
  let last = 'base';
  visual.forEach(({ clip, src }, i) => {
    if (src.kind === 'image')
      args.push('-loop', '1', '-framerate', String(fps), '-t', num(clip.duration), '-i', src.path);
    else args.push('-ss', num(clip.in), '-t', num(clip.duration), '-i', src.path);
    const { chain, overlay } = clipChain(clip, n++, `v${i}`, src, { width, height }, fps);
    graph.push(chain, `[${last}][v${i}]${overlay}[o${i}]`);
    last = `o${i}`;
  });
  graph.push(`[${last}]format=yuv420p[vout]`);

  // звук відео без аудіопотоку — тиша, а не «Stream specifier ':a' matches no streams»
  const sounds = audioPlan(doc).filter((a) => sources.get(a.assetId)?.hasAudio);
  const silence = `anullsrc=r=48000:cl=stereo,atrim=duration=${num(T)}`;
  if (!sounds.length) graph.push(`${silence}[aout]`);
  else {
    sounds.forEach((item, i) => {
      args.push('-ss', num(item.in), '-t', num(item.duration), '-i', sources.get(item.assetId)!.path);
      graph.push(audioChain(item, n++, `a${i}`));
    });
    graph.push(`${silence}[asil]`);
    graph.push(
      `[asil]${sounds.map((_, i) => `[a${i}]`).join('')}amix=inputs=${sounds.length + 1}:normalize=0:duration=first[aout]`,
    );
  }

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
      ...args,
      '-filter_complex_script',
      input.filterScriptPath,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-c:v',
      'libx264',
      ...ENCODE[preset],
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-t',
      num(T),
      '-movflags',
      '+faststart',
      input.outPath,
    ],
    filterScript: graph.join(';\n') + '\n',
    durationSec: T,
    width,
    height,
  };
}
