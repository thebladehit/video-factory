# Підпроєкт 1 «Бібліотека» — специфікація

- **Дата:** 2026-10-20
- **Статус:** погоджено в обговоренні, очікує перегляду
- **Базова специфікація:** `docs/specs/2026-10-20-video-factory-design.md` (§4 інтерфейси, §5 дані, §6.2 бібліотека, §7 AI, §12)
- **Фундамент:** `docs/plans/2026-10-20-subproject-0-foundation.md` (злито в `main`, PR #1)

## 1. Мета

Користувач закидає (drag & drop будь-де в UI) або генерує з тексту фото й відео; медіа зберігається в S3 і БД, отримує метадані, мініатюру й теги та знаходиться пошуком за ключовими словами й тегами.

Генерація — **сервіс, що викликається з коду**, а не лише кнопка: у підпроєкті 4 конвеєр «тема → сценарій → кадри» викликатиме ті самі функції для кожної сцени.

### Рішення власника (з обговорення)
| Питання | Рішення |
|---|---|
| FFmpeg | API працює в Docker-контейнері з ffmpeg (Debian, повна збірка з libass) |
| Розробка й тести | API і всі vitest-тести — у контейнері; web (Vite) і Playwright — на хості |
| Теги | Згенеровані: теги з промпту дешевою текстовою моделлю (без картинки). Завантажені: vision-теги автоматично лише за перемикачем у налаштуваннях. Кнопка «Згенерувати теги» — завжди |
| Генерація | Лише з тексту (без image→video, без референсів, без «згенерувати схожі») |
| Завантаження | Рядок `assets` створюється до завантаження (статус `uploading`); у браузері — Uppy без його UI |

## 2. Інфраструктура

### 2.1 API у Docker
- `docker/api.Dockerfile`: `node:24-bookworm-slim` + `ffmpeg` (apt) + pnpm через corepack.
- Сервіс `api` у `docker-compose.yml`: репозиторій змонтований у `/app`, `node_modules` (корінь і кожен пакет) — в іменованих томах контейнера (бінарники Linux не конфліктують з macOS); entrypoint: `pnpm install --frozen-lockfile` → `pnpm db:migrate` → `tsx watch apps/api/src/main.ts`. Порт `3001`. `depends_on` postgres (healthy) і rustfs.
- Змінні в контейнері: `DATABASE_URL=postgres://vf:vf@postgres:5432/vf`, `TEST_DATABASE_URL=…/vf_test`, `S3_ENDPOINT=http://rustfs:9000`, **`S3_PUBLIC_ENDPOINT=http://localhost:9000`** — presigned URL для браузера підписуються на публічну адресу (підпис залежить від хоста). Якщо `S3_PUBLIC_ENDPOINT` порожній — використовується `S3_ENDPOINT`.
- `FFMPEG_PATH` / `FFPROBE_PATH` (за замовчуванням `ffmpeg` / `ffprobe`). На старті API перевіряє `ffprobe -version`; якщо нема — лог-попередження, `health.check` повертає `media: 'down'`, задачі `asset.process` падають зі зрозумілою помилкою.
- Команди: `docker compose up -d` — postgres + rustfs + api; `pnpm dev` — лише web на хості (Vite проксіює `/trpc` на `localhost:3001`).
- Тести: `pnpm test` / `pnpm test:unit` / `pnpm test:live` = `docker compose run --rm api pnpm vitest run …` (одна точка запуску, ffmpeg доступний). E2E: Playwright на хості; `webServer` запускає сервіс `api-e2e` (профіль compose `e2e`, порт `3101`, БД `vf_test`, бакет `vf-media-test`) і Vite на `5174`.
- README і `.env.example` оновлюються під новий порядок запуску.

### 2.2 Пакет `@vf/media`
```ts
interface MediaProbe { kind: 'image' | 'video' | 'audio'; mime: string; width?: number; height?: number; durationMs?: number }
probe(path: string, opts?: { signal?: AbortSignal }): Promise<MediaProbe>        // ffprobe -print_format json
thumbnail(path: string, out: string, opts: { kind; durationMs?; signal? }): Promise<void>  // WebP, довша сторона 512 px; відео — кадр на ~10% тривалості
```
Обидві — `child_process.spawn` з таймаутом (60 с) і `signal`; помилка містить хвіст stderr. Нерозпізнаний файл → `AppError('VALIDATION', 'Не вдалося прочитати файл (пошкоджений або непідтримуваний формат)')`.

## 3. Дані (міграція 0002)

**`assets`** — нові колонки:
- `status text not null default 'ready'` з check `uploading | processing | ready | failed`; `error text`
- `original_name text`; `upload_id text` (id multipart-завантаження S3)
- індекс `(user_id, status, created_at)`; GIN trigram на `vf_tags_text(tags)` (зараз є лише на `title`)

**`generations`** — нові колонки:
- `provider_op jsonb` — ідентифікатор операції провайдера (відео) для відновлення після рестарту
- `asset_ids uuid[] not null default '{}'` — результати генерації
- `cost_estimate` заповнюється за цінами каталогу: фото `image × n`, відео `second × тривалість`, текст/vision — за `usage` токенів

**`user_settings`**:
- `defaults` приймає ще `tagger` (модель для тегів; можливість `text`)
- `auto_tag_uploads boolean not null default false`

**Ключі S3** (генерує лише сервер): `u/{userId}/assets/{assetId}/original.{ext}`, `u/{userId}/assets/{assetId}/thumb.webp`.

**Ліміти й формати** (конфіг `packages/shared/src/media-limits.ts`):
| Тип | MIME | Ліміт |
|---|---|---|
| Фото | image/jpeg, image/png, image/webp, image/gif | 50 МБ |
| Відео | video/mp4, video/quicktime, video/webm | 5 ГБ |
| Аудіо | audio/mpeg, audio/wav (audio/x-wav), audio/mp4 (audio/x-m4a), audio/ogg | 500 МБ |

Multipart — від 64 МБ, частини по 16 МБ. Тип перевіряється двічі: MIME у `createUpload` і `ffprobe` в `asset.process`; розбіжність типу (`kind`) → `failed` з поясненням.

**Прибирання:** раз на годину й на старті видаляються assets у статусі `uploading`, старші за 24 год: `AbortMultipartUpload` (якщо є `upload_id`), видалення об'єкта, видалення рядка. Перша реалізація інтерфейсу `Scheduler` з §4: `IntervalScheduler` (`setInterval` у процесі API) у composition root.

## 4. API

Модулі мають сервіс (чисті функції над `deps`, без tRPC) і тонкий роутер. Конвеєр підпроєкту 4 викликатиме сервіси напряму. Усі запити фільтруються за `userId`; чужий id поводиться як неіснуючий (`NOT_FOUND`).

### 4.1 `assets`
| Процедура | Поведінка |
|---|---|
| `createUpload({ name, mime, size })` | ліміти/MIME → рядок `uploading` → `{ assetId, mode: 'single', url }` або `{ assetId, mode: 'multipart', uploadId, partSize }` |
| `signParts({ assetId, partNumbers })` | presigned URL частин (Uppy запитує порціями) |
| `complete({ assetId, parts? })` | `CompleteMultipartUpload` (multipart) → `HEAD` об'єкта, розмір збігається із заявленим → `processing` → задача `asset.process`. Ідемпотентно: для `processing`/`ready` повертає поточний стан |
| `abort({ assetId })` | abort multipart + видалення об'єкта й рядка (лише для `uploading`) |
| `list({ q?, kind?, source?, orientation?, tags?, cursor?, limit=60 })` | лише `ready`; пошук + фільтри; `thumbUrl` і `url` — presigned GET (1 год) |
| `pending()` | `uploading` / `processing` / `failed` користувача (блок «В роботі») |
| `get({ id })`, `update({ id, title?, tags? })`, `delete({ id })` | картка; редагування (теги нормалізуються: trim, нижній регістр, без дублів, ≤ 30 шт.); видалення об'єктів S3 і рядка |
| `retryProcess({ id })` | для `failed` → `processing` + нова задача |
| `tag({ id })` | задача `assets.tag` (ручне тегування) |
| `tags()` | топ-20 тегів користувача з кількістю |

**Пошук:** порожній `q` → `created_at desc`. Інакше: `search @@ websearch_to_tsquery('simple', q)` АБО `similarity(title, q) > 0.3` АБО `similarity(vf_tags_text(tags), q) > 0.3`; сортування `ts_rank(search, query) + greatest(similarity…)` desc. `tags` — `tags @> $1`. Орієнтація: `vertical` (h > w), `horizontal` (w > h), `square`. Курсорна пагінація (offset-курсор для ранжованих результатів, `(created_at, id)` для порожнього `q`).

### 4.2 `generate`
| Процедура | Поведінка |
|---|---|
| `image({ model, prompt, aspect, n: 1..4 })` | перевірка моделі (`MODEL_NOT_FOUND`/`MODEL_UNAVAILABLE` до постановки в чергу) і аспекту за каталогом → `generations` (`queued`) → задача `image.generate` → `{ generationId, jobId }` |
| `video({ model, prompt, aspect, durationSec })` | те саме для `video.generate`; тривалість — лише з підтримуваних моделлю |
| `estimate({ capability, model, n?, durationSec? })` | оцінка вартості для UI |
| `list()` | активні й невдалі генерації користувача (блок «В роботі») |

### 4.3 `jobs.feed`
SSE-підписка на всі події задач поточного користувача: `JobEvent` + `type` + `subject: { assetId?, generationId? }` (з payload). UI інвалідує запити TanStack Query за подіями. Одна підписка замість з'єднання на кожен файл (ліміт браузера ~6 з'єднань на хост).

