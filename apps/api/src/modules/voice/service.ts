import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { estimateCost, type CatalogItem } from '@vf/ai';
import { PRESETS, captionStyleSchema, type CaptionStyle } from '@vf/captions';
import { assets, captionStyles, projectLanguageTimelines, projects, transcripts, voiceLines } from '@vf/db';
import {
  AppError,
  emptyTimeline,
  languageInfo,
  normalizeDoc,
  projectVoiceSchema,
  type ModelRef,
  type OriginalSound,
  type ProjectVoice,
  type Segment,
  type TimelineDoc,
  type VoiceChoice,
  type Word,
} from '@vf/shared';
import { addClip, audioPlan, fitSegment, quantize, type SegmentFit, type VoiceTake } from '@vf/timeline';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { firstVisualAsset, ownProject, timelineAssetIds, type ProjectRow } from '../projects/service';
import { pickModel, textModel, userDefaults } from './job-utils';
import { lineState, translationStale, type LineFacts, type LineState } from './stale';
import { collectTakes } from './takes';
import { parseVoice, userVoiceDefaults, voiceForLanguage } from './choice';

export { parseVoice, userVoiceDefaults, voiceForLanguage } from './choice';

/** Максимум символів у тексті рядка */
export const MAX_LINE_CHARS = 1500;
/** Оцінка тривалості озвучки для вартості */
export const CHARS_PER_SEC = 15;
/** Модель міток слів і розпізнавання за замовчуванням */
export const STT_MODEL = 'openai/whisper-1' as ModelRef;
const URL_TTL_SEC = 3600;

export interface VoiceLineView {
  id: string;
  text: string;
  origin: 'manual' | 'stt' | 'translated' | 'script';
  state: LineState;
  audioUrl?: string;
  durationMs?: number;
  error?: string;
  words?: Word[];
  timing?: 'aligned' | 'estimated' | 'stt';
  /** Файл озвучки видалено з бібліотеки */
  audioDeleted?: true;
  /** Базовий текст змінено після перекладу — потрібен новий переклад (озвучка цього не виправить) */
  translationStale?: true;
}

export interface CaptionStyleView {
  id: string;
  name: string;
  style: CaptionStyle;
  preset: boolean;
}

export interface VoiceView {
  projectId: string;
  version: number;
  segments: Segment[];
  base: string;
  languages: string[];
  /** Мови з власним (відокремленим) документом */
  separated: string[];
  voice: ProjectVoice;
  lines: Record<string, Record<string, VoiceLineView>>;
  fits: Record<string, ({ segmentId: string } & Omit<SegmentFit, 'segmentId'>)[]>;
  styles: { id: string; name: string; style: CaptionStyle }[];
  estimate: Record<string, { chars: number; usd: number }>;
  /** Готові дублі базової мови (для синхронізації доріжки озвучки в редакторі) */
  baseTakes: VoiceTake[];
}

export interface VoiceProjectCard {
  id: string;
  title: string;
  format: ProjectRow['format'];
  thumbUrl: string | null;
  base: string;
  languages: { code: string; state: 'ready' | 'stale' | 'failed' | 'partial' | 'empty' }[];
}

/** Мови проєкту; базова завжди перша серед них. */
export const projectLanguages = (p: ProjectRow) =>
  p.languages.includes(p.baseLanguage) ? p.languages : [p.baseLanguage, ...p.languages];

/** Модель озвучки існує, голос є в її списку. */
export async function assertVoiceChoice(deps: AppDeps, userId: string, voice: VoiceChoice): Promise<CatalogItem> {
  const entry = (await deps.ai.catalog(userId)).find((e) => e.ref === voice.model && e.capability === 'tts');
  if (!entry) throw new AppError('MODEL_NOT_FOUND', `Модель ${voice.model} не підходить для озвучки`);
  if (entry.voices && !entry.voices.some((v) => v.id === voice.voiceId))
    throw new AppError('VALIDATION', `Голосу «${voice.voiceId}» немає в моделі ${voice.model}`);
  return entry;
}

