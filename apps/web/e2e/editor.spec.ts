import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const TONE = fixture('tone.mp4');
const PNG = fixture('photo.png');
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

/** Перетягування файлу з ОС на таймлайн (як у library.spec — DataTransfer у сторінці). */
async function dropFile(page: Page, file: { name: string; type: string; bytes: Buffer }, atPx = 20) {
  await page.evaluate(
    ({ bytes, name, type, atPx }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
      const tl = document.querySelector('[data-testid=timeline]')!;
      const r = tl.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 112 + atPx,
        clientY: r.top + 60,
        dataTransfer: dt,
      };
      for (const t of ['dragenter', 'dragover', 'drop']) tl.dispatchEvent(new DragEvent(t, init));
    },
    { bytes: [...file.bytes], name: file.name, type: file.type, atPx },
  );
}

/** Файл з панелі бібліотеки під плейхед: спершу дочекатися відфільтрованого списку (клік — за координатами). */
async function addFromPanel(page: Page, name: string) {
  const panel = page.getByTestId('library-panel');
  await panel.getByPlaceholder('Пошук у бібліотеці').fill(name);
  await expect(panel.getByTestId('library-item')).toHaveCount(1);
  const item = panel.getByTestId('library-item').first();
  await item.hover();
  await item.getByRole('button', { name: `Додати «${name}» під плейхед` }).click();
  await expect(page.getByTestId('track-video').locator('[data-clip-id]').first()).toBeVisible();
}

const videoClip = (page: Page) => page.getByTestId('track-video').locator('[data-clip-id]').first();
const duration = async (clip: Locator) => Number(await clip.getAttribute('data-duration'));

async function dragBy(page: Page, handle: Locator, dx: number) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y);
  await page.mouse.up();
}

/** Після debounce автозбереження (1,5 с) — інакше «saved» видно ще до початку збереження. */
const savedState = async (page: Page) => {
  await page.waitForTimeout(1700);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
};

test('new 9:16 project → drop MP4 from OS onto the timeline → video clip and waveform clip appear', async ({
  page,
}) => {
  await newProject(page, `Drop ${uid()}`);
  await dropFile(page, { name: `tone-${uid()}.mp4`, type: 'video/mp4', bytes: TONE });
  await expect(videoClip(page)).toBeVisible();
  // після обробки файлу — зв'язаний звук з хвилею
  const audio = page.getByTestId('track-audio').locator('[data-clip-id]').first();
  await expect(audio).toBeVisible({ timeout: 30_000 });
  await expect(audio.getByTestId('waveform')).toBeVisible();
  expect(await duration(audio)).toBeCloseTo(await duration(videoClip(page)), 3);
});

test('trim, undo/redo, draft render → rendered asset with the trimmed duration in the library', async ({ page }) => {
  test.setTimeout(120_000);
  const title = `render${uid()}`;
  await newProject(page, title);
  await dropFile(page, { name: `tone-${uid()}.mp4`, type: 'video/mp4', bytes: TONE });
  const clip = videoClip(page);
  await expect(page.getByTestId('track-audio').locator('[data-clip-id]')).toHaveCount(1, { timeout: 30_000 });
  const full = await duration(clip);
  expect(full).toBeCloseTo(2, 1);

  // правий край ліворуч на 1 с (60 px/с)
  await dragBy(page, clip.getByTestId('clip-handle-r'), -60);
  const trimmed = await duration(clip);
  expect(trimmed).toBeLessThan(full - 0.5);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(clip).toHaveAttribute('data-duration', String(full));
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(clip).toHaveAttribute('data-duration', String(trimmed));
  await savedState(page);

  await page.getByTestId('render-menu').click();
  await page.getByRole('menuitem', { name: 'Чернетка 720p' }).click();
  const item = page.getByTestId('render-item').first();
  await expect(item).toHaveAttribute('data-status', 'done', { timeout: 90_000 });
  await expect(item.getByRole('link', { name: 'Завантажити' })).toBeVisible();
  await expect(item).not.toContainText('обробка файлу', { timeout: 30_000 });

  await page.goto('/library');
  await page.getByRole('textbox', { name: 'Пошук' }).fill(title);
  const card = page
    .getByTestId('asset-card')
    .filter({ hasText: /\d:\d\d/ })
    .first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const text = await card.innerText();
  const [m, s] = /(\d+):(\d\d)/.exec(text)!.slice(1).map(Number) as [number, number];
  expect(Math.abs(m * 60 + s - trimmed)).toBeLessThanOrEqual(1);
});

