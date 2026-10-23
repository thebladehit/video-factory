# Підпроєкт 4 «Конвеєр тема → чернетка» — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Кнопка «Відео з теми»: тема → сценарій зі сцен → візуал (бібліотека або згенероване фото) → переклад і озвучка вибраних мов → базовий документ на таймлайні з сегментами, кліпами й музикою; сторінка сцен для перевірки сценарію й перегенерації будь-якої сцени.

**Architecture:** Стан запуску живе в БД (`pipeline_runs`, `pipeline_scenes`); чиста функція `advance(snapshot) → Action[]` вирішує, що ставити далі, а `runAdvance` виконує дії атомарно й ідемпотентно — на кінцеві події задач, після мутацій і на старті API. Кроки — дрібні задачі `pipeline.script|scene|visual|assemble` плюс наявні `voice.translate|synthesize`, `image.generate`, `video.generate` підпроєктів 1 і 3. Збірка — чиста `assembleTimeline` у `@vf/timeline`; сцена = сегмент документа, тексти — `voice_lines`, мовні версії — наявний `localize`.

**Tech Stack:** як у підпроєкті 3 (Node 24, pnpm 12, TypeScript 6.0.x, Vitest, Fastify 5, tRPC 11, Zod 4, Drizzle 0.45, Postgres 17, RustFS, ffmpeg з libass у контейнері, React 19, Vite 8, TanStack Router/Query, Tailwind 4, shadcn, Zustand+zundo, Playwright, `ai@7`). Нових залежностей немає.

**Spec:** `docs/specs/2026-10-20-subproject-4-pipeline.md` (обсяг і рішення — головне джерело); `docs/specs/2026-10-20-subproject-3-voice.md` (сегменти, `voice_lines`, `localize`, задачі озвучки); `docs/specs/2026-10-20-subproject-2-editor.md` (таймлайн, рендер).

## Global Constraints

