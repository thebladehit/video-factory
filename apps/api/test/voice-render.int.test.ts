import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assets, jobs, renders } from '@vf/db';
import type { TimelineDoc, VoiceChoice } from '@vf/shared';
import { docDuration, syncVoiceTrack } from '@vf/timeline';
import { appRouter } from '../src/index';
import { toneMp4Bytes, upload, waitForAsset } from './assets-helpers';
import { startApp } from './helpers';

type Started = Awaited<ReturnType<typeof startApp>>;
const VOICE: VoiceChoice = { model: 'fake/tts', voiceId: 'fake-voice' };
const FRAME = 1 / 30;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const waitJobs = (s: Started, ids: string[]) =>
  waitFor(async () => {
    const rows = await s.deps.db.select().from(jobs).where(inArray(jobs.id, ids));
    return rows.length === ids.length && rows.every((j) => ['done', 'failed', 'cancelled'].includes(j.status)) && rows;
  });

const waitRender = (s: Started, renderId: string) =>
  waitFor(async () => {
    const [a] = await s.deps.db.select().from(assets).where(eq(assets.id, renderId));
    if (a?.status === 'ready') return a;
    const [r] = await s.deps.db.select().from(renders).where(eq(renders.id, renderId));
    if (r?.status === 'failed') throw new Error(`render failed: ${r.error}`);
    return null;
  }, 120_000);

const voiceClips = (doc: TimelineDoc) =>
  doc.tracks.flatMap((t) => (t.kind === 'audio' && t.role === 'voiceover' ? t.clips : []));

/**
 * Відео 4 с з тоном, сегменти s1 [0,2] і s2 [2,4], мови uk (база), en, de.
 * EN: s1 — 3 слова (1,2 с), s2 — 6 слів (2,4 с), субтитри увімкнено. UK: лише s1 — 1 слово (0,4 с).
 */
async function dubbed(s: Started, o: { uk?: boolean } = {}) {
  const video = await upload(s.caller, 'v.mp4', 'video/mp4', await toneMp4Bytes(4));
  await waitForAsset(s.deps, video, ['ready']);
  const { projectId } = await s.caller.voice.createFromAsset({ assetId: video });
  const p = await s.caller.projects.get({ id: projectId });
  const base: TimelineDoc = {
    ...p.timeline,
    segments: [
      { id: 's1', start: 0, end: 2 },
      { id: 's2', start: 2, end: 4 },
    ],
  };
  const { version } = await s.caller.projects.save({ id: projectId, timeline: base, baseVersion: p.version });
  await s.caller.voice.setLanguages({ projectId, base: 'uk', languages: ['uk', 'en', 'de'] });
  await s.caller.voice.setVoice({ projectId, language: 'en', voice: VOICE });
  await s.caller.voice.setCaptions({ projectId, language: 'en', enabled: true, styleId: 'preset:classic' });
  await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'en', text: 'Hello dear friends' });
  await s.caller.voice.setText({ projectId, segmentId: 's2', language: 'en', text: 'One two three four five six' });
  const ids = (await s.caller.voice.synthesize({ projectId, language: 'en' })).jobIds;
  if (o.uk) {
    await s.caller.voice.setVoice({ projectId, language: 'uk', voice: VOICE });
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт' });
    ids.push(...(await s.caller.voice.synthesize({ projectId, language: 'uk' })).jobIds);
  }
  const done = await waitJobs(s, ids);
  expect(done.every((j) => j.status === 'done')).toBe(true);
  return { projectId, version, base, video };
}

/** Ціль сегмента s2 мови en (пакетний дубль): 0,15 + 2,46 + 0,35 с, округлено до кадру */
const EN_S2 = 89 / 30;

