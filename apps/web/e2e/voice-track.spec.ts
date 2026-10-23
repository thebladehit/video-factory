import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// 2 с німе відео: три вставлені абзаци дають три короткі сегменти, fake-озвучка кожного довша за сегмент
const SILENT = readFileSync(new URL('./fixtures/clip.mp4', import.meta.url));
const uid = () => Math.random().toString(36).slice(2, 10);

/** tRPC без transformer: query — GET. */
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
  segments?: { id: string; start: number; end: number }[];
  tracks: {
    kind: string;
    role?: string;
    language?: string;
    removedSegments?: string[];
    clips: { id: string; assetId: string; start: number; duration: number; sceneId?: string }[];
  }[];
}
const voiceTrack = (doc: Doc) => doc.tracks.find((t) => t.kind === 'audio' && t.role === 'voiceover');
const savedDoc = async (page: Page, projectId: string) =>
  (await trpc<{ timeline: Doc }>(page, 'projects.get', { id: projectId })).timeline;

const rows = (page: Page) => page.getByTestId('segment-row');
const voiceClips = (page: Page) => page.locator('[data-testid=track-audio][data-role=voiceover] [data-clip-id]');

async function saved(page: Page) {
  await page.waitForTimeout(1700);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
}

async function allRowsReady(page: Page, count: number) {
  await expect(rows(page)).toHaveCount(count);
  for (let i = 0; i < count; i++)
    await expect(rows(page).nth(i)).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
}

let projectId = '';

