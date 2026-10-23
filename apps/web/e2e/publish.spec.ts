import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const TONE = readFileSync(new URL('./fixtures/tone.mp4', import.meta.url));
const uid = () => Math.random().toString(36).slice(2, 10);

/** tRPC без transformer: query — GET, mutation — POST. */
const trpc = <T>(page: Page, proc: string, input: unknown, kind: 'query' | 'mutation' = 'query') =>
  page.evaluate(
    async ({ proc, input, kind }) => {
      const res =
        kind === 'query'
          ? await fetch(
              input === undefined
                ? `/trpc/${proc}`
                : `/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`,
            )
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

/** Перетягування MP4 з ОС на таймлайн (як у editor.spec). */
async function dropVideo(page: Page) {
  await page.evaluate(
    ({ bytes, name }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'video/mp4' }));
      const tl = document.querySelector('[data-testid=timeline]')!;
      const r = tl.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, clientX: r.left + 132, clientY: r.top + 60, dataTransfer: dt };
      for (const t of ['dragenter', 'dragover', 'drop']) tl.dispatchEvent(new DragEvent(t, init));
    },
    { bytes: [...TONE], name: `tone-${uid()}.mp4` },
  );
}

/** Проєкт 9:16 з готовим фінальним рендером; повертає id проєкту */
async function projectWithFinalRender(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новий проєкт' }).click();
  await page.getByLabel('Назва').fill(`Publish ${uid()}`);
  await page.getByRole('radio', { name: '9:16' }).click();
  await page.getByRole('button', { name: 'Створити' }).click();
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('timeline')).toBeVisible();
  const projectId = page.url().split('/projects/')[1]!;
  await dropVideo(page);
  await expect(page.getByTestId('track-audio').locator('[data-clip-id]')).toHaveCount(1, { timeout: 30_000 });
  // після debounce автозбереження (1,5 с)
  await page.waitForTimeout(1700);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

  await page.getByTestId('render-menu').click();
  await page.getByRole('menuitem', { name: 'Фінал 1080p', exact: true }).click();
  const item = page.getByTestId('render-item').first();
  await expect(item).toHaveAttribute('data-status', 'done', { timeout: 90_000 });
  await expect(item).not.toContainText('обробка файлу', { timeout: 30_000 });
  return projectId;
}

test('publishing: manual TikTok + fake YouTube → YouTube published, TikTok awaits → paste link → published', async ({
  page,
}) => {
  test.setTimeout(240_000);

  // AI-метадані беруть типову модель тексту — у тестовій БД її може не бути
  await page.goto('/settings');
  await page.getByRole('combobox', { name: 'Текст' }).click();
  await page.getByRole('option', { name: 'Fake · текст' }).click();
  await expect(page.getByRole('combobox', { name: 'Текст' })).toContainText('Fake · текст');

  // ручні публікації, що лишились від попередніх запусків, рахувались би в бейджі
  const leftovers = await trpc<{ id: string; status: string }[]>(page, 'publish.list', undefined);
  for (const p of leftovers.filter((x) => x.status === 'awaiting_manual')) {
    await trpc(page, 'publish.cancel', { id: p.id }, 'mutation');
  }

  const projectId = await projectWithFinalRender(page);
  const editorUrl = page.url();

  // акаунти: ручний TikTok (uk) і fake-YouTube (uk)
  await page.goto('/publications');
  const strip = page.getByTestId('accounts-strip');
  const tiktokName = `@tt${uid()}`;
  await strip.getByTestId('add-manual-account').click();
  const accountDialog = page.getByRole('dialog');
  await expect(accountDialog.getByLabel('Платформа')).toContainText('TikTok');
  await expect(accountDialog.getByLabel('Мова каналу')).toContainText('(UK)');
  await accountDialog.getByLabel('Назва').fill(tiktokName);
  await accountDialog.getByRole('button', { name: 'Додати' }).click();
  await expect(strip.getByTestId('account-card').filter({ hasText: tiktokName })).toBeVisible();

  await strip.getByTestId('connect-youtube').click();
  await expect(page.getByRole('dialog').getByLabel('Мова каналу')).toContainText('(UK)');
  await page.getByTestId('connect-youtube-submit').click();
  // fake OAuth одразу повертає на /publications?connected=<id>
  await expect(page.getByText('Канал підключено')).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/publications$/);
  await expect(
    strip.getByTestId('account-card').filter({ hasText: 'Тестовий канал' }).and(page.locator('[data-status=active]')),
  ).toBeVisible();

  // «Опублікувати…» з історії рендерів
  await page.goto(editorUrl);
  await page.getByTestId('render-publish').first().click();
  const dialog = page.getByTestId('publish-dialog');
  await expect(
    dialog.locator('[data-testid=publish-target][data-platform=youtube] input[type=checkbox]'),
  ).toBeChecked();
  await expect(dialog.locator('[data-testid=publish-target][data-platform=tiktok] input[type=checkbox]')).toBeChecked();
  await expect(dialog.getByTestId('meta-title').first()).not.toHaveValue('', { timeout: 15_000 });
  await expect(dialog.getByTestId('publish-submit')).toBeEnabled();
  await dialog.getByTestId('publish-submit').click();
  await expect(page.getByText(/Створено \d+ публікаці/)).toBeVisible();
  await expect(dialog).toBeHidden();

  // матриця: YouTube — після завантаження й тіку (2 с у api-e2e) «Опубліковано» з посиланням
  await page.goto('/publications');
  const cell = (platform: string) =>
    page.locator(
      `[data-testid=publication-cell][data-project="${projectId}"][data-language=uk][data-platform=${platform}]`,
    );
  await expect(cell('youtube').getByTestId('publication-status')).toHaveText('Опубліковано', { timeout: 60_000 });
  await expect(cell('youtube').getByTestId('publication-link')).toHaveAttribute('href', /youtube\.com|youtu\.be/);
  await expect(cell('tiktok').getByTestId('publication-status')).toHaveText('Чекає на вас');
  await expect(page.getByTestId('pending-badge')).toHaveText('1');

  // чуже посилання — підказка й неактивна кнопка; своє — «Опубліковано», бейдж зникає
  await cell('tiktok').getByTestId('paste-link').click();
  const input = page.getByTestId('paste-link-input');
  await input.fill('https://youtu.be/dQw4w9WgXcQ');
  await expect(page.getByRole('dialog').getByText('Це не посилання на TikTok')).toBeVisible();
  await expect(page.getByTestId('paste-link-submit')).toBeDisabled();
  await input.fill('https://www.tiktok.com/@me/video/7311111111111111111');
  await expect(page.getByRole('dialog').getByText('Це не посилання на TikTok')).toHaveCount(0);
  await page.getByTestId('paste-link-submit').click();
  await expect(cell('tiktok').getByTestId('publication-status')).toHaveText('Опубліковано');
  await expect(cell('tiktok').getByTestId('publication-link')).toHaveAttribute('href', /tiktok\.com/);
  await expect(page.getByTestId('pending-badge')).toHaveCount(0);
});
