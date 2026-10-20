import { rm } from 'node:fs/promises';
import { run, type MediaTools } from './ffmpeg';

/** Синтетичні медіафайли — для фікстур тестів і fake-провайдера. */
export async function synthImage(
  tools: MediaTools,
  out: string,
  o: { width: number; height: number; color: string; format: 'png' | 'jpg' },
): Promise<void> {
  await run(tools.ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${o.color}:s=${o.width}x${o.height}`,
    '-frames:v',
    '1',
    ...(o.format === 'jpg' ? ['-c:v', 'mjpeg'] : []),
    out,
  ]);
}

export async function synthVideo(
  tools: MediaTools,
  out: string,
  o: { width: number; height: number; durationSec: number; color: string; rotate?: 90 },
): Promise<void> {
  // ffmpeg 5 записує поворот (як телефон) лише під час копіювання потоку — тому два кроки
  const encoded = o.rotate ? `${out}.raw.mp4` : out;
  await run(tools.ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${o.color}:s=${o.width}x${o.height}:r=25:d=${o.durationSec}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-movflags',
    '+faststart',
    encoded,
  ]);
  if (!o.rotate) return;
  try {
    await run(tools.ffmpegPath, [
      '-v',
      'error',
      '-y',
      '-i',
      encoded,
      '-c',
      'copy',
      '-metadata:s:v:0',
      `rotate=${o.rotate}`,
      out,
    ]);
  } finally {
    await rm(encoded, { force: true });
  }
}

export async function synthAudio(
  tools: MediaTools,
  out: string,
  o: { durationSec: number; format: 'mp3' | 'wav' },
): Promise<void> {
  await run(tools.ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${o.durationSec}`,
    ...(o.format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '64k'] : []),
    out,
  ]);
}
