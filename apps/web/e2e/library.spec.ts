import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const PNG = fixture('photo.png');
const MP4 = fixture('clip.mp4');
// випадкові, а не мітки часу: схожі числа з попередніх прогонів знаходились би trigram-пошуком
const uid = () => Math.random().toString(36).slice(2, 10);

async function uploadViaButton(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId('file-input').setInputFiles(files);
}

const card = (page: Page, title: string) =>
  page.getByTestId('asset-grid').getByRole('button', { name: title, exact: true });

async function search(page: Page, q: string) {
  await page.getByRole('textbox', { name: 'Пошук' }).fill(q);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/library');
});

test('upload via button shows progress and ready cards with a video duration', async ({ page }) => {
  const id = uid();
  await uploadViaButton(page, [
    { name: `фото${id}.png`, mimeType: 'image/png', buffer: PNG },
    { name: `кліп${id}.mp4`, mimeType: 'video/mp4', buffer: MP4 },
  ]);
  await expect(page.getByTestId('upload-panel')).toContainText(`фото${id}.png`);
  await expect(card(page, `фото${id}`)).toBeVisible({ timeout: 20_000 });
  await expect(card(page, `кліп${id}`)).toBeVisible({ timeout: 20_000 });
  await expect(card(page, `кліп${id}`)).toContainText('0:02');
});

test('drop anywhere shows the overlay and uploads', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Налаштування' })).toBeVisible();
  const id = uid();
  const name = `перетягнуте${id}.png`;
  await page.evaluate(
    async ({ bytes, name }) => {
      const file = new File([new Uint8Array(bytes)], name, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt }));
      await new Promise((r) => setTimeout(r, 100));
      if (!document.querySelector('[data-testid=drop-overlay]')) throw new Error('overlay not shown');
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt }));
    },
    { bytes: [...PNG], name },
  );
  await expect(page.getByTestId('upload-panel')).toContainText(name);
  await page.getByRole('navigation').getByRole('link', { name: 'Бібліотека' }).click();
  await expect(card(page, `перетягнуте${id}`)).toBeVisible({ timeout: 20_000 });
});

test('search by tag and by a title with a typo', async ({ page }) => {
  const id = uid();
  await uploadViaButton(page, [{ name: `sunset${id}.png`, mimeType: 'image/png', buffer: PNG }]);
  await card(page, `sunset${id}`).click({ timeout: 20_000 });
  const sheet = page.getByTestId('asset-sheet');
  await sheet.getByPlaceholder('Додати тег і натиснути Enter').fill(`тег${id}`);
  await sheet.getByPlaceholder('Додати тег і натиснути Enter').press('Enter');
  await expect(sheet.getByTestId('asset-tags')).toContainText(`тег${id}`);
  await page.keyboard.press('Escape');

  await search(page, `тег${id}`);
  await expect(page.getByTestId('asset-card')).toHaveCount(1);
  await search(page, `sunst${id}`);
  await expect(card(page, `sunset${id}`)).toBeVisible();
});

test('delete an asset', async ({ page }) => {
  const id = uid();
  await uploadViaButton(page, [{ name: `видалити${id}.png`, mimeType: 'image/png', buffer: PNG }]);
  await card(page, `видалити${id}`).click({ timeout: 20_000 });
  await page.getByTestId('asset-sheet').getByRole('button', { name: 'Видалити' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Видалити' }).click();
  await expect(card(page, `видалити${id}`)).toHaveCount(0);
});

async function generate(page: Page, tab: 'Фото' | 'Відео', prompt: string) {
  await page.getByRole('button', { name: 'Згенерувати' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: tab }).click();
  await dialog.getByLabel('Опис').fill(prompt);
  await expect(dialog.getByRole('combobox', { name: 'Модель' })).toContainText('Fake');
  await dialog.getByRole('button', { name: 'Згенерувати' }).click();
  await expect(dialog).toHaveCount(0);
}

test('generated image appears in progress, then in the grid, and is found by a prompt word', async ({ page }) => {
  const id = uid();
  await generate(page, 'Фото', `космічний кіт ${id}`);
  await expect(page.getByTestId('pending').or(card(page, `космічний кіт ${id}`))).toBeVisible();
  await expect(card(page, `космічний кіт ${id}`)).toBeVisible({ timeout: 20_000 });
  await search(page, `${id}`);
  await expect(page.getByTestId('asset-card')).toHaveCount(1);
});

test('generate a video with the fake provider', async ({ page }) => {
  const id = uid();
  await generate(page, 'Відео', `хвилі океану ${id}`);
  await expect(card(page, `хвилі океану ${id}`)).toBeVisible({ timeout: 30_000 });
  await expect(card(page, `хвилі океану ${id}`)).toContainText('0:02');
});

test('filters by kind and source', async ({ page }) => {
  const id = uid();
  await uploadViaButton(page, [
    { name: `ф${id}.png`, mimeType: 'image/png', buffer: PNG },
    { name: `в${id}.mp4`, mimeType: 'video/mp4', buffer: MP4 },
  ]);
  await expect(card(page, `в${id}`)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('combobox', { name: 'Тип' }).click();
  await page.getByRole('option', { name: 'Відео' }).click();
  await expect(page).toHaveURL(/kind=video/);
  await expect(card(page, `в${id}`)).toBeVisible();
  const kinds = await page.getByTestId('asset-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  expect(kinds.length).toBeGreaterThan(0);
  expect(new Set(kinds)).toEqual(new Set(['video']));

  await page.getByRole('combobox', { name: 'Тип' }).click();
  await page.getByRole('option', { name: 'Тип: усі' }).click();
  await page.getByRole('combobox', { name: 'Джерело' }).click();
  await page.getByRole('option', { name: 'Завантажені' }).click();
  await expect(page).toHaveURL(/source=uploaded/);
  await expect(card(page, `ф${id}`)).toBeVisible();
  const sources = await page
    .getByTestId('asset-card')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-source')));
  expect(new Set(sources)).toEqual(new Set(['uploaded']));
});
