# Підпроєкт 4a «Редактор і голос: доопрацювання» — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Розмір і позиція картинки в кадрі; озвучка базової мови справжніми кліпами на таймлайні «Монтажу»; стабільний голос (озвучка сценарію одним дублем, закріплена подача, порівняння голосів); панелі редактора зі зміною розміру.

**Architecture:** Нове поле `MediaClip.transform` проходить через одну геометрію `coverRect` (прев'ю) і `transformFilter` (ffmpeg). Озвучка в «Монтажі» — доріжка `voiceover` базової мови, яку тримає в актуальному стані чиста `syncVoiceTrack` (виклики: збірка конвеєра, редактор, рендер «Монтажу»); `localize` для базової мови бере її як є, для інших — прибирає. Пакетна озвучка — нова задача `voice.synthesizeBatch`: шматок сценарію → один TTS → мітки слів → нарізка по паузах (`splitTake`) → по asset'у на рядок, ненадійні межі — фолбек на `voice.synthesize`.

**Tech Stack:** як у підпроєкті 4 (Node 24, pnpm 12, TypeScript 6.0.x, Vitest, Fastify 5, tRPC 11, Zod 4, Drizzle 0.45, Postgres 17, ffmpeg, React 19, Vite 8, TanStack Router/Query, Tailwind 4, shadcn, Zustand+zundo, Playwright). Нова залежність: `react-resizable-panels` (через shadcn `resizable`), лише в Task 12.

**Spec:** `docs/specs/2026-10-23-subproject-4a-editor-voice.md` (головне джерело); `docs/specs/2026-10-20-subproject-3-voice.md` (сегменти, `voice_lines`, `localize`); `docs/specs/2026-10-20-subproject-2-editor.md` (таймлайн, рендер, паритет прев'ю↔рендер).

## Global Constraints

- Гілка `feat/subproject-4a-editor-voice` (від `main`); нічого не пушити й не відкривати PR без слова власника. Не чіпати порт 3001 на хості; ніколи не виконувати `docker compose down`. AI-ключі — лише з `.env`, не друкувати; `AI_FAKE=1` — fake-провайдер.
- Мова UI й повідомлень помилок — українська; ідентифікатори — англійська.
- `TimelineDoc` лишається `schemaVersion: 1`; нові поля лише необов'язкові (`MediaClip.transform`, `removedSegments` доріжки `voiceover`); старі документи проходять `normalizeDoc` без змін.
- `transform`: `scale ∈ [0.1, 4]`, `x, y ∈ [0, 1]`; відсутнє ≡ `{ scale: 1, x: 0.5, y: 0.5 }`; порядок геометрії: `fit` → `transform` → ефекти `zoom`/`kenburns`.
- Кліп озвучки: `start = segment.start + LEAD` (`LEAD = 0.15`), `in = 0`, `volume = 1`, `sceneId = segmentId`, тривалість — `max(1 кадр, quantizeDown(durationSec))`.
- Пакетна озвучка: шматок ≤ `TTS_MAX_CHARS` (1500), лише по межах рядків; рядки шматка — через `\n\n`; межа ненадійна, якщо будь-яке з двох прикордонних слів не зіставлене зі STT або пауза < 80 мс; пакет — коли для мови ≥ 2 рядків.
- `GEMINI_TTS_TEMPERATURE = 0.4`. Порівняння голосів: 2 дублі на кандидата, фраза ≤ 300 символів, ≤ 3 запити одночасно.
- Панелі: мінімуми бібліотека 160 px, інспектор 220 px, прев'ю й таймлайн 120 px; бібліотека й інспектор згортаються; `localStorage` лише в try/catch.
- Тести: `*.test.ts` unit, `*.int.test.ts` int, `*.spec.ts` Playwright, `*.live.test.ts` — лише `pnpm test:live`. Vitest — у контейнері (`pnpm test`; фільтр: `docker compose run --rm -T api pnpm vt --project <пакет> <фільтр>`); e2e — на хості (`pnpm --filter @vf/web e2e`, API `api-e2e` :3101, Vite :5174).
- Кожна задача закінчується зеленими тестами зачеплених пакетів, `pnpm typecheck && pnpm lint` і комітом із рядком `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Кліп озвучки, видалений вручну, після переозвучки цього ж рядка** → не повертається (сегмент у `removedSegments`); «Повернути озвучку» в меню сегмента повертає. Тест — Task 4 і Task 7.
2. **Undo після автосинхронізації в редакторі** → undo відкочує синхронізацію, але наступна зміна даних озвучки не зациклюється (синхронізація не застосовується повторно до того самого набору дублів). Тест — Task 7.
3. **Пакетна озвучка, у якій STT пропустив слово на межі рядків** → рядок не ріжеться навмання, а йде окремим `voice.synthesize`; сусідні рядки з надійними межами — `ready`. Тест — Task 9 і Task 10.
4. **Скасування `voice.synthesizeBatch` посеред шматка** → жоден рядок не лишається `running`; рядки, вже записані як `ready`, лишаються `ready`. Тест — Task 10.
5. **Картинка зі `scale` < 1 і Ken Burns** → прев'ю й рендер збігаються (той самий поріг різниці кадрів), картинка не «стрибає» на першому кадрі. Тест — Task 2.

---

## Структура файлів

```
packages/shared/src/timeline.ts                                   (+ timeline.test.ts)
packages/timeline/src/{draw,evaluate,ops,voice-track,localize,index}.ts (+ draw.int.test.ts, evaluate.test.ts, ops.test.ts, voice-track.test.ts, localize.test.ts)
packages/render/src/compile-video.ts                               (+ паритетний int-тест поруч з наявним для Ken Burns)
packages/captions/src/{align,split,index}.ts                       (+ align.test.ts, split.test.ts)
packages/ai/src/{delivery,index}.ts packages/ai/src/providers/google-speech.ts (+ google-speech.test.ts, delivery.test.ts)
apps/api/src/modules/voice/{takes,service,localized,synthesize-batch-job,router}.ts apps/api/src/modules/pipeline/assemble-job.ts
apps/api/src/modules/renders/service.ts apps/api/src/app.ts
apps/api/test/{voice-batch,voice-track}.int.test.ts
apps/web/src/components/ui/resizable.tsx
apps/web/src/components/editor/{EditorPage,Inspector,TransformControls,TransformOverlay,PreviewPane,Timeline,TimelineClip}.tsx
apps/web/src/editor/{use-editor-assets,voice-sync}.ts              (+ voice-sync.test.ts)
apps/web/src/components/voice/VoicePicker.tsx apps/web/src/components/settings/{DefaultVoices,AuditionDialog}.tsx
apps/web/e2e/{transform,voice-track,audition,panels}.spec.ts
```

---

### Task 1: `transform` у моделі й геометрії прев'ю

**Files:**
- Modify: `packages/shared/src/timeline.ts`, `packages/timeline/src/{draw,evaluate,ops,index}.ts`
- Test: `packages/shared/src/timeline.test.ts`, `packages/timeline/src/{evaluate,ops}.test.ts`, `packages/timeline/src/draw.test.ts` (новий, unit для `coverRect`)

**Interfaces:**
- Produces (`@vf/shared`): `clipTransformSchema` (`{ scale: number ∈ [0.1,4], x ∈ [0,1], y ∈ [0,1] }`), `type ClipTransform`, `DEFAULT_TRANSFORM = { scale: 1, x: 0.5, y: 0.5 }`; `MediaClip.transform?: ClipTransform`.
- Produces (`@vf/timeline`): `coverRect(src, dst, fit, scale, cx, cy, transform?: ClipTransform)`; `Layer.transform?: ClipTransform`; `setClipTransform(doc, clipId, t: ClipTransform | null): TimelineDoc` (null або значення = `DEFAULT_TRANSFORM` прибирає поле; не-відео кліп → документ без змін).

- [ ] **Step 1: Failing tests.** `timeline.test.ts`: `accepts clip without transform and keeps it absent after normalizeDoc`; `rejects transform scale 0.05 and 5, x -0.1, y 1.1`. `draw.test.ts`: `coverRect without transform equals old result`; `transform scale 0.5 centered → rect is half of contain rect, centered` (src 1000×1000, dst 1080×1920, contain → w 540, x 270, y 690); `transform x 0.25 y 0.75 moves center to (270, 1440)`; `zoom scale 2 around focus applies after transform` (центр rect із transform + zoom 2 у фокусі = центр rect лише з transform). `evaluate.test.ts`: `layer carries clip transform`. `ops.test.ts`: `setClipTransform sets, null removes, default removes, audio clip unchanged`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project shared timeline` і `--project timeline draw evaluate ops` → FAIL.
- [ ] **Step 3:** Реалізувати. Геометрія `coverRect`: базовий прямокутник `fit` (`w0,h0`) → `w1 = w0·s`, `h1 = h0·s`, `x1 = x·W − w1/2`, `y1 = y·H − h1/2` → далі наявна формула масштабу ефекту навколо фокусу з `x1,y1,w1,h1` замість `x0,y0,w0,h0`. `drawFrame` передає `layer.transform`.
- [ ] **Step 4:** Ті самі команди → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(timeline): clip transform (size and position) in model and preview geometry`.

### Task 2: `transform` у рендері (паритет)

**Files:**
- Modify: `packages/render/src/compile-video.ts`
- Test: наявний паритетний int-тест Ken Burns у `packages/render/src` (знайти за `drawFrame` у `*.int.test.ts`) — додати випадки

**Interfaces:**
- Consumes: `ClipTransform`, `coverRect` (Task 1).
- Produces: `transformFilter(effects, src, out, fit, duration, start, transform?: ClipTransform)`; `clipChain` передає `clip.transform`.

- [ ] **Step 1: Failing tests** (той самий метод і поріг, що наявні): `transform 0.5 at (0.3, 0.7) matches drawFrame at t 0.1/2.5/4.9`; `transform 0.6 + kenburns matches drawFrame` (Review Focus 5); `no transform → filter string unchanged` (snapshot наявного виразу).
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project render compile` → FAIL.
- [ ] **Step 3:** У `transformFilter` рахувати `w0,h0,x0,y0` з урахуванням `transform` (статичні числа, як у `coverRect`); вирази ефектів не змінювати.
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(render): clip transform in ffmpeg layer geometry`.

### Task 3: UI розміру й позиції (інспектор + рамка в прев'ю)

**Files:**
- Create: `apps/web/src/components/editor/TransformControls.tsx`, `apps/web/src/components/editor/TransformOverlay.tsx`, `apps/web/e2e/transform.spec.ts`
- Modify: `apps/web/src/components/editor/{Inspector,PreviewPane}.tsx`

**Interfaces:**
- Consumes: `setClipTransform`, `coverRect`, `DEFAULT_TRANSFORM` (Task 1); `store.apply`, `beginGesture/endGesture` (`apps/web/src/editor/store.ts`).
- Produces: `<TransformControls store clipId />` (група «Розмір і позиція»: повзунок «Розмір» 10–400 %, поля X/Y у %, кнопки «По центру», «Скинути»; `data-testid`: `transform-scale`, `transform-x`, `transform-y`, `transform-center`, `transform-reset`); `<TransformOverlay engine doc ui store />` (рамка `data-testid="transform-box"`, ручки `transform-handle-{nw,ne,sw,se}`).

- [ ] **Step 1: Failing e2e** `transform.spec.ts`: `drag box moves image and inspector shows new X/Y` (вибрати фото-кліп → тягнути `transform-box` на +100 px по X → `transform-x` > 50); `corner drag changes size`; `values survive reload`; `no box while playing`; `reset removes transform` (після «Скинути» поля 100 / 50 / 50).
- [ ] **Step 2:** `pnpm --filter @vf/web e2e transform` → FAIL.
- [ ] **Step 3:** Реалізувати. Рамка — DOM-оверлей поверх canvas у координатах кадру (масштаб canvas → кадр як у `PreviewPane`); прямокутник — `coverRect` без ефектів для вибраного візуального кліпу під плейхедом; жест: `beginGesture` на pointerdown, `apply(setClipTransform…)` на pointermove, `endGesture` на pointerup; кут — масштаб із збереженням пропорцій відносно центру. Ховати під час відтворення й коли `isReadOnlyState`.
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(web): clip size and position in inspector and preview box`.

### Task 4: `syncVoiceTrack` і видалення кліпів озвучки

**Files:**
- Create: `packages/timeline/src/voice-track.ts`, `packages/timeline/src/voice-track.test.ts`
- Modify: `packages/shared/src/timeline.ts` (поле доріжки), `packages/timeline/src/{ops,index}.ts`

**Interfaces:**
- Consumes: `VoiceTake`, `LEAD` (`localize.ts`), `insertTrack`, `quantize/quantizeDown`.
- Produces: аудіо-доріжка `removedSegments?: string[]` (лише `role: 'voiceover'`, у схемі — для будь-якої аудіо-доріжки, ігнорується для інших ролей); `syncVoiceTrack(doc, opts: { language: string; takes: VoiceTake[]; newId?: () => string }): { doc: TimelineDoc; changed: boolean }`; `voiceTrackOf(doc, language): AudioTrack | null`; `restoreSegmentVoice(doc, language, segmentId): TimelineDoc` (прибирає id з `removedSegments`); `deleteClips` додає `sceneId` видаленого кліпу доріжки `voiceover` у її `removedSegments`.

- [ ] **Step 1: Failing tests** `voice-track.test.ts`: `inserts clip at segment.start + LEAD with sceneId`; `creates track language=base when absent and takes exist`; `no takes and no track → same doc, changed false`; `new assetId keeps start, volume, fadeIn, fadeOut, envelope and resets in`; `same assetId → changed false (referential equality)`; `take gone → clip removed`; `segment gone → clip removed and id dropped from removedSegments`; `removed segment is not re-added after new take` (Review Focus 1); `restoreSegmentVoice + sync → clip back`. `ops.test.ts`: `deleteClips on voiceover clip records removedSegments`; `deleteClips on music clip does not`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project timeline voice-track ops` → FAIL.
- [ ] **Step 3:** Реалізувати за таблицею спеки §3.2.
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(timeline): voice track sync for the base language`.

### Task 5: `localize` з доріжкою озвучки і спільний збір дублів

**Files:**
- Create: `apps/api/src/modules/voice/takes.ts`
- Modify: `packages/timeline/src/localize.ts`, `apps/api/src/modules/voice/{localized,service}.ts`
- Test: `packages/timeline/src/localize.test.ts`, `apps/api/test/voice.int.test.ts`

**Interfaces:**
- Consumes: `voiceTrackOf` (Task 4).
- Produces: `localize` — якщо в документі є доріжка `voiceover` з `language === opts.language`: підгонки немає (усі `fits` з `speed 1`, `hold 0`), кліпи доріжки — це `voiceClips` (для приглушення й субтитрів), `transcriptId` субтитрів — з `opts.takes` за `assetId` (кліп без дубля — без субтитрів), `opts.takes` для підгонки ігноруються; доріжки `voiceover` інших мов прибираються завжди. `collectTakes(rows, segments, opts: { language; isBase; baseText: Map<string,string>; voice: VoiceChoice | null }): { takes: VoiceTake[]; notReady: string[] }` у `takes.ts` (винесено з `localized.ts` без зміни поведінки); `VoiceView.baseTakes: VoiceTake[]` у `getVoice`.

- [ ] **Step 1: Failing tests** `localize.test.ts`: `base language with voice track: no fitting, clips kept as is (moved clip stays moved)`; `base with track: captions reference track clip ids and take transcriptIds`; `base with track: duck curve follows track clips`; `other language: base voice track removed, own track added, single voiceover track in result`; `no track → behaviour unchanged` (наявні тести зелені). `voice.int.test.ts`: `voice.get returns baseTakes for ready base lines only`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project timeline localize` і `--project api voice.int` → FAIL.
- [ ] **Step 3:** Реалізувати; `localized.ts` і `getVoice` використовують `collectTakes`.
- [ ] **Step 4:** → PASS (усі наявні тести `localize` і `voice` теж); `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(voice): base language uses the voice track from the edit doc; shared takes collection`.

### Task 6: Серверні виклики синхронізації (збірка, рендер «Монтажу»)

**Files:**
- Modify: `apps/api/src/modules/pipeline/assemble-job.ts`, `apps/api/src/modules/renders/service.ts`
- Test: `apps/api/test/voice-track.int.test.ts` (новий), `apps/api/test/pipeline-flow.int.test.ts`

**Interfaces:**
- Consumes: `syncVoiceTrack` (Task 4), `collectTakes` (Task 5).
- Produces: `baseTakesOf(deps, userId, p: ProjectRow): Promise<VoiceTake[]>` у `takes.ts` (рядки базової мови + голос → `collectTakes`).

- [ ] **Step 1: Failing tests.** `pipeline-flow.int.test.ts`: `assembled timeline has voiceover track of base language with one clip per voiced scene`. `voice-track.int.test.ts`: `render without language syncs voice on a copy: render snapshot has new take, projects.timeline unchanged`; `render without language keeps user-moved clip position`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api pipeline-flow voice-track` → FAIL.
- [ ] **Step 3:** `assemble-job`: після `assembleTimeline` — `syncVoiceTrack(doc, { language: project.baseLanguage, takes })` з дублями, які вже рахує збірка (`lineOf` + `lineState === 'ready'`). `startRender` без мови: `doc = syncVoiceTrack(normalizeDoc(project.timeline), …).doc` перед `assertRenderable`.
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(api): voice track in assembled drafts and edit-doc renders`.

### Task 7: Синхронізація в редакторі, підсвітка переповнення, «Повернути озвучку»

**Files:**
- Create: `apps/web/src/editor/voice-sync.ts`, `apps/web/src/editor/voice-sync.test.ts`, `apps/web/e2e/voice-track.spec.ts`
- Modify: `apps/web/src/editor/use-editor-assets.ts`, `apps/web/src/components/editor/{Timeline,TimelineClip}.tsx`, `apps/web/src/components/voice/SegmentStrip.tsx` (меню сегмента)

**Interfaces:**
- Consumes: `syncVoiceTrack`, `restoreSegmentVoice`, `voiceTrackOf` (Task 4); `VoiceView.baseTakes` (Task 5).
- Produces: `takesKey(takes: VoiceTake[]): string` (стабільний ключ `segmentId:assetId` у порядку сегментів); `createVoiceSync(): { run(store, view): void }` — застосовує `syncVoiceTrack` через `store.apply`, лише якщо режим `edit`, не `readOnly`/`frozen`, і `takesKey` відрізняється від останнього застосованого (Review Focus 2); `voiceOverflow(doc, language): Map<clipId, seconds>` (на скільки кліп виходить за свій сегмент).

- [ ] **Step 1: Failing tests** `voice-sync.test.ts`: `applies sync once per takes key`; `undo after sync and same takes → not re-applied`; `new takes after undo → applied`; `skips in language mode and when frozen`; `voiceOverflow reports clip longer than its segment`. `voice-track.spec.ts`: `voiced line appears as clip in edit mode and preview plays voice` (fake TTS; перевірка через `audio-graph` debug або наявний спосіб у `voice.spec.ts`); `deleted voice clip stays deleted after re-synthesis`; `restore voice from segment menu brings it back`; `overflowing clip has warning title «Озвучка довша за сцену на»`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project web voice-sync` і `pnpm --filter @vf/web e2e voice-track` → FAIL.
- [ ] **Step 3:** Реалізувати; виклик `run` у `use-editor-assets` на зміну `voice.data`; підсвітка — клас попередження й `title` у `TimelineClip`; пункт «Повернути озвучку» в меню сегмента, видимий, коли сегмент у `removedSegments`.
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(web): base voice clips on the edit timeline with sync, overflow hint and restore`.

### Task 8: Закріплена подача (типова інструкція, temperature Gemini)

**Files:**
- Create: `packages/ai/src/delivery.ts`, `packages/ai/src/delivery.test.ts`
- Modify: `packages/ai/src/{index}.ts`, `packages/ai/src/providers/google-speech.ts`, `apps/api/src/modules/voice/service.ts` (`voiceForLanguage`), `apps/web/src/components/voice/VoicePicker.tsx`
- Test: `packages/ai/src/providers/google-speech.test.ts`, `apps/api/test/voice.int.test.ts`

**Interfaces:**
- Produces (`@vf/ai`): `DEFAULT_DELIVERY: Record<string, string>` (`uk`, `en` — тексти нижче; інші мови → `en`), `deliveryFor(language: string): string`, `GEMINI_TTS_TEMPERATURE = 0.4`. `voiceForLanguage` повертає `{ ...voice, instructions: voice.instructions?.trim() || deliveryFor(language) }`.
- Тексти (копія фіксована):
  - `uk`: «Рівний спокійний голос оповідача. Помірний сталий темп, нейтральна впевнена інтонація, однакова гучність. Без драматизму, шепоту, сміху й різких пауз.»
  - `en`: «Steady, calm narrator voice. Moderate consistent pace, neutral confident intonation, even volume. No drama, whispering, laughter or abrupt pauses.»

- [ ] **Step 1: Failing tests.** `delivery.test.ts`: `uk and en texts`, `unknown language falls back to en`. `google-speech.test.ts`: `request body has generationConfig.temperature 0.4`. `voice.int.test.ts`: `voice without instructions gets default delivery; its ready lines become stale`; `voice with own instructions keeps voicedHash (line stays ready)`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project ai delivery google-speech` і `--project api voice.int` → FAIL.
- [ ] **Step 3:** Реалізувати; `VoicePicker`: плейсхолдер поля інструкції = `deliveryFor(lang)`, кнопка «Вставити типову».
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(voice): default delivery instructions and lower Gemini TTS temperature`.

### Task 9: Нарізка дубля на рядки (`splitTake`) і шматки сценарію

**Files:**
- Create: `packages/captions/src/split.ts`, `packages/captions/src/split.test.ts`
- Modify: `packages/captions/src/{align,index}.ts`, `packages/captions/src/align.test.ts`

**Interfaces:**
- Produces (`@vf/captions`): `alignWordsDetailed(script, stt): { words: Word[]; matched: boolean[] }` (`alignWords` = `.words`, поведінка без змін); `chunkLines(lines: { id: string; text: string }[], max = 1500): { id: string; text: string }[][]` (порядок збережено, межі лише між рядками, рядок > max — окремий шматок); `CHUNK_JOIN = '\n\n'`; `splitTake(input: { words: Word[]; matched: boolean[]; lineTexts: string[]; speech: { startMs: number; endMs: number }[]; durationMs: number }): { lines: ({ startMs: number; endMs: number; words: Word[] } | null)[] }` — `null` для рядка з ненадійною межею (з будь-якого боку); слова рядка зсунуті на `startMs`; межа = середина паузи, зсунута до найближчої тиші з `speech`, якщо тиша перетинає паузу; `MIN_GAP_MS = 80`.

- [ ] **Step 1: Failing tests** `split.test.ts`: `chunkLines keeps order and splits only between lines at 1500`; `chunkLines puts oversize line alone`; `three lines with clear pauses → three ranges covering 0..durationMs`; `boundary snaps to silence interval inside the gap`; `unmatched last word of line 1 → lines 1 and 2 are null, line 3 ok` (Review Focus 3); `gap 50 ms → both neighbours null`; `words shifted to line start`. `align.test.ts`: `alignWordsDetailed marks interpolated words as unmatched; alignWords unchanged`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project captions split align` → FAIL.
- [ ] **Step 3:** Реалізувати; токени рядків — тим самим `tokenize`, що в `alignWords`, щоб індекси слів рядків збігались з `words`.
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(captions): split one take into lines by pauses`.

### Task 10: Задача `voice.synthesizeBatch`

**Files:**
- Create: `apps/api/src/modules/voice/synthesize-batch-job.ts`, `apps/api/test/voice-batch.int.test.ts`
- Modify: `packages/shared/src/jobs.ts` (`JobType`), `apps/api/src/modules/voice/{service,synthesize-job}.ts`, `apps/api/src/app.ts`, `packages/ai/src/fake/index.ts` (опція fake TTS без слів для тесту фолбеку)

**Interfaces:**
- Consumes: `chunkLines`, `splitTake`, `alignWordsDetailed`, `CHUNK_JOIN` (Task 9); `voiceForLanguage` (Task 8); з `synthesize-job.ts` винести й експортувати `wordTimings` (повертає ще `matched`) і `saveLineTake(deps, ctx, line, { bytes, durationMs, words, timing, voice, text })` (asset + transcript + рядок `ready` з `voicedHash`) — `voice.synthesize` користується ними без зміни поведінки.
- Produces: `JobType` + `'voice.synthesizeBatch'`, payload `{ projectId: string; language: string; lineIds: string[] }`, concurrency 2; `enqueueSynthesize` — для мови з ≥ 2 рядками в `todo` ставить одну batch-задачу (усі рядки `queued`, `job_id` = задача), інакше як зараз.

- [ ] **Step 1: Failing tests** `voice-batch.int.test.ts` (fake TTS з мітками слів): `4 lines → 1 batch job, 4 ready lines with own assets and transcripts, durations sum ≈ take`; `ready line voicedHash equals what voice.synthesize would write`; `unreliable boundary → those lines re-enqueued as voice.synthesize, others ready` (fake STT пропускає слово); `chunk TTS error → its lines failed, other chunks ready`; `cancel mid-batch → no line left running, ready lines stay ready` (Review Focus 4); `single line → voice.synthesize as before`; `pipeline enqueue of 3 empty lines → one batch job`.
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api voice-batch` → FAIL.
- [ ] **Step 3:** Реалізувати за спекою §4.3: захоплення рядків атомарно (як у `voice.synthesize`, умова `job_id = ctx.jobId`); шматки по черзі; вирізка `atrim` через `deps.media`; генерація — одна на шматок (`params.lineIds`); на скасування — рядки задачі, що не `ready`, повертаються в попередній стан (`empty`/`failed`/`stale` за `voiced_hash`).
- [ ] **Step 4:** → PASS (наявні `voice.int`, `pipeline-flow` теж); `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(voice): batch synthesis of a script as one take, split into lines`.

### Task 11: «Порівняти голоси»

**Files:**
- Create: `apps/web/src/components/settings/AuditionDialog.tsx`, `apps/web/e2e/audition.spec.ts`
- Modify: `apps/api/src/modules/voice/{service,router}.ts`, `apps/web/src/components/settings/DefaultVoices.tsx`
- Test: `apps/api/test/voice.int.test.ts`

**Interfaces:**
- Consumes: `deliveryFor` (Task 8); `previewVoice` (наявний — спільний код кешу/підпису).
- Produces: tRPC `voice.audition` (mutation) `{ model, voiceId, language, text: 1..300, instructions?: string, take: 1|2 } → { url }`; ключ `u/<userId>/voice-samples/audition/<sha256(model|voiceId|language|text|instructions)>/<take>.wav`; `AUDITION_CANDIDATES: { model: ModelRef; voiceId: string }[]` (OpenAI `marin`, `cedar`, `ash`, `coral`; `google/gemini-3.8-flash-tts` `Autonoe`, `Vindemiatrix`, `Kore`, `Charon`) у `DefaultVoices`/`AuditionDialog`.

- [ ] **Step 1: Failing tests.** `voice.int.test.ts`: `audition caches by text and take: second call does not hit TTS`; `audition rejects text of 301 chars and unavailable model`. `audition.spec.ts` (fake TTS — у каталозі fake кандидати замість реальних, коли `AI_FAKE=1`): `dialog generates 2 takes per checked candidate`; `estimate shown before start`; `make default saves model, voice and instructions` (після закриття `DefaultVoices` показує вибраний голос).
- [ ] **Step 2:** `docker compose run --rm -T api pnpm vt --project api voice.int` і `pnpm --filter @vf/web e2e audition` → FAIL.
- [ ] **Step 3:** Реалізувати; черга клієнта — ≤ 3 запити одночасно; оцінка — `символи / CHARS_PER_SEC × ціна за хвилину × дублі × кандидати`.
- [ ] **Step 4:** → PASS; `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(voice): compare voices by ear and set the default`.

### Task 12: Панелі редактора зі зміною розміру

**Files:**
- Create: `apps/web/src/components/ui/resizable.tsx` (`pnpm dlx shadcn@latest add resizable` у `apps/web`), `apps/web/e2e/panels.spec.ts`
- Modify: `apps/web/src/components/editor/EditorPage.tsx`, `apps/web/package.json`

**Interfaces:**
- Produces: `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` (shadcn); групи з `autoSaveId` `editor-h` і `editor-v`; `data-testid`: `panel-library`, `panel-inspector`, `handle-library`, `handle-inspector`, `handle-timeline`.

- [ ] **Step 1: Failing e2e** `panels.spec.ts`: `dragging library handle changes its width and it survives reload`; `dragging timeline handle changes timeline height`; `double click on handle restores default width`; `library collapses when dragged to the edge and expands back`.
- [ ] **Step 2:** `pnpm --filter @vf/web e2e panels` → FAIL.
- [ ] **Step 3:** Перебудувати сітку `EditorPage`: тулбар і банери — як зараз; далі вертикальна група [горизонтальна група (бібліотека | прев'ю | інспектор) | (смуга сегментів + таймлайн)]; історія рендерів — під групою. Мінімуми в пікселях перевести у відсотки від розміру групи через `onLayout`/`ResizeObserver` або `minSize` у px, якщо підтримується версією бібліотеки (перевірити й вибрати одне).
- [ ] **Step 4:** → PASS (наявні e2e редактора теж); `pnpm typecheck && pnpm lint`.
- [ ] **Step 5:** Commit `feat(web): resizable editor panels`.

### Task 13: Фінальна перевірка

**Files:**
- Modify: `README.md` (розділ редактора/озвучки: розмір картинки, озвучка в «Монтажі», пакетна озвучка, порівняння голосів, панелі)

- [ ] **Step 1:** `pnpm test`, `pnpm --filter @vf/web e2e`, `pnpm typecheck && pnpm lint` → усе зелене.
- [ ] **Step 2:** Ручна перевірка в браузері (`web-e2e-api` з `.claude/launch.json`, fake-провайдер): конвеєр → чернетка з голосом у «Монтажі»; зменшити картинку рамкою; рендер «Монтажу» й UK — голос і позиція картинки є в обох файлах.
- [ ] **Step 3:** Commit `docs: README for sub-project 4a`.
