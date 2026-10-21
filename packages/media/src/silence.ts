import { run, type MediaTools } from './ffmpeg';
import { probe } from './probe';

/**
 * Інтервали мовлення = доповнення до інтервалів тиші `silencedetect` (за замовчуванням −35 dB, ≥ 0,2 с).
 * Мітки тиші йдуть у stdout через `ametadata` (stderr ffmpeg обрізається `run` до хвоста).
 */
export async function speechIntervals(
  tools: MediaTools,
  path: string,
  opts: { signal?: AbortSignal; noiseDb?: number; minSilence?: number } = {},
): Promise<{ startMs: number; endMs: number }[]> {
  const noise = opts.noiseDb ?? -35;
  const minSilence = opts.minSilence ?? 0.2;
  const durationMs = (await probe(tools, path)).durationMs ?? 0;
  let text = '';
  await run(
    tools.ffmpegPath,
    [
      '-v',
      'error',
      '-i',
      path,
      '-vn',
      '-af',
      `silencedetect=noise=${noise}dB:d=${minSilence},ametadata=mode=print:file=-`,
      '-f',
      'null',
      '-',
    ],
    { signal: opts.signal, timeoutMs: 600_000, onStdout: (c) => (text += c.toString()) },
  );

  const silences: { startMs: number; endMs: number }[] = [];
  let open: number | null = null;
  for (const m of text.matchAll(/lavfi\.silence_(start|end)=(-?[\d.]+)/g)) {
    const ms = Math.round(Number(m[2]) * 1000);
    if (m[1] === 'start') open = Math.max(0, ms);
    else if (open !== null) {
      silences.push({ startMs: open, endMs: ms });
      open = null;
    } else silences.push({ startMs: 0, endMs: ms });
  }
  if (open !== null) silences.push({ startMs: open, endMs: Math.max(open, durationMs) });

  const speech: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.startMs > cursor) speech.push({ startMs: cursor, endMs: s.startMs });
    cursor = Math.max(cursor, s.endMs);
  }
  if (durationMs > cursor) speech.push({ startMs: cursor, endMs: durationMs });
  return speech;
}
