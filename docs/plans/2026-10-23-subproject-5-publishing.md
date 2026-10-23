# Підпроєкт 5 «Публікація» — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ручний шлях публікації для YouTube / TikTok / Instagram / Facebook + справжній YouTube-адаптер (OAuth, resumable upload, `publishAt`), AI-метадані під платформи, розклад через `Scheduler`, вкладка «Публікації» з матрицею «мовна версія × платформи».

**Architecture:** Новий пакет `packages/publish` (чисті функції метаданих і посилань, `Publisher`/`OAuthProvider`, YouTube- і fake-реалізації; HTTP через переданий `fetch`). У `apps/api/src/modules/publish` — акаунти (зашифровані токени, OAuth-callback на Fastify), публікації як рядок-стан, ідемпотентна задача `publish` (продовжує resumable-сесію), тік `publish.tick` раз на 60 с у наявному `createIntervalScheduler`, синхронна генерація метаданих із кешем. Web: сторінка `/publications`, діалог публікації, пункт у `RenderHistory`, бейдж у бічному меню.

**Tech Stack:** як у підпроєкті 4a (Node 24, pnpm 12, TypeScript 6.0.x, Vitest, Fastify 5, tRPC 11, Zod 4, Drizzle 0.45, Postgres 17, React 19, Vite 8, TanStack Router/Query, Tailwind 4, shadcn, sonner, Playwright). Нових npm-залежностей немає: шифрування й HMAC — `node:crypto`, HTTP — глобальний `fetch`.

**Spec:** `docs/specs/2026-10-23-subproject-5-publishing.md` (головне джерело); `docs/specs/2026-10-20-video-factory-design.md` §4, §4.1, §8.

**Уточнення до спеки (рішення плану):** (1) FK `publications.render_id` — `cascade`, а не `restrict`: захист живих публікацій робиться в `deleteProject`/`deleteAsset` (рендери окремо не видаляються, а `restrict` блокував би видалення проєкту навіть із завершеними публікаціями); (2) додано колонку `processing_since` для тайм-ауту обробки; (3) `UPSTREAM` = наявний код `PROVIDER_ERROR`; (4) `PUBLISH_TICK_MS` — щоб e2e не чекали хвилину; (5) у web клієнтські чисті функції — з `@vf/publish/client`.

## Global Constraints

- Гілка `feat/subproject-5-publishing` (від `main`). Нічого не пушити й не відкривати PR без слова власника. Не чіпати порт 3001 на хості й ніколи не виконувати `docker compose down`. AI-ключі, `YOUTUBE_CLIENT_SECRET` і `TOKEN_ENCRYPTION_KEY` — лише з `.env`, не друкувати й не логувати.
- Мова UI й повідомлень помилок — українська; ідентифікатори — англійська.
- `Platform = 'youtube' | 'tiktok' | 'instagram' | 'facebook'`. Статуси публікації: `scheduled | uploading | processing | published | awaiting_manual | failed | cancelled`; «живі» = `scheduled | uploading | processing | awaiting_manual`.
- Ліміти: YouTube назва ≤ 100 символів без `<`/`>`, опис ≤ 5000 байтів UTF-8, теги разом ≤ 500 символів. TikTok підпис ≤ 2200. Instagram підпис ≤ 2200, ≤ 30 хештегів. Facebook назва ≤ 255, опис ≤ 5000.
- YouTube: шматок 8 МіБ (`8 * 1024 * 1024`), до 5 повторів тимчасових помилок; `publishAt` передається, лише коли `scheduled_at > now + 5 хв`; категорія типово `'22'`; приватність типово `public`; `madeForKids` типово `false`; scope `https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly`, `access_type=offline`, `prompt=consent`. `state` OAuth живе 10 хв. Оновлення токена — коли `token_expires_at < now + 60 с`.
- Тік — 60 000 мс, `runOnStart: true`. Опитування `processing` — не частіше ніж раз на 60 с на рядок, тайм-аут обробки — 2 год. Паралельність задачі `publish` — 1.
- Коди помилок — наявний `ErrorCode` (`packages/shared/src/errors.ts`). `UPSTREAM` зі спеки = наявний `PROVIDER_ERROR`; нового коду не додавати.
- Тести: `*.test.ts` unit, `*.int.test.ts` int, `*.spec.ts` Playwright, `*.live.test.ts` — лише `pnpm test:live`. Vitest — у контейнері (`pnpm test`; фільтр `docker compose run --rm -T api pnpm vt --project <пакет> <фільтр>`). e2e — на хості (`pnpm --filter @vf/web e2e`, `api-e2e` :3101, Vite :5174). Наявні падіння через справжні AI-ключі в `.env` (voice.transcribe, generate, tagging, settings, library generate e2e) — не регресії.
- Кожна задача закінчується зеленими тестами зачеплених пакетів, `pnpm typecheck && pnpm lint` і комітом із рядком `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Рестарт API посеред завантаження YouTube** → завантаження продовжується з того самого `upload_session` (не нова сесія, не дубль відео); прострочена сесія (`404`/`410`) → нова сесія без помилки для користувача. Тести — Task 3 і Task 6.
2. **Два кліки «Опублікувати» або повтор `publish.create` для тієї самої версії й акаунта** → друга спроба `CONFLICT` «Ця версія вже публікується на цей акаунт», жодного другого відео. Тест — Task 5.
3. **Вставлене посилання з іншої платформи чи з трекінговими параметрами** (`https://youtu.be/ID?si=…`, `https://www.instagram.com/reel/CODE/?igsh=…`) → чуже — `VALIDATION`, своє з параметрами — правильний `platformPostId`. Тест — Task 2.
4. **Відкликаний доступ Google (`invalid_grant`)** → акаунт `reauth_required`, публікація `failed` з «Підключення до каналу втрачено — перепідключіть», інші публікації не зачеплені; повторне підключення того самого каналу повертає `active` без дубля акаунта. Тести — Task 4 і Task 6.
5. **Видалення проєкту чи файлу рендеру з живою публікацією** → `CONFLICT` з поясненням; після переходу публікацій у кінцевий стан видалення працює (публікації видаляються каскадом). Тест — Task 5.

