# Підпроєкт 0 «Фундамент» — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Монорепо, яке запускається однією командою: БД і S3-сховище в Docker, API з чергою задач (in-process) і живим прогресом, реєстр AI-провайдерів з FakeProvider, веб-каркас зі сторінкою «Налаштування».

**Architecture:** pnpm-монорепо; внутрішні пакети споживаються як TypeScript-сирці (без кроку збірки). Модулі залежать лише від інтерфейсів (`JobQueue`, `BlobStorage`, `AiRegistry`, `AuthProvider`, `CredentialStore`); реалізації збираються в одному composition root у `apps/api`. Веб — React SPA, що говорить з API через tRPC (запити — batch HTTP, прогрес задач — tRPC-підписка поверх SSE).

**Tech Stack:** Node ≥ 24 (локально 26), pnpm 12, Turborepo 2, TypeScript 6.0.x, Vitest 5, Fastify 5, tRPC 11, Zod 4, Drizzle ORM 0.45 + drizzle-kit, `postgres` (postgres.js), PostgreSQL 17, RustFS (S3), `@aws-sdk/client-s3` v3, Vercel AI SDK 7 (`ai`, `@ai-sdk/anthropic|openai|google`), p-queue 10, React 19, Vite, TanStack Router + Query, Tailwind CSS 4, shadcn/ui, Playwright.

**Spec:** `docs/specs/2026-10-20-video-factory-design.md` (розділ 12.1 — обсяг цього плану; розділи 3–5, 7 — контракти).

## Global Constraints

- Мова інтерфейсу — українська; ідентифікатори коду — англійська.
- **TypeScript 6.0.x, не 7** (typescript-eslint 8.x вимагає `typescript <6.1`).
- ESM усюди (`"type": "module"`); внутрішні пакети мають `"exports": { ".": "./src/index.ts" }`, імена `@vf/<name>`.
- Кожна таблиця з даними користувача має `user_id` (spec §5).
- Payload задач — лише JSON-серіалізовані plain-значення з ідентифікаторами (spec §4.1, правило 1).
- AI-провайдери: `anthropic`, `openai`, `google` (лише платний ключ) і `fake` (тільки коли `AI_FAKE=1`). **Безкоштовного Gemini немає.**
- Змінні середовища (точні імена): `DATABASE_URL`, `TEST_DATABASE_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `QUEUE_DRIVER=inprocess`, `API_PORT=3001`, `WEB_ORIGIN=http://localhost:5173`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `AI_FAKE`.
- Порти: Postgres `5433→5432`, RustFS S3 `9000`, консоль RustFS `9001`, API `3001`, web `5173` (Vite проксіює `/trpc` на API).
- Фіксований id локального користувача: `LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001'`.
- Тести: `*.test.ts` — unit; `*.int.test.ts` — потребують `docker compose up -d`; `*.live.test.ts` — справжні ключі, лише `pnpm test:live`. `pnpm test` запускає unit + int.
- **Передумови:** запущений Docker Desktop. FFmpeg у цьому підпроєкті не потрібен.

## Review Focus

1. **Postgres не запущений під час старту API** → процес завершується з повідомленням українською, що містить `docker compose up -d`, а не зі стеком помилки драйвера. Тест — Task 7.
2. **RustFS недоступний** → API стартує, `health.check` повертає `storage: 'down'`, жоден запит не падає з 500. Тест — Task 7.
3. **Недійсний або прострочений API-ключ** → «Перевірити модель» повертає `PROVIDER_ERROR` з текстом провайдера (напр. «401 invalid x-api-key»), UI показує його. Тести — Task 6 (адаптер) і Task 7 (роутер).
4. **Збережена модель за замовчуванням стала недоступною** (ключ прибрали з `.env` або модель зникла з каталогу) → `settings.get` повертає її з `available: false`, сторінка показує «недоступна», нічого не падає. Тест — Task 7.
5. **Підписка на події задачі після її завершення або повторне підключення** → клієнт одразу отримує поточний знімок і підписка завершується, а не висить. Тест — Task 7.

---

## Структура файлів

```
package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json  vitest.config.ts
eslint.config.js  .prettierrc  .nvmrc  .env.example  docker-compose.yml  docker/postgres-init.sql
README.md
packages/shared/src/{index,errors,capabilities,jobs,timeline}.ts           (+ *.test.ts)
packages/db/src/{index,client,schema,seed,migrate}.ts  packages/db/drizzle/   (+ db.int.test.ts)
packages/storage/src/{index,blob-storage,s3-blob-storage}.ts                (+ s3.int.test.ts)
packages/jobs/src/{index,types,pg-job-store,in-process,serializable}.ts     (+ *.test.ts, in-process.int.test.ts)
packages/ai/src/{index,types,catalog,credentials,registry}.ts
packages/ai/src/providers/{anthropic,openai,google,ai-sdk-text}.ts
packages/ai/src/fake/{index,png,wav,fake-object}.ts                          (+ *.test.ts)
apps/api/src/{main,app,config,trpc,context}.ts
apps/api/src/auth/single-user.ts
apps/api/src/routers/{index,health,settings,ai,jobs}.ts
apps/api/src/jobs/debug-sleep.ts                                             (+ test/*.int.test.ts)
apps/web/{index.html,vite.config.ts,components.json}
apps/web/src/{main.tsx,styles.css,lib/trpc.ts,lib/utils.ts}
apps/web/src/routes/{__root,index,library,voice,publications,analytics,settings}.tsx
apps/web/src/components/{AppSidebar,ComingSoon}.tsx
apps/web/src/components/settings/{HealthCard,ModelDefaults,TestModel,DebugJobCard,ChannelStyle}.tsx
apps/web/e2e/settings.spec.ts  apps/web/playwright.config.ts
```

---