- Гілка `feat/subproject-4-pipeline` (від `main`); нічого не пушити й не відкривати PR без слова власника. Не чіпати порт 3001 на хості; ніколи не виконувати `docker compose down` (і `--profile … down`). AI-ключі — лише з `.env`, не друкувати; `AI_FAKE=1` — fake-провайдер.
- Мова UI й повідомлень помилок — українська; ідентифікатори — англійська.
- `TimelineDoc` лишається `schemaVersion: 1`, без нових полів; документ із БД завжди проходить `normalizeDoc`.
- Сцена = сегмент: `pipeline_scenes.segment_id` = `TimelineDoc.segments[].id`; текст сцени — рядок `voice_lines` базової мови з `text_origin='script'`. Таблиць `scenes`/`scene_texts` не створювати.
- Межі налаштувань: тема 3–2000 символів; стиль ≤ 1000; `targetSec` 9:16 — 15–90 (за замовч. 45), 16:9 — 60–900 (за замовч. 300); `stopAfterScript` за замовч. 16:9 — `true`, 9:16 — `false`.
- Сценарій: 1–60 сцен; середня сцена 9:16 — 5 с, 16:9 — 15 с; бюджет слів `targetSec × 2.5`; `narration` 1–1500 символів (`TTS_MAX_CHARS`); `keywords` 1–8; одна повторна спроба при невалідному об'єкті; 16:9 > 40 сцен — план розділів, потім сцени розділів (контекст — останні 3 сцени).
- Оцінка тривалості сцени без озвучки: `quantize(LEAD + символи / 15 + TAIL)` (`LEAD = 0.15`, `TAIL = 0.35` з `@vf/timeline`); з озвучкою: `quantize(LEAD + V + TAIL)` — для базової мови `fitSegment` дає темп ×1.
- Збірка: прямі склейки; фото — `kenburns`, чергування за індексом (парні 1→1.15, непарні 1.15→1; фокус x 0.4 / 0.6); відео коротше за сцену — повтор із `in=0`, шматок < 1 кадру відкидається; відео `volume=0` без зв'язаного звуку; `contain`, якщо відношення сторін файлу відрізняється від формату > 20 %; музика — повтор до кінця, `volume=0.15`, `fadeOut=1.5` на останньому кліпі; сцена без візуалу — заглушка «Порожня сцена» (чорний PNG розміру формату, без Ken Burns).
- Бібліотека: лише `status='ready'`, `kind ∈ {image, video}`, орієнтація формату або `square`; один файл — не більше однієї сцени запуску; автопідстановка лише за `score ≥ LIBRARY_MATCH_MIN`; до 3 підказок.
- Субтитри після збірки: 9:16 → `preset:shorts`, 16:9 → `preset:classic`, увімкнені для всіх мов; `projects.voice.original.mode = 'replace'`.
- Задачі: `pipeline.script` concurrency 2, `pipeline.scene` 2, `pipeline.visual` 3, `pipeline.assemble` 2; payload — лише id (`{ projectId }` або `{ sceneId }`); обробники ідемпотентні; прогрес лише через `ctx.progress`; кожен запит фільтрується за `userId`, чужий id → `NOT_FOUND`.
- Тести: `*.test.ts` unit, `*.int.test.ts` int, `*.spec.ts` Playwright, `*.live.test.ts` — лише `pnpm test:live`. Vitest — у контейнері (`pnpm test`; фільтр: `docker compose run --rm -T api pnpm vt --project <пакет> <фільтр>`); e2e — на хості (`pnpm --filter @vf/web e2e`, API `api-e2e` :3101, Vite :5174). Для ручної перевірки в браузері — конфіг `web-e2e-api` з `.claude/launch.json`.
- Кожна задача закінчується зеленими тестами зачеплених пакетів, `pnpm typecheck && pnpm lint` і комітом із рядком `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Журнал рішень і відхилень — `subproject-4-ledger.md` у теці нотаток сесії.

## Review Focus

1. **Остання сцена (або всі) без візуалу й без озвучки** → документ усе одно має повну тривалість (сума сегментів), сегменти лежать у `[0, docDuration]`, `localize` і рендер не обрізають сцену. Тест — Task 2 і Task 9.
2. **Події задач після `done`** (переозвучка рядка в студії, нове фото з бібліотеки, `asset.process` чужого файлу) → `advance` не запускає збірку повторно й не чіпає документ, крім точкової заміни візуалу сцени. Тест — Task 5 і Task 9.
3. **Скасування під час `pipeline.script`, потім «Повторити»** → сцени й рядки не дублюються (рівно один набір), етап продовжується з місця. Тест — Task 7.
4. **Проєкт видалено посеред запуску** → задачі `pipeline.*` завершуються без винятку (no-op), не лишається рядків `running`, слухач подій не падає. Тест — Task 7 і Task 9.
5. **Музика: трек довший за відео, коротший за 1 кадр, або без `duration_ms`** → обрізається по документу / повторюється / пропускається без музики (без помилки збірки). Тест — Task 2 і Task 9.

---

## Структура файлів

```
packages/shared/src/{pipeline,jobs,index}.ts                                  (+ pipeline.test.ts)
packages/db/src/schema.ts  packages/db/drizzle/0006_pipeline.sql             (+ db.int.test.ts)
packages/timeline/src/{assemble,index}.ts                                     (+ assemble.test.ts)
packages/ai/src/prompts/script.ts packages/ai/src/{index}.ts packages/ai/src/fake/index.ts (+ script.test.ts, fake.test.ts, providers.live.test.ts)
apps/api/src/modules/assets/match.ts                                          (+ apps/api/test/assets-match.int.test.ts)
apps/api/src/modules/pipeline/{advance,snapshot,run-advance,service,estimate,scenes,blank,script-job,scene-job,visual-job,assemble-job,events,router}.ts (+ advance.test.ts, estimate.test.ts)
apps/api/src/modules/{recovery,projects/service}.ts apps/api/src/{app}.ts apps/api/src/routers/index.ts
apps/api/test/{pipeline,pipeline-flow}.int.test.ts
apps/web/src/pipeline/{use-pipeline,settings-form,stages}.ts                  (+ settings-form.test.ts, stages.test.ts)
apps/web/src/components/pipeline/{NewPipelineDialog,MusicPicker,PipelinePage,StageBar,SceneRow,SceneVisual,SceneVideoDialog}.tsx
apps/web/src/components/projects/ProjectGrid.tsx apps/web/src/routes/{index,projects.$id.pipeline}.tsx
apps/web/src/components/editor/{EditorPage,Toolbar}.tsx apps/web/e2e/pipeline.spec.ts README.md
```

---

### Task 1: Дані — налаштування, типи задач, таблиці (міграція 0006)

**Files:**
- Create: `packages/shared/src/pipeline.ts`, `packages/shared/src/pipeline.test.ts`, `packages/db/drizzle/0006_pipeline.sql` (генерується `pnpm db:generate`, назва вручну)
- Modify: `packages/shared/src/{jobs,index}.ts`, `packages/db/src/schema.ts`, `packages/db/src/db.int.test.ts`

**Interfaces:**
- Produces (`@vf/shared`): `pipelineSettingsSchema` (Zod, поля зі спеки §2.1; `.superRefine`: `targetSec` у межах формату, `baseLanguage ∈ languages`, мови з `LANGUAGES`, `voices` має ключ для кожної мови), `type PipelineSettings`, `defaultPipelineSettings(format, defaults: { text?, image?, voices }) → Partial<PipelineSettings>`, `TARGET_SEC: Record<VideoFormat, { min, max, default }>`, `PIPELINE_STAGES = ['script','review','produce','assemble','done']`, `PIPELINE_STATUSES = ['running','awaiting_review','done','failed','cancelled']`, `SCENE_STATUSES = ['empty','queued','running','ready','failed']`, `VISUAL_SOURCES = ['library','generated','manual']`; `JobType` + `'pipeline.script' | 'pipeline.scene' | 'pipeline.visual' | 'pipeline.assemble'`; `JobSubject.sceneId?` (з `payload.sceneId`).
- Produces (`@vf/db`): таблиці `pipelineRuns`, `pipelineScenes` (колонки й обмеження — спека §2; check-обмеження на `stage`, `status`, `visual_source`, `pipeline_scenes.status`; unique `pipeline_runs.project_id`, unique `(run_id, segment_id)`, індекс `(run_id, position)`), `VOICE_TEXT_ORIGINS` + `'script'` (оновлений check `voice_lines_text_origin_check`).

- [ ] **Step 1: Failing tests.** `pipeline.test.ts`: `accepts defaults for 9:16` (`targetSec 45`, `stopAfterScript false`); `16:9 defaults stopAfterScript true and targetSec 300`; `rejects targetSec 100 for 9:16 and 30 for 16:9`; `rejects baseLanguage not in languages`; `rejects language without voice`; `rejects topic of 2 chars and style of 1001`; `jobSubject picks sceneId`. `db.int.test.ts`: `pipeline_runs unique per project`, `pipeline_scenes unique (run_id, segment_id)`, `cascade: deleting project deletes run and scenes`, `voice_lines accepts text_origin script`, `visual_asset_id set null on asset delete`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project shared pipeline` і `--project db db.int` → FAIL (немає модулів/таблиць).
- [ ] **Step 3:** Реалізувати схему й таблиці; `pnpm db:generate`, перейменувати міграцію на `0006_pipeline.sql`; `pnpm db:migrate`.
- [ ] **Step 4:** Ті самі команди → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(db): pipeline runs and scenes, script text origin, pipeline job types`.

### Task 2: `assembleTimeline` і `replaceSegmentVisual` (`@vf/timeline`)

**Files:**
- Create: `packages/timeline/src/assemble.ts`, `packages/timeline/src/assemble.test.ts`
- Modify: `packages/timeline/src/index.ts`

**Interfaces:**
- Consumes: `LEAD`, `TAIL`, `fitSegment`, `localize` (`localize.ts`); `quantize`, `docDuration` (`time.ts`); `EFFECT_DEFAULTS`, `emptyTimeline`, `FORMATS` (`@vf/shared`).
- Produces:
  ```ts
  export interface SceneVisual { assetId: string; kind: 'image' | 'video'; durationSec?: number; width: number; height: number; blank?: boolean }
  export interface AssembleScene { segmentId: string; estimatedSec: number; baseVoiceSec: number | null; visual: SceneVisual }
  export interface AssembleInput { format: VideoFormat; fps: number; scenes: AssembleScene[]; music: { assetId: string; durationSec: number } | null }
  export function estimateSceneSec(text: string): number;          // LEAD + chars/15 + TAIL (не квантоване)
  export function skeletonDoc(format: VideoFormat, fps: number, scenes: { segmentId: string; estimatedSec: number }[]): TimelineDoc; // лише segments
  export function assembleTimeline(input: AssembleInput, newId?: () => string): TimelineDoc;
  export function replaceSegmentVisual(doc: TimelineDoc, segmentId: string, visual: SceneVisual, sceneIndex: number, newId?: () => string): TimelineDoc; // сегмента немає → той самий doc
  ```
  Доріжки: одна `video` (id `v1`), опційно `audio` роль `music`. `kenburns` за індексом сцени (`sceneIndex` у `replaceSegmentVisual`, щоб чергування збігалося з повною збіркою); `blank: true` → без ефектів.

- [ ] **Step 1: Failing tests** (`assemble.test.ts`, fps 30):
  - `scene with voice 3.0 s lasts quantize(0.15+3.0+0.35)=3.5 s; scene without voice uses quantize(estimatedSec)`; `segments are contiguous from 0 and on the frame grid`;
  - `localize of assembled doc for base takes gives speed 1 and hold 0 in every voiced segment` (takes = `baseVoiceSec`, перевірка `fits`);
  - `photo gets kenburns 1→1.15 on even index and 1.15→1 on odd, focus x 0.4/0.6`; `blank visual gets no effects`;
  - `video 10 s in 3.5 s scene → one clip in=0 duration 3.5`; `video 1.5 s in 3.5 s scene → clips 1.5+1.5+0.5`; `remainder shorter than a frame is dropped`; `video clips have volume 0 and no linked audio`;
  - `square image in 9:16 → contain; 1080×1920 → cover; 1920×1080 in 9:16 → contain`;
  - `last scene blank keeps docDuration equal to sum of segments` (Review Focus 1);
  - `music 100 s on 20 s doc → one clip 20 s, volume 0.15, fadeOut 1.5`; `music 8 s on 20 s doc → clips 8+8+4, fadeOut only on last`; `music shorter than a frame → no music track` (Review Focus 5);
  - `skeletonDoc has segments only and no clips`;
  - `replaceSegmentVisual swaps photo for video inside segment only, other segments' clips unchanged`; `replaceSegmentVisual on missing segment returns the same doc`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project timeline assemble` → FAIL.
