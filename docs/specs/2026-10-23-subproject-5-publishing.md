# Підпроєкт 5 «Публікація» — специфікація

- **Дата:** 2026-10-23
- **Статус:** погоджено в обговоренні, очікує перегляду
- **Базова специфікація:** `docs/specs/2026-10-20-video-factory-design.md` (§1 критерій 4, §4 `Publisher`/`Scheduler`, §4.1 задачі, §5 модель даних, §8 публікація, §12 підпроєкт 5)
- **Попередні підпроєкти:** 0–4a (усі в `main`)
- **Гілка:** `feat/subproject-5-publishing` від `main`

## 1. Мета

Готову мовну версію відео (готовий рендер) опублікувати на YouTube через API, а на TikTok, Instagram Reels і Facebook — ручним шляхом з обліком у застосунку. Метадані (назва, опис, теги/хештеги) для кожної платформи готує AI, їх можна редагувати. Публікацію можна запланувати на дату й час. Вкладка «Публікації» показує матрицю «відео (мовна версія) × платформи» зі статусами, посиланнями, помилками й діями.

### Рішення власника (з обговорення)
| Питання | Рішення |
|---|---|
| Обсяг | **Ручний шлях для всіх 4 платформ + справжній YouTube-адаптер.** Адаптери TikTok і Meta (Instagram + Facebook) — окремий підпроєкт, коли будуть застосунки розробника |
| YouTube без аудиту | Прийнятно: завантаження працює одразу, але Google блокує як приватні відео з неперевіреного API-проєкту. Аудит YouTube API Services власник подає паралельно. Після аудиту код не змінюється |
| Акаунти | **Окремий канал на мову** на кожній платформі. Акаунт має мову, і мовна версія автоматично пропонується на свій канал |
| Метадані | **AI один раз на мовну версію** повертає варіанти для всіх 4 платформ (свої ліміти й стиль). Усе редагується перед публікацією |
| Розклад | **«Зараз» або дата й час** на кожну публікацію. Контент-плану зі слотами немає |
| YouTube-додатки | **Лише база:** завантаження, назва/опис/теги, приватність, «для дітей», категорія, `publishAt`. Без субтитрів, мініатюр і позначки синтетичного контенту |
| Архітектура | **Стан у БД + тік `Scheduler` + ідемпотентна задача `publish`** (той самий стиль, що й координатор конвеєра) |

## 2. Модель даних

Одна міграція Drizzle (`packages/db/src/schema.ts`).

```
social_accounts
  id, user_id, platform (youtube|tiktok|instagram|facebook), method (api|manual)
  name                 -- для api — назва каналу з платформи; для manual — введена
  language             -- мова каналу (обов'язкова); для автовибору акаунта
  external_id          -- channelId для api; null для manual
  profile_url          -- необов'язкове посилання на профіль
  tokens_enc           -- AES-256-GCM (ключ TOKEN_ENCRYPTION_KEY), лише api
  scopes text[], token_expires_at
  status (active|reauth_required), created_at, updated_at
  unique (user_id, platform, external_id) where external_id is not null

publications
  id, user_id, project_id, render_id, language, platform, account_id, method (api|manual)
  status (scheduled|uploading|processing|published|awaiting_manual|failed|cancelled)
  scheduled_at         -- null = «зараз»
  metadata jsonb       -- PublicationMeta (нижче)
  job_id, upload_session (URI resumable-сесії YouTube)
  platform_post_id, url, error, published_at, created_at, updated_at
  unique (render_id, account_id) where status not in ('failed','cancelled')
  index (user_id, status), index (project_id)

publish_meta_drafts    -- кеш AI-метаданих: повторне відкриття діалогу не платить вдруге
  project_id, language, variants jsonb (Record<Platform, PublicationMeta>),
  model, generation_id, created_at;  PK (project_id, language)
```

```ts
type Platform = 'youtube' | 'tiktok' | 'instagram' | 'facebook';
type PublicationMeta = {
  title: string;          // TikTok/Instagram — порожньо (у них немає назви)
  description: string;    // для TikTok/Instagram/Facebook — підпис
  tags: string[];         // YouTube — tags; інші — хештеги без «#»
  privacy?: 'public' | 'unlisted' | 'private';   // лише youtube, типово public
  madeForKids?: boolean;                          // лише youtube, типово false
  categoryId?: string;                            // лише youtube, типово '22'
};
```