/** Пресети й збережені стилі користувача. */
export async function listCaptionStyles(deps: AppDeps, userId: string): Promise<CaptionStyleView[]> {
  const rows = await deps.db
    .select()
    .from(captionStyles)
    .where(eq(captionStyles.userId, userId))
    .orderBy(captionStyles.createdAt);
  const saved: CaptionStyleView[] = [];
  for (const r of rows) {
    const style = captionStyleSchema.safeParse(r.style);
    if (style.success) saved.push({ id: r.id, name: r.name, style: style.data, preset: false });
  }
  return [...PRESETS.map((p) => ({ id: p.id, name: p.name, style: p.style, preset: true })), ...saved];
}

export async function getVoice(deps: AppDeps, userId: string, projectId: string): Promise<VoiceView> {
  const p = await ownProject(deps, userId, projectId);
  const doc = normalizeDoc(p.timeline);
  const segments = doc.segments ?? [];
  const voice = parseVoice(p.voice);
  const languages = projectLanguages(p);
  const ids = new Set(segments.map((s) => s.id));

  // рядки сегментів, яких немає в документі, ігноруються (undo повертає їх разом з озвучкою)
  const rows = (await deps.db.select().from(voiceLines).where(eq(voiceLines.projectId, p.id))).filter(
    (r) => ids.has(r.segmentId) && languages.includes(r.language),
  );
  const assetIds = [...new Set(rows.flatMap((r) => (r.audioAssetId ? [r.audioAssetId] : [])))];
  const assetRows = assetIds.length
    ? await deps.db
        .select({ id: assets.id, storageKey: assets.storageKey })
        .from(assets)
        .where(and(eq(assets.userId, userId), inArray(assets.id, assetIds)))
    : [];
  const keyOf = new Map(assetRows.map((a) => [a.id, a.storageKey]));
  const tIds = [...new Set(rows.flatMap((r) => (r.transcriptId ? [r.transcriptId] : [])))];
  const tRows = tIds.length
    ? await deps.db
        .select()
        .from(transcripts)
        .where(and(eq(transcripts.userId, userId), inArray(transcripts.id, tIds)))
    : [];
  const tById = new Map(tRows.map((t) => [t.id, t]));

  const defaults = await userVoiceDefaults(deps, userId);
  const voiceFor = (lang: string): VoiceChoice | null => voice.languages[lang]?.voice ?? defaults[lang] ?? null;
  const baseText = new Map(rows.filter((r) => r.language === p.baseLanguage).map((r) => [r.segmentId, r.text]));

  const lines: VoiceView['lines'] = {};
  const chars: Record<string, number> = Object.fromEntries(languages.map((l) => [l, 0]));
  const readyMs = new Map<string, number>();
  for (const r of rows) {
    const state = lineState(
      r,
      r.language === p.baseLanguage ? undefined : baseText.get(r.segmentId),
      voiceFor(r.language),
    );
    const key = r.audioAssetId ? keyOf.get(r.audioAssetId) : undefined;
    const t = r.transcriptId ? tById.get(r.transcriptId) : undefined;
    const view: VoiceLineView = { id: r.id, text: r.text, origin: r.textOrigin, state };
    if (key) {
      view.audioUrl = await deps.storage.presignGet(key, { expiresSec: URL_TTL_SEC });
      if (r.durationMs !== null) view.durationMs = r.durationMs;
    }
    if (r.error) view.error = r.error;
    if (t) {
      view.words = t.words;
      view.timing = t.timing;
    }
    if (r.status === 'ready' && !r.audioAssetId) view.audioDeleted = true;
    if (r.language !== p.baseLanguage && translationStale(r, baseText.get(r.segmentId))) view.translationStale = true;
    (lines[r.segmentId] ??= {})[r.language] = view;
    if (state === 'ready' && view.durationMs !== undefined)
      readyMs.set(`${r.segmentId}\n${r.language}`, view.durationMs);
    // ті самі рядки, що поставить «Озвучити все»
    if (voicedByAll(r, voiceFor(r.language))) chars[r.language]! += r.text.length;
  }

  const fits: VoiceView['fits'] = {};
  for (const lang of languages) {
    fits[lang] = segments.map((s) => {
      const ms = readyMs.get(`${s.id}\n${lang}`);
      const D = Math.max(1 / doc.fps, quantize(s.end - s.start, doc.fps));
      return { segmentId: s.id, ...fitSegment(D, ms === undefined ? null : ms / 1000, doc.fps) };
    });
  }

  // вартість «Озвучити все»: символи → хвилини × ціна моделі мови + whisper (мітки слів)
  const catalog = await deps.ai.catalog(userId);
  const whisper = catalog.find((e) => e.ref === STT_MODEL);
  const estimate: VoiceView['estimate'] = {};
  for (const lang of languages) {
    const durationSec = chars[lang]! / CHARS_PER_SEC;
    const tts = catalog.find((e) => e.ref === voiceFor(lang)?.model);
    const usd =
      (tts ? (estimateCost(tts, { durationSec }) ?? 0) : 0) +
      (whisper ? (estimateCost(whisper, { durationSec }) ?? 0) : 0);
    estimate[lang] = { chars: chars[lang]!, usd: chars[lang]! ? usd : 0 };
  }

  const { takes: baseTakes } = collectTakes(rows, segments, {
    language: p.baseLanguage,
    isBase: true,
    baseText,
    voice: voiceFor(p.baseLanguage),
  });

  const styles = (await listCaptionStyles(deps, userId)).map(({ id, name, style }) => ({ id, name, style }));
  const separated = (
    await deps.db
      .select({ language: projectLanguageTimelines.language })
      .from(projectLanguageTimelines)
      .where(eq(projectLanguageTimelines.projectId, p.id))
  )
    .map((r) => r.language)
    .filter((l) => languages.includes(l));
  return {
    projectId: p.id,
    version: p.timelineVersion,
    segments,
    base: p.baseLanguage,
    languages,
    separated,
    voice,
    lines,
    fits,
    styles,
    estimate,
    baseTakes,
  };
}

