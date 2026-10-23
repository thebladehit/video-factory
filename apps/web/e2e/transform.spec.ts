import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

const PNG = readFileSync(new URL('./fixtures/photo.png', import.meta.url));
const uid = () => Math.random().toString(36).slice(2, 10);

async function photoProject(page: Page) {
  const name = `tr${uid()}`;
  await page.goto('/library');
  await page.getByTestId('file-input').setInputFiles([{ name: `${name}.png`, mimeType: 'image/png', buffer: PNG }]);
  await expect(page.getByTestId('asset-grid').getByRole('button', { name, exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Новий проєкт' }).click();
  await page.getByLabel('Назва').fill(`Transform ${uid()}`);
  await page.getByRole('radio', { name: '9:16' }).click();
  await page.getByRole('button', { name: 'Створити' }).click();
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('timeline')).toBeVisible();

  const panel = page.getByTestId('library-panel');
  await panel.getByPlaceholder('Пошук у бібліотеці').fill(name);
  const label = `Додати «${name}» під плейхед`;
  const item = panel.getByTestId('library-item').filter({ has: page.getByRole('button', { name: label }) });
  await expect(item).toHaveCount(1);
  await item.hover();
  await item.getByRole('button', { name: label }).click();
  const clip = page.getByTestId('track-video').locator('[data-clip-id]').first();
  await expect(clip).toBeVisible();
  await clip.click();
  await expect(page.getByTestId('transform-box')).toBeVisible();
}

async function dragBy(page: Page, handle: Locator, dx: number, dy = 0) {
  const b = (await handle.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y + (dy * i) / 5);
  await page.mouse.up();
}

const field = (page: Page, id: string) => page.getByTestId('inspector').getByTestId(id);

test('drag box moves image and inspector shows new X/Y', async ({ page }) => {
  await photoProject(page);
  await expect(field(page, 'transform-x')).toHaveValue('50');
  await dragBy(page, page.getByTestId('transform-box'), 100);
  expect(Number(await field(page, 'transform-x').inputValue())).toBeGreaterThan(50);
});

test('corner drag changes size', async ({ page }) => {
  await photoProject(page);
  await expect(field(page, 'transform-scale')).toHaveValue('100');
  await dragBy(page, page.getByTestId('transform-handle-se'), 40, 40);
  expect(Number(await field(page, 'transform-scale').inputValue())).toBeGreaterThan(100);
});

test('values survive reload', async ({ page }) => {
  await photoProject(page);
  await field(page, 'transform-x').fill('30');
  await field(page, 'transform-y').fill('70');
  await field(page, 'transform-scale').fill('150');
  await page.waitForTimeout(1700);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
  await page.reload();
  await page.getByTestId('track-video').locator('[data-clip-id]').first().click();
  await expect(field(page, 'transform-x')).toHaveValue('30');
  await expect(field(page, 'transform-y')).toHaveValue('70');
  await expect(field(page, 'transform-scale')).toHaveValue('150');
});

test('no box while playing', async ({ page }) => {
  await photoProject(page);
  await page.getByRole('button', { name: 'Відтворити' }).click();
  await expect(page.getByTestId('transform-box')).toHaveCount(0);
  await page.getByRole('button', { name: 'Пауза' }).click();
  await expect(page.getByTestId('transform-box')).toBeVisible();
});

test('reset removes transform', async ({ page }) => {
  await photoProject(page);
  await field(page, 'transform-x').fill('20');
  await field(page, 'transform-scale').fill('200');
  await field(page, 'transform-reset').click();
  await expect(field(page, 'transform-scale')).toHaveValue('100');
  await expect(field(page, 'transform-x')).toHaveValue('50');
  await expect(field(page, 'transform-y')).toHaveValue('50');
});

test('play pressed mid-drag ends the gesture: the move is one undoable step', async ({ page }) => {
  await photoProject(page);
  const box = page.getByTestId('transform-box');
  const b = (await box.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + 20 * i, y);
  // пробіл посеред жесту — рамка зникає, pointerup уже нікому не прийде
  await page.keyboard.press('Space');
  await expect(box).toHaveCount(0);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Пауза' }).click();
  await expect(box).toBeVisible();
  const moved = Number(await field(page, 'transform-x').inputValue());
  expect(moved).toBeGreaterThan(50);
  // історія не на паузі: скасування повертає позицію до жесту
  await page.getByRole('button', { name: 'Скасувати' }).click();
  await expect(field(page, 'transform-x')).toHaveValue('50');
});