### Task 1: Каркас монорепо та локальна інфраструктура

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.nvmrc`, `.env.example`, `docker-compose.yml`, `docker/postgres-init.sql`
- Modify: `.gitignore` (додати `apps/web/test-results/`, `apps/web/playwright-report/`)

**Interfaces:**
- Produces: кореневі скрипти `pnpm dev | test | test:unit | test:live | lint | typecheck | db:migrate | db:seed`; Vitest-проєкти за glob `packages/*`, `apps/*`.

- [ ] **Step 1:** Кореневий `package.json`: `"private": true`, `"type": "module"`, `"packageManager": "pnpm@12.14.0"`, `"engines": { "node": ">=24" }`; devDependencies: `turbo@^2.11`, `typescript@~6.0.3`, `vitest@^5`, `eslint@^10`, `typescript-eslint@^8.72`, `prettier@^3.9`, `tsx@^4.23`, `dotenv@^18`. Скрипти:
  - `test`: `vitest run --exclude "**/*.live.test.ts"`; `test:unit`: `vitest run --exclude "**/*.int.test.ts" --exclude "**/*.live.test.ts"`; `test:live`: `vitest run live`
  - `dev`: `turbo run dev --parallel`; `typecheck`: `turbo run typecheck`; `lint`: `eslint .`
  - `db:migrate`: `pnpm --filter @vf/db migrate`; `db:seed`: `pnpm --filter @vf/db seed`
- [ ] **Step 2:** `vitest.config.ts` з `test.projects: ['packages/*', 'apps/api']`, `setupFiles` що вантажить `.env` через `dotenv/config`; `test.fileParallelism: false` (int-тести різних пакетів ділять одну тестову БД — паралельне очищення таблиць дало б нестабільні тести).
- [ ] **Step 3:** `tsconfig.base.json`: `target ES2023`, `module/moduleResolution: "bundler"`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `skipLibCheck`, `noEmit`.
- [ ] **Step 4:** `docker-compose.yml`:
  - `postgres`: `postgres:17-alpine`, user/password/db `vf`/`vf`/`vf`, порт `5433:5432`, volume `pgdata`, монтує `docker/postgres-init.sql` (створює БД `vf_test`), healthcheck `pg_isready`.
  - `rustfs`: образ `rustfs/rustfs` з **точним тегом поточного GA-релізу 1.x** (перевірити на Docker Hub / GitHub Releases; не `latest`, не alpha), порти `9000`, `9001`, облікові дані з `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (`vfadmin` / `vfadmin-secret`), volume `s3data`. Імена змінних середовища контейнера взяти з документації RustFS.
  - **Запасний план:** якщо RustFS не проходить інтеграційний тест Task 4 (presigned PUT або CORS), замінити сервіс на SeaweedFS (`weed server -s3`, порт 8333 → змінити `S3_ENDPOINT`) і записати це в README.
- [ ] **Step 5:** `.env.example` зі всіма змінними з Global Constraints (значення для локального запуску; ключі AI порожні; `AI_FAKE=1`). `.nvmrc` = `24`.
- [ ] **Step 6:** Перевірка інфраструктури.
  Run: `cp .env.example .env && docker compose up -d && docker compose ps`
  Expected: обидва сервіси `running (healthy)` / `running`; `psql postgres://vf:vf@localhost:5433/vf_test -c 'select 1'` повертає `1`; `curl -s -o /dev/null -w '%{http_code}' http://localhost:9000` — будь-який HTTP-код (сервер відповідає).
- [ ] **Step 7:** `pnpm install && pnpm lint && pnpm test`
  Expected: install без помилок; lint чистий; vitest повідомляє «No test files found» без падіння (додати `passWithNoTests: true`).
- [ ] **Step 8:** Commit `chore: monorepo scaffold and local infrastructure`.

---

### Task 2: `@vf/shared` — помилки, можливості, задачі, документ таймлайну

**Files:**
- Create: `packages/shared/package.json` (deps: `zod@^4.6`), `packages/shared/src/{index,errors,capabilities,jobs,timeline}.ts`
- Test: `packages/shared/src/errors.test.ts`, `packages/shared/src/timeline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // errors.ts
  type ErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'MODEL_NOT_FOUND' | 'MODEL_UNAVAILABLE'
    | 'PROVIDER_ERROR' | 'INVALID_PAYLOAD' | 'UNKNOWN_JOB_TYPE' | 'CONFLICT' | 'INFRA_UNAVAILABLE' | 'INTERNAL';
  class AppError extends Error { constructor(code: ErrorCode, message: string, details?: unknown); code; details; toJSON(): { code; message; details } }
  const isAppError: (e: unknown) => e is AppError;
  // capabilities.ts
  const CAPABILITIES = ['text', 'image', 'video', 'tts', 'stt'] as const; type Capability;
  type ProviderId = 'anthropic' | 'openai' | 'google' | 'fake';
  type ModelRef = `${ProviderId}/${string}`;          // 'anthropic/claude-sonnet-5-5'
  const parseModelRef: (ref: string) => { provider: ProviderId; model: string };  // кидає AppError('VALIDATION')
  // jobs.ts
  const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const; type JobStatus;
  const TERMINAL_STATUSES: ReadonlySet<JobStatus>;     // done, failed, cancelled
  type JobType = 'debug.sleep';                        // розширюється в наступних підпроєктах
  interface JobRecord { id; userId; type: JobType; payload: unknown; status: JobStatus; progress: number;
    message: string | null; error: string | null; attempts: number; result: unknown;
    createdAt: string; startedAt: string | null; finishedAt: string | null }
  interface JobEvent { jobId: string; status: JobStatus; progress: number; message: string | null; error: string | null }
  // timeline.ts — точно за spec §5.1
  const FORMATS = { '9:16': { width: 1080, height: 1920 }, '16:9': { width: 1920, height: 1080 } } as const;
  type VideoFormat = keyof typeof FORMATS;
  const timelineDocSchema: z.ZodType<TimelineDoc>;  type TimelineDoc; type Track; type MediaClip; type AudioClip; type CaptionClip; type Effect;
  const emptyTimeline: (format: VideoFormat, fps?: number /* 30 */) => TimelineDoc;
  // index.ts
  const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001';
  ```

- [ ] **Step 1: Failing tests.**
  - `errors.test.ts`: `new AppError('MODEL_NOT_FOUND', 'x', { ref: 'a/b' }).toJSON()` дорівнює `{ code: 'MODEL_NOT_FOUND', message: 'x', details: { ref: 'a/b' } }`; `isAppError(new Error())` → `false`; `parseModelRef('anthropic/claude-sonnet-5-5')` → `{ provider: 'anthropic', model: 'claude-sonnet-5-5' }`; `parseModelRef('nope')` і `parseModelRef('groq/x')` кидають `AppError` з `code: 'VALIDATION'`.
  - `timeline.test.ts`: `emptyTimeline('9:16')` проходить `timelineDocSchema.parse` і має `width 1080, height 1920, fps 30, tracks: []`; документ із одним `video`-треком і кліпом `{ start: 0, duration: 2, in: 0, fit: 'cover', effects: [{ type: 'kenburns', params: {} }] }` проходить; відхиляються: `duration: 0`, `start: -1`, `in: -0.5`, трек `kind: 'subtitle'`, `captions`-трек без `language`, `schemaVersion: 2`, ефект `type: 'glitch'`.
