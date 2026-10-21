import type { CaptionStyle } from './style';

export type PresetId = 'preset:shorts' | 'preset:pop' | 'preset:karaoke' | 'preset:classic';

export const PRESETS: readonly { id: PresetId; name: string; style: CaptionStyle }[] = [
  {
    id: 'preset:shorts',
    name: 'Шортс — підсвітка слова',
    style: {
      font: 'montserrat',
      size: 7,
      color: '#FFFFFF',
      activeColor: '#FFD400',
      outline: { color: '#000000', width: 6 },
      shadow: 0,
      box: { enabled: false, color: '#000000', opacity: 0.6 },
      position: { align: 'middle', marginY: 0 },
      maxWordsPerLine: 3,
      maxLines: 1,
      uppercase: true,
      animation: 'highlight',
    },
  },
  {
    id: 'preset:pop',
    name: 'Pop по слову',
    style: {
      font: 'rubik',
      size: 9,
      color: '#FFFFFF',
      activeColor: '#FF4D8D',
      outline: { color: '#000000', width: 7 },
      shadow: 2,
      box: { enabled: false, color: '#000000', opacity: 0.6 },
      position: { align: 'middle', marginY: 0 },
      maxWordsPerLine: 2,
      maxLines: 1,
      uppercase: true,
      animation: 'pop',
    },
  },
  {
    id: 'preset:karaoke',
    name: 'Караоке',
    style: {
      font: 'oswald',
      size: 6,
      color: '#FFFFFF',
      activeColor: '#00E5FF',
      outline: { color: '#000000', width: 5 },
      shadow: 1,
      box: { enabled: false, color: '#000000', opacity: 0.6 },
      position: { align: 'bottom', marginY: 12 },
      maxWordsPerLine: 5,
      maxLines: 2,
      uppercase: false,
      animation: 'karaoke',
    },
  },
  {
    id: 'preset:classic',
    name: 'Класичні рядки',
    style: {
      font: 'inter',
      size: 4.5,
      color: '#FFFFFF',
      activeColor: '#FFFFFF',
      outline: { color: '#000000', width: 0 },
      shadow: 0,
      box: { enabled: true, color: '#000000', opacity: 0.6 },
      position: { align: 'bottom', marginY: 6 },
      maxWordsPerLine: 8,
      maxLines: 2,
      uppercase: false,
      animation: 'none',
    },
  },
];

const DEFAULT = PRESETS[0]!.style;

/** Пресет за id, інакше збережений стиль, інакше `preset:shorts`. */
export function resolveStyle(styleId: string, saved: Record<string, CaptionStyle>): CaptionStyle {
  return PRESETS.find((p) => p.id === styleId)?.style ?? saved[styleId] ?? DEFAULT;
}