- Публікується **готовий фінальний рендер** (`renders.status = 'done'`, `preset = 'final'`, `output_asset_id` не null). Мова — `render.language ?? project.baseLanguage`. «Мовна версія» в UI — останній такий рендер проєкту для мови.
- Видалення рендеру чи asset'а, на який посилається жива публікація (`scheduled`/`uploading`/`processing`/`awaiting_manual`), — заборонене (`AppError('CONFLICT')`); `render_id` — `on delete restrict`.
- `JobType` отримує `'publish'`; `JobSubject` — `publicationId`.
- Коли перша публікація проєкту стає `published`, `projects.status = 'published'`.
- `publication_stats` і `StatsCollector` — підпроєкт 6.

## 3. Пакет `packages/publish`

Новий пакет (+ рядок тому `nm-publish` у `docker-compose.yml`). Залежить лише від `@vf/shared`; HTTP — через переданий `fetch`, файл — через переданий відкривач потоку.

```ts
interface UploadFile { size: number; contentType: string; open(fromByte: number): Promise<Readable> }

interface Publisher {
  platform: Platform;
  /** Завантаження з продовженням: resume — збережений URI сесії */
  upload(req: {
    tokens: AccessTokenSource;            // () => Promise<string> — свіжий access token
    file: UploadFile;
    meta: PublicationMeta;
    language: string;
    publishAt?: Date;
    resume?: string;
    onSession(uri: string): Promise<void>; // зберегти URI до початку передачі байтів
    onProgress(pct: number): Promise<void>;
    signal: AbortSignal;
  }): Promise<{ platformPostId: string; url: string }>;
  status(tokens: AccessTokenSource, platformPostId: string):
    Promise<{ state: 'processing' | 'ready' | 'failed'; error?: string }>;
}

interface OAuthProvider {
  authUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<OAuthTokens & { account: { externalId: string; name: string; profileUrl: string } }>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
}
```

Також у пакеті (чисті функції, юніт-тести):
- `PLATFORM_LIMITS` — ліміти довжини: YouTube назва ≤ 100 символів, без `<`/`>`; опис ≤ 5000 байтів; теги разом ≤ 500 символів. TikTok підпис ≤ 2200. Instagram підпис ≤ 2200, ≤ 30 хештегів. Facebook назва ≤ 255, опис ≤ 5000. Плюс `validateMeta(platform, meta) → string[]` з українськими повідомленнями.
- `formatForCopy(platform, meta) → string` — текст для «Скопіювати метадані»: YouTube — назва, порожній рядок, опис, `Теги: …`; інші — підпис + хештеги `#tag` через пробіл.
- `parsePostUrl(platform, url) → { platformPostId: string | null } | null` (null — посилання не цієї платформи):
  - YouTube: `youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/shorts/ID`;
  - TikTok: `tiktok.com/@user/video/ID`; короткі `vm.tiktok.com/…`/`vt.tiktok.com/…` приймаються з `platformPostId: null` (без мережевого розкриття);
  - Instagram: `instagram.com/reel/CODE`, `/reels/CODE`, `/p/CODE`;
  - Facebook: `facebook.com/reel/ID`, `facebook.com/watch?v=ID`, `facebook.com/<page>/videos/ID`, `fb.watch/…` (з `null`).
- `createYoutubePublisher({ fetch })`, `createGoogleOAuth({ clientId, clientSecret, fetch })`.
- `createFakePublisher()` / `createFakeOAuth()` — для e2e та інтеграційних тестів (миттєве «завантаження», `fake-<uuid>` id, `status → ready`).

Ручний шлях адаптера не потребує: це поведінка сервісу для `method = 'manual'`.

## 4. YouTube

