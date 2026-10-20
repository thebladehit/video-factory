import { useEffect, useRef } from 'react';
import { Asset, Clip, Project, activeClips, projectDuration } from './model';
import { drawFrame } from './canvasRender';

// Демо A/C: власний прев'ю-рушій. Один <canvas>, для кожного відео-кліпу — прихований <video>.
// Під час програвання рахуємо час від performance.now() і підтягуємо відео, якщо вони "з'їхали".

interface Props {
  project: Project;
  time: number;
  playing: boolean;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
}


export function CanvasPreview({ project, time, playing, setTime, setPlaying }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const images = useRef(new Map<string, HTMLImageElement>());
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const timeRef = useRef(time);
  timeRef.current = time;
  // Внутрішня роздільність canvas = відображений розмір × devicePixelRatio (Retina),
  // інакше браузер розтягує маленьку картинку і прев'ю "мило".
  const scaleRef = useRef(0.4);
  const renderRef = useRef<(t: number) => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = canvas.parentElement!;
    const fit = () => {
      const cs = getComputedStyle(wrap);
      const aw = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ah = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const k = Math.min(aw / project.width, ah / project.height);
      const cssW = project.width * k, cssH = project.height * k;
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      scaleRef.current = canvas.width / project.width;
      renderRef.current(timeRef.current);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    fit();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.width, project.height]);

  const getImage = (a: Asset) => {
    let img = images.current.get(a.id);
    if (!img) {
      img = new Image();
      img.src = a.url;
      img.onload = () => render(timeRef.current);
      images.current.set(a.id, img);
    }
    return img.complete ? img : null;
  };
  const getVideo = (c: Clip, a: Asset) => {
    let v = videos.current.get(c.id);
    if (!v) {
      v = document.createElement('video');
      v.src = a.url;
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.onseeked = () => render(timeRef.current);
      v.onloadeddata = () => render(timeRef.current);
      videos.current.set(c.id, v);
    }
    return v;
  };

  const syncVideos = (t: number, isPlaying: boolean) => {
    const active = new Set(activeClips(project, t, 'media').map((c) => c.id));
    for (const c of project.clips) {
      const a = project.assets.find((x) => x.id === c.assetId);
      if (!a || a.kind !== 'video') continue;
      const v = getVideo(c, a);
      if (!active.has(c.id)) { if (!v.paused) v.pause(); continue; }
      const target = t - c.start + c.in;
      if (isPlaying) {
        if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
        if (v.paused) v.play().catch(() => {});
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - target) > 0.02) v.currentTime = target;
      }
    }
  };

  const render = (t: number) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(scaleRef.current, 0, 0, scaleRef.current, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    drawFrame(ctx, project, t, (clip, asset) => {
      if (asset.kind === 'image') return getImage(asset);
      const v = getVideo(clip, asset);
      return v.readyState >= 2 ? v : null;
    });
  };

  renderRef.current = render;

  // пауза / перемотка
  useEffect(() => {
    if (playing) return;
    syncVideos(time, false);
    render(time);
  });

  // програвання
  useEffect(() => {
    if (!playing) return;
    const t0 = timeRef.current;
    const now0 = performance.now();
    const end = projectDuration(project);
    let raf = 0;
    const tick = () => {
      const t = t0 + (performance.now() - now0) / 1000;
      if (t >= end) { setPlaying(false); setTime(end); return; }
      syncVideos(t, true);
      render(t);
      setTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); videos.current.forEach((v) => v.pause()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, project]);

  return (
    <canvas ref={canvasRef} className="preview-canvas" />
  );
}
