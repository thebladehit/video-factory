import { AppError } from './errors';

export interface LanguageInfo {
  code: string;
  /** Назва українською. */
  name: string;
  script: 'latin' | 'cyrillic' | 'other';
  /** Чи є шрифти для субтитрів цієї писемності. */
  captions: boolean;
}

const lang = (code: string, name: string, script: LanguageInfo['script']): LanguageInfo => ({
  code,
  name,
  script,
  captions: script !== 'other',
});

export const LANGUAGES: readonly LanguageInfo[] = [
  lang('uk', 'Українська', 'cyrillic'),
  lang('en', 'Англійська', 'latin'),
  lang('es', 'Іспанська', 'latin'),
  lang('de', 'Німецька', 'latin'),
  lang('fr', 'Французька', 'latin'),
  lang('it', 'Італійська', 'latin'),
  lang('pt', 'Португальська', 'latin'),
  lang('pl', 'Польська', 'latin'),
  lang('nl', 'Нідерландська', 'latin'),
  lang('cs', 'Чеська', 'latin'),
  lang('ro', 'Румунська', 'latin'),
  lang('tr', 'Турецька', 'latin'),
  lang('sv', 'Шведська', 'latin'),
  lang('ru', 'Російська', 'cyrillic'),
  lang('kk', 'Казахська', 'cyrillic'),
];

export function languageInfo(code: string): LanguageInfo {
  const info = LANGUAGES.find((l) => l.code === code);
  if (!info) throw new AppError('VALIDATION', `Невідома мова: "${code}"`, { code });
  return info;
}
