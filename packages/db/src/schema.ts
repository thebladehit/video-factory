import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { CAPABILITIES, JOB_STATUSES } from '@vf/shared';
import type { Capability, ModelRef } from '@vf/shared';

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
  defaults: jsonb('defaults').$type<Partial<Record<Capability, ModelRef>>>().notNull().default({}),
  channelStyle: text('channel_style').notNull().default(''),
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
    storageKey: text('storage_key').notNull().unique(),
    thumbKey: text('thumb_key'),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    title: text('title').notNull().default(''),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    prompt: text('prompt'),
    language: text('language'),
    generationId: uuid('generation_id').references(() => generations.id, { onDelete: 'set null' }),
    // 'simple': контент багатомовний, української конфігурації в Postgres немає
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || vf_tags_text(tags) || ' ' || coalesce(prompt, ''))`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    index('assets_user_created_idx').on(t.userId, t.createdAt),
    index('assets_search_idx').using('gin', t.search),
    index('assets_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
    check('assets_kind_check', sql`${t.kind} in ('image', 'video', 'audio')`),
    check('assets_source_check', sql`${t.source} in ('generated', 'uploaded', 'rendered')`),
  ],
);