/** Проєкти для студії озвучки: де є сегменти або рядки озвучки. */
export async function listVoiceProjects(deps: AppDeps, userId: string): Promise<VoiceProjectCard[]> {
  const rows = await deps.db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt));
  if (!rows.length) return [];
  const lineRows = await deps.db
    .select()
    .from(voiceLines)
    .where(
      inArray(
        voiceLines.projectId,
        rows.map((r) => r.id),
      ),
    );
  const byProject = new Map<string, (typeof lineRows)[number][]>();
  for (const l of lineRows) {
    const list = byProject.get(l.projectId) ?? [];
    list.push(l);
    byProject.set(l.projectId, list);
  }
  const defaults = await userVoiceDefaults(deps, userId);

  const out: VoiceProjectCard[] = [];
  for (const p of rows) {
    // пошкоджений документ не має валити весь список: картка без сегментів і мініатюри
    let doc: TimelineDoc | null = null;
    try {
      doc = normalizeDoc(p.timeline);
    } catch {
      doc = null;
    }
    const segs = doc?.segments ?? [];
    const own = byProject.get(p.id) ?? [];
    if (!segs.length && !own.length) continue;
    const voice = parseVoice(p.voice);
    const baseText = new Map(own.filter((l) => l.language === p.baseLanguage).map((l) => [l.segmentId, l.text]));
    const first = doc && firstVisualAsset(doc);
    let thumbUrl: string | null = null;
    if (first && isUuid(first)) {
      const [a] = await deps.db
        .select({ thumbKey: assets.thumbKey })
        .from(assets)
        .where(and(eq(assets.id, first), eq(assets.userId, userId)));
      if (a?.thumbKey) thumbUrl = await deps.storage.presignGet(a.thumbKey);
    }
    out.push({
      id: p.id,
      title: p.title,
      format: p.format,
      thumbUrl,
      base: p.baseLanguage,
      languages: projectLanguages(p).map((code) => {
        const current = voice.languages[code]?.voice ?? defaults[code] ?? null;
        const states = segs.flatMap((s) => {
          const line = own.find((l) => l.segmentId === s.id && l.language === code);
          if (!line?.text.trim()) return [];
          return [lineState(line, code === p.baseLanguage ? undefined : baseText.get(s.id), current)];
        });
        let state: VoiceProjectCard['languages'][number]['state'];
        if (!states.length) state = 'empty';
        else if (states.includes('failed')) state = 'failed';
        else if (states.includes('stale')) state = 'stale';
        else if (states.every((s) => s === 'ready')) state = 'ready';
        else state = states.some((s) => s === 'ready') ? 'partial' : 'empty';
        return { code, state };
      }),
    });
  }
  return out;
}

