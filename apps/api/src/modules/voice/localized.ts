import { and, eq, inArray } from 'drizzle-orm';
import { captionPages, toAss, toSrt, toVtt, type CaptionStyle, type TranscriptWords } from '@vf/captions';
import { projectLanguageTimelines, transcripts, voiceLines } from '@vf/db';
import { AppError, languageInfo, normalizeDoc, type TimelineDoc } from '@vf/shared';
import {
  fitSegment,
  localize,
  quantize,
  syncVoiceTrack,
  voiceTrackOf,
  withoutForeignVoice,
  type SegmentFit,
} from '@vf/timeline';
import type { AppDeps } from '../../app';
import { editorAssets, isUuid, type EditorAsset } from '../projects/editor-assets';
import { languageTimeline, ownProject, timelineAssetIds, type ProjectRow } from '../projects/service';
import { listCaptionStyles, parseVoice, projectLanguages, voiceForLanguage } from './service';
import { collectTakes } from './takes';

export interface Localized {
  timeline: TimelineDoc;
  /** ASS з доріжок `captions` документа; `null` — субтитрів немає */
  subtitles: string | null;
  /** Слова транскриптів доріжок `captions` — клієнт перебудовує ASS з чорновим стилем (живе прев'ю редактора стилю) */
  transcripts: Record<string, TranscriptWords>;
  fits: SegmentFit[];
  /** Сегменти з текстом мови, чия озвучка не готова (не озвучено, застаріла, помилка, у роботі), і сегменти з базовим текстом без перекладу */
  notReady: string[];
  /** Мова відокремлена: документ — її власна копія */
  separated: boolean;
}

interface Resolved extends Omit<Localized, 'subtitles' | 'transcripts'> {
  project: ProjectRow;
  /** Версія документа: базового проєкту або відокремленої мови */
  version: number;
  captionData: { transcripts: Record<string, TranscriptWords>; styles: Record<string, CaptionStyle> };
}

/** Мова має бути серед мов проєкту. */
export function assertProjectLanguage(p: ProjectRow, language: string): void {
  languageInfo(language);
  if (!projectLanguages(p).includes(language)) throw new AppError('VALIDATION', 'Мови немає в проєкті');
}

/** Слова транскриптів (лише свої) і збережені стилі — для ASS/SRT із доріжок `captions`. */
async function captionData(deps: AppDeps, userId: string, doc: TimelineDoc): Promise<Resolved['captionData']> {
  const ids = [
    ...new Set(doc.tracks.flatMap((t) => (t.kind === 'captions' ? t.clips.map((c) => c.transcriptId) : []))),
  ].filter(isUuid);
  const rows = ids.length
    ? await deps.db
        .select({ id: transcripts.id, words: transcripts.words })
        .from(transcripts)
        .where(and(eq(transcripts.userId, userId), inArray(transcripts.id, ids)))
    : [];
  const styles: Record<string, CaptionStyle> = {};
  if (ids.length) for (const s of await listCaptionStyles(deps, userId)) if (!s.preset) styles[s.id] = s.style;
  return { transcripts: Object.fromEntries(rows.map((r) => [r.id, { words: r.words }])), styles };
}

const hasCaptions = (doc: TimelineDoc) => doc.tracks.some((t) => t.kind === 'captions' && t.clips.length > 0);

/**
 * Документ мови. Відокремлена мова → її збережений документ. Інакше `localize(base, озвучка ready-рядків)`;
 * мова без жодної готової озвучки й без своєї доріжки озвучки → базовий документ без доріжок озвучки інших мов.
 * `captions: 'always'` — субтитри будуються навіть якщо вони вимкнені для мови (для завантаження srt/vtt).
 */
