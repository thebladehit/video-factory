import { run, type MediaTools } from './ffmpeg';

/** Вирізка [startMs, endMs) аудіофайлу в wav (ffmpeg `atrim`, відлік з нуля). */
export async function cutAudio(
  tools: MediaTools,
  inPath: string,
  outPath: string,
  startMs: number,
  endMs: number,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const s = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);
  await run(
    tools.ffmpegPath,
    [
      '-v',
      'error',
      '-y',
      '-i',
      inPath,
      '-vn',
      '-af',
      `atrim=start=${s(startMs)}:end=${s(endMs)},asetpts=PTS-STARTPTS`,
      '-c:a',
      'pcm_s16le',
      outPath,
    ],
    { signal: opts.signal, timeoutMs: 120_000 },
  );
}