/** Проєкт «{назва} — озвучка» з одного відео: формат за орієнтацією, один кліп і зв'язаний «Звук відео». */
export async function createFromAsset(deps: AppDeps, userId: string, assetId: string): Promise<{ projectId: string }> {
  const notFound = () => new AppError('NOT_FOUND', 'Файл не знайдено');
  if (!isUuid(assetId)) throw notFound();
  const [a] = await deps.db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.userId, userId)));
  if (!a || a.status === 'uploading') throw notFound();
  if (a.kind !== 'video') throw new AppError('VALIDATION', 'Для озвучки потрібне відео');
  if (a.status !== 'ready' || !a.width || !a.height)
    throw new AppError('VALIDATION', 'Відео ще обробляється або його не вдалося обробити');
  const format = a.width > a.height ? '16:9' : '9:16';
  let doc = addClip(
    emptyTimeline(format),
    {
      id: a.id,
      kind: 'video',
      durationSec: a.durationMs ? a.durationMs / 1000 : undefined,
      hasAudio: a.hasAudio === true,
    },
    { at: 0 },
  ).doc;
  if (a.width === a.height)
    doc = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === 'video' ? { ...t, clips: t.clips.map((c) => ({ ...c, fit: 'contain' as const })) } : t,
      ),
    };
  const [row] = await deps.db
    .insert(projects)
    .values({
      userId,
      title: `${a.title || a.originalName || 'Відео'} — озвучка`,
      format,
      fps: doc.fps,
      timeline: doc,
      assetIds: timelineAssetIds(doc),
      voice: parseVoice({}),
    })
    .returning({ id: projects.id });
  return { projectId: row!.id };
}

export async function setLanguages(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; base: string; languages: string[] },
): Promise<void> {
  await ownProject(deps, userId, input.projectId);
  const languages = [...new Set(input.languages)];
  for (const l of languages) languageInfo(l);
  languageInfo(input.base);
  if (!languages.includes(input.base)) throw new AppError('VALIDATION', 'Базова мова має бути серед мов проєкту');
  await deps.db
    .update(projects)
    .set({ baseLanguage: input.base, languages, updatedAt: new Date() })
    .where(and(eq(projects.id, input.projectId), eq(projects.userId, userId)));
}

const defaultLang = (): ProjectVoice['languages'][string] => ({
  captions: { enabled: false, styleId: PRESETS[0]!.id },
});

async function patchVoice(
  deps: AppDeps,
  userId: string,
  projectId: string,
  change: (v: ProjectVoice) => void,
): Promise<void> {
  const p = await ownProject(deps, userId, projectId);
  const v = parseVoice(p.voice);
  change(v);
  await deps.db
    .update(projects)
    .set({ voice: v, updatedAt: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
}

export async function setVoiceChoice(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; language: string; voice: VoiceChoice | null },
): Promise<void> {
  languageInfo(input.language);
  if (input.voice) await assertVoiceChoice(deps, userId, input.voice);
  await patchVoice(deps, userId, input.projectId, (v) => {
    const l = (v.languages[input.language] ??= defaultLang());
    if (input.voice) l.voice = input.voice;
    else delete l.voice;
  });
}

export async function setOriginal(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; original: OriginalSound },
): Promise<void> {
  const original = projectVoiceSchema.shape.original.safeParse(input.original);
  if (!original.success) throw new AppError('VALIDATION', 'Некоректні налаштування звуку оригіналу');
  await patchVoice(deps, userId, input.projectId, (v) => {
    v.original = original.data;
  });
}