### 4.1 Підключення каналу (OAuth)
- Змінні `.env` (+ `.env.example`): `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (32 байти, base64; `openssl rand -base64 32`), `PUBLISH_FAKE` (`1` у `api-e2e`), `YOUTUBE_API_AUDITED` (`0`/`1`, лише для підказки в UI). Без client id/secret кнопка «Підключити YouTube» вимкнена з підказкою «Додайте YOUTUBE_CLIENT_ID і YOUTUBE_CLIENT_SECRET у .env». Без `TOKEN_ENCRYPTION_KEY` API не стартує, якщо задано client id.
- Redirect URI: `${WEB_ORIGIN}/oauth/youtube/callback`. Vite-проксі отримує правило `/oauth` → API (як `/trpc`). Google дозволяє `http://localhost` для web-клієнта.
- Потік: «Підключити YouTube» → діалог вибору мови каналу → `publish.accounts.connectUrl({ platform: 'youtube', language })` повертає URL Google (`scope = youtube.upload youtube.readonly`, `access_type=offline`, `prompt=consent`, `state`). `state` — HMAC-підписаний (ключ із `TOKEN_ENCRYPTION_KEY`) `{ userId, language, exp: +10 хв, nonce }`, тож таблиця станів не потрібна.
- Fastify-маршрут `GET /oauth/youtube/callback`: перевіряє `state` → `exchange` → `channels.list?mine=true` (назва, id, `customUrl`) → upsert `social_accounts` (той самий канал — оновлює токени, мову, `status = active`) → redirect на `/publications?connected=<accountId>`. Помилка чи відмова → `/publications?connectError=<код>` → тост українською.
- Токени шифруються AES-256-GCM (`apps/api/src/modules/publish/crypto.ts`). У відповіді tRPC їх ніколи немає.
- Оновлення: перед кожним викликом, якщо `token_expires_at < now + 60 с`, викликається `refresh`. `invalid_grant` → `status = reauth_required`, публікація `failed` з повідомленням «Підключення до каналу втрачено — перепідключіть». У списку акаунтів — кнопка «Перепідключити».
- **Обмеження режиму Testing** (документується в UI-підказці й README): поки OAuth-застосунок у статусі «Testing», refresh-токени Google живуть 7 днів, тож перепідключати доведеться щотижня. Перевести застосунок у «In production» можна без верифікації: з'явиться попередження «неперевірений застосунок», зате токени будуть постійні.

### 4.2 Завантаження
- Resumable upload: `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` з метаданими → URI сесії з `Location` → `onSession` (записується в `publications.upload_session` до передачі байтів).
- Передача шматками по 8 МіБ (кратно 256 КіБ) з `Content-Range`; потік з S3 через `BlobStorage.get` з `Range` (`UploadFile.open(fromByte)`). Прогрес — `onProgress` → `ctx.progress`.
- Продовження: якщо `resume` задано — `PUT` з `Content-Range: bytes */<size>` → `308` + `Range` → далі з наступного байта; `404`/`410` (сесія прострочена) → нова сесія.
- Тимчасові помилки (`5xx`, мережа) — до 5 повторів із backoff у межах задачі.
- `snippet`: `title`, `description`, `tags`, `categoryId`, `defaultLanguage` = `defaultAudioLanguage` = мова версії. `status`: `privacyStatus`, `selfDeclaredMadeForKids`; для запланованої — `privacyStatus: 'private'` + `publishAt` (ISO), а вибрана приватність ігнорується (YouTube сам відкриє відео в `publishAt`).
- Відповідь → `platformPostId`. URL: `https://www.youtube.com/shorts/<id>` для 9:16, `https://www.youtube.com/watch?v=<id>` для 16:9.
- `quotaExceeded` / `uploadLimitExceeded` → `failed`: «Вичерпано добову квоту YouTube API (скидається опівночі за тихоокеанським часом)». Без повторів.
- Shorts: 9:16 до 3 хв YouTube визначає сам; додаткових дій немає.

### 4.3 Обробка після завантаження
`status()` = `videos.list?part=status,processingDetails&id=…`: `uploadStatus = processed` → `ready`; `rejected`/`failed` → `failed` з `rejectionReason`/`failureReason`; інакше `processing`.

## 5. Потік публікації