---

## Структура файлів

```
packages/shared/src/{publish,jobs,index}.ts                       (+ publish.test.ts)
packages/db/src/schema.ts  packages/db/drizzle/0007_publishing.sql
packages/storage/src/{blob-storage,s3-blob-storage}.ts             (+ s3.int.test.ts)
packages/publish/{package.json,tsconfig.json}
packages/publish/src/{index,limits,copy,urls,types,google-oauth,youtube,fake}.ts
packages/publish/src/{limits,copy,urls,google-oauth,youtube}.test.ts  youtube.live.test.ts
packages/ai/src/prompts/publish-meta.ts                            (+ publish-meta.test.ts) packages/ai/src/index.ts
apps/api/src/{config,app}.ts  apps/api/src/routers/index.ts  apps/api/src/modules/recovery.ts
apps/api/src/modules/publish/{crypto,accounts,oauth-route,service,meta,job,tick,router}.ts  (+ crypto.test.ts, tick.test.ts)
apps/api/src/modules/{assets/search,projects/service}.ts           (захист від видалення)
apps/api/test/{publish-accounts,publish,publish-job}.int.test.ts
apps/web/vite.config.ts  apps/web/src/routes/publications.tsx  apps/web/src/components/AppSidebar.tsx
apps/web/src/components/publish/{PublicationsPage,AccountsStrip,AccountDialog,ConnectYoutubeDialog,PublishMatrix,PublicationCell,PasteLinkDialog,PublishDialog,MetaEditor,status}.tsx
apps/web/src/components/editor/RenderHistory.tsx
apps/web/e2e/publish.spec.ts
docker-compose.yml  .env.example  README.md
```

---

### Task 1: Спільні типи, схема БД, діапазон читання зі сховища

**Files:**
- Create: `packages/shared/src/publish.ts`, `packages/db/drizzle/0007_publishing.sql` (через `pnpm --filter @vf/db generate`)
- Modify: `packages/shared/src/{jobs,index}.ts`, `packages/db/src/schema.ts`, `packages/storage/src/{blob-storage,s3-blob-storage}.ts`
- Test: `packages/shared/src/publish.test.ts`, `packages/storage/src/s3.int.test.ts`, `packages/db/src/db.int.test.ts`

**Interfaces:**
- Produces (`@vf/shared`): `PLATFORMS`, `type Platform`; `PUBLISH_METHODS = ['api','manual']`; `PUBLICATION_STATUSES`, `type PublicationStatus`, `LIVE_PUBLICATION_STATUSES: ReadonlySet<PublicationStatus>`; `ACCOUNT_STATUSES = ['active','reauth_required']`; `publicationMetaSchema` (Zod: `title: string`, `description: string`, `tags: string[]`, `privacy?: 'public'|'unlisted'|'private'`, `madeForKids?: boolean`, `categoryId?: string`), `type PublicationMeta`; `PLATFORM_LABELS: Record<Platform, string>` (`YouTube`, `TikTok`, `Instagram`, `Facebook`). `JobType` + `'publish'`; `JobSubject.publicationId?: string` (і в `jobSubject`).
- Produces (`@vf/db`): таблиці `socialAccounts`, `publications`, `publishMetaDrafts` за спекою §2 + колонка `publications.processing_since timestamptz` (момент переходу в `processing`, для 2-годинного тайм-ауту). FK: `publications.project_id`, `render_id`, `account_id` — `on delete cascade` (захист живих публікацій — у сервісах, Task 5); `job_id` — `set null`. Часткові індекси: `unique(user_id, platform, external_id) where external_id is not null`; `unique(render_id, account_id) where status not in ('failed','cancelled')`. CHECK-и на enum-колонки — як у наявних таблицях (`inList`).
- Produces (`@vf/storage`): `BlobStorage.get(key, opts?: { fromByte?: number })` — S3 `Range: bytes=<fromByte>-`; `size` у відповіді — повний розмір об'єкта.

- [ ] **Step 1: Failing tests.** `publish.test.ts`: `publicationMetaSchema accepts minimal {title:'',description:'',tags:[]}`; `rejects privacy 'secret'`; `jobSubject picks publicationId`. `s3.int.test.ts`: `get with fromByte 3 of 'fake-mp4' returns '-mp4' and size 8`. `db.int.test.ts`: `second live publication for same render+account violates unique; failed one does not`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project shared publish` / `--project storage s3` / `--project db db` → FAIL.
- [ ] **Step 3:** Реалізувати типи, схему, згенерувати міграцію (перевірити, що в SQL є обидва часткові індекси), `fromByte` у S3-реалізації.
- [ ] **Step 4:** `pnpm db:migrate` (робоча БД) і ті самі тести → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(db): social accounts, publications and publish meta drafts`.

