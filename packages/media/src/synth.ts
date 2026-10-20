import { readFile, rm, writeFile } from 'node:fs/promises';
import { run, type MediaTools } from './ffmpeg';

/** Синус амплітудою 0.5 (пік ≈ 128 з 255 у піках хвилі). */
const toneSource = (hz: number, durationSec: number) => `aevalsrc=0.5*sin(2*PI*${hz}*t):s=48000:d=${durationSec}`;

/** Синтетичні медіафайли — для фікстур тестів і fake-провайдера. */
export async function synthImage(
  tools: MediaTools,
  out: string,
  o: {
    width: number;
    height: number;
    color: string;
    format: 'png' | 'jpg';
    /** права половина іншим кольором (щоб було видно поворот) */
    rightColor?: string;
    /** EXIF Orientation для JPEG (як у фото з телефона) */
    orientation?: number;
  },
): Promise<void> {
  const half = Math.floor(o.width / 2);
  await run(tools.ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    o.rightColor
      ? `color=c=${o.color}:s=${o.width}x${o.height},drawbox=x=${half}:y=0:w=${o.width - half}:h=${o.height}:color=${o.rightColor}:t=fill`
      : `color=c=${o.color}:s=${o.width}x${o.height}`,
    '-frames:v',
    '1',
    ...(o.format === 'jpg' ? ['-c:v', 'mjpeg'] : []),
    out,
  ]);
  if (o.orientation && o.format === 'jpg')
    await writeFile(out, withExifOrientation(await readFile(out), o.orientation));
}

/** JPEG + сегмент APP1 Exif з одним тегом Orientation (big-endian TIFF). */
function withExifOrientation(jpg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const len = payload.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]), payload]);
  return Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
}

export async function synthVideo(
  tools: MediaTools,
  out: string,
  o: { width: number; height: number; durationSec: number; color: string; rotate?: 90; tone?: number },
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
    ...(o.tone
      ? ['-f', 'lavfi', '-i', toneSource(o.tone, o.durationSec), '-c:a', 'aac', '-b:a', '128k', '-shortest']
      : []),
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
  o: { durationSec: number; format: 'mp3' | 'wav'; tone?: number },
): Promise<void> {
  await run(tools.ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    o.tone ? toneSource(o.tone, o.durationSec) : `sine=frequency=440:duration=${o.durationSec}`,
    ...(o.format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '64k'] : []),
    out,
  ]);
}