- [ ] **Step 3:** Реалізувати в `assemble.ts`; ідентифікатори через `newId` (детерміновані в тестах).
- [ ] **Step 4:** Та сама команда → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(timeline): assembleTimeline, skeleton doc, replaceSegmentVisual`.

### Task 3: Промпт і схема сценарію, fake-сценарій (`@vf/ai`)

**Files:**
- Create: `packages/ai/src/prompts/script.ts`, `packages/ai/src/prompts/script.test.ts`
- Modify: `packages/ai/src/index.ts`, `packages/ai/src/fake/index.ts`, `packages/ai/src/fake/fake.test.ts`, `packages/ai/src/providers/providers.live.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SCRIPT_PROMPT_VERSION = 1;
  export const scriptSchema: z.ZodType<{ title: string; scenes: { narration: string; visualPrompt: string; keywords: string[] }[] }>;
  export const outlineSchema: z.ZodType<{ title: string; sections: { title: string; summary: string; sec: number }[] }>;
  export const sceneSchema: z.ZodType<{ narration: string; visualPrompt: string; keywords: string[] }>;
  export function scenePlan(format: VideoFormat, targetSec: number): { scenes: number; words: number; twoStage: boolean };
  export function buildScriptPrompt(i: { topic; format; targetSec; language: string; channelStyle: string; style: string; section?: { title; summary; sec; previous: string[] }; errors?: string[] }): { system: string; prompt: string };
  export function buildOutlinePrompt(i: { topic; targetSec; language; channelStyle; style }): { system; prompt };
  export function buildScenePrompt(i: { topic; format; language; channelStyle; style; previous?: string; next?: string; current: string }): { system; prompt };
  export function validateScript(s: ScriptResult, plan: { scenes: number }): string[];   // порожній масив — валідно
  ```
  У `prompt` — рядки-маркери, які розбирає fake: `Кількість сцен: N`, `Мова: <код>`, `Тема: …`. Мова narration задається явно (назва з `languageInfo`), `visualPrompt` — англійською.
- Fake: `generateObject(scriptSchema)` → `N` сцен (`narration` = `Сцена i. <перші слова теми>` з 4–8 слів, `visualPrompt` = `scene i <тема>`, `keywords` = слова теми); `outlineSchema` → розділи на `targetSec`; `sceneSchema` → одна сцена з префіксом `Нова версія.`; fake `image.generate` кидає `PROVIDER_ERROR` «Fake: відмова», якщо prompt містить `FAIL` (для тестів помилки сцени).

- [ ] **Step 1: Failing tests:** `scenePlan('9:16', 45) → 9 scenes, 113 words, twoStage false`; `scenePlan('16:9', 900) → 60 scenes, twoStage true`; `scenePlan clamps to 1..60`; `9:16 prompt asks for a hook in the first scene and no greeting`; `16:9 prompt asks for intro, sections, conclusion`; `channel style and run style go into system`; `prompt names the narration language and asks for English visual prompts`; `validateScript flags narration > 1500, empty visualPrompt, 0 or 9 keywords, scene count outside 1..60`; `retry prompt lists errors`; fake: `script returns N scenes from marker`, `image with FAIL in prompt rejects`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project ai script fake` → FAIL.
- [ ] **Step 3:** Реалізувати; експортувати з `index.ts`. Live: `script via each available text model returns valid object within ±30 % of word budget` (пропуск без ключа — `it.skipIf`).
- [ ] **Step 4:** Та сама команда → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(ai): script prompts and schemas, fake script and failing image marker`.

### Task 4: Пошук збігів у бібліотеці (`matchAssets`)

**Files:**
- Create: `apps/api/src/modules/assets/match.ts`, `apps/api/test/assets-match.int.test.ts`

**Interfaces:**
- Consumes: ранжування з `assets/search.ts` (той самий вираз `ts_rank(search, websearch_to_tsquery('simple', q)) + greatest(word_similarity…)`; винести в спільну функцію `rankExpr(q)` у `search.ts`, не дублювати).
- Produces:
  ```ts
  export const LIBRARY_MATCH_MIN: number;          // підбирається тестом на фікстурі; записати значення в ledger
  export interface AssetMatch { assetId: string; score: number; kind: 'image' | 'video'; width: number; height: number; durationMs: number | null }
  export function matchAssets(deps: AppDeps, userId: string, i: { keywords: string[]; format: VideoFormat; exclude: string[]; limit?: number }): Promise<AssetMatch[]>; // score desc, limit 4
  ```
  Запит — окремо кожне ключове слово й усі разом; score файлу = максимум; фільтри — Global Constraints «Бібліотека».

- [ ] **Step 1: Failing tests** (фікстура: «Захід сонця над морем» з тегами `море, захід`, «Кіт на дивані», горизонтальне «Гори взимку», аудіо «Море шумить», ще `processing`-фото «море»): `strong match for keywords ['море','захід сонця'] scores ≥ LIBRARY_MATCH_MIN`; `unrelated keywords ['космос'] score below LIBRARY_MATCH_MIN`; `horizontal asset excluded for 9:16, square allowed`; `audio and processing assets never returned`; `exclude list skips an asset`; `other user's assets never returned`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api assets-match` → FAIL.
- [ ] **Step 3:** Реалізувати; поріг — найменше значення, при якому перші два тести розрізняються з запасом; записати в ledger.
- [ ] **Step 4:** Та сама команда + `assets-search` (регрес) → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(api): library match for pipeline scenes`.

### Task 5: Координатор — `advance` (чиста функція)

**Files:**
- Create: `apps/api/src/modules/pipeline/advance.ts`, `apps/api/src/modules/pipeline/advance.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SceneSnap { id: string; status: SceneStatus; hasVisual: boolean; generation: { status: JobStatus; assetId: string | null; assetStatus: AssetStatus | null } | null }
  export interface LangSnap { language: string; isBase: boolean; translate: 'none' | 'live' | 'done' | 'failed'; lines: { status: VoiceLineStatus; hasText: boolean }[] }
  export interface RunSnap { stage: PipelineStage; status: PipelineStatus; stopAfterScript: boolean;
    scriptJob: JobStatus | null; assembleJob: JobStatus | null; scenesWritten: boolean; scenes: SceneSnap[]; langs: LangSnap[] }
  export type Action =
    | { type: 'enqueueScript' } | { type: 'toReview' } | { type: 'toProduce' }
    | { type: 'enqueueVisual'; sceneId: string } | { type: 'linkGenerated'; sceneId: string; assetId: string }
    | { type: 'sceneReady'; sceneId: string } | { type: 'sceneFailed'; sceneId: string; error: string }
    | { type: 'enqueueTranslate'; language: string } | { type: 'enqueueSynthesize'; language: string }
    | { type: 'enqueueAssemble' } | { type: 'markDone' } | { type: 'markFailed'; error: string };
  export function advance(s: RunSnap): Action[];
  ```
  Правила — спека §3.1–3.2: `status ∉ {running}` → `[]`; `script`: немає задачі → `enqueueScript`; задача `done` і `scenesWritten` → `toReview` або `toProduce`; задача `failed` → `markFailed`; `produce`: сцени `empty` → `enqueueVisual`; генерація `done` з asset без прив'язки → `linkGenerated`; asset `ready` → `sceneReady`; генерація/asset `failed` → `sceneFailed`; базова мова з рядками `empty` і текстом → `enqueueSynthesize(base)`; інша мова `translate: 'none'` → `enqueueTranslate`; `translate: 'done'` і є `empty` рядки з текстом → `enqueueSynthesize(lang)`; усе кінцеве (сцени `ready|failed`, рядки не `queued|running`, переклади не `none|live`) → `enqueueAssemble` (якщо `assembleJob` null); `assemble`: задача `done` → `markDone`, `failed` → `markFailed`; `done` → `[]` завжди. Помилка перекладу (`failed`) не блокує збірку.

- [ ] **Step 1: Failing tests** — таблиця «знімок → дії», по тесту на кожне правило вище, плюс: `fresh run → enqueueScript only`; `script done with stopAfterScript → toReview`; `awaiting_review → []`; `produce with two languages → visuals, synth base, translate en`; `translate done → synth en`; `failed visual does not block assemble`; `failed translate does not block assemble`; `queued line blocks assemble`; `assemble job exists → no second enqueueAssemble`; `done run ignores any snapshot` (Review Focus 2); `cancelled run → []`; `same snapshot twice → same actions (pure)`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api advance` → FAIL.
- [ ] **Step 3:** Реалізувати.
- [ ] **Step 4:** Та сама команда → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(api): pipeline advance state machine`.

### Task 6: Сервіс і API запуску, сцени на перевірці, оцінка

**Files:**
- Create: `apps/api/src/modules/pipeline/{snapshot,run-advance,service,estimate,scenes,router}.ts`, `apps/api/src/modules/pipeline/estimate.test.ts`, `apps/api/test/pipeline.int.test.ts`
- Modify: `apps/api/src/routers/index.ts`, `apps/api/src/modules/projects/service.ts` (`ProjectCard.pipeline`), `apps/api/src/modules/voice/service.ts` (`setText` приймає `origin?: 'manual' | 'script'`)

**Interfaces:**
- Consumes: `pipelineSettingsSchema` (T1), `advance` (T5), `skeletonDoc`, `estimateSceneSec` (T2), `enqueueSynthesize`, `enqueueTranslate`, `setText`, `assertVoiceChoice`, `getVoice` (voice/service), `estimateCost`.
- Produces:
  - `loadSnapshot(deps, runId) → RunSnap`; `runAdvance(deps, runId): Promise<void>` — виконує `Action[]`: умовні `update … where` для етапу (`stage = очікуваний`) і сцени (`status in ('empty','failed')` → `queued`, потім задача й `job_id`, як `enqueueSynthesize`); для мов — наявні `enqueueSynthesize({ projectId, language })` / `enqueueTranslate`; `enqueueAssemble` — умовно `assemble_job_id is null`. Виконавці дій для `pipeline.script|visual|assemble` реєструються задачами в T7–T9; тут — постановка задач за типом.
  - `estimatePipeline(settings, catalog) → { usd: number | null; parts: { script; images; tts; stt; translate } }` (чиста, в `estimate.ts`).
  - Процедури `pipeline.estimate`, `pipeline.start`, `pipeline.get`, `pipeline.updateScene`, `pipeline.addScene`, `pipeline.deleteScene`, `pipeline.moveScene`, `pipeline.continue` — поведінка за спекою §5. `PipelineView` (вихід `get`): `{ run: { stage, status, error, settings, assembledVersion }, scenes: SceneView[], languages: { language, ready, total, failed }[], progress: { done, total } }`; `SceneView = { id, segmentId, position, narration, visualPrompt, keywords, status, error, visual: { assetId, thumbUrl, kind, source } | null, suggestions: { assetId, thumbUrl }[], inTimeline: boolean }`.
  - `ProjectCard.pipeline: { stage, status, done, total } | null`.

- [ ] **Step 1: Failing tests.** `estimate.test.ts`: `9:16 45 s, uk+en, fake models → all parts 0`; `openai tts priced by minutes × languages`; `missing price → usd null`. `pipeline.int.test.ts` (FakeProvider; обробники `pipeline.*` з'являються в T7–T9, тож тут перевіряються рядки `jobs` і стан; якщо `InProcessQueue` вимагає зареєстрованого типу — тест реєструє no-op заглушки `pipeline.*`): `start creates project with format, topic, languages, empty doc and a running run in stage script with a queued pipeline.script job`; `start rejects unavailable image model (MODEL_UNAVAILABLE) before creating a project`; `start rejects language without voice (VALIDATION)`; `start rejects someone else's music asset (NOT_FOUND)`; на підготовленому запуску в `review` (сцени й скелет вставлені фікстурою): `updateScene writes narration to base line with text_origin script`; `addScene/deleteScene/moveScene keep skeleton segments in scene order with estimated durations`; `add/delete/move rejected outside review (VALIDATION)`; `continue moves to produce and enqueues visuals and base synth`; `parallel runAdvance calls enqueue each visual once`; `projects.list shows pipeline progress`; `other user gets NOT_FOUND`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api estimate pipeline.int` → FAIL.
- [ ] **Step 3:** Реалізувати; підключити роутер у `routers/index.ts`.
- [ ] **Step 4:** Та сама команда + `voice.int projects.int` (регрес) → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(api): pipeline start, view, review edits, estimate, advance runner`.

### Task 7: Задачі сценарію, слухач подій, відновлення

**Files:**
- Create: `apps/api/src/modules/pipeline/{script-job,scene-job,events}.ts`
- Modify: `apps/api/src/app.ts` (реєстрація задач, `queue.onEvent(pipelineEvents(deps))`), `apps/api/src/modules/recovery.ts`, `apps/api/src/modules/pipeline/{service,router}.ts`, `apps/api/test/pipeline.int.test.ts`

**Interfaces:**
- Consumes: `buildScriptPrompt`, `buildOutlinePrompt`, `buildScenePrompt`, `scenePlan`, `validateScript`, `scriptSchema`, `outlineSchema`, `sceneSchema` (T3); `skeletonDoc`, `estimateSceneSec` (T2); `runAdvance` (T6); `startGeneration/finishGeneration` (`voice/job-utils.ts`).
- Produces:
  - `scriptJob(deps): JobDef<{ projectId }, { scenes: number }>` — спека §4.1; запис сцен, рядків базової мови й скелета — однією транзакцією, лише якщо сцен ще немає (інакше no-op); назва проєкту = `title`. Проєкту/запуску немає → повертає `{ scenes: 0 }` без винятку.
  - `sceneJob(deps): JobDef<{ sceneId }, { ok: boolean }>`; процедури `pipeline.regenerateScene({ sceneId, part: 'text' })`, `pipeline.cancel`, `pipeline.retry`.
  - `pipelineEvents(deps): (e: JobEvent) => void` — на кінцеві події (`done|failed|cancelled`) типів зі спеки §3.2 знаходить `run_id` (за `projectId` → `pipeline_runs`; `sceneId` → сцена; `lineId` → `voice_lines.project_id`; `generationId` → `pipeline_scenes.generation_id`; `assetId` → `pipeline_scenes.visual_asset_id` або `generations.asset_ids`) і викликає `runAdvance`; помилки ловить і логує (`deps.log.error`), не кидає.
  - `recovery.ts`: для запусків зі `status='running'` — `runAdvance` (невдала рестартом задача сценарію/збірки → `markFailed` «Перервано перезапуском сервера»).
  - `cancel`: `queue.cancel` для живих задач запуску (сценарій, сцени, рядки проєкту, збірка) → `status='cancelled'`; сцени `queued|running` → `empty`. `retry`: `failed|cancelled` → `running`, `error=null`, невдалі задачі етапу (`script_job_id`/`assemble_job_id`) обнуляються, сцени `failed` → `empty`, рядки `failed` → `empty`; потім `runAdvance`.

- [ ] **Step 1: Failing tests** (повний runtime, FakeProvider): `16:9 900 s script runs outline then per-section scenes (fake outline), scene count from scenePlan`; `start without stop → script job writes N scenes, base lines (text_origin script), skeleton segments matching scene ids, project title from script, stage produce`; `stopAfterScript → awaiting_review`; `invalid model output retried once then run failed with message` (fake перевизначено в тесті: перша відповідь з `narration` 1600 символів, друга валідна → успіх; обидві невалідні → `failed`); `regenerateScene text rewrites narration, base line becomes voiced-stale`; `cancel during script then retry → exactly one set of scenes` (Review Focus 3); `deleting the project while the script job runs → job ends without throwing, no run rows left` (Review Focus 4); `restart with interrupted script job → run failed with restart message, retry completes`; `event listener survives an event for a deleted project`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api pipeline.int` → FAIL.
- [ ] **Step 3:** Реалізувати; зареєструвати задачі (`concurrency` з Global Constraints) і слухач у `app.ts` (відписка при `close`).
- [ ] **Step 4:** Та сама команда + `recovery.int voice.int` → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(api): pipeline script and scene jobs, event-driven advance, cancel/retry, recovery`.

### Task 8: Візуал сцен — бібліотека, генерація, ручний вибір

**Files:**
- Create: `apps/api/src/modules/pipeline/visual-job.ts`
- Modify: `apps/api/src/modules/pipeline/{run-advance,service,router}.ts`, `apps/api/src/app.ts`, `apps/api/test/pipeline.int.test.ts`

**Interfaces:**
- Consumes: `matchAssets`, `LIBRARY_MATCH_MIN` (T4); `generateImage`, `generateVideo` (generate/service); `runAdvance` (T6).
- Produces:
  - `visualJob(deps): JobDef<{ sceneId }, { source: 'library' | 'generated' | null }>` — спека §4.2; `exclude` = візуали інших сцен запуску; сильний збіг → `visual_asset_id`, `visual_source='library'`, `ready`; інакше `generateImage({ model: settings.imageModel, prompt: visual_prompt, aspect: format, n: 1 })` → `generation_id`, `running`; `suggestions` — до 3 наступних збігів у будь-якому разі. «Згенерувати знову» ставить задачу з `{ sceneId, regenerate: true }` — пошук у бібліотеці пропускається.
  - Дія `linkGenerated` у `runAdvance`: `visual_asset_id = assetId`, `visual_source='generated'`, теги asset += тема (перші 3 слова), «конвеєр», ключові слова (`normalizeTags`).
  - Процедури `pipeline.regenerateScene({ sceneId, part: 'visual' })`, `pipeline.generateSceneVideo({ sceneId, model, durationSec? })`, `pipeline.setSceneVisual({ sceneId, assetId })` (до `done`; гілка після `done` — у T9).

- [ ] **Step 1: Failing tests:** `library asset with strong match is used, source library, no generation row`; `weak matches land in suggestions and an image is generated`; `same library file is not used for two scenes`; `generated image is linked when asset.process finishes, scene ready, asset tagged конвеєр`; `scene whose prompt contains FAIL is failed with provider message, other scenes ready`; `regenerate visual skips library and creates a new generation`; `generateSceneVideo links fake video when ready`; `setSceneVisual rejects audio asset and someone else's asset`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api pipeline.int` → FAIL.
- [ ] **Step 3:** Реалізувати; зареєструвати задачу.
- [ ] **Step 4:** Та сама команда + `generate.int` → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(api): pipeline scene visuals from library or generation`.

### Task 9: Збірка, заглушка, точкова заміна, повний потік

**Files:**
- Create: `apps/api/src/modules/pipeline/{assemble-job,blank}.ts`, `apps/api/test/pipeline-flow.int.test.ts`
- Modify: `apps/api/src/modules/pipeline/{run-advance,service,router}.ts`, `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `assembleTimeline`, `replaceSegmentVisual` (T2); `solidPng` (`@vf/ai` — експортувати з `index.ts`, якщо ще ні); `projectVoiceSchema`, `PRESETS` (`@vf/captions`), `timelineAssetIds`; `buildLocalized`, `startRender` (для тесту).
- Produces:
  - `ensureBlankAsset(deps, userId, format) → SceneVisual` — шукає власний asset з тегом `заглушка` і розміром формату; немає → `solidPng(w, h, [0,0,0])` у сховище (`assetKeys.original`), рядок `assets` одразу `ready` (`kind='image'`, `source='generated'`, назва «Порожня сцена», теги `заглушка`, `конвеєр`). Паралельні виклики не створюють двох (unique-перевірка в транзакції з `pg_advisory_xact_lock` на `userId+format`).
  - `assembleJob(deps): JobDef<{ projectId }, { version: number }>` — спека §4.3: тривалість базового голосу з `voice_lines.duration_ms` (лише `ready` і не застарілі), візуали сцен (`ready` asset; інакше заглушка), музика (`duration_ms` null → без музики), запис документа (`for update`, версія +1, `asset_ids`), `assembled_version`, `projects.voice` (голоси, субтитри з пресетом за форматом, `original.mode='replace'`), дія `markDone` — через `runAdvance`.
  - Після `done`: `linkGenerated` і `setSceneVisual` викликають `applySceneVisual(deps, sceneId)` — `replaceSegmentVisual` на актуальній версії (`for update`), версія +1; сегмента немає → `inTimeline=false` у `get`, документ не змінюється.
  - `pipeline.reassemble({ projectId, version })` — `CONFLICT`, якщо `version` ≠ `timeline_version`; інакше нова задача збірки (стадія лишається `done`).

