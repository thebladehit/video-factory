import { run, type MediaTools } from './ffmpeg';
import type { MediaProbe } from './probe';

const MAX_SIDE = 512;

/** Мініатюра WebP, довша сторона ≤ 512 px (без збільшення); для відео — кадр на ~10% тривалості. */
export async function thumbnail(
  tools: MediaTools,
  input: string,
  output: string,
  { kind, durationMs, signal }: { kind: MediaProbe['kind']; durationMs?: number; signal?: AbortSignal },
): Promise<void> {
  const seek = kind === 'video' && durationMs ? ['-ss', ((durationMs * 0.1) / 1000).toFixed(3)] : [];
  await run(
    tools.ffmpegPath,
    [
      '-v',
      'error',
      '-y',
      ...seek,
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      `scale='min(${MAX_SIDE},iw)':'min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease`,
      '-c:v',
      'libwebp',
      '-quality',
      '80',
      output,
    ],
    { signal },
  );
}
