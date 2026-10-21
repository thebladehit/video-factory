import type { AudioRole, MediaClip, TimelineDoc } from '@vf/shared';
import { audioPlan, docDuration, drawFrame, easeAlpha, evaluate, type AudioItem, type Layer } from '@vf/timeline';
import { createCaptionsLayer, type CaptionsLayer } from '@/captions/captions-layer';
import { applyRate, AudioGraph, audioTarget } from './audio-graph';
import { MediaCache } from './media-cache';
import { videoTarget } from './video-sync';
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
  /** ASS субтитрів поверх прев'ю (`null` — без субтитрів); JASSUB вантажиться лише тоді, коли субтитри є. */
  setSubtitles(ass: string | null): void;
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
  let subtitles: string | null = null;
  let captions: CaptionsLayer | null = null;
  /** Кліпи відео-доріжок за id (темп і стоп-кадр) і ролі доріжок звукових кліпів. */
  let videoClips = new Map<string, MediaClip>();
  let roles = new Map<string, AudioRole>();
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
      const clip = videoClips.get(l.clipId);
      if (!clip) continue;
      const target = videoTarget(clip, t, v.duration, doc?.fps ?? 30);
      applyRate(v, target.playbackRate);
      if (playing && !target.paused) {
        if (Math.abs(v.currentTime - target.time) > DRIFT) v.currentTime = target.time;
        if (v.paused) void v.play().catch(() => {});
      } else {
        if (!v.paused) v.pause();
        // пів кадру: браузер ставить currentTime на кадр, точний збіг не гарантований
        if (Math.abs(v.currentTime - target.time) > 1 / 60) v.currentTime = target.time;
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
      const target = audioTarget(item, roles.get(item.clipId), local);
      if (!playing || !target.active) {
        if (!el.paused) el.pause();
        continue;
      }
      // локальний час кліпу = 0 у момент годинника clockStart + (start − tStart): від нього — рампи огинаючої
      const clipStart = clockStart + (item.start - tStart);
      audio.setGain(
        el,
        item.volume * easeAlpha(item.fadeIn, item.fadeOut, item.duration).at(local),
        item.envelope,
        clipStart,
      );
      applyRate(el, target.rate);
      if (Math.abs(el.currentTime - target.time) > DRIFT) el.currentTime = target.time;
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
    captions?.setTime(t, !playing);
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

  /** Шар субтитрів створюється, коли є і полотно, і ASS (до того JASSUB не вантажиться). */
  function ensureCaptions() {
    const host = canvas?.parentElement;
    if (captions || !subtitles || !host || !canvas) return;
    captions = createCaptionsLayer(host);
    fitCaptions();
  }

  function fitCaptions() {
    if (captions && canvas) captions.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
  }

  return {
    attach(c) {
      // полотно перемонтоване в інший контейнер — шар субтитрів (його canvas уже передано воркеру) створити заново
      if (captions && canvas?.parentElement !== c.parentElement) {
        captions.destroy();
        captions = null;
      }
      canvas = c;
      ensureCaptions();
      captions?.setAss(subtitles);
      queueDraw();
    },
    setDoc(d, a) {
      for (const [id, next] of Object.entries(a)) {
        const prev = assets[id];
        if (isPresent(prev) && isPresent(next) && prev.url !== next.url) cache.forgetFailure(id);
      }
      doc = d;
      assets = a;
      videoClips = new Map(
        d.tracks.flatMap((tr) => (tr.kind === 'video' ? tr.clips.map((c) => [c.id, c] as const) : [])),
      );
      roles = new Map(
        d.tracks.flatMap((tr) => (tr.kind === 'audio' ? tr.clips.map((c) => [c.id, tr.role] as const) : [])),
      );
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
    redraw() {
      fitCaptions();
      if (!playing) queueDraw();
    },
    setSubtitles(ass) {
      subtitles = ass;
      ensureCaptions();
      captions?.setAss(ass);
      if (!playing) queueDraw();
    },
    destroy() {
      pause();
      captions?.destroy();
      captions = null;
      cache.destroy();
      audio.destroy();
      canvas = null;
    },
  };
}
