# Фабрика відео — дизайн (загальна архітектура + підпроєкт 0)

- **Дата:** 2026-10-20
- **Статус:** погоджено в обговоренні, очікує фінального перегляду специфікації
- **Прототипи:** `prototypes/editor-demos` (одноразовий код для вибору рушія монтажу; не частина продукту)

---

## 1. Мета і контекст

Веб-додаток, що спрощує створення відео для YouTube: від теми до готового ролика, опублікованого на платформах, зі збором статистики.

- **Формати:** короткі вертикальні (9:16 — YouTube Shorts, Instagram Reels, TikTok, Facebook Reels) і повноцінні горизонтальні (16:9 — YouTube).
- **Перша версія — для одного користувача (власника)**, але це майбутній SaaS: архітектура з першого дня розрахована на багатьох користувачів, авторизацію, черги та горизонтальне масштабування.
- **Основний сценарій:** автоматичний конвеєр «тема → сценарій → сцени → медіа → озвучка → чернетка на таймлайні», після якого все можна доредагувати вручну. Кожен крок також доступний окремо (ручний режим).

### Критерії успіху продукту
1. З однієї теми за кілька кліків отримати чернетку відео на таймлайні в потрібному форматі.
2. Озвучити будь-яке готове відео кількома мовами з субтитрами без відкриття редактора.
3. Усі згенеровані та завантажені медіа зберігаються в бібліотеці й знаходяться пошуком.
4. Готове відео публікується (автоматично або вручну) на YouTube / TikTok / Instagram / Facebook, а статистика збирається в одному місці.
5. Перехід від «один користувач локально» до «сотні користувачів на сервері» не вимагає переписування модулів — лише заміни реалізацій інтерфейсів.

### Поза межами першої версії
- Реєстрація, оплата, тарифи (лише закладаються інтерфейси `AuthProvider`, `CredentialStore`).
- Справжні черги (BullMQ/Redis) — лише інтерфейс `JobQueue` з in-process реалізацією.
- Спільне (колаборативне) редагування.
- Мобільний UI (адаптивність — «не ламається», але редактор розрахований на десктоп).

---

## 2. Ключові рішення та обґрунтування

| Рішення | Вибір | Чому |
|---|---|---|
| Де працює v1 | Локально, `docker compose` (Postgres + RustFS), S3-сумісне сховище з першого дня | Найдешевший старт; деплой на сервер = інші змінні середовища |
| S3 локально | **RustFS** (Apache-2.0, 1.0 GA вересень 2026); резерв — SeaweedFS. **Не MinIO**: з жовтня 2025 без Docker-образів, з квітня 2026 репозиторій в архіві | Будь-яке S3-сумісне сховище підходить, бо доступ лише через `BlobStorage` |
| Фронтенд-фреймворк | React + Vite SPA, **не Next.js** | Додаток за логіном (SEO не потрібне), редактор повністю клієнтський (canvas, WASM, `<video>`), бекенд однаково окремий (довгі задачі, FFmpeg). Лендинг SaaS — пізніше окремим проєктом (Next.js/Astro); за потреби SSR — TanStack Start на тому ж роутері |
| Основний режим | Конвеєр «тема → чернетка» + повний ручний режим | Головна мета — спростити процес |
| AI-провайдери | Anthropic (Claude), OpenAI, Google Gemini (**лише платний ключ**); ElevenLabs — пізніше. **Безкоштовний Gemini не використовується** | Вибір провайдера/моделі на кожному кроці робить користувач |
| Рушій монтажу | **Варіант A:** власний таймлайн + canvas-прев'ю у браузері + рендер FFmpeg на сервері, за інтерфейсами `PreviewEngine` / `Renderer` | Див. 2.1 |
| Субтитри | ASS-формат (libass у FFmpeg) + **JASSUB** (libass у WASM) для прев'ю | Прев'ю і результат субтитрів фактично ідентичні |
| Різна тривалість мов | **Варіант C:** один таймлайн з автопідгонкою темпу + кнопка «відокремити мову» | Редагування один раз; точкове доопрацювання можливе. **Уточнено в підпроєкті 3:** темп змінюється у відео (×0,8–1,25 + стоп-кадр), голос не прискорюється — див. `docs/specs/2026-10-20-subproject-3-voice.md` |
| Публікація | Прямі офіційні API за інтерфейсом `Publisher` + **ручний шлях** для будь-якої платформи | Без постійних витрат на агрегатори; ручний шлях закриває аудити й обмеження платформ |

