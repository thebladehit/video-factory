import {
  LANGUAGES,
  TARGET_SEC,
  type ModelRef,
  type PipelineSettings,
  type VideoFormat,
  type VoiceChoice,
} from '@vf/shared';

/** Форма запуску — ті самі налаштування, що йдуть у `pipeline.estimate/start` (моделі можуть бути порожні, доки не вибрані). */
export type PipelineForm = PipelineSettings;

/** Мінімум полів запису `ai.catalog`, потрібний формі. */
export interface FormCatalogItem {
  ref: string;
  label: string;
  capability: string;
  available: boolean;
}

export interface FormDefaults {
  text?: ModelRef | undefined;
  image?: ModelRef | undefined;
  /** Голоси за замовчуванням з налаштувань користувача (мова → голос) */
  voices: Record<string, VoiceChoice>;
  baseLanguage?: string | undefined;
}

const DEFAULT_LANGUAGE = 'uk';

const stopDefault = (format: VideoFormat) => format === '16:9';

export function initialForm(format: VideoFormat, defaults: FormDefaults): PipelineForm {
  const lang = defaults.baseLanguage ?? DEFAULT_LANGUAGE;
  const voice = defaults.voices[lang];
  return {
    topic: '',
    format,
    targetSec: TARGET_SEC[format].default,
    style: '',
    baseLanguage: lang,
    languages: [lang],
    textModel: defaults.text ?? ('' as ModelRef),
    imageModel: defaults.image ?? ('' as ModelRef),
    voices: voice ? { [lang]: voice } : {},
    musicAssetId: null,
    stopAfterScript: stopDefault(format),
  };
}

/**
 * Зміна формату: тривалість — у межі нового формату; «зупинитися після сценарію» переходить на замовчування
 * нового формату, лише якщо дорівнює замовчуванню старого (користувач його не чіпав).
 */
export function onFormatChange(form: PipelineForm, format: VideoFormat): PipelineForm {
  if (form.format === format) return form;
  const { min, max } = TARGET_SEC[format];
  return {
    ...form,
    format,
    targetSec: Math.min(max, Math.max(min, form.targetSec)),
    stopAfterScript: form.stopAfterScript === stopDefault(form.format) ? stopDefault(format) : form.stopAfterScript,
  };
}

/** Додає мову; голос — з налаштувань користувача (немає → вибере сам). */
export function addLanguage(form: PipelineForm, code: string, userVoices: Record<string, VoiceChoice>): PipelineForm {
  if (form.languages.includes(code)) return form;
  const voice = userVoices[code];
  return {
    ...form,
    languages: [...form.languages, code],
    voices: voice ? { ...form.voices, [code]: voice } : form.voices,
  };
}

/** Прибирає мову; базову прибрати не можна. */
export function removeLanguage(form: PipelineForm, code: string): PipelineForm {
  if (code === form.baseLanguage || !form.languages.includes(code)) return form;
  const voices = { ...form.voices };
  delete voices[code];
  return { ...form, languages: form.languages.filter((c) => c !== code), voices };
}

export function setBaseLanguage(form: PipelineForm, code: string): PipelineForm {
  return form.languages.includes(code) ? { ...form, baseLanguage: code } : form;
}

const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase();

/** Тексти причин, чому «Створити» неактивна. */
export function blockers(form: PipelineForm, catalog: readonly FormCatalogItem[]): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  const model = (ref: string, kind: string) => {
    if (!ref) return add(`Не вибрано модель ${kind}`);
    const entry = catalog.find((m) => m.ref === ref);
    if (!entry) return add(`Немає моделі ${ref}`);
    if (!entry.available) add(`Немає ключа для моделі ${entry.label}`);
  };
  if (form.topic.trim().length < 3) add('Тема — від 3 символів');
  model(form.textModel, 'тексту');
  model(form.imageModel, 'зображень');
  for (const code of form.languages) {
    const v = form.voices[code];
    if (!v) add(`Не вибрано голос для мови «${languageName(code)}»`);
    else model(v.model, 'озвучки');
  }
  return out;
}