- [ ] **Step 1: Failing tests** (`pipeline-flow.int.test.ts`, FakeProvider, uk+en, 9:16, музика з бібліотеки):
  - `full run reaches done: doc has segments for every scene, one video clip per scene, music track, voice for uk and en ready, projects.voice has preset:shorts captions` — і `voice.localized('uk')` дає `speed 1` у кожному сегменті, `voice.localized('en')` має доріжки озвучки й субтитрів;
  - `renders.start({ language: 'en' }) on the draft produces an MP4 whose duration equals docDuration of localized en ±1 frame`;
  - `failed scene visual → blank asset clip, run still done; last scene blank keeps full duration` (Review Focus 1);
  - `all base voices failed → doc built from estimates, run done`;
  - `music asset without duration → no music track, run done` (Review Focus 5);
  - `restart during produce (stop runtime, start again) → run reaches done`;
  - `after done: re-synthesizing a base line or processing an unrelated asset does not change timeline_version` (Review Focus 2);
  - `after done: regenerate visual replaces only that segment's clip, version +1`; `after segment deleted in editor: regenerate leaves doc unchanged and inTimeline false`;
  - `reassemble with stale version → CONFLICT; with current version → new doc version`;
  - `project deleted during produce → no exceptions, no running lines or scenes left` (Review Focus 4);
  - `blank asset created once for concurrent assembles of two runs`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api pipeline-flow` → FAIL.
- [ ] **Step 3:** Реалізувати; зареєструвати задачу.
- [ ] **Step 4:** `docker compose run --rm -T api pnpm vt --project api pipeline` + `voice-render.int renders.int` → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(api): pipeline assemble, blank placeholder, post-draft visual swap, reassemble`.

