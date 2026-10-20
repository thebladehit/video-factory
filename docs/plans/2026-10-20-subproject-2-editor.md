# Підпроєкт 2 «Редактор + рендер» — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сторінка «Проєкти» і редактор (таймлайн, canvas-прев'ю, undo/redo, автозбереження, drag & drop) + серверний рендер `compileFfmpeg` → MP4 у бібліотеці; прев'ю збігається з рендером за таймінгом.

**Architecture:** Новий чистий пакет `@vf/timeline` — єдине джерело правди для операцій, обчислення кадру (`evaluate`), законів ефектів (число для canvas + вираз для ffmpeg) і `drawFrame`. Пакет `@vf/render` компілює той самий документ у ffmpeg-граф і запускає його за інтерфейсом `Renderer`. `apps/api` отримує модулі `projects` і `renders` (сервіс + тонкий роутер) і задачі `render`, `asset.analyze`; `apps/web` — маршрути `/` (Проєкти) і `/projects/$id` (редактор) зі стором Zustand + zundo і `PreviewEngine` на canvas + Web Audio.

**Tech Stack:** як у підпроєкті 1 (Node 24, pnpm 12, TypeScript 6.0.x, Vitest 5, Fastify 5, tRPC 11, Zod 4, Drizzle 0.45, Postgres 17, RustFS, ffmpeg 5.1 Debian у контейнері, React 19, Vite 8, TanStack Router/Query, Tailwind 4, shadcn 4, Playwright) **+** `zustand@^5`, `zundo@^2`, `@napi-rs/canvas` (devDependency `@vf/timeline`, лише тести).

**Spec:** `docs/specs/2026-10-20-subproject-2-editor.md` (обсяг і рішення); `docs/specs/2026-10-20-video-factory-design.md` (§2.1, §5.1, §6.3, §6.5, §11).

## Global Constraints

