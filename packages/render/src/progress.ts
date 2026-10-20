/** Прогрес ffmpeg (`-progress pipe:1`, рядки `key=value`) → 0..100 за `out_time_us`; null — у фрагменті немає часу. */
export function parseProgress(chunk: string, durationSec: number): number | null {
  let pct: number | null = null;
  for (const line of chunk.split('\n')) {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
    if (m) pct = Math.min(100, (Number(m[1]) / 1e6 / Math.max(durationSec, 1e-6)) * 100);
    else if (line.trim() === 'progress=end') pct = 100;
  }
  return pct;
}
