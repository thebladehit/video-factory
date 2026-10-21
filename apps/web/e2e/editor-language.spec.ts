import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

const TONE = readFileSync(new URL('./fixtures/tone.mp4', import.meta.url));
const SHOTS =
  '/private/tmp/claude-501/-Users-boosted-projects-video-creator-web/54632240-2cfc-4f42-a1fc-d6e3c29fdfa2/scratchpad';
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

async function dropFile(page: Page, file: { name: string; type: string; bytes: Buffer }) {
  await page.evaluate(
    ({ bytes, name, type }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
      const tl = document.querySelector('[data-testid=timeline]')!;
      const r = tl.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, clientX: r.left + 132, clientY: r.top + 60, dataTransfer: dt };
      for (const t of ['dragenter', 'dragover', 'drop']) tl.dispatchEvent(new DragEvent(t, init));
    },
    { bytes: [...file.bytes], name: file.name, type: file.type },
  );
}

const videoClip = (page: Page) => page.getByTestId('track-video').locator('[data-clip-id]').first();
const duration = async (clip: Locator) => Number(await clip.getAttribute('data-duration'));
const savedState = async (page: Page) => {
  await page.waitForTimeout(1700);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
};

async function dragBy(page: Page, handle: Locator, dx: number) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y);
  await page.mouse.up();
}

/** tRPC без транспорту-обгортки (немає transformer): query — GET, mutation — POST. */
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

test('language view is read-only, separated language is its own document, base edits never leak into it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await newProject(page, `Lang ${uid()}`);
  await dropFile(page, { name: `tone-${uid()}.mp4`, type: 'video/mp4', bytes: TONE });
  await expect(page.getByTestId('track-audio').locator('[data-clip-id]')).toHaveCount(1, { timeout: 30_000 });
  const projectId = page.url().split('/projects/')[1]!;
  await savedState(page);

  // сегмент (як після «Вставити текст» у студії), мови UK + EN
  const fresh = await trpc<{ timeline: Record<string, unknown>; version: number }>(page, 'projects.get', {
    id: projectId,
  });
  await trpc(
    page,
    'projects.save',
    {
      id: projectId,
      baseVersion: fresh.version,
      timeline: { ...fresh.timeline, segments: [{ id: 'seg-1', start: 0, end: 1 }] },
    },
    'mutation',
  );
  await trpc(page, 'voice.setLanguages', { projectId, base: 'uk', languages: ['uk', 'en'] }, 'mutation');
  await page.reload();
  await expect(page.getByTestId('mode-switch')).toBeVisible();
  await expect(page.getByTestId('editor-segment-strip')).toBeVisible();
  await expect(page.getByTestId('strip-segment')).toHaveCount(1);
  await page.getByTestId('strip-segment').click(); // плейхед усередину сегмента
  await page.getByTestId('split-segment').click();
  await expect(page.getByTestId('strip-segment')).toHaveCount(2);
  await savedState(page);
  await page.screenshot({ path: `${SHOTS}/t16-edit-mode.png` });

  const full = await duration(videoClip(page));

  // перегляд EN: банер, без смуги сегментів, зміни ігноруються й не зберігаються
  const saves: string[] = [];
  page.on('request', (r) => r.url().includes('projects.save') && saves.push(r.url()));
  await page.getByTestId('mode-en').click();
  await expect(page.getByTestId('language-banner')).toContainText('Перегляд мови EN');
  await expect(page.getByTestId('editor-segment-strip')).toHaveCount(0);
  await dragBy(page, videoClip(page).getByTestId('clip-handle-r'), -60);
  expect(await duration(videoClip(page))).toBe(full);
  await page.waitForTimeout(1800);
  expect(saves).toHaveLength(0);
  await page.screenshot({ path: `${SHOTS}/t16-language-view.png` });

  // відокремити: тепер редагується й зберігається у власний документ
  await page.getByTestId('separate').click();
  await expect(page.getByTestId('language-banner')).toContainText('відокремлена');
  await expect(page.getByTestId('mode-en')).toContainText('(відокремлена)');
  await dragBy(page, videoClip(page).getByTestId('clip-handle-r'), -60);
  const trimmed = await duration(videoClip(page));
  expect(trimmed).toBeLessThan(full - 0.5);
  await savedState(page);
  expect(saves.length).toBeGreaterThan(0);
  const enDoc = await trpc<{ timeline: { tracks: { kind: string; clips: { duration: number }[] }[] } }>(
    page,
    'projects.get',
    {
      id: projectId,
      language: 'en',
    },
  );
  const enVideo = enDoc.timeline.tracks.find((t) => t.kind === 'video')!.clips[0]!.duration;
  expect(enVideo).toBeCloseTo(trimmed, 3);
  await page.screenshot({ path: `${SHOTS}/t16-separated.png` });

  // «Монтаж» не зачеплений; правка Монтажу не потрапляє в мовний документ
  await page.getByTestId('mode-edit').click();
  await expect(page.getByTestId('editor-segment-strip')).toBeVisible();
  expect(await duration(videoClip(page))).toBeCloseTo(full, 3);
  await dragBy(page, videoClip(page).getByTestId('clip-handle-r'), -30);
  const baseTrimmed = await duration(videoClip(page));
  await savedState(page);
  const enAfter = await trpc<{ timeline: { tracks: { kind: string; clips: { duration: number }[] }[] } }>(
    page,
    'projects.get',
    {
      id: projectId,
      language: 'en',
    },
  );
  expect(enAfter.timeline.tracks.find((t) => t.kind === 'video')!.clips[0]!.duration).toBeCloseTo(trimmed, 3);
  const baseDoc = await trpc<{ timeline: { tracks: { kind: string; clips: { duration: number }[] }[] } }>(
    page,
    'projects.get',
    {
      id: projectId,
    },
  );
  expect(baseDoc.timeline.tracks.find((t) => t.kind === 'video')!.clips[0]!.duration).toBeCloseTo(baseTrimmed, 3);

  // рендер мови з меню
  await page.getByTestId('render-menu').click();
  await page.getByTestId('render-en-draft').click();
  await expect(page.getByText('EN: Чернетка 720p — у черзі')).toBeVisible();

  // повернути до спільного — з підтвердженням
  await page.getByTestId('mode-en').click();
  await page.getByTestId('unseparate').click();
  await page.getByTestId('unseparate-ok').click();
  await expect(page.getByTestId('language-banner')).toContainText('Перегляд мови EN');
  await expect(page.getByTestId('mode-en')).not.toContainText('відокремлена');
  await page.screenshot({ path: `${SHOTS}/t16-unseparated.png` });
});