### 2.1 Вибір рушія монтажу

Розглянуто й продемонстровано у прототипі (`prototypes/editor-demos`, запуск: `npm --prefix prototypes/editor-demos install && npm --prefix prototypes/editor-demos run dev`):

| | A. Canvas-прев'ю + FFmpeg | B. Remotion | C. Рендер у браузері (WebCodecs) |
|---|---|---|---|
| Прев'ю = результат | приблизно (два рушії) | так | так |
| Анімовані субтитри | ASS-теги (`\t`, `\k`, `\move`…) | React/CSS | вручну |
| Довгі 16:9 відео | найшвидше | повільніше (headless Chrome) | ризиковано |
| Конвеєр без людини | так | так | ні |
| Ліцензія | безкоштовно | платна Company License для компаній від 4 осіб | безкоштовно |

**Обрано A**, бо власник уточнив: головне — збіг **тривалості й таймінгу анімацій** (±) між прев'ю й результатом, а не піксельна ідентичність. Таймінг у A збігається за конструкцією (обидва рушії читають ті самі `start/duration/in` і мітки слів), субтитри — через однаковий libass (FFmpeg + JASSUB). Ефекти — закрита бібліотека, кожен реалізується двічі (canvas + FFmpeg), що прийнятно для фабрики контенту.

**Шлях до B:** рушій прихований за `PreviewEngine` (браузер) і `Renderer` (сервер). Модель таймлайну (`TimelineDoc`) від рушія не залежить. Перехід на Remotion = нова реалізація двох інтерфейсів, без змін у таймлайні, БД і модулях. Також можливий проміжний варіант **A′**: та сама функція `drawFrame` на сервері через `skia-canvas` → сирі кадри у `ffmpeg` (один код малювання, без ліцензій).

**Відомі обмеження ASS/libass:** немає градієнтів/текстур у літерах, кольорових емодзі, spring-фізики (лише криві з прискоренням); округлені плашки — незручно (через `\p`). Запасний вихід — пре-рендер графіки у прозоре відео й `overlay`.

**Уроки з прототипу:** canvas-прев'ю має рендерити з роздільністю `відображений розмір × devicePixelRatio` і `imageSmoothingQuality='high'`, інакше прев'ю помітно мильніше за DOM-рендер; перенос рядків субтитрів має бути реалізований явно.

---

## 3. Архітектура

```
┌──────────────── apps/web (React SPA) ────────────────┐
│ Бібліотека · Генератори · Редактор(таймлайн+canvas)  │
│ Студія озвучки · Публікації · Статистика · Налашт.   │
└───────────────┬─────────────────── ▲ SSE (прогрес) ──┘
                │ tRPC                │
┌───────────────▼─────────── apps/api (Node) ──────────┐
│ модулі: assets · projects · pipeline · ai · voice ·  │
│         render · publish · analytics · settings      │
│ ───────────── інтерфейси (порти) ─────────────────── │
│ AuthProvider  CredentialStore  JobQueue  Scheduler   │
│ BlobStorage   Renderer   TextGen ImageGen VideoGen   │
│ TTS  STT  Publisher  StatsCollector                  │
└──┬──────────┬───────────┬───────────┬────────────────┘
   │          │           │           │
 Postgres   RustFS(S3)   ffmpeg     AI-провайдери / платформи
```

### 3.1 Стек

| Шар | Вибір |
|---|---|
| Монорепо | pnpm workspaces + Turborepo |
| Фронтенд | React 19, Vite, TypeScript, TanStack Router, TanStack Query, Tailwind CSS v4, shadcn/ui, Zustand (+ undo/redo через zundo) |
| API | Node (LTS ≥ 24), Fastify 5, tRPC, Zod |
| БД | PostgreSQL + Drizzle ORM; full-text (`tsvector`) + `pg_trgm`; пізніше `pgvector` |
| Сховище | RustFS (S3 API, `@aws-sdk/client-s3`, presigned URL) |
| AI | Vercel AI SDK (текст, зображення, TTS, STT; провайдери Anthropic/OpenAI/Google/ElevenLabs) + офіційні SDK для генерації відео (Veo, Sora) — усе за власними інтерфейсами |
| Рендер | FFmpeg / ffprobe (child process) |
| Субтитри у браузері | JASSUB |
| Тести | Vitest, Playwright |
| Локальна інфраструктура | docker compose: postgres, minio; ffmpeg — `brew install ffmpeg` локально або в Docker-образі |