export async function setCaptions(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; language: string; enabled: boolean; styleId: string },
): Promise<void> {
  const info = languageInfo(input.language);
  if (input.enabled && !info.captions)
    throw new AppError('VALIDATION', `Для мови «${info.name}» немає шрифтів субтитрів`);
  const unknownStyle = () => new AppError('VALIDATION', 'Невідомий стиль субтитрів');
  if (input.styleId.startsWith('preset:')) {
    if (!PRESETS.some((p) => p.id === input.styleId)) throw unknownStyle();
  } else {
    if (!isUuid(input.styleId)) throw unknownStyle();
    const [s] = await deps.db
      .select({ id: captionStyles.id })
      .from(captionStyles)
      .where(and(eq(captionStyles.id, input.styleId), eq(captionStyles.userId, userId)));
    if (!s) throw unknownStyle();
  }
  await patchVoice(deps, userId, input.projectId, (v) => {
    const l = (v.languages[input.language] ??= defaultLang());
    l.captions = { enabled: input.enabled, styleId: input.styleId };
  });
}

/** `failed` → `empty` без помилки (новий текст після невдалої озвучки). */
export const clearFailure = {
  status: sql<'empty'>`case when ${voiceLines.status} = 'failed' then 'empty' else ${voiceLines.status} end`,
  error: sql<null>`case when ${voiceLines.status} = 'failed' then null else ${voiceLines.error} end`,
};

/** Ручний текст рядка (upsert; `origin: 'script'` — текст сцени конвеєра). Озвучка й переклад «застаріють» самі через хеші. */
export async function setText(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; segmentId: string; language: string; text: string; origin?: 'manual' | 'script' },
): Promise<void> {
  const p = await ownProject(deps, userId, input.projectId);
  languageInfo(input.language);
  if (input.text.length > MAX_LINE_CHARS)
    throw new AppError('VALIDATION', `Текст довший за ${MAX_LINE_CHARS} символів — розділіть сегмент`);
  if (!(normalizeDoc(p.timeline).segments ?? []).some((s) => s.id === input.segmentId))
    throw new AppError('NOT_FOUND', 'Сегмент не знайдено');
  const patch = { text: input.text, textOrigin: input.origin ?? 'manual', sourceHash: null, updatedAt: new Date() };
  await deps.db
    .insert(voiceLines)
    .values({ userId, projectId: p.id, segmentId: input.segmentId, language: input.language, ...patch })
    .onConflictDoUpdate({
      target: [voiceLines.projectId, voiceLines.segmentId, voiceLines.language],
      // новий текст рядка з помилкою — знову «не озвучено», без старої помилки
      set: { ...patch, ...clearFailure },
    });
}

/** Коротка фраза для зразка голосу кожною мовою. */
const SAMPLE_PHRASES: Record<string, string> = {
  uk: 'Привіт! Так звучить цей голос.',
  en: 'Hello! This is how this voice sounds.',
  es: '¡Hola! Así suena esta voz.',
  de: 'Hallo! So klingt diese Stimme.',
  fr: 'Bonjour ! Voici le son de cette voix.',
  it: 'Ciao! Ecco come suona questa voce.',
  pt: 'Olá! É assim que esta voz soa.',
  pl: 'Cześć! Tak brzmi ten głos.',
  nl: 'Hallo! Zo klinkt deze stem.',
  cs: 'Ahoj! Takto zní tento hlas.',
  ro: 'Salut! Așa sună această voce.',
  tr: 'Merhaba! Bu ses böyle duyuluyor.',
  sv: 'Hej! Så här låter den här rösten.',
  ru: 'Привет! Так звучит этот голос.',
  kk: 'Сәлем! Бұл дауыс осылай естіледі.',
};