### 4.4 Задачі
| Тип | Payload | Поведінка |
|---|---|---|
| `asset.process` | `{ assetId }` | оригінал → тимчасова тека → `probe` → `thumbnail` → put → оновити метадані, `ready`. Далі теги: згенерований → теги з промпту; завантажений і `auto_tag_uploads` → vision. Помилка тегування не робить asset `failed` (пишеться в `generations` з `capability='text'`). Ідемпотентно: фіксований ключ мініатюри, стан пишеться наприкінці. Тимчасова тека прибирається у `finally`. Concurrency 2 |
| `image.generate` | `{ generationId }` | якщо `asset_ids` заповнені — лише догнати незавершені `asset.process`. Інакше адаптер → для кожного файлу asset (`processing`, `source='generated'`, `prompt`, `generation_id`) → put → `asset_ids` → `asset.process`. Concurrency 2 |
| `video.generate` | `{ generationId }` | немає `provider_op` → `start` і **одразу** зберегти op; далі `poll` кожні 10 с з `ctx.progress`; файл → asset → `asset.process`. Повтор після рестарту продовжує опитування, а не запускає (і не оплачує) нову генерацію. Таймаут 15 хв. Concurrency 2 |
| `assets.tag` | `{ assetId }` | vision-тегування за моделлю `defaults.tagger` (або першою доступною дешевою) |