### 5.1 Стани
```
api:    scheduled ──(тік: час настав)──▶ uploading ──▶ processing ──(тік: ready)──▶ published
                                            │              │
                                            └──▶ failed ◀──┘           (повторити → scheduled)
manual: scheduled ──(тік: час настав)──▶ awaiting_manual ──(вставлено посилання)──▶ published
будь-який не кінцевий ──(скасувати)──▶ cancelled
```
- Для API-публікацій `scheduled_at` — це час виходу **на платформі**, а не час завантаження. Задача `publish` ставиться **одразу** при створенні, «зараз» чи «за розкладом» (рядок створюється в `scheduled`, і `publish.create` одразу ставить задачу так само, як тік). Якщо `scheduled_at` більш ніж на 5 хв у майбутньому, передається як `publishAt` (нативний розклад YouTube), інакше відео виходить із вибраною приватністю. Після обробки статус `published`; поки `scheduled_at` у майбутньому, матриця показує «Заплановано на YouTube · <час>».
- Ручна з часом: `scheduled` → у потрібний момент тік переводить її в `awaiting_manual`. Ручна «зараз» створюється одразу в `awaiting_manual`. Вставити посилання можна в будь-якому не кінцевому стані ручної публікації.

### 5.2 `Scheduler`
Наявний `createIntervalScheduler` у `app.ts`: `scheduler.every('publish.tick', 60_000, publishTick, { runOnStart: true })`. `publishTick(deps)` (ідемпотентний, кожен крок — умовний `UPDATE … WHERE status = …`):
1. `manual` + `scheduled` + `scheduled_at ≤ now` → `awaiting_manual`.
2. `api` + `scheduled` без живої задачі (незалежно від `scheduled_at`) → поставити `publish` (захист від гонки — умовний `UPDATE` з `job_id`). Це страховка для повторів і рестартів; у звичайному потоці задачу ставить `publish.create`.
3. `api` + `processing` → `Publisher.status()` (не частіше ніж раз на 60 с на рядок; через 2 год у `processing` → `failed`: «YouTube не завершив обробку за 2 год»).

### 5.3 Задача `publish` `{ publicationId }`
1. Читає публікацію, акаунт, рендер, asset. Якщо публікація вже `processing`/`published`/`cancelled` — нічого не робить (ідемпотентність).
2. `status = uploading`, `job_id`.
3. `Publisher.upload({ resume: upload_session, publishAt: scheduled_at > now + 5 хв ? scheduled_at : undefined, … })` → `platform_post_id`, `url`, `status = processing`, `upload_session = null`.
4. Помилка → `failed` + `error` (текст українською). Скасування задачі (`signal`) → `cancelled`; сесія YouTube не відкликається (Google сам видаляє незавершену).
5. Рестарт API: `running`-задача → `failed` (загальне правило черги). `reconcileAfterRestart` переводить публікації `uploading` з такою задачею назад у `scheduled` (`scheduled_at` не змінюється), і тік поставить нову задачу, яка продовжить завантаження з `upload_session`.

