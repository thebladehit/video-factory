import { useEffect, useRef, useState } from 'react';

const PEAKS_PER_SECOND = 100;
const MAX_CANVAS = 8000;
const cache = new Map<string, Promise<Uint8Array | null>>();

/** Піки (Uint8, 100/с) за URL; кеш на час сторінки. */
function loadPeaks(url: string): Promise<Uint8Array | null> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? new Uint8Array(b) : null))
      .catch(() => null);
    cache.set(url, p);
  }
  return p;
}

/** Хвиля звуку кліпу: ділянка джерела [in, in + duration] на ширину кліпу. */
export function Waveform({
  peaksUrl,
  sourceIn,
  duration,
  width,
  height,
}: {
  peaksUrl: string | null;
  sourceIn: number;
  duration: number;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Uint8Array | null>(null);
  useEffect(() => {
    let alive = true;
    if (peaksUrl) void loadPeaks(peaksUrl).then((p) => alive && setPeaks(p));
    return () => {
      alive = false;
    };
  }, [peaksUrl]);

  const w = Math.max(1, Math.min(MAX_CANVAS, Math.round(width)));
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    if (!peaks) return;
    g.fillStyle = 'rgba(255,255,255,0.85)';
    const mid = c.height / 2;
    for (let x = 0; x < c.width; x++) {
      const from = Math.floor((sourceIn + (x / c.width) * duration) * PEAKS_PER_SECOND);
      const to = Math.max(from + 1, Math.floor((sourceIn + ((x + 1) / c.width) * duration) * PEAKS_PER_SECOND));
      let v = 0;
      for (let i = from; i < to && i < peaks.length; i++) v = Math.max(v, peaks[i]!);
      const h = Math.max(1, (v / 255) * (c.height - 2));
      g.fillRect(x, mid - h / 2, 1, h);
    }
  }, [peaks, sourceIn, duration, w, height]);

  return (
    <canvas
      ref={ref}
      data-testid="waveform"
      width={w}
      height={height}
      className="pointer-events-none absolute inset-0 size-full"
    />
  );
}