test.describe.serial('voice track in the editor', () => {
  test('voiced line appears as clip in edit mode and preview plays voice', async ({ page }) => {
    test.setTimeout(180_000);
    // кожен play() медіаелемента — у журнал (звукові елементи прев'ю не вставляються в DOM)
    await page.addInitScript(() => {
      const w = window as unknown as { __plays: { tag: string; src: string }[] };
      w.__plays = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        w.__plays.push({ tag: this.tagName, src: this.currentSrc || this.src });
        return play.call(this);
      };
    });

    await page.goto('/voice');
    await page.getByTestId('new-voice').click();
    await page
      .getByTestId('voice-file-input')
      .setInputFiles({ name: `vt-${uid()}.mp4`, mimeType: 'video/mp4', buffer: SILENT });
    await expect(page).toHaveURL(/\/voice\/[0-9a-f-]{36}/, { timeout: 60_000 });
    projectId = page.url().split('/voice/')[1]!;
    await page.getByTestId('paste-text-open').click();
    await page.getByTestId('paste-text').fill('Перший абзац тексту.\n\nДругий абзац трохи довший.\n\nІ третій абзац.');
    await page.getByTestId('paste-apply').click();
    await expect(rows(page)).toHaveCount(3, { timeout: 30_000 });
    await page.getByLabel('Модель озвучки').click();
    await page.getByRole('option', { name: /Fake · озвучка/ }).click();
    await expect(page.getByRole('combobox', { name: 'Голос' })).toContainText(/\S/);
    await page.getByTestId('voice-all').click();
    await allRowsReady(page, 3);

    // «Монтаж»: доріжка озвучки з'являється з готових дублів і зберігається
    await page.goto(`/projects/${projectId}`);
    await expect(voiceClips(page)).toHaveCount(3, { timeout: 30_000 });
    await saved(page);
    const doc = await savedDoc(page, projectId);
    const track = voiceTrack(doc)!;
    expect(track.clips.map((c) => c.sceneId).sort()).toEqual(doc.segments!.map((s) => s.id).sort());

    // прев'ю грає саме файл першого дубля
    const first = [...track.clips].sort((a, b) => a.start - b.start)[0]!;
    const assets = await trpc<Record<string, { url: string }>>(page, 'projects.assets', { ids: [first.assetId] });
    const path = new URL(assets[first.assetId]!.url).pathname;
    await page.getByRole('button', { name: 'Відтворити' }).click();
    await expect
      .poll(
        () =>
          page.evaluate(
            (p) =>
              (window as unknown as { __plays: { tag: string; src: string }[] }).__plays.some(
                (x) => x.tag === 'AUDIO' && x.src && new URL(x.src).pathname === p,
              ),
            path,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test('deleted voice clip stays deleted after re-synthesis', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/projects/${projectId}`);
    await expect(voiceClips(page)).toHaveCount(3, { timeout: 30_000 });
    const before = voiceTrack(await savedDoc(page, projectId))!;
    const first = [...before.clips].sort((a, b) => a.start - b.start)[0]!;

    await page.locator(`[data-clip-id="${first.id}"]`).click();
    await page.keyboard.press('Delete');
    await expect(voiceClips(page)).toHaveCount(2);
    await saved(page);
    expect(voiceTrack(await savedDoc(page, projectId))!.removedSegments).toEqual([first.sceneId]);

    // новий текст рядка в студії → переозвучити → новий дубль, але кліп не повертається
    await page.goto(`/voice/${projectId}`);
    await allRowsReady(page, 3);
    const box = page.getByLabel('Текст UK, сегмент 1');
    await box.fill('Перший абзац тексту, змінений.');
    await box.blur();
    await expect(rows(page).first()).not.toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await rows(page).first().getByRole('button', { name: 'Переозвучити' }).click();
    await allRowsReady(page, 3);
    const view = await trpc<{ baseTakes: { segmentId: string; assetId: string }[] }>(page, 'voice.get', { projectId });
    expect(view.baseTakes.find((t) => t.segmentId === first.sceneId)?.assetId).not.toBe(first.assetId);

    await page.goto(`/projects/${projectId}`);
    await expect(voiceClips(page)).toHaveCount(2, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    await expect(voiceClips(page)).toHaveCount(2);
    const after = voiceTrack(await savedDoc(page, projectId))!;
    expect(after.clips.some((c) => c.sceneId === first.sceneId)).toBe(false);
    expect(after.removedSegments).toEqual([first.sceneId]);
  });

  test('restore voice from segment menu brings it back', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await expect(voiceClips(page)).toHaveCount(2, { timeout: 30_000 });
    const removed = voiceTrack(await savedDoc(page, projectId))!.removedSegments![0]!;
    const seg = page.locator(`[data-testid=strip-segment][data-id="${removed}"]`);
    await expect(seg).toHaveAttribute('data-voice-removed', 'true');
    // для сегмента з озвучкою пункту немає
    await page
      .locator('[data-testid=strip-segment]:not([data-voice-removed])')
      .first()
      .click({ position: { x: 4, y: 20 } });
    await expect(page.getByTestId('restore-voice')).toHaveCount(0);

    await seg.click({ position: { x: 4, y: 20 } });
    await page.getByTestId('restore-voice').click();
    await expect(voiceClips(page)).toHaveCount(3);
    await expect(page.getByTestId('restore-voice')).toHaveCount(0);
    await saved(page);
    const track = voiceTrack(await savedDoc(page, projectId))!;
    expect(track.removedSegments).toBeUndefined();
    expect(track.clips.some((c) => c.sceneId === removed)).toBe(true);
  });

  test('overflowing clip has warning title «Озвучка довша за сцену на»', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await expect(voiceClips(page)).toHaveCount(3, { timeout: 30_000 });
    const doc = await savedDoc(page, projectId);
    const ends = new Map(doc.segments!.map((s) => [s.id, s.end]));
    const over = voiceTrack(doc)!.clips.filter((c) => c.start + c.duration - ends.get(c.sceneId!)! > 1 / 60);
    expect(over.length).toBeGreaterThan(0);
    for (const c of voiceTrack(doc)!.clips) {
      const clip = page.locator(`[data-clip-id="${c.id}"]`);
      if (over.includes(c)) {
        const sec = c.start + c.duration - ends.get(c.sceneId!)!;
        await expect(clip).toHaveAttribute('title', /^Озвучка довша за сцену на \d+,\d с$/);
        const shown = Number((await clip.getAttribute('title'))!.match(/(\d+,\d)/)![1]!.replace(',', '.'));
        expect(shown).toBeGreaterThanOrEqual(sec - 1e-6);
        expect(shown).toBeLessThan(sec + 0.1 + 1e-6);
        await expect(clip.getByTestId('clip-overflow')).toBeVisible();
      } else {
        await expect(clip).not.toHaveAttribute('title', /.+/);
      }
    }
  });
});
