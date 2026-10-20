import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_MEDIUM } from 'mediabunny';
import { Asset, uid } from './model';

// Генеруємо тестові "AI-картинки" та одне тестове відео прямо в браузері,
// щоб демо працювало без файлів. Свої фото/відео можна перетягнути в бібліотеку.

const PALETTE = [
  ['#ff6b6b', '#5f27cd', 'Сцена 1 · Хук'],
  ['#1dd1a1', '#0a3d62', 'Сцена 2 · Проблема'],
  ['#feca57', '#c44569', 'Сцена 3 · Рішення'],
  ['#48dbfb', '#341f97', 'Сцена 4 · CTA'],
];

function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number, a: string, b: string, label: string, phase = 0) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 14; i++) {
    const x = (Math.sin(i * 1.7 + phase) * 0.5 + 0.5) * w;
    const y = (Math.cos(i * 2.3 + phase * 0.7) * 0.5 + 0.5) * h;
    ctx.fillStyle = `rgba(255,255,255,${0.06 + (i % 4) * 0.03})`;
    ctx.beginPath();
    ctx.arc(x, y, 40 + (i % 5) * 35, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `800 ${Math.round(w / 16)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  const [l1, l2] = label.split(' · ');
  ctx.fillText(l1, w / 2, h / 2 - w / 30);
  if (l2) ctx.fillText(l2, w / 2, h / 2 + w / 20);
}

export async function makeSampleImages(): Promise<Asset[]> {
  const size = 1280;
  const out: Asset[] = [];
  for (const [a, b, label] of PALETTE) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    drawScene(c.getContext('2d')!, size, size, a, b, label);
    const blob = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), 'image/jpeg', 0.9));
    out.push({ id: uid(), kind: 'image', name: `${label}.jpg`, url: URL.createObjectURL(blob), duration: Infinity, width: size, height: size });
  }
  return out;
}

// Тестове відео 6 с кодуємо через WebCodecs (Mediabunny) — це той самий механізм, що й у демо C.
export async function makeSampleVideo(): Promise<Asset> {
  const w = 1280, h = 720, fps = 30, dur = 6;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const src = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_MEDIUM });
  output.addVideoTrack(src, { frameRate: fps });
  await output.start();
  for (let i = 0; i < fps * dur; i++) {
    const t = i / fps;
    drawScene(ctx, w, h, '#0f2027', '#2c5364', '', t * 1.5);
    ctx.fillStyle = 'white';
    ctx.font = '800 90px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Відео-кліп  ${t.toFixed(1)}s`, w / 2, h / 2 + 30);
    ctx.fillStyle = '#feca57';
    ctx.fillRect(0, h - 24, (w * t) / dur, 24);
    await src.add(t, 1 / fps);
  }
  await output.finalize();
  const blob = new Blob([output.target.buffer!], { type: 'video/mp4' });
  return { id: uid(), kind: 'video', name: 'stock-clip.mp4', url: URL.createObjectURL(blob), duration: dur, width: w, height: h };
}

export async function assetFromFile(file: File): Promise<Asset | null> {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('image/')) {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { id: uid(), kind: 'image', name: file.name, url, duration: Infinity, width: img.naturalWidth, height: img.naturalHeight };
  }
  if (file.type.startsWith('video/')) {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = j; });
    return { id: uid(), kind: 'video', name: file.name, url, duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  }
  return null;
}