### Task 10: Веб — діалог «Відео з теми» й картки проєктів

**Files:**
- Create: `apps/web/src/pipeline/{use-pipeline,settings-form}.ts`, `apps/web/src/pipeline/settings-form.test.ts`, `apps/web/src/components/pipeline/{NewPipelineDialog,MusicPicker}.tsx`
- Modify: `apps/web/src/routes/index.tsx`, `apps/web/src/components/projects/ProjectGrid.tsx`

**Interfaces:**
- Consumes: `pipeline.estimate`, `pipeline.start`, `projects.list` (`pipeline`), `settings.get` (defaults, voices), `ai.catalog`, `assets.list` (`kind: 'audio'`); `VoicePicker` (`components/voice/VoicePicker.tsx`); `TARGET_SEC`, `defaultPipelineSettings`, `pipelineSettingsSchema` (T1).
- Produces:
  - `settings-form.ts`: `initialForm(format, defaults) → PipelineSettings`; `onFormatChange(form, format) → PipelineSettings` (переносить `targetSec` у межі нового формату, перемикає `stopAfterScript` на замовчування формату, якщо користувач його не чіпав); `blockers(form, catalog) → string[]` (тексти причин неактивної кнопки: «Немає ключа для моделі …», «Не вибрано голос для мови «…»», «Тема — від 3 символів»).
  - `NewPipelineDialog` — поля спеки §6.1; оцінка з debounce 300 мс; «Створити» → `navigate('/projects/$id/pipeline')`.
  - Картка проєкту з `pipeline` (не `done`) показує етап і `done/total`; клік → `/projects/$id/pipeline`.

