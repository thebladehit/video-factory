import { expect, test, type Locator, type Page } from '@playwright/test';

const uid = () => Math.random().toString(36).slice(2, 10);

async function newProject(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новий проєкт' }).click();
  await page.getByLabel('Назва').fill(title);
  await page.getByRole('radio', { name: '9:16' }).click();
  await page.getByRole('button', { name: 'Створити' }).click();
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('timeline')).toBeVisible();
}

async function dragBy(page: Page, handle: Locator, dx: number, dy = 0) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
  await page.mouse.up();
}

const width = async (l: Locator) => (await l.boundingBox())!.width;
const height = async (l: Locator) => (await l.boundingBox())!.height;

test('dragging library handle changes its width and it survives reload', async ({ page }) => {
  await newProject(page, `Panels ${uid()}`);
  const lib = page.getByTestId('panel-library');
  const before = await width(lib);
  await dragBy(page, page.getByTestId('handle-library'), 80);
  await expect.poll(() => width(lib)).toBeGreaterThan(before + 50);
  const after = await width(lib);
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect.poll(() => width(page.getByTestId('panel-library'))).toBeGreaterThan(before + 50);
  expect(Math.abs((await width(page.getByTestId('panel-library'))) - after)).toBeLessThan(6);
});

test('dragging timeline handle changes timeline height', async ({ page }) => {
  await newProject(page, `Panels ${uid()}`);
  const tl = page.getByTestId('timeline');
  const before = await height(tl);
  await dragBy(page, page.getByTestId('handle-timeline'), 0, -60);
  await expect.poll(() => height(tl)).toBeGreaterThan(before + 40);
});

test('double click on handle restores default width', async ({ page }) => {
  await newProject(page, `Panels ${uid()}`);
  const lib = page.getByTestId('panel-library');
  const initial = await width(lib);
  await dragBy(page, page.getByTestId('handle-library'), 60);
  await expect.poll(() => width(lib)).toBeGreaterThan(initial + 40);
  await page.getByTestId('handle-library').dblclick();
  await expect.poll(async () => Math.abs((await width(lib)) - initial)).toBeLessThan(4);
});

test('library collapses when dragged to the edge and expands back', async ({ page }) => {
  await newProject(page, `Panels ${uid()}`);
  const lib = page.getByTestId('panel-library');
  const initial = await width(lib);
  await dragBy(page, page.getByTestId('handle-library'), -initial - 40);
  await expect.poll(() => width(lib)).toBeLessThan(10);
  await dragBy(page, page.getByTestId('handle-library'), 200);
  await expect.poll(() => width(lib)).toBeGreaterThan(150);
});

test('a corrupt saved layout does not break the editor', async ({ page }) => {
  await newProject(page, `Panels ${uid()}`);
  await dragBy(page, page.getByTestId('handle-library'), 80);
  await page.waitForTimeout(300);
  const keys = await page.evaluate(() => {
    const ks = Object.keys(localStorage).filter((k) => k.startsWith('react-resizable-panels:'));
    for (const k of ks) localStorage.setItem(k, '{corrupt');
    return ks;
  });
  expect(keys.length).toBeGreaterThan(0);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.reload();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('panel-library')).toBeVisible();
  expect(errors).toEqual([]);
});
