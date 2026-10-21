import { FONTS } from '@vf/captions';
import inter from '@vf/captions/fonts/Inter-Bold.ttf?url';
import montserrat from '@vf/captions/fonts/Montserrat-Bold.ttf?url';
import oswald from '@vf/captions/fonts/Oswald-Bold.ttf?url';
import robotoSlab from '@vf/captions/fonts/RobotoSlab-Bold.ttf?url';
import rubik from '@vf/captions/fonts/Rubik-Bold.ttf?url';
import unbounded from '@vf/captions/fonts/Unbounded-Bold.ttf?url';

const BY_FILE: Record<string, string> = {
  'Inter-Bold.ttf': inter,
  'Montserrat-Bold.ttf': montserrat,
  'Oswald-Bold.ttf': oswald,
  'RobotoSlab-Bold.ttf': robotoSlab,
  'Rubik-Bold.ttf': rubik,
  'Unbounded-Bold.ttf': unbounded,
};

/** Сімейство шрифту (як у `Style:` ASS) → URL вбудованого TTF (ті самі файли, що `fontsdir` рендеру). */
export const FONT_URLS: Record<string, string> = Object.fromEntries(
  FONTS.map((f) => {
    const url = BY_FILE[f.file];
    if (!url) throw new Error(`Немає URL шрифту ${f.file}`);
    return [f.family, url];
  }),
);
