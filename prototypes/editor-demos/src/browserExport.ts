import { ALL_FORMATS, BufferTarget, CanvasSink, CanvasSource, Input, Mp4OutputFormat, Output, QUALITY_HIGH, UrlSource, WrappedCanvas } from 'mediabunny';
import { Project, projectDuration } from './model';
import { drawFrame } from './canvasRender';

// Демо C: рендер повністю в браузері через WebCodecs (бібліотека Mediabunny).
// Для кожного кадру: декодуємо потрібні кадри джерел → малюємо тією ж drawFrame() → кодуємо в H.264 → MP4.
// Сервер не потрібен, але швидкість залежить від пристрою користувача, і вкладку не можна закривати.

export async function exportInBrowser(p: Project, scale: number, onProgress: (x: number) => void): Promise<Blob> {
  const W = Math.round(p.width * scale), H = Math.round(p.height * scale);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingQuality = 'high';

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: p.fps });
  await output.start();

  // картинки — просто ImageBitmap
  const bitmaps = new Map<string, ImageBitmap>();
  for (const a of p.assets.filter((a) => a.kind === 'image')) {
    bitmaps.set(a.id, await createImageBitmap(await (await fetch(a.url)).blob()));
  }

  // для кожного відео-кліпу — ітератор декодованих кадрів у потрібні моменти джерела
  const total = projectDuration(p);
  const frames = Math.ceil(total * p.fps);
  const iters = new Map<string, AsyncGenerator<WrappedCanvas | null>>();
  const current = new Map<string, CanvasImageSource>();
  for (const c of p.clips.filter((c) => c.track === 'media')) {
    const a = p.assets.find((x) => x.id === c.assetId);
    if (a?.kind !== 'video') continue;
    const input = new Input({ source: new UrlSource(a.url), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) continue;
    const sink = new CanvasSink(track, { width: Math.min(a.width, W * 2), poolSize: 2 });
    const ts: number[] = [];
    for (let i = 0; i < frames; i++) {
      const t = i / p.fps;
      if (t >= c.start && t < c.start + c.duration) ts.push(t - c.start + c.in);
    }
    iters.set(c.id, sink.canvasesAtTimestamps(ts));
  }

  for (let i = 0; i < frames; i++) {
    const t = i / p.fps;
    for (const c of p.clips) {
      const it = iters.get(c.id);
      if (it && t >= c.start && t < c.start + c.duration) {
        const r = await it.next();
        if (!r.done && r.value) current.set(c.id, r.value.canvas as CanvasImageSource);
      }
    }
    drawFrame(ctx, p, t, (clip, asset) => asset.kind === 'image' ? bitmaps.get(asset.id) ?? null : current.get(clip.id) ?? null);
    await source.add(t, 1 / p.fps);
    if (i % 5 === 0) onProgress(i / frames);
  }
  await output.finalize();
  onProgress(1);
  return new Blob([output.target.buffer!], { type: 'video/mp4' });
}
