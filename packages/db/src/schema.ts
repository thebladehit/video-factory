import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { ASSET_STATUSES, CAPABILITIES, FORMATS, JOB_STATUSES } from '@vf/shared';
import type {
  DefaultSlot,
  ModelRef,
  ProjectVoice,
  TimelineDoc,
  VideoFormat,
  VoiceChoice,
  VoiceDefaults,
  Word,
} from '@vf/shared';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  defaults: jsonb('defaults').$type<Partial<Record<DefaultSlot, ModelRef>>>().notNull().default({}),
  channelStyle: text('channel_style').notNull().default(''),
  /** Vision-теги для завантажених файлів (коштує грошей — вмикається свідомо) */
  autoTagUploads: boolean('auto_tag_uploads').notNull().default(false),
  /** Голос за замовчуванням для кожної мови */
  voices: jsonb('voices').$type<VoiceDefaults>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
    progress: real('progress').notNull().default(0),
    message: text('message'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    /** Прапорець скасування: працює і для задачі, яку саме бере воркер (гонка cancel vs claim) */
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    result: jsonb('result'),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_status_created_idx').on(t.status, t.createdAt),
    check('jobs_status_check', sql`${t.status} in (${inList(JOB_STATUSES)})`),
  ],
);

export const generations = pgTable(
  'generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    capability: text('capability', { enum: CAPABILITIES }).notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    prompt: text('prompt'),
    params: jsonb('params').notNull().default({}),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    error: text('error'),
    costEstimate: numeric('cost_estimate', { precision: 12, scale: 6 }),
    /** Операція провайдера (відео): з нею задача після рестарту продовжує опитування, а не платить удруге */
    providerOp: jsonb('provider_op'),
    assetIds: uuid('asset_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
  },
  (t) => [check('generations_capability_check', sql`${t.capability} in (${inList(CAPABILITIES)})`)],
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['image', 'video', 'audio'] }).notNull(),
    source: text('source', { enum: ['generated', 'uploaded', 'rendered'] }).notNull(),
    status: text('status', { enum: ASSET_STATUSES }).notNull().default('ready'),
    error: text('error'),
    originalName: text('original_name'),
    /** id незавершеного multipart-завантаження S3 (для скасування й прибирання) */
    uploadId: text('upload_id'),
    storageKey: text('storage_key').notNull().unique(),
    thumbKey: text('thumb_key'),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    title: text('title').notNull().default(''),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    prompt: text('prompt'),
    language: text('language'),
    generationId: uuid('generation_id').references(() => generations.id, { onDelete: 'set null' }),
    /** null — ще не проаналізовано (asset.analyze) */
    hasAudio: boolean('has_audio'),
    /** Піки хвилі: Uint8 по 100 значень на секунду */
    peaksKey: text('peaks_key'),
    // 'simple': контент багатомовний, української конфігурації в Postgres немає
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || vf_tags_text(tags) || ' ' || coalesce(prompt, ''))`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    index('assets_user_created_idx').on(t.userId, t.createdAt),
    index('assets_user_status_created_idx').on(t.userId, t.status, t.createdAt),
    index('assets_search_idx').using('gin', t.search),
    index('assets_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
    check('assets_kind_check', sql`${t.kind} in ('image', 'video', 'audio')`),
    check('assets_source_check', sql`${t.source} in ('generated', 'uploaded', 'rendered')`),
    check('assets_status_check', sql`${t.status} in (${inList(ASSET_STATUSES)})`),
  ],
);

const VIDEO_FORMATS = Object.keys(FORMATS) as VideoFormat[];
export const PROJECT_STATUSES = ['draft', 'ready', 'published'] as const;
export const RENDER_PRESETS = ['final', 'draft'] as const;

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    format: text('format').$type<VideoFormat>().notNull(),
    fps: integer('fps').notNull().default(30),
    timeline: jsonb('timeline').$type<TimelineDoc>().notNull(),
    timelineVersion: integer('timeline_version').notNull().default(1),
    /** Перераховується сервером з таймлайну при кожному збереженні (для assets.usage) */
    assetIds: uuid('asset_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: text('status', { enum: PROJECT_STATUSES }).notNull().default('draft'),
    topic: text('topic'),
    baseLanguage: text('base_language').notNull().default('uk'),
    languages: text('languages')
      .array()
      .notNull()
      .default(sql`'{uk}'::text[]`),
    voice: jsonb('voice').$type<ProjectVoice>().notNull().default({} as ProjectVoice),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('projects_user_updated_idx').on(t.userId, t.updatedAt),
    index('projects_asset_ids_idx').using('gin', t.assetIds),
    check('projects_format_check', sql`${t.format} in (${inList(VIDEO_FORMATS)})`),
    check('projects_status_check', sql`${t.status} in (${inList(PROJECT_STATUSES)})`),
  ],
);

export const renders = pgTable(
  'renders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    preset: text('preset', { enum: RENDER_PRESETS }).notNull(),
    language: text('language'),
    timelineSnapshot: jsonb('timeline_snapshot').$type<TimelineDoc>().notNull(),
    timelineVersion: integer('timeline_version').notNull(),
    /** ASS, згенерований на старті рендеру (знімок разом із timeline_snapshot) */
    subtitles: text('subtitles'),
    /** Дзеркало статусу задачі */
    status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    /** = id рендеру, коли asset створено після ffmpeg */
    outputAssetId: uuid('output_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('renders_project_created_idx').on(t.projectId, t.createdAt),
    check('renders_preset_check', sql`${t.preset} in (${inList(RENDER_PRESETS)})`),
    check('renders_status_check', sql`${t.status} in (${inList(JOB_STATUSES)})`),
  ],
);

export const VOICE_TEXT_ORIGINS = ['manual', 'stt', 'translated'] as const;
export const VOICE_LINE_STATUSES = ['empty', 'queued', 'running', 'ready', 'failed'] as const;
export const TRANSCRIPT_SOURCES = ['tts', 'stt'] as const;
export const TRANSCRIPT_TIMINGS = ['aligned', 'estimated', 'stt'] as const;

export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    language: text('language').notNull(),
    source: text('source', { enum: TRANSCRIPT_SOURCES }).notNull(),
    text: text('text').notNull(),
    words: jsonb('words').$type<Word[]>().notNull(),
    timing: text('timing', { enum: TRANSCRIPT_TIMINGS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('transcripts_asset_idx').on(t.assetId),
    check('transcripts_source_check', sql`${t.source} in (${inList(TRANSCRIPT_SOURCES)})`),
    check('transcripts_timing_check', sql`${t.timing} in (${inList(TRANSCRIPT_TIMINGS)})`),
  ],
);

/** Рядок «сегмент × мова»: текст, голос і результат озвучки */
export const voiceLines = pgTable(
  'voice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    segmentId: text('segment_id').notNull(),
    language: text('language').notNull(),
    text: text('text').notNull().default(''),
    textOrigin: text('text_origin', { enum: VOICE_TEXT_ORIGINS }).notNull().default('manual'),
    /** Хеш базового тексту на момент перекладу */
    sourceHash: text('source_hash'),
    /** Голос, яким озвучено */
    voice: jsonb('voice').$type<VoiceChoice>(),
    audioAssetId: uuid('audio_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    transcriptId: uuid('transcript_id').references(() => transcripts.id, { onDelete: 'set null' }),
    durationMs: integer('duration_ms'),
    /** Хеш text + voice на момент озвучки */
    voicedHash: text('voiced_hash'),
    status: text('status', { enum: VOICE_LINE_STATUSES }).notNull().default('empty'),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('voice_lines_project_segment_language_key').on(t.projectId, t.segmentId, t.language),
    index('voice_lines_project_language_idx').on(t.projectId, t.language),
    check('voice_lines_text_origin_check', sql`${t.textOrigin} in (${inList(VOICE_TEXT_ORIGINS)})`),
    check('voice_lines_status_check', sql`${t.status} in (${inList(VOICE_LINE_STATUSES)})`),
  ],
);

export const captionStyles = pgTable(
  'caption_styles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    style: jsonb('style').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('caption_styles_user_idx').on(t.userId)],
);

/** Мовна версія таймлайну (localize) для кожної мови проєкту */
export const projectLanguageTimelines = pgTable(
  'project_language_timelines',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    language: text('language').notNull(),
    timeline: jsonb('timeline').$type<TimelineDoc>().notNull(),
    timelineVersion: integer('timeline_version').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.language] })],
);
