import { expect, test, type Page } from '@playwright/test';

const uid = () => Math.random().toString(36).slice(2, 10);

/** tRPC без transformer: query — GET, mutation — POST. */
const trpc = <T>(page: Page, proc: string, input: unknown) =>
  page.evaluate(
    async ({ proc, input }) => {
      const res = await fetch(`/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`);
      const body = (await res.json()) as { result?: { data: unknown }; error?: unknown };
      if (!body.result) throw new Error(JSON.stringify(body.error));
      return body.result.data as T;
    },
    { proc, input },
  ) as Promise<T>;

interface Doc {
  timeline: {
    segments: { id: string; start: number; end: number }[];
    tracks: { kind: string; role?: string; clips: { start: number; duration: number }[] }[];
  };
}
interface PipelineView {
  scenes: { narration: string; lines: Record<string, { state: string }> }[];
}

/** «Відео з теми» → тема, формат, тривалість → голос fake-моделі для кожної вибраної мови. */
async function openForm(page: Page, opts: { topic: string; format: '9:16' | '16:9'; sec: number; langs: string[] }) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Відео з теми' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Тема' }).fill(opts.topic);
  await dialog.getByRole('radio', { name: opts.format }).click();
  await dialog.getByLabel(/^Тривалість/).fill(String(opts.sec));
  for (const code of opts.langs) {
    const chip = dialog.getByTestId(`lang-chip-${code}`);
    if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  }
  for (const code of opts.langs) {
    const box = dialog.getByTestId(`pipeline-voice-${code}`);
    await box.getByLabel('Модель озвучки').click();
    await page.getByRole('option', { name: /Fake · озвучка/ }).click();
    await expect(box.getByRole('combobox', { name: 'Голос' })).toContainText(/\S/);
  }
  await expect(dialog.getByTestId('pipeline-blockers')).toHaveCount(0);
  await expect(dialog.getByTestId('pipeline-estimate')).toContainText('≈ $');
  return dialog;
}

test('topic to draft, 9:16, uk+en', async ({ page }) => {
  test.setTimeout(240_000);
  const topic = `Конвеєр ${uid()} про місто вночі`;
  const dialog = await openForm(page, { topic, format: '9:16', sec: 15, langs: ['uk', 'en'] });
  await expect(dialog.getByRole('checkbox', { name: 'Зупинитися після сценарію' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Створити' }).click();

  // сторінка сцен: смуга етапів і рядки сцен (fake: 15 с / 5 с = 3 сцени); автоперехід — лише через 1,5 с після «Готово»
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/pipeline$/);
  const projectId = /\/projects\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
  await expect(page.getByRole('list', { name: 'Етапи конвеєра' })).toBeVisible();
  await expect(page.getByTestId('stage-done')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });

  // автоперехід у редактор
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`), { timeout: 15_000 });
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('pipeline-banner')).toHaveCount(0);

  // таймлайн: на кожен сегмент-сцену — щонайменше один відео-кліп, що його перекриває
  const doc = await trpc<Doc>(page, 'projects.get', { id: projectId });
  expect(doc.timeline.segments).toHaveLength(3);
  const videoClips = doc.timeline.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips);
  for (const s of doc.timeline.segments)
    expect(videoClips.filter((c) => c.start < s.end && c.start + c.duration > s.start).length).toBeGreaterThan(0);
  await expect(page.getByTestId('track-video').locator('[data-clip-id]')).toHaveCount(videoClips.length);
  const view = await trpc<PipelineView>(page, 'pipeline.get', { projectId });
  for (const s of view.scenes) expect(s.lines).toMatchObject({ uk: { state: 'ready' }, en: { state: 'ready' } });

  // перемикач мови EN: доріжка озвучки з кліпами
  await page.getByTestId('mode-en').click();
  await expect(page.getByTestId('language-banner')).toContainText('Перегляд мови EN');
  const voiceTrack = page.locator('[data-testid=track-audio][data-role=voiceover]');
  await expect(voiceTrack.locator('[data-clip-id]')).toHaveCount(3);

  // рендер EN «Чернетка 720p» → MP4 «… (en) — …» у бібліотеці
  await page.getByTestId('render-menu').click();
  await page.getByTestId('render-en-draft').click();
  const item = page.getByTestId('render-item').first();
  await expect(item).toHaveAttribute('data-status', 'done', { timeout: 120_000 });
  await expect(item).not.toContainText('обробка файлу', { timeout: 30_000 });
  const renders = await trpc<{ language: string | null; output: { assetId: string; status: string } | null }[]>(
    page,
    'renders.list',
    { projectId },
  );
  expect(renders).toHaveLength(1);
  expect(renders[0]).toMatchObject({ language: 'en', output: { status: 'ready' } });

  await page.goto('/library');
  await page.getByRole('textbox', { name: 'Пошук' }).fill(topic);
  const card = page.getByTestId('asset-card').filter({ hasText: `${topic} (en)` });
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card).toHaveAttribute('data-kind', 'video');
});

test('16:9 with review', async ({ page }) => {
  test.setTimeout(180_000);
  const topic = `Огляд ${uid()} гірських стежок`;
  const dialog = await openForm(page, { topic, format: '16:9', sec: 60, langs: ['uk'] });
  const stop = dialog.getByRole('checkbox', { name: 'Зупинитися після сценарію' });
  await expect(stop).toBeChecked(); // замовчування 16:9
  await dialog.getByRole('button', { name: 'Створити' }).click();

  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/pipeline$/);
  const projectId = /\/projects\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
  await expect(page.getByTestId('stage-review')).toHaveAttribute('data-state', 'active', { timeout: 30_000 });
  await expect(page.getByTestId('stage-script')).toHaveAttribute('data-state', 'done');
  // fake: 60 с / 15 с = 4 сцени
  await expect(page.getByTestId('scene-row')).toHaveCount(4);

  const edited = `Змінений текст першої сцени ${uid()}`;
  const text = page.getByRole('textbox', { name: 'Текст сцени 1' });
  await text.fill(edited);
  await text.blur();
  await page.getByRole('button', { name: 'Продовжити' }).click();

  await expect(page.getByTestId('stage-done')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  const view = await trpc<PipelineView>(page, 'pipeline.get', { projectId });
  expect(view.scenes[0]!.narration).toBe(edited);
  expect(view.scenes[0]!.lines.uk?.state).toBe('ready');

  // кнопка «Відкрити в редакторі» веде в проєкт (автоперехід через 1,5 с — до нього посилання видно)
  await expect(page.getByText('Готово', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Відкрити в редакторі' })).toHaveAttribute(
    'href',
    `/projects/${projectId}`,
  );
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`), { timeout: 15_000 });
  await expect(page.getByTestId('track-video').locator('[data-clip-id]').first()).toBeVisible();
  await expect(page.getByTestId('open-scenes')).toBeVisible();
});