/** Зразок голосу: кеш у сховищі за (модель, голос, мова); повертає підписаний URL. */
export async function previewVoice(
  deps: AppDeps,
  userId: string,
  input: { model: ModelRef; voiceId: string; language: string },
): Promise<{ url: string }> {
  languageInfo(input.language);
  await assertVoiceChoice(deps, userId, { model: input.model, voiceId: input.voiceId });
  const key = `u/${userId}/voice-samples/${input.model}/${input.voiceId}/${input.language}.wav`;
  if (!(await deps.storage.head(key))) {
    const tts = await deps.ai.tts(userId, input.model);
    const { audio } = await tts.synthesize({
      text: SAMPLE_PHRASES[input.language]!,
      voiceId: input.voiceId,
      language: input.language,
    });
    await deps.storage.put(key, audio.bytes, { contentType: audio.mime });
  }
  return { url: await deps.storage.presignGet(key, { expiresSec: URL_TTL_SEC }) };
}

/**
 * Рядок, який бере «Озвучити все» (і рахує його оцінка): є текст і стан «не озвучено», «помилка» або «застарілий».
 * Стан — без базового тексту: «застарілий переклад» (лише source_hash) озвучка не виправляє —
 * потрібен новий переклад, а задача була б порожньою (voiced_hash збігається).
 */
export function voicedByAll(line: LineFacts, voice: VoiceChoice | null): boolean {
  if (!line.text.trim()) return false;
  const state = lineState(line, undefined, voice);
  return state === 'empty' || state === 'failed' || state === 'stale';
}

/**
 * «Озвучити»: задача на кожен рядок. Без `segmentIds` — рядки з текстом у станах «не озвучено», «помилка»,
 * «застарілий»; із `segmentIds` — усі рядки з текстом цих сегментів, крім тих, що вже в черзі чи в роботі.
 */
export async function enqueueSynthesize(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; language?: string; segmentIds?: string[] },
): Promise<{ jobIds: string[] }> {
  const p = await ownProject(deps, userId, input.projectId);
  const all = projectLanguages(p);
  if (input.language !== undefined) {
    languageInfo(input.language);
    if (!all.includes(input.language)) throw new AppError('VALIDATION', 'Мови немає в проєкті');
  }
  const languages = input.language ? [input.language] : all;
  const segIds = new Set((normalizeDoc(p.timeline).segments ?? []).map((s) => s.id));
  const wanted = input.segmentIds ? new Set(input.segmentIds) : null;
  const rows = (await deps.db.select().from(voiceLines).where(eq(voiceLines.projectId, p.id))).filter(
    (r) => segIds.has(r.segmentId) && (!wanted || wanted.has(r.segmentId)),
  );
  const voices = new Map<string, VoiceChoice | null>();
  for (const lang of languages) voices.set(lang, await voiceForLanguage(deps, userId, p, lang));

  const todo = rows.filter((r) => {
    if (!languages.includes(r.language) || !r.text.trim()) return false;
    if (!wanted) return voicedByAll(r, voices.get(r.language) ?? null);
    const state = lineState(r, undefined, voices.get(r.language));
    return state !== 'queued' && state !== 'running';
  });

  const catalog = await deps.ai.catalog(userId);
  for (const lang of new Set(todo.map((r) => r.language))) {
    const voice = voices.get(lang);
    if (!voice) throw new AppError('VALIDATION', `Не вибрано голос для мови «${languageInfo(lang).name}»`);
    const entry = catalog.find((e) => e.ref === voice.model && e.capability === 'tts');
    if (!entry?.available)
      throw new AppError('MODEL_UNAVAILABLE', `Модель озвучки ${voice.model} недоступна — додайте ключ`, {
        model: voice.model,
      });
  }

  const jobIds: string[] = [];
  for (const r of todo) {
    // атомарно «в черзі» (паралельний запит, що вже поставив рядок, виграє), потім задача;
    // обробник сам запише свій job_id, коли забере рядок
    const [won] = await deps.db
      .update(voiceLines)
      .set({ status: 'queued', jobId: null, error: null, updatedAt: new Date() })
      .where(and(eq(voiceLines.id, r.id), notInArray(voiceLines.status, ['queued', 'running'])))
      .returning({ id: voiceLines.id });
    if (!won) continue;
    const jobId = await deps.jobs.queue.enqueue('voice.synthesize', { lineId: r.id }, { userId });
    await deps.db
      .update(voiceLines)
      .set({ jobId })
      .where(and(eq(voiceLines.id, r.id), eq(voiceLines.status, 'queued'), isNull(voiceLines.jobId)));
    jobIds.push(jobId);
  }
  return { jobIds };
}