### Task 2: `packages/publish` — ліміти, копіювання, розбір посилань

**Files:**
- Create: `packages/publish/{package.json,tsconfig.json}` (за зразком `packages/captions`; `name: @vf/publish`, залежність `@vf/shared`), `packages/publish/src/{index,limits,copy,urls}.ts`
- Modify: `docker-compose.yml` (том `nm-publish:/app/packages/publish/node_modules` у `api` і в `volumes:`), `apps/api/package.json` (залежність `@vf/publish`)
- Test: `packages/publish/src/{limits,copy,urls}.test.ts`

**Interfaces:**
- Produces: `PLATFORM_LIMITS: Record<Platform, { title: number; titleRequired: boolean; description: number; descriptionBytes?: boolean; tagsTotal?: number; hashtags?: number }>`; `validateMeta(platform, meta): string[]` (порожній масив = ок); `clampMeta(platform, meta): PublicationMeta` (обрізка по останньому пробілу, теги — відкидати з кінця, `<`/`>` прибирати з назви YouTube); `formatForCopy(platform, meta): string`; `parsePostUrl(platform, url): { platformPostId: string | null } | null`.

- [ ] **Step 1: Failing tests.**
  - `limits.test.ts`: `youtube title 101 chars → ['Назва довша за 100 символів']`; `youtube title with '<' → error`; `youtube empty title → 'Назва обов'язкова'`; `youtube description 2500 cyrillic chars (5000 bytes) ok, 2501 → error`; `youtube tags joined > 500 → error`; `instagram 31 hashtags → error`; `tiktok empty title ok`; `clampMeta youtube title of 120 chars → ≤100, ends on word boundary`; `clampMeta drops trailing tags until total ≤ 500`.
  - `copy.test.ts`: `youtube → "Title\n\nDesc\n\nТеги: a, b"`; `tiktok → "Desc\n\n#a #b"`; `tags with leading '#' are not doubled`.
  - `urls.test.ts` (Review Focus 3): YouTube `watch?v=abcDEF12345`, `youtu.be/abcDEF12345?si=x`, `youtube.com/shorts/abcDEF12345`, `m.youtube.com/watch?v=…` → `abcDEF12345`; TikTok `tiktok.com/@u/video/7311111111111111111?is_from_webapp=1` → id, `vm.tiktok.com/ZMabc/` → `{ platformPostId: null }`; Instagram `instagram.com/reel/C1abc_-9/?igsh=x`, `/reels/…`, `/p/…` → `C1abc_-9`; Facebook `facebook.com/reel/123`, `facebook.com/watch/?v=123`, `facebook.com/MyPage/videos/123/`, `fb.watch/abc` → `123` / `null`; `parsePostUrl('youtube', 'https://www.tiktok.com/@u/video/1') → null`; `'not a url' → null`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm install` (новий пакет у томі), потім `docker compose run --rm -T api pnpm vt --project publish` → FAIL.
- [ ] **Step 3:** Реалізувати. Розбір — `new URL`, хост без `www.`/`m.`, далі шаблони шляхів.
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(publish): platform limits, copy text and post URL parsers`.

### Task 3: `packages/publish` — Google OAuth, YouTube-адаптер, fake-реалізації

**Files:**
- Create: `packages/publish/src/{types,google-oauth,youtube,fake}.ts`, `packages/publish/src/youtube.live.test.ts`
- Test: `packages/publish/src/{google-oauth,youtube}.test.ts`

**Interfaces:**
- Produces (`types.ts`, як у спеці §3): `UploadFile`, `AccessTokenSource = () => Promise<string>`, `Publisher`, `OAuthTokens = { accessToken; refreshToken?; expiresAt: Date; scopes: string[] }`, `OAuthProvider`, `PublishError extends Error { reason: 'quota' | 'auth' | 'rejected' | 'transient' | 'other'; platformReason?: string }`. До `Publisher.upload` додається `format: '9:16' | '16:9'` (для URL).
- Produces: `createGoogleOAuth({ clientId, clientSecret, fetch }): OAuthProvider`; `createYoutubePublisher({ fetch, chunkSize?, retryDelayMs? }): Publisher`; `createFakeOAuth(): OAuthProvider` (`authUrl` = `${redirectUri}?code=fake&state=${state}`, `exchange` → акаунт `{ externalId: 'fake-channel', name: 'Тестовий канал', profileUrl: 'https://www.youtube.com/@fake' }`); `createFakePublisher(platform): Publisher` (читає потік до кінця, `onSession('fake-session')`, `onProgress(100)`, id `fake-<uuid>`; `status → ready`).

