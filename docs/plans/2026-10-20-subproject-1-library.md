# Підпроєкт 1 «Бібліотека» — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закинути (drag & drop будь-де) або згенерувати з тексту фото/відео → файл у S3, метадані й мініатюра в БД, теги, пошук за словами й тегами; сторінка «Бібліотека».

**Architecture:** API переїжджає в Docker-контейнер з ffmpeg (сирці змонтовані, `tsx watch`); браузер вантажить файли напряму в RustFS через presigned PUT/multipart (Uppy без UI), API веде життєвий цикл `assets.status` (`uploading → processing → ready | failed`) і ставить задачі `asset.process`, `image.generate`, `video.generate`, `assets.tag` у наявну `InProcessQueue`. Модулі `assets` і `generate` у `apps/api` мають сервіси без tRPC (їх викликатиме конвеєр підпроєкту 4) і тонкі роутери; UI оновлюється через одну SSE-підписку `jobs.feed`.

**Tech Stack:** як у підпроєкті 0 (Node 24, pnpm 12, TypeScript 6.0.x, Vitest 5, Fastify 5, tRPC 11, Zod 4, Drizzle 0.45, Postgres 17, RustFS, `@aws-sdk/client-s3` v3, Vercel AI SDK 7, React 19, Vite 8, TanStack Router/Query, Tailwind 4, shadcn 4, Playwright) **+** Docker-образ `node:24-bookworm-slim` з `ffmpeg` (apt), пакет `openai@^7` (Sora), `@uppy/core@^6` + `@uppy/aws-s3@^6`.

**Spec:** `docs/specs/2026-10-20-subproject-1-library.md` (обсяг і рішення); `docs/specs/2026-10-20-video-factory-design.md` (§4 інтерфейси, §5 дані, §7 AI).

## Global Constraints

- Мова інтерфейсу й повідомлень помилок — українська; ідентифікатори коду — англійська.
- TypeScript 6.0.x (не 7); ESM; внутрішні пакети `@vf/<name>` з `"exports": { ".": "./src/index.ts" }`.
- Payload задач — лише JSON з ідентифікаторами (`{ assetId }`, `{ generationId }`); обробники ідемпотентні; прогрес лише через `ctx.progress`.
- Кожен запит фільтрується за `userId`; чужий id → `AppError('NOT_FOUND')`.
- Ключі S3 генерує лише сервер: `u/{userId}/assets/{assetId}/original.{ext}`, `u/{userId}/assets/{assetId}/thumb.webp`.
- Ліміти: фото `image/jpeg|png|webp|gif` ≤ 50 МБ; відео `video/mp4|quicktime|webm` ≤ 5 ГБ; аудіо `audio/mpeg|wav|x-wav|mp4|x-m4a|ogg` ≤ 500 МБ; multipart від 64 МБ, частини 16 МБ.
- Мініатюра: WebP, довша сторона 512 px; відео — кадр на ~10% тривалості.
- Прибирання: assets `uploading` старші за 24 год, раз на годину й на старті.
- `video.generate`: опитування кожні 10 с, таймаут 15 хв; `provider_op` зберігається одразу після `start`.
- AI-ретраї: 429/5xx — до 3 спроб з backoff; відмова контент-політики — без ретраїв, `PROVIDER_ERROR` з текстом провайдера.
- Нові змінні середовища: `S3_PUBLIC_ENDPOINT`, `API_HOST` (контейнер — `0.0.0.0`, за замовчуванням `127.0.0.1`), `FFMPEG_PATH`, `FFPROBE_PATH`, `SKIP_INSTALL`.
- Порти без змін: Postgres `5433`, RustFS `9000/9001`, API `3001`, web `5173`; e2e — API `3101`, web `5174`, БД `vf_test`, бакет `vf-media-test`.
- Тести: `*.test.ts` unit, `*.int.test.ts` int, `*.live.test.ts` live. Усі vitest-прогони — у контейнері `api`; Playwright — на хості.
- Id моделей і ціни в каталозі звіряються з документацією провайдерів під час Task 6/7 (дата перевірки — коментарем у `catalog.ts`).

## Review Focus

1. **Вертикальне відео з телефона** (ширина/висота закодовані горизонтально + `rotation` у side data) → `probe` повертає відображувані розміри (h > w), орієнтація «вертикальна», мініатюра не повернута. Тест — Task 3.
2. **Файл з «брехливим» розширенням/MIME** (`.mp4`, що насправді текст або PNG) → asset `failed` з поясненням, а не вічний `processing`. Тест — Task 9.
3. **Пошуковий запит зі спецсимволами** (`"`, `'`, `:`, `&`, `!`, `(`, емодзі, лише пробіли) → жодної SQL/tsquery-помилки, коректний (можливо порожній) результат. Тест — Task 10.
4. **Видалення asset під час `asset.process`** → задача завершується без помилки й не «воскрешає» рядок; мініатюра, що встигла завантажитись, видаляється. Тест — Task 9.
5. **Повторний `complete` і два файли з однаковим іменем одночасно** → `complete` ідемпотентний (повертає поточний стан, друга задача не ставиться); однакові імена дають два різні assets без колізії ключів. Тест — Task 9.

---

## Структура файлів

```
docker/api.Dockerfile  docker/api-entrypoint.sh  docker-compose.yml (+api, +api-e2e)
packages/media/src/{index,ffmpeg,probe,thumbnail,synth}.ts                (+ media.int.test.ts)
packages/storage/src/{blob-storage,s3-blob-storage,lazy-bucket}.ts        (+ s3.int.test.ts, lazy-bucket.test.ts)
packages/jobs/src/{types,in-process,pg-job-store,scheduler}.ts            (+ тести)
packages/shared/src/{jobs,media-limits,assets,settings}.ts                (+ тести)
packages/db/src/schema.ts  packages/db/drizzle/{0002_job_cancel,0003_library}.sql
packages/ai/src/{types,catalog,registry,cost}.ts
packages/ai/src/providers/{ai-sdk-image,ai-sdk-video,openai-sora,errors}.ts  (+ тести)
packages/ai/src/fake/{index,video}.ts  packages/ai/src/prompts/tagger.ts
apps/api/src/{app,config,main,trpc}.ts
apps/api/src/modules/assets/{service,search,process-job,tag-job,tagger,cleanup,router}.ts
apps/api/src/modules/generate/{service,image-job,video-job,router}.ts
apps/api/src/routers/{index,jobs,settings,health}.ts
apps/api/test/{assets-upload,assets-search,generate,tagging,queue}.int.test.ts
apps/web/src/components/upload/{UploadProvider,DropOverlay,UploadPanel,uppy}.ts(x)
apps/web/src/components/library/{LibraryToolbar,TagChips,PendingStrip,AssetGrid,AssetCard,AssetSheet,GenerateDialog}.tsx
apps/web/src/lib/job-feed.ts  apps/web/src/routes/library.tsx
apps/web/src/components/settings/{ModelDefaults,AutoTagToggle}.tsx
apps/web/e2e/{library.spec.ts,fixtures/photo.png,fixtures/clip.mp4}  apps/web/playwright.config.ts
```

---

### Task 1: API і тести в Docker

**Files:**
- Create: `docker/api.Dockerfile`, `docker/api-entrypoint.sh`
- Modify: `docker-compose.yml`, `package.json` (скрипти), `apps/api/src/config.ts`, `apps/api/src/main.ts`, `apps/web/playwright.config.ts`, `.env.example`, `README.md`, `.claude/launch.json` (лише web)

**Interfaces:**
- Produces: `AppConfig` += `apiHost: string`, `s3PublicEndpoint: string`, `ffmpegPath: string`, `ffprobePath: string`; кореневі скрипти `test`, `test:unit`, `test:live` запускають vitest у контейнері; `vt`, `vt:unit`, `vt:live` — сирі vitest-команди (те, що було `test*`).