- Гілка `feat/subproject-2-editor` (від `feat/subproject-1-library`); нічого не пушити без слова власника.
- Мова UI й повідомлень помилок — українська; ідентифікатори — англійська.
- TypeScript 6.0.x; ESM; нові пакети `@vf/timeline`, `@vf/render` з `"exports": { ".": "./src/index.ts" }`; **кожен новий пакет = рядок тому `nm-<name>` у `docker-compose.yml` (обидва сервіси через `*api-volumes`) і в `volumes` унизу**.
- `TimelineDoc` лишається `schemaVersion: 1`; нові поля лише необов'язкові; документ з БД завжди проходить `normalizeDoc`.
- Усі часи таймлайну округлюються до кадру `1/fps` (fps = 30); мінімальна тривалість кліпу — 1 кадр.
- Замовчування: фото — 5 с + `kenburns { fromScale: 1, toScale: 1.15, fromX/Y/toX/Y: 0.5 }`; `zoom { scale: 1.2, x: 0.5, y: 0.5 }`; `fade { in: 0.3, out: 0 }`; `xfade { duration: 0.5 }`; снепінг 8 px; undo — 100 кроків; автозбереження — debounce 1,5 с.
- Рендер: `final` = розмір документа, `libx264 -preset medium -crf 20`; `draft` = довша сторона 1280, `-preset veryfast -crf 26`; обидва `-pix_fmt yuv420p -r 30`, AAC 192k 48 кГц, `-movflags +faststart`; таймаут `max(10 хв, 5 × тривалість)`; задача `render` concurrency 1; **без `zoompan`**.
- Піки: `Uint8`, 100 значень/с, моно, ключ `u/{userId}/assets/{assetId}/peaks.bin`.
- Payload задач — лише id (`{ renderId }`, `{ assetId }`); обробники ідемпотентні; прогрес лише через `ctx.progress`; кожен запит фільтрується за `userId`, чужий id → `NOT_FOUND`.
- Тести: `*.test.ts` unit, `*.int.test.ts` int (включно з render-тестами на ffmpeg), `*.spec.ts` Playwright. Vitest — у контейнері (`pnpm test`, фільтр: `docker compose run --rm api pnpm vt <фільтр>`); e2e — на хості (`pnpm --filter @vf/web e2e`, API `api-e2e` :3101, Vite :5174). Порт 3001 на хості може тримати чужий `pnpm dev` — не чіпати; для ручної перевірки в браузері — конфіг `web-e2e-api` з `.claude/launch.json`.
- Кожна задача закінчується зеленим `pnpm test` для зачеплених пакетів, `pnpm typecheck && pnpm lint` і комітом (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

## Review Focus

1. **Відео без аудіопотоку (або `has_audio` ще null) з `volume > 0`** → рендер не падає з «Stream specifier ':a' matches no streams», виходить тиша. Тест — Task 8.
2. **Кліп на всю довжину джерела, у якого справжня тривалість трохи менша за `durationMs`** (округлення ffprobe/кадрів) → останній кадр — кадр кліпу (заморожений), а не чорний; прев'ю теж тримає останній кадр. Тест — Task 8 (`tpad=stop_mode=clone`) і Task 2 (`trimEnd` обрізає до кадру вниз).
3. **Непарні або «телефонні» розміри джерела** (повернуте вертикальне відео, 333×251 фото) у проєкті іншого формату, cover і contain, final і draft → коректний кадр, парні розміри виходу, без падіння `yuv420p`. Тест — Task 8.
4. **Зміна таймлайну під час збереження, що вже йде** → жодна зміна не губиться, немає самоконфлікту (наступне збереження бере `version` з відповіді попереднього). Тест — Task 10.
5. **Видалення файлу, який стоїть у проєкті, зокрема під час рендеру** → `projects.get` віддає `missing`, `renders.start` → `VALIDATION`; рендер, що вже йде, — `failed` «Файл «…» видалено з бібліотеки», без зависання й без asset. Тест — Task 6 і Task 9.

---

## Структура файлів

```
packages/shared/src/{timeline,jobs,assets}.ts                (+ timeline.test.ts)
packages/timeline/src/{index,time,ops,snap,evaluate,laws,draw}.ts     (+ *.test.ts, draw.int.test.ts)
packages/media/src/{ffmpeg,probe,peaks}.ts                   (+ media.int.test.ts)
packages/render/src/{index,compile,compile-video,compile-audio,ffmpeg-renderer,progress}.ts (+ compile.test.ts, render.int.test.ts)
packages/db/src/schema.ts  packages/db/drizzle/0004_editor.sql
apps/api/src/modules/assets/{process-job,analyze-job,service,search,router}.ts
apps/api/src/modules/projects/{service,editor-assets,router}.ts
apps/api/src/modules/renders/{service,render-job,router}.ts
apps/api/src/modules/recovery.ts  apps/api/src/app.ts  apps/api/src/routers/index.ts
apps/api/test/{analyze,projects,renders}.int.test.ts
apps/web/src/editor/{store,autosave,preview-engine,audio-graph,media-cache,use-editor-assets}.ts (+ store.test.ts, autosave.test.ts)
apps/web/src/components/editor/{EditorPage,Toolbar,LibraryPanel,PreviewPane,Inspector,Timeline,TimelineClip,Waveform,RenderMenu,RenderHistory,ConflictDialog}.tsx
apps/web/src/components/projects/{ProjectGrid,NewProjectDialog}.tsx
apps/web/src/routes/{index,projects.$id}.tsx  apps/web/src/components/library/AssetSheet.tsx
apps/web/src/components/upload/UploadProvider.tsx
apps/web/e2e/editor.spec.ts  vitest.config.ts (+ apps/web)  docker-compose.yml  README.md
```

---

### Task 1: Схема `TimelineDoc` v1+ і типи задач

**Files:**
- Modify: `packages/shared/src/timeline.ts`, `packages/shared/src/jobs.ts`, `packages/shared/src/assets.ts`
- Test: `packages/shared/src/timeline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Effect =
    | { type: 'kenburns'; params: { fromScale: number; toScale: number; fromX: number; fromY: number; toX: number; toY: number } }
    | { type: 'zoom'; params: { scale: number; x: number; y: number } }
    | { type: 'fade'; params: { in: number; out: number } }
    | { type: 'xfade'; params: { duration: number } };
  type EffectType = Effect['type'];
  const EFFECT_DEFAULTS: { [K in EffectType]: Extract<Effect, { type: K }>['params'] };
  MediaClip += { volume?: number /*0..2*/; linkId?: string }
  AudioClip += { linkId?: string }
  AudioTrack.role: 'voiceover' | 'music' | 'sfx' | 'original'
  function normalizeDoc(input: unknown): TimelineDoc; // parse + заповнення params з EFFECT_DEFAULTS; кидає AppError('VALIDATION')
  JobType += 'render' | 'asset.analyze';  JobSubject += { renderId?: string; projectId?: string }
  assetKeys.peaks(userId, assetId) => `u/${userId}/assets/${assetId}/peaks.bin`
  ```
- [ ] **Step 1: Failing tests** у `timeline.test.ts`: `normalizeDoc fills kenburns defaults for params: {}` (→ `{ fromScale: 1, toScale: 1.15, fromX: 0.5, … }`); `keeps explicit params`; `accepts linkId, volume and role 'original'`; `rejects volume 2.5`; `rejects kenburns scale <= 0` (scale-параметри `positive`, координати `0..1`, тривалості `≥ 0`); наявні тести схеми лишаються зеленими; `jobSubject` дістає `renderId`.
- [ ] **Step 2:** `docker compose run --rm api pnpm vt shared` → FAIL.
- [ ] **Step 3:** Ефекти — `z.discriminatedUnion('type', …)`, де `params` кожного типу — `z.object` з `.partial()` на вході і `normalizeDoc` зливає з `EFFECT_DEFAULTS` (тип `TimelineDoc` — вже повний). `jobSubject` додає `renderId`/`projectId`.
- [ ] **Step 4:** тести PASS; `pnpm typecheck` (наявні споживачі `Effect` у `packages/*` компілюються).
- [ ] **Step 5:** Commit `feat(shared): timeline v1 additions — typed effects, linked clips, original audio role`.

---

### Task 2: `@vf/timeline` — час і операції

**Files:**
- Create: `packages/timeline/{package.json,tsconfig.json}`, `packages/timeline/src/{index,time,ops,snap}.ts`
- Modify: `docker-compose.yml` (`nm-timeline`), `pnpm-lock.yaml`
- Test: `packages/timeline/src/ops.test.ts`, `packages/timeline/src/snap.test.ts`

**Interfaces:**
- Consumes: Task 1 типи.
- Produces:
  ```ts
  // time.ts
  quantize(t: number, fps: number): number;          // до найближчого кадру
  quantizeDown(t: number, fps: number): number;      // вниз (межі джерела)
  docDuration(doc: TimelineDoc): number;
  // ops.ts — усі чисті, повертають новий doc; невідомий id → doc без змін
  interface AssetInfo { id: string; kind: 'image' | 'video' | 'audio'; durationSec?: number; hasAudio?: boolean | null }
  addClip(doc, asset: AssetInfo, opts: { at: number; trackId?: string }, newId?: () => string): { doc: TimelineDoc; clipIds: string[] };
  moveClip(doc, clipId, start: number, sources: SourceLengths, trackId?: string): TimelineDoc;
  trimStart(doc, clipId, t: number, sources: SourceLengths): TimelineDoc;
  trimEnd(doc, clipId, t: number, sources: SourceLengths): TimelineDoc;
  splitAt(doc, clipId, t: number, newId?: () => string): TimelineDoc;
  deleteClips(doc, ids: string[]): TimelineDoc;
  unlink(doc, linkId: string): TimelineDoc;
  addLinkedAudio(doc, videoClipId: string, newId?): TimelineDoc;   // після ready з has_audio (6.6 спеки)
  setVolume(doc, clipId, v: number): TimelineDoc;
  setEffect(doc, clipId, effect: Effect): TimelineDoc; removeEffect(doc, clipId, type: EffectType): TimelineDoc;
  setTransition(doc, clipId, duration: number): TimelineDoc;      // xfade; перекриття з попереднім кліпом доріжки
  setFormat(doc, format: VideoFormat): TimelineDoc;
  findClip(doc, clipId): { track: Track; clip: MediaClip | AudioClip } | null;
  type SourceLengths = Record<string /*assetId*/, number | undefined>; // секунди; undefined = фото/невідомо
  // snap.ts
  snapTargets(doc, opts: { playhead: number; exclude: string[] }): number[];
  snap(value: number, targets: number[], opts: { tolerancePx: number; pxPerSec: number }): { value: number; target: number | null };
  ```
- [ ] **Step 1: Failing tests** (`ops.test.ts`, fps 30):
  - `addClip image → 5s with default kenburns on a new video track`;
  - `addClip video with hasAudio → linked audio on 'original' track with same start/in/duration and video volume 0`; `video without audio → no audio clip, volume 1`; `audio → 'music' track`; порядок доріжок `video…, original, music`;
  - `moveClip moves the linked partner`; `moving onto an occupied place snaps flush to the nearest free edge`; `start never below 0`;
  - `trimEnd clamps to source length rounded down to a frame` (джерело 2.0166 с → 2.0); `trimStart keeps in >= 0 and updates in/start/duration`; `image trim has no source bound`; `min duration is one frame`;
  - `splitAt splits both linked clips and gives the right halves a new shared linkId`; `split outside the clip is a no-op`;
  - `deleteClips(video) removes its linked audio`; `deleteClips(audio) keeps video with volume 0`;
  - `unlink removes linkId from both`; `setTransition creates an overlap equal to duration and clamps to the shorter clip`; `setFormat swaps width/height`;
  - `all times are multiples of 1/30` (property: випадкові `moveClip`/`trim*` 200 разів → `Math.abs(t*30 - round(t*30)) < 1e-9`).
  - `snap.test.ts`: `snaps within 8px`, `does not snap at 9px`, `targets include playhead and 0 and exclude moving clips`.
- [ ] **Step 2:** `pnpm vt timeline` у контейнері → FAIL.
- [ ] **Step 3:** Реалізувати. Id — `crypto.randomUUID()` за замовчуванням. «Впритул»: якщо новий інтервал перетинає кліп доріжки (не враховуючи дозволене `xfade`-перекриття), ставити кліп лівіше або правіше перешкоди — що ближче до бажаного `start`. `moveClip` між доріжками — лише того самого `kind`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(timeline): frame-quantized timeline operations with linked clips and snapping`.

---

### Task 3: Закони ефектів, `evaluate`, `audioPlan`

**Files:**
- Create: `packages/timeline/src/{laws,evaluate}.ts`
- Test: `packages/timeline/src/laws.test.ts`, `packages/timeline/src/evaluate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // laws.ts — p ∈ [0,1] прогрес у кліпі
  interface Law { at(p: number): number; expr(p: string): string }
  lerp(a: number, b: number): Law; constant(v: number): Law;
  easeAlpha(fadeIn: number, fadeOut: number, duration: number): { at(local: number): number; expr(local: string): string }; // local — секунди від початку кліпу
  clipTransform(effects: Effect[]): { scale: Law; cx: Law; cy: Law };   // kenburns > zoom > identity
  // evaluate.ts
  interface Layer { clipId: string; assetId: string; kind: 'image' | 'video'; sourceTime: number; alpha: number; scale: number; cx: number; cy: number; fit: 'cover' | 'contain' }
  evaluate(doc: TimelineDoc, t: number, kinds: Record<string, 'image' | 'video'>): Layer[];
  interface AudioItem { clipId: string; assetId: string; start: number; in: number; duration: number; volume: number; fadeIn: number; fadeOut: number }
  audioPlan(doc: TimelineDoc): AudioItem[];   // аудіокліпи + відео-кліпи з volume > 0
  ```
- [ ] **Step 1: Failing tests:**
  - `laws.test.ts`: мінімальний інтерпретатор виразів у тесті (числа, `+ - * /`, дужки, `min`, `max`, змінна) — для кожного закону й 11 точок `p = 0, 0.1 … 1` `evaluate(expr('p'))` ≈ `at(p)` (1e-9). Вирази ffmpeg-сумісні: лише `+ - * / ( ) min max` і змінна (без `^`, `if`).
  - `evaluate.test.ts`: `gap → []`; `clip interval is [start, start+duration)`; `sourceTime = t - start + in`; `kenburns scale at start/middle/end = 1 / 1.075 / 1.15`; `fade in 0.3: alpha(0.15) = 0.5`; `xfade: during overlap the later clip alpha rises 0→1 and both layers are present`; `layer order = track order`; `audioPlan includes video clip with volume 0.5 and excludes volume 0`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Реалізувати. Альфа = `min(fadeIn-рампа, fadeOut-рампа, xfade-рампа)`; `xfade` додає вхідну рампу тривалістю `duration`. У ffmpeg альфа реалізується фільтром `fade=…:alpha=1` з тими самими `st/d` (лінійна рампа = той самий закон), тож `easeAlpha.expr` перевіряється лише паритет-тестом.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(timeline): effect laws, frame evaluation and audio plan`.

---

### Task 4: `drawFrame` (браузер і `@napi-rs/canvas`)

**Files:**
- Create: `packages/timeline/src/draw.ts`
- Modify: `packages/timeline/package.json` (devDependency `@napi-rs/canvas`)
- Test: `packages/timeline/src/draw.int.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Ctx2D { save(); restore(); setTransform(a,b,c,d,e,f); fillStyle: unknown; fillRect(x,y,w,h); globalAlpha: number;
                    imageSmoothingEnabled: boolean; imageSmoothingQuality: 'low'|'medium'|'high';
                    drawImage(img: unknown, dx: number, dy: number, dw: number, dh: number): void }
  interface FrameSource { image: unknown; width: number; height: number }       // HTMLImageElement / HTMLVideoElement / napi Image
  drawFrame(ctx: Ctx2D, size: { width: number; height: number }, layers: Layer[], sources: (l: Layer) => FrameSource | null, scale?: number): void;
  coverRect(src: {width;height}, dst: {width;height}, fit, scale, cx, cy): { x: number; y: number; w: number; h: number }; // спільна геометрія; її ж повторює compile-video
  ```
- [ ] **Step 1: Failing tests** (`@napi-rs/canvas`, у контейнері): `black canvas for no layers`; `cover fills the frame with the source color` (джерело 64×48 червоне на 108×192 → піксель центру й кутів червоний); `contain leaves black bars` (16:9 джерело на 9:16 → верх чорний, центр — колір); `alpha 0.5 blends with black` (≈ 128 ±3); `top layer covers bottom`; `coverRect with scale 1.15 centered at (0.5,0.5) is centered and 15% larger`; `focus point (0,0) keeps the top-left corner anchored`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Реалізувати; `imageSmoothingQuality = 'high'`; `scale` — множник роздільності (прев'ю × dpr).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(timeline): drawFrame shared by the canvas preview and node tests`.

---

### Task 5: Звук у бібліотеці — `has_audio`, піки, `asset.analyze`, міграція 0004

**Files:**
- Modify: `packages/media/src/{ffmpeg,probe,index}.ts`, `packages/db/src/schema.ts`, `apps/api/src/modules/assets/process-job.ts`, `apps/api/src/modules/recovery.ts`, `apps/api/src/app.ts`, `apps/api/src/modules/assets/search.ts` (`AssetView += hasAudio`)
- Create: `packages/media/src/peaks.ts`, `packages/db/drizzle/0004_editor.sql` (`pnpm --filter @vf/db generate`, разом з таблицями Task 6/9 — **уся схема цього підпроєкту в одній міграції**), `apps/api/src/modules/assets/analyze-job.ts`
- Test: `packages/media/src/media.int.test.ts`, `apps/api/test/analyze.int.test.ts`

**Interfaces:**
- Produces:
  ```ts
  run(bin, args, { signal?, timeoutMs?, onStdout?: (chunk: Buffer) => void })  // з onStdout stdout не буферизується
  MediaProbe += { hasAudio: boolean }
  peaks(tools, path, { signal? }): Promise<Uint8Array>;   // ffmpeg -ac 1 -ar 8000 -f f32le pipe:1 → max|x| по вікнах 80 семплів → 0..255
  synthVideo(..., { tone?: number /*Гц*/ })  // відео з синусом для тестів
  // db
  assets += hasAudio: boolean | null (has_audio), peaksKey: text | null (peaks_key)
  projects, renders — таблиці за §2 спеки (Task 6 і 9 лише користуються)
  // api
  analyzeAsset(deps, row: AssetRow, local: string, signal): Promise<{ hasAudio: boolean; peaksKey: string | null }>
  assetAnalyzeJob(deps): JobDef<{ assetId: string }, { assetId: string }>  // concurrency 2; лише ready з has_audio is null
  ```
- [ ] **Step 1: Failing tests:** `media.int`: `probe reports hasAudio for a video with a tone and not for a silent one`; `peaks of 2s tone ≈ 200 values all > 100`; `peaks of silence are all 0`; `peaks streams a 10-minute file without buffering stdout` (`anullsrc` 600 с → довжина 60 000). `analyze.int`: `asset.process stores has_audio and peaks for video with sound`; `image gets has_audio false and no peaks`; `startup enqueues asset.analyze for ready video with has_audio null and fills it`; `asset.analyze is idempotent` (повтор не міняє `peaks_key`).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Схема (усі колонки й таблиці підпроєкту: `assets.has_audio`, `assets.peaks_key`, `projects`, `renders` з індексами й check-обмеженнями за §2 спеки) → `generate` → `0004_editor.sql`. `process-job` після мініатюри викликає `analyzeAsset` для відео/аудіо. `reconcileAfterRestart` ставить `asset.analyze` для `ready` відео/аудіо з `has_audio is null` без живої задачі. Зареєструвати задачу в `app.ts`.
- [ ] **Step 4:** PASS (`pnpm test` — уся сюїта, бо міграція).
- [ ] **Step 5:** Commit `feat(assets): detect audio and store waveform peaks; migration 0004`.

---

### Task 6: Модуль `projects` і `assets.usage`

**Files:**
- Create: `apps/api/src/modules/projects/{service,editor-assets,router}.ts`
- Modify: `apps/api/src/routers/index.ts`, `apps/api/src/modules/assets/{router,search}.ts` (`usage`), `apps/api/src/index.ts` (реекспорт типів для web)
- Test: `apps/api/test/projects.int.test.ts`

**Interfaces:**
- Consumes: `normalizeDoc`, `emptyTimeline` (Task 1), таблиця `projects` (Task 5).
- Produces:
  ```ts
  type EditorAsset =
    | { id: string; missing: false; kind: AssetKind; status: AssetStatus; title: string; url: string; thumbUrl: string | null;
        peaksUrl: string | null; width: number | null; height: number | null; durationMs: number | null; hasAudio: boolean | null; urlExpiresAt: string }
    | { id: string; missing: true };
  interface ProjectCard { id: string; title: string; format: VideoFormat; durationSec: number; thumbUrl: string | null; updatedAt: string }
  interface ProjectView { id: string; title: string; format: VideoFormat; timeline: TimelineDoc; version: number; assets: Record<string, EditorAsset> }
  // tRPC: projects.{list, create({title, format}) → {id}, get({id}) → ProjectView, assets({ids}) → Record<string, EditorAsset>,
  //   save({id, timeline, baseVersion}) → {version}, rename({id,title}), duplicate({id}) → {id}, delete({id})}
  // assets.usage({id}) → { projectId: string; title: string }[]
  ```
- [ ] **Step 1: Failing tests:** `create → get returns an empty normalized 9:16 timeline at version 1`; `save with baseVersion increments version and recomputes asset_ids`; `save with stale baseVersion → CONFLICT and does not write`; `save rejects an invalid timeline → VALIDATION`; `save of 16:9 dimensions updates format`; `get marks deleted assets as missing` (видалити asset через `assets.delete`); `get enqueues asset.analyze for a used asset with has_audio null`; `usage lists projects containing the asset`; `list is ordered by updatedAt and shows thumb of the first visual clip`; `duplicate copies timeline with a new id and "(копія)" title`; `another user's project → NOT_FOUND` (caller з іншим `userId`); `assets({ids}) ignores foreign ids` (→ `missing`).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** `save`: `UPDATE … SET timeline, timeline_version = timeline_version + 1, asset_ids, format, updated_at WHERE id AND user_id AND timeline_version = baseVersion RETURNING`; нема рядка → перевірити існування → `NOT_FOUND` або `CONFLICT` («Проєкт змінено в іншій вкладці»). `asset_ids` — унікальні `assetId` усіх кліпів, лише валідні uuid. `urlExpiresAt` = час підпису + 1 год.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): projects module with optimistic timeline versions and asset usage`.

---

### Task 7: `@vf/render` — `compileFfmpeg`

**Files:**
- Create: `packages/render/{package.json,tsconfig.json}`, `packages/render/src/{index,compile,compile-video,compile-audio}.ts`
- Modify: `docker-compose.yml` (`nm-render`)
- Test: `packages/render/src/compile.test.ts`

**Interfaces:**
- Consumes: `evaluate`-закони (`clipTransform`, `coverRect`), `audioPlan`, `docDuration` (Tasks 2–4).
- Produces:
  ```ts
  type Preset = 'final' | 'draft';
  interface SourceInfo { path: string; kind: 'image' | 'video' | 'audio'; width?: number; height?: number; hasAudio: boolean }
  interface CompileInput { doc: TimelineDoc; preset: Preset; sources: Map<string, SourceInfo>; language?: string | null; filterScriptPath: string; outPath: string }
  interface Compiled { args: string[]; filterScript: string; durationSec: number; width: number; height: number }
  compileFfmpeg(input: CompileInput): Compiled;
  outputSize(doc, preset): { width: number; height: number };  // draft: довша сторона 1280, обидві парні
  ```
- [ ] **Step 1: Failing tests** (`compile.test.ts`, без ffmpeg): `one input per visual clip with -ss in -t duration (video) / -loop 1 -framerate 30 -t duration (image)`; `overlay enable between(t,start,end) per clip in track order`; `setpts shifts by start`; `tpad stop_mode=clone after video sources`; `fade alpha filters for fade and xfade`; `no zoompan anywhere`; `audio item → volume, afade, adelay=<ms>:all=1, amix normalize=0 with anullsrc of total duration`; `video clip with hasAudio false is not in amix even if volume > 0`; `draft 9:16 → 720x1280 and -preset veryfast -crf 26`; `final → -preset medium -crf 20`; `uses -filter_complex_script with filterScriptPath`; `-t equals docDuration`; `200 clips compile and args stay under 32 KB` (граф — у файлі).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Реалізувати за §5.1 спеки. Трансформація шару — окрема функція `transformFilter(transform, srcSize, outSize, dur): string` у `compile-video.ts`: варіант A — `scale=w='…':h='…':eval=frame` (розмір cover/contain × `scale.expr`) + `crop=W:H:x='…':y='…'` (зсув за `cx/cy.expr`), де `p = min(1, t/<dur>)`. Task 8 перевіряє його на справжньому ffmpeg і за потреби замінює тіло цієї функції — інтерфейс і тести Task 7 лишаються. Contain — `pad` з прозорим тлом після `format=yuva420p`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(render): compileFfmpeg — black canvas + per-clip overlay, amix audio`.

---

### Task 8: `FfmpegRenderer` і render-тести на справжньому ffmpeg

**Files:**
- Create: `packages/render/src/{ffmpeg-renderer,progress}.ts`
- Modify: `packages/render/src/compile-video.ts` (обраний варіант трансформації)
- Test: `packages/render/src/render.int.test.ts`

**Interfaces:**
- Consumes: `run(…, { onStdout })` (Task 5), `compileFfmpeg` (Task 7), `drawFrame` (Task 4), `synthImage/synthVideo/synthAudio` (+ `tone`).
- Produces:
  ```ts
  interface Renderer { render(input: CompileInput, ctx: { signal: AbortSignal; onProgress(pct: number): void; timeoutMs: number }): Promise<void> }
  createFfmpegRenderer(tools: MediaTools): Renderer;
  parseProgress(chunk: string, durationSec: number): number | null;   // out_time_us → 0..100
  ```
- [ ] **Step 1: Спайк трансформації (рішення до коду продукту).** Тест `ken burns frame matches drawFrame` на фото-текстурі (шахівниця 8×8 клітинок, 1200×1200) у 9:16 при `t = 0.1, 2.5, 4.9` з варіантом A з Task 7 (`scale=…:eval=frame` + `crop` із виразними `x/y`); запасний (B) — той самий граф, але `scale` до фіксованого розміру ×`maxScale` перед ним і `overlay` з виразними `x/y` на прозоре полотно W×H замість `crop`. Якщо жоден не проходить критерій — зупинитися й повідомити власника з виміряними числами (не повертатися до `zoompan` мовчки). Критерій: ffmpeg 5.1 приймає граф, середня абсолютна різниця з `drawFrame` ≤ 12/255 і монотонний плавний масштаб (різниця центральної клітинки між сусідніми кадрами не стрибає більш ніж удвічі від середньої). Обраний варіант і виміряну різницю записати коментарем у `compile-video.ts`; поріг у тесті = виміряне × 1.5, але ≤ 12.
- [ ] **Step 2: Failing tests** (усі на 2–4-секундних фрагментах, `draft` якщо не сказано інше):
  - `duration matches docDuration ±1 frame` (final і draft; ffprobe);
  - `draft output is 720x1280 / 1280x720`;
  - `gap is black, clip shows its color, upper track covers lower` (пікселі центру в моменти 0.5/1.5/2.5);
  - `fade-in midpoint is ~50% of the color (±10%)`; `xfade midpoint blends both clips`;
  - `full-length video clip ends on its own color, not black` (Review Focus 2);
  - `odd-sized 333x251 image and rotated phone video in 16:9 cover/contain render` (Review Focus 3);
  - аудіо через `astats`/`volumedetect` по інтервалах: `tone inside clip, silence outside`; `volume 0 → silence`; `silent video with volume 1 renders and is silent` (Review Focus 1); `two audio clips mix without clipping normalization (normalize=0)`;
  - `progress reaches >= 95 and is monotonic`; `abort kills ffmpeg and rejects with aborted`; `timeout rejects`;
  - `30 short clips render` (довгий граф через файл).
- [ ] **Step 3:** `FfmpegRenderer`: записати `filterScript` у `filterScriptPath`, `run(ffmpeg, args, { signal, timeoutMs, onStdout })`, буферизувати рядки `-progress`, `onProgress(min(95, pct))`.
- [ ] **Step 4:** `docker compose run --rm api pnpm vt render` → PASS.
- [ ] **Step 5:** Commit `feat(render): FfmpegRenderer with render tests against real ffmpeg and preview parity`.

---

### Task 9: Задача `render` і модуль `renders`

**Files:**
- Create: `apps/api/src/modules/renders/{service,render-job,router}.ts`
- Modify: `apps/api/src/app.ts` (`AppDeps += renderer: Renderer`, реєстрація задачі), `apps/api/src/routers/index.ts`, `apps/api/src/modules/recovery.ts`, `apps/api/package.json` (deps `@vf/render`, `@vf/timeline`)
- Test: `apps/api/test/renders.int.test.ts`

**Interfaces:**
- Consumes: `projects` (Task 6), `Renderer` (Task 8), `assetProcessJob` (наявний).
- Produces:
  ```ts
  interface RenderView { id: string; preset: Preset; status: JobStatus; progress: number; message: string | null; error: string | null;
                         createdAt: string; output: { assetId: string; durationMs: number | null; downloadUrl: string; status: AssetStatus } | null }
  // tRPC: renders.start({ projectId, preset, version }) → { renderId, jobId }; renders.list({ projectId }) → RenderView[];
  //       renders.cancel({ id }); renders.retry({ id }) → { jobId }
  renderJob(deps): JobDef<{ renderId: string }, { assetId: string }>   // concurrency 1
  ```
- [ ] **Step 1: Failing tests:** `start on an empty timeline → VALIDATION`; `start with a deleted asset → VALIDATION with details.clipIds`; `start with a processing asset → VALIDATION`; `start with a stale version → CONFLICT`; `render job produces a ready rendered asset with id = renderId, title "{project} — …", thumbnail and duration` (фото + відео з тоном, draft); `list shows progress then output with downloadUrl`; `retry after failure does not duplicate the asset` (обробник двічі → один рядок `assets`); `cancel during ffmpeg ends cancelled, no asset and no temp dir left` (`readdir(tmpdir())` без `vf-render-*` цього рендеру); `asset deleted while rendering → failed "Файл «…» видалено з бібліотеки"` (Review Focus 5; ffmpeg-обгортка з затримкою як у тестах process-job); `restart-interrupted render is shown failed and retry works`; `foreign project/render → NOT_FOUND`; `deleting a project keeps the rendered asset`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Обробник за §5.2 спеки; тимчасова тека `mkdtemp('vf-render-')` у `finally`; джерела — `<dir>/<assetId>.<ext>` (кожен asset один раз); таймаут `max(600_000, 5 × durationSec × 1000)`; після put — `insert assets … onConflictDoNothing` з `id = renderId`, `storageKey = assetKeys.original(userId, renderId, 'mp4')`, `source 'rendered'`, `status 'processing'` → `enqueue('asset.process')` → `renders.output_asset_id`. Статус `renders` синхронізується з задачею (як `listGenerations` — похідний від `jobs`).
- [ ] **Step 4:** PASS (`pnpm test` — уся сюїта).
- [ ] **Step 5:** Commit `feat(api): render job and renders module`.

---

### Task 10: Стор редактора і автозбереження (web, unit)

**Files:**
- Create: `apps/web/src/editor/{store,autosave}.ts`
- Modify: `apps/web/package.json` (`zustand`, `zundo`, `@vf/timeline`), `vitest.config.ts` (додати `apps/web` у `roots` з `include: ['src/**/*.test.ts']`), `docker-compose.yml` (нічого — `nm-web` уже є)
- Test: `apps/web/src/editor/store.test.ts`, `apps/web/src/editor/autosave.test.ts`

**Interfaces:**
- Consumes: операції `@vf/timeline` (Task 2), `EditorAsset` (Task 6).
- Produces:
  ```ts
  interface EditorState { doc: TimelineDoc; apply(op: (d: TimelineDoc) => TimelineDoc): void; beginGesture(): void; endGesture(): void; replaceDoc(doc: TimelineDoc): void }
  createEditorStore(doc: TimelineDoc): StoreApi<EditorState> & { temporal: …zundo }   // limit 100; replaceDoc чистить історію
  interface UiState { selected: string[]; playhead: number; pxPerSec: number; playing: boolean; snapLine: number | null }  // окремий стор без історії
  class Autosave { constructor(o: { save(doc, baseVersion): Promise<{ version: number }>; debounceMs: number; onState(s: 'saved'|'saving'|'error'|'conflict'): void; version: number });
                   change(doc: TimelineDoc): void; flush(): Promise<void>; hasPending(): boolean; setVersion(v: number): void }
  ```
- [ ] **Step 1: Failing tests:** `store.test.ts`: `a gesture of 20 moves is one undo step`; `undo/redo restores doc`; `history is limited to 100`; `replaceDoc clears history`. `autosave.test.ts` (fake timers): `saves once 1.5s after the last change`; `change during an in-flight save triggers one more save with the version returned by the first` (Review Focus 4); `CONFLICT → state conflict and no retry loop`; `network error → state error, next change retries`; `flush saves immediately`; `does not save while the doc has local: asset ids` (6.6 спеки).
- [ ] **Step 2:** `docker compose run --rm api pnpm vt web` → FAIL.
- [ ] **Step 3:** Реалізувати (zundo `temporal` з `limit: 100`, `pause()/resume()` у жестах + один `setState` фіксації на `endGesture`).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): editor store with gesture-coalesced undo and serialized autosave`.

---

### Task 11: Сторінка «Проєкти»

**Files:**
- Create: `apps/web/src/components/projects/{ProjectGrid,NewProjectDialog}.tsx`, `apps/web/src/routes/projects.$id.tsx` (поки — заглушка з назвою проєкту)
- Modify: `apps/web/src/routes/index.tsx`

- [ ] **Step 1:** Сітка карток (мініатюра або плейсхолдер формату, назва, `9:16`/`16:9`, тривалість `m:ss`, «змінено …»); клік → `/projects/$id`; меню картки: «Перейменувати» (інлайн-діалог), «Дублювати», «Видалити» (AlertDialog «Видалити проєкт «…»? Готові рендери лишаться в бібліотеці.»). Порожній стан: «Створіть перший проєкт». «Новий проєкт» → діалог (назва, за замовчуванням «Новий проєкт», формат — ToggleGroup 9:16 / 16:9) → `create` → перехід у редактор.
- [ ] **Step 2: Перевірка** в браузері (`web-e2e-api`): створити, перейменувати, дублювати, видалити; консоль без помилок. `pnpm typecheck && pnpm lint`.
- [ ] **Step 3:** Commit `feat(web): projects page`.

---

### Task 12: `PreviewEngine` — canvas, відео, Web Audio

**Files:**
- Create: `apps/web/src/editor/{preview-engine,audio-graph,media-cache}.ts`, `apps/web/src/components/editor/PreviewPane.tsx`

**Interfaces:**
- Consumes: `evaluate`, `audioPlan`, `drawFrame`, `docDuration` (Tasks 3–4), `EditorAsset` (Task 6).
- Produces:
  ```ts
  interface PreviewEngine { attach(canvas: HTMLCanvasElement): void; setDoc(doc: TimelineDoc, assets: Record<string, EditorAsset | LocalAsset>): void;
                            seek(t: number): void; play(): void; pause(): void; onTime(cb: (t: number) => void): () => void;
                            onEnded(cb: () => void): () => void; destroy(): void }
  type LocalAsset = { id: string; missing: false; local: true; kind; url: string /*blob:*/; durationMs; width; height; hasAudio: null }
  createCanvasPreviewEngine(): PreviewEngine;
  ```
- [ ] **Step 0:** Перевірити CORS бакета (`createLazyBucket`, `corsOrigins: [webOrigin]`): правило має дозволяти `GET`/`HEAD` з origin веб-додатку (`AllowedHeaders: ['*']`, `ExposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges']`). Якщо ні — додати й int-тест у `packages/storage` (`OPTIONS` preflight з `Origin` → `Access-Control-Allow-Origin`). Без цього Web Audio дає тишу.
- [ ] **Step 1:** `media-cache`: `HTMLImageElement` на asset, `<video muted playsInline preload=auto crossOrigin=anonymous>` на кліп, `<audio crossOrigin=anonymous>` на `AudioItem`; помилка декодування → прапорець «unsupported» (PreviewPane малює заглушку «браузер не може показати цей файл» поверх шару); помилка завантаження → одне оновлення URL через `projects.assets`.
- [ ] **Step 2:** `audio-graph`: `AudioContext`, на кожен `AudioItem` — `MediaElementAudioSourceNode → GainNode`; gain = `volume × easeAlpha(fadeIn, fadeOut)` (ті самі закони), оновлення на кожному кадрі. Годинник — `ctx.currentTime` від моменту `play()`; підтяжка елементів при розбіжності > 0,15 с; на паузі — seek і `seeked` → перемалювати.
- [ ] **Step 3:** `PreviewPane`: canvas = відображений розмір × `devicePixelRatio` (ResizeObserver), `drawFrame(evaluate(doc, t))`, кнопка ▶/⏸, час `m:ss.ff / m:ss.ff`.
- [ ] **Step 4: Перевірка** в браузері на проєкті з фото й відео зі звуком (тимчасово через сторінку-заглушку Task 11): play/pause/seek, звук чути (у `read_console_messages` без CORS-помилок `MediaElementAudioSource outputs zeroes`), Ken Burns рухається; знімок екрана. `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(web): canvas preview engine with Web Audio clock`.