### 3.2 Структура репозиторію

```
apps/
  web/            React SPA
  api/            Fastify + tRPC + WorkerRuntime (in-process)
  worker/         (пізніше) окремий entrypoint для BullMQ-воркерів
packages/
  shared/         TimelineDoc (Zod), спільні типи, коди помилок
  db/             Drizzle-схема, міграції, seed
  jobs/           JobQueue/JobDef/WorkerRuntime контракти + InProcessQueue
  storage/        BlobStorage + S3-реалізація (RustFS / S3 / R2)
  ai/             інтерфейси можливостей, реєстр, каталог моделей, адаптери, FakeProvider, промпти
  render/         (підпроєкт 2) compileFfmpeg, генератор ASS, FfmpegRenderer
  publish/        (підпроєкт 5) Publisher-адаптери
docs/specs/       специфікації
prototypes/       одноразові прототипи
docker-compose.yml
.env.example
```

---

## 4. Інтерфейси (порти)

Усі модулі залежать лише від інтерфейсів; реалізації підставляються в одному місці (composition root у `apps/api`) за змінними середовища.

| Інтерфейс | Реалізація зараз | Пізніше |
|---|---|---|
| `AuthProvider` | `SingleUserAuth` — один локальний користувач; `userId` все одно передається всюди | Better Auth / Clerk |
| `CredentialStore` | `EnvCredentialStore` — ключі з `.env` | зашифровані ключі користувачів (BYOK) або ключі платформи + білінг |
| `JobQueue` + `WorkerRuntime` | `InProcessQueue` | `BullMqQueue` (`QUEUE_DRIVER=bullmq`) |
| `Scheduler` | перевірка раз на хвилину в процесі | відкладені/повторювані задачі BullMQ |
| `BlobStorage` | RustFS | S3 / Cloudflare R2 |
| `PreviewEngine` (web) | canvas + JASSUB | Remotion Player |
| `Renderer` | `FfmpegRenderer` | `RemotionRenderer` |
| `TextGen`/`ImageGen`/`VideoGen`/`TTS`/`STT` | адаптери Anthropic, OpenAI, Google + `FakeProvider` | + ElevenLabs |
| `Publisher` | YouTube, TikTok, Instagram, Facebook (+ ручний шлях) | + агрегатор як ще один адаптер, якщо знадобиться |
| `StatsCollector` | адаптери платформ + ручне введення | — |

### 4.1 Задачі (jobs)

```ts
interface JobDef<P, R> {
  type: JobType;                 // 'render' | 'image.generate' | 'video.generate' | 'tts.generate'
                                 // | 'stt.transcribe' | 'asset.process' | 'pipeline.*' | 'publish' | 'stats.collect' | 'debug.sleep'
  concurrency: number;           // ліміт паралельності для типу
  handler(payload: P, ctx: JobContext): Promise<R>;
}
interface JobContext {
  jobId: string; userId: string;
  progress(pct: number, message?: string): Promise<void>;
  signal: AbortSignal;
}
interface JobQueue {
  enqueue<P>(type: JobType, payload: P, opts: { userId: string; priority?: number }): Promise<string>;
  get(jobId: string): Promise<JobStatus>;
  cancel(jobId: string): Promise<void>;
  onEvent(listener: (e: JobEvent) => void): () => void;
}
interface WorkerRuntime { register(def: JobDef<any, any>): void; start(): Promise<void>; stop(): Promise<void>; }
```

**Зараз (`InProcessQueue`):** `enqueue` → INSERT у `jobs` (`queued`) → in-memory черга з лімітом паралельності на тип → обробник → прогрес через `ctx.progress` (UPDATE `jobs` + подія) → SSE `/jobs/:id/events`. На старті: `queued` підхоплюються знову, `running` → `failed` (можна повторити). FFmpeg виконується окремим процесом ОС, тож event loop не блокується.