- [ ] **Step 1:** `docker/api.Dockerfile`: `FROM node:24-bookworm-slim`; `apt-get install -y --no-install-recommends ffmpeg ca-certificates` (+ прибрати apt-lists); `corepack enable && corepack prepare pnpm@12.14.0 --activate`; `ENV PNPM_STORE_DIR=/pnpm-store`; `WORKDIR /app`; `ENTRYPOINT ["/app/docker/api-entrypoint.sh"]`; `CMD ["pnpm", "--filter", "@vf/api", "dev"]`.
- [ ] **Step 2:** `docker/api-entrypoint.sh` (`set -e`): якщо `SKIP_INSTALL` порожній — під `flock /app/node_modules/.vf-install.lock` порівняти `sha1sum pnpm-lock.yaml` з `/app/node_modules/.vf-lock-hash`, за розбіжності `pnpm install --frozen-lockfile` і записати хеш; далі `pnpm db:migrate`; `exec "$@"`. `chmod +x`.
- [ ] **Step 3:** `docker-compose.yml`, сервіс `api`: `build: { context: ., dockerfile: docker/api.Dockerfile }`, `ports: ['3001:3001']`, `volumes`: `.:/app`, `pnpm-store:/pnpm-store` і іменовані томи для кожного `node_modules` (`/app/node_modules`, `/app/apps/api/node_modules`, `/app/apps/web/node_modules`, `/app/packages/{shared,db,jobs,storage,ai,media}/node_modules`); `environment`: `DATABASE_URL=postgres://vf:vf@postgres:5432/vf`, `TEST_DATABASE_URL=postgres://vf:vf@postgres:5432/vf_test`, `S3_ENDPOINT=http://rustfs:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `API_HOST=0.0.0.0`; `depends_on: postgres (service_healthy), rustfs (service_started)`. Сервіс `api-e2e` (`profiles: [e2e]`): той самий образ і томи, `ports: ['3101:3101']`, `DATABASE_URL=…/vf_test`, `S3_BUCKET=vf-media-test`, `API_PORT=3101`, `WEB_ORIGIN=http://localhost:5174`, `AI_FAKE=1`, `SKIP_INSTALL=1`, `command: ["pnpm", "--filter", "@vf/api", "exec", "tsx", "src/main.ts"]`. Решта змінних — `env_file: .env` (змінні з `environment` мають пріоритет).
- [ ] **Step 4:** `config.ts`: `apiHost = env.API_HOST || '127.0.0.1'`, `s3PublicEndpoint = env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT`, `ffmpegPath = env.FFMPEG_PATH || 'ffmpeg'`, `ffprobePath = env.FFPROBE_PATH || 'ffprobe'`; `main.ts` слухає `cfg.apiHost`.
- [ ] **Step 5:** Кореневий `package.json`: перейменувати поточні `test`/`test:unit`/`test:live` на `vt`/`vt:unit`/`vt:live`; нові `test` = `docker compose run --rm api pnpm vt`, аналогічно `test:unit`, `test:live`. `dev` = `pnpm --filter @vf/web dev`.
- [ ] **Step 6:** `playwright.config.ts`: перший `webServer.command` = `docker compose --profile e2e up --build api-e2e` (передній план, Playwright зупиняє його сам), `url` = `http://localhost:3101/trpc/health.check`, `timeout: 180_000`, без `env`.
- [ ] **Step 7:** `.env.example`: додати `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `API_HOST=`, `FFMPEG_PATH=`, `FFPROBE_PATH=` з коментарями. README «Швидкий старт»: `cp .env.example .env` → `docker compose up -d --build` → `pnpm install` (для web на хості) → `pnpm dev`; «Тести»: `pnpm test` (у контейнері), e2e — потрібен запущений `docker compose up -d`; примітка: новий пакет у `packages/` = новий рядок тому `node_modules` у compose.
- [ ] **Step 8: Перевірка.**
  Run: `docker compose up -d --build && sleep 20 && curl -s localhost:3001/trpc/health.check`
  Expected: JSON з `"db":"up","storage":"up"`. `docker compose exec api ffprobe -version` — друкує версію.
  Run: `pnpm test` → усі 84 наявні тести проходять у контейнері. `pnpm --filter @vf/web e2e` → 7 наявних e2e проходять (API з контейнера `api-e2e`).
- [ ] **Step 9:** Commit `chore: run the API and tests in Docker with ffmpeg`.

---

### Task 2: Черга — виправлення, `Scheduler`, `jobs.feed`

**Files:**
- Modify: `packages/shared/src/jobs.ts`, `packages/jobs/src/{types,in-process,pg-job-store,index}.ts`, `packages/db/src/schema.ts` (`jobs.cancel_requested`), `apps/api/src/routers/jobs.ts`, `apps/api/src/trpc.ts`
- Create: `packages/jobs/src/scheduler.ts`, `packages/db/drizzle/0002_job_cancel.sql` (`pnpm --filter @vf/db generate`)
- Test: `packages/jobs/src/in-process.int.test.ts`, `packages/jobs/src/scheduler.test.ts`, `apps/api/test/jobs.int.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared/jobs.ts
  type JobType = 'debug.sleep' | 'asset.process' | 'image.generate' | 'video.generate' | 'assets.tag';
  interface JobSubject { assetId?: string; generationId?: string }
  interface JobEvent { jobId; userId: string; type: JobType; subject: JobSubject; status; progress; message; error }
  // jobs/types.ts — JobStore
  requestCancel(id: string): Promise<JobRecord | null>;   // ставить cancel_requested; null — уже термінальна
  claim(id)              // не бере задачу з cancel_requested: переводить її в cancelled і повертає null
  progress(id, pct, msg) // лише status='running'; повертає JobRecord | null
  finish(id, status, f)  // лише status in ('running','queued'); повертає JobRecord | null
  // jobs/scheduler.ts
  interface Scheduler { every(name: string, ms: number, fn: () => Promise<void>, opts?: { runOnStart?: boolean }): void; stop(): void }
  function createIntervalScheduler(log?: (msg: string, e: unknown) => void): Scheduler;
  // api: jobs.feed — subscription без input, JobEvent лише поточного userId
  ```
- [ ] **Step 1: Failing tests** (`in-process.int.test.ts`):
  - `cancel between claim and handler start ends cancelled` — обробник, що чекає 300 мс до першого `ctx.progress`; `cancel` одразу після події `running`; фінальний статус `cancelled`, обробник бачить `signal.aborted === true`.
  - `cancel of a queued job that is claimed concurrently never runs the handler` — `store.requestCancel` до `claim`; `claim` → `null`; статус `cancelled`; лічильник викликів обробника 0.
  - `late progress after cancel does not change status` — після `cancelled` викликати `store.progress(id, 90, 'x')` → `null`, у БД `cancelled`, `progress` не 90.
  - `stop() resolves within 10s even if a handler ignores abort` — обробник `await new Promise(() => {})`; `stop()` завершується за ≤ 10,5 с (vi fake timers не використовувати; тест з таймаутом 15 с).
  - `events carry userId, type and subject from payload` — `enqueue('debug.sleep', { durationMs: 100, steps: 1, assetId: '<uuid>' })` → подія має `subject.assetId`.
  - `scheduler.test.ts`: `runs on start and every interval` (fake timers: `every('x', 1000, fn, { runOnStart: true })` → 1 виклик одразу, 3 після `advanceTimersByTime(3000)`); `does not overlap a slow run`; `stop() clears timers`; помилка `fn` логується, наступні запуски тривають.
  - `jobs.int.test.ts`: `feed streams only own events` — два caller-и з різними `userId`; feed першого отримує подію своєї задачі й не отримує чужої.
- [ ] **Step 2:** `pnpm test` → нові тести FAIL.
- [ ] **Step 3:** Колонка `jobs.cancel_requested boolean not null default false`. `JobStore` за інтерфейсами вище; `in-process.cancel`: `cancelIfQueued` → інакше `requestCancel` + `controllers.get(id)?.abort()`; `execute` після `claim` перечитує `cancel_requested` (поле в `JobRecord` не виносимо — `claim` повертає рядок з колонкою; внутрішнє поле `cancelRequested` у `toRecord` не потрапляє, використовується лише в store) і абортить контролер. Події з `null` від store не емітяться. `stop()`: `Promise.race([onIdle всіх, sleep(10_000)])`. `emit` заповнює `subject` з `payload.assetId`/`payload.generationId`, якщо це рядки.
- [ ] **Step 4:** SSE у `jobs.events` і новий `jobs.feed`: спільний генератор `eventStream(ctx, filter, signal)` з **одним** `signal.addEventListener('abort', …)` на підписку (будить очікування через змінну `wake`). `feed` фільтрує `e.userId === ctx.userId`, без знімка, до abort.
- [ ] **Step 5:** `trpc.ts` `errorFormatter`: прибрати `shape.data.stack` (`const { stack: _, ...data } = shape.data`).
- [ ] **Step 6:** `pnpm test` → PASS (включно з наявними тестами черги).
- [ ] **Step 7:** Commit `fix(jobs): cancel flag, guarded progress/finish, stop timeout, scheduler, job feed`.

---

### Task 3: `@vf/media` — ffprobe, мініатюри, синтетичні фікстури

**Files:**
- Create: `packages/media/package.json` (deps `@vf/shared`), `packages/media/tsconfig.json`, `packages/media/src/{index,ffmpeg,probe,thumbnail,synth}.ts`
- Modify: `docker-compose.yml` (том `node_modules` уже додано в Task 1)
- Test: `packages/media/src/media.int.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface MediaTools { ffmpegPath: string; ffprobePath: string }
  interface MediaProbe { kind: 'image' | 'video' | 'audio'; mime: string; width?: number; height?: number; durationMs?: number }
  function run(bin: string, args: string[], opts?: { signal?: AbortSignal; timeoutMs?: number /* 60_000 */ }): Promise<{ stdout: Buffer; stderr: string }>;
  function probe(tools: MediaTools, path: string, opts?: { signal? }): Promise<MediaProbe>;
  function thumbnail(tools: MediaTools, input: string, output: string, opts: { kind: MediaProbe['kind']; durationMs?: number; signal? }): Promise<void>;
  function checkTools(tools: MediaTools): Promise<boolean>;   // ffprobe -version
  // synth.ts — для фікстур тестів і fake-провайдера
  function synthImage(tools, out: string, o: { width; height; color: string /* '#rrggbb' */; format: 'png' | 'jpg' }): Promise<void>;
  function synthVideo(tools, out: string, o: { width; height; durationSec; color: string; rotate?: 90 }): Promise<void>;
  function synthAudio(tools, out: string, o: { durationSec: number; format: 'mp3' | 'wav' }): Promise<void>;
  ```
- [ ] **Step 1: Failing tests** (кожен тест створює фікстури в `mkdtemp`):
  - `probes a png` → `{ kind: 'image', mime: 'image/png', width: 64, height: 48 }`, без `durationMs`.
  - `probes an mp4` (2 с, 320×180) → `kind: 'video'`, `mime: 'video/mp4'`, `width: 320`, `height: 180`, `durationMs` у `[1900, 2100]`.
  - `probes an mp3` → `kind: 'audio'`, `mime: 'audio/mpeg'`, `durationMs` ≈ 1000 (±150).
  - `rotated phone video reports display size` (`synthVideo` 320×180 з `rotate: 90`) → `width: 180`, `height: 320`.
  - `rejects a text file with VALIDATION` → `code: 'VALIDATION'`, `message` містить «Не вдалося прочитати файл».
  - `thumbnail of a video is a 512px webp` (відео 1280×720) → `probe(out)` = `{ kind: 'image', mime: 'image/webp', width: 512, height: 288 }`.
  - `thumbnail of a small image is not upscaled` (64×48) → 64×48.
  - `thumbnail of a rotated video is upright` → `height > width`.
  - `run times out` → `run('sleep', ['5'], { timeoutMs: 200 })` відхиляється з повідомленням про таймаут.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Реалізація. `run` — `spawn`, kill `SIGKILL` за таймаутом/abort, помилка з останніми 2000 символами stderr. `probe` — `ffprobe -v error -print_format json -show_format -show_streams`; `kind`: `format_name` містить `image2|png_pipe|jpeg_pipe|webp_pipe|gif` або один відеопотік з 1 кадром і без тривалості → `image`; є відеопотік → `video`; лише аудіо → `audio`. `mime` — з мапи `format_name`/`codec_name` (`mov,mp4,…` + `major_brand qt` → `video/quicktime`, інакше `video/mp4`; `matroska,webm` → `video/webm`; `mp3` → `audio/mpeg`; `wav` → `audio/wav`; `ogg` → `audio/ogg`; `mov,mp4` без відео → `audio/mp4`; `gif` → `image/gif`). Обертання: `side_data_list[].rotation` або `tags.rotate` = ±90/270 → поміняти width/height. `thumbnail` — `ffmpeg -y [-ss <10% тривалості> для відео] -i in -frames:v 1 -vf "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease" -c:v libwebp -q:v 80 out.webp` (ffmpeg сам застосовує autorotate).
- [ ] **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(media): ffprobe metadata, webp thumbnails, synthetic fixtures`.