- [ ] **Step 1: Failing tests** на підставному `fetch`, що записує запити:
  - `google-oauth.test.ts`: `authUrl contains client_id, both scopes, access_type=offline, prompt=consent, state, redirect_uri`; `exchange posts code → tokens; then GET channels?part=snippet&mine=true → account (id, title, https://www.youtube.com/<customUrl>)`; `refresh returns new access token and keeps old refresh token when none returned`; `refresh with {error:'invalid_grant'} → PublishError reason 'auth'`; `exchange when channels.items empty → PublishError 'auth' with 'На цьому Google-акаунті немає YouTube-каналу'`.
  - `youtube.test.ts`: `new upload: POST …/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status with X-Upload-Content-Length and body {snippet:{title,description,tags,categoryId:'22',defaultLanguage:'uk',defaultAudioLanguage:'uk'},status:{privacyStatus:'public',selfDeclaredMadeForKids:false}}`; `publishAt → privacyStatus 'private' + publishAt ISO`; `onSession called before first PUT`; `20 MiB file → 3 PUTs with Content-Range bytes 0-8388607/20971520, …, 16777216-20971519/20971520`; `resume: PUT bytes */size → 308 Range bytes=0-8388607 → continues from 8388608 (file.open(8388608))`; `resume 404 → new session`; `503 twice then 200 → success`; `403 quotaExceeded → PublishError 'quota', no retry`; `result url shorts/<id> for 9:16, watch?v=<id> for 16:9`; `status: processed → ready; rejected (rejectionReason 'duplicate') → failed with reason; uploaded → processing`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project publish google youtube` → FAIL.
- [ ] **Step 3:** Реалізувати. Помилки YouTube: `error.errors[0].reason` → `PublishError.platformReason`; `quotaExceeded`/`uploadLimitExceeded` → `quota`, `401`/`invalid_grant` → `auth`, `5xx`/мережа → `transient` (повтор з backoff `retryDelayMs · 2^n`, типово 1000), решта → `other`. `youtube.live.test.ts` (пропускається без `YOUTUBE_LIVE_REFRESH_TOKEN`): завантажує `apps/web/e2e/fixtures/tone.mp4` як `private` і чекає `status` ≠ `processing` до 5 хв.
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(publish): Google OAuth, YouTube resumable publisher and fakes`.

### Task 4: API — конфіг, шифрування, акаунти, OAuth-callback

**Files:**
- Create: `apps/api/src/modules/publish/{crypto,accounts,oauth-route,router}.ts`
- Modify: `apps/api/src/{config,app}.ts`, `apps/api/src/routers/index.ts`, `apps/web/vite.config.ts` (проксі `'/oauth'` → той самий target, що `/trpc`), `.env.example`, `docker-compose.yml` (`api-e2e`: `PUBLISH_FAKE: '1'`, `TOKEN_ENCRYPTION_KEY` — фіксований тестовий base64)
- Test: `apps/api/src/modules/publish/crypto.test.ts`, `apps/api/test/publish-accounts.int.test.ts`

**Interfaces:**
- Consumes: `OAuthProvider`, `createGoogleOAuth`, `createFakeOAuth`, `createYoutubePublisher`, `createFakePublisher` (Task 3).
- Produces (`AppConfig`): `youtube: { clientId?: string; clientSecret?: string; audited: boolean }`, `tokenKey?: Buffer` (32 байти; `loadConfig` кидає `VALIDATION`, якщо задано `YOUTUBE_CLIENT_ID` без коректного ключа), `publishFake: boolean`.
- Produces (`AppDeps`): `publish: { publishers: Partial<Record<Platform, Publisher>>; oauth: Partial<Record<Platform, OAuthProvider>>; tokenKey?: Buffer; redirectBase: string; youtubeAudited: boolean }`. За `publishFake` — fake для `youtube` (і `tokenKey` за замовчуванням тестовий); без client id і без fake — порожні записи.
- Produces (`crypto.ts`): `encryptJson(key, value): string` / `decryptJson<T>(key, s): T` (AES-256-GCM, формат `v1.<iv>.<tag>.<data>` base64url); `signState(key, { userId, language, platform }, now?): string` / `verifyState(key, s, now?)` → payload або `AppError('VALIDATION', 'Посилання підключення застаріло — спробуйте ще раз')`.
- Produces (`accounts.ts`): `listAccounts(deps, userId)` → без токенів + `{ youtubeConfigured, youtubeAudited }`; `createManualAccount`, `updateAccount`, `removeAccount` (`CONFLICT` «Акаунт має публікації в роботі», якщо є живі); `connectUrl(deps, userId, { platform: 'youtube', language })`; `completeOAuth(deps, { code, state })` → `accountId` (upsert за `(user, platform, external_id)`: токени, назва, мова, `status: 'active'`); `accessTokenFor(deps, account): AccessTokenSource` (refresh + збереження нових токенів; `PublishError 'auth'` → `status = 'reauth_required'` і перекидання).
- Produces (tRPC `publish.accounts.*`): `list`, `createManual({ platform, name, language, profileUrl? })`, `update({ id, name?, language?, profileUrl? })`, `remove({ id })`, `connectUrl({ platform: z.literal('youtube'), language })`.
- Produces (Fastify): `GET /oauth/youtube/callback?code&state[&error]` → `302 ${webOrigin}/publications?connected=<id>` або `?connectError=<denied|state|exchange>`.