- [ ] **Step 1: Failing tests** (`settings-form.test.ts`): `switching 9:16→16:9 moves targetSec 45 to 60 and enables stopAfterScript`; `user-set stopAfterScript survives format change`; `blockers lists missing voice per language and unavailable model`; `adding a language takes its default voice from user settings`.
- [ ] **Step 2:** `pnpm --filter @vf/web test settings-form` → FAIL.
- [ ] **Step 3:** Реалізувати форму, діалог, `MusicPicker` (пошук аудіо, ▶ прослуховування `<audio>`, «Без музики»), кнопку «Відео з теми» поруч із «Новий проєкт», стан на картці.
- [ ] **Step 4:** Та сама команда → PASS; `pnpm typecheck && pnpm lint`; ручна перевірка в браузері (`web-e2e-api`): діалог відкривається, оцінка оновлюється, кнопка неактивна з причиною без голосу.
- [ ] **Step 5:** Commit `feat(web): topic-to-video launch dialog and pipeline progress on project cards`.

### Task 11: Веб — сторінка сцен

**Files:**
- Create: `apps/web/src/routes/projects.$id.pipeline.tsx`, `apps/web/src/pipeline/stages.ts`, `apps/web/src/pipeline/stages.test.ts`, `apps/web/src/components/pipeline/{PipelinePage,StageBar,SceneRow,SceneVisual,SceneVideoDialog}.tsx`
- Modify: `apps/web/src/pipeline/use-pipeline.ts`

