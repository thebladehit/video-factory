import type { EditorAsset } from '@vf/api';

/** Файл, перетягнутий з ОС, поки він вантажиться: локальний `blob:`-URL і метадані з браузера. */
export interface LocalAsset {
  id: string;
  missing: false;
  local: true;
  kind: 'image' | 'video' | 'audio';
  url: string;
  thumbUrl: null;
  peaksUrl: null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hasAudio: null;
  title: string;
  /** 0..100 — прогрес завантаження */
  progress: number;
}

export type AnyAsset = EditorAsset | LocalAsset;
export type PresentAsset = Exclude<AnyAsset, { missing: true }>;

export const isPresent = (a: AnyAsset | undefined): a is PresentAsset => !!a && !a.missing;