- [ ] **Step 2:** `pnpm vitest run packages/shared` → FAIL (модулі відсутні).
- [ ] **Step 3:** Реалізувати файли за інтерфейсами. Обмеження схеми: `start ≥ 0`, `in ≥ 0`, `duration > 0`, `volume` у `[0, 2]`, `fps` ціле `[1, 120]`, `width/height` цілі `[16, 7680]`, `schemaVersion: z.literal(1)`, `Track` — `z.discriminatedUnion('kind', …)`.
- [ ] **Step 4:** `pnpm vitest run packages/shared` → PASS.
- [ ] **Step 5:** Commit `feat(shared): errors, capabilities, job types, TimelineDoc schema`.

---

### Task 3: `@vf/db` — схема, міграції, seed

**Files:**
- Create: `packages/db/package.json` (deps: `drizzle-orm@^0.45`, `postgres@^3.4`, `@vf/shared`; dev: `drizzle-kit@^0.31`), `packages/db/drizzle.config.ts`, `packages/db/src/{index,client,schema,seed,migrate}.ts`, `packages/db/drizzle/*` (згенеровано), `packages/db/test/global-setup.ts`
- Modify: `vitest.config.ts` — `test.globalSetup: ['packages/db/test/global-setup.ts']` (один раз: `runMigrations(TEST_DATABASE_URL)` + `seed`, щоб усі int-тести мали мігровану тестову БД)
- Test: `packages/db/src/db.int.test.ts`

**Interfaces:**
- Consumes: `LOCAL_USER_ID`, `JOB_STATUSES`, `CAPABILITIES` із `@vf/shared`.
- Produces:
  ```ts
  type Db = PostgresJsDatabase<typeof schema>;
  const createDb: (url: string) => { db: Db; close: () => Promise<void>; ping: () => Promise<void> };
  const runMigrations: (url: string) => Promise<void>;
  const seed: (db: Db) => Promise<void>;                 // ідемпотентно: upsert користувача LOCAL_USER_ID і порожніх user_settings
  // schema.ts — таблиці: users, userSettings, jobs, assets, generations
  ```
  Колонки (spec §5): `users(id uuid pk, email text unique null, name text not null, created_at)`; `user_settings(user_id uuid pk → users, defaults jsonb not null default '{}' /* Partial<Record<Capability, ModelRef>> */, channel_style text not null default '', updated_at)`; `jobs(id uuid pk default gen_random_uuid(), user_id → users, type text, payload jsonb, status text check in JOB_STATUSES, progress real default 0, message text, error text, attempts int default 0, result jsonb, created_at, started_at, finished_at)` + індекс `(status, created_at)`; `assets` і `generations` — повністю за spec §5 без `embedding`.

- [ ] **Step 1: Failing test** `db.int.test.ts` (використовує `TEST_DATABASE_URL`, у `beforeAll` — `runMigrations` + `seed` двічі):
  - `seed` двічі поспіль не кидає і лишає рівно 1 рядок у `users` з `id = LOCAL_USER_ID`;
  - вставка `jobs` зі `status: 'weird'` кидає (check constraint);
  - вставка asset `{ title: 'Захід сонця над морем', tags: ['beach', 'sunset'], prompt: 'golden hour ocean' }` знаходиться запитом `search @@ websearch_to_tsquery('simple', 'sunset')`, а також `'Захід'`; пошук `'mountain'` повертає 0;
  - trigram: `similarity(title, 'Захид сонця') > 0.3` для того ж рядка (неточний збіг).
- [ ] **Step 2:** `docker compose up -d && pnpm vitest run packages/db` → FAIL.
- [ ] **Step 3:** Реалізувати `schema.ts`, `client.ts`, `seed.ts`, `migrate.ts` (CLI: `tsx src/migrate.ts` читає `DATABASE_URL`). Пошукова колонка — **ручна SQL-міграція** (drizzle-kit `--custom`): `create extension if not exists pg_trgm;` функція `create function vf_tags_text(text[]) returns text language sql immutable as $$ select coalesce(array_to_string($1, ' '), '') $$;` і `search tsvector generated always as (to_tsvector('simple', coalesce(title,'') || ' ' || vf_tags_text(tags) || ' ' || coalesce(prompt,''))) stored` + GIN-індекс на `search`, GIN `gin_trgm_ops` на `title`. Конфіг `'simple'`, бо контент багатомовний (у Postgres немає української конфігурації). Скрипти пакета: `generate`, `migrate`, `seed`.
- [ ] **Step 4:** `pnpm db:migrate && pnpm db:seed && pnpm vitest run packages/db` → PASS.
- [ ] **Step 5:** Commit `feat(db): schema, migrations with search, idempotent seed`.

---

### Task 4: `@vf/storage` — BlobStorage на S3 (RustFS)

