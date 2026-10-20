# Фабрика відео

Веб-додаток для створення коротких (9:16) і довгих (16:9) відео для YouTube, Shorts, Reels і TikTok: AI-генерація медіа, монтаж, озвучка кількома мовами, автопублікація і статистика.

- Специфікація: [docs/specs/2026-10-20-video-factory-design.md](docs/specs/2026-10-20-video-factory-design.md)
- План підпроєкту 0: [docs/plans/2026-10-20-subproject-0-foundation.md](docs/plans/2026-10-20-subproject-0-foundation.md)
- Підпроєкт 1 «Бібліотека»: [специфікація](docs/specs/2026-10-20-subproject-1-library.md), [план](docs/plans/2026-10-20-subproject-1-library.md)
- Прототипи рушіїв монтажу: [prototypes/editor-demos](prototypes/editor-demos)

## Передумови

- Docker Desktop (запущений)
- Node.js ≥ 24
- pnpm 12: `npm i -g pnpm@12`

## Швидкий старт

```bash
cp .env.example .env
docker compose up -d --build   # Postgres, RustFS і API (з ffmpeg); міграції застосовуються автоматично
pnpm install                   # залежності для web на хості
pnpm dev                       # web (Vite) на хості
```

Відкрийте http://localhost:5173 → «Налаштування».

- API працює в контейнері `api` (http://localhost:3001, tRPC на `/trpc`): сирці змонтовані, зміни підхоплюються без перезбирання. Логи — `docker compose logs -f api`. Після зміни `pnpm-lock.yaml` залежності в контейнері оновлюються самі при наступному старті (`docker compose restart api`).
- Консоль сховища RustFS: http://localhost:9001 (логін і пароль — `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` з `.env`)

## AI-ключі

Впишіть у `.env` ключі провайдерів, якими користуєтесь (порожньо = провайдер недоступний), і перезапустіть `pnpm dev`:

```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GOOGLE_API_KEY=...   # лише платний ключ Gemini
```

`AI_FAKE=1` вмикає fake-провайдер: детерміновані відповіді без витрат, щоб працювати з UI без ключів.

## Бібліотека

- **Завантаження:** перетягніть файли на будь-яку сторінку або натисніть «Завантажити» в «Бібліотеці». Файли йдуть напряму в сховище (великі — частинами по 16 МБ), потім API читає метадані (ffprobe) і робить мініатюру.
  - Фото: JPEG, PNG, WebP, GIF — до 50 МБ; відео: MP4, MOV, WebM — до 5 ГБ; аудіо: MP3, WAV, M4A, OGG — до 500 МБ.
- **Генерація:** «Згенерувати» → фото або відео з текстового опису; модель вибирається для кожного запуску (за замовчуванням — з «Налаштувань»). Вартість кожного виклику пишеться в `generations.cost_estimate`.
  - Фото: OpenAI GPT Image, Google Gemini Image. Відео: Google Gemini Omni Flash (OpenAI Sora API вимкнено у вересні 2026, Veo preview у Gemini API — у жовтні 2026).
- **Теги й пошук:** згенеровані файли отримують теги з опису; завантажені — з мініатюри (vision), якщо в «Налаштуваннях» увімкнено «Авто-теги» (≈ $0.0001–0.0003 за файл на дешевій моделі). Пошук — за назвою, тегами й описом, зокрема з опечатками; фільтри — тип, джерело, орієнтація, теги.
- Файли видно в консолі RustFS (http://localhost:9001), бакет `vf-media`, ключі `u/<користувач>/assets/<id>/…`. Незавершені завантаження прибираються через 24 год.

## Тести

```bash
pnpm test                    # unit + інтеграційні — у контейнері api (там ffmpeg), потрібен docker compose up -d
pnpm test:unit               # лише unit
pnpm test:live               # справжні виклики AI-провайдерів з ключами з .env
pnpm --filter @vf/web e2e    # Playwright на хості; API — контейнер api-e2e (тестова БД, порт 3101)
pnpm typecheck && pnpm lint
```

Будь-яку vitest-команду можна виконати в контейнері так: `docker compose run --rm api pnpm vt <фільтр>`.

Перед першим e2e: `pnpm --filter @vf/web exec playwright install chromium`.

## Структура

```
apps/api        Fastify + tRPC, composition root, черга задач in-process
apps/web        React SPA (Vite, TanStack Router/Query, Tailwind, shadcn/ui)
packages/shared типи, помилки, схема таймлайну
packages/db     Drizzle-схема, міграції, seed
packages/jobs   контракти черги, Postgres-сховище задач, InProcessQueue
packages/storage S3 BlobStorage (RustFS локально, S3/R2 у продакшені)
packages/ai     каталог моделей, реєстр провайдерів, адаптери, FakeProvider
```

## Примітки

- **Новий пакет у `packages/`** → додайте рядок тому `node_modules` у `volumes` сервісу `api` (і в список томів унизу) у `docker-compose.yml` (інакше в контейнері його залежності змішаються з macOS-версіями з хоста).

- **S3 локально — RustFS**, не MinIO: MinIO з жовтня 2025 не публікує Docker-образи. Запасний варіант — SeaweedFS (`weed server -s3`), бо код працює через інтерфейс `BlobStorage`.
- Черга задач зараз виконується в процесі API, а її стан зберігається в Postgres. Після перезапуску незавершені задачі позначаються «Перервано перезапуском сервера», а ті, що чекали в черзі, виконуються.
