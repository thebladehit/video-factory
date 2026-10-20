import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/settings');
});

test('shows infrastructure health', async ({ page }) => {
  await expect(page.getByText('База даних: працює')).toBeVisible();
  await expect(page.getByText('Сховище: працює')).toBeVisible();
});

test('sidebar lists all sections and placeholders name their sub-project', async ({ page }) => {
  const nav = page.getByRole('navigation');
  for (const name of ['Проєкти', 'Бібліотека', 'Студія озвучки', 'Публікації', 'Статистика', 'Налаштування']) {
    await expect(nav.getByRole('link', { name })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Бібліотека' }).click();
  await expect(page.getByRole('heading', { name: 'Бібліотека' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Пошук' })).toBeVisible();
});

test('default text model persists across reloads', async ({ page }) => {
  await page.getByRole('combobox', { name: 'Текст' }).click();
  await page.getByRole('option', { name: 'Fake · текст' }).click();
  await expect(page.getByRole('combobox', { name: 'Текст' })).toContainText('Fake · текст');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Текст' })).toContainText('Fake · текст');
});

test('testing the text model shows its answer', async ({ page }) => {
  await page.getByRole('combobox', { name: 'Текст' }).click();
  await page.getByRole('option', { name: 'Fake · текст' }).click();
  await page.getByRole('button', { name: 'Перевірити' }).click();
  await expect(page.getByTestId('test-model-result')).toContainText('[fake]');
});

test('debug job shows live progress until done', async ({ page }) => {
  const card = page.getByTestId('debug-job');
  await card.getByLabel('Тривалість, с').fill('3');
  await card.getByLabel('Кроків').fill('5');
  await card.getByRole('button', { name: 'Запустити' }).click();
  await expect(card.getByText(/Крок \d\/5/)).toBeVisible();
  await expect(card.getByText('Готово')).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText('100%')).toBeVisible();
});

test('debug job can be cancelled and retried', async ({ page }) => {
  const card = page.getByTestId('debug-job');
  await card.getByLabel('Тривалість, с').fill('10');
  await card.getByRole('button', { name: 'Запустити' }).click();
  await expect(card.getByText('Виконується')).toBeVisible();
  await card.getByRole('button', { name: 'Скасувати' }).click();
  await expect(card.getByText('Скасовано')).toBeVisible();
  await card.getByRole('button', { name: 'Повторити' }).click();
  await expect(card.getByText('Виконується')).toBeVisible();
  await card.getByRole('button', { name: 'Скасувати' }).click();
});

test('channel style persists', async ({ page }) => {
  const text = `Стиль ${Date.now()}`;
  await page.getByLabel('Стиль каналу').fill(text);
  await page.getByRole('button', { name: 'Зберегти' }).click();
  await expect(page.getByText('Збережено')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Стиль каналу')).toHaveValue(text);
});