Статус `generations` синхронізується зі статусом задачі (`queued → running → done | failed | cancelled`).

**Назви й модель для тегів:** назва завантаженого файлу = ім'я файлу без розширення; згенерованого = промпт, обрізаний до 80 символів (vision-тегер може запропонувати кращу назву лише для завантажених). Модель для тегів: `defaults.tagger` → інакше текстова модель за замовчуванням → інакше тегування пропускається без помилки (згенеровані все одно знаходяться за промптом, бо він у `search`).

### 4.5 Виправлення черги (відкладені з рецензії підпроєкту 0)
1. **Гонка cancel vs claim:** колонка `jobs.cancel_requested boolean`. `cancel` ставить її атомарно; `claim` не бере задачу з прапорцем (переводить у `cancelled`); раннер після claim перевіряє прапорець і абортить `signal`. Працюватиме однаково з BullMQ.
2. `progress` пише лише за `status='running'`; `finish` — за `status in ('running','queued')`; запізнілі записи після скасування ігноруються.
3. SSE (`jobs.events`, `jobs.feed`): один abort-listener на підписку.
4. `runtime.stop()` чекає `onIdle` не довше 10 с.
5. `ensureBucket` ліниво: якщо на старті S3 недоступний — повтор у `health.check` і перед першим `createUpload`/`put`.
6. Stack trace не потрапляє у відповіді tRPC.

