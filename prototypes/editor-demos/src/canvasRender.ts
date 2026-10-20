import { Asset, Clip, Project, activeClips } from './model';

// Єдина функція "намалювати кадр у момент t". Її використовують і живе прев'ю (демо A),
// і експорт у браузері (демо C). Для серверного рендеру FFmpeg повторює ту саму логіку фільтрами.

export type FrameSource = CanvasImageSource & { width?: number; videoWidth?: number };
export type SourceResolver = (clip: Clip, asset: Asset) => CanvasImageSource | null;

export function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, W: number, H: number, zoom = 1) {
  const scale = Math.max(W / sw, H / sh) * zoom;
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

export function drawFrame(ctx: CanvasRenderingContext2D, p: Project, t: number, resolve: SourceResolver) {
  const W = p.width, H = p.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  for (const clip of activeClips(p, t, 'media')) {
    const asset = p.assets.find((a) => a.id === clip.assetId);
    if (!asset) continue;
    const src = resolve(clip, asset);
    if (!src) continue;
    const local = t - clip.start;
    // Ken Burns для статичних фото: повільний зум, щоб картинка "жила"
    const zoom = asset.kind === 'image' ? 1 + 0.08 * (local / clip.duration) : 1;
    // плавна поява кліпу (fade-in 0.3с)
    ctx.globalAlpha = Math.min(1, local / 0.3);
    drawCover(ctx, src, asset.width, asset.height, W, H, zoom);
    ctx.globalAlpha = 1;
  }

  for (const clip of activeClips(p, t, 'text')) {
    drawCaption(ctx, clip.text ?? '', t - clip.start, W, H);
  }
}

function drawCaption(ctx: CanvasRenderingContext2D, text: string, local: number, W: number, H: number) {
  const base = Math.round(Math.min(W, H) * 0.075);
  const pop = local < 0.15 ? 0.8 + (local / 0.15) * 0.2 : 1; // "pop"-анімація появи
  ctx.save();
  ctx.translate(W / 2, H * 0.74);
  ctx.scale(pop, pop);
  ctx.font = `900 ${base}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = base * 0.18;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#fff';
  // перенос по словах у межах 85% ширини кадру (в canvas переносу "з коробки" немає)
  const lines: string[] = [];
  for (const w of text.toUpperCase().split(/\s+/).filter(Boolean)) {
    const cur = lines[lines.length - 1];
    if (cur && ctx.measureText(cur + ' ' + w).width <= W * 0.85) lines[lines.length - 1] = cur + ' ' + w;
    else lines.push(w);
  }
  const lh = base * 1.15;
  lines.forEach((l, i) => {
    const y = (i - (lines.length - 1) / 2) * lh;
    ctx.strokeText(l, 0, y);
    ctx.fillText(l, 0, y);
  });
  ctx.restore();
}
