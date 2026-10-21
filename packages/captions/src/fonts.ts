export type FontId = 'montserrat' | 'inter' | 'oswald' | 'rubik' | 'roboto-slab' | 'unbounded';

export interface FontInfo {
  id: FontId;
  /** Назва родини в TTF (її libass шукає в `fontsdir`). */
  family: string;
  file: string;
  /** Середня ширина гліфа (латиниця + кирилиця, обидва регістри) як частка em. */
  avgGlyph: number;
}

export const FONTS: readonly FontInfo[] = [
  { id: 'montserrat', family: 'Montserrat', file: 'Montserrat-Bold.ttf', avgGlyph: 0.717 },
  { id: 'inter', family: 'Inter', file: 'Inter-Bold.ttf', avgGlyph: 0.675 },
  { id: 'oswald', family: 'Oswald', file: 'Oswald-Bold.ttf', avgGlyph: 0.541 },
  { id: 'rubik', family: 'Rubik', file: 'Rubik-Bold.ttf', avgGlyph: 0.672 },
  { id: 'roboto-slab', family: 'Roboto Slab', file: 'RobotoSlab-Bold.ttf', avgGlyph: 0.681 },
  { id: 'unbounded', family: 'Unbounded', file: 'Unbounded-Bold.ttf', avgGlyph: 0.872 },
];

export const fontById = (id: FontId): FontInfo => FONTS.find((f) => f.id === id) ?? FONTS[0]!;