Поза обсягом: `priority` у черзі, стани помилок сторінки налаштувань.

## 5. AI-адаптери

- **ImageGen:** OpenAI (gpt-image, дешевша mini-модель) і Google (Gemini Image / Imagen) через `generateImage` Vercel AI SDK 7. Аспект `9:16 | 16:9 | 1:1` → розмір або `aspectRatio` за мапою в каталозі.
- **VideoGen** (`start` / `poll`):
  - Veo — через відео-модель `@ai-sdk/google`, якщо вона дає доступ до id операції для відновлення; інакше прямий REST Gemini (`predictLongRunning` + `operations.get`).
  - Sora — офіційний пакет `openai` (`videos.create` / `retrieve` / `downloadContent`); у `@ai-sdk/openai` відео-моделі немає.
- **Vision-тегер:** `TextGen.generateObject` отримує опційні `images: GeneratedFile[]`; схема `{ title: string, tags: string[5..10] }`. Теги українською + англійські синоніми ключових сутностей (пошук знаходить і «кіт», і «cat»). Промпти — у `packages/ai/src/prompts` з версією.
- **Fake:** `fake/video` — ffmpeg `lavfi` (колір за хешем промпту, 2 с, mp4), `poll` двічі повертає `running`, потім файл; `fake/text` для тегів — детерміновані теги зі слів промпту; `fake/image` уже є.
- **Каталог:** рядки image/video з цінами, підтримуваними аспектами й тривалостями. Точні id моделей і ціни звіряються з документацією провайдерів під час реалізації; живе підтвердження — `pnpm test:live` після додавання ключів.
- **Надійність:** 429/5xx — до 3 ретраїв з backoff; відмова контент-політики — `PROVIDER_ERROR` з текстом провайдера, без ретраїв; помилка → `generations.error` і `jobs.error`.

## 6. Інтерфейс

### 6.1 Глобальне завантаження
- `UploadProvider` у кореневому layout: перетягування файлів над вікном → напівпрозорий оверлей «Відпустіть, щоб додати в бібліотеку».
- Uppy (`@uppy/core` + `@uppy/aws-s3`, без його UI) з колбеками на `createUpload` / `signParts` / `complete` / `abort`; до 5 повторів частини.
- Плаваюча панель завантажень (правий нижній кут): файл, прогрес, швидкість, «Скасувати»; після 100% — «Обробка…» → ✓ (за `jobs.feed`); помилка — «Повторити»; згортається. `beforeunload`-попередження, поки є активні завантаження.

### 6.2 Сторінка «Бібліотека» (`/library`, замість `ComingSoon`)
- Верхній рядок: пошук (debounce 300 мс), фільтри (тип, джерело, орієнтація), «Завантажити», «Згенерувати». Стан — у search params URL.
- Чипи топ-тегів (клік → фільтр).
- Блок «В роботі»: `uploading` / `processing` / активні генерації з живим прогресом; `failed` з «Повторити» / «Видалити».
- Сітка квадратних мініатюр, нескінченна прокрутка; відео — тривалість і беззвучне прев'ю при наведенні; аудіо — іконка + тривалість. Порожній стан: «Перетягніть файли сюди або згенеруйте перше зображення».
- Бічна панель картки (Sheet): перегляд (img / video / audio з контролами), інлайн-редагування назви й тегів, метадані, для згенерованих — промпт, модель, вартість; «Згенерувати теги», «Завантажити файл», «Видалити» (з підтвердженням).
- Діалог «Згенерувати»: вкладки Фото / Відео; промпт; модель (недоступні вимкнені з «немає ключа»; за замовчуванням — з налаштувань); формат (лише підтримувані моделлю); кількість 1–4 (фото) / тривалість (відео); оцінка вартості; після запуску діалог закривається, картка з'являється в «В роботі».