async function resolveLocalized(
  deps: AppDeps,
  userId: string,
  projectId: string,
  language: string,
  opts: { captions?: 'settings' | 'always' } = {},
): Promise<Resolved> {
  const p = await ownProject(deps, userId, projectId);
  assertProjectLanguage(p, language);

  const sep = await languageTimeline(deps, p.id, language);
  if (sep) {
    const timeline = normalizeDoc(sep.timeline);
    return {
      project: p,
      version: sep.timelineVersion,
      timeline,
      fits: [],
      notReady: [],
      separated: true,
      captionData: await captionData(deps, userId, timeline),
    };
  }

  let base = normalizeDoc(p.timeline);
  const segments = base.segments ?? [];
  const segIds = new Set(segments.map((s) => s.id));
  const isBase = language === p.baseLanguage;
  // рядки сегментів, яких немає в документі, ігноруються (undo повертає сегмент разом з озвучкою)
  const rows = (
    await deps.db
      .select()
      .from(voiceLines)
      .where(
        and(
          eq(voiceLines.projectId, p.id),
          inArray(voiceLines.language, isBase ? [language] : [language, p.baseLanguage]),
        ),
      )
  ).filter((r) => segIds.has(r.segmentId));
  const baseText = new Map(rows.filter((r) => r.language === p.baseLanguage).map((r) => [r.segmentId, r.text]));
  const voice = await voiceForLanguage(deps, userId, p, language);

  const { takes, pending, notReady } = collectTakes(rows, segments, { language, isBase, baseText, voice });
  // доріжка озвучки базової мови в документі синхронізується на копії (як у `startRender`): переозвучені
  // рядки — нові дублі, нові — нові кліпи. Доріжки немає — поведінка без змін (підгонка, спека §3.3).
  if (isBase && voiceTrackOf(base, language)) base = syncVoiceTrack(base, { language, takes, pending }).doc;

  // доріжка озвучки мови в документі (базова мова) — `localize` бере її як є, навіть без готових дублів
  const ownTrack = (voiceTrackOf(base, language)?.clips.length ?? 0) > 0;
  if (!takes.length && !ownTrack) {
    const fits = segments.map((s) => ({
      segmentId: s.id,
      ...fitSegment(Math.max(1 / base.fps, quantize(s.end - s.start, base.fps)), null, base.fps),
    }));
    return {
      project: p,
      version: p.timelineVersion,
      // озвучка інших мов (доріжка базової мови) у цій мові не звучить
      timeline: withoutForeignVoice(base, language),
      fits,
      notReady,
      separated: false,
      captionData: { transcripts: {}, styles: {} },
    };
  }

  const settings = parseVoice(p.voice);
  const lang = settings.languages[language];
  const captionsOn = languageInfo(language).captions && (opts.captions === 'always' || lang?.captions.enabled === true);
  const { doc, fits } = localize(base, {
    language,
    takes,
    original: settings.original,
    captions: captionsOn ? { enabled: true, styleId: lang?.captions.styleId ?? 'preset:shorts' } : null,
  });
  return {
    project: p,
    version: p.timelineVersion,
    timeline: doc,
    fits,
    notReady,
    separated: false,
    captionData: await captionData(deps, userId, doc),
  };
}

const assOf = (r: Resolved): string | null =>
  hasCaptions(r.timeline) ? toAss({ doc: r.timeline, ...r.captionData }) : null;

export async function buildLocalized(
  deps: AppDeps,
  userId: string,
  projectId: string,
  language: string,
): Promise<Localized & { project: ProjectRow; version: number }> {
  const r = await resolveLocalized(deps, userId, projectId, language);
  return {
    project: r.project,
    version: r.version,
    timeline: r.timeline,
    subtitles: assOf(r),
    transcripts: r.captionData.transcripts,
    fits: r.fits,
    notReady: r.notReady,
    separated: r.separated,
  };
}

/** Прев'ю мови в редакторі/студії: той самий документ і ASS, що й у рендері. */
export async function getLocalized(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; language: string },
): Promise<{
  timeline: TimelineDoc;
  subtitles: string | null;
  transcripts: Record<string, TranscriptWords>;
  fits: SegmentFit[];
  assets: Record<string, EditorAsset>;
  /** Мова відокремлена: `timeline` — її власний документ з версією `version` (інакше — версія базового) */
  separated: boolean;
  version: number;
}> {
  const l = await buildLocalized(deps, userId, input.projectId, input.language);
  const assets = await editorAssets(deps, userId, timelineAssetIds(l.timeline));
  return {
    timeline: l.timeline,
    subtitles: l.subtitles,
    transcripts: l.transcripts,
    fits: l.fits,
    assets,
    separated: l.separated,
    version: l.version,
  };
}

/** Відокремити мову: поточний документ мови стає її власною копією (версія 1). Повторно — без змін. */
export async function separateLanguage(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; language: string },
): Promise<{ version: number }> {
  const l = await buildLocalized(deps, userId, input.projectId, input.language);
  if (l.separated) return { version: l.version };
  // копія мови — звичайний документ без сегментів (як і результат `localize`)
  const timeline = { ...l.timeline };
  delete timeline.segments;
  const [row] = await deps.db
    .insert(projectLanguageTimelines)
    .values({ projectId: l.project.id, language: input.language, timeline, timelineVersion: 1 })
    .onConflictDoNothing()
    .returning({ version: projectLanguageTimelines.timelineVersion });
  if (row) return { version: row.version };
  return { version: (await languageTimeline(deps, l.project.id, input.language))?.timelineVersion ?? 1 };
}

/** Повернути мову до автоматичного `localize`: власна копія видаляється. */
export async function unseparateLanguage(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; language: string },
): Promise<void> {
  const p = await ownProject(deps, userId, input.projectId);
  languageInfo(input.language);
  await deps.db
    .delete(projectLanguageTimelines)
    .where(and(eq(projectLanguageTimelines.projectId, p.id), eq(projectLanguageTimelines.language, input.language)));
}

/** Субтитри мови файлом srt/vtt: сторінки з того самого документа, що й рендер. */
export async function languageSubtitles(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; language: string; format: 'srt' | 'vtt' },
): Promise<{ filename: string; content: string }> {
  const r = await resolveLocalized(deps, userId, input.projectId, input.language, { captions: 'always' });
  const pages = captionPages(r.timeline, r.captionData.transcripts, r.captionData.styles);
  if (!pages.length) throw new AppError('VALIDATION', 'Немає озвучених сегментів — субтитрів поки немає');
  const name = r.project.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'subtitles';
  return {
    filename: `${name} (${input.language}).${input.format}`,
    content: input.format === 'srt' ? toSrt(pages) : toVtt(pages),
  };
}