/** «Перекласти»: базові тексти (усі або `segmentIds`) → мова `language` однією задачею. */
export async function enqueueTranslate(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; language: string; segmentIds?: string[] },
): Promise<{ jobId: string }> {
  const p = await ownProject(deps, userId, input.projectId);
  languageInfo(input.language);
  if (input.language === p.baseLanguage) throw new AppError('VALIDATION', 'Це базова мова — перекладати нічого');
  if (!projectLanguages(p).includes(input.language)) throw new AppError('VALIDATION', 'Мови немає в проєкті');
  const segIds = new Set((normalizeDoc(p.timeline).segments ?? []).map((s) => s.id));
  const wanted = input.segmentIds ? new Set(input.segmentIds) : null;
  const base = await deps.db
    .select({ segmentId: voiceLines.segmentId, text: voiceLines.text })
    .from(voiceLines)
    .where(and(eq(voiceLines.projectId, p.id), eq(voiceLines.language, p.baseLanguage)));
  if (!base.some((l) => segIds.has(l.segmentId) && (!wanted || wanted.has(l.segmentId)) && l.text.trim()))
    throw new AppError('VALIDATION', 'Немає тексту базової мови для перекладу');
  await textModel(deps, userId);
  const payload: { projectId: string; language: string; segmentIds?: string[] } = {
    projectId: p.id,
    language: input.language,
  };
  if (input.segmentIds) payload.segmentIds = input.segmentIds;
  return { jobId: await deps.jobs.queue.enqueue('voice.translate', payload, { userId }) };
}

/** «Розпізнати»: звук ролі `original` → сегменти й тексти базової мови. */
export async function enqueueTranscribe(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; language?: string },
): Promise<{ jobId: string }> {
  const p = await ownProject(deps, userId, input.projectId);
  if (input.language !== undefined) languageInfo(input.language);
  const ids = originalAssetIds(normalizeDoc(p.timeline));
  const rows = ids.length
    ? await deps.db
        .select({ hasAudio: assets.hasAudio })
        .from(assets)
        .where(and(eq(assets.userId, userId), inArray(assets.id, ids)))
    : [];
  // has_audio = null — ще не проаналізовано: перевірить задача
  if (!rows.some((a) => a.hasAudio !== false)) throw new AppError('VALIDATION', NO_SOUND);
  await sttModel(deps, userId);
  const payload: { projectId: string; language?: string } = { projectId: p.id };
  if (input.language) payload.language = input.language;
  return { jobId: await deps.jobs.queue.enqueue('voice.transcribe', payload, { userId }) };
}

export const NO_SOUND = 'У відео немає звуку';

/** Файли, що звучать у ролі `original`: доріжки «Звук відео» + власний звук відео-кліпів. */
export function originalAssetIds(doc: TimelineDoc): string[] {
  const original = new Set<string>();
  for (const t of doc.tracks)
    if (t.kind === 'video' || (t.kind === 'audio' && t.role === 'original'))
      for (const c of t.clips) original.add(c.id);
  return [...new Set(audioPlan(doc).flatMap((a) => (original.has(a.clipId) && isUuid(a.assetId) ? [a.assetId] : [])))];
}

/** Модель розпізнавання: налаштування `stt` → whisper-1 → будь-яка доступна. */
export async function sttModel(deps: AppDeps, userId: string): Promise<CatalogItem> {
  const m = await pickModel(deps, userId, 'stt', [(await userDefaults(deps, userId)).stt, STT_MODEL]);
  if (!m) throw new AppError('MODEL_UNAVAILABLE', 'Немає моделі розпізнавання — додайте ключ OpenAI або Google');
  return m;
}