### 6.3 «Налаштування»
- «Моделі за замовчуванням»: додаються фото, відео, модель для тегів.
- Перемикач «Авто-теги для завантажених файлів» з підказкою про вартість (≈ $0.0001–0.0003 за файл на дешевій моделі, напр. Claude Haiku 5.5).

## 7. Помилки
| Ситуація | Поведінка |
|---|---|
| Файл завеликий / непідтримуваний тип | `VALIDATION` у `createUpload`, toast з лімітом |
| S3 недоступний | `INFRA_UNAVAILABLE` «Сховище недоступне» |
| `complete` без файлу або з іншим розміром | `VALIDATION`, asset лишається `uploading` (можна повторити або скасувати) |
| ffprobe не розпізнав / тип не збігся | asset `failed` з поясненням, «Повторити» / «Видалити» |
| Провайдер відмовив / ліміт | текст провайдера в картці генерації; задача `failed`, «Повторити» |
| Обрив мережі під час multipart | Uppy повторює частину до 5 разів; далі «Повторити» продовжує з уже завантажених частин |
| ffmpeg відсутній | `health.check` → `media: 'down'`; `asset.process` → «FFmpeg недоступний у контейнері API» |

## 8. Тестування
- **Unit:** ліміти/MIME, S3-ключі, побудова пошукового запиту, мапа аспектів, розрахунок `cost_estimate`, нормалізація тегів, парсер відповіді тегера, адаптери ImageGen/VideoGen з мок-моделлю AI SDK.
- **Integration** (у контейнері; Postgres + RustFS + ffmpeg):
  - `@vf/media`: `probe`/`thumbnail` на фікстурах, згенерованих ffmpeg (фото, відео, аудіо, битий файл).
  - Повний цикл: `createUpload` → PUT на presigned URL (одиночний і multipart з 2 частинами) → `complete` → `asset.process` → `ready`, мініатюра в S3.
  - Чужий `assetId` → `NOT_FOUND`; `complete` без файлу → помилка.
  - Пошук: full-text, trigram з опечаткою, фільтр тегів, орієнтація, лише `ready`, ізоляція користувачів.
  - `image.generate` / `video.generate` з fake: asset і `generations` з вартістю; повтор задачі не дублює; `video.generate` з наявним `provider_op` продовжує опитування.
  - Прибирання завислих `uploading`.
  - Черга: cancel між claim і стартом обробника, запізнілий progress після cancel, `stop()` з таймаутом.
- **E2E** (Playwright, fake-провайдер): перетягнути PNG і MP4 → панель → картки з мініатюрами; пошук за назвою й тегом; редагування тегів; видалення; генерація фото → «В роботі» → сітка → знаходиться за словом з промпту; генерація відео; фільтри типу й джерела.
- **Live** (`pnpm test:live`, вручну з ключами): по одному виклику кожного реального адаптера фото/відео і vision-тегера.

## 9. Поза обсягом
Image→video і референси для фото; «згенерувати схожі»; семантичний пошук (pgvector); масові дії; папки/колекції; drop саме в редактор (підпроєкт 2 — `UploadProvider` уже глобальний); транскодування (зберігається оригінал); HEIC/RAW.

## 10. Готово, коли
- `docker compose up -d && pnpm dev` → можна закинути фото/відео/аудіо або згенерувати фото/відео (fake без ключів; реальні — з ключами).
- Файли в RustFS, метадані в БД, мініатюри в S3; згенеровані мають теги з промпту, `generations` з `cost_estimate`.
- Пошук знаходить за словами з назви, тегів і промпту, зокрема з опечаткою; фільтри працюють.
- `pnpm test` (у контейнері) і `pnpm --filter @vf/web e2e` проходять; `pnpm typecheck && pnpm lint` чисті.