**Files:**
- Create: `packages/storage/package.json` (deps: `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, `@vf/shared`), `packages/storage/src/{index,blob-storage,s3-blob-storage}.ts`
- Test: `packages/storage/src/s3.int.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface BlobStorage {
    put(key: string, body: Uint8Array | ReadableStream | NodeJS.ReadableStream, opts: { contentType: string }): Promise<void>;
    get(key: string): Promise<{ body: NodeJS.ReadableStream; contentType: string; size: number }>;  // нема → AppError('NOT_FOUND')
    delete(key: string): Promise<void>;                                   // ідемпотентно
    presignPut(key: string, opts: { contentType: string; expiresSec?: number /* 900 */ }): Promise<string>;
    presignGet(key: string, opts?: { expiresSec?: number /* 3600 */ }): Promise<string>;
    ensureBucket(opts?: { corsOrigins?: string[] }): Promise<void>;     // створює бакет, якщо нема; ставить CORS (PUT/GET/HEAD, ETag у ExposeHeaders)
    ping(): Promise<void>;                                                // HeadBucket з таймаутом 2 с
  }
  interface S3Config { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string; forcePathStyle: boolean }
  const createS3BlobStorage: (cfg: S3Config) => BlobStorage;
  const s3ConfigFromEnv: (env: NodeJS.ProcessEnv) => S3Config;
  ```

- [ ] **Step 1: Failing test** `s3.int.test.ts` (ключі з префіксом `test/${randomUUID()}/`):
  - `ensureBucket({ corsOrigins: ['http://localhost:5173'] })` двічі не кидає;
  - `put` → `get` повертає ті самі байти й `contentType: 'image/png'`; `get` неіснуючого ключа → `AppError` `NOT_FOUND`; `delete` двічі не кидає;
  - `presignPut` → `fetch(url, { method: 'PUT', body, headers: { 'content-type': 'video/mp4' } })` → 200, потім `get` повертає ці байти;
  - `presignGet` → `fetch` → 200 і ті самі байти;
  - CORS: `fetch(presignPutUrl, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PUT' } })` → відповідь містить `access-control-allow-origin`;
  - `createS3BlobStorage({ ...cfg, endpoint: 'http://localhost:1' }).ping()` відхиляється протягом ≤ 3 с.
- [ ] **Step 2:** `pnpm vitest run packages/storage` → FAIL.
- [ ] **Step 3:** Реалізувати. `S3Client` з `requestChecksumCalculation: 'WHEN_REQUIRED'` (інакше presigned PUT від браузера ламається на S3-сумісних сховищах); `ping` через `AbortSignal.timeout(2000)`.
- [ ] **Step 4:** `pnpm vitest run packages/storage` → PASS. Якщо падають лише presigned/CORS-кейси через RustFS — застосувати запасний план Task 1 Step 4 і повторити.
- [ ] **Step 5:** Commit `feat(storage): S3 BlobStorage with presigned URLs and CORS`.

---

### Task 5: `@vf/jobs` — контракти, PgJobStore, InProcessQueue

**Files:**
- Create: `packages/jobs/package.json` (deps: `p-queue@^10`, `@vf/shared`, `@vf/db`), `packages/jobs/src/{index,types,serializable,pg-job-store,in-process}.ts`
- Test: `packages/jobs/src/serializable.test.ts`, `packages/jobs/src/in-process.int.test.ts`

**Interfaces:**
- Consumes: `JobRecord`, `JobEvent`, `JobStatus`, `JobType`, `TERMINAL_STATUSES`, `AppError` (`@vf/shared`); `Db`, `jobs` (`@vf/db`).
- Produces (spec §4.1 дослівно + сховище):
  ```ts
  interface JobContext { jobId: string; userId: string; progress(pct: number, message?: string): Promise<void>; signal: AbortSignal }
  interface JobDef<P = unknown, R = unknown> { type: JobType; concurrency: number; handler(payload: P, ctx: JobContext): Promise<R> }
  interface JobQueue {
    enqueue<P>(type: JobType, payload: P, opts: { userId: string; priority?: number }): Promise<string>;
    get(jobId: string): Promise<JobRecord>;             // нема → AppError('NOT_FOUND')
    cancel(jobId: string): Promise<void>;
    retry(jobId: string): Promise<string>;              // нова задача з тим самим type/payload/userId; лише з failed|cancelled, інакше AppError('CONFLICT')
    onEvent(listener: (e: JobEvent) => void): () => void;
  }
  interface WorkerRuntime { register(def: JobDef<any, any>): void; start(): Promise<void>; stop(): Promise<void> }
  interface JobStore {
    insert(row: { userId: string; type: JobType; payload: unknown }): Promise<JobRecord>;
    claim(id: string): Promise<JobRecord | null>;      // queued → running атомарно (UPDATE … WHERE status='queued' RETURNING); null, якщо вже не queued
    progress(id: string, pct: number, message: string | null): Promise<JobRecord>;
    finish(id: string, status: 'done' | 'failed' | 'cancelled', fields: { result?: unknown; error?: string }): Promise<JobRecord>;
    get(id: string): Promise<JobRecord | null>;
    listByStatus(statuses: JobStatus[]): Promise<JobRecord[]>;
  }
  const createPgJobStore: (db: Db) => JobStore;
  const assertSerializablePayload: (payload: unknown) => void;   // AppError('INVALID_PAYLOAD')
  const createInProcessJobs: (store: JobStore) => { queue: JobQueue; runtime: WorkerRuntime };
  ```

Поведінка `createInProcessJobs`:
- `enqueue`: невідомий тип (не зареєстрований) → `AppError('UNKNOWN_JOB_TYPE')`; перевірка `assertSerializablePayload`; `store.insert`; подія `queued`; якщо runtime запущено — поставити в `PQueue` цього типу (`concurrency` з `JobDef`).
- Виконання: `store.claim` (null → пропустити); `attempts + 1`; виклик `handler` з `AbortController.signal`; `progress` обрізається до `[0, 100]`, пише в store і шле подію; успіх → `done` з `result` і `progress 100`; виняток → `failed` з `error = message` (для `AppError` — `message`); якщо під час виконання викликано `cancel` → `cancelled` незалежно від результату handler.
- `cancel`: `queued` → одразу `cancelled` (handler ніколи не викликається); `running` → `abort()`; термінальний статус → no-op.
- `start()`: `running` → `failed` з `error: 'Перервано перезапуском сервера'`; `queued` → поставити в черги за `created_at`.
- `stop()`: abort усіх running, дочекатися `onIdle()` черг.

- [ ] **Step 1: Failing tests.**
  - `serializable.test.ts`: приймає `{ projectId: 'a', n: 1, flags: [true, null], nested: { s: 'x' } }`; відхиляє з `INVALID_PAYLOAD`: `{ buf: Buffer.from('x') }`, `{ fn: () => 1 }`, `{ d: new Date() }`, `{ m: new Map() }`, `{ n: NaN }`, `{ u: undefined }`, `{ big: 1n }`, циклічний об'єкт.
  - `in-process.int.test.ts` (реальна тестова БД; `beforeEach` очищає `jobs`; тестовий тип `debug.sleep` реєструється з handler, що кроками викликає `ctx.progress` і поважає `signal`):
    1. `enqueue` → події в порядку `queued → running → (progress…) → done`; `get` дає `status 'done'`, `progress 100`, `attempts 1`, `result` від handler.
    2. `concurrency: 1`, три задачі → максимум одночасно запущених handler = 1; при `concurrency: 2` — 2.
    3. handler кидає `new Error('boom')` → `failed`, `error: 'boom'`.
    4. `cancel` running → handler отримує `signal.aborted === true`, фінальний статус `cancelled`.
    5. `cancel` queued (runtime ще не запущено) → `cancelled`, після `start()` handler не викликається.
    6. Відновлення: вручну вставити рядки `running` і `queued` через store, `start()` → `running` став `failed` з `'Перервано перезапуском сервера'`, `queued` виконався до `done`.
    7. `enqueue('nope' as JobType, {})` → `UNKNOWN_JOB_TYPE`; `enqueue('debug.sleep', { b: Buffer.from('x') })` → `INVALID_PAYLOAD`, і рядок у `jobs` не створено.
    8. `retry` для `failed` → новий id, той самий payload; `retry` для `done` → `CONFLICT`.
- [ ] **Step 2:** `pnpm vitest run packages/jobs` → FAIL.
- [ ] **Step 3:** Реалізувати за інтерфейсами. `assertSerializablePayload` — рекурсивний обхід: дозволені лише `null`, `boolean`, скінченні `number`, `string`, масиви і об'єкти з `Object.getPrototypeOf(x) === Object.prototype || null`; цикли відстежуються через `WeakSet`.
- [ ] **Step 4:** `pnpm vitest run packages/jobs` → PASS.
- [ ] **Step 5:** Commit `feat(jobs): job contracts, Postgres job store, in-process queue with recovery`.

---

### Task 6: `@vf/ai` — інтерфейси, каталог, реєстр, адаптери тексту, FakeProvider

**Files:**
- Create: `packages/ai/package.json` (deps: `ai@^7`, `@ai-sdk/anthropic@^4`, `@ai-sdk/openai@^4`, `@ai-sdk/google@^4`, `zod@^4.6`, `@vf/shared`), `packages/ai/src/{index,types,catalog,credentials,registry}.ts`, `packages/ai/src/providers/{ai-sdk-text,anthropic,openai,google}.ts`, `packages/ai/src/fake/{index,png,wav,fake-object}.ts`
- Test: `packages/ai/src/registry.test.ts`, `packages/ai/src/fake/fake.test.ts`, `packages/ai/src/providers/ai-sdk-text.test.ts`, `packages/ai/src/providers/providers.live.test.ts`

**Interfaces:**
- Consumes: `Capability`, `ProviderId`, `ModelRef`, `parseModelRef`, `AppError` (`@vf/shared`).
- Produces:
  ```ts
  // types.ts — spec §7.1
  interface Word { text: string; startMs: number; endMs: number }
  interface GeneratedFile { bytes: Uint8Array; mime: string; width?: number; height?: number; durationMs?: number }
  interface TextGen  { generateText(req: { prompt: string; system?: string; maxOutputTokens?: number; signal?: AbortSignal }): Promise<string>;
                       generateObject<T>(schema: z.ZodType<T>, req: { prompt: string; system?: string; signal?: AbortSignal }): Promise<T> }
  interface ImageGen { generate(req: { prompt: string; aspect: '9:16' | '16:9' | '1:1'; n: number }): Promise<GeneratedFile[]> }
  interface TTS      { listVoices(language?: string): Promise<{ id: string; name: string; language: string }[]>;
                       synthesize(req: { text: string; voiceId: string; language: string; speed?: number }): Promise<{ audio: GeneratedFile; words?: Word[] }> }
  interface STT      { transcribe(req: { audio: Uint8Array; mime: string; language?: string }): Promise<{ text: string; words: Word[] }> }
  // VideoGen — інтерфейс оголошується тут (spec §7.1), реалізації (включно з fake) — у підпроєкті 1
  // catalog.ts
  interface CatalogEntry { ref: ModelRef; provider: ProviderId; capability: Capability; label: string;
    pricing?: { unit: '1M_tokens_in' | '1M_tokens_out' | 'image' | 'second' | '1K_chars'; usd: number }[];
    rateLimitPerMin?: number; wordTimestamps?: boolean }
  const CATALOG: readonly CatalogEntry[];
  // credentials.ts
  interface CredentialStore { get(userId: string, provider: ProviderId): Promise<string | null> }
  const createEnvCredentialStore: (env: NodeJS.ProcessEnv) => CredentialStore;  // anthropic→ANTHROPIC_API_KEY, openai→OPENAI_API_KEY, google→GOOGLE_API_KEY; fake→'fake' лише якщо AI_FAKE==='1'
  // registry.ts
  interface CatalogItem extends CatalogEntry { available: boolean }
  interface AiRegistry {
    catalog(userId: string): Promise<CatalogItem[]>;
    text(userId: string, ref: ModelRef): Promise<TextGen>;     // MODEL_NOT_FOUND | MODEL_UNAVAILABLE
    image(userId: string, ref: ModelRef): Promise<ImageGen>;   // у цьому підпроєкті — лише fake
    tts(userId: string, ref: ModelRef): Promise<TTS>;          // лише fake
    stt(userId: string, ref: ModelRef): Promise<STT>;          // лише fake
  }
  const createAiRegistry: (deps: { credentials: CredentialStore; catalog?: readonly CatalogEntry[] }) => AiRegistry;
  ```

- [ ] **Step 1: Заповнити `CATALOG`.** Текстові моделі Anthropic: `anthropic/claude-opus-5-5`, `anthropic/claude-sonnet-5-5`, `anthropic/claude-haiku-5-5`. Для OpenAI і Google — по дві актуальні текстові моделі (флагман + дешева), **id взяти з офіційних списків моделей** (`GET https://api.openai.com/v1/models`, `GET https://generativelanguage.googleapis.com/v1beta/models`) або документації в день реалізації. Fake: `fake/text`, `fake/image`, `fake/tts` (`wordTimestamps: true`), `fake/stt`.
- [ ] **Step 2: Failing tests.**
  - `registry.test.ts` (credentials-заглушка з ключем лише для `anthropic`, `AI_FAKE` вимкнено): `catalog()` — усі записи `anthropic/*` мають `available: true`, `openai/*` і `google/*` — `false`, записів `fake/*` немає; `text(u, 'anthropic/unknown-model')` → `MODEL_NOT_FOUND`; `text(u, <openai-ref>)` → `MODEL_UNAVAILABLE`; `image(u, 'anthropic/claude-sonnet-5-5')` → `MODEL_NOT_FOUND` (не та можливість). З `AI_FAKE=1` — записи `fake/*` присутні й доступні.
  - `fake.test.ts`: `fake/text` `generateText({ prompt: 'Привіт' })` двічі повертає однаковий рядок, що містить `'Привіт'`; `generateObject(z.object({ title: z.string(), scenes: z.array(z.object({ n: z.number(), kind: z.enum(['a','b']) })).min(2), note: z.string().optional() }), …)` повертає значення, що проходить `schema.parse`; `fake/image` з `aspect '9:16'` → PNG (перші 8 байтів `89 50 4E 47 0D 0A 1A 0A`), `width 540`, `height 960`; `fake/tts` для `'один два три'` → `words.length === 3`, `startMs` строго зростають, `words[0].startMs === 0`, `audio.mime === 'audio/wav'`, `audio.durationMs === words[2].endMs`; `fake/stt` повертає `words`, текст яких складає `text`.
  - `ai-sdk-text.test.ts` (модель — `MockLanguageModel` з `ai/test`): успіх → повертає текст моделі; модель кидає `APICallError` зі `statusCode: 401` і повідомленням `'invalid x-api-key'` → `AppError` `PROVIDER_ERROR`, `message` містить `'invalid x-api-key'`, `details: { provider: 'anthropic', status: 401 }`; помилка зі `statusCode: 429` → після ретраїв (`maxRetries: 2`) той самий `PROVIDER_ERROR` зі `status: 429`.
- [ ] **Step 3:** `pnpm vitest run packages/ai` → FAIL.
- [ ] **Step 4: Реалізувати.**
  - `ai-sdk-text.ts`: `createAiSdkTextGen(provider: ProviderId, model: LanguageModel): TextGen` — `generateText`/структурований вивід AI SDK 7 (`maxRetries: 2`), усі помилки → `AppError('PROVIDER_ERROR', …)`. `anthropic.ts`/`openai.ts`/`google.ts` — лише фабрики моделі з ключем (`createAnthropic({ apiKey })` тощо).
  - `fake/png.ts`: мінімальний PNG-енкодер (IHDR + один IDAT через `node:zlib.deflateSync` + IEND, CRC32) — суцільний колір, похідний від хешу промпта; розміри: `9:16 → 540×960`, `16:9 → 960×540`, `1:1 → 768×768`.
  - `fake/wav.ts`: тиша PCM 16-bit mono 16 kHz заданої тривалості; `fake/tts`: 300 мс на слово.
  - `fake/fake-object.ts`: `fakeValueFor(schema: z.ZodType)` — обхід JSON Schema з `z.toJSONSchema(schema)`: `object` → усі `required` властивості, `array` → `max(minItems, 1)` елементів, `string` → `'fake'`, `number|integer` → `minimum ?? 1`, `boolean` → `true`, `enum` → перше значення; результат проганяється через `schema.parse`.
- [ ] **Step 5:** `pnpm vitest run packages/ai` → PASS.
- [ ] **Step 6:** `providers.live.test.ts`: для кожного провайдера з ключем у `.env` — `generateText({ prompt: 'Відповідай одним словом: ок', maxOutputTokens: 10 })` повертає непорожній рядок (тест `skip`, якщо ключа нема). Запуск вручну: `pnpm test:live` (не входить у `pnpm test`).
- [ ] **Step 7:** Commit `feat(ai): capability interfaces, model catalog, registry, text adapters, fake provider`.

---

### Task 7: `apps/api` — Fastify + tRPC, composition root, роутери, задача `debug.sleep`

**Files:**
- Create: `apps/api/package.json` (deps: `fastify@^5.12`, `@fastify/cors@^11`, `@trpc/server@^11.19`, `zod@^4.6`, `@vf/shared`, `@vf/db`, `@vf/storage`, `@vf/jobs`, `@vf/ai`; scripts: `dev: tsx watch --env-file=../../.env src/main.ts`, `typecheck: tsc`), `apps/api/src/{main,app,config,trpc,context}.ts`, `apps/api/src/auth/single-user.ts`, `apps/api/src/routers/{index,health,settings,ai,jobs}.ts`, `apps/api/src/jobs/debug-sleep.ts`
- Test: `apps/api/test/{health,settings,ai,jobs,startup}.int.test.ts`, `apps/api/test/helpers.ts`

**Interfaces:**
- Consumes: усе з Tasks 2–6.
- Produces:
  ```ts
  // config.ts
  interface AppConfig { databaseUrl: string; s3: S3Config; apiPort: number; webOrigin: string; queueDriver: 'inprocess'; aiFake: boolean }
  const loadConfig: (env: NodeJS.ProcessEnv) => AppConfig;   // AppError('VALIDATION') з переліком відсутніх змінних
  // auth/single-user.ts
  interface AuthProvider { authenticate(req: FastifyRequest): Promise<{ userId: string }> }
  const singleUserAuth: AuthProvider;                         // завжди LOCAL_USER_ID
  // app.ts
  interface AppDeps { db: Db; storage: BlobStorage; jobs: { queue: JobQueue; runtime: WorkerRuntime }; ai: AiRegistry; auth: AuthProvider }
  const createApp: (cfg: AppConfig, overrides?: Partial<AppDeps>) => Promise<{ server: FastifyInstance; deps: AppDeps; close(): Promise<void> }>;
  // routers/index.ts
  type AppRouter = typeof appRouter;      // імпортується вебом як type-only: import type { AppRouter } from '@vf/api'
  ```
  Процедури tRPC (`/trpc`, Zod-валідація входів):
  - `health.check` → `{ db: 'up' | 'down'; storage: 'up' | 'down' }` (кожна перевірка з таймаутом 2 с, ніколи не кидає).
  - `settings.get` → `{ defaults: Record<Capability, { ref: ModelRef; available: boolean } | null>; channelStyle: string }`.
  - `settings.setDefault({ capability, ref })` → валідація через реєстр (запис існує, `capability` збігається, `available`), інакше `MODEL_NOT_FOUND` / `MODEL_UNAVAILABLE`.
  - `settings.setChannelStyle({ text })` (≤ 4000 символів).
  - `ai.catalog` → `CatalogItem[]`.
  - `ai.testModel({ ref })` (лише `text`) → `{ sample: string; ms: number }`; prompt `'Відповідай одним словом: ок'`, `maxOutputTokens: 10`.
  - `jobs.enqueueDebug({ durationMs: 100..60000, steps: 1..100 })` → `{ jobId }`; `jobs.get({ id })`; `jobs.cancel({ id })`; `jobs.retry({ id })` → `{ jobId }`.
  - `jobs.events({ id })` — **subscription** (async generator, SSE): першою віддає подію-знімок поточного стану; якщо статус термінальний — одразу завершується; інакше віддає події цієї задачі до термінальної й завершується.
  - `errorFormatter`: для `AppError` додає `data.appCode = code` і `data.details`; мапінг на tRPC-коди: `NOT_FOUND→NOT_FOUND`, `VALIDATION|MODEL_NOT_FOUND|MODEL_UNAVAILABLE|INVALID_PAYLOAD|UNKNOWN_JOB_TYPE→BAD_REQUEST`, `CONFLICT→CONFLICT`, `PROVIDER_ERROR→BAD_GATEWAY`, `INFRA_UNAVAILABLE→SERVICE_UNAVAILABLE`, інше → `INTERNAL_SERVER_ERROR`.
  - `jobs/debug-sleep.ts`: `JobDef<{ durationMs: number; steps: number }, { sleptMs: number }>`, `type: 'debug.sleep'`, `concurrency: 2`; рівні кроки, `ctx.progress(round(100*i/steps), \`Крок ${i}/${steps}\`)`, переривання за `signal`.
  - `createApp`: `createDb` → `ping()` (помилка → `AppError('INFRA_UNAVAILABLE', 'Postgres недоступний за DATABASE_URL. Запустіть: docker compose up -d')`); `storage.ensureBucket({ corsOrigins: [webOrigin] })` — помилку лише логувати; реєстр AI з `createEnvCredentialStore`; `createInProcessJobs(createPgJobStore(db))` + `register(debugSleep)` + `runtime.start()`; Fastify + `@fastify/cors` (`origin: webOrigin`) + tRPC-адаптер з `createContext` = `auth.authenticate(req)`.
  - `main.ts`: `loadConfig` → `createApp` → `listen({ port: apiPort })`; `AppError` → `console.error(message)` + `process.exit(1)`; `SIGINT/SIGTERM` → `close()` (зупиняє runtime, закриває БД).

- [ ] **Step 1: Failing tests** (усі через `createApp` з тестовою БД `TEST_DATABASE_URL`, `aiFake: true`, виклики через `appRouter.createCaller(ctx)` або `server.inject`):
  - `startup.int.test.ts`: `createApp({ ...cfg, databaseUrl: 'postgres://vf:vf@localhost:1/vf' })` відхиляється з `AppError` `INFRA_UNAVAILABLE`, `message` містить `'docker compose up -d'` *(Review Focus 1)*; `loadConfig({})` кидає `VALIDATION`, `message` містить `'DATABASE_URL'` і `'S3_BUCKET'`.
  - `health.int.test.ts`: нормальна конфігурація → `{ db: 'up', storage: 'up' }`; з `s3.endpoint: 'http://localhost:1'` — `createApp` не кидає, `health.check` → `storage: 'down'` протягом ≤ 3 с *(Review Focus 2)*.
  - `settings.int.test.ts`: `setDefault({ capability: 'text', ref: 'fake/text' })` → `get` повертає `{ ref: 'fake/text', available: true }`; `setDefault({ capability: 'text', ref: 'fake/image' })` → `MODEL_NOT_FOUND`; для `anthropic/claude-sonnet-5-5` без ключа → `MODEL_UNAVAILABLE`; записати в `user_settings.defaults` напряму `{ text: 'openai/gone-model' }` → `settings.get` повертає `{ ref: 'openai/gone-model', available: false }` без помилки *(Review Focus 4)*; `setChannelStyle` зберігається.
  - `ai.int.test.ts`: `ai.catalog` містить `fake/text` з `available: true`; `ai.testModel({ ref: 'fake/text' })` → `sample` непорожній; з підміненим реєстром (`overrides.ai`), чий `TextGen` кидає `AppError('PROVIDER_ERROR', '401 invalid x-api-key')` → tRPC-помилка з `code: 'BAD_GATEWAY'`, `data.appCode: 'PROVIDER_ERROR'`, повідомлення містить `'invalid x-api-key'` *(Review Focus 3)*.
  - `jobs.int.test.ts`: `enqueueDebug({ durationMs: 300, steps: 3 })` → збираємо `jobs.events` до завершення: останній `status: 'done'`, `progress` неспадний і закінчується на `100`; підписка на вже завершену задачу віддає рівно одну подію (`done`) і завершується протягом 1 с *(Review Focus 5)*; `cancel` під час виконання → фінальна подія `cancelled`; `retry` скасованої → новий `jobId`; `jobs.get` неіснуючого id → `NOT_FOUND`.
- [ ] **Step 2:** `pnpm vitest run apps/api` → FAIL.
- [ ] **Step 3:** Реалізувати файли за інтерфейсами.
- [ ] **Step 4:** `pnpm vitest run apps/api` → PASS.
- [ ] **Step 5: Ручна перевірка.** `pnpm --filter @vf/api dev`, далі `curl -s 'http://localhost:3001/trpc/health.check'` → JSON з `"db":"up","storage":"up"`. Зупинити Postgres (`docker compose stop postgres`), перезапустити API → процес завершився з повідомленням українською про `docker compose up -d`. `docker compose start postgres`.
- [ ] **Step 6:** Commit `feat(api): fastify + tRPC app with health, settings, ai, jobs and SSE progress`.

---

### Task 8: `apps/web` — каркас SPA і сторінка «Налаштування»

**Files:**
- Create: `apps/web/package.json` (deps: `react@^19`, `react-dom@^19`, `@tanstack/react-router@^1.170`, `@tanstack/react-query@^5.104`, `@trpc/client@^11.19`, `@trpc/tanstack-react-query@^11.19`, `@vf/shared`; dev: `vite`, `@vitejs/plugin-react`, `@tanstack/router-plugin@^1.168`, `tailwindcss@^4.3`, `@tailwindcss/vite@^4.3`, `@playwright/test@^1.64`, `@vf/api` (лише типи); scripts: `dev: vite --port 5173 --strictPort`, `typecheck: tsc`, `e2e: playwright test`), `apps/web/{index.html,vite.config.ts,components.json,tsconfig.json,playwright.config.ts}`, `apps/web/src/{main.tsx,styles.css,lib/trpc.ts,lib/utils.ts}`, маршрути й компоненти зі «Структури файлів»
- Test: `apps/web/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `type AppRouter` з `@vf/api`; `CAPABILITIES`, `Capability`, `JobEvent` з `@vf/shared`.
- Produces: маршрути `/` (Проєкти), `/library` (Бібліотека), `/voice` (Студія озвучки), `/publications` (Публікації), `/analytics` (Статистика) — компонент `ComingSoon` з назвою розділу і номером підпроєкту; `/settings` — робоча сторінка.

- [ ] **Step 1:** Vite: плагіни `tanstackRouter({ target: 'react', autoCodeSplitting: true })`, `react()`, `tailwindcss()`; `server.proxy['/trpc'] = { target: 'http://localhost:3001' }` (SSE працює через проксі). Ініціалізувати shadcn/ui (`components.json`, alias `@/`), додати компоненти: `button`, `card`, `select`, `progress`, `badge`, `textarea`, `sonner`, `sidebar`.
- [ ] **Step 2:** `lib/trpc.ts`: `createTRPCClient<AppRouter>` з `splitLink({ condition: op => op.type === 'subscription', true: httpSubscriptionLink({ url: '/trpc' }), false: httpBatchLink({ url: '/trpc' }) })`; `createTRPCContext<AppRouter>()` з `@trpc/tanstack-react-query`. Помилки мутацій → toast (`sonner`) з `error.message`.
- [ ] **Step 3: Failing e2e** `e2e/settings.spec.ts`. `playwright.config.ts`: `webServer` — дві команди: `pnpm --filter @vf/api dev` (env `AI_FAKE=1`, чекати `http://localhost:3001/trpc/health.check`) і `pnpm --filter @vf/web dev` (чекати `http://localhost:5173`). Тести (тексти UI — точно ці):
  1. `/settings` показує бейджі «База даних: працює» і «Сховище: працює».
  2. Бічне меню містить «Проєкти», «Бібліотека», «Студія озвучки», «Публікації», «Статистика», «Налаштування»; клік «Бібліотека» показує «Скоро: підпроєкт 1».
  3. «Моделі за замовчуванням»: у селекті «Текст» вибрати «Fake · текст», перезавантажити сторінку → вибір збережено.
  4. «Перевірити» біля текстової моделі → з'являється відповідь моделі (непорожній текст).
  5. «Тестова задача»: «Запустити» (3 с, 5 кроків) → прогрес-бар росте, підпис «Крок N/5», фінал — бейдж «Готово» і 100%.
  6. «Запустити» (10 с) → «Скасувати» → бейдж «Скасовано»; кнопка «Повторити» запускає нову задачу.
  7. «Стиль каналу»: ввести текст, «Зберегти», перезавантажити → текст на місці.
- [ ] **Step 4:** `pnpm --filter @vf/web e2e` → FAIL.
- [ ] **Step 5: Реалізувати.**
  - `__root.tsx`: `SidebarProvider` + `AppSidebar` (пункти з іконками; активний підсвічено) + `<Outlet/>` + `<Toaster/>`.
  - `HealthCard`: `health.check` з `refetchInterval: 10_000`; бейджі «працює»/«недоступне»; якщо щось `down` — підказка «Запустіть `docker compose up -d`».
  - `ModelDefaults`: для кожної `Capability` (підписи: Текст, Зображення, Відео, Озвучка, Розпізнавання мови) — `Select` з моделей каталогу цієї можливості; недоступні моделі показані як вимкнені з позначкою «немає ключа»; збережена недоступна модель показана з бейджем «недоступна»; зміна → `settings.setDefault` + інвалідація `settings.get`. Можливість без жодної моделі в каталозі — текст «Немає моделей (з'являться в наступних підпроєктах)».
  - `TestModel`: кнопка «Перевірити» для текстової моделі → `ai.testModel`; показує відповідь і час (`ms`) або текст помилки.
  - `DebugJobCard`: поля тривалості й кроків, «Запустити» → `jobs.enqueueDebug` → `useSubscription(jobs.events)`; `Progress`, `message`, бейдж статусу (Очікує / Виконується / Готово / Помилка / Скасовано); «Скасувати» (поки не термінальний), «Повторити» (для failed/cancelled).
  - `ChannelStyle`: `Textarea` + «Зберегти».
- [ ] **Step 6:** `pnpm --filter @vf/web e2e && pnpm typecheck` → PASS.
- [ ] **Step 7:** Commit `feat(web): app shell, navigation and settings page with live job progress`.

---

### Task 9: Приймання підпроєкту 0 і README

**Files:**
- Create: `README.md`
- Modify: `turbo.json` (таски `dev`, `typecheck`), за потреби кореневий `package.json`

**Interfaces:**
- Consumes: усе попереднє.

- [ ] **Step 1:** `README.md` (українською): передумови (Docker Desktop, Node ≥ 24, `corepack enable`), швидкий старт (`cp .env.example .env`, `docker compose up -d`, `pnpm install`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev` → http://localhost:5173), де вписати AI-ключі, `AI_FAKE=1` для роботи без ключів, команди тестів (`pnpm test`, `pnpm test:live`, `pnpm --filter @vf/web e2e`), посилання на spec і цей план, примітка про RustFS (і SeaweedFS, якщо довелося перейти).
- [ ] **Step 2: Критерії «Готово» зі spec §12.1 — з чистого стану.**
  Run: `docker compose down -v && docker compose up -d && pnpm install && pnpm db:migrate && pnpm db:seed && pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @vf/web e2e`
  Expected: усе зелене.
- [ ] **Step 3: Ручна перевірка відновлення після рестарту.** `pnpm dev`; на `/settings` запустити тестову задачу на 60 с; на середині зупинити API (Ctrl+C у процесі API) і запустити знову → бейдж задачі «Помилка», текст «Перервано перезапуском сервера», «Повторити» запускає нову задачу до «Готово».
- [ ] **Step 4: Ключі (якщо є).** Вписати реальний ключ хоча б одного провайдера в `.env`, перезапустити API → на `/settings` моделі цього провайдера доступні, «Перевірити» повертає відповідь; `pnpm test:live` — зелений для провайдерів із ключами.
- [ ] **Step 5:** Commit `docs: README and sub-project 0 acceptance`.
