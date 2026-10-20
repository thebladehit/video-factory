import type { TimelineDoc } from '@vf/shared';
import { audioPlan, docDuration, drawFrame, easeAlpha, evaluate, type AudioItem, type Layer } from '@vf/timeline';
import { AudioGraph } from './audio-graph';
import { MediaCache } from './media-cache';
import { isPresent, type AnyAsset } from './types';

export interface PreviewEngine {
  attach(canvas: HTMLCanvasElement): void;
  setDoc(doc: TimelineDoc, assets: Record<string, AnyAsset>): void;
  seek(t: number): void;
  play(): void;
  pause(): void;
  onTime(cb: (t: number) => void): () => void;
  onEnded(cb: () => void): () => void;
  /** Свіжий URL файлу потрібен (протух підпис або помилка завантаження) */
  onRefresh(cb: (assetId: string) => void): () => void;
  /** Перемалювати (змінився розмір полотна) */
  redraw(): void;
  destroy(): void;
}

/** Розбіжність годинника й медіаелемента, після якої елемент перемотується. */
const DRIFT = 0.15;
const UNSUPPORTED = 'Браузер не може показати цей файл';

export function createCanvasPreviewEngine(): PreviewEngine {
  let canvas: HTMLCanvasElement | null = null;
  let doc: TimelineDoc | null = null;
  let assets: Record<string, AnyAsset> = {};
  let t = 0;
  let playing = false;
  let clockStart = 0;
  let tStart = 0;
  let raf = 0;
  let drawQueued = false;
  const timeCbs = new Set<(t: number) => void>();
  const endCbs = new Set<() => void>();
  const refreshCbs = new Set<(assetId: string) => void>();
  const audio = new AudioGraph();
  const cache = new MediaCache({
    onRefresh: (id) => refreshCbs.forEach((cb) => cb(id)),
    onFrame: () => queueDraw(),
  });

  const kinds = () => {
    const out: Record<string, 'image' | 'video'> = {};
    for (const [id, a] of Object.entries(assets)) if (isPresent(a) && a.kind !== 'audio') out[id] = a.kind;
    return out;
  };
  const sounds = (): AudioItem[] => (doc ? audioPlan(doc).filter((i) => isPresent(assets[i.assetId])) : []);
  const duration = () => (doc ? docDuration(doc) : 0);

  function source(layer: Layer) {
    const a = assets[layer.assetId];
    if (!isPresent(a) || cache.unsupported.has(layer.assetId)) return null;
    if (layer.kind === 'image') {
      const img = cache.image(layer.assetId, a.url);
      return img.complete && img.naturalWidth
        ? { image: img, width: img.naturalWidth, height: img.naturalHeight }
        : null;
    }
    const v = cache.video(layer.clipId, layer.assetId, a.url);
    return v.readyState >= 2 && v.videoWidth ? { image: v, width: v.videoWidth, height: v.videoHeight } : null;
  }

  /** Відео-елементи кліпів під часом `t`: під час програвання — грають і підтягуються, на паузі — точний seek. */
  function syncVideos(layers: Layer[]) {
    const active = new Set<string>();
    for (const l of layers) {
      if (l.kind !== 'video') continue;
      const a = assets[l.assetId];
      if (!isPresent(a)) continue;
      active.add(l.clipId);
      const v = cache.video(l.clipId, l.assetId, a.url);
      if (playing) {
        if (Math.abs(v.currentTime - l.sourceTime) > DRIFT) v.currentTime = l.sourceTime;
        if (v.paused) void v.play().catch(() => {});
      } else {
        if (!v.paused) v.pause();
        // пів кадру: браузер ставить currentTime на кадр, точний збіг не гарантований
        if (Math.abs(v.currentTime - l.sourceTime) > 1 / 60) v.currentTime = l.sourceTime;
      }
    }
    for (const [clipId, v] of cache.allVideos()) if (!active.has(clipId) && !v.paused) v.pause();
  }

  function syncAudio() {
    const live = new Set<string>();
    for (const item of sounds()) {
      const a = assets[item.assetId];
      if (!isPresent(a) || cache.unsupported.has(item.assetId)) continue;
      live.add(item.clipId);
      const el = cache.audio(item.clipId, item.assetId, a.url);
      const local = t - item.start;
      const inside = playing && local >= 0 && local < item.duration;
      if (!inside) {
        if (!el.paused) el.pause();
        continue;
      }
      audio.setGain(el, item.volume * easeAlpha(item.fadeIn, item.fadeOut, item.duration).at(local));
      const want = item.in + local;
      if (Math.abs(el.currentTime - want) > DRIFT) el.currentTime = want;
      if (el.paused) void el.play().catch(() => {});
    }
    for (const [id, el] of cache.allAudios()) if (!live.has(id) && !el.paused) el.pause();
  }

  function draw() {
    drawQueued = false;
    if (!canvas || !doc) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const layers = evaluate(doc, t, kinds());
    syncVideos(layers);
    const scale = canvas.width / doc.width;
    drawFrame(ctx, { width: doc.width, height: doc.height }, layers, source, scale);
    if (layers.some((l) => cache.unsupported.has(l.assetId))) {
      const font = Math.round(canvas.width / 22);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, canvas.height / 2 - font, canvas.width, font * 2);
      ctx.fillStyle = '#fff';
      ctx.font = `${font}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(UNSUPPORTED, canvas.width / 2, canvas.height / 2);
      ctx.restore();
    }
  }

  function queueDraw() {
    if (drawQueued || playing) return;
    drawQueued = true;
    requestAnimationFrame(draw);
  }

  function tick() {
    if (!playing) return;
    t = tStart + (audio.now() - clockStart);
    const end = duration();
    if (t >= end) {
      t = end;
      pause();
      timeCbs.forEach((cb) => cb(t));
      endCbs.forEach((cb) => cb());
      return;
    }
    syncAudio();
    draw();
    timeCbs.forEach((cb) => cb(t));
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
    for (const v of cache.allVideos().values()) v.pause();
    for (const a of cache.allAudios().values()) a.pause();
    queueDraw();
  }

  /** Прибрати елементи кліпів, яких уже немає в документі. */
  function prune() {
    if (!doc) return;
    const images = new Set<string>();
    const videos = new Set<string>();
    for (const tr of doc.tracks)
      if (tr.kind === 'video')
        for (const c of tr.clips) {
          const a = assets[c.assetId];
          if (isPresent(a) && a.kind === 'image') images.add(c.assetId);
          else videos.add(c.id);
        }
    cache.prune({ images, videos, audios: new Set(sounds().map((s) => s.clipId)) });
  }

  return {
    attach(c) {
      canvas = c;
      queueDraw();
    },
    setDoc(d, a) {
      for (const [id, next] of Object.entries(a)) {
        const prev = assets[id];
        if (isPresent(prev) && isPresent(next) && prev.url !== next.url) cache.forgetFailure(id);
      }
      doc = d;
      assets = a;
      prune();
      if (!playing) {
        syncAudio();
        queueDraw();
      }
    },
    seek(to) {
      t = Math.max(0, Math.min(to, duration()));
      tStart = t;
      clockStart = audio.now();
      if (playing) syncAudio();
      else queueDraw();
      timeCbs.forEach((cb) => cb(t));
    },
    play() {
      if (playing || !doc) return;
      audio.ensure();
      if (t >= duration()) t = 0;
      playing = true;
      tStart = t;
      clockStart = audio.now();
      raf = requestAnimationFrame(tick);
    },
    pause,
    onTime(cb) {
      timeCbs.add(cb);
      return () => timeCbs.delete(cb);
    },
    onEnded(cb) {
      endCbs.add(cb);
      return () => endCbs.delete(cb);
    },
    onRefresh(cb) {
      refreshCbs.add(cb);
      return () => refreshCbs.delete(cb);
    },
    redraw: () => (playing ? undefined : queueDraw()),
    destroy() {
      pause();
      cache.destroy();
      audio.destroy();
      canvas = null;
    },
  };
}