**Потім (`BullMqQueue`):** `enqueue` → INSERT у `jobs` + `queue.add(type, payload, { jobId })`; `apps/worker` імпортує ті самі обробники з `packages/*` і запускає `new Worker(type, …)`; прогрес → Redis pub/sub → будь-який інстанс API → SSE. Розгортання: API ×N, `worker-render` ×M (CPU), `worker-ai` ×K.

**Обов'язкові правила (з першого дня):**
1. Payload — лише серіалізовані ідентифікатори (`{ projectId, renderId }`), жодних буферів/функцій.
2. Обробник отримує дані з БД і S3, не з пам'яті API.
3. Обробники ідемпотентні (повтор після збою не створює дублікатів).
4. Прогрес — лише через `ctx.progress`; обробник не знає про SSE.
5. Таблиця `jobs` — джерело правди для UI за будь-якого драйвера.

---

## 5. Модель даних

Кожна таблиця має `user_id` (крім довідкових). Медіа — у S3, у БД — метадані.

```
users                 зараз один локальний користувач (seed)
user_settings         defaults: { text, image, video, tts, stt } → 'provider/model'; стиль каналу (текст для промптів)

assets                бібліотека
  id, user_id, kind (image|video|audio), source (generated|uploaded|rendered)
  storage_key, thumb_key, mime, width, height, duration_ms, size_bytes
  title, tags text[], prompt, language
  generation_id → generations
  search tsvector (title + tags + prompt)        -- GIN; + pg_trgm на title/tags
  embedding vector                                -- пізніше

generations           журнал AI-викликів
  id, user_id, capability (text|image|video|tts|stt), provider, model,
  prompt, params jsonb, status, job_id, error, cost_estimate, created_at

transcripts           мітки часу слів
  id, asset_id, language, source (tts|stt), text, words jsonb [{ text, startMs, endMs }]

projects
  id, user_id, title, topic, format (9:16|16:9), fps, base_language, languages text[],
  status (draft|ready|published), timeline jsonb, timeline_version int
project_language_timelines   «відокремлені» мови (варіант C)
  project_id, language, timeline jsonb, timeline_version int

scenes                id, project_id, position, visual_prompt, duration_hint_ms
scene_texts           scene_id, language, narration

renders               id, project_id, language, timeline_snapshot jsonb, status, job_id, output_asset_id
caption_styles        id, user_id, name, style jsonb (шрифт, кольори, обведення, анімація, слів на рядок)

jobs                  id, user_id, type, payload jsonb, status (queued|running|done|failed|cancelled),
                      progress, message, error, attempts, result jsonb, created_at, started_at, finished_at

social_accounts       id, user_id, platform, external_id, name, tokens (зашифровано), scopes, expires_at
publications          id, user_id, render_id, platform, account_id, method (api|manual),
                      status (scheduled|uploading|processing|published|awaiting_manual|failed),
                      scheduled_at, metadata jsonb, platform_post_id, url, error
publication_stats     publication_id, collected_at, metrics jsonb (views, likes, comments, shares, watch_time…), source (api|manual)
```

### 5.1 Документ таймлайну (`packages/shared`)

```ts
type TimelineDoc = {
  schemaVersion: 1;
  width: number; height: number; fps: number;
  tracks: Track[];                                   // порядок = порядок шарів
};
type Track =
  | { id: string; kind: 'video';    clips: MediaClip[] }
  | { id: string; kind: 'audio';    clips: AudioClip[]; role: 'voiceover' | 'music' | 'sfx'; language?: string }
  | { id: string; kind: 'captions'; clips: CaptionClip[]; language: string };

type MediaClip   = { id: string; assetId: string; start: number; duration: number; in: number;
                     sceneId?: string; fit: 'cover' | 'contain'; effects: Effect[] };
type AudioClip   = { id: string; assetId: string; start: number; duration: number; in: number;
                     volume: number; sceneId?: string; fadeIn?: number; fadeOut?: number };
type CaptionClip = { id: string; audioClipId: string; transcriptId: string; styleId: string };
type Effect      = { type: 'kenburns' | 'fade' | 'xfade' | 'zoom'; params: Record<string, number> };
```

- Час — у секундах (`start` — позиція на таймлайні, `in` — зсув у джерелі).
- Субтитри не мають власного часу: час слова на таймлайні = `audioClip.start + (word.startMs/1000 − audioClip.in)`. Переміщення/обрізка озвучки автоматично зсуває субтитри.
- Ефекти — закритий union; кожен новий тип = реалізація в `PreviewEngine` (canvas) і в `compileFfmpeg`.
- Зміни схеми — через `schemaVersion` + функції міграції документа.