---

### Task 4: `@vf/storage` — multipart, `head`, публічні presigned URL, лінивий бакет

**Files:**
- Modify: `packages/storage/src/{blob-storage,s3-blob-storage,index}.ts`
- Create: `packages/storage/src/lazy-bucket.ts`
- Test: `packages/storage/src/s3.int.test.ts`, `packages/storage/src/lazy-bucket.test.ts`

**Interfaces:**
- Produces (додається до `BlobStorage`):
  ```ts
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  createMultipart(key: string, opts: { contentType: string }): Promise<string>;           // uploadId
  presignPart(key: string, uploadId: string, partNumber: number, opts?: { expiresSec?: number }): Promise<string>;
  listParts(key: string, uploadId: string): Promise<{ PartNumber: number; ETag: string; Size: number }[]>;
  completeMultipart(key: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;                             // ідемпотентно
  // S3Config += publicEndpoint?: string — presign* (PUT, GET, part) підписуються клієнтом з цим endpoint
  // lazy-bucket.ts
  function createLazyBucket(storage: BlobStorage, opts: { corsOrigins: string[] }): { ensure(): Promise<void> };
  ```
- [ ] **Step 1: Failing tests:**
  - `multipart upload via presigned parts` — `createMultipart` → дві частини (5 МБ мінімум для першої — 5 MiB нулів, друга 10 байт) через `fetch(PUT)` на `presignPart` → `ETag` з відповіді → `listParts` повертає 2 → `completeMultipart` → `head` = `{ size: 5 MiB + 10 }`.
  - `head of a missing key is null`.
  - `abortMultipart is idempotent` — двічі без помилки; повторний `abort` неіснуючого uploadId не кидає.
  - `presigned urls use the public endpoint` — сховище з `publicEndpoint: 'http://public.example:9000'` → `presignPut`/`presignGet`/`presignPart` починаються з `http://public.example:9000/`.
  - `lazy-bucket.test.ts`: `retries after failure and memoizes success` — мок `ensureBucket` падає раз, потім ок: перший `ensure()` відхиляється, другий успішний, третій не викликає мок; паралельні виклики ділять один проміс.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізація (`HeadObjectCommand`, `CreateMultipartUploadCommand`, `UploadPartCommand` через `getSignedUrl`, `ListPartsCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand` з ігноруванням 404/`NoSuchUpload`; другий `S3Client` з `publicEndpoint` лише для підпису). `apps/api/src/config.ts` передає `publicEndpoint: s3PublicEndpoint`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(storage): multipart uploads, head, public presign endpoint, lazy bucket`.

---

### Task 5: Дані — міграція 0003 і спільні типи бібліотеки

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/shared/src/index.ts`
- Create: `packages/db/drizzle/0003_library.sql` (`pnpm --filter @vf/db generate`, GIN trigram на тегах дописати вручну), `packages/shared/src/{media-limits,assets,settings}.ts`
- Test: `packages/shared/src/media-limits.test.ts`, `packages/shared/src/assets.test.ts`, `packages/db/src/db.int.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared/media-limits.ts
  type AssetKind = 'image' | 'video' | 'audio';
  const MEDIA_LIMITS: Record<AssetKind, { mimes: readonly string[]; maxBytes: number }>;
  const MULTIPART_THRESHOLD = 64 * 1024 ** 2; const PART_SIZE = 16 * 1024 ** 2;
  function kindForMime(mime: string): AssetKind | null;
  function mimeFromName(name: string): string | null;            // за розширенням: .jpg .jpeg .png .webp .gif .mp4 .mov .webm .mp3 .wav .m4a .ogg
  function validateUpload(i: { name: string; mime: string; size: number }): { kind: AssetKind; mime: string; ext: string };  // кидає AppError('VALIDATION') з українським текстом і лімітом у МБ/ГБ
  // shared/assets.ts
  const ASSET_STATUSES = ['uploading', 'processing', 'ready', 'failed'] as const; type AssetStatus;
  type Orientation = 'vertical' | 'horizontal' | 'square';
  const assetKeys: { original(userId, assetId, ext): string; thumb(userId, assetId): string };
  function normalizeTags(tags: string[]): string[];               // trim, lower-case, без порожніх і дублів, ≤ 30, кожен ≤ 40 символів
  function titleFromName(name: string): string;                   // без розширення
  function titleFromPrompt(prompt: string): string;               // ≤ 80 символів, обрізка по слову + '…'
  // shared/settings.ts
  const DEFAULT_SLOTS = [...CAPABILITIES, 'tagger'] as const; type DefaultSlot;
  ```
  Схема: `assets` += `status` (default `'ready'`, check), `error`, `originalName`, `uploadId`, індекс `(user_id, status, created_at)`, GIN trigram на `vf_tags_text(tags)` (у SQL міграції вручну, як у 0001 для title); `generations` += `providerOp jsonb`, `assetIds uuid[] default '{}'`; `userSettings.defaults` типу `Partial<Record<DefaultSlot, ModelRef>>`, += `autoTagUploads boolean default false`.