**Interfaces:**
- Consumes: усі процедури `pipeline.*` (T6–T9); `useJobFeed` + `coalesce` (`apps/web/src/voice/coalesce.ts`); `useTextDraft`-підхід із `voice/text-draft.ts` для debounce-збереження тексту; кольори станів — `components/voice/states.ts`.
- Produces:
  - `stages.ts`: `stageSteps(run) → { key, label, state: 'done' | 'active' | 'todo' | 'failed' }[]` (підписи: «Сценарій», «Перевірка», «Візуал і озвучка», «Збірка», «Готово»; «Перевірка» — `todo`/пропущено без `stopAfterScript`); `isPipelineEvent(e, view) → boolean` (подія стосується проєкту, його сцен або рядків).
  - `usePipeline(projectId)` — `pipeline.get` + refetch на події з об'єднанням 200 мс; автоперехід у редактор при першому переході `assemble → done`, якщо сторінка відкрита.
  - `PipelinePage` — макет спеки §6.2; на `review` — «+ сцена», видалення, перетягування (`moveScene`), «Продовжити»; `SceneVisual` — мініатюра, джерело, ↻ / 🎬 / 📚 (вибір з бібліотеки — наявний `LibraryPanel` у діалозі або простий пошук), підказки; «Пересібрати» — `AlertDialog` з текстом «Ручні зміни таймлайну буде втрачено», `CONFLICT` → toast «Таймлайн змінено — оновіть сторінку».