- [ ] **Step 1: Failing tests.** `crypto.test.ts`: `encrypt/decrypt round-trip`; `decrypt with other key throws`; `state round-trip`; `state after 10 min + 1 s → VALIDATION`; `tampered state → VALIDATION`. `publish-accounts.int.test.ts` (з `PUBLISH_FAKE`): `createManual tiktok uk → listed without tokens fields`; `connectUrl → fake url; GET callback via server.inject → 302 ?connected=<id>, account youtube active with tokens_enc set, list has no tokens`; `callback twice for same channel → one account, language updated` (Review Focus 4); `callback with error=access_denied → ?connectError=denied`; `remove account with live publication → CONFLICT` (рядок публікації вставити напряму); `youtubeConfigured false when no client id and not fake`; `accessTokenFor with fake oauth whose refresh throws auth → account reauth_required`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api crypto publish-accounts` → FAIL.
- [ ] **Step 3:** Реалізувати; маршрут реєструється в `createApp` після tRPC-плагіна. Ні в логах, ні у відповідях не має бути токенів (у `list` — явний `select` колонок).
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(api): social accounts, encrypted tokens and YouTube OAuth callback`.

### Task 5: API — сервіс публікацій (версії, створення, ручний шлях, захист видалення)

**Files:**
- Create: `apps/api/src/modules/publish/service.ts`
- Modify: `apps/api/src/modules/publish/router.ts`, `apps/api/src/modules/assets/search.ts` (`deleteAsset`), `apps/api/src/modules/projects/service.ts` (`deleteProject`)
- Test: `apps/api/test/publish.int.test.ts`

**Interfaces:**
- Consumes: `validateMeta`, `parsePostUrl` (Task 2); схема (Task 1); `listAccounts` (Task 4).
- Produces (`service.ts`):
  - `listVersions(deps, userId, projectId?)` → `{ projectId, projectTitle, format, language, renderId, durationMs, thumbKey, renderedAt }[]` — останній `done`+`final` рендер з `output_asset_id` на (проєкт, `render.language ?? project.baseLanguage`).
  - `createPublications(deps, userId, items: { renderId; accountId; meta; scheduledAt?: string }[])` → `string[]`. Одна транзакція. Перевірки: рендер готовий і належить користувачу; акаунт `active`; мова акаунта не перевіряється (вибір користувача); `validateMeta` → `VALIDATION` з першою помилкою й `details.errors`; для YouTube з `scheduledAt` ≤ now + 5 хв, але > now → `VALIDATION` «Час публікації на YouTube має бути щонайменше через 5 хвилин». `method` = `account.method`. Стан: `manual` без часу або з часом ≤ now → `awaiting_manual`, інакше `scheduled`; `api` → `scheduled` (задачу ставить Task 6). Порушення часткового unique → `CONFLICT` «Ця версія вже публікується на цей акаунт».
  - `listPublications(deps, userId, { projectId?, status? })`, `pendingCount(deps, userId)` (`awaiting_manual`), `downloadUrl(deps, userId, id)` (`presignGet` з `downloadName` `<назва проєкту>-<мова>.mp4`), `markPublished(deps, userId, { id, url })` (лише `manual` і живий стан; `parsePostUrl` null → `VALIDATION` «Це не посилання на <Платформа>»; → `published`, `published_at = now`, `projects.status = 'published'`), `updateMeta(deps, userId, { id, meta, scheduledAt? })` (лише `scheduled`/`awaiting_manual`; manual зі зміненим часом у майбутньому → знову `scheduled`), `cancelPublication` (живий → `cancelled`; `uploading` — ще й `jobs.queue.cancel`), `retryPublication` (`failed` → `scheduled`, `error = null`, `scheduled_at` без змін).
  - `markProjectPublished(deps, projectId)` — спільний для ручного шляху й задачі.
  - `assertNoLivePublications(deps, where: { projectId } | { assetId })` → `CONFLICT` «Є публікації в роботі — скасуйте їх або дочекайтесь завершення»; викликається на початку `deleteProject` і `deleteAsset` (Review Focus 5).
- Produces (tRPC `publish.*`): `versions`, `create`, `list`, `pendingCount`, `downloadUrl`, `markPublished`, `updateMeta`, `cancel`, `retry` — сигнатури за спекою §6.

- [ ] **Step 1: Failing tests** (`publish.int.test.ts`; рендер готувати як у `renders.int.test.ts`, акаунти — `createManual`):
  - `versions returns latest done final render per language, ignores draft and failed`;
  - `create manual tiktok now → awaiting_manual; pendingCount 1`;
  - `create manual with future time → scheduled`;
  - `create twice same render+account → CONFLICT` (Review Focus 2); `after cancel → create again ok`;
  - `create youtube with title 101 chars → VALIDATION with details.errors`;
  - `create youtube scheduled in 2 min → VALIDATION`;
  - `markPublished with tiktok url → published, platform_post_id, projects.status published`; `with youtube url on tiktok publication → VALIDATION 'Це не посилання на TikTok'`;
  - `downloadUrl contains attachment filename`;
  - `cancel scheduled → cancelled; retry failed → scheduled`;
  - `deleteProject with awaiting_manual publication → CONFLICT; after markPublished → delete ok and publications gone`; `deleteAsset of render output with live publication → CONFLICT`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api publish.int` → FAIL.
- [ ] **Step 3:** Реалізувати. Для api-публікацій тут лише рядок `scheduled`; постановку задачі додає Task 6 (тести з YouTube-акаунтом у цій задачі перевіряють лише валідацію й дублікати).
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(api): publications service, manual path and delete guards`.