- [ ] **Step 1: Failing tests:** `validateUpload` — 50 МБ PNG ок, 50 МБ + 1 → `VALIDATION` з «50 МБ»; `application/pdf` → `VALIDATION` «Непідтримуваний тип»; порожній `mime` + `clip.MOV` → `video/quicktime`, `ext: 'mov'`; 6 ГБ відео → «5 ГБ». `normalizeTags([' Кіт ', 'кіт', '', 'Space'])` → `['кіт', 'space']`; 31 тег → 30. `titleFromPrompt` 200 символів → ≤ 81 і закінчується `…`. `assetKeys.original('u1', 'a1', 'png')` = `u/u1/assets/a1/original.png`. `db.int.test.ts`: вставка asset без `status` → `ready`; `status: 'bogus'` → помилка check; пошук `similarity(vf_tags_text(tags), 'котк') > 0.3` знаходить asset з тегом `котик`.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізація + `pnpm --filter @vf/db generate` → перевірити SQL, дописати індекс trigram на тегах.
- [ ] **Step 4:** PASS (`pnpm test`; міграцію застосовує global-setup). **Step 5:** Commit `feat(db): library columns, upload limits, asset keys and tag rules`.

---

### Task 6: AI — каталог фото/відео, ImageGen-адаптери, вартість

**Files:**
- Modify: `packages/ai/src/{types,catalog,registry,index}.ts`, `packages/ai/src/providers/{openai,google}.ts`, `packages/ai/src/providers/ai-sdk-text.ts` (винести `toProviderError` у `errors.ts`)
- Create: `packages/ai/src/providers/{ai-sdk-image,errors}.ts`, `packages/ai/src/cost.ts`
- Test: `packages/ai/src/providers/ai-sdk-image.test.ts`, `packages/ai/src/cost.test.ts`, `packages/ai/src/registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // catalog.ts — CatalogEntry +=
  aspects?: Aspect[];                          // image/video
  sizes?: Partial<Record<Aspect, `${number}x${number}`>>;   // для моделей, що приймають size, а не aspectRatio
  durations?: number[];                        // video, секунди
  maxN?: number;                               // image
  cheap?: true; vision?: true;                 // text: fallback для тегера; вміє картинки
  // registry.ts — AiRegistry +=
  video(userId, ref): Promise<VideoGen>;
  // image(userId, ref) тепер повертає реальні адаптери openai/google
  // cost.ts
  function estimateCost(entry: CatalogEntry, u: { images?: number; seconds?: number; inputTokens?: number; outputTokens?: number }): number | null;
  ```
- [ ] **Step 1:** Звірити з документацією провайдерів (WebFetch сторінок моделей і цін OpenAI та Google) id і ціни: OpenAI — `gpt-image-2` і дешевша mini-модель; Google — Gemini Image (з `GoogleImageModelId` у `@ai-sdk/google`) і Imagen, якщо ще пропонується; відео — Veo 3.1 (звичайна й fast), Sora 2 (і Pro). Додати рядки з `pricing`, `aspects`, `sizes`/`durations`, `maxN`; на дешеві текстові (`claude-haiku-5-5`, `gpt-5.6-luna`, `gemini-3.8-flash`) — `cheap: true`; на всі текстові Claude/GPT/Gemini — `vision: true`. Fake: `fake/image` (`aspects: ['9:16','16:9','1:1']`, `maxN: 4`, ціна 0), `fake/video` (`durations: [2]`), `fake/text` — `cheap: true, vision: true`.
- [ ] **Step 2: Failing tests:**
  - `ai-sdk-image.test.ts` (`MockImageModelV4` з `ai/test`): `passes aspectRatio for models without sizes` (отримані `options.aspectRatio === '9:16'`); `passes size from catalog when present` (`size === '1024x1536'`, `aspectRatio` undefined); `returns n files with mime`; `maps 400 content policy to PROVIDER_ERROR without retry` (1 виклик); `retries 500` (3 виклики).
  - `cost.test.ts`: зображення `0.04 × 3 = 0.12`; відео `0.1 × 8 = 0.8`; токени `(1000 × 0.1 + 200 × 0.5) / 1e6`; модель без `pricing` → `null`.
  - `registry.test.ts`: `image('openai/…')` з ключем повертає адаптер; без ключа → `MODEL_UNAVAILABLE`; `video('fake/video')` при `AI_FAKE=1` повертає fake.