test('photo from the library panel gets Ken Burns; changing the end scale in the inspector persists after reload', async ({
  page,
}) => {
  const name = `kb${uid()}`;
  await page.goto('/library');
  await page.getByTestId('file-input').setInputFiles([{ name: `${name}.png`, mimeType: 'image/png', buffer: PNG }]);
  await expect(page.getByTestId('asset-grid').getByRole('button', { name, exact: true })).toBeVisible({
    timeout: 20_000,
  });

  await newProject(page, `Ken Burns ${uid()}`);
  await addFromPanel(page, name);
  const clip = videoClip(page);
  await expect(clip).toHaveAttribute('data-duration', '5');
  await clip.click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector.getByRole('switch', { name: 'Ken Burns' })).toBeChecked();
  await expect(inspector.getByTestId('kb-to-scale')).toHaveValue('1.15');
  await inspector.getByTestId('kb-to-scale').fill('1.5');
  await savedState(page);

  await page.reload();
  await videoClip(page).click();
  await expect(page.getByTestId('inspector').getByTestId('kb-to-scale')).toHaveValue('1.5');
});

test('deleting a used file shows the usage warning and leaves a "файл видалено" placeholder', async ({ page }) => {
  const name = `used${uid()}`;
  const project = `Використання ${uid()}`;
  await page.goto('/library');
  await page.getByTestId('file-input').setInputFiles([{ name: `${name}.png`, mimeType: 'image/png', buffer: PNG }]);
  await expect(page.getByTestId('asset-grid').getByRole('button', { name, exact: true })).toBeVisible({
    timeout: 20_000,
  });

  await newProject(page, project);
  const editorUrl = page.url();
  await addFromPanel(page, name);
  await expect(videoClip(page)).toBeVisible();
  await savedState(page);

  await page.goto('/library');
  await page.getByTestId('asset-grid').getByRole('button', { name, exact: true }).click();
  await page.getByTestId('asset-sheet').getByRole('button', { name: 'Видалити' }).click();
  const warning = page.getByTestId('usage-warning');
  await expect(warning).toContainText('Файл використано в 1 проєкті');
  await expect(warning).toContainText(project);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Видалити' }).click();
  await expect(page.getByTestId('asset-grid').getByRole('button', { name, exact: true })).toHaveCount(0);

  await page.goto(editorUrl);
  await expect(videoClip(page)).toContainText('файл видалено');
  await expect(page.getByTestId('render-menu')).toBeDisabled();
});

test('reopening a project right after editing shows the latest timeline and saves without a conflict', async ({
  page,
}) => {
  await newProject(page, `Reopen ${uid()}`);
  await dropFile(page, { name: `tone-${uid()}.mp4`, type: 'video/mp4', bytes: TONE });
  await expect(page.getByTestId('track-audio').locator('[data-clip-id]')).toHaveCount(1, { timeout: 30_000 });
  await savedState(page);
  const clip = videoClip(page);
  await dragBy(page, clip.getByTestId('clip-handle-r'), -60);
  const trimmed = await duration(clip);
  await savedState(page);

  await page.getByRole('link', { name: 'До проєктів' }).click();
  await expect(page.getByRole('heading', { name: 'Проєкти' })).toBeVisible();
  await page.goBack();
  await expect(videoClip(page)).toHaveAttribute('data-duration', String(trimmed));
  // наступна зміна зберігається без конфлікту
  await dragBy(page, videoClip(page), 60);
  await savedState(page);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('render does not start when the save before it fails', async ({ page }) => {
  await newProject(page, `SaveFail ${uid()}`);
  await dropFile(page, { name: `tone-${uid()}.mp4`, type: 'video/mp4', bytes: TONE });
  await expect(page.getByTestId('track-audio').locator('[data-clip-id]')).toHaveCount(1, { timeout: 30_000 });
  await savedState(page);
  await page.route('**/trpc/projects.save**', (route) => route.fulfill({ status: 500, body: 'down' }));
  await dragBy(page, videoClip(page).getByTestId('clip-handle-r'), -60);
  await page.getByTestId('render-menu').click();
  await page.getByRole('menuitem', { name: 'Чернетка 720p' }).click();
  await expect(page.getByText('Не вдалося зберегти проєкт')).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('render-item')).toHaveCount(0);
});

test('a slider released outside itself still ends its undo step', async ({ page }) => {
  const name = `gest${uid()}`;
  await page.goto('/library');
  await page.getByTestId('file-input').setInputFiles([{ name: `${name}.png`, mimeType: 'image/png', buffer: PNG }]);
  await expect(page.getByTestId('asset-grid').getByRole('button', { name, exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await newProject(page, `Gesture ${uid()}`);
  await addFromPanel(page, name);
  await videoClip(page).click();
  const slider = page.getByTestId('inspector').getByTestId('kb-to-scale');
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width * 0.9, box.y + 300); // відпускаємо далеко від повзунка
  await page.mouse.up();
  const after = await slider.inputValue();
  expect(Number(after)).toBeGreaterThan(1.15);
  // наступна зміна — окремий крок історії: undo прибирає лише її
  await page.getByRole('radio', { name: '16:9' }).click();
  await page.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(page.getByRole('radio', { name: '9:16' })).toHaveAttribute('data-state', 'on');
  await expect(slider).toHaveValue(after);
});
