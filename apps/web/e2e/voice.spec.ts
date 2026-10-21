import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
// 7 с відео з тоном 440 Гц (fake STT повертає три фрази до 5,5 с); німе — 2 с
const TONE = fixture('tone-7s.mp4');
const SILENT = fixture('clip.mp4');
const uid = () => Math.random().toString(36).slice(2, 10);
const FRAME = 1 / 30;

/** tRPC без transformer: query — GET, mutation — POST. */
const trpc = <T>(page: Page, proc: string, input: unknown, kind: 'query' | 'mutation' = 'query') =>
  page.evaluate(
    async ({ proc, input, kind }) => {
      const res =
        kind === 'query'
          ? await fetch(`/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`)
          : await fetch(`/trpc/${proc}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(input),
            });
      const body = (await res.json()) as { result?: { data: unknown }; error?: unknown };
      if (!body.result) throw new Error(JSON.stringify(body.error));
      return body.result.data as T;
    },
    { proc, input, kind },
  ) as Promise<T>;

/** «Озвучити відео» → файл з ОС (діалог сам чекає `ready`) → студія. */
async function createFromOsFile(page: Page, name: string, bytes: Buffer): Promise<string> {
  await page.goto('/voice');
  await page.getByTestId('new-voice').click();
  await page.getByTestId('voice-file-input').setInputFiles({ name, mimeType: 'video/mp4', buffer: bytes });
  await expect(page).toHaveURL(/\/voice\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect(page.getByTestId('language-chip').first()).toBeVisible();
  return page.url().split('/voice/')[1]!;
}

/** Голос мови (потрібен для озвучки): перший голос fake-моделі. */
async function pickVoice(page: Page) {
  await page.getByLabel('Модель озвучки').click();
  await page.getByRole('option', { name: /Fake · озвучка/ }).click();
  await expect(page.getByRole('combobox', { name: 'Голос' })).toContainText(/\S/);
}

const rows = (page: Page) => page.getByTestId('segment-row');

async function allRowsReady(page: Page, count: number) {
  await expect(rows(page)).toHaveCount(count);
  for (let i = 0; i < count; i++)
    await expect(rows(page).nth(i)).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
}

interface RenderRow {
  status: string;
  language: string | null;
  output: { status: string; durationMs: number | null; assetId: string } | null;
}

/** Рендер із діалогу студії (чернетка) → чекаємо, поки всі рендери проєкту завершаться (нічого не лишаємо в роботі). */
async function renderDraft(page: Page, projectId: string, expected: number): Promise<RenderRow[]> {
  await page.getByTestId('render-menu').click();
  await page.getByTestId('preset-draft').click();
  await page.getByTestId('render-start').click();
  const items = page.getByTestId('render-item');
  await expect(items).toHaveCount(expected, { timeout: 15_000 });
  for (let i = 0; i < expected; i++)
    await expect(items.nth(i)).toHaveAttribute('data-status', 'done', { timeout: 120_000 });
  await expect(page.getByText('обробка файлу…')).toHaveCount(0, { timeout: 30_000 });
  const list = await trpc<RenderRow[]>(page, 'renders.list', { projectId });
  expect(list).toHaveLength(expected);
  return list;
}

interface Localized {
  timeline: { fps: number; tracks: { kind: string; clips: { start: number; duration: number }[] }[] };
  fits: { base: number; target: number }[];
  subtitles: string | null;
}
const docEnd = (l: Pick<Localized, 'timeline'>) =>
  Math.max(
    ...l.timeline.tracks.filter((t) => t.kind !== 'captions').flatMap((t) => t.clips.map((c) => c.start + c.duration)),
  );

test('dub: OS video → recognise → EN → translate → voice all → captions on first word → render UK + EN', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const name = `dub-${uid()}.mp4`;
  const projectId = await createFromOsFile(page, name, TONE);

  // розпізнати мову оригіналу: fake STT дає три фрази, але вони зливаються в один сегмент (фрази < 2 с, паузи < 0,7 с)
  await page.getByTestId('transcribe').click();
  await expect(rows(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByLabel('Текст UK, сегмент 1')).toHaveValue(/перша тестова фраза/, { timeout: 30_000 });

  // межі — на смузі: розрізаємо двічі (плейхед усередині сегмента), далі тексти трьох сегментів
  for (const at of [0.3, 0.5]) {
    const seg = page.getByTestId('strip-segment').last();
    await seg.click({ position: { x: (await seg.boundingBox())!.width * at, y: 8 } });
    await page.getByTestId('split-segment').click();
  }
  await expect(rows(page)).toHaveCount(3);
  const texts = ['Це перша тестова фраза', 'А це друга фраза трохи довша', 'І наприкінці третя'];
  for (const [i, t] of texts.entries()) {
    const box = page.getByLabel(`Текст UK, сегмент ${i + 1}`);
    await box.fill(t);
    await box.blur();
  }
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

  // + EN → переклад (fake: «[en] …»)
  await page.getByTestId('add-language').click();
  await page.getByTestId('add-language-en').click();
  await page.locator('[data-testid=language-chip][data-lang=en] button').first().click();
  await page.getByTestId('translate-all').click();
  for (let i = 1; i <= 3; i++)
    await expect(page.getByLabel(`Текст EN, сегмент ${i}`)).toHaveValue(/^\[en\] \S/, { timeout: 30_000 });

  // базовий текст змінено після перекладу → рядок EN «переклад застарів», дія рядка — «Оновити переклад» цього сегмента
  const changedUk = 'Це перша тестова фраза, змінена';
  await page.getByLabel('Текст UK, сегмент 1').fill(changedUk);
  await page.getByLabel('Текст UK, сегмент 1').blur();
  await expect(rows(page).first().getByTestId('translation-stale')).toBeVisible({ timeout: 15_000 });
  await expect(rows(page).nth(1).getByTestId('translation-stale')).toHaveCount(0);
  await rows(page).first().getByRole('button', { name: 'Оновити переклад' }).click();
  await expect(page.getByLabel('Текст EN, сегмент 1')).toHaveValue(`[en] ${changedUk}`, { timeout: 30_000 });
  await expect(rows(page).first().getByTestId('translation-stale')).toHaveCount(0);

  // без голосу мови (ні в проєкті, ні за замовчуванням) «Озвучити все» вимкнена з видимою підказкою
  const defaults = await trpc<{ voices: Record<string, unknown> }>(page, 'settings.get', {});
  if (!defaults.voices.en) {
    await expect(page.getByTestId('voice-all')).toBeDisabled();
    await expect(page.getByTestId('key-hints')).toContainText('Виберіть голос для мови «Англійська»');
  }

  // озвучити все: EN, потім UK
  await pickVoice(page);
  await page.getByTestId('voice-all').click();
  await allRowsReady(page, 3);
  await page.locator('[data-testid=language-chip][data-lang=uk] button').first().click();
  await pickVoice(page);
  await page.getByTestId('voice-all').click();
  await allRowsReady(page, 3);

  // субтитри EN: у прев'ю у момент першого слова canvas має непрозорі пікселі, поза словами — порожній
  await page.locator('[data-testid=language-chip][data-lang=en] button').first().click();
  await page.getByTestId('captions-enabled').click();
  await expect(page.getByTestId('captions-enabled')).toBeChecked();
  const en = await expect
    .poll(async () => (await trpc<Localized>(page, 'voice.localized', { projectId, language: 'en' })).subtitles, {
      timeout: 30_000,
    })
    .toBeTruthy()
    .then(() => trpc<Localized>(page, 'voice.localized', { projectId, language: 'en' }));
  const dialogues = [
    ...en.subtitles!.matchAll(/^Dialogue: 0,(\d+):(\d+):(\d+)\.(\d+),(\d+):(\d+):(\d+)\.(\d+),/gm),
  ].map((m) => ({
    start: +m[1]! * 3600 + +m[2]! * 60 + +m[3]! + +m[4]! / 100,
    end: +m[5]! * 3600 + +m[6]! * 60 + +m[7]! + +m[8]! / 100,
  }));
  // слово після паузи між кліпами озвучки (TAIL + LEAD ≥ 0,5 с): до нього canvas має бути порожнім
  const gapAt = dialogues.findIndex((d, i) => i > 0 && d.start - dialogues[i - 1]!.end >= 0.4);
  expect(gapAt).toBeGreaterThan(0);
  const prevEnd = dialogues[gapAt - 1]!.end;
  const laterWord = dialogues[gapAt]!.start;
  expect(laterWord - 0.25).toBeGreaterThan(prevEnd + 0.1);
  const playhead = async () => {
    const m = /(\d+):(\d+\.\d+) \//.exec((await page.getByTestId('timecode').textContent()) ?? '')!;
    return +m[1]! * 60 + +m[2]!;
  };
  // перезавантаження — плейхед на 0 (перемикач мови час не скидає)
  await page.reload();
  await page.locator('[data-testid=language-chip][data-lang=en] button').first().click();
  await expect(page.getByTestId('captions-enabled')).toBeChecked();
  await expect(page.getByTestId('timecode')).toContainText('0:00.00 /');
  await expect(page.getByTestId('captions-canvas')).toBeAttached({ timeout: 30_000 });
  // Відтворення з семплуванням кожен кадр у сторінці: (мс від старту відтворення, непрозорі пікселі).
  // Таймкод оновлюється рідко й відстає від кадру субтитрів на сотні мс, тому час міряємо годинником сторінки
  // від першої зміни таймкоду (старт), а не за самим таймкодом.
  await page.evaluate(() => {
    const w = window as unknown as { __samples: { ms: number; px: number }[]; __stop: boolean };
    w.__samples = [];
    w.__stop = false;
    const copy = document.createElement('canvas');
    let t0: number | null = null;
    const tick = () => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid=captions-canvas]');
      const tc = document.querySelector('[data-testid=timecode]')?.textContent ?? '';
      if (t0 === null && !tc.startsWith('0:00.00 /')) t0 = performance.now();
      if (c && c.width && t0 !== null) {
        copy.width = c.width;
        copy.height = c.height;
        const ctx = copy.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(c, 0, 0);
        const d = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let px = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 16) px++;
        w.__samples.push({ ms: performance.now() - t0, px });
      }
      if (!w.__stop) requestAnimationFrame(tick);
    };
    tick();
  });
  // документ EN закінчується після останнього слова (хвіст озвучки TAIL = 0,35 с)
  const lastEnd = Math.max(...dialogues.map((d) => d.end));
  const enEnd = docEnd(en);
  expect(enEnd).toBeGreaterThan(lastEnd + 0.2);
  await page.getByRole('button', { name: 'Відтворити' }).click();
  // до кінця відтворення: прев'ю саме зупиняється в кінці документа (таймкод оновлюється рідко — чекаємо на кнопку)
  await expect.poll(playhead, { timeout: 30_000, intervals: [100] }).toBeGreaterThan(laterWord + 0.7);
  await expect(page.getByRole('button', { name: 'Відтворити' })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(300);
  const samples = await page.evaluate(() => {
    const w = window as unknown as { __samples: { ms: number; px: number }[]; __stop: boolean };
    w.__stop = true;
    return w.__samples.map((x) => ({ t: x.ms / 1000, px: x.px }));
  });
  // шар вже малював слово до паузи, далі йде порожній проміжок, що збігається з паузою між кліпами
  // (допуск на старт відтворення й ліниве перемальовування JASSUB), і слово після паузи
  const firstOn = samples.findIndex((x) => x.px > 50);
  expect(firstOn).toBeGreaterThanOrEqual(0);
  expect(samples[firstOn]!.t).toBeGreaterThanOrEqual(dialogues[0]!.start - 0.25);
  expect(samples[firstOn]!.t).toBeLessThan(dialogues[0]!.start + 0.7);
  const offAt = samples.findIndex((x, i) => i > firstOn && x.px === 0);
  expect(offAt).toBeGreaterThan(firstOn);
  const onAgain = samples.findIndex((x, i) => i > offAt && x.px > 50);
  expect(onAgain).toBeGreaterThan(offAt);
  const offStart = samples[offAt]!.t;
  const offEnd = samples[onAgain]!.t;
  expect(offStart).toBeGreaterThanOrEqual(prevEnd - 0.1);
  expect(offStart).toBeLessThan(prevEnd + 0.7);
  expect(offEnd).toBeGreaterThanOrEqual(laterWord - 0.1);
  expect(offEnd).toBeLessThan(laterWord + 0.7);
  expect(offEnd - offStart).toBeGreaterThan(0.2);
  // після останнього слова canvas порожній до кінця відео: останнє вимкнення — біля кінця останнього слова
  expect(samples.at(-1)!.px).toBe(0);
  const lastOn = samples.findLastIndex((x) => x.px > 50);
  expect(lastOn).toBeGreaterThan(onAgain);
  const lastOff = samples.findIndex((x, i) => i > lastOn && x.px === 0);
  expect(lastOff).toBeGreaterThan(lastOn);
  expect(samples.slice(lastOff).every((x) => x.px === 0)).toBe(true);
  expect(samples[lastOff]!.t).toBeGreaterThanOrEqual(lastEnd - 0.1);
  expect(samples[lastOff]!.t).toBeLessThan(lastEnd + 0.7);

  // рендер UK і EN (чернетка) → два MP4 різної тривалості = fits ±1 кадр
  const renders = await renderDraft(page, projectId, 2);
  const dur = (lang: string) => {
    const r = renders.find((x) => x.language === lang);
    expect(r?.output?.status, lang).toBe('ready');
    return r!.output!.durationMs! / 1000;
  };
  const uk = await trpc<Localized>(page, 'voice.localized', { projectId, language: 'uk' });
  const base = await trpc<Pick<Localized, 'timeline'>>(page, 'projects.get', { id: projectId });
  const durUk = dur('uk');
  const durEn = dur('en');
  expect(Math.abs(durUk - durEn)).toBeGreaterThan(0.2);
  for (const [l, d] of [
    [uk, durUk],
    [en, durEn],
  ] as const) {
    // база + Σ(цільова − базова довжина сегментів) = довжина мовної версії (проміжки між сегментами лишаються)
    const baseEnd = docEnd(base);
    const viaFits = baseEnd + l.fits.reduce((s, f) => s + (f.target - f.base), 0);
    expect(Math.abs(d - viaFits)).toBeLessThanOrEqual(FRAME + 0.005);
    expect(Math.abs(d - docEnd(l))).toBeLessThanOrEqual(FRAME + 0.005);
  }

  // обидва MP4 — у бібліотеці
  await page.goto('/library');
  const ids = renders.map((r) => r.output!.assetId);
  const found = await trpc<{ items: { id: string; status: string }[] }>(page, 'assets.list', {
    q: name.replace('.mp4', ''),
    kind: 'video',
    limit: 40,
  });
  for (const id of ids) expect(found.items.find((i) => i.id === id)?.status).toBe('ready');
  await page.getByPlaceholder(/Пошук/).first().fill(name.replace('.mp4', ''));
  await expect(page.getByTestId('asset-card').first()).toBeVisible({ timeout: 15_000 });

  // редактор: перегляд мови — банер, операції вимкнені; «Відокремити мову» → редагування → збереження
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByTestId('mode-switch')).toBeVisible();
  const clip = page.getByTestId('track-video').locator('[data-clip-id]').first();
  await expect(clip).toBeVisible();
  const saves: string[] = [];
  page.on('request', (r) => r.url().includes('projects.save') && saves.push(r.url()));
  await page.getByTestId('mode-en').click();
  await expect(page.getByTestId('language-banner')).toContainText('Перегляд мови EN');
  await expect(page.getByTestId('editor-segment-strip')).toHaveCount(0);
  const before = Number(await clip.getAttribute('data-duration'));
  await dragBy(page, clip.getByTestId('clip-handle-r'), -40);
  expect(Number(await clip.getAttribute('data-duration'))).toBe(before);
  await page.waitForTimeout(1800);
  expect(saves).toHaveLength(0);

  await page.getByTestId('separate').click();
  await expect(page.getByTestId('language-banner')).toContainText('відокремлена');
  const saveDone = page.waitForResponse((r) => r.url().includes('projects.save') && r.ok(), { timeout: 15_000 });
  await dragBy(page, clip.getByTestId('clip-handle-r'), -40);
  const edited = Number(await clip.getAttribute('data-duration'));
  expect(edited).toBeLessThan(before - 0.2);
  await saveDone;
  const saved = await trpc<{ timeline: { tracks: { kind: string; clips: { duration: number }[] }[] } }>(
    page,
    'projects.get',
    { id: projectId, language: 'en' },
  );
  expect(saved.timeline.tracks.find((t) => t.kind === 'video')!.clips[0]!.duration).toBeCloseTo(edited, 3);
});

test('silent video: paste text (3 paragraphs) → voice → render', async ({ page }) => {
  test.setTimeout(240_000);
  const projectId = await createFromOsFile(page, `silent-${uid()}.mp4`, SILENT);

  await page.getByTestId('paste-text-open').click();
  await page
    .getByTestId('paste-text')
    .fill('Перший абзац тексту.\n\nДругий абзац трохи довший за перший.\n\nІ третій абзац.');
  await page.getByTestId('paste-apply').click();
  await expect(rows(page)).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByLabel('Текст UK, сегмент 2')).toHaveValue(/Другий абзац/);

  await pickVoice(page);
  await page.getByTestId('voice-all').click();
  await allRowsReady(page, 3);

  const renders = await renderDraft(page, projectId, 1);
  expect(renders[0]).toMatchObject({ language: 'uk', output: { status: 'ready' } });
  const uk = await trpc<Localized>(page, 'voice.localized', { projectId, language: 'uk' });
  expect(uk.fits).toHaveLength(3);
  expect(Math.abs(renders[0]!.output!.durationMs! / 1000 - docEnd(uk))).toBeLessThanOrEqual(FRAME + 0.005);
});

async function dragBy(page: Page, handle: Locator, dx: number) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y);
  await page.mouse.up();
}