- [ ] **Step 3:** `createAiSdkImageGen(provider, model, entry): ImageGen` у `ai-sdk-image.ts` — `generateImage({ model, prompt, n, size | aspectRatio, maxRetries: 2, abortSignal })`, результат → `GeneratedFile { bytes, mime, width?, height? }`. `ImageGen.generate` req += `signal?: AbortSignal`. Відмова контент-політики: статус 400 і повідомлення провайдера — повертати без ретраю (`APICallError.isRetryable === false` AI SDK і так не ретраїть; переконатися тестом). Фабрики в `openai.ts`/`google.ts`: `openaiImage(key, model, entry)`, `googleImage(key, model, entry)`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(ai): image generation adapters, catalog for image/video, cost estimates`.

---

### Task 7: AI — VideoGen (Veo, Sora, fake) і vision для `generateObject`

**Files:**
- Modify: `packages/ai/src/{types,registry}.ts`, `packages/ai/src/fake/index.ts`, `packages/ai/src/providers/ai-sdk-text.ts`, `packages/ai/package.json` (`openai@^7`, `@vf/media`)
- Create: `packages/ai/src/providers/{ai-sdk-video,openai-sora}.ts`, `packages/ai/src/fake/video.ts`, `packages/ai/src/prompts/tagger.ts`
- Test: `packages/ai/src/providers/ai-sdk-video.test.ts`, `packages/ai/src/providers/openai-sora.test.ts`, `packages/ai/src/fake/fake.test.ts`, `packages/ai/src/providers/ai-sdk-text.test.ts`, `packages/ai/src/providers/providers.live.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  interface OpRef { provider: ProviderId; data: JSONValue }            // серіалізується в generations.provider_op
  type OpStatus = { state: 'pending' | 'running'; progress?: number } | { state: 'failed'; error: string };
  interface VideoGen {
    start(req: { prompt: string; aspect: Aspect; durationSec: number; signal?: AbortSignal }): Promise<OpRef>;
    poll(ref: OpRef, opts?: { signal?: AbortSignal }): Promise<OpStatus | GeneratedFile[]>;
  }
  // TextGen.generateObject req += images?: GeneratedFile[]; onUsage?: (u: { inputTokens: number; outputTokens: number }) => void
  // prompts/tagger.ts
  const TAGGER_PROMPT_VERSION = 1;
  const taggerSchema: z.ZodType<{ title: string; tags: string[] }>;   // tags 5..10
  function taggerPrompt(i: { mode: 'image' | 'prompt'; prompt?: string }): { system: string; prompt: string };
  // fake/video.ts
  function createFakeVideo(tools: MediaTools): VideoGen;   // poll: 'running' двічі, потім 2-с mp4 (synthVideo, колір із sha1 промпту, 540×960 або 960×540 / 768×768)
  ```
- [ ] **Step 1: Failing tests:**
  - `ai-sdk-video.test.ts` (мок `Experimental_VideoModelV4` з `doStart`/`doStatus`): `start returns serializable op` (`JSON.parse(JSON.stringify(ref))` дорівнює `ref`); `poll pending → running`; `poll completed → files` (base64/bytes → `GeneratedFile` з `mime: 'video/mp4'`; URL-дані — завантажуються через `fetch`); `poll error → failed with provider text`.
  - `openai-sora.test.ts` (мок клієнта з методами `videos.create/retrieve/downloadContent`): `start maps aspect to size and seconds`; `queued/in_progress → running with progress`; `completed → downloads mp4`; `failed → failed with error.message`.
  - `fake.test.ts`: `fake video completes after two polls` (у контейнері, з ffmpeg) → третій `poll` повертає 1 файл, `probe` = `video`, ≈ 2 с.
  - `ai-sdk-text.test.ts`: `generateObject sends images as file parts` (мок бачить у `prompt` user-повідомлення з part `type: 'file'`, `mediaType: 'image/webp'`); `reports usage` (`onUsage` отримує `{ inputTokens: 1, outputTokens: 1 }`).
  - `providers.live.test.ts` (+): по одному виклику `image` на дешевшій моделі кожного провайдера з ключем; `video` — лише `start` + один `poll` (не чекати завершення, щоб не платити за повну генерацію — або `it.skip` за відсутності `LIVE_VIDEO=1`); тегер з картинкою — схема проходить.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізація:
  - `createAiSdkVideoGen(provider, model: Experimental_VideoModelV4, entry)` — `model.doStart({ prompt, aspectRatio, duration, n: 1, … })` → `{ provider, data: operation }`; `poll` → `model.doStatus({ operation })`. Точні імена полів опцій `doStart`/`doStatus` взяти з `@ai-sdk/provider` d.ts (`VideoModelV4CallOptions`); якщо `doStart` у моделі відсутній — `AppError('MODEL_UNAVAILABLE', 'Модель не підтримує асинхронну генерацію')`. Фабрика `googleVideo(key, model, entry)` через `createGoogleGenerativeAI({ apiKey }).video(model)`.
  - `createSoraVideoGen(client: Pick<OpenAI, 'videos'>, model, entry)` у `openai-sora.ts`; фабрика `openaiVideo(key, model, entry)` = `new OpenAI({ apiKey, maxRetries: 2 })`. Розмір з `entry.sizes[aspect]`, тривалість — `seconds` (рядок, як вимагає API — перевірити типи пакета).
  - `registry.video` → fake / google / openai за провайдером; `fakeOnly` для `video` прибрати.
  - `generateObject` з `images` → `messages: [{ role: 'user', content: [...images.map(file part), { type: 'text', text: prompt }] }]`; `onUsage(res.usage)` (поля `inputTokens`/`outputTokens` з AI SDK 7 usage — `.total`, якщо об'єкт).
  - `fakeText.generateObject` для `taggerSchema` — детерміновано: `tags` = перші 5–10 унікальних слів промпту довжиною ≥ 3 (або `['fake','image','test','media','tag']`, якщо промпту немає), `title` = `titleFromPrompt`. Розпізнавати схему через прапорець: `taggerSchema` експортується з `prompts/tagger.ts`, fake порівнює посилання.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(ai): video generation (Veo, Sora, fake) and vision input for structured output`.

---

### Task 8: Модуль `assets` — завантаження (`createUpload` / `signParts` / `complete` / `abort`)

**Files:**
- Create: `apps/api/src/modules/assets/{service,router}.ts`
- Modify: `apps/api/src/app.ts` (deps: `media: MediaTools`, `bucket: { ensure() }`), `apps/api/src/routers/index.ts`, `apps/api/src/routers/health.ts` (`media: 'up'|'down'`, `bucket.ensure()` при `storage: 'up'`)
- Test: `apps/api/test/assets-upload.int.test.ts`

**Interfaces:**
- Consumes: `validateUpload`, `assetKeys`, `MULTIPART_THRESHOLD`, `PART_SIZE` (Task 5); `BlobStorage` multipart (Task 4); `JobQueue.enqueue` (Task 2).
- Produces:
  ```ts
  // modules/assets/service.ts
  type UploadTicket = { assetId: string; mode: 'single'; url: string } | { assetId: string; mode: 'multipart'; uploadId: string; partSize: number };
  function createUpload(deps: AppDeps, userId: string, i: { name: string; mime: string; size: number }): Promise<UploadTicket>;
  function signParts(deps, userId, i: { assetId: string; partNumbers: number[] }): Promise<{ partNumber: number; url: string }[]>;
  function listUploadedParts(deps, userId, assetId): Promise<{ PartNumber: number; ETag: string; Size: number }[]>;
  function completeUpload(deps, userId, i: { assetId: string; parts?: { PartNumber: number; ETag: string }[] }): Promise<{ status: AssetStatus }>;
  function abortUpload(deps, userId, assetId: string): Promise<void>;
  function ownAsset(deps, userId, assetId): Promise<AssetRow>;     // NOT_FOUND для чужого/неіснуючого/не-uuid
  // router: assets.createUpload | signParts | listParts | complete | abort
  ```