- [ ] **Step 1: Failing tests** (`stages.test.ts`): `produce without review marks Перевірка skipped and Візуал і озвучка active`; `failed run marks the stage of failure`; `isPipelineEvent matches sceneId, lineId and projectId of this project only`.
- [ ] **Step 2:** `pnpm --filter @vf/web test stages` → FAIL.
- [ ] **Step 3:** Реалізувати маршрут і компоненти.
- [ ] **Step 4:** Та сама команда → PASS; `pnpm typecheck && pnpm lint`; ручна перевірка (`web-e2e-api`, `AI_FAKE=1`): запуск зі зупинкою → правка тексту → «Продовжити» → прогрес → «Готово»; скриншот.
- [ ] **Step 5:** Commit `feat(web): pipeline scenes page with live progress and per-scene regeneration`.

### Task 12: Веб — редактор під час конвеєра

**Files:**
- Modify: `apps/web/src/components/editor/{EditorPage,Toolbar}.tsx`, `apps/web/src/editor/store.ts` (якщо потрібен прапорець read-only), `apps/api/src/modules/projects/service.ts` (`ProjectView.pipeline: { stage, status } | null`)

**Interfaces:**
- Consumes: `projects.get` + `pipeline`; механізм read-only режиму мови з підпроєкту 3 (`apply`/`beginGesture` — no-op); `LanguageBanner` як зразок банера.
- Produces: кнопка «Сцени» → `/projects/$id/pipeline` для проєктів із запуском; поки `status ∈ {running, awaiting_review}` — банер «Конвеєр ще працює — чернетка з'явиться після збірки» з посиланням на сторінку сцен і документ лише для перегляду; на події `pipeline.assemble done` цього проєкту — перезавантаження документа (без модалки конфлікту, бо локальних змін немає).

- [ ] **Step 1: Failing test** у `apps/api/test/projects.int.test.ts`: `projects.get returns pipeline stage and status for a pipeline project and null otherwise`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api projects.int` → FAIL.
- [ ] **Step 3:** Реалізувати API-поле й UI.
- [ ] **Step 4:** Та сама команда → PASS; `pnpm typecheck && pnpm lint`; ручна перевірка: відкрити редактор під час `produce` — банер, кліки по таймлайну нічого не змінюють; після збірки документ з'являється.
- [ ] **Step 5:** Commit `feat(web): editor read-only banner while the pipeline runs, scenes button`.

### Task 13: E2E, README, фінальна перевірка

**Files:**
- Create: `apps/web/e2e/pipeline.spec.ts`
- Modify: `README.md` (розділ «Відео з теми»: кроки, ключі, оцінка вартості, поведінка при помилках)

**Interfaces:**
- Consumes: усе вище; фікстури e2e (`apps/web/e2e/fixtures`), API `api-e2e` з `AI_FAKE=1`.

- [ ] **Step 1: Write e2e:**
  - `topic to draft, 9:16, uk+en`: «Відео з теми» → тема → додати EN → вибрати «Fake · озвучка» для мов → «Створити» → сторінка сцен показує етапи й прогрес → автоперехід у редактор → таймлайн має ≥ 1 відео-кліп на кожен сегмент → перемикач мови EN показує доріжку озвучки → «Рендер ▾» EN «Чернетка 720p» → у бібліотеці з'являється MP4 з `(en)` у назві.
  - `16:9 with review`: увімкнене «Зупинитися після сценарію» → етап «Перевірка» → змінити текст сцени 1 → «Продовжити» → «Готово» → «Відкрити в редакторі».
- [ ] **Step 2:** `pnpm --filter @vf/web e2e pipeline` → спершу FAIL на відсутньому кроці (якщо все вже працює — переконатися, що тест справді перевіряє кліпи й MP4, змінивши очікування й побачивши падіння), потім виправити й PASS.
- [ ] **Step 3:** Повний прогін: `pnpm test`, `pnpm --filter @vf/web e2e` двічі поспіль, `pnpm typecheck && pnpm lint` — усе зелене; записати підсумок (кількість тестів) у ledger.
- [ ] **Step 4:** Оновити README.
- [ ] **Step 5:** Commit `test(e2e): topic to draft pipeline; docs: README pipeline section`.
