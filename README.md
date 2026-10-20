# Фабрика відео

Веб-додаток для створення коротких (9:16) і довгих (16:9) відео для YouTube, Shorts, Reels і TikTok: AI-генерація медіа, монтаж, озвучка кількома мовами, автопублікація і статистика.

- Специфікація: [docs/specs/2026-10-20-video-factory-design.md](docs/specs/2026-10-20-video-factory-design.md)
- План підпроєкту 0: [docs/plans/2026-10-20-subproject-0-foundation.md](docs/plans/2026-10-20-subproject-0-foundation.md)
- Прототипи рушіїв монтажу: [prototypes/editor-demos](prototypes/editor-demos)

## Передумови

- Docker Desktop (запущений)
- Node.js ≥ 24
- pnpm 12: `npm i -g pnpm@12`

## Швидкий старт

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Відкрийте http://localhost:5173 → «Налаштування».

- API: http://localhost:3001 (tRPC на `/trpc`)
- Консоль сховища RustFS: http://localhost:9001 (логін і пароль — `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` з `.env`)

## AI-ключі

Впишіть у `.env` ключі провайдерів, якими користуєтесь (порожньо = провайдер недоступний), і перезапустіть `pnpm dev`:

```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GOOGLE_API_KEY=...   # лише платний ключ Gemini
```

`AI_FAKE=1` вмикає fake-провайдер: детерміновані відповіді без витрат, щоб працювати з UI без ключів.

## Тести

```bash
pnpm test                    # unit + інтеграційні (потрібен docker compose up -d)
pnpm test:unit               # лише unit
pnpm test:live               # справжні виклики AI-провайдерів з ключами з .env
pnpm --filter @vf/web e2e    # Playwright (сам піднімає API і веб)
pnpm typecheck && pnpm lint
```

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

- **S3 локально — RustFS**, не MinIO: MinIO з жовтня 2025 не публікує Docker-образи. Запасний варіант — SeaweedFS (`weed server -s3`), бо код працює через інтерфейс `BlobStorage`.
- Черга задач зараз виконується в процесі API, а її стан зберігається в Postgres. Після перезапуску незавершені задачі позначаються «Перервано перезапуском сервера», а ті, що чекали в черзі, виконуються.
