# Підпроєкт 3 «Озвучка й субтитри» — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Студія озвучки (`/voice`, `/voice/$id`): готове відео або проєкт → сегменти → тексти мов (розпізнавання, ручний текст, переклад) → TTS → мітки слів → субтитри ASS (JASSUB у прев'ю, libass у рендері) → N мовних MP4, де відео підлаштоване під озвучку кожної мови.

**Architecture:** Межі сегментів — у `TimelineDoc.segments`; тексти/озвучки мов — у `voice_lines`. Чиста функція `localize(doc, opts)` у `@vf/timeline` перетворює базовий документ на документ мови (темп відео ×0,8–1,25, стоп-кадр, обрізаний хвіст, доріжки озвучки/субтитрів, ducking) і використовується і прев'ю, і рендером. Новий чистий пакет `@vf/captions` — стилі, пресети, шрифти, вирівнювання міток, `toAss`/`toSrt`/`toVtt`. `apps/api` отримує модулі `voice` і `caption-styles` і задачі `voice.transcribe|translate|synthesize`; `apps/web` — студію, JASSUB-шар у `PreviewEngine` і режим мови в редакторі.

**Tech Stack:** як у підпроєкті 2 (Node 24, pnpm 12, TypeScript 6.0.x, Vitest, Fastify 5, tRPC 11, Zod 4, Drizzle 0.45, Postgres 17, RustFS, ffmpeg 5.1 з libass у контейнері, React 19, Vite 8, TanStack Router/Query, Tailwind 4, shadcn, Zustand+zundo, Playwright, `ai@7` + `@ai-sdk/openai|google`) **+** `jassub@2.5.x` (версія, опублікована ≥ 2 тижні тому на момент встановлення; точна — фіксується в `package.json`), шрифти OFL (Google Fonts).

