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

/** Непрозорі пікселі в canvas субтитрів (JASSUB) — копія в 2D-полотно, щоб прочитати альфа-канал. */
const captionPixels = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=captions-canvas]');
    if (!c || !c.width || !c.height) return 0;
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) n++;
    return n;
  });

interface Localized {
  timeline: { fps: number; tracks: { kind: string; clips: { start: number; duration: number }[] }[] };
  fits: { base: number; target: number }[];
  subtitles: string | null;
}
const docEnd = (l: Localized) =>
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
  const first = /^Dialogue: 0,(\d+):(\d+):(\d+)\.(\d+),/m.exec(en.subtitles!)!;
  const firstWord = +first[1]! * 3600 + +first[2]! * 60 + +first[3]! + +first[4]! / 100;
  expect(firstWord).toBeGreaterThan(0);
  // перезавантаження — плейхед на 0 (перемикач мови час не скидає)
  await page.reload();
  await page.locator('[data-testid=language-chip][data-lang=en] button').first().click();
  await expect(page.getByTestId('captions-enabled')).toBeChecked();
  await expect(page.getByTestId('timecode')).toContainText('0:00.00 /');
  await expect(page.getByTestId('captions-canvas')).toBeAttached({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  expect(await captionPixels(page)).toBe(0); // t = 0, слів ще немає
  await page.getByRole('button', { name: 'Відтворити' }).click();
  await expect.poll(() => captionPixels(page), { timeout: 20_000, intervals: [100] }).toBeGreaterThan(50);
  await page.getByRole('button', { name: 'Пауза' }).click();

  // рендер UK і EN (чернетка) → два MP4 різної тривалості = fits ±1 кадр
  const renders = await renderDraft(page, projectId, 2);
  const dur = (lang: string) => {
    const r = renders.find((x) => x.language === lang);
    expect(r?.output?.status, lang).toBe('ready');
    return r!.output!.durationMs! / 1000;
  };
  const uk = await trpc<Localized>(page, 'voice.localized', { projectId, language: 'uk' });
  const durUk = dur('uk');
  const durEn = dur('en');
  expect(Math.abs(durUk - durEn)).toBeGreaterThan(0.2);
  for (const [l, d] of [
    [uk, durUk],
    [en, durEn],
  ] as const) {
    // база + Σ(цільова − базова довжина сегментів) = довжина мовної версії (проміжки між сегментами лишаються)
    const baseEnd = 7;
    const viaFits = baseEnd + l.fits.reduce((s, f) => s + (f.target - f.base), 0);
    expect(Math.abs(d - viaFits)).toBeLessThanOrEqual(FRAME + 0.02);
    expect(Math.abs(d - docEnd(l))).toBeLessThanOrEqual(FRAME + 0.02);
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
  await dragBy(page, clip.getByTestId('clip-handle-r'), -40);
  const edited = Number(await clip.getAttribute('data-duration'));
  expect(edited).toBeLessThan(before - 0.2);
  await page.waitForTimeout(1700);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
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
  expect(Math.abs(renders[0]!.output!.durationMs! / 1000 - docEnd(uk))).toBeLessThanOrEqual(FRAME + 0.02);
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