### Task 6: API — задача `publish`, тік планувальника, відновлення після рестарту

**Files:**
- Create: `apps/api/src/modules/publish/{job,tick}.ts`
- Modify: `apps/api/src/app.ts` (реєстрація задачі з `concurrency: 1`, `scheduler.every('publish.tick', cfg.publishTickMs, …, { runOnStart: true })`), `apps/api/src/config.ts` (`publishTickMs` з `PUBLISH_TICK_MS`, типово `60_000`), `docker-compose.yml` (`api-e2e`: `PUBLISH_TICK_MS: '2000'`), `apps/api/src/modules/recovery.ts`, `apps/api/src/modules/publish/service.ts` (`createPublications` і `retryPublication` після коміту викликають `enqueuePublish` для api)
- Test: `apps/api/src/modules/publish/tick.test.ts`, `apps/api/test/publish-job.int.test.ts`

**Interfaces:**
- Consumes: `Publisher`, `PublishError` (Task 3); `accessTokenFor` (Task 4); `markProjectPublished` (Task 5).
- Produces (`job.ts`): `publishJob(deps): JobDef<{ publicationId: string }, void>`; `enqueuePublish(deps, publication)` — умовний `UPDATE publications SET job_id = <new> WHERE id = … AND status = 'scheduled' AND (job_id IS NULL OR job not live)`; якщо рядок не оновився — задачу не ставити (поставлену скасувати). Повідомлення помилок: `quota` → «Вичерпано добову квоту YouTube API (скидається опівночі за тихоокеанським часом)»; `auth` → «Підключення до каналу втрачено — перепідключіть»; `youtubeSignupRequired` → «На цьому Google-акаунті немає YouTube-каналу»; інше → `Помилка YouTube: <platformReason ?? message>`.
- Produces (`tick.ts`): чиста `planTick(rows, now): { toAwaiting: string[]; toEnqueue: string[]; toPoll: string[]; toTimeout: string[] }` (правила спеки §5.2; `toPoll` — `processing` з `updated_at ≤ now − 60 с`; `toTimeout` — `processing_since ≤ now − 2 год`); `publishTick(deps, now = new Date())` (кожне опитування оновлює `updated_at`).
- Тайм-аут обробки → `failed` «YouTube не завершив обробку за 2 год». `status → ready` → `published`, `published_at = now`, `markProjectPublished`.
- Відновлення: у `reconcileAfterRestart` — `uploading` з неживою задачею → `scheduled` (`scheduled_at` без змін); тік поставить задачу.