- [ ] **Step 1: Failing tests:**
  - `single upload: createUpload → PUT → complete → processing and job enqueued` — PNG з `synthImage` (`fetch(url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body })`); `complete` → `{ status: 'processing' }`; у `jobs` є `asset.process` з `payload.assetId`.
  - `multipart upload of 70 MB file` — `createUpload({ size: 70 MiB })` → `mode: 'multipart'`, `partSize: 16 MiB`; `signParts([1..5])`; PUT частин (вміст — нулі), ETag-и → `complete({ parts })` → `processing`.
  - `complete is idempotent` — другий `complete` → той самий статус, у `jobs` одна задача `asset.process` (Review Focus 5).
  - `two uploads with the same name get different keys` (Review Focus 5).
  - `complete without an uploaded object is VALIDATION and keeps uploading`.
  - `complete with a size mismatch is VALIDATION` (заявлено 1000, завантажено 10 байт).
  - `foreign asset is NOT_FOUND` для `signParts`/`complete`/`abort` (інший `userId` через `appRouter.createCaller`).
  - `abort removes the row and the multipart upload` — після `abort` `listParts` через storage кидає/порожньо, `ownAsset` → `NOT_FOUND`.
  - `createUpload rejects too large file before touching S3` — `VALIDATION`, рядків не додано.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізація; перед першим зверненням до S3 — `deps.bucket.ensure()`. У `createApp`: `checkTools(media)` — якщо `false`, `server.log.warn('FFmpeg/ffprobe недоступні — обробка медіа не працюватиме')`; `health.check` повертає `media` з того самого `checkTools` (кеш 30 с). Рядок `uploading`: `source: 'uploaded'`, `title: titleFromName(name)`, `originalName`, `mime`, `sizeBytes`, `kind`, `storageKey`. `complete`: якщо `status !== 'uploading'` → повернути поточний; multipart → `completeMultipart`; `head` (немає → `VALIDATION` «Файл не завантажено»; розмір ≠ `sizeBytes` → `VALIDATION`); `update … set status='processing', upload_id=null where status='uploading' returning` — лише якщо оновлено рядок, `enqueue('asset.process', { assetId })`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(api): direct-to-S3 uploads with multipart and idempotent completion`.

---

### Task 9: `asset.process` і прибирання завислих завантажень

**Files:**
- Create: `apps/api/src/modules/assets/{process-job,cleanup}.ts`
- Modify: `apps/api/src/app.ts` (реєстрація задачі; `createIntervalScheduler` → `every('assets.cleanup', 3_600_000, …, { runOnStart: true })` у `start()`, `stop()` у `close()`)
- Test: `apps/api/test/assets-upload.int.test.ts` (доповнення)

**Interfaces:**
- Consumes: `probe`, `thumbnail` (Task 3); `assetKeys` (Task 5); `ownAsset`/`createUpload`/`completeUpload` (Task 8); `tagAfterProcess` (Task 11 — до Task 11 викликається заглушка, що нічого не робить; Task 11 підміняє).
- Produces:
  ```ts
  const assetProcessJob: (deps: AppDeps) => JobDef<{ assetId: string }, { assetId: string }>;   // type 'asset.process', concurrency 2
  function cleanupStaleUploads(deps: AppDeps, olderThanMs = 86_400_000): Promise<number>;      // кількість видалених
  function retryProcess(deps, userId, assetId): Promise<{ jobId: string }>;                    // лише failed → processing
  ```
- [ ] **Step 1: Failing tests** (через `startApp()` і очікування статусу `ready`/`failed` хелпером `waitForAsset(caller, id, statuses, timeoutMs=15_000)`):
  - `processes an uploaded png into ready with metadata and thumbnail` — `width/height/mime`, `thumbKey` = `assetKeys.thumb(…)`, `storage.head(thumbKey)` існує.
  - `processes an mp4` → `durationMs` ≈ 2000, мініатюра є.
  - `processes an mp3` → `kind: 'audio'`, `thumbKey: null`.
  - `mp4 that is actually text fails with explanation` → `failed`, `error` містить «Не вдалося прочитати файл» (Review Focus 2).
  - `png uploaded as video/mp4 fails with kind mismatch` → `failed`, `error` містить «Тип файлу не збігається» (Review Focus 2).
  - `deleting the asset during processing ends quietly` — обробник з підміненим `deps.media` через override, що чекає 500 мс у `thumbnail`; видалити рядок під час чекання; задача `done`, рядка нема, `thumb` у S3 відсутній (Review Focus 4).
  - `retryProcess re-runs a failed asset`.
  - `cleanup removes uploading older than 24h` — вставити рядок `uploading` з `created_at = now() - 25h` і незавершеним multipart → після `cleanupStaleUploads` рядка нема, multipart скасовано; свіжий `uploading` лишився.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізація: рядок не `processing` → повернути (ідемпотентність); оригінал `storage.get` → `pipeline` у `mkdtemp` файл → `probe` → `kind` ≠ `row.kind` → `failed` «Тип файлу не збігається з розширенням: очікувалось <kind>, отримано <kind>»; image/video → `thumbnail` → `put(thumbKey, 'image/webp')`; фінальний `update … where id and status='processing' returning`; якщо 0 рядків → `storage.delete(thumbKey)` і повернути. Помилка `probe`/ffmpeg → `failed` з `e.message` (не кидати — задача `done`, бо asset несе статус; виняток — помилки БД/S3, вони кидаються, щоб задачу можна було повторити). Помилка `ENOENT` під час запуску ffmpeg/ffprobe → `failed` «FFmpeg недоступний у контейнері API». `rm -rf` теки у `finally`. Після `ready` — `await tagAfterProcess(deps, asset)`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(api): asset processing job and stale upload cleanup`.

---

### Task 10: Пошук і керування assets

**Files:**
- Create: `apps/api/src/modules/assets/search.ts`
- Modify: `apps/api/src/modules/assets/{service,router}.ts`
- Test: `apps/api/test/assets-search.int.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface AssetView { id; kind: AssetKind; source; status: AssetStatus; error: string | null; title; tags: string[]; mime;
    width: number | null; height: number | null; durationMs: number | null; sizeBytes: number | null; prompt: string | null;
    url: string; thumbUrl: string | null; createdAt: string;
    generation: { model: string; costEstimate: number | null } | null }
  interface ListInput { q?: string; kind?: AssetKind; source?: 'uploaded' | 'generated'; orientation?: Orientation; tags?: string[]; cursor?: string; limit?: number /* 60, ≤ 100 */ }
  function listAssets(deps, userId, i: ListInput): Promise<{ items: AssetView[]; nextCursor: string | null }>;
  function pendingAssets(deps, userId): Promise<AssetView[]>;          // uploading | processing | failed, новіші зверху, ≤ 50
  function getAsset / updateAsset(i: { id; title?: string /* ≤ 200 */; tags?: string[] }) / deleteAsset(deps, userId, id);
  function topTags(deps, userId, limit = 20): Promise<{ tag: string; count: number }[]>;
  // router: assets.list | pending | get | update | delete | retryProcess | tags
  ```
- [ ] **Step 1: Failing tests** (сід через пряму вставку `ready`-рядків з різними title/tags/prompt/розмірами):
  - `empty query lists newest first and only ready`.
  - `finds by title word`, `by tag`, `by prompt word` (згенерований asset з `prompt: 'кіт у космосі'` знаходиться за «космосі»).
  - `finds with a typo via trigram` — `котк` → asset з тегом `котик`; `soncet` → title `Sunset`.
  - `ranks exact matches above fuzzy`.
  - `filters by kind, source, orientation, tags (all must match)`.
  - `special characters never throw` — для кожного з `['"', "'", ':', '&', '!', '(', 'a & | b', '🐱', '   ', "o'neil"]` `list({ q })` резолвиться (Review Focus 3).
  - `cursor pagination returns disjoint pages` — 130 assets, `limit: 60` → 60 + 60 + 10, без повторів, `nextCursor` останньої `null`; те саме з `q`.
  - `isolates users` — чужі assets не видно в `list`, `get`, `tags`, `pending`.
  - `update normalizes tags` (`[' Кіт ', 'кіт']` → `['кіт']`) і `search` знаходить за новим тегом.
  - `delete removes S3 objects and the row`.
  - `topTags counts only ready assets of the user`.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізація за §4.1 специфікації. Запит з `q`: `tsq = websearch_to_tsquery('simple', $q)`; умова `(search @@ tsq OR similarity(title, $q) > 0.3 OR similarity(vf_tags_text(tags), $q) > 0.3)`; ранг `ts_rank(search, tsq) + greatest(similarity(title,$q), similarity(vf_tags_text(tags),$q))`; курсор — base64 JSON `{ o: offset }` для `q`, `{ c: createdAt, i: id }` без `q`. Порожній після `trim` `q` = без пошуку. URL-и — `storage.presignGet` (1 год). Видалення: `storage.delete` оригіналу й мініатюри, потім рядок (якщо `uploading` з `uploadId` — `abortMultipart`).
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(api): library search with full-text and trigram, asset management`.

---

### Task 11: Теги — з промпту, vision, налаштування

**Files:**
- Create: `apps/api/src/modules/assets/{tagger,tag-job}.ts`
- Modify: `apps/api/src/modules/assets/process-job.ts` (реальний `tagAfterProcess`), `apps/api/src/routers/settings.ts`, `apps/api/src/modules/assets/router.ts` (`assets.tag`), `apps/api/src/app.ts`
- Test: `apps/api/test/tagging.int.test.ts`, `apps/api/test/settings.int.test.ts`

**Interfaces:**
- Consumes: `taggerSchema`, `taggerPrompt`, `TextGen.generateObject({ images, onUsage })` (Task 7); `estimateCost` (Task 6); `DEFAULT_SLOTS` (Task 5).
- Produces:
  ```ts
  function resolveTagger(deps, userId): Promise<ModelRef | null>;     // defaults.tagger → defaults.text → перша доступна cheap+vision → null
  function tagAfterProcess(deps, asset: AssetRow): Promise<void>;     // generated → з промпту; uploaded && autoTagUploads → vision; інакше нічого
  function tagWithVision(deps, asset: AssetRow, opts?: { signal? }): Promise<void>;
  const assetsTagJob: (deps) => JobDef<{ assetId: string }, void>;   // type 'assets.tag', concurrency 2
  // settings.get → { defaults: Record<DefaultSlot, {ref, available} | null>, channelStyle, autoTagUploads: boolean }
  // settings.setDefault input { capability: DefaultSlot, ref } — 'tagger' валідується як capability 'text'
  // settings.setAutoTag({ enabled: boolean })
  ```
- [ ] **Step 1: Failing tests** (fake-провайдер):
  - `generated asset gets tags from its prompt` — `tags` непорожні, слова з промпту; рядок `generations` з `capability: 'text'`, `model: 'fake/text'`, `status: 'done'`.
  - `uploaded asset is not tagged when auto-tag is off`; `is tagged by vision when on` — `title` лишається ім'ям файлу, `tags` заповнені; вручну задані теги зберігаються (злиття, `normalizeTags`).
  - `tagging failure does not fail the asset` — тегер через override кидає `PROVIDER_ERROR`; asset `ready`, `generations.status = 'failed'` з текстом.
  - `no tagger model → skipped silently` (без fake і ключів: `aiFake: false`).
  - `assets.tag enqueues manual tagging` → теги з'являються.
  - `settings.int.test.ts`: `tagger default is validated as a text model` (`fake/image` → `MODEL_NOT_FOUND`); `autoTagUploads persists` (за замовчуванням `false`).
- [ ] **Step 2:** FAIL. **Step 3:** Реалізація. Vision: мініатюра (`storage.get(thumbKey)` → bytes, `image/webp`); для аудіо vision не викликається. Запис у `generations` — `prompt: 'tagger v<VERSION>'`, `params: { assetId, mode }`, `costEstimate` з `onUsage`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(api): prompt and vision tagging with settings toggle`.