---

### Task 13: Таймлайн

**Files:**
- Create: `apps/web/src/components/editor/{Timeline,TimelineClip,Waveform}.tsx`

**Interfaces:**
- Consumes: стори (Task 10), `snap`, `snapTargets`, операції (Task 2), `EditorAsset.peaksUrl` (Uint8 по 100/с).
- Produces: `<Timeline store ui assets onDropAssets(assetIds, at, trackId) onDropFiles(files, at) />`; `data-testid`: `timeline`, `track-<kind>`, `clip-<id>` (з `data-start`, `data-duration` у секундах), `clip-handle-l`, `clip-handle-r`, `transition-handle`, `playhead`, `zoom`.
- [ ] **Step 1:** Лінійка (клік/тягнення — перемотка), доріжки (зверху: відео-доріжки, «Звук відео», «Музика»; «+ доріжка відео»), кліпи з абсолютним позиціонуванням `left = start × pxPerSec`; фото/відео — повторена мініатюра, аудіо — `Waveform` (canvas з піків); заглушки: «файл видалено» (червона), «завантаження N %».
- [ ] **Step 2:** Жести pointer events: рух (між доріжками одного типу), трім лівий/правий, ручка переходу; на `pointerdown` — `beginGesture`, на `pointerup` — `endGesture`; снепінг з лінією-підказкою; вибір (клік, ⇧-клік), зв'язані виділяються разом.
- [ ] **Step 3:** Зум (Ctrl/⌘ + колесо навколо курсора, повзунок 10–400 px/с); клавіші: S, Del/Backspace, Space, ⌘Z / ⇧⌘Z, ←/→ (кадр), ⇧←/⇧→ (1 с) — не перехоплювати, коли фокус в input.
- [ ] **Step 4:** Drop: `application/x-vf-asset` (JSON id-шників з LibraryPanel) → `onDropAssets`; файли ОС → `onDropFiles`; `preventDefault()` + `stopPropagation()`, а `UploadProvider` на `window` ігнорує `drop`, у якого `defaultPrevented` (зміна в Task 14).
- [ ] **Step 5: Перевірка** в браузері: рух/трім/снепінг/розрізання/undo; знімок екрана. `pnpm typecheck && pnpm lint`.
- [ ] **Step 6:** Commit `feat(web): timeline with move, trim, snapping, split, zoom and transitions`.