### 5.2 Мови (варіант C)

> **Замінено підпроєктом 3** (`docs/specs/2026-10-20-subproject-3-voice.md` §2): відео підлаштовується під озвучку кожної мови, `atempo` на голосі не використовується.

- Візуальні доріжки спільні; аудіо-озвучка та субтитри мають `language`.
- Рендер з `language: X`: якщо є запис у `project_language_timelines` — рендериться він; інакше — базовий таймлайн, де озвучка мови X підганяється до тривалості сцени через `atempo` у межах ±15%; якщо не влазить — сцена подовжується на різницю (відео сцени розтягується/заморожується, фото — довше показується).
- «Відокремити мову» копіює поточний (вже підігнаний) таймлайн у `project_language_timelines`; далі ця мова редагується незалежно.

---

## 6. Модулі та сценарії

### 6.1 Конвеєр «тема → чернетка»
Покроковий майстер; кожен крок — задача, перегенеровується повністю або для однієї сцени, результат редагується перед наступним кроком.

1. **Налаштування:** тема, формат, цільова тривалість, мови, стиль, провайдер/модель на кожен крок (з `user_settings`, можна змінити).
2. **Сценарій:** `TextGen.generateObject` за Zod-схемою → `scenes[{ narration, visual_prompt, duration_hint }]` базовою мовою. Промпти відрізняються для Shorts (хук у перші 1–2 с) і довгих відео (вступ → розділи → висновок) + «стиль каналу».
3. **Переклад:** `TextGen` → `scene_texts` для кожної мови.
4. **Візуал:** для кожної сцени — «спершу бібліотека» (підказки з пошуку за `visual_prompt`) або «генерувати» (`ImageGen`/`VideoGen`) → нові assets з авто-тегами.
5. **Озвучка:** `TTS` для кожної сцени × мови → аудіо-asset + `transcript`.
6. **Збірка:** чиста функція `assembleTimeline(scenes, assets, voiceovers, settings) → TimelineDoc` (тривалість сцени = озвучка базовою мовою + пауза; фото → Ken Burns; доріжки субтитрів для кожної мови; музика — опційно).
7. → редактор.

### 6.2 Бібліотека
- **Завантаження:** drag & drop будь-де в UI (зокрема в редактор) → presigned PUT напряму в RustFS (multipart для великих файлів) → `POST assets.complete` → задача `asset.process` (ffprobe-метадані, мініатюра, опційно авто-теги vision-моделлю).
- **Генерація:** промпт + провайдер/модель → задача → asset; параметри в `generations` («згенерувати схожі»).
- **Пошук:** full-text по title/tags/prompt + trigram для неточних збігів; фільтри: тип, джерело, орієнтація. Пізніше — семантичний пошук (pgvector).