describe('voice.localized', () => {
  it('two ready lines → duration = sum of fit targets (+ gaps), voice clips and ASS with the words', async () => {
    const s = await startApp();
    const { projectId } = await dubbed(s);
    const l = await s.caller.voice.localized({ projectId, language: 'en' });
    // en озвучено одним дублем: s1 — 3 слова (1,2 с) + хвіст 0,1 с → ціль 0,15 + 1,3 + 0,35 = 1,8;
    // s2 — вступ 0,06 с + 6 слів (2,4 с) → 0,15 + 2,46 + 0,35 = 2,96 → кадр 89/30
    expect(l.fits.map((f) => f.segmentId)).toEqual(['s1', 's2']);
    expect(l.fits[0]!.target).toBeCloseTo(1.8, 6);
    expect(l.fits[1]!.target).toBeCloseTo(EN_S2, 6);
    // сегменти покривають усе відео — проміжків немає
    expect(docDuration(l.timeline)).toBeCloseTo(1.8 + EN_S2, 6);
    const voice = voiceClips(l.timeline);
    expect(voice).toHaveLength(2);
    // старт = початок сегмента мови + LEAD (0,15 с), округлений до кадру
    expect(Math.abs(voice[0]!.start - 0.15)).toBeLessThanOrEqual(FRAME / 2 + 1e-6);
    expect(Math.abs(voice[1]!.start - (1.8 + 0.15))).toBeLessThanOrEqual(FRAME / 2 + 1e-6);
    for (const c of voice) expect(l.assets[c.assetId]).toMatchObject({ missing: false, kind: 'audio' });
    expect(l.subtitles).toMatch(/\[Events\]/);
    expect(l.subtitles).toMatch(/hello/i);
    expect(l.subtitles).toMatch(/six/i);
    // слова транскриптів для чорнового прев'ю стилю: кожен кліп субтитрів має свої
    const clips = l.timeline.tracks.flatMap((t) => (t.kind === 'captions' ? t.clips : []));
    expect(clips).toHaveLength(2);
    for (const c of clips) expect(l.transcripts[c.transcriptId]?.words.length).toBeGreaterThan(0);
  }, 60_000);

  it('a language without voice-over → the base document, no subtitles', async () => {
    const s = await startApp();
    const { projectId, base } = await dubbed(s);
    const l = await s.caller.voice.localized({ projectId, language: 'de' });
    expect(l.timeline).toEqual((await s.caller.projects.get({ id: projectId })).timeline);
    expect(docDuration(l.timeline)).toBeCloseTo(docDuration(base), 6);
    expect(l.subtitles).toBeNull();
  }, 60_000);

  it('base voice track in the document: base uses it as is; other languages drop it (spec §3.3)', async () => {
    const s = await startApp();
    const { projectId, base, version } = await dubbed(s, { uk: true });
    const { baseTakes } = await s.caller.voice.get({ projectId });
    expect(baseTakes.map((t) => t.segmentId)).toEqual(['s1']);
    const synced = syncVoiceTrack(base, { language: 'uk', takes: baseTakes }).doc;
    // кліп озвучки зсунуто вручну
    const moved: TimelineDoc = {
      ...synced,
      tracks: synced.tracks.map((t) =>
        t.kind === 'audio' && t.role === 'voiceover' ? { ...t, clips: t.clips.map((c) => ({ ...c, start: 1 })) } : t,
      ),
    };
    await s.caller.projects.save({ id: projectId, timeline: moved, baseVersion: version });

    const uk = await s.caller.voice.localized({ projectId, language: 'uk' });
    expect(uk.fits.every((f) => f.speed === 1 && f.hold === 0)).toBe(true);
    expect(voiceClips(uk.timeline).map((c) => [c.assetId, c.start])).toEqual([[baseTakes[0]!.assetId, 1]]);
    const en = await s.caller.voice.localized({ projectId, language: 'en' });
    const enTracks = en.timeline.tracks.filter((t) => t.kind === 'audio' && t.role === 'voiceover');
    expect(enTracks.map((t) => (t.kind === 'audio' ? t.language : null))).toEqual(['en']);
    const de = await s.caller.voice.localized({ projectId, language: 'de' });
    expect(voiceClips(de.timeline)).toEqual([]);
  }, 60_000);

  it('base language: a re-voiced line after the track was saved → the new take with its captions, position kept', async () => {
    const s = await startApp();
    const { projectId, base, version } = await dubbed(s, { uk: true });
    const { baseTakes } = await s.caller.voice.get({ projectId });
    const synced = syncVoiceTrack(base, { language: 'uk', takes: baseTakes }).doc;
    const moved: TimelineDoc = {
      ...synced,
      tracks: synced.tracks.map((t) =>
        t.kind === 'audio' && t.role === 'voiceover' ? { ...t, clips: t.clips.map((c) => ({ ...c, start: 1 })) } : t,
      ),
    };
    await s.caller.projects.save({ id: projectId, timeline: moved, baseVersion: version });
    await s.caller.voice.setCaptions({ projectId, language: 'uk', enabled: true, styleId: 'preset:classic' });
    // переозвучка s1 (новий текст) і новий рядок s2 — після збереження доріжки
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт друзі' });
    await s.caller.voice.setText({ projectId, segmentId: 's2', language: 'uk', text: 'Як справи' });
    // поки s1 застарів (є попередній дубль) — pending: його зсунутий кліп лишається зі старим дублем
    const stale = await s.caller.voice.get({ projectId });
    expect(stale.baseTakes).toEqual([]);
    expect(stale.basePending).toEqual(['s1']);
    const mid = await s.caller.voice.localized({ projectId, language: 'uk' });
    expect(voiceClips(mid.timeline).map((c) => [c.assetId, c.start])).toEqual([[baseTakes[0]!.assetId, 1]]);
    const done = await waitJobs(s, (await s.caller.voice.synthesize({ projectId, language: 'uk' })).jobIds);
    expect(done.every((j) => j.status === 'done')).toBe(true);
    const { baseTakes: fresh } = await s.caller.voice.get({ projectId });
    expect(fresh.map((t) => t.segmentId)).toEqual(['s1', 's2']);
    expect(fresh[0]!.assetId).not.toBe(baseTakes[0]!.assetId);

    const uk = await s.caller.voice.localized({ projectId, language: 'uk' });
    const clips = voiceClips(uk.timeline);
    expect(clips.map((c) => c.assetId)).toEqual(fresh.map((t) => t.assetId));
    expect(clips[0]!.start).toBe(1); // зсув користувача лишається
    const caps = uk.timeline.tracks.flatMap((t) => (t.kind === 'captions' ? t.clips : []));
    expect(caps.map((c) => c.transcriptId).sort()).toEqual(fresh.map((t) => t.transcriptId).sort());
    expect(uk.subtitles).toMatch(/друзі/i);
  }, 90_000);

  it('a language outside the project → VALIDATION; foreign project → NOT_FOUND', async () => {
    const s = await startApp();
    const { projectId } = await dubbed(s);
    await expect(s.caller.voice.localized({ projectId, language: 'fr' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'VALIDATION' }),
    });
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    await expect(stranger.voice.localized({ projectId, language: 'en' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);
});

describe('voice.subtitles', () => {
  it('EN as srt → numbered blocks, the first starts at the first word; vtt has a header', async () => {
    const s = await startApp();
    const { projectId } = await dubbed(s);
    const l = await s.caller.voice.localized({ projectId, language: 'en' });
    const firstVoice = voiceClips(l.timeline)[0]!;
    const view = await s.caller.voice.get({ projectId });
    const firstWordMs = view.lines.s1!.en!.words![0]!.startMs;
    const ms = Math.round((firstVoice.start + firstWordMs / 1000) * 1000);
    const stamp = `00:00:0${Math.floor(ms / 1000)},${String(ms % 1000).padStart(3, '0')}`;

    const srt = await s.caller.voice.subtitles({ projectId, language: 'en', format: 'srt' });
    expect(srt.filename).toMatch(/\(en\)\.srt$/);
    expect(srt.content.startsWith(`1\n${stamp} --> `)).toBe(true);
    expect(srt.content).toMatch(/\n\n2\n\d\d:\d\d:\d\d,\d{3} --> /);
    expect(srt.content).toMatch(/Hello/);

    const vtt = await s.caller.voice.subtitles({ projectId, language: 'en', format: 'vtt' });
    expect(vtt.filename).toMatch(/\.vtt$/);
    expect(vtt.content.startsWith('WEBVTT\n\n')).toBe(true);
  }, 60_000);
});

describe('renders of a language', () => {
  it('a not-ready line → VALIDATION with segmentIds; force starts the render', async () => {
    const s = await startApp();
    const { projectId, version } = await dubbed(s);
    await s.caller.voice.setText({ projectId, segmentId: 's2', language: 'en', text: 'Changed text' });
    const err = await s.caller.renders.start({ projectId, preset: 'draft', version, language: 'en' }).then(
      () => ({ cause: null }),
      (e: unknown) => e as { cause: unknown },
    );
    expect(err.cause).toMatchObject({ code: 'VALIDATION', details: { segmentIds: ['s2'] } });
    const { renderId } = await s.caller.renders.start({
      projectId,
      preset: 'draft',
      version,
      language: 'en',
      force: true,
    });
    const [r] = await s.deps.db.select().from(renders).where(eq(renders.id, renderId));
    // неготовий сегмент — без голосу, темп 1
    expect(voiceClips(r!.timelineSnapshot)).toHaveLength(1);
    expect(docDuration(r!.timelineSnapshot)).toBeCloseTo(1.8 + 2, 6);
  }, 60_000);

  it('the render job of a language → MP4 of the localized duration, language and subtitles stored', async () => {
    const s = await startApp();
    const { projectId, version } = await dubbed(s);
    const l = await s.caller.voice.localized({ projectId, language: 'en' });
    const { renderId } = await s.caller.renders.start({ projectId, preset: 'draft', version, language: 'en' });
    const a = await waitRender(s, renderId);
    expect(Math.abs(a.durationMs! - docDuration(l.timeline) * 1000)).toBeLessThanOrEqual(FRAME * 1000 + 1);
    expect(a.language).toBe('en');
    const [r] = await s.deps.db.select().from(renders).where(eq(renders.id, renderId));
    expect(r).toMatchObject({ language: 'en', status: 'done' });
    expect(r!.subtitles).toMatch(/Dialogue:.*hello/i);
    const list = await s.caller.renders.list({ projectId });
    expect(list[0]).toMatchObject({ id: renderId, language: 'en' });
  }, 150_000);

  it('startAll uk, en → two renders with different durations', async () => {
    const s = await startApp();
    const { projectId } = await dubbed(s, { uk: true });
    const { renderIds } = await s.caller.renders.startAll({ projectId, preset: 'draft', languages: ['uk', 'en'] });
    expect(renderIds).toHaveLength(2);
    const [uk, en] = [await waitRender(s, renderIds[0]!), await waitRender(s, renderIds[1]!)];
    // uk: s1 0,15 + 0,4 + 0,35 = 0,9 (×1,25 обрізає хвіст), s2 без тексту — 2 с; en: 1,8 + 89/30
    expect(Math.abs(uk.durationMs! - 2900)).toBeLessThanOrEqual(FRAME * 1000 + 1);
    expect(Math.abs(en.durationMs! - (1.8 + EN_S2) * 1000)).toBeLessThanOrEqual(FRAME * 1000 + 1);
    const rows = await s.deps.db.select().from(renders).where(inArray(renders.id, renderIds));
    expect(rows.map((r) => r.language).sort()).toEqual(['en', 'uk']);
  }, 240_000);

  it('startAll with a not-ready language → VALIDATION and nothing is started', async () => {
    const s = await startApp();
    const { projectId } = await dubbed(s);
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'de', text: 'Hallo' });
    const err = await s.caller.renders.startAll({ projectId, preset: 'draft', languages: ['en', 'de'] }).then(
      () => ({ cause: null }),
      (e: unknown) => e as { cause: unknown },
    );
    expect(err.cause).toMatchObject({ code: 'VALIDATION', details: { segmentIds: ['s1'] } });
    expect(await s.deps.db.select().from(renders).where(eq(renders.projectId, projectId))).toEqual([]);
  }, 60_000);
});

describe('renders of a language — fixes r1', () => {
  it('base text without a translation → VALIDATION with segmentIds (start and startAll)', async () => {
    const s = await startApp();
    const { projectId, version } = await dubbed(s);
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт' });
    await s.caller.voice.setText({ projectId, segmentId: 's2', language: 'uk', text: 'Як справи' });
    // de: s1 перекладено порожнім текстом, s2 — без рядка взагалі
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'de', text: '' });
    const err = await s.caller.renders.start({ projectId, preset: 'draft', version, language: 'de' }).then(
      () => ({ cause: null }),
      (e: unknown) => e as { cause: unknown },
    );
    expect(err.cause).toMatchObject({ code: 'VALIDATION', details: { segmentIds: ['s1', 's2'] } });
    const all = await s.caller.renders.startAll({ projectId, preset: 'draft', languages: ['en', 'de'] }).then(
      () => ({ cause: null }),
      (e: unknown) => e as { cause: unknown },
    );
    expect(all.cause).toMatchObject({ code: 'VALIDATION', details: { segmentIds: ['s1', 's2'], languages: ['de'] } });
    // EN перекладено й озвучено — базовий текст йому не заважає
    await s.caller.renders.start({ projectId, preset: 'draft', version, language: 'en' });
  }, 60_000);

  it('a stale version → CONFLICT before localize and file checks', async () => {
    const s = await startApp();
    const { projectId, version, video } = await dubbed(s);
    // файл ще «обробляється» — перевірка файлів дала б VALIDATION, але версія перевіряється раніше
    await s.deps.db.update(assets).set({ status: 'processing' }).where(eq(assets.id, video));
    await expect(
      s.caller.renders.start({ projectId, preset: 'draft', version: version - 1, language: 'en' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(s.caller.renders.start({ projectId, preset: 'draft', version, language: 'en' })).rejects.toMatchObject(
      { cause: expect.objectContaining({ code: 'VALIDATION' }) },
    );
  }, 60_000);
});

describe('separated languages', () => {
  it('separate → own document v1 with optimistic saves; renders use it; unseparate returns to localize', async () => {
    const s = await startApp();
    const { projectId, version } = await dubbed(s);
    const localized = await s.caller.voice.localized({ projectId, language: 'en' });

    await s.caller.voice.separate({ projectId, language: 'en' });
    const sep = await s.caller.projects.get({ id: projectId, language: 'en' });
    expect(sep.version).toBe(1);
    expect(docDuration(sep.timeline)).toBeCloseTo(docDuration(localized.timeline), 6);
    expect(voiceClips(sep.timeline)).toHaveLength(2);
    expect(sep.assets[voiceClips(sep.timeline)[0]!.assetId]).toMatchObject({ missing: false });

    // правка відокремленої мови: прибрати другий кліп озвучки й субтитри до нього, вкоротити відео
    const voiceId = voiceClips(sep.timeline)[1]!.id;
    const edited: TimelineDoc = {
      ...sep.timeline,
      tracks: sep.timeline.tracks.map((t) => {
        if (t.kind === 'audio' && t.role === 'voiceover')
          return { ...t, clips: t.clips.filter((c) => c.id !== voiceId) };
        if (t.kind === 'captions') return { ...t, clips: t.clips.filter((c) => c.audioClipId !== voiceId) };
        if (t.kind === 'audio') return { ...t, clips: t.clips.filter((c) => c.start < 1.8) };
        return { ...t, clips: t.clips.filter((c) => c.start < 1.8) };
      }),
    } as TimelineDoc;
    expect(await s.caller.projects.save({ id: projectId, language: 'en', timeline: edited, baseVersion: 1 })).toEqual({
      version: 2,
    });
    await expect(
      s.caller.projects.save({ id: projectId, language: 'en', timeline: edited, baseVersion: 1 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // базовий документ не змінився
    expect((await s.caller.projects.get({ id: projectId })).version).toBe(version);

    const l2 = await s.caller.voice.localized({ projectId, language: 'en' });
    expect(docDuration(l2.timeline)).toBeCloseTo(1.8, 6);
    expect(l2.subtitles).toMatch(/hello/i);
    expect(l2.subtitles).not.toMatch(/six/i);

    // рендер відокремленої мови бере її документ (версія — відокремлена) і ASS з його субтитрів
    await expect(
      s.caller.renders.start({ projectId, preset: 'draft', version: 1, language: 'en' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const { renderId } = await s.caller.renders.start({ projectId, preset: 'draft', version: 2, language: 'en' });
    const [r] = await s.deps.db.select().from(renders).where(eq(renders.id, renderId));
    expect(docDuration(r!.timelineSnapshot)).toBeCloseTo(1.8, 6);
    expect(r!.subtitles).toMatch(/hello/i);
    expect(r!.subtitles).not.toMatch(/six/i);

    await s.caller.voice.unseparate({ projectId, language: 'en' });
    await expect(s.caller.projects.get({ id: projectId, language: 'en' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const l3 = await s.caller.voice.localized({ projectId, language: 'en' });
    expect(docDuration(l3.timeline)).toBeCloseTo(1.8 + EN_S2, 6);
  }, 60_000);

  it('separate twice keeps the existing document; foreign user → NOT_FOUND', async () => {
    const s = await startApp();
    const { projectId } = await dubbed(s);
    await s.caller.voice.separate({ projectId, language: 'en' });
    const sep = await s.caller.projects.get({ id: projectId, language: 'en' });
    await s.caller.projects.save({ id: projectId, language: 'en', timeline: sep.timeline, baseVersion: 1 });
    await s.caller.voice.separate({ projectId, language: 'en' });
    expect((await s.caller.projects.get({ id: projectId, language: 'en' })).version).toBe(2);
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    await expect(stranger.voice.separate({ projectId, language: 'en' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(stranger.voice.unseparate({ projectId, language: 'en' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(stranger.projects.get({ id: projectId, language: 'en' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  }, 60_000);
});

describe('Review Focus 4: a voiced segment deleted, then restored', () => {
  it('localized and render work without the segment; restoring the old document brings the voice back', async () => {
    const s = await startApp();
    const { projectId, version, base } = await dubbed(s);
    const without = { ...base, segments: base.segments!.filter((x) => x.id !== 's2') };
    const v2 = (await s.caller.projects.save({ id: projectId, timeline: without, baseVersion: version })).version;

    const l = await s.caller.voice.localized({ projectId, language: 'en' });
    expect(voiceClips(l.timeline)).toHaveLength(1);
    expect(docDuration(l.timeline)).toBeCloseTo(1.8 + 2, 6);
    const { renderId } = await s.caller.renders.start({ projectId, preset: 'draft', version: v2, language: 'en' });
    const a = await waitRender(s, renderId);
    expect(Math.abs(a.durationMs! - 3800)).toBeLessThanOrEqual(FRAME * 1000 + 1);

    // undo: зберегти старий документ
    await s.caller.projects.save({ id: projectId, timeline: base, baseVersion: v2 });
    const back = await s.caller.voice.localized({ projectId, language: 'en' });
    expect(voiceClips(back.timeline)).toHaveLength(2);
    expect(docDuration(back.timeline)).toBeCloseTo(1.8 + EN_S2, 6);
    expect(back.subtitles).toMatch(/six/i);
  }, 150_000);
});