---

### Task 12: Модуль `generate` — задачі фото й відео

**Files:**
- Create: `apps/api/src/modules/generate/{service,image-job,video-job,router}.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/routers/index.ts`
- Test: `apps/api/test/generate.int.test.ts`

**Interfaces:**
- Consumes: `ai.image`/`ai.video`/`ai.catalog`, `estimateCost` (Task 6–7); `assetKeys`, `titleFromPrompt` (Task 5); `assetProcessJob` (Task 9).
- Produces:
  ```ts
  function generateImage(deps, userId, i: { model: ModelRef; prompt: string /* 1..4000 */; aspect: Aspect; n: number /* 1..maxN */ }): Promise<{ generationId: string; jobId: string }>;
  function generateVideo(deps, userId, i: { model: ModelRef; prompt: string; aspect: Aspect; durationSec: number }): Promise<{ generationId: string; jobId: string }>;
  function estimate(deps, userId, i: { capability: 'image' | 'video'; model: ModelRef; n?: number; durationSec?: number }): Promise<{ usd: number | null }>;
  function listGenerations(deps, userId): Promise<GenerationView[]>;   // queued | running | failed за 7 днів, ≤ 50
  interface GenerationView { id; capability: 'image' | 'video'; model: ModelRef; prompt: string; status: JobStatus; error: string | null; jobId: string | null; progress: number; createdAt: string }
  const imageGenerateJob, videoGenerateJob: (deps) => JobDef<{ generationId: string }, { assetIds: string[] }>;
  // router: generate.image | video | estimate | list
  ```