- [ ] **Step 1: Failing tests.** `tick.test.ts`: `manual scheduled past → toAwaiting`; `manual scheduled future → nothing`; `api scheduled future without job → toEnqueue` (API-час — це час на платформі); `api scheduled with live job → nothing`; `processing updated 30 s ago → no poll; 61 s → poll`; `processing since 2 h 1 min → toTimeout`. `publish-job.int.test.ts` (fake publisher + fake oauth):
  - `create youtube now → job → processing with url; publishTick → published; projects.status published`;
  - `scheduled in 1 day → upload gets publishAt` (обгорнути fake publisher, щоб записати запит);
  - `publisher throws PublishError quota → failed with quota message; retry → scheduled → job again`;
  - `restart mid-upload` (Review Focus 1): publisher, що на першому виклику викликає `onSession('s1')` і зависає до `signal` → `app.close()` → нова `startApp` → публікація знову завантажується з `resume: 's1'`;
  - `accessTokenFor throws auth → publication failed with reauth message, account reauth_required, another manual publication untouched` (Review Focus 4);
  - `cancel during uploading → cancelled, job cancelled`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api tick publish-job` → FAIL.
- [ ] **Step 3:** Реалізувати. Файл для `upload`: asset рендеру → `{ size: asset.sizeBytes, contentType: 'video/mp4', open: (from) => storage.get(key, { fromByte: from }).then(r => r.body) }`. Прогрес — `ctx.progress`.
- [ ] **Step 4:** → PASS (разом із `publish.int`); `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(api): publish job with resumable uploads, scheduler tick and restart recovery`.


### Task 7: AI-метадані

**Files:**
- Create: `packages/ai/src/prompts/publish-meta.ts`, `apps/api/src/modules/publish/meta.ts`
- Modify: `packages/ai/src/index.ts`, `packages/ai/src/fake/*` (детермінована відповідь для схеми метаданих — за зразком того, як fake відповідає на схему сценарію), `apps/api/src/modules/publish/router.ts`
- Test: `packages/ai/src/prompts/publish-meta.test.ts`, `apps/api/test/publish.int.test.ts` (доповнити)

**Interfaces:**
- Produces (`@vf/ai`): `PUBLISH_META_PROMPT_VERSION = 1`; `publishMetaSchema` (Zod `Record<Platform, { title: string; description: string; tags: string[] }>` як `z.object` з чотирма ключами); `buildPublishMetaPrompt({ title, topic, language, format, narration: string[], channelStyle, limits }): { system: string; prompt: string }` — narration обрізається до 6000 символів сумарно; у промпті — мова відповіді, ліміти з `PLATFORM_LIMITS`, правила зі спеки §5.4 (YouTube 8–15 тегів, хук у перших 2 рядках опису; TikTok/Instagram — без назви, 3–5 хештегів; Facebook — назва + опис; Shorts/Reels для 9:16, довге відео для 16:9).
- Produces (`meta.ts`): `generateMeta(deps, userId, { projectId, language, force? }): Promise<{ variants: Record<Platform, PublicationMeta>; model: string; cached: boolean }>` — кеш `publish_meta_drafts`; модель — `user_settings.defaults.text` через `deps.ai.text(userId, ref)` як у `assets/tagger.ts`; запис у `generations` (`capability: 'text'`, `params: { purpose: 'publish-meta', projectId, language }`, `cost_estimate`); результат — `clampMeta` для кожної платформи; YouTube-варіант доповнюється `privacy: 'public'`, `madeForKids: false`, `categoryId: '22'`.
- Produces (tRPC): `publish.generateMeta`.

- [ ] **Step 1: Failing tests.** `publish-meta.test.ts`: `prompt mentions language and all four platforms`; `narration of 10 000 chars is cut to 6000`; `9:16 mentions Shorts, 16:9 does not`. Int: `generateMeta twice → second cached:true, one generations row`; `force → new generation`; `project without voice lines uses title and topic`; `youtube variant passes validateMeta`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project ai publish-meta` і `--project api publish.int` → FAIL.
- [ ] **Step 3:** Реалізувати.
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(ai): publish metadata prompt and cached generateMeta`.

### Task 8: Web — акаунти на сторінці «Публікації»

**Files:**
- Create: `apps/web/src/components/publish/{PublicationsPage,AccountsStrip,AccountDialog,ConnectYoutubeDialog}.tsx`
- Modify: `apps/web/src/routes/publications.tsx` (замість `ComingSoon`; `validateSearch` для `connected`/`connectError`)
- Test: перевіряється e2e у Task 11; тут — `pnpm typecheck && pnpm lint` і ручний огляд у прев'ю

**Interfaces:**
- Consumes: `publish.accounts.*` (Task 4).
- Produces: `PublicationsPage` (каркас: `AccountsStrip` зверху, слот під матрицю Task 9); `ConnectYoutubeDialog` — вибір мови (список мов як у налаштуваннях голосів) → `connectUrl` → `window.location.assign(url)`; кнопка вимкнена з tooltip «Додайте YOUTUBE_CLIENT_ID і YOUTUBE_CLIENT_SECRET у .env», коли `!youtubeConfigured`; підказка про режим Testing (7 днів) — під кнопкою. `AccountDialog` — створення/редагування ручного акаунта. Картка акаунта: іконка платформи, назва, мова, «API»/«Вручну», `reauth_required` — червоний бейдж «Потрібно перепідключити» + кнопка «Перепідключити» (той самий `connectUrl` з мовою акаунта). Тости `connected` → «Канал підключено», `connectError` → `denied`: «Доступ не надано», `state`: «Посилання підключення застаріло — спробуйте ще раз», `exchange`: «Не вдалося підключити канал»; потім `navigate({ search: {} , replace: true })`. `data-testid`: `accounts-strip`, `account-card`, `connect-youtube`, `add-manual-account`.

- [ ] **Step 1:** Реалізувати компоненти.
- [ ] **Step 2:** `pnpm typecheck && pnpm lint` → без помилок; прев'ю `/publications`: додати ручний акаунт, змінити, видалити.
- [ ] **Step 3:** Commit `feat(web): publications page accounts strip and YouTube connect`.

### Task 9: Web — матриця публікацій, дії комірок, бейдж

**Files:**
- Create: `apps/web/src/components/publish/{PublishMatrix,PublicationCell,PasteLinkDialog,status}.tsx`
- Modify: `apps/web/src/components/publish/PublicationsPage.tsx`, `apps/web/src/components/AppSidebar.tsx`

**Interfaces:**
- Consumes: `publish.versions`, `list`, `pendingCount`, `downloadUrl`, `markPublished`, `cancel`, `retry` (Task 5); `formatForCopy`, `PLATFORM_LABELS` (Task 1–2; `@vf/publish` додати в залежності web — лише чисті модулі, без `fake`/`youtube` у бандлі: імпортувати з підшляху `@vf/publish/client`, експорт у `package.json` → `src/client.ts`, що реекспортує `limits`, `copy`, `urls`); `useJobFeed` для `type === 'publish'` → інвалідація `publish.list`.
- Produces: `statusLabel(p, now): string` у `status.tsx` (`Заплановано · 24.10 18:00`, `Завантаження 42 %`, `Обробка на YouTube`, `Заплановано на YouTube · <час>` для `published` із `scheduled_at` у майбутньому, `Опубліковано`, `Чекає на вас`, `Помилка`, `Скасовано`); матриця з колонками з `PLATFORMS`, рядками з `versions`; фільтр «Потребують дій»; «+» у порожній комірці й кнопка «Опублікувати…» викликають `onPublish({ projectId?, language?, platform? })` (діалог — Task 10). Бейдж у `AppSidebar` біля «Публікації»: `pendingCount` з `refetchInterval: 60_000`, прихований при 0. `data-testid`: `publish-matrix`, `publication-cell` (з `data-platform`, `data-language`), `copy-meta`, `download-mp4`, `paste-link`, `pending-badge`.

- [ ] **Step 1:** Юніт `apps/web/src/components/publish/status.test.ts`: `scheduled → 'Заплановано · 24.10 18:00'` (фіксований `now`, локаль `uk-UA`); `published with future scheduled_at on youtube → 'Заплановано на YouTube · …'`; `uploading with job progress 42 → 'Завантаження 42 %'`. Запуск `docker compose run --rm -T api pnpm vt --project web status` → FAIL.
- [ ] **Step 2:** Реалізувати → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 3:** Commit `feat(web): publications matrix, manual actions and pending badge`.

### Task 10: Web — діалог публікації й вхід з історії рендерів

**Files:**
- Create: `apps/web/src/components/publish/{PublishDialog,MetaEditor}.tsx`
- Modify: `apps/web/src/components/publish/PublicationsPage.tsx`, `apps/web/src/components/editor/RenderHistory.tsx`

**Interfaces:**
- Consumes: `publish.versions`, `accounts.list`, `generateMeta`, `create` (Tasks 4–7); `validateMeta`, `PLATFORM_LIMITS` з `@vf/publish/client`.
- Produces: `PublishDialog({ open, onOpenChange, projectId?, language?, platform? })` — кроки спеки §7.2 одним екраном: «Що» (без `projectId` — спершу вибір проєкту з `versions`), «Куди» (акаунт за мовою вибрано за замовчуванням; кілька — `Select`; немає — «Немає акаунта <Платформа> для <мова>» + «Додати» → `AccountDialog` з наперед заданими платформою й мовою), «Метадані» (`MetaEditor`: вкладки мова × платформа, лічильники, помилки `validateMeta` під полями, YouTube — приватність, «Для дітей», категорія з короткого списку: 22 Люди й блоги, 27 Освіта, 24 Розваги, 28 Наука й техніка, 10 Музика, 20 Ігри, 17 Спорт, 26 Стиль і поради), «Коли» (`Зараз` / `datetime-local`), підказка про аудит при `!youtubeAudited`. `generateMeta` викликається для кожної вибраної мови при відкритті; «Згенерувати знову» — `force`. «Опублікувати» вимкнена, доки є помилки валідації. Після успіху — тост «Створено N публікацій» і закриття. У `RenderHistory` для `done`+`final` — пункт «Опублікувати…» (`data-testid="render-publish"`), що відкриває діалог із `projectId` і мовою рендеру. `data-testid`: `publish-dialog`, `publish-submit`, `meta-title`, `meta-description`.

- [ ] **Step 1:** Реалізувати.
- [ ] **Step 2:** `pnpm typecheck && pnpm lint`; прев'ю: з історії рендерів відкрити діалог, метадані заповнились (fake AI), створити ручну публікацію → у матриці «Чекає на вас».
- [ ] **Step 3:** Commit `feat(web): publish dialog with AI metadata and render history entry`.

### Task 11: E2E, документація, фінальна перевірка

**Files:**
- Create: `apps/web/e2e/publish.spec.ts`
- Modify: `README.md` (розділ «Публікація»: кроки Google Cloud зі спеки §10, змінні `.env`, обмеження аудиту й режиму Testing), `.env.example` (коментарі до нових змінних, якщо ще не додані в Task 4)

- [ ] **Step 1: e2e** (сценарій спеки §9): створити проєкт і готовий фінальний рендер (як у `editor.spec.ts`); на `/publications` додати ручний акаунт TikTok (uk) і підключити fake-YouTube (uk) через `connect-youtube` (fake redirect одразу повертає на `?connected=`) → тост «Канал підключено»; з `render-publish` відкрити діалог → `meta-title` YouTube не порожній → `publish-submit` → комірка YouTube «Опубліковано» з посиланням (тік в `api-e2e` — 2 с, Task 6), TikTok — «Чекає на вас», `pending-badge` = 1 → `paste-link` з `https://www.tiktok.com/@me/video/7311111111111111111` → «Опубліковано», бейдж зник; чуже посилання → помилка «Це не посилання на TikTok».
- [ ] **Step 2:** `pnpm --filter @vf/web e2e publish` → PASS; повний `pnpm --filter @vf/web e2e` — нових падінь немає (відомі падіння через AI-ключі — не регресії).
- [ ] **Step 3:** `pnpm test`, `pnpm typecheck && pnpm lint` → зелено (крім відомих).
- [ ] **Step 4:** Commit `test(e2e): publishing flow; docs: YouTube setup`.

---

## Покриття спеки

| Спека | Задача |
|---|---|
| §2 модель даних | 1 (+ `processing_since`, 6) |
| §3 пакет `publish` | 2, 3 |
| §4.1 OAuth | 3, 4 |
| §4.2–4.3 завантаження, обробка | 3, 6 |
| §5.1–5.3 стани, тік, задача | 5, 6 |
| §5.4 AI-метадані | 7 |
| §6 tRPC | 4, 5, 7 |
| §7 UI | 8, 9, 10 |
| §8 помилки | 4–6 |
| §9 тести | у кожній задачі; e2e і live — 3, 11 |
| §10 організаційне | 11 (README) |