Паралельність `publish` — 1 (вистачає однієї, і квота не з'їдається паралельними завантаженнями).

### 5.4 AI-метадані
- Мутація `publish.generateMeta({ projectId, language, force? })` — синхронна, як «Перевірити провайдера». Якщо в `publish_meta_drafts` є запис і `force` не задано — повертає його.
- Джерело тексту: назва проєкту, тема, тексти `voice_lines` цієї мови в порядку сегментів (до 6000 символів), формат (9:16 → Shorts/Reels, 16:9 → довге відео), «стиль каналу» з `user_settings`. Якщо рядків немає — назва й тема.
- Промпт `packages/ai/src/prompts/publish-meta.ts` (з версією, як наявні) → `TextGen.generateObject` за Zod-схемою `Record<Platform, { title, description, tags }>`. Мова відповіді — мова версії. Ліміти з `PLATFORM_LIMITS` передаються в промпт; результат додатково обрізається `clampMeta` (обрізка по слову). YouTube: SEO-назва, опис з першими 2 рядками-хуком, 8–15 тегів. TikTok/Instagram: короткий підпис + 3–5 хештегів. Facebook: назва + опис.
- Модель — `user_settings.defaults.text`. Запис у `generations` (`capability: 'text'`, `params.purpose = 'publish-meta'`) з `cost_estimate`. Помилка провайдера → тост; поля лишаються порожніми, публікувати можна з ручними метаданими.

## 6. tRPC (`apps/api/src/modules/publish`)
```
publish.accounts.list()                                  → акаунти без токенів, + youtubeConfigured, youtubeAudited
publish.accounts.createManual({ platform, name, language, profileUrl? })
publish.accounts.update({ id, name?, language?, profileUrl? })
publish.accounts.remove({ id })                          → CONFLICT, якщо є живі публікації
publish.accounts.connectUrl({ platform: 'youtube', language })
publish.versions({ projectId? })                         → мовні версії (проєкт, мова, останній готовий фінальний рендер, формат, тривалість)
publish.generateMeta({ projectId, language, force? })
publish.create({ items: [{ renderId, accountId, meta, scheduledAt? }] })   → по одному рядку на пару; validateMeta на сервері
publish.list({ projectId? , status? })                   → для матриці
publish.pendingCount()                                   → кількість awaiting_manual (бейдж)
publish.downloadUrl({ id })                              → presignGet із downloadName «<назва>-<мова>.mp4»
publish.markPublished({ id, url })                       → parsePostUrl; чуже посилання → VALIDATION «Це не посилання на <платформу>»
publish.updateMeta({ id, meta, scheduledAt? })           → лише scheduled / awaiting_manual
publish.cancel({ id }) · publish.retry({ id })           → retry: failed → scheduled (scheduled_at без змін) з тим самим upload_session; для api одразу ставить задачу
```
Композиція: `deps.publishers: Record<Platform, Publisher | undefined>` (зараз лише `youtube`) та `deps.oauth.youtube`; за `PUBLISH_FAKE=1` — fake-реалізації. Платформа без адаптера → акаунт можна створити лише `manual`.

## 7. UI

### 7.1 Вкладка «Публікації» (`/publications` замість заглушки)
- **Рядок акаунтів** зверху: картки «платформа · назва · мова · статус». Кнопки «Підключити YouTube» (з вибором мови) і «Додати акаунт вручну» (платформа, назва, мова, посилання на профіль). Для акаунта `reauth_required` — червона позначка й кнопка «Перепідключити». Меню картки: змінити, видалити.
- **Матриця**: рядки — мовні версії (мініатюра, назва проєкту, мова-прапорець, формат), колонки — YouTube / TikTok / Instagram / Facebook. Комірка — останні публікації цієї версії на цій платформі (зазвичай одна):
  - статус-бейдж українською (`Заплановано · 24.10 18:00`, `Завантаження 42 %`, `Обробка на YouTube`, `Опубліковано` + посилання ↗, `Чекає на вас`, `Помилка` + текст, `Скасовано`);
  - дії: `awaiting_manual` → «Завантажити MP4», «Скопіювати метадані», «Вставити посилання»; `failed` → «Повторити»; `scheduled` → «Змінити», «Скасувати»;
  - порожня комірка → «+» відкриває діалог публікації з цією версією й платформою.
- Фільтр «Потребують дій» (`awaiting_manual` + `failed`). Кнопка «Опублікувати…» над матрицею — діалог без попереднього вибору.
- Прогрес завантаження — з подій задач через наявну SSE-підписку (`jobSubject.publicationId`).
- Посилання з `?connected=` / `?connectError=` → тост і очищення query.

### 7.2 Діалог публікації
1. **Що:** мовні версії проєкту (чекбокси; без готового фінального рендеру — вимкнено з підказкою «Немає готового рендеру»).
2. **Куди:** для кожної вибраної версії — платформи з акаунтом цієї мови, вибрані за замовчуванням. Якщо акаунтів кілька — випадний список. Якщо акаунта цієї мови немає — рядок «Немає акаунта <платформа> для <мова>» з кнопкою «Додати».
3. **Метадані:** вкладки «мова × платформа». Поля заповнюються з `generateMeta` при відкритті (індикатор; кнопка «Згенерувати знову» = `force`). Лічильники довжини з `PLATFORM_LIMITS`, помилки `validateMeta` підсвічуються. Для YouTube також: приватність, «Для дітей» (так/ні, обов'язково), категорія (список основних категорій YouTube, типово «Люди й блоги» = 22).
4. **Коли:** «Зараз» / «Дата й час» (локальний час браузера → ISO; не раніше ніж за 5 хв від зараз для YouTube, бо `publishAt` має бути в майбутньому).
5. Підказка, коли `youtubeAudited = false`: «Поки Google-проєкт не пройшов аудит YouTube API, YouTube робить такі відео приватними. Їх можна побачити в YouTube Studio».
6. «Опублікувати» → `publish.create` → тост «Створено N публікацій» → матриця.

### 7.3 Інші точки входу
- **Редактор, історія рендерів** (`RenderHistory`): для готового фінального рендеру — пункт «Опублікувати…», що відкриває діалог із цим проєктом і мовою.
- **Бічне меню:** бейдж із `publish.pendingCount` (опитування раз на 60 с) біля «Публікації».

## 8. Обробка помилок
- `AppError` з кодами: `VALIDATION` (метадані, посилання, час), `CONFLICT` (дублікат живої публікації, видалення акаунта чи рендеру з живими публікаціями), `NOT_FOUND`, `UPSTREAM` (помилки YouTube з текстом `error.errors[0].reason` + українське пояснення для `quotaExceeded`, `uploadLimitExceeded`, `forbidden`, `youtubeSignupRequired` — «На цьому Google-акаунті немає YouTube-каналу»).
- Помилка однієї публікації не впливає на інші. «Повторити» продовжує завантаження з наявної сесії.
- Токени, client secret і `TOKEN_ENCRYPTION_KEY` не логуються й не повертаються клієнту.

## 9. Тестування
| Рівень | Що |
|---|---|
| Юніт (`packages/publish`) | `parsePostUrl` (усі формати 4 платформ, чужі домени, короткі посилання); `validateMeta`/`clampMeta`/`formatForCopy`; YouTube-адаптер на підставному `fetch`: створення сесії, шматки з правильним `Content-Range`, продовження після `308`, нова сесія на `404`, `quotaExceeded` → помилка без повторів, тіло з `publishAt`; `status()` для `processed`/`rejected`; Google OAuth: `authUrl`, `exchange`, `refresh`, `invalid_grant` |
| Юніт (`apps/api`) | підпис і перевірка `state` (прострочений, підроблений); шифрування токенів (round-trip, інший ключ → помилка); `publishTick` на станах (чиста частина вибору дій) |
| Інтеграційні (docker, fake publisher) | `publish.create` → задача → `processing` → тік → `published`, `projects.status = published`; ручна із часом: тік до часу — без змін, після — `awaiting_manual`; `markPublished` з правильним/чужим URL; дублікат живої публікації → `CONFLICT`; рестарт під час `uploading` → `scheduled` → нова задача з тим самим `upload_session`; `generateMeta` (FakeProvider) кешується в `publish_meta_drafts`; OAuth-callback з fake OAuth створює акаунт і не повертає токени |
| E2E (Playwright, `PUBLISH_FAKE=1`, `AI_FAKE=1`) | додати ручний акаунт TikTok (uk) і підключити fake-YouTube (uk) → проєкт із готовим рендером → «Опублікувати…» → метадані заповнені → публікація → YouTube-комірка «Опубліковано» з посиланням, TikTok — «Чекає на вас» + бейдж у меню → «Вставити посилання» → «Опубліковано» |
| Живий (вручну, `pnpm test:live`) | YouTube: завантаження 2-секундного кліпу як `private` на тестовий канал і перевірка `status()` |

## 10. Організаційне (власник, паралельно)
1. Google Cloud: проєкт → увімкнути YouTube Data API v3 → OAuth consent screen (External; себе — тестовим користувачем) → OAuth client «Web application» з redirect URI `http://localhost:5173/oauth/youtube/callback` → ключі в `.env`.
2. Подати форму аудиту YouTube API Services (щоб відео не блокувались як приватні), коли потік запрацює.
3. За бажанням перевести OAuth-застосунок у «In production», щоб refresh-токени не спливали через 7 днів.

## 11. Поза межами
- API-адаптери TikTok, Instagram, Facebook (окремий підпроєкт після отримання застосунків і аудитів); HTTPS-тунель і публічні URL файлів для Instagram.
- Субтитри (`captions.insert`), мініатюри, позначка синтетичного контенту, локалізовані назви YouTube.
- Контент-план зі слотами й «до черги».
- Статистика (`publication_stats`, `StatsCollector`) — підпроєкт 6.
- Видалення чи редагування вже опублікованого відео на платформі із застосунку.
- Браузерні push-сповіщення (лише бейдж і тости у відкритому застосунку).
