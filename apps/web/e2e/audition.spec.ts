import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/settings');
  await page.getByTestId('default-voice-en').getByRole('button', { name: 'Порівняти голоси' }).click();
  await expect(page.getByTestId('audition-dialog')).toBeVisible();
});

test('estimate shown before start', async ({ page }) => {
  const dialog = page.getByTestId('audition-dialog');
  await expect(dialog.getByTestId('audition-estimate')).toContainText('Оцінка');
  await expect(dialog.getByTestId('audition-estimate')).toContainText('$');
  await expect(dialog.getByTestId('audition-take')).toHaveCount(0);
});

test('dialog generates 2 takes per checked candidate', async ({ page }) => {
  const dialog = page.getByTestId('audition-dialog');
  const candidates = await dialog.getByTestId('audition-candidate').count();
  expect(candidates).toBeGreaterThan(0);
  await dialog.getByRole('button', { name: 'Згенерувати' }).click();
  await expect(dialog.locator('[data-testid=audition-take][data-state=ready]')).toHaveCount(candidates * 2, {
    timeout: 60_000,
  });
});

test('make default saves model, voice and instructions', async ({ page }) => {
  const dialog = page.getByTestId('audition-dialog');
  await dialog.getByLabel('Інструкції стилю (необов’язково)').fill('Тепло й повільно');
  await dialog.getByRole('button', { name: 'Згенерувати' }).click();
  await expect(dialog.locator('[data-testid=audition-take][data-state=ready]').first()).toBeVisible({
    timeout: 30_000,
  });
  const first = dialog.getByTestId('audition-candidate').first();
  const voiceId = (await first.getAttribute('data-voice'))!;
  const [modelLabel] = (await first.locator('label').innerText()).split(' · ');
  await first.getByRole('button', { name: 'Зробити типовим' }).click();
  await expect(page.getByTestId('audition-dialog')).toHaveCount(0);
  const row = page.getByTestId('default-voice-en');
  await expect(row.getByRole('combobox', { name: 'Модель озвучки' })).toContainText(modelLabel!);
  await expect(row.getByRole('combobox', { name: 'Голос' })).toContainText(voiceId);
  const res = await page.request.get(`${new URL(page.url()).origin}/trpc/settings.get`.replace(':5174', ':3101'));
  expect(JSON.stringify(await res.json())).toContain('Тепло й повільно');
});
