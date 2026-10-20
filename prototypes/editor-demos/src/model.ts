// Спільна модель проєкту. Саме цей JSON зберігається в БД і є "джерелом правди"
// для будь-якого рушія: canvas-прев'ю, Remotion, FFmpeg на сервері.

export type AssetKind = 'image' | 'video';

export interface Asset {
  id: string;
  kind: AssetKind;
  name: string;
  url: string;
  duration: number; // секунди; для зображень — Infinity
  width: number;
  height: number;
}

export type TrackKind = 'media' | 'text';

export interface Clip {
  id: string;
  track: TrackKind;
  start: number; // позиція на таймлайні, сек
  duration: number; // тривалість на таймлайні, сек
  in: number; // з якого місця джерела почати (трім зліва), сек
  assetId?: string;
  text?: string;
}

export interface Project {
  width: number;
  height: number;
  fps: number;
  assets: Asset[];
  clips: Clip[];
}

export const FORMATS = {
  short: { width: 1080, height: 1920, label: '9:16 · Shorts / Reels / TikTok' },
  long: { width: 1920, height: 1080, label: '16:9 · YouTube' },
} as const;
export type FormatKey = keyof typeof FORMATS;

export const uid = () => Math.random().toString(36).slice(2, 9);

export const projectDuration = (p: Project) =>
  Math.max(1, ...p.clips.map((c) => c.start + c.duration));

export const activeClips = (p: Project, t: number, track: TrackKind) =>
  p.clips
    .filter((c) => c.track === track && t >= c.start && t < c.start + c.duration)
    .sort((a, b) => a.start - b.start);

export const fmtTime = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};