**Spec:** `docs/specs/2026-10-20-subproject-3-voice.md` (обсяг і рішення — головне джерело); `docs/specs/2026-10-20-subproject-2-editor.md` (таймлайн, рендер, прев'ю).

## Global Constraints

- Гілка `feat/subproject-3-voice` (від `main`); нічого не пушити й не відкривати PR без слова власника.
- Мова UI й повідомлень помилок — українська; ідентифікатори — англійська.
- `TimelineDoc` лишається `schemaVersion: 1`; нові поля лише необов'язкові; документ із БД завжди проходить `normalizeDoc`.
- **Голос озвучки ніколи не змінює швидкість** (жодного `atempo`/`playbackRate ≠ 1` на ролі `voiceover`).
- Підгонка: `LEAD = 0.15` с, `TAIL = 0.35` с, темп відео `SPEED_MIN = 0.8` … `SPEED_MAX = 1.25`; оригінал: `mode` `'duck'` за замовчуванням, `level = 0.25`, `duckLevel = 0.08`, рампа `DUCK_RAMP = 0.2` с. Усі часи округлюються до кадру `1/fps`.
- Мітки: `whisper-1` (якщо TTS сам не дав слова); без ключа OpenAI — `estimateWords` з `silencedetect` (−35 dB, 0,2 с), `timing: 'estimated'`.
- Розпізнавання оригіналу: мікс ролі `original`, моно 16 кГц Opus 32 кбіт/с WebM; > 90 хв → частини по 60 хв з перекриттям 5 с; фрази 2–15 с, розрив на кінці речення або паузі > 0,7 с.
- Текст рядка ≤ 1500 символів; оцінка тривалості для вартості — 15 символів/с.
- Субтитри: 6 шрифтів (Montserrat, Inter, Oswald, Rubik, Roboto Slab, Unbounded; Bold, TTF, OFL); 4 пресети `preset:shorts|preset:pop|preset:karaoke|preset:classic`; `PlayResX/Y` = розмір документа; фільтр `subtitles` — останнім у відео-ланцюжку, після масштабування до розміру виходу; розрив сторінки на паузі > 0,5 с.
- Задачі: `voice.transcribe` і `voice.translate` concurrency 2, `voice.synthesize` concurrency 3; payload — лише id; обробники ідемпотентні; прогрес лише через `ctx.progress`; кожен запит фільтрується за `userId`, чужий id → `NOT_FOUND`.
- Новий пакет `@vf/captions` (`"exports": { ".": "./src/index.ts", "./fonts/*": "./fonts/*" }`) = рядок тому `nm-captions` у `docker-compose.yml` (у `*api-volumes` і в `volumes` унизу).
- Тести: `*.test.ts` unit, `*.int.test.ts` int (включно з render-тестами на ffmpeg), `*.spec.ts` Playwright, `*.live.test.ts` — лише `pnpm test:live`. Vitest — у контейнері (`pnpm test`; фільтр: `docker compose run --rm -T api pnpm vt --project <пакет> <фільтр>`); e2e — на хості (`pnpm --filter @vf/web e2e`, API `api-e2e` :3101, Vite :5174). Порт 3001 на хості може тримати чужий `pnpm dev` — не чіпати; для ручної перевірки в браузері — конфіг `web-e2e-api` з `.claude/launch.json`.
- Кожна задача закінчується зеленими тестами зачеплених пакетів, `pnpm typecheck && pnpm lint` і комітом із рядком `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Журнал рішень і відхилень — `subproject-3-ledger.md` у теці нотаток сесії (як у підпроєкті 2).

## Review Focus

1. **Межа сегмента всередині кліпу з Ken Burns/zoom або посеред `xfade`** → у мовній версії немає стрибка кадру на межі (масштаб/фокус безперервні, перехід не обривається раптово). Тест — Task 4.
2. **Текст із числами, скороченнями, емодзі й дефісами** («У 2026 р. — 5 % зростання 🚀, Харків-Сіті») → whisper повертає інші токени («двох тисяч…»); кожне слово тексту все одно має мітку, мітки монотонні й у межах аудіо, емодзі не губить сусідні слова. Тест — Task 6.
3. **Текст або голос змінено, поки йде `voice.synthesize`** → результат не стає «свіжим» для нового тексту: `voiced_hash` рахується від тексту/голосу на старті задачі, рядок показується застарілим. Тест — Task 11.
4. **Сегмент видалено (або змінено межі) після озвучки; undo повертає його** → `localize` ігнорує рядки неіснуючих сегментів, після undo озвучка знову на місці; рендер мови не падає. Тест — Task 4 і Task 12.
5. **Дуже короткий сегмент (1–3 кадри) з довгою озвучкою і сегмент лише з фото** → темп 0,8 + довгий стоп-кадр, документ валідний (тривалості ≥ 1 кадр), фото просто показується довше; рендер дає очікувану тривалість. Тест — Task 4 і Task 8.

---

## Структура файлів

```
packages/shared/src/{timeline,languages,voice,words,jobs,settings}.ts           (+ timeline.test.ts, voice.test.ts)
packages/timeline/src/{segments,localize,evaluate,ops}.ts                      (+ segments.test.ts, localize.test.ts, evaluate.test.ts)
packages/captions/{package.json,tsconfig.json,fonts/*.ttf,fonts/OFL.txt}
packages/captions/src/{index,style,presets,fonts,layout,ass,subs,align}.ts      (+ *.test.ts)
packages/media/src/{silence,index}.ts                                          (+ media.int.test.ts)
packages/render/src/{compile,compile-video,compile-audio,compile-audio-only,ffmpeg-renderer,types}.ts (+ compile.test.ts, render.int.test.ts)
packages/ai/src/{types,catalog,cost,registry}.ts packages/ai/src/providers/{openai-speech,google-speech,whisper,gemini-stt}.ts
packages/ai/src/prompts/translate.ts packages/ai/src/fake/index.ts            (+ tests, providers.live.test.ts)
packages/db/src/schema.ts  packages/db/drizzle/0005_voice.sql
apps/api/src/modules/voice/{service,stale,localized,transcribe-job,translate-job,synthesize-job,router}.ts
apps/api/src/modules/caption-styles/{service,router}.ts
apps/api/src/modules/{projects,renders}/{service,router}.ts  apps/api/src/modules/renders/render-job.ts
apps/api/src/{app,config}.ts apps/api/src/routers/index.ts
apps/api/test/{voice,voice-render,caption-styles}.int.test.ts
apps/web/src/captions/{captions-layer,fonts}.ts
apps/web/src/editor/{preview-engine,audio-graph,video-sync,store}.ts
apps/web/src/voice/{use-voice,cost}.ts
apps/web/src/components/voice/{VoiceList,NewVoiceDialog,StudioPage,LanguageBar,SegmentTable,SegmentRow,SegmentStrip,PasteTextDialog,VoicePicker,OriginalSoundPanel,CaptionsPanel,StyleEditor,StudioRenderMenu}.tsx
apps/web/src/components/editor/{EditorPage,Toolbar,PreviewPane,Timeline,RenderMenu}.tsx
apps/web/src/components/settings/DefaultVoices.tsx
apps/web/src/routes/{voice,voice.$id}.tsx  apps/web/e2e/voice.spec.ts
docker/api.Dockerfile  docker-compose.yml  README.md
```

---

### Task 1: Спайк JASSUB поверх canvas з нашим годинником

Відповідь, а не код продукту: чи працює JASSUB без `<video>`, поверх нашого canvas, з часом, який задаємо ми, і зі шрифтами з URL — у dev і в `vite build`.

**Files:**
- Create: `prototypes/jassub-spike/{package.json,index.html,main.ts,sample.ass}` (одноразовий, як `prototypes/editor-demos`)

- [ ] **Step 1:** Vite-проєкт з `jassub` (точна версія ≥ 2 тижнів), canvas 1080×1920 (CSS 270×480, DPR), повзунок часу 0–10 с і кнопка ▶ (годинник `performance.now()`); `sample.ass` — 3 рядки кирилицею з `\t`-pop і `\kf`, шрифт Montserrat Bold з `fonts`.
- [ ] **Step 2:** Перевірити по черзі: (а) конструктор з `canvas` замість `video` + встановлення часу вручну на кожному кадрі; (б) якщо (а) не підтримується — `manualRender`/`renderOnce` у прихований canvas і `drawImage` поверх; (в) зміна ASS без перестворення (`setTrack`); (г) `pnpm build && pnpm preview` — воркер і WASM завантажуються; (ґ) кадр у момент слова збігається з кадром `ffmpeg -vf subtitles=sample.ass:fontsdir=…` (скриншот поруч, візуально).
- [ ] **Step 3:** Записати в ledger: робочий режим, точні імена API/опцій, як Vite віддає `workerUrl`/`wasmUrl` (`?url`-імпорти або `new URL(…, import.meta.url)`), обмеження. Якщо жоден режим не працює — зупинитися й спитати власника (запасний план зі спеки: рендер ASS через libass-WASM у прихований canvas).
- [ ] **Step 4:** Commit `chore(prototypes): jassub canvas spike` (код спайку лишається в `prototypes/`, у продукт не імпортується).

---

### Task 2: Спільні типи — сегменти, темп, мови, налаштування озвучки

**Files:**
- Modify: `packages/shared/src/{timeline,jobs,settings,index}.ts`, `packages/ai/src/types.ts` (реекспорт `Word`)
- Create: `packages/shared/src/{languages,voice,words}.ts`
- Test: `packages/shared/src/timeline.test.ts`, `packages/shared/src/voice.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // timeline.ts
  type Segment = { id: string; start: number; end: number };
  TimelineDoc += { segments?: Segment[] }        // refine: впорядковані, не перекриваються, end - start ≥ 1/fps
  MediaClip += { speed?: number /*0.8..1.25*/; hold?: number /*≥0*/ }
  AudioClip += { speed?: number; hold?: number; envelope?: { t: number; gain: number }[] /* t ≥ 0, зростає; gain 0..2 */ }
  // words.ts
  interface Word { text: string; startMs: number; endMs: number }
  // languages.ts
  interface LanguageInfo { code: string; name: string; script: 'latin' | 'cyrillic' | 'other'; captions: boolean }
  const LANGUAGES: readonly LanguageInfo[];  // uk en es de fr it pt pl nl cs ro tr sv ru kk
  function languageInfo(code: string): LanguageInfo;  // невідома → AppError('VALIDATION')
  // voice.ts
  interface VoiceChoice { model: ModelRef; voiceId: string; instructions?: string }
  interface OriginalSound { mode: 'replace' | 'duck'; level: number; duckLevel: number }
  const DEFAULT_ORIGINAL: OriginalSound;  // { mode: 'duck', level: 0.25, duckLevel: 0.08 }
  const projectVoiceSchema: z.ZodType<ProjectVoice>;
  type ProjectVoice = { languages: Record<string, { voice?: VoiceChoice; captions: { enabled: boolean; styleId: string } }>; original: OriginalSound };
  const voiceDefaultsSchema; type VoiceDefaults = Record<string, { model: ModelRef; voiceId: string }>;
  // jobs.ts
  JobType += 'voice.transcribe' | 'voice.translate' | 'voice.synthesize';  JobSubject += { lineId?: string }
  ```
- [ ] **Step 1: Failing tests:** `accepts doc with segments, speed, hold, envelope`; `rejects overlapping segments`; `rejects segment shorter than one frame`; `rejects speed 1.5 and 0.5`; `rejects envelope with decreasing t`; `old doc without new fields still normalizes`; `projectVoiceSchema fills DEFAULT_ORIGINAL for {}`; `languageInfo('uk').captions === true`, `languageInfo('xx')` кидає; `jobSubject` дістає `lineId`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project shared` → FAIL.
- [ ] **Step 3:** Схеми через Zod (`superRefine` для сегментів і `envelope`); `Word` переїжджає в shared, `packages/ai/src/types.ts` реекспортує.
- [ ] **Step 4:** PASS; `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat(shared): segments, clip speed/hold/envelope, languages, project voice settings`.

---

### Task 3: `@vf/timeline` — темп у `evaluate`/`audioPlan` і операції сегментів

**Files:**
- Modify: `packages/timeline/src/{evaluate,ops,index}.ts`
- Create: `packages/timeline/src/segments.ts`
- Test: `packages/timeline/src/evaluate.test.ts`, `packages/timeline/src/segments.test.ts`

**Interfaces:**
- Consumes: Task 2 типи.
- Produces:
  ```ts
  // evaluate.ts
  sourceTimeAt(clip: { start: number; duration: number; in: number; speed?: number; hold?: number }, t: number): number;
  //   = in + min(t - start, duration - hold) * speed
  AudioItem += { speed: number; hold: number; envelope: { t: number; gain: number }[] }
  // segments.ts — чисті doc → doc; час округлюється до кадру
  splitSegmentAt(doc, t: number, newId?: () => string): TimelineDoc;   // всередині сегмента — розрізати; поза — новий сегмент між сусідами (до країв сусідів/0/docDuration)
  mergeSegments(doc, aId: string, bId: string): TimelineDoc;          // сусідні; лишається id першого
  setSegmentBounds(doc, id: string, start: number, end: number): TimelineDoc;  // обмежено сусідами і [0, docDuration], ≥ 1 кадр
  deleteSegment(doc, id: string): TimelineDoc;
  segmentsFromText(count: number, duration: number, fps: number, newId?): Segment[];   // рівні частини, суцільні
  interface SpeechSegment { start: number; end: number; text: string }
  groupPhrases(stt: SpeechSegment[]): SpeechSegment[];     // 2–15 с; розрив на [.!?…] або паузі > 0.7
  segmentsFromSpeech(stt: SpeechSegment[], duration: number, fps: number, newId?): { segments: Segment[]; texts: Record<string, string> };
  //   межі = початки фраз; [0, перша фраза) — сегмент без тексту (якщо ≥ 1 кадр); останній — до duration
  ```
- [ ] **Step 1: Failing tests:** `sourceTimeAt` з `speed 0.8` і `hold 0.5` (у зоні hold — останній кадр джерела); `audioPlan` переносить `speed/hold/envelope` (замовчування 1/0/[]); операції: розрізати всередині/поза сегментом, злиття, межі не заходять на сусіда, `deleteSegment`; `segmentsFromText(3, 9, 30)` → `[0,3) [3,6) [6,9)`; `groupPhrases` об'єднує короткі шматки до кінця речення і ріже > 15 с; `segmentsFromSpeech` з першою фразою на 1,2 с → перший сегмент `[0,1.2)` без тексту.
- [ ] **Step 2:** `pnpm vt --project timeline` → FAIL.
- [ ] **Step 3:** Реалізація; `evaluate` використовує `sourceTimeAt`; наявні операції (`moveClip`, `trimStart/End`, `splitAt`) зберігають `speed/hold` (у `splitAt` `hold` лишається лише правій частині, `in` правої = `in + Δ × speed`).
- [ ] **Step 4:** PASS (разом з наявними тестами пакета).
- [ ] **Step 5:** Commit `feat(timeline): clip speed/hold in evaluation and segment operations`.

---

### Task 4: `localize` — документ мови

**Files:**
- Create: `packages/timeline/src/localize.ts`
- Test: `packages/timeline/src/localize.test.ts`

**Interfaces:**
- Consumes: Task 2–3.
- Produces:
  ```ts
  const LEAD = 0.15, TAIL = 0.35, SPEED_MIN = 0.8, SPEED_MAX = 1.25, DUCK_RAMP = 0.2;
  interface VoiceTake { segmentId: string; assetId: string; durationSec: number; transcriptId: string }
  interface SegmentFit { segmentId: string; base: number; target: number; speed: number; used: number; hold: number; trimmed: number }
  fitSegment(D: number, V: number | null, fps: number): Omit<SegmentFit, 'segmentId'>;
  //   V = null → { target: D, speed: 1, used: D, hold: 0, trimmed: 0 }
  //   T = LEAD + V + TAIL; s = clamp(D/T, 0.8, 1.25); used = min(D, T*s); hold = max(0, T - D/s); trimmed = D - used
  interface LocalizeOptions {
    language: string; takes: VoiceTake[]; original: OriginalSound;
    captions: { enabled: boolean; styleId: string } | null; newId?: () => string;
  }
  localize(doc: TimelineDoc, opts: LocalizeOptions): { doc: TimelineDoc; fits: SegmentFit[]; map: (tBase: number) => number };
  ```
- [ ] **Step 1: Failing tests** (документи-фікстури будуються в тесті):
  - `fitSegment`: `D=4, V=4.5` → `speed 0.8, hold 0, target 5` (4/5 = 0,8); `D=4, V=6` → `speed 0.8, hold 1.5`; `D=10, V=3` → `speed 1.25, used 4.375, trimmed 5.625`; `D=4, V=null` → незмінно; `D=1/30, V=3` (Review Focus 5) → `target 3.5`, `hold` > 0, усі тривалості ≥ 1 кадр.
  - Два сегменти з проміжком: проміжок зсувається на різницю першого; `map` монотонна й `map(segStart)` = початок сегмента мови.
  - Відеокліп через межу двох сегментів → два шматки з різним `speed`; `in` другого = кінець використаної частини першого шматка в джерелі; зв'язаний `original` розрізано так само; шматки в обрізаному хвості видалено.
  - **Review Focus 1:** Ken Burns на кліпі через межу: `clipTransform` шматків у точках межі збігається з базовим законом у відповідних точках (±1e-6); `fade.in` лише в першому шматку, `fade.out` — в останньому; `xfade` через межу обрізається до межі, всередині сегмента — зберігається.
  - Фото в сегменті з `hold` → кліп просто довший, `speed` не впливає на джерело (Review Focus 5).
  - Музика: позиції без змін, кліп за межею нової тривалості обрізано.
  - Озвучка: доріжка `voiceover` з `language`, кліп на `segStartLang + 0.15`, `duration = V`, без `speed`.
  - `replace` → `original` volume 0 і відео-кліпи `volume` 0; `duck` → `volume = 0.25`, `envelope` падає до `0.08/0.25` множника під кожним кліпом озвучки з рампою 0,2 с.
  - Субтитри: доріжка `captions` з кліпом на кожен кліп озвучки; `captions: null` або `enabled: false` → доріжки немає.
  - **Review Focus 4:** take з `segmentId`, якого немає в `doc.segments`, ігнорується; документ без `segments` → результат = вхід (крім `original`-гучності).
  - Результат проходить `normalizeDoc` і не має `segments`.
- [ ] **Step 2:** `pnpm vt --project timeline localize` → FAIL.
- [ ] **Step 3:** Реалізація: (1) `fits` для кожного сегмента; (2) кусково-лінійна `map`; (3) візуальні й `original`-кліпи розрізаються на межах сегментів і в `segStart + used`, кожен шматок перераховується через `map`, `speed = s`, `hold = H` шматкам, що закінчуються в `segStart + used`; параметри ефектів шматків — значення базового закону на кінцях шматка (`kenburns from*/to*`, `zoom` без змін); (4) музика/sfx обрізаються по `docDuration`; (5) доріжки `voiceover`/`captions`; (6) гучність/`envelope` оригіналу. Документ збирається з нуля, вхід не мутується.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(timeline): localize — video follows each language's voiceover`.

---

### Task 5: `@vf/captions` — стилі, пресети, шрифти, ASS/SRT/VTT

**Files:**
- Create: `packages/captions/{package.json,tsconfig.json}`, `packages/captions/fonts/{Montserrat-Bold,Inter-Bold,Oswald-Bold,Rubik-Bold,RobotoSlab-Bold,Unbounded-Bold}.ttf`, `packages/captions/fonts/OFL.txt`, `packages/captions/src/{index,style,presets,fonts,layout,ass,subs}.ts`
- Modify: `docker-compose.yml` (`nm-captions`), `vitest.config.ts` (проєкт `captions`), `pnpm-lock.yaml`
- Test: `packages/captions/src/{layout,ass,subs}.test.ts`

**Interfaces:**
- Consumes: `Word`, `TimelineDoc` (Task 2).
- Produces:
  ```ts
  type FontId = 'montserrat' | 'inter' | 'oswald' | 'rubik' | 'roboto-slab' | 'unbounded';
  const FONTS: readonly { id: FontId; family: string; file: string /* 'Montserrat-Bold.ttf' */; avgGlyph: number /* частка em */ }[];
  const captionStyleSchema: z.ZodType<CaptionStyle>;   // поля — spec §3.1
  type PresetId = 'preset:shorts' | 'preset:pop' | 'preset:karaoke' | 'preset:classic';
  const PRESETS: readonly { id: PresetId; name: string; style: CaptionStyle }[];
  resolveStyle(styleId: string, saved: Record<string, CaptionStyle>): CaptionStyle;   // невідомий → preset:shorts
  interface Page { lines: Word[][]; start: number; end: number }   // секунди таймлайну
  layoutWords(words: Word[], style: CaptionStyle, frame: { width: number; height: number }): Page[];
  interface TranscriptWords { words: Word[] }
  toAss(input: { doc: TimelineDoc; transcripts: Record<string, TranscriptWords>; styles: Record<string, CaptionStyle> }): string;
  toSrt(pages: Page[]): string;  toVtt(pages: Page[]): string;
  captionPages(doc, transcripts, styles): Page[];   // спільне для toAss/toSrt
  ```
- [ ] **Step 1:** Завантажити 6 TTF (Bold) з `github.com/google/fonts` (`ofl/<family>/`; для variable-шрифтів — статичний Bold з репозиторію сімейства або `fonttools varLib.instancer wght=700` у контейнері) + `OFL.txt`; перевірити кирилицю: `fc-query <file> | grep -c "lang:.*uk"` або `fc-scan --format "%{charset}"` містить `0410-044f`.
- [ ] **Step 2: Failing tests:**
  - `layoutWords`: `maxWordsPerLine 3, maxLines 1` → сторінки по 3 слова; пауза 0,6 с між словами → нова сторінка; `.`/`?` закінчує сторінку; довге слово, що не влазить у ширину, — окремий рядок; `uppercase` не міняє час.
  - `toAss`: заголовок з `PlayResX/Y` = `doc.width/height`, `WrapStyle: 2`; стиль із шрифтом/кольорами (`&H00BBGGRR`), обведенням, `BorderStyle=3` для плашки; `highlight` — по `Dialogue` на слово з активним кольором для нього; `pop` — `\t(0,60,\fscx115\fscy115)\t(60,120,\fscx100\fscy100)`; `karaoke` — `\kf` у сотих; час слова = `clip.start + word.startMs/1000 − clip.in`; слова поза кліпом відкинуто; символи `{`, `}`, `\` у тексті екрановано.
  - `toSrt`/`toVtt`: нумерація, формат часу `00:00:01,250` / `00:00:01.250`.
- [ ] **Step 3:** `pnpm vt --project captions` → FAIL; реалізація; PASS.
- [ ] **Step 4:** Commit `feat(captions): caption styles, presets, bundled fonts, ASS/SRT/VTT generation`.

---

### Task 6: Мітки слів — вирівнювання й оцінка

**Files:**
- Create: `packages/captions/src/align.ts`; `packages/media/src/silence.ts`
- Modify: `packages/media/src/index.ts`, `packages/captions/src/index.ts`
- Test: `packages/captions/src/align.test.ts`, `packages/media/src/media.int.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // captions/align.ts
  tokenize(text: string): { text: string; norm: string }[];   // слова тексту з пунктуацією; norm — нижній регістр, без пунктуації, ’ʼ' → ', без дефісів
  alignWords(script: string, stt: Word[]): Word[];             // DP Levenshtein на norm; незіставлені — інтерполяція між сусідами
  estimateWords(script: string, durationMs: number, speech: { startMs: number; endMs: number }[]): Word[];  // пропорційно кількості символів
  // media/silence.ts
  speechIntervals(path: string, opts?: { signal?: AbortSignal; noiseDb?: number /*-35*/; minSilence?: number /*0.2*/ }): Promise<{ startMs: number; endMs: number }[]>;
  ```
- [ ] **Step 1: Failing tests:** точний збіг → мітки STT; пропущене STT-слово → інтерпольовано між сусідами; зайве STT-слово ігнорується; «Харків-Сіті» проти STT «харків сіті» → одне слово від початку першого до кінця другого; **Review Focus 2:** текст «У 2026 р. — 5 % зростання 🚀, Харків-Сіті» проти STT «у дві тисячі двадцять шостому році п'ять відсотків зростання харків сіті» → `result.length === tokenize(script).length`, `startMs` неспадні, `endMs ≥ startMs`, усе в `[stt[0].startMs, stt.at(-1).endMs]`, емодзі не має власного слова (приклеюється до попереднього); `estimateWords` з двома інтервалами мовлення — жодне слово не потрапляє в паузу; `speechIntervals` на фікстурі «тон 1 с — тиша 1 с — тон 1 с» (`synth`) → два інтервали ±50 мс.
- [ ] **Step 2:** FAIL → реалізація (`silencedetect` через наявний `run` з `@vf/media`, парсинг `silence_start/silence_end` зі stderr) → PASS.
- [ ] **Step 3:** Commit `feat(captions,media): word alignment, estimated timings, speech intervals`.

---

### Task 7: Рендер — темп, стоп-кадр, envelope, субтитри, аудіо-мікс

**Files:**
- Modify: `packages/render/src/{compile,compile-video,compile-audio,ffmpeg-renderer,types,index}.ts`, `docker/api.Dockerfile` (за потреби `fontconfig`), `apps/api/src/config.ts` (`CAPTIONS_FONTS_DIR`, за замовчуванням `/app/packages/captions/fonts`)
- Create: `packages/render/src/compile-audio-only.ts`
- Test: `packages/render/src/compile.test.ts`, `packages/render/src/render.int.test.ts`

**Interfaces:**
- Consumes: Task 3 (`sourceTimeAt`, `AudioItem.speed/hold/envelope`), Task 5 (`toAss`).
- Produces:
  ```ts
  CompileInput += { subtitlesPath?: string; fontsDir?: string }
  Renderer.render(input += { subtitles?: string /* ASS-текст */; fontsDir?: string }, ctx)
  compileAudioOnly(input: { doc: TimelineDoc; sources: Map<string, SourceInfo>; roles: AudioRole[]; outPath: string; filterScriptPath: string }): Compiled;
  //   моно 16 кГц, libopus 32k, WebM; лише кліпи заданих ролей (+ volume відео-кліпів, якщо роль 'original')
  envelopeExpr(volume: number, env: { t: number; gain: number }[], start: number): string;  // для volume=…:eval=frame
  ```
- [ ] **Step 1: Failing unit tests (`compile.test.ts`):** відео зі `speed 0.8` → вхід `-t` = `(duration − hold) × speed`, у ланцюжку `setpts=(PTS-STARTPTS)/0.8`; `hold 0.5` → `tpad=stop_mode=clone:stop_duration=0.5`; `original` зі `speed 1.25` → `atempo=1.25`; `hold` в аудіо → `apad=pad_dur=…`; **жодного `atempo` для кліпів доріжки `voiceover`**; `envelope` → `volume='…':eval=frame` (вираз, обчислений `evalExpr`, дорівнює лінійній інтерполяції в 11 точках); `subtitlesPath` → `subtitles=f=…:fontsdir=…` останнім перед `format=yuv420p[vout]` і після `scale=…:flags=area`; `compileAudioOnly` → `-ac 1 -ar 16000 -c:a libopus -b:a 32k`, без відео-входів.
- [ ] **Step 2: Failing render tests (`render.int.test.ts`, справжній ffmpeg):** документ від `localize` (Task 4) з фікстурою-лічильником (`synth`: кадр N має колір N) і озвучкою-тоном: тривалість (ffprobe) = `docDuration` ±1 кадр; кадри в зоні `hold` однакові; кадр у середині сегмента зі `speed 0.8` має колір очікуваного кадру джерела (±1 кадр); субтитри (`toAss` з одним словом 1,0–1,5 с, пресет `preset:classic`): у момент 1,2 с у нижній третині є нечорні пікселі, у 0,5 с — немає; ducking: RMS оригіналу-тону під голосом нижчий у `0.08/0.25` разів (±20 %); **Review Focus 5:** сегмент 1 кадр з озвучкою 3 с і сегмент лише з фото — рендер успішний, тривалість очікувана.
- [ ] **Step 3:** `docker compose run --rm -T api pnpm vt --project render` → FAIL; реалізація (`FfmpegRenderer` пише `subtitles` у `workDir/subs.ass`); PASS.
- [ ] **Step 4:** Commit `feat(render): clip speed/hold, volume envelopes, ASS subtitles, audio-only mix`.

---

### Task 8: AI — TTS/STT адаптери, каталог, fake, переклад

**Files:**
- Modify: `packages/ai/src/{types,catalog,cost,registry,index}.ts`, `packages/ai/src/fake/index.ts`, `packages/ai/src/providers/providers.live.test.ts`
- Create: `packages/ai/src/providers/{openai-speech,google-speech,whisper,gemini-stt}.ts`, `packages/ai/src/prompts/translate.ts`
- Test: `packages/ai/src/providers/{openai-speech,google-speech,whisper,gemini-stt}.test.ts` (мок `fetch`), `packages/ai/src/fake/fake.test.ts`, `packages/ai/src/cost.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface TTS {
    synthesize(req: { text: string; voiceId: string; language: string; instructions?: string; signal?: AbortSignal }):
      Promise<{ audio: GeneratedFile /* audio/wav, durationMs */; words?: Word[] }>;
  }   // listVoices прибрано: голоси — у каталозі
  interface SttSegment { start: number; end: number; text: string }   // секунди
  interface STT {
    transcribe(req: { audio: Uint8Array; mime: string; language?: string; prompt?: string; signal?: AbortSignal }):
      Promise<{ text: string; language?: string; segments: SttSegment[]; words?: Word[] }>;
  }
  CatalogEntry += { voices?: { id: string; name: string }[] }; pricing.unit += 'minute'
  // каталог: openai/gpt-4o-mini-tts (minute 0.015; голоси alloy ash ballad coral echo fable nova onyx sage shimmer verse marin cedar),
  //   google/gemini-3.8-flash-tts (0.0135), google/gemini-3.8-flash-lite-tts (0.009) — 30 голосів із документації,
  //   openai/whisper-1 (stt, 0.006, wordTimestamps), google/gemini-3.8-flash (stt, 0.0015), fake/tts (voices [fake-voice], wordTimestamps), fake/stt
  costEstimate(entry, { durationSec }) // minute → usd × durationSec / 60
  const translateSchema: z.ZodType<{ items: { id: string; text: string }[] }>;
  buildTranslatePrompt(req: { from: string; to: string; items: { id: string; text: string }[]; context?: string[] }): { system: string; prompt: string };
  ```
- [ ] **Step 1: Звірити** з документацією провайдерів (2026-10-20): ендпоінти, імена полів, список голосів Gemini 3.8 TTS, формат відповіді (WAV/PCM), поля `verbose_json` whisper. Розбіжності — у ledger.
- [ ] **Step 2: Failing tests** (мок `fetch`): OpenAI TTS — `POST /v1/audio/speech` з `model`, `voice`, `input`, `instructions`, `response_format: 'wav'`; Gemini TTS — `generateContent` з `responseModalities: ['AUDIO']`, `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`, стиль у промпті/`speech_metadata`; PCM-відповідь → коректний WAV-заголовок 24 кГц моно 16 біт, `durationMs` з довжини; whisper — multipart з `timestamp_granularities[]=word` і `=segment`, `response_format=verbose_json`, мапінг у `segments` (с) і `words` (мс); Gemini STT — `generateObject` за схемою сегментів; текст > 1500 символів → `AppError('VALIDATION')` до виклику; 429 → наявний ретрай; fake: TTS — WAV тиші 0,4 с/слово з `words`; STT — 3 фрази (`0–1.2`, `2–3.5`, `4–5.5` с) з `segments` і `words`; fake `generateObject(translateSchema)` → `[${to}] ${text}` для кожного `id`; `costEstimate` за хвилинами.
- [ ] **Step 3:** FAIL → реалізація (OpenAI TTS і whisper, Gemini TTS — прямий `fetch` з `signal`, як `google-omni.ts`; Gemini STT — наявний `createAiSdkTextGen(...).generateObject` з аудіо як файлом); реєстр: фабрики `tts`/`stt` для `openai`, `google`, `fake` замість `fakeOnly` → PASS.
- [ ] **Step 4: Live tests** (`providers.live.test.ts`, пропускаються без ключа): обидва TTS — WAV тривалістю > 0; whisper — слова з мітками на згенерованому аудіо; Gemini STT — ≥ 1 сегмент.
- [ ] **Step 5:** Commit `feat(ai): OpenAI/Gemini TTS, whisper and Gemini STT adapters, translate prompt`.

---

### Task 9: БД — міграція 0005

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/db.int.test.ts`
- Create: `packages/db/drizzle/0005_voice.sql` (+ `meta`) через `pnpm --filter @vf/db generate`

**Interfaces:**
- Produces (Drizzle): `voiceLines`, `transcripts`, `captionStyles`, `projectLanguageTimelines`; `projects.voice` (`jsonb`, `$type<ProjectVoice>()`, default `'{}'`), `renders.subtitles` (`text`), `userSettings.voices` (`jsonb`, default `'{}'`). Поля, check-и, індекси й `on delete` — спека §5; додатково індекс `voice_lines (project_id, language)` і `transcripts (asset_id)`.
- [ ] **Step 1: Failing int test:** унікальність `(project_id, segment_id, language)`; видалення asset озвучки → `audio_asset_id` null; видалення проєкту → рядки `voice_lines` і `project_language_timelines` видалено; видалення asset → його `transcripts` видалено; check статусів.
- [ ] **Step 2:** Генерація міграції, перевірка SQL очима (лише очікувані `CREATE/ALTER`), `docker compose restart api` (міграції на старті) → PASS.
- [ ] **Step 3:** Commit `feat(db): voice lines, transcripts, caption styles, language timelines`.

---

### Task 10: API — модуль `voice` (дані, налаштування, тексти) і стилі субтитрів

**Files:**
- Create: `apps/api/src/modules/voice/{service,stale,router}.ts`, `apps/api/src/modules/caption-styles/{service,router}.ts`
- Modify: `apps/api/src/routers/index.ts`, `apps/api/src/routers/settings.ts` (голоси за замовчуванням)
- Test: `apps/api/test/voice.int.test.ts`, `apps/api/test/caption-styles.int.test.ts`

**Interfaces:**
- Consumes: Task 2, 9.
- Produces:
  ```ts
  // stale.ts
  textHash(text: string): string; voicedHash(text: string, voice: VoiceChoice): string;   // sha1 hex
  lineState(line, baseText: string | undefined): 'empty' | 'queued' | 'running' | 'ready' | 'failed' | 'stale';
  // service.ts (deps — як у projects/service)
  getVoice(deps, userId, projectId): Promise<VoiceView>;
  //   VoiceView = { projectId; version; segments: Segment[]; base: string; languages: string[]; voice: ProjectVoice;
  //     lines: Record<segmentId, Record<lang, { id; text; origin; state; audioUrl?; durationMs?; error?; words?: Word[]; timing? }>>;
  //     fits: Record<lang, SegmentFit[]>; styles: { id; name; style }[]; estimate: Record<lang, { chars; usd }> }
  createFromAsset(deps, userId, assetId): Promise<{ projectId: string }>;   // spec §7; відео не ready → VALIDATION
  setLanguages(deps, userId, { projectId, base, languages }): Promise<void>;     // через languageInfo
  setVoiceChoice / setOriginal / setCaptions(deps, userId, …): Promise<void>;
  setText(deps, userId, { projectId, segmentId, language, text }): Promise<void>;   // upsert, origin 'manual', ≤ 1500
  listVoiceProjects(deps, userId): Promise<{ id; title; format; thumbUrl; base; languages: { code; state: 'ready' | 'stale' | 'failed' | 'partial' | 'empty' }[] }[]>;  // проєкти з segments або voice_lines
  // routers: voice.{list,get,createFromAsset,setLanguages,setVoice,setOriginal,setCaptions,setText,preview}; captionStyles.{list,create,update,delete}
  ```
- [ ] **Step 1: Failing int tests:** `createFromAsset` для відео 1920×1080 → проєкт `16:9` з одним кліпом + зв'язаним `original` (якщо `has_audio`); вертикальне → `9:16`; квадратне → `9:16` з `fit: 'contain'`; `setText` → `getVoice` показує рядок `manual`; зміна тексту після `ready` → `stale`; зміна базового тексту після перекладу → перекладений рядок `stale`; рядки сегмента, якого немає в документі, не потрапляють у `getVoice`; `estimate` = символи/15 с × ціна моделі мови + whisper; `voice.preview` кешує зразок (другий виклик не викликає TTS — шпигун на fake); `captionStyles` CRUD і пресети в `list`; чужий `projectId` → `NOT_FOUND`; стиль з невалідним кольором → `VALIDATION`; `settings` зберігає `voices`; видалений asset озвучки → рядок `empty` з `audioDeleted: true` (поле `VoiceView.lines[…].audioDeleted`); `voice.list` повертає лише проєкти із сегментами або рядками.
- [ ] **Step 2:** FAIL → реалізація → PASS.
- [ ] **Step 3:** Commit `feat(api): voice module — project voice data, texts, settings, caption styles`.

---

### Task 11: API — задачі `voice.synthesize`, `voice.translate`, `voice.transcribe`

**Files:**
- Create: `apps/api/src/modules/voice/{synthesize-job,translate-job,transcribe-job}.ts`
- Modify: `apps/api/src/modules/voice/{service,router}.ts`, `apps/api/src/app.ts` (реєстрація), `apps/api/src/modules/recovery.ts` (статус рядків при рестарті)
- Test: `apps/api/test/voice.int.test.ts`

**Interfaces:**
- Consumes: Task 3 (`segmentsFromSpeech`), 6 (`alignWords`, `estimateWords`, `speechIntervals`), 7 (`compileAudioOnly`), 8, 10.
- Produces:
  ```ts
  enqueueSynthesize(deps, userId, { projectId, language?, segmentIds? }): Promise<{ jobIds: string[] }>;
  //   без segmentIds — усі рядки зі state ∈ {empty(з текстом), failed, stale}; рядок → 'queued', job_id
  enqueueTranslate(deps, userId, { projectId, language, segmentIds? }): Promise<{ jobId: string }>;
  enqueueTranscribe(deps, userId, { projectId, language? }): Promise<{ jobId: string }>;
  synthesizeJob(deps): JobDef<{ lineId: string }>;     // concurrency 3
  translateJob(deps): JobDef<{ projectId: string; language: string; segmentIds?: string[] }>;   // 2
  transcribeJob(deps): JobDef<{ projectId: string; language?: string }>;  // 2
  ```
- [ ] **Step 1: Failing int tests (FakeProvider):**
  - synthesize: рядок → asset `audio`, `source='generated'`, `language`, теги; `transcripts` (`source 'tts'`, `timing 'aligned'`) ; `duration_ms`, `voiced_hash`, `ready`; `generations` з `capability 'tts'` і `cost_estimate`; повтор задачі при незмінному `voiced_hash` не створює другого asset; **Review Focus 3:** `setText` під час задачі (fake TTS з затримкою через хук у тесті) → після завершення `lineState === 'stale'` і `voiced_hash` = хеш старого тексту; помилка TTS → рядок `failed` з текстом помилки, інші рядки `ready`.
  - мітки: TTS без `words` + доступний `openai/whisper-1` (тестовий каталог із fake-реалізацією під цим ref) → `alignWords`; без нього → `estimateWords`, `timing 'estimated'`.
  - translate: усі сегменти одним `generateObject`; рядки мови `translated` з `source_hash`; > 60 сегментів → кілька викликів з контекстом.
  - transcribe: проєкт з `original` → сегменти в документі (`timeline_version` +1) і рядки базової мови `stt`; повторний виклик замінює; проєкт без аудіо → `VALIDATION` «У відео немає звуку»; аудіо > 90 хв обробляється частинами (тест на функції розбиття часу, без справжніх 90 хв).
  - рестарт: `running` рядки → `failed` «Перервано перезапуском сервера».
- [ ] **Step 2:** FAIL → реалізація → PASS.
- [ ] **Step 3:** Commit `feat(api): voice jobs — synthesize with word timings, translate, transcribe original`.

---

### Task 12: API — локалізований документ, відокремлені мови, рендер мов

**Files:**
- Create: `apps/api/src/modules/voice/localized.ts`
- Modify: `apps/api/src/modules/voice/{service,router}.ts`, `apps/api/src/modules/projects/{service,router}.ts`, `apps/api/src/modules/renders/{service,render-job,router}.ts`
- Test: `apps/api/test/voice-render.int.test.ts`, `apps/api/test/projects.int.test.ts`

**Interfaces:**
- Consumes: Task 4, 5, 7, 10, 11.
- Produces:
  ```ts
  buildLocalized(deps, userId, projectId, language): Promise<{ timeline: TimelineDoc; subtitles: string | null; fits: SegmentFit[]; notReady: string[] /* segmentIds */ }>;
  //   відокремлена мова → її документ + ASS з його captions-доріжок; інакше localize(base, takes ready-рядків)
  voice.localized({ projectId, language }) → { timeline, subtitles, fits, assets: Record<string, EditorAsset> }
  voice.separate({ projectId, language }) / voice.unseparate({ projectId, language })
  projects.get({ id, language? }), projects.save({ id, language?, timeline, baseVersion })   // language → project_language_timelines
  renders.start({ projectId, preset, version, language?, force?: boolean })   // notReady і !force → VALIDATION { segmentIds }
  renders.startAll({ projectId, preset, languages, force? }) → { renderIds: string[] }
  voice.subtitles({ projectId, language, format: 'srt' | 'vtt' }) → { filename: string; content: string }   // captionPages + toSrt/toVtt
  ```
- [ ] **Step 1: Failing int tests:** `voice.localized` для мови з двома готовими рядками → тривалість = сума `fits.target` + проміжки; ASS містить слова; мова без озвучки → базовий документ і `subtitles: null`; `renders.start({ language: 'en' })` з неготовим рядком → `VALIDATION` з `segmentIds`, з `force` — рендер; повна задача `render` мови → MP4 asset з тривалістю локалізованого документа (±1 кадр), `renders.language = 'en'`, `renders.subtitles` заповнено; `startAll` для `uk, en` → два рендери з різною тривалістю; `voice.subtitles` для EN у `srt` → нумеровані блоки з часом першого слова; `separate` → `projects.get({ language })` повертає копію з версією 1, `save` з застарілою версією → `CONFLICT`; рендер відокремленої мови бере її документ; `unseparate` повертає до `localize`; **Review Focus 4:** видалити сегмент з озвученим рядком → `localized` і рендер успішні; повернути сегмент (save старого документа) → озвучка знову в результаті.
- [ ] **Step 2:** FAIL → реалізація → PASS.
- [ ] **Step 3:** Commit `feat(api): localized timelines, separated languages, per-language renders with subtitles`.

---

### Task 13: Web — прев'ю: темп, стоп-кадр, envelope, шар субтитрів JASSUB

**Files:**
- Create: `apps/web/src/captions/{captions-layer,fonts}.ts`
- Modify: `apps/web/src/editor/{preview-engine,audio-graph,video-sync}.ts`, `apps/web/src/components/editor/PreviewPane.tsx`, `apps/web/package.json` (`jassub`, `@vf/captions`), `apps/web/vite.config.ts` (за результатом Task 1)
- Test: `apps/web/src/editor/video-sync.test.ts`, `apps/web/src/editor/audio-graph.test.ts`

**Interfaces:**
- Consumes: Task 1 (робочий режим JASSUB), Task 3, Task 5 (`FONTS`).
- Produces:
  ```ts
  interface CaptionsLayer { setAss(ass: string | null): void; setTime(t: number): void; resize(cssW: number, cssH: number, dpr: number): void; destroy(): void }
  createCaptionsLayer(host: HTMLElement): CaptionsLayer;     // canvas поверх прев'ю; шрифти — FONT_URLS
  const FONT_URLS: Record<string, string>;                    // family → URL (Vite ?url з @vf/captions/fonts/*)
  PreviewEngine += { setSubtitles(ass: string | null): void }  // engine викликає layer.setTime на кожному кадрі/seek
  videoTarget(...) враховує speed/hold: playbackRate = speed; у зоні hold — pause на останньому кадрі
  ```
- [ ] **Step 1: Failing unit tests:** `videoTarget` для кліпу `speed 0.8, hold 0.5`: у зоні hold `{ paused: true, time: in + (duration − hold) × speed }`, поза — `playbackRate 0.8`; `audio-graph` планує `envelope` як `linearRampToValueAtTime` у точках `start + t` (мок `AudioParam`), `playbackRate` для `original` зі `speed`, `preservesPitch = true`.
- [ ] **Step 2:** FAIL → реалізація → PASS (`pnpm --filter @vf/web test`).
- [ ] **Step 3:** Ручна перевірка в браузері (`web-e2e-api`): тимчасовий проєкт з ASS (через `voice.localized` після Task 12) — субтитри видно поверх прев'ю, рухаються при seek і відтворенні; зламаний `wasmUrl` → прев'ю працює, повідомлення «Не вдалося завантажити субтитри».
- [ ] **Step 4:** Commit `feat(web): preview speed/hold/envelope and JASSUB captions layer`.

---

### Task 14: Web — `/voice` і студія: мови, сегменти, тексти, озвучка

**Files:**
- Create: `apps/web/src/routes/voice.$id.tsx`, `apps/web/src/voice/{use-voice,cost}.ts`, `apps/web/src/components/voice/{VoiceList,NewVoiceDialog,StudioPage,LanguageBar,SegmentTable,SegmentRow}.tsx`
- Modify: `apps/web/src/routes/voice.tsx` (замість `ComingSoon`), `apps/web/src/components/editor/RenderHistory.tsx` (колонка мови)
- Test: `apps/web/src/voice/cost.test.ts`

**Interfaces:**
- Consumes: Task 10–12 роутери, Task 13 (`PreviewEngine.setSubtitles`).
- Produces:
  ```ts
  useVoice(projectId): { view: VoiceView | undefined; refetch(); localized(lang): UseQueryResult<…> }  // інвалідація за jobs.feed (subject.projectId / lineId)
  formatFit(fit: SegmentFit, lang: string): string;   // «база 4,1 с → EN 5,3 с (темп ×0,8 + стоп-кадр 0,2 с)»
  ```
- [ ] **Step 1: Failing test:** `formatFit` для трьох випадків (рівно, темп + стоп-кадр, темп ×1,25 + «обрізано 5,6 с»).
- [ ] **Step 2:** Реалізація UI за спекою §9.1–9.2: список проєктів з мовами; «Озвучити відео» — вибір відео з бібліотеки або файл з ОС (наявний `UploadProvider`, після `ready` — `createFromAsset`) → `/voice/$id`; `LanguageBar` (база, мови, «+ мова» з `LANGUAGES`, стан мови: усі готові / є застарілі / є помилки); прев'ю з перемикачем мови (`voice.localized`); таблиця сегментів: база + вибрана мова, редагування тексту на місці (debounce 600 мс → `setText`), ▶ прослухати, ↻ переозвучити, стан рядка (кольорові позначки й тексти зі спеки), `formatFit`; кнопки «Розпізнати мову оригіналу» (з підтвердженням заміни), «Перекласти все», «Озвучити все ≈ $X»; без доступної моделі TTS/STT (`ai.catalog`, `available: false`) відповідні кнопки неактивні з підказкою «Немає ключа …»; рядок з `audioDeleted` — позначка «озвучку видалено».
- [ ] **Step 3:** PASS unit; ручна перевірка в браузері з fake-провайдерами: відео → розпізнати → EN → перекласти → озвучити → прев'ю EN із субтитрами.
- [ ] **Step 4:** Commit `feat(web): voice studio — projects list, languages, segment table, voicing`.

---

### Task 15: Web — студія: смуга сегментів, текст, голос, оригінал, стилі, рендер мов

**Files:**
- Create: `apps/web/src/components/voice/{SegmentStrip,PasteTextDialog,VoicePicker,OriginalSoundPanel,CaptionsPanel,StyleEditor,StudioRenderMenu}.tsx`, `apps/web/src/components/settings/DefaultVoices.tsx`
- Modify: `apps/web/src/components/voice/StudioPage.tsx`, `apps/web/src/routes/settings.tsx`

**Interfaces:**
- Consumes: Task 3 операції сегментів (через стор документа — зміни зберігаються наявним автозбереженням `projects.save`), Task 10–12, Task 5 (`PRESETS`, `captionStyleSchema`, `FONTS`).
- [ ] **Step 1:** `SegmentStrip` (спільний для студії й редактора): сегменти над шкалою часу, перетягування меж (снепінг 8 px до країв кліпів і плейхеда), «Розрізати під плейхедом», «Злити з наступним», «Видалити»; undo/redo — наявний zundo-стор документа.
- [ ] **Step 2:** `PasteTextDialog`: абзаци → якщо сегментів немає — `segmentsFromText`, інакше по порядку в наявні (зайві абзаци — нові сегменти в кінці, з попередженням).
- [ ] **Step 3:** `VoicePicker` (модель TTS з `ai.catalog`, голос із `voices`, ▶ зразок через `voice.preview`, інструкції стилю — для моделей, що їх підтримують), `OriginalSoundPanel` (Замінити/Приглушити + повзунки рівнів), `CaptionsPanel` (увімк., стиль ▾, «Редагувати стиль»), `StyleEditor` (поля §3.1, живе прев'ю на поточному кадрі через `setSubtitles`, «Зберегти як…»), `StudioRenderMenu` (пресет × мови → `renders.startAll`; неготові → діалог «Рендерити все одно?» → `force`), попередження «Мітки слів приблизні: додайте ключ OpenAI», якщо є рядки з `timing 'estimated'`; мови без шрифтів — субтитри вимкнені з поясненням; у меню субтитрів мови — «Завантажити .srt / .vtt» (`voice.subtitles`).
- [ ] **Step 4:** `DefaultVoices` у «Налаштуваннях».
- [ ] **Step 5:** Ручна перевірка в браузері: німе відео → «Вставити текст» (3 абзаци) → межі тягнуться → озвучка → зміна стилю видна в прев'ю → рендер двох мов з'являється в історії.
- [ ] **Step 6:** Commit `feat(web): studio segment strip, paste text, voice/original/captions panels, multi-language render`.

---

### Task 16: Web — редактор: режим мови, сегменти, відокремлення

**Files:**
- Modify: `apps/web/src/components/editor/{EditorPage,Toolbar,PreviewPane,Timeline,RenderMenu}.tsx`, `apps/web/src/editor/store.ts`
- Test: `apps/web/src/editor/store.test.ts`

**Interfaces:**
- Consumes: Task 12 (`projects.get/save` з `language`, `voice.localized`, `separate/unseparate`), Task 15 (`SegmentStrip`).
- Produces: `EditorMode = { kind: 'edit' } | { kind: 'language'; language: string; separated: boolean }` у UI-стані стору (поза історією).
- [ ] **Step 1: Failing test:** у режимі `language` (не відокремленої) операції стору — no-op (документ не змінюється); перемикання режиму не потрапляє в історію undo; відокремлена мова — окремий документ зі своєю `baseVersion` і автозбереженням з `language`.
- [ ] **Step 2:** Реалізація: перемикач «Монтаж / UK / EN … / EN (відокремлена)» у тулбарі; режим мови — таймлайн і прев'ю з `voice.localized` лише для перегляду (доріжки озвучки й субтитрів), банер зі спеки з кнопкою «Відокремити мову»; `SegmentStrip` над лінійкою лише в «Монтажі»; «Повернути до спільного» з підтвердженням; кнопка «Озвучка» → `/voice/$id`; «Рендер ▾» з вибором мови.
- [ ] **Step 3:** PASS; ручна перевірка в браузері.
- [ ] **Step 4:** Commit `feat(web): editor language view, segment strip, separate language`.

---

### Task 17: E2E, README, фінальна перевірка

**Files:**
- Create: `apps/web/e2e/voice.spec.ts` (+ фікстура відео з тоном у `apps/web/e2e/fixtures`)
- Modify: `README.md` (розділ «Озвучка й субтитри»: сценарії, ключі, вартість, обмеження), `.env.example` (за потреби `CAPTIONS_FONTS_DIR`)

- [ ] **Step 1: E2E (fake):** (1) «Озвучити відео» з ОС → розпізнати → 3 сегменти з текстом → додати EN → перекласти (`[en] …`) → озвучити все → у прев'ю EN у момент першого слова canvas субтитрів має непрозорі пікселі → рендер UK і EN (чернетка) → два MP4 у бібліотеці, тривалості різні й дорівнюють `fits` ±1 кадр; (2) німе відео → «Вставити текст» (3 абзаци) → озвучка → рендер; (3) редактор: перемикач мови показує банер, операції вимкнені; «Відокремити мову» → редагування → збереження.
- [ ] **Step 2:** `pnpm --filter @vf/web e2e` — двічі поспіль зелене (разом із наявними `editor`, `library`, `settings`).
- [ ] **Step 3:** `pnpm test`, `pnpm typecheck && pnpm lint` — зелені; кількість тестів — у ledger.
- [ ] **Step 4:** README оновлено; commit `test(e2e): voice studio flows; docs: voice & captions`.
