import { AppError } from '@vf/shared';
import { run, type MediaTools } from './ffmpeg';

export interface MediaProbe {
  kind: 'image' | 'video' | 'audio';
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  nb_frames?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}
interface FfProbe {
  streams?: FfStream[];
  format?: { format_name?: string; duration?: string; tags?: { major_brand?: string } };
}

const UNREADABLE = 'Не вдалося прочитати файл (пошкоджений або непідтримуваний формат)';
const IMAGE_CODECS: Record<string, string> = {
  png: 'image/png',
  mjpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function videoMime(format: string, brand: string | undefined): string {
  if (format.includes('webm') || format.includes('matroska')) return 'video/webm';
  if (format.includes('mov') && brand?.trim() === 'qt') return 'video/quicktime';
  return 'video/mp4';
}

function audioMime(format: string, codec: string | undefined): string {
  if (format === 'mp3' || codec === 'mp3') return 'audio/mpeg';
  if (format === 'wav') return 'audio/wav';
  if (format === 'ogg') return 'audio/ogg';
  if (format.includes('mp4') || format.includes('mov')) return 'audio/mp4';
  return `audio/${format.split(',')[0]}`;
}

const rotation = (s: FfStream) => {
  const r = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(s.tags?.rotate ?? 0);
  return Math.abs(r) % 180 === 90;
};

/** Метадані файлу через ffprobe. Розміри — відображувані (з урахуванням повороту відео з телефона). */
export async function probe(tools: MediaTools, path: string, opts: { signal?: AbortSignal } = {}): Promise<MediaProbe> {
  let info: FfProbe;
  try {
    const { stdout } = await run(
      tools.ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      opts,
    );
    info = JSON.parse(stdout.toString()) as FfProbe;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e;
    if (opts.signal?.aborted) throw e;
    throw new AppError('VALIDATION', UNREADABLE, { cause: (e as Error).message });
  }
  const format = info.format?.format_name ?? '';
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const seconds = Number(info.format?.duration);
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;

  if (
    video?.codec_name &&
    IMAGE_CODECS[video.codec_name] &&
    (format.endsWith('_pipe') || format === 'gif' || format === 'image2')
  ) {
    return { kind: 'image', mime: IMAGE_CODECS[video.codec_name]!, width: video.width, height: video.height };
  }
  if (video && video.width && video.height) {
    const swap = rotation(video);
    return {
      kind: 'video',
      mime: videoMime(format, info.format?.tags?.major_brand),
      width: swap ? video.height : video.width,
      height: swap ? video.width : video.height,
      durationMs,
    };
  }
  if (audio) return { kind: 'audio', mime: audioMime(format, audio.codec_name), durationMs };
  throw new AppError('VALIDATION', UNREADABLE);
}