---

### Task 14: Редактор цілком — бібліотека, інспектор, drop з ОС, конфлікт, рендер

**Files:**
- Create: `apps/web/src/components/editor/{EditorPage,Toolbar,LibraryPanel,Inspector,RenderMenu,RenderHistory,ConflictDialog}.tsx`, `apps/web/src/editor/use-editor-assets.ts`
- Modify: `apps/web/src/routes/projects.$id.tsx`, `apps/web/src/components/upload/UploadProvider.tsx`

**Interfaces:**
- Consumes: усе з Tasks 6, 9–13; `useUploads`, `useJobFeed`.
- Produces: `UploadsApi.addFiles(files: File[]): string[]` (id завантажень; `UploadItem.assetId` з'являється після `createUpload`).
- [ ] **Step 1:** Розкладка §6.2 спеки. `Toolbar`: назва (інлайн-перейменування), перемикач формату (`setFormat`), ↶ ↷, індикатор автозбереження, `RenderMenu`. `LibraryPanel`: пошук + фільтр типу (`assets.list`), елементи `draggable` з `application/x-vf-asset`; клік «+» додає під плейхед.
- [ ] **Step 2:** `Inspector` для вибраного кліпу: гучність 0–200 % (відео — `volume`, аудіо — `volume`), «Від'єднати звук», ефекти: Ken Burns (масштаб від/до, точка фокусу від/до — повзунки або клік по мініатюрі), Zoom, Fade in/out, Перехід (тривалість); «Скинути до замовчувань». Зміни повзунків — один крок історії на жест.
- [ ] **Step 3:** Drop з ОС: для кожного файлу прочитати метадані локально (`loadedmetadata` / `Image`), `addClip` з `assetId = 'local:<uploadId>'` і `LocalAsset`; коли `UploadItem.assetId` з'являється — замінити id у документі; помилка `createUpload` — прибрати кліп + toast; на `asset.process` `done` (`useJobFeed`) → `projects.assets` → якщо `hasAudio` і відео-кліп ще існує — `addLinkedAudio`. `UploadProvider` ігнорує `drop` з `defaultPrevented`.
- [ ] **Step 4:** `use-editor-assets`: `projects.get` → стор; оновлення URL за 5 хв до `urlExpiresAt`; `Autosave` з `projects.save`, `visibilitychange` → `flush`, `beforeunload`-попередження при `hasPending()`/помилці. `ConflictDialog`: «Проєкт змінено в іншій вкладці» — «Перезавантажити» (`replaceDoc` з сервера) / «Перезаписати моєю версією» (повтор з актуальною версією).
- [ ] **Step 5:** `RenderMenu`: «Фінал 1080p» / «Чернетка 720p» → `flush` → `renders.start`; недоступно з підказкою, поки є `local:`-кліпи або `missing`; `VALIDATION.details.clipIds` → підсвітити кліпи. `RenderHistory` (згортається): статус, прогрес за `jobs.feed` (`subject.renderId`), «Скасувати», «Повторити», готові — тривалість, «Завантажити», «Відкрити в бібліотеці» (`/library` з відкритою карткою).
- [ ] **Step 6: Перевірка** в браузері: зібрати ролик (фото з панелі + MP4 з ОС), ефект, гучність, рендер-чернетка до кінця, конфлікт у двох вкладках; консоль без помилок; знімок екрана. `pnpm typecheck && pnpm lint`.
- [ ] **Step 7:** Commit `feat(web): editor page — library panel, inspector, OS drop, conflicts, renders`.

---

### Task 15: Видалення файлу з бібліотеки, що використаний у проєктах

**Files:**
- Modify: `apps/web/src/components/library/AssetSheet.tsx`

- [ ] **Step 1:** Перед видаленням — `assets.usage`; порожньо → наявне підтвердження; інакше AlertDialog «Файл використано в N проєктах: «A», «B»…. Після видалення на таймлайні лишиться заглушка, а рендер буде недоступний, доки ви її не заміните. Видалити все одно?» (назви — посилання на редактор).
- [ ] **Step 2: Перевірка** в браузері; `pnpm typecheck && pnpm lint`.
- [ ] **Step 3:** Commit `feat(web): warn before deleting a file used in projects`.

---

### Task 16: E2E, README, фінальна перевірка

**Files:**
- Create: `apps/web/e2e/editor.spec.ts`, `apps/web/e2e/fixtures/tone.mp4` (2 с, 320×180, синус 440 Гц — `synthVideo` з `tone`, закомітити бінарник)
- Modify: `README.md` (розділ «Редактор і рендер»: що вміє, клавіші, де з'являються рендери; структура `+ packages/timeline`, `packages/render`)

- [ ] **Step 1: Тести** `editor.spec.ts`:
  - `new 9:16 project → drop MP4 from OS onto the timeline → video clip and waveform clip appear` (`DataTransfer` + `DragEvent` на `[data-testid=timeline]`, як у library.spec);
  - `trim the right edge by dragging → data-duration decreases; undo restores; redo reapplies`;
  - `draft render completes and a rendered asset with the trimmed duration appears in the library` (тривалість у картці бібліотеки ±0:01);
  - `photo from the library panel gets Ken Burns; changing the end scale in the inspector persists after reload`;
  - `deleting a used file shows the usage warning and leaves a "файл видалено" placeholder`.
- [ ] **Step 2:** `pnpm --filter @vf/web e2e` → усі e2e (наявні 14 + нові) проходять двічі поспіль.
- [ ] **Step 3:** `pnpm test && pnpm typecheck && pnpm lint` — зелено; записати кількість тестів.
- [ ] **Step 4:** Commit `test(web): editor e2e; docs: README for sub-project 2`.
