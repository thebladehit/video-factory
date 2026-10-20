import { run, type MediaTools } from './ffmpeg';

export const PEAKS_PER_SECOND = 100;
const RATE = 8000;
const WINDOW = RATE / PEAKS_PER_SECOND;

/**
 * Піки хвилі: моно 8 кГц f32le з ffmpeg потоком → max|x| у вікнах по 80 семплів → 0..255.
 * Буферизується лише результат (100 байт на секунду), не PCM.
 */
export async function peaks(
  tools: MediaTools,
  path: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const out: number[] = [];
  let carry = Buffer.alloc(0);
  let max = 0;
  let n = 0;
  const flush = () => {
    out.push(Math.round(Math.min(1, max) * 255));
    max = 0;
    n = 0;
  };
  await run(
    tools.ffmpegPath,
    ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'],
    {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 600_000,
      onStdout(chunk) {
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const whole = buf.length - (buf.length % 4);
        for (let i = 0; i < whole; i += 4) {
          const v = Math.abs(buf.readFloatLE(i));
          if (v > max) max = v;
          if (++n === WINDOW) flush();
        }
        carry = Buffer.from(buf.subarray(whole));
      },
    },
  );
  if (n > 0) flush();
  return Uint8Array.from(out);
}