### 6.3 Редактор
- Zustand-стор із `TimelineDoc`, undo/redo.
- Автозбереження з debounce та оптимістичним контролем версії (`timeline_version`); конфлікт → пропозиція перезавантажити.
- Прев'ю: canvas (`devicePixelRatio`), приховані `<video>` для відео-кліпів, JASSUB для субтитрів, Web Audio для звуку.
- Таймлайн (на основі прототипу): переміщення, трім за краї, снепінг до країв і плейхеда, розрізання, видалення, зум, drag & drop з бібліотеки й з ОС (кліп з'являється одразу з локальним blob-URL, завантаження у фоні).
- Формати 9:16 і 16:9.

### 6.4 Студія озвучки (працює без редактора)
Вибрати/закинути готове відео → (опційно) STT оригіналу → редагування/переклад тексту → TTS на N мов → аудіо: замінити оригінал або змішати з ducking → стиль субтитрів → рендер N мовних версій. Всередині будується простий `TimelineDoc` (відео + озвучка + субтитри) і використовується той самий `Renderer`. Кнопка «відкрити в редакторі».

### 6.5 Рендер
`job 'render' { projectId, renderId }` → знімок таймлайну + мова → `compileFfmpeg(doc, language, localPaths) → { args, assFiles }` (чиста функція; підхід «чорне полотно + overlay для кожного кліпу в його інтервалі», аудіо — `amix`/`adelay`/`atempo`, субтитри — фільтр `subtitles` з ASS) → spawn ffmpeg, прогрес із `-progress pipe:1` → `out.mp4` → asset (`source=rendered`). Тимчасова тека на задачу, прибирається у `finally`; таймаут процесу.

### 6.6 Субтитри
- Джерело міток слів: TTS, що їх повертає (ElevenLabs `with-timestamps`), інакше — STT згенерованого аудіо (напр. OpenAI Whisper з `timestamp_granularities: ['word']`) + **зіставлення зі словами сценарію** (текст — зі сценарію, таймінг — з аудіо).
- Для готового відео — STT оригінальної доріжки.
- Генератор `words[] + caption_style → .ass` (групування в рядки по 2–4 слова за паузами, підсвітка активного слова й «pop» через `\t`).
- Прев'ю — JASSUB з тим самим `.ass`.
- Для публікації з тих самих `words` генеруються `.srt`/`.vtt` для кожної мови.

---

## 7. Шар AI-провайдерів

### 7.1 Інтерфейси можливостей
```ts
interface TextGen  { generateText(req): Promise<string>; generateObject<T>(schema: ZodType<T>, req): Promise<T> }
interface ImageGen { generate(req: { prompt; aspect; n; referenceImages? }): Promise<GeneratedFile[]> }
interface VideoGen { start(req: { prompt; image?; aspect; durationSec }): Promise<OpRef>; poll(ref: OpRef): Promise<OpStatus | GeneratedFile[]> }
interface TTS      { listVoices(language?): Promise<Voice[]>; synthesize(req: { text; voiceId; language; speed? }): Promise<{ audio; mime; words?: Word[] }> }
interface STT      { transcribe(req: { audio; language? }): Promise<{ text; words: Word[] }> }
```

### 7.2 Реєстр і каталог
- `ai.get(capability, 'provider/model')` повертає адаптер.
- **Каталог моделей — конфіг-файл**, не код: id, можливість, назва, ціна, ліміти швидкості, `wordTimestamps`, підтримувані формати/тривалості. Нова модель = рядок у конфігу.
- `ai.catalog` (tRPC) віддає UI всі моделі з прапорцем `available`; моделі провайдерів без ключа показуються вимкненими з позначкою «немає ключа» (видно, що ще можна підключити).
- Точні id моделей звіряються з документацією провайдерів під час реалізації.

| Провайдер | Текст | Фото | Відео | TTS | STT |
|---|---|---|---|---|---|
| Anthropic | ✅ | — | — | — | — |
| OpenAI | ✅ | ✅ | ✅ | ✅ (без міток) | ✅ (мітки слів) |
| Google (paid) | ✅ | ✅ | ✅ | ✅ (без міток) | ✅ |
| ElevenLabs (пізніше) | — | — | — | ✅ з мітками | ✅ |

### 7.3 Надійність, ключі, вартість
- Rate limiter на адаптер за лімітами з каталогу; 429/тимчасові помилки — ретраї з backoff; вичерпаний ліміт → зрозуміла помилка + пропозиція іншого провайдера.
- Відмова через контент-політику — показується як є, без ретраїв.
- Генерація відео: `start` + `poll` усередині задачі з `ctx.progress`.
- Усі результати одразу зберігаються в S3 як assets (URL провайдерів тимчасові).
- `CredentialStore` (зараз `.env`).
- `generations.cost_estimate` за цінами каталогу; підсумок витрат за місяць у налаштуваннях.
- Промпти — у `packages/ai/prompts` з версіями; «стиль каналу» з `user_settings` додається до промптів сценарію.

### 7.4 FakeProvider
Детермінована реалізація всіх можливостей (кольорові картинки з текстом, тиша з вигаданими мітками слів, шаблонний сценарій) — для тестів і розробки UI без витрат.

---

## 8. Публікація

### 8.1 Адаптери `Publisher`

| | YouTube | TikTok | Instagram Reels | Facebook |
|---|---|---|---|---|
| API | YouTube Data API v3 | Content Posting API (Direct Post) | Instagram API with Instagram Login | Graph API: `/{page-id}/video_reels` (9:16), `/{page-id}/videos` (16:9) |
| Доступ | Google OAuth, `youtube.upload` (+ readonly) | TikTok Login, `video.publish` | акаунт Business/Creator | **лише Facebook-сторінки**; `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` |
| Завантаження | resumable upload потоком з S3 | `FILE_UPLOAD` частинами з сервера (без верифікації домену) | контейнер `media_type=REELS` + публічний `video_url` → `media_publish` | частинами з сервера або за URL |
| Розклад | нативний (`private` + `publishAt`) | наш `Scheduler` | наш `Scheduler` | наш `Scheduler` |
| Обмеження | квота 10 000 од./день, завантаження ≈100 од.; неперевірений застосунок → відео можуть ставати приватними до аудиту | без аудиту — лише `SELF_ONLY`, ≤5 користувачів/24 год; обов'язковий `creator_info` і UI вибору приватності | 50 постів / 24 год | App Review (спільний з Instagram, один Meta-застосунок) |
| Додатково | субтитри для кожної мови (`captions.insert`), локалізовані назви/описи, мініатюра, позначка синтетичного контенту | — | файл має бути доступний з інтернету | особистий профіль — лише ручний шлях |

### 8.2 Потік
Рендер готовий → «Опублікувати» → AI генерує метадані під платформу й мову (назва, опис, теги/хештеги; редагуються) → вибір акаунтів і часу → `publications` (`scheduled`) → `Scheduler` ставить задачу `publish` → `Publisher.upload()` → опитування статусу обробки → `published` + `url` + `platform_post_id`.

Кожна мовна версія — окрема публікація (зазвичай на окремий канал/акаунт).

### 8.3 Вкладка «Публікації» і ручний шлях
- Матриця **відео (мовна версія) × платформи** зі статусами, переглядами, часом публікації, помилками й кнопкою «Повторити».
- Якщо API недоступний (аудит, особистий профіль Facebook, платформа без адаптера): `method=manual`, статус `awaiting_manual` → кнопки **«Завантажити MP4»** і **«Скопіювати метадані»** → користувач публікує сам і вставляє посилання → парсер URL для кожної платформи дає `platform_post_id` → `published`.
- Статистика ручних постів збирається через підключений акаунт з правами на читання (напр. TikTok Display API для власних відео); якщо й це недоступно — ручне введення метрик.

### 8.4 Організаційні кроки (паралельно з підпроєктами 1–3)
Подати заявки: аудит TikTok Content Posting API, Meta App Review (Instagram + Facebook), верифікація Google OAuth / аудит YouTube API. Для локальної розробки потрібен HTTPS-тунель (напр. Cloudflare Tunnel) для OAuth-редіректів TikTok/Meta і публічний URL файлів для Instagram (тунель до RustFS або публічний бакет R2 лише для файлів, що публікуються).

---

## 9. Статистика (коротко; деталізується у підпроєкті 6)
`StatsCollector` для кожної платформи (YouTube Analytics API, TikTok Display API, Instagram Insights, Facebook Video Insights) + ручне введення. Задача `stats.collect` за розкладом (`Scheduler`) пише знімки у `publication_stats`. UI: метрики в матриці публікацій + сторінка відео з динамікою.

---

## 10. Обробка помилок
- Типізовані помилки `AppError { code, message, details }`; tRPC передає код у UI.
- Помилки задач зберігаються в `jobs` (текст + хвіст stderr FFmpeg); UI — кнопка «Повторити». У конвеєрі помилка однієї сцени не блокує інші.
- Multipart-завантаження великих файлів.
- Конфлікт версій таймлайну — пропозиція перезавантажити, без мовчазного перезапису.
- Рендер: тимчасова тека в `finally`, таймаут процесу.

## 11. Тестування

| Рівень | Що | Чим |
|---|---|---|
| Unit | `assembleTimeline`, `compileFfmpeg`, генератор ASS, операції таймлайну (трім, розрізання, снепінг), підгонка темпу мов, парсери URL публікацій | Vitest |
| Інтеграційні | API + Postgres + RustFS у Docker, AI через `FakeProvider` | Vitest + docker compose |
| Рендер | справжній FFmpeg на 2–3-секундних фрагментах: тривалість (ffprobe), кольори пікселів у ключових точках; порівняння кадру `drawFrame` (прев'ю) з кадром FFmpeg у тих самих моментах (допуск) | Vitest + ffmpeg |
| E2E | файл → таймлайн → трім → рендер | Playwright |
| Живі AI/API | контрактні тести адаптерів зі справжніми ключами, лише вручну (`pnpm test:live`) | Vitest |

---

## 12. Підпроєкти та порядок

Кожен підпроєкт після нульового отримує власну коротку специфікацію → план → реалізацію.

| # | Підпроєкт | Результат |
|---|---|---|
| **0** | **Фундамент** (детально нижче) | додаток запускається; налаштування провайдерів; тестова задача з живим прогресом |
| 1 | Бібліотека: drag & drop, завантаження, генерація фото/відео, теги, пошук | генеруєте й знаходите медіа |
| 2 | Редактор + рендер: таймлайн, canvas-прев'ю, `compileFfmpeg`, 9:16 / 16:9 | монтуєте й отримуєте MP4 |
| 3 | Озвучка й субтитри: TTS, STT, мітки, ASS + JASSUB, мови (варіант C), студія озвучки | озвучуєте готове відео кількома мовами |
| 4 | Конвеєр «тема → чернетка» | одна кнопка → чернетка на таймлайні |
| 5 | Публікація: вкладка «Публікації», ручний шлях, YouTube / TikTok / Instagram / Facebook, `Scheduler` | автопостинг і ручний облік |
| 6 | Статистика | метрики по відео |

### 12.1 Підпроєкт 0 — Фундамент

**Входить:**
1. Монорепо (pnpm + Turborepo, TypeScript, ESLint/Prettier, Vitest), структура з розділу 3.2.
2. `docker-compose.yml`: Postgres, RustFS (+ автоматичне створення бакета); `.env.example` з усіма змінними (`DATABASE_URL`, `S3_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `QUEUE_DRIVER=inprocess`).
3. `packages/db`: Drizzle-схема для `users`, `user_settings`, `jobs`, `assets`, `generations` (решта таблиць — у своїх підпроєктах), міграції, seed локального користувача.
4. `packages/shared`: Zod-схема `TimelineDoc` v1, `AppError`, спільні типи.
5. `packages/jobs`: контракти + `InProcessQueue`/`WorkerRuntime` з відновленням після рестарту; SSE-ендпоінт прогресу; задача `debug.sleep` для перевірки.
6. `packages/storage`: `BlobStorage` (put/get/delete/presignPut/presignGet) на RustFS.
7. `packages/ai`: інтерфейси можливостей, реєстр, каталог-конфіг, `EnvCredentialStore`, `FakeProvider`; адаптери Anthropic/OpenAI/Google — мінімальний `TextGen` (повні можливості — у підпроєктах 1 і 3).
8. `apps/api`: Fastify + tRPC, composition root, `SingleUserAuth`, health-check (Postgres + RustFS).
9. `apps/web`: каркас (React, Router, Query, Tailwind, shadcn/ui), навігація по майбутніх розділах (заглушки), сторінка **Налаштування**: провайдери з ключами, вибір моделі за замовчуванням для кожної можливості (зберігається в `user_settings`), кнопка «Тестова задача» з живим прогресом через SSE, кнопка «Перевірити провайдера» (короткий виклик `TextGen`).

**Готово, коли:**
- `docker compose up -d && pnpm install && pnpm db:migrate && pnpm dev` піднімає web і api.
- Health-check зелений; на сторінці налаштувань доступні для вибору лише моделі провайдерів із ключами (решта — вимкнені з позначкою «немає ключа»); вибір моделі за замовчуванням зберігається після перезавантаження.
- Тестова задача показує прогрес у реальному часі; після рестарту API незавершені задачі коректно відновлюються/позначаються.
- Unit- та інтеграційні тести (`pnpm test`) проходять, зокрема з `FakeProvider` і RustFS.

---

## 13. Ризики та відкриті питання
- **Аудити платформ** (TikTok, Meta, Google) займають тижні → подаються рано; ручний шлях знімає блокування.
- **Різниця прев'ю/рендеру** у варіанті A → тести порівняння кадрів (розділ 11); ефекти лише з закритої бібліотеки.
- **Довгі 16:9 рендери** на локальній машині → у v1 прийнятно; масштабування — окремі render-воркери (BullMQ).
- **Публічний доступ до файлів для Instagram** у локальному режимі → тунель або R2.
- **Ціни й моделі AI змінюються** → каталог у конфігу, `cost_estimate` — оцінка, а не рахунок.
