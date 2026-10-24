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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ACCOUNT_STATUSES,
  ASSET_STATUSES,
  CAPABILITIES,
  FORMATS,
  JOB_STATUSES,
  PIPELINE_STAGES,
  PIPELINE_STATUSES,
  PLATFORMS,
  PUBLICATION_STATUSES,
  PUBLISH_METHODS,
  SCENE_STATUSES,
  VISUAL_SOURCES,
} from '@vf/shared';
import type {
  DefaultSlot,
  ModelRef,
  PipelineSettings,
  Platform,
  PublicationMeta,
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

export const VOICE_TEXT_ORIGINS = ['manual', 'stt', 'translated', 'script'] as const;
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

/** Один запуск конвеєра «тема → чернетка» на проєкт */
export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: 'cascade' }),
    settings: jsonb('settings').$type<PipelineSettings>().notNull(),
    stage: text('stage', { enum: PIPELINE_STAGES }).notNull().default('script'),
    status: text('status', { enum: PIPELINE_STATUSES }).notNull().default('running'),
    error: text('error'),
    scriptJobId: uuid('script_job_id'),
    assembleJobId: uuid('assemble_job_id'),
    /** Версія документа після останньої збірки */
    assembledVersion: integer('assembled_version'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('pipeline_runs_stage_check', sql`${t.stage} in (${inList(PIPELINE_STAGES)})`),
    check('pipeline_runs_status_check', sql`${t.status} in (${inList(PIPELINE_STATUSES)})`),
  ],
);

/** Метадані сцени конвеєра (segmentId = id сегмента документа) */
export const pipelineScenes = pgTable(
  'pipeline_scenes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    segmentId: text('segment_id').notNull(),
    position: integer('position').notNull(),
    visualPrompt: text('visual_prompt').notNull().default(''),
    keywords: text('keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    visualAssetId: uuid('visual_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    visualSource: text('visual_source', { enum: VISUAL_SOURCES }),
    generationId: uuid('generation_id').references(() => generations.id, { onDelete: 'set null' }),
    /** До 3 слабких збігів бібліотеки */
    suggestions: uuid('suggestions')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: text('status', { enum: SCENE_STATUSES }).notNull().default('empty'),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('pipeline_scenes_run_segment_key').on(t.runId, t.segmentId),
    index('pipeline_scenes_run_position_idx').on(t.runId, t.position),
    check('pipeline_scenes_status_check', sql`${t.status} in (${inList(SCENE_STATUSES)})`),
    check(
      'pipeline_scenes_visual_source_check',
      sql`${t.visualSource} is null or ${t.visualSource} in (${inList(VISUAL_SOURCES)})`,
    ),
  ],
);

export const socialAccounts = pgTable(
  'social_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: PLATFORMS }).notNull(),
    method: text('method', { enum: PUBLISH_METHODS }).notNull(),
    /** api — назва каналу з платформи; manual — введена користувачем */
    name: text('name').notNull(),
    /** Мова каналу — для автовибору акаунта */
    language: text('language').notNull(),
    /** channelId для api; null для manual */
    externalId: text('external_id'),
    profileUrl: text('profile_url'),
    /** AES-256-GCM (ключ TOKEN_ENCRYPTION_KEY), лише api */
    tokensEnc: text('tokens_enc'),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    status: text('status', { enum: ACCOUNT_STATUSES }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('social_accounts_external_key')
      .on(t.userId, t.platform, t.externalId)
      .where(sql`${t.externalId} is not null`),
    check('social_accounts_platform_check', sql`${t.platform} in (${inList(PLATFORMS)})`),
    check('social_accounts_method_check', sql`${t.method} in (${inList(PUBLISH_METHODS)})`),
    check('social_accounts_status_check', sql`${t.status} in (${inList(ACCOUNT_STATUSES)})`),
  ],
);

export const publications = pgTable(
  'publications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Захист живих публікацій від видалення рендеру — у сервісах, не в FK */
    renderId: uuid('render_id')
      .notNull()
      .references(() => renders.id, { onDelete: 'cascade' }),
    language: text('language').notNull(),
    platform: text('platform', { enum: PLATFORMS }).notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => socialAccounts.id, { onDelete: 'cascade' }),
    method: text('method', { enum: PUBLISH_METHODS }).notNull(),
    status: text('status', { enum: PUBLICATION_STATUSES }).notNull(),
    /** null = «зараз» */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<PublicationMeta>().notNull(),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    /** URI resumable-сесії YouTube */
    uploadSession: text('upload_session'),
    platformPostId: text('platform_post_id'),
    url: text('url'),
    error: text('error'),
    /** Момент переходу в processing — для тайм-ауту обробки */
    processingSince: timestamp('processing_since', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('publications_render_account_live_key')
      .on(t.renderId, t.accountId)
      .where(sql`${t.status} not in ('failed', 'cancelled')`),
    index('publications_user_status_idx').on(t.userId, t.status),
    index('publications_project_idx').on(t.projectId),
    check('publications_platform_check', sql`${t.platform} in (${inList(PLATFORMS)})`),
    check('publications_method_check', sql`${t.method} in (${inList(PUBLISH_METHODS)})`),
    check('publications_status_check', sql`${t.status} in (${inList(PUBLICATION_STATUSES)})`),
  ],
);

/** Кеш AI-метаданих: повторне відкриття діалогу не платить вдруге */
export const publishMetaDrafts = pgTable(
  'publish_meta_drafts',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    language: text('language').notNull(),
    variants: jsonb('variants').$type<Record<Platform, PublicationMeta>>().notNull(),
    model: text('model').notNull(),
    generationId: uuid('generation_id').references(() => generations.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.language] })],
);