- [ ] **Step 1: Failing tests:**
  - `image generation creates n generated assets that become ready` — `n: 2`, `fake/image`, `9:16` → 2 assets `source: 'generated'`, `prompt`, `generationId`, `title = titleFromPrompt`, після обробки `ready` з тегами; `generations.status = 'done'`, `asset_ids` довжини 2, `cost_estimate = 0`.
  - `rejects unsupported aspect or n before enqueuing` (`n: 5` → `VALIDATION`), `unavailable model → MODEL_UNAVAILABLE` (`openai/gpt-image-2` без ключа), рядків `generations` не додано.
  - `retrying a finished image job does not duplicate assets` — ще раз виконати обробник з тим самим `generationId` → assets лишилось 2.
  - `video generation polls until done and stores provider_op first` — `fake/video`; `provider_op` не null; asset `video`, `durationMs` ≈ 2000; прогрес-події монотонні.
  - `video job resumes from provider_op without calling start` — підміна `ai.video` шпигуном: рядок `generations` з готовим `provider_op`; обробник викликає лише `poll`, `start` — 0 разів.
  - `provider failure marks generation failed with provider text` — `poll` повертає `{ state: 'failed', error: 'content policy' }` → `generations.error` містить «content policy», задача `failed`.
  - `video timeout` — `poll` завжди `running`, таймаут через override на 1 с (параметр `timeoutMs` в `videoGenerateJob(deps, { pollMs, timeoutMs })`) → `failed` «Перевищено час очікування».
  - `estimate returns catalog price × n / × seconds`.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізація. Статус `generations` оновлюється разом із задачею: `running` на старті обробника, `done`/`failed` наприкінці (помилка — `error` і `throw`, щоб задача була `failed`). Відео: `poll` кожні `pollMs` (10 000) зі `sleep(…, { signal })`, `ctx.progress(min(95, elapsed/expected·100))`, де `expected` = 120 с; файл → asset → `put` → `asset_ids` → `enqueue('asset.process')`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(api): image and video generation jobs with resumable provider operations`.

---

### Task 13: Web — глобальне завантаження (Uppy, оверлей, панель)

**Files:**
- Create: `apps/web/src/components/upload/{uppy.ts,UploadProvider.tsx,DropOverlay.tsx,UploadPanel.tsx}`, `apps/web/src/lib/job-feed.ts`
- Modify: `apps/web/src/routes/__root.tsx`, `apps/web/package.json` (`@uppy/core@^6`, `@uppy/aws-s3@^6`)
- Test: e2e — Task 15

**Interfaces:**
- Consumes: `assets.createUpload | signParts | listParts | complete | abort` (Task 8), `jobs.feed` (Task 2).
- Produces:
  ```ts
  // uppy.ts
  function createUppy(client: typeof trpcClient): Uppy;   // @uppy/aws-s3: shouldUseMultipart(file) = size >= MULTIPART_THRESHOLD; getChunkSize = PART_SIZE;
                                                          // getUploadParameters/createMultipartUpload/signPart/listParts/completeMultipartUpload/abortMultipartUpload → tRPC;
                                                          // retryDelays [0, 1000, 3000, 5000, 10000]; file.meta.assetId зберігається з createUpload
  // UploadProvider.tsx
  function useUploads(): { addFiles(files: File[]): void; items: UploadItem[]; cancel(id): void; retry(id): void };
  interface UploadItem { id: string; name: string; progress: number; bytesPerSec: number; state: 'uploading' | 'processing' | 'done' | 'error'; error?: string; assetId?: string }
  // job-feed.ts
  function useJobFeed(onEvent: (e: JobEvent) => void): void;   // одна підписка на застосунок (у UploadProvider), роздає події підписникам через контекст
  ```
- [ ] **Step 1:** Перевірити в d.ts встановленого `@uppy/aws-s3` точні імена колбеків і форму `signPart` (`{ uploadId, key, partNumber, signal }` → `{ url }`) — підлаштувати `createUppy`; `key` = `assetId` (сервер знає справжній ключ).
- [ ] **Step 2:** `UploadProvider` у `__root.tsx` навколо layout: `dragenter`/`dragover`/`dragleave`/`drop` на `window` (лише коли `dataTransfer.types` містить `Files`; лічильник вкладеності для `dragleave`) → `DropOverlay` (`data-testid="drop-overlay"`, текст «Відпустіть, щоб додати в бібліотеку»); `drop` → `addFiles`. Відхилені валідацією файли — `toast.error` з текстом сервера. `beforeunload`, поки є `uploading`. Після `complete` стан `processing`; подія `jobs.feed` з `type: 'asset.process'` і `subject.assetId` у термінальному статусі → `done` (або `error`, якщо `assets.get` повертає `failed`) + `invalidateQueries` для `assets.list`/`assets.pending`.
- [ ] **Step 3:** `UploadPanel` (правий нижній кут, `data-testid="upload-panel"`, згортається): назва, `Progress`, швидкість (КБ/с, МБ/с), «Скасувати» (`assets.abort`), «Повторити»; заголовок «Завантаження (N)»; ховається, коли всі `done` і минуло 5 с.
- [ ] **Step 4:** Ручна перевірка в preview (`preview_start name=app`): перетягнути файл (або вибрати) → панель показує прогрес → «Обробка…» → ✓; `pnpm typecheck && pnpm lint` чисті.
- [ ] **Step 5:** Commit `feat(web): global drag and drop uploads with Uppy and upload panel`.

---

### Task 14: Web — сторінка «Бібліотека», діалог генерації, налаштування

**Files:**
- Create: `apps/web/src/components/library/{LibraryToolbar,TagChips,PendingStrip,AssetGrid,AssetCard,AssetSheet,GenerateDialog}.tsx`, `apps/web/src/components/settings/AutoTagToggle.tsx`; shadcn-компоненти за потреби (`dialog`, `tabs`, `toggle-group`, `switch`, `alert-dialog`, `scroll-area`) через `pnpm dlx shadcn@latest add …`
- Modify: `apps/web/src/routes/library.tsx`, `apps/web/src/routes/settings.tsx`, `apps/web/src/components/settings/ModelDefaults.tsx`
- Test: e2e — Task 15

**Interfaces:**
- Consumes: `assets.list | pending | get | update | delete | retryProcess | tag | tags` (Task 10–11), `generate.image | video | estimate | list` (Task 12), `settings.get | setDefault | setAutoTag` (Task 11), `useUploads`, `useJobFeed` (Task 13).
- Produces: route `/library` з `validateSearch` (Zod): `{ q?: string; kind?; source?; orientation?; tags?: string[] }`.
- [ ] **Step 1:** `library.tsx`: `LibraryToolbar` (пошук `aria-label="Пошук"`, debounce 300 мс → `navigate({ search })`; селекти «Тип», «Джерело», «Орієнтація»; кнопки «Завантажити» — прихований `<input type="file" multiple accept=…>` з `MEDIA_LIMITS` → `addFiles`; «Згенерувати» → `GenerateDialog`), `TagChips` (з `assets.tags`, активні виділені), `PendingStrip` (`data-testid="pending"`: `assets.pending` + `generate.list` з прогресом із `useJobFeed`; failed — «Повторити»/«Видалити»), `AssetGrid` (`useInfiniteQuery` + `IntersectionObserver`; порожній стан «Перетягніть файли сюди або згенеруйте перше зображення»).
- [ ] **Step 2:** `AssetCard` (`data-testid="asset-card"`, `aria-label={title}`): мініатюра `object-cover` квадрат; відео — бейдж тривалості `m:ss`, при `mouseenter` `<video muted loop autoplay src={url}>`; аудіо — іконка `Music` + тривалість. Клік → `AssetSheet`: перегляд, `Input` назви (збереження на blur/Enter), теги-чипи з × і полем «Додати тег» (Enter), метадані (розмір у МБ, `w×h`, тривалість, дата), для згенерованих — промпт, модель, вартість `$0.000`; кнопки «Згенерувати теги», «Завантажити файл» (`<a download href={url}>`), «Видалити» з `AlertDialog` «Видалити файл назавжди?».
- [ ] **Step 3:** `GenerateDialog`: `Tabs` «Фото»/«Відео»; `Textarea` «Опис» (обов'язково); селект «Модель» з `ai.catalog` за можливістю (недоступні `disabled` + « — немає ключа»; початкове значення — `settings.defaults.image|video`); `ToggleGroup` формату з `entry.aspects`; «Кількість» 1..`maxN` (фото) / «Тривалість» з `entry.durations` (відео); рядок «Орієнтовна вартість: ≈ $X» з `generate.estimate` (або «невідома»); «Згенерувати» → мутація → закрити, `toast` «Генерацію запущено», інвалідація `generate.list`.
- [ ] **Step 4:** Налаштування: `ModelDefaults` перебирає `DEFAULT_SLOTS` (мітка `tagger` — «Модель для тегів», список — текстові моделі); `AutoTagToggle` (`Switch` з `aria-label="Авто-теги для завантажених файлів"`, підказка «≈ $0.0001–0.0003 за файл на дешевій моделі»).
- [ ] **Step 5:** Ручна перевірка в preview: пошук, фільтри, картка, генерація fake-фото й відео з'являються в «В роботі», потім у сітці; `pnpm typecheck && pnpm lint` чисті.
- [ ] **Step 6:** Commit `feat(web): library page with search, filters, asset sheet and generation dialog`.

---

### Task 15: E2E, README, приймання

**Files:**
- Create: `apps/web/e2e/library.spec.ts`, `apps/web/e2e/fixtures/{photo.png,clip.mp4}` (згенерувати один раз у контейнері через `ffmpeg -f lavfi`: PNG 320×240, mp4 2 с 320×180; кожен ≤ 30 КБ)
- Modify: `apps/web/e2e/settings.spec.ts` (тест заглушки «Скоро: підпроєкт 1» замінити на перевірку, що «Бібліотека» відкриває сторінку з пошуком), `README.md`

- [ ] **Step 1: Тести** `library.spec.ts` (кожен тест — унікальні назви `e2e-<Date.now()>`, щоб не залежати від попередніх прогонів):
  - `upload via button shows progress and a ready card` — `setInputFiles` з `fixtures/photo.png` і `fixtures/clip.mp4` → `upload-panel` показує обидва → картки з `aria-label` назв у сітці, у відео бейдж `0:02`.
  - `drop anywhere shows overlay and uploads` — на `/settings` диспатчити `dragenter` з `DataTransfer` (файл через `page.evaluateHandle`) → `drop-overlay` видно → `drop` → панель завантажень → картка в бібліотеці.
  - `search by title and by tag` — завантажити, відкрити картку, додати тег `e2eтег<ts>` → пошук за тегом показує 1 картку; пошук за частиною назви з опечаткою показує її.
  - `delete asset` — «Видалити» → підтвердити → картки нема.
  - `generate image appears in progress and then in grid, found by prompt word` — «Згенерувати» → «Фото» → опис `e2e кіт космос <ts>` → модель `Fake · зображення` → «Згенерувати» → `pending` містить картку → картка в сітці → пошук `космос` знаходить її.
  - `generate video (fake)` → картка відео з бейджем тривалості.
  - `filters by kind and source` — фільтр «Відео» лишає лише відео; «Згенеровані» — лише згенеровані.
- [ ] **Step 2:** `pnpm --filter @vf/web e2e` → PASS (усі, включно з наявними).
- [ ] **Step 3:** README: розділ «Бібліотека» (завантаження, генерація, авто-теги й вартість), нові змінні, де дивитися файли (консоль RustFS), обмеження (формати, розміри). Відмітити підпроєкт 1 у таблиці/посиланнях на план і специфікацію.
- [ ] **Step 4: Приймання** (spec §10): `docker compose up -d --build && pnpm dev` → у браузері закинути фото/відео/аудіо, згенерувати fake-фото й відео, знайти за словом з промпту й за тегом з опечаткою; `pnpm test`, `pnpm --filter @vf/web e2e`, `pnpm typecheck && pnpm lint` — чисті. Скріншот сторінки бібліотеки — у PR.
- [ ] **Step 5:** Commit `test(web): library e2e; docs: README for sub-project 1`.
