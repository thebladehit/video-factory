import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  createAiRegistry,
  createEnvCredentialStore,
  type AiRegistry,
  type CatalogItem,
  type STT,
  type TextGen,
  type TTS,
} from '@vf/ai';
import { PRESETS } from '@vf/captions';
import { assets, generations, jobs, projects, transcripts, userSettings, voiceLines } from '@vf/db';
import { RESTART_ERROR } from '@vf/jobs';
import { LOCAL_USER_ID, type VoiceChoice } from '@vf/shared';
import { appRouter } from '../src/index';
import { textHash, voicedHash } from '../src/modules/voice/stale';
import { releaseCancelledLines, synthesizeJob } from '../src/modules/voice/synthesize-job';
import { chunkRanges, languageCode, sanitizeSegments, stitchParts } from '../src/modules/voice/transcribe-job';
import { tools, toneMp4Bytes, upload, waitForAsset } from './assets-helpers';
import { startApp } from './helpers';

type Started = Awaited<ReturnType<typeof startApp>>;
const VOICE: VoiceChoice = { model: 'fake/tts', voiceId: 'fake-voice' };

async function insertAsset(s: Started, patch: Partial<typeof assets.$inferInsert> = {}) {
  const id = randomUUID();
  await s.deps.db.insert(assets).values({
    id,
    userId: LOCAL_USER_ID,
    kind: 'video',
    source: 'uploaded',
    status: 'ready',
    storageKey: `test/${id}`,
    mime: 'video/mp4',
    width: 1920,
    height: 1080,
    durationMs: 4000,
    hasAudio: true,
    title: 'Інтерв’ю',
    ...patch,
  });
  return id;
}

/** Проєкт із сегментами s1 [0,2] і s2 [2,4], мови uk (база) + en. */
async function voiceProject(s: Started, languages = ['uk', 'en']) {
  const { id } = await s.caller.projects.create({ title: 'Озвучка', format: '16:9' });
  const p = await s.caller.projects.get({ id });
  await s.caller.projects.save({
    id,
    baseVersion: p.version,
    timeline: {
      ...p.timeline,
      segments: [
        { id: 's1', start: 0, end: 2 },
        { id: 's2', start: 2, end: 4 },
      ],
    },
  });
  await s.caller.voice.setLanguages({ projectId: id, base: 'uk', languages });
  return id;
}

async function readyLine(
  s: Started,
  projectId: string,
  o: { segmentId: string; language: string; text: string; voice?: VoiceChoice } & Partial<
    typeof voiceLines.$inferInsert
  >,
) {
  const { segmentId, language, text, voice = VOICE, ...rest } = o;
  const audio = await insertAsset(s, { kind: 'audio', mime: 'audio/wav', width: null, height: null });
  await s.deps.db.insert(voiceLines).values({
    userId: LOCAL_USER_ID,
    projectId,
    segmentId,
    language,
    text,
    voice,
    voicedHash: voicedHash(text, voice),
    audioAssetId: audio,
    durationMs: 2000,
    status: 'ready',
    ...rest,
  });
  return audio;
}

describe('voice.createFromAsset', () => {
  it('landscape video with sound → 16:9, one clip and a linked "original" track', async () => {
    const s = await startApp();
    const assetId = await insertAsset(s);
    const { projectId } = await s.caller.voice.createFromAsset({ assetId });
    const p = await s.caller.projects.get({ id: projectId });
    expect(p).toMatchObject({ title: 'Інтерв’ю — озвучка', format: '16:9' });
    expect([p.timeline.width, p.timeline.height]).toEqual([1920, 1080]);
    const video = p.timeline.tracks.find((t) => t.kind === 'video')!;
    const orig = p.timeline.tracks.find((t) => t.kind === 'audio' && t.role === 'original')!;
    expect(video.clips).toHaveLength(1);
    expect(video.clips[0]).toMatchObject({ assetId, start: 0, duration: 4, fit: 'cover' });
    expect(orig.clips).toHaveLength(1);
    const link = (c: unknown) => (c as { linkId?: string }).linkId;
    expect(link(orig.clips[0])).toBe(link(video.clips[0]));
    expect(link(orig.clips[0])).toBeTruthy();
    const [row] = await s.deps.db.select().from(projects).where(eq(projects.id, projectId));
    expect(row!.assetIds).toEqual([assetId]);
  });

  it('video without sound has no original track', async () => {
    const s = await startApp();
    const assetId = await insertAsset(s, { hasAudio: false });
    const { projectId } = await s.caller.voice.createFromAsset({ assetId });
    const p = await s.caller.projects.get({ id: projectId });
    expect(p.timeline.tracks.map((t) => t.kind)).toEqual(['video']);
  });

  it('vertical video → 9:16', async () => {
    const s = await startApp();
    const assetId = await insertAsset(s, { width: 1080, height: 1920 });
    const { projectId } = await s.caller.voice.createFromAsset({ assetId });
    expect(await s.caller.projects.get({ id: projectId })).toMatchObject({ format: '9:16' });
  });

  it('square video → 9:16 with fit "contain"', async () => {
    const s = await startApp();
    const assetId = await insertAsset(s, { width: 1000, height: 1000 });
    const { projectId } = await s.caller.voice.createFromAsset({ assetId });
    const p = await s.caller.projects.get({ id: projectId });
    expect(p.format).toBe('9:16');
    expect(p.timeline.tracks.find((t) => t.kind === 'video')!.clips[0]).toMatchObject({ fit: 'contain' });
  });

  it('not-ready or non-video asset → VALIDATION; foreign or unknown → NOT_FOUND', async () => {
    const s = await startApp();
    const processing = await insertAsset(s, { status: 'processing' });
    const image = await insertAsset(s, { kind: 'image', mime: 'image/png' });
    await expect(s.caller.voice.createFromAsset({ assetId: processing })).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });
    await expect(s.caller.voice.createFromAsset({ assetId: image })).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });
    const ready = await insertAsset(s);
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    await expect(stranger.voice.createFromAsset({ assetId: ready })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.caller.voice.createFromAsset({ assetId: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('voice texts and staleness', () => {
  it('setText upserts a manual line that getVoice shows', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт' });
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт усім' });
    const v = await s.caller.voice.get({ projectId });
    expect(v.lines.s1!.uk).toMatchObject({ text: 'Привіт усім', origin: 'manual', state: 'empty' });
    expect(v.lines.s2).toBeUndefined();
    expect(v).toMatchObject({ base: 'uk', languages: ['uk', 'en'], version: 2 });
    expect(v.segments).toHaveLength(2);
  });

  it('setText validates length, language and segment', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await expect(
      s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'я'.repeat(1501) }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'я'.repeat(1500) });
    await expect(
      s.caller.voice.setText({ projectId, segmentId: 's1', language: 'xx', text: 'a' }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    await expect(
      s.caller.voice.setText({ projectId, segmentId: 'nope', language: 'uk', text: 'a' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('changing the text of a ready line makes it stale', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setVoice({ projectId, language: 'uk', voice: VOICE });
    await readyLine(s, projectId, { segmentId: 's1', language: 'uk', text: 'Привіт' });
    const before = (await s.caller.voice.get({ projectId })).lines.s1!.uk!;
    expect(before).toMatchObject({ state: 'ready', durationMs: 2000 });
    expect(before.audioUrl).toMatch(/^http/);

    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт, світе' });
    expect((await s.caller.voice.get({ projectId })).lines.s1!.uk!.state).toBe('stale');
  });

  it('changing the voice makes ready lines stale', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setVoice({ projectId, language: 'uk', voice: VOICE });
    await readyLine(s, projectId, { segmentId: 's1', language: 'uk', text: 'Привіт' });
    await s.caller.voice.setVoice({
      projectId,
      language: 'uk',
      voice: { ...VOICE, instructions: 'Говори повільно' },
    });
    expect((await s.caller.voice.get({ projectId })).lines.s1!.uk!.state).toBe('stale');
  });

  it('changing the base text after translation makes the translated line stale', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setVoice({ projectId, language: 'en', voice: VOICE });
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт' });
    await readyLine(s, projectId, {
      segmentId: 's1',
      language: 'en',
      text: 'Hello',
      textOrigin: 'translated',
      sourceHash: textHash('Привіт'),
    });
    expect((await s.caller.voice.get({ projectId })).lines.s1!.en!.state).toBe('ready');

    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Вітаю' });
    expect((await s.caller.voice.get({ projectId })).lines.s1!.en!.state).toBe('stale');
  });

  it('lines of segments missing from the document are ignored', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.deps.db
      .insert(voiceLines)
      .values({ userId: LOCAL_USER_ID, projectId, segmentId: 'gone', language: 'uk', text: 'привид' });
    const v = await s.caller.voice.get({ projectId });
    expect(v.lines.gone).toBeUndefined();
    expect(v.estimate.uk!.chars).toBe(0);
  });

  it('deleted voice-over asset → line "empty" with audioDeleted', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setVoice({ projectId, language: 'uk', voice: VOICE });
    const audio = await readyLine(s, projectId, { segmentId: 's1', language: 'uk', text: 'Привіт' });
    await s.deps.db.delete(assets).where(eq(assets.id, audio));
    const line = (await s.caller.voice.get({ projectId })).lines.s1!.uk!;
    expect(line).toMatchObject({ state: 'empty', audioDeleted: true, text: 'Привіт' });
    expect(line.audioUrl).toBeUndefined();
  });

  it('fits are computed from ready lines only', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setVoice({ projectId, language: 'uk', voice: VOICE });
    await readyLine(s, projectId, { segmentId: 's1', language: 'uk', text: 'Привіт', durationMs: 1000 });
    const v = await s.caller.voice.get({ projectId });
    expect(v.fits.uk![0]).toMatchObject({ segmentId: 's1', base: 2, target: 1.5, speed: 1.25, hold: 0 });
    expect(v.fits.uk![0]!.trimmed).toBeCloseTo(0.133, 2);
    expect(v.fits.uk![1]).toMatchObject({ segmentId: 's2', base: 2, target: 2, speed: 1 });
    expect(v.fits.en!.every((f) => f.speed === 1)).toBe(true);
  });

  it('includes transcript words and timing for voiced lines', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setVoice({ projectId, language: 'uk', voice: VOICE });
    const audio = await readyLine(s, projectId, { segmentId: 's1', language: 'uk', text: 'Привіт' });
    const { transcripts } = await import('@vf/db');
    const [t] = await s.deps.db
      .insert(transcripts)
      .values({
        userId: LOCAL_USER_ID,
        assetId: audio,
        language: 'uk',
        source: 'tts',
        text: 'Привіт',
        words: [{ text: 'Привіт', startMs: 0, endMs: 400 }],
        timing: 'aligned',
      })
      .returning();
    await s.deps.db.update(voiceLines).set({ transcriptId: t!.id }).where(eq(voiceLines.audioAssetId, audio));
    expect((await s.caller.voice.get({ projectId })).lines.s1!.uk).toMatchObject({
      timing: 'aligned',
      words: [{ text: 'Привіт', startMs: 0, endMs: 400 }],
    });
  });
});

describe('voice estimate', () => {
  it('chars / 15 s × TTS price of the language voice + whisper', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setVoice({
      projectId,
      language: 'en',
      voice: { model: 'openai/gpt-4o-mini-tts', voiceId: 'alloy' },
    });
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'en', text: 'a'.repeat(150) });
    await s.caller.voice.setText({ projectId, segmentId: 's2', language: 'en', text: 'b'.repeat(150) });
    const { estimate } = await s.caller.voice.get({ projectId });
    // 300 символів = 20 с: 20/60 × 0.015 + 20/60 × 0.006
    expect(estimate.en!.chars).toBe(300);
    expect(estimate.en!.usd).toBeCloseTo((20 / 60) * (0.015 + 0.006), 6);
    expect(estimate.uk).toEqual({ chars: 0, usd: 0 });
  });

  it('ready lines are not counted', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setVoice({ projectId, language: 'uk', voice: VOICE });
    await readyLine(s, projectId, { segmentId: 's1', language: 'uk', text: 'x'.repeat(30) });
    await s.caller.voice.setText({ projectId, segmentId: 's2', language: 'uk', text: 'y'.repeat(30) });
    expect((await s.caller.voice.get({ projectId })).estimate.uk!.chars).toBe(30);
  });
});

describe('voice settings', () => {
  it('setLanguages keeps texts and validates', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт' });
    await s.caller.voice.setLanguages({ projectId, base: 'en', languages: ['en', 'de', 'uk'] });
    const v = await s.caller.voice.get({ projectId });
    expect(v).toMatchObject({ base: 'en', languages: ['en', 'de', 'uk'] });
    expect(v.lines.s1!.uk!.text).toBe('Привіт');
    await expect(s.caller.voice.setLanguages({ projectId, base: 'en', languages: ['uk'] })).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });
    await expect(s.caller.voice.setLanguages({ projectId, base: 'uk', languages: ['uk', 'xx'] })).rejects.toMatchObject(
      { cause: { code: 'VALIDATION' } },
    );
  });

  it('setVoice / setOriginal / setCaptions persist into project voice', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    expect((await s.caller.voice.get({ projectId })).voice).toEqual({
      languages: {},
      original: { mode: 'duck', level: 0.25, duckLevel: 0.08 },
    });
    await s.caller.voice.setVoice({ projectId, language: 'en', voice: VOICE });
    await s.caller.voice.setOriginal({ projectId, original: { mode: 'replace', level: 0.5, duckLevel: 0.1 } });
    await s.caller.voice.setCaptions({ projectId, language: 'en', enabled: true, styleId: PRESETS[1]!.id });
    expect((await s.caller.voice.get({ projectId })).voice).toEqual({
      languages: { en: { voice: VOICE, captions: { enabled: true, styleId: 'preset:pop' } } },
      original: { mode: 'replace', level: 0.5, duckLevel: 0.1 },
    });
    await s.caller.voice.setVoice({ projectId, language: 'en', voice: null });
    expect((await s.caller.voice.get({ projectId })).voice.languages.en!.voice).toBeUndefined();
  });

  it('rejects unknown voices, bad original values and unknown caption styles', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await expect(
      s.caller.voice.setVoice({ projectId, language: 'en', voice: { model: 'fake/tts', voiceId: 'nope' } }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    await expect(
      s.caller.voice.setVoice({ projectId, language: 'en', voice: { model: 'fake/text', voiceId: 'x' } }),
    ).rejects.toMatchObject({ cause: { code: 'MODEL_NOT_FOUND' } });
    await expect(
      s.caller.voice.setOriginal({ projectId, original: { mode: 'duck', level: -1, duckLevel: 0 } }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    await expect(
      s.caller.voice.setCaptions({ projectId, language: 'en', enabled: true, styleId: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
  });

  it('a saved caption style can be chosen; captions are refused for scripts without fonts', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    const mine = await s.caller.captionStyles.create({ name: 'Мій', style: PRESETS[0]!.style });
    await s.caller.voice.setCaptions({ projectId, language: 'uk', enabled: true, styleId: mine.id });
    expect((await s.caller.voice.get({ projectId })).voice.languages.uk!.captions.styleId).toBe(mine.id);
    const { LANGUAGES } = await import('@vf/shared');
    const noFonts = LANGUAGES.find((l) => !l.captions);
    if (noFonts)
      await expect(
        s.caller.voice.setCaptions({ projectId, language: noFonts.code, enabled: true, styleId: mine.id }),
      ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
  });

  it('get exposes presets and saved styles', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    const mine = await s.caller.captionStyles.create({ name: 'Мій', style: PRESETS[0]!.style });
    const ids = (await s.caller.voice.get({ projectId })).styles.map((x) => x.id);
    expect(ids.slice(0, PRESETS.length)).toEqual(PRESETS.map((p) => p.id));
    expect(ids).toContain(mine.id);
  });

  it('user default voices are stored by settings and used for staleness and estimate', async () => {
    const s = await startApp();
    await s.deps.db.update(userSettings).set({ voices: {} }).where(eq(userSettings.userId, LOCAL_USER_ID));
    expect((await s.caller.settings.get()).voices).toEqual({});
    await s.caller.settings.setVoice({ language: 'uk', voice: VOICE });
    expect((await s.caller.settings.get()).voices).toEqual({ uk: VOICE });
    await expect(
      s.caller.settings.setVoice({ language: 'uk', voice: { model: 'fake/tts', voiceId: 'nope' } }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    await expect(s.caller.settings.setVoice({ language: 'xx', voice: VOICE })).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });

    const projectId = await voiceProject(s);
    await readyLine(s, projectId, { segmentId: 's1', language: 'uk', text: 'Привіт' });
    expect((await s.caller.voice.get({ projectId })).lines.s1!.uk!.state).toBe('ready');
    await s.caller.settings.setVoice({ language: 'uk', voice: { model: 'openai/gpt-4o-mini-tts', voiceId: 'alloy' } });
    expect((await s.caller.voice.get({ projectId })).lines.s1!.uk!.state).toBe('stale');

    await s.caller.settings.setVoice({ language: 'uk', voice: null });
    expect((await s.caller.settings.get()).voices).toEqual({});
  });
});

describe('voice.list', () => {
  it('returns only projects with segments or voice lines, with per-language state', async () => {
    const s = await startApp();
    const plain = (await s.caller.projects.create({ title: 'Без озвучки', format: '9:16' })).id;
    const projectId = await voiceProject(s);
    await s.caller.voice.setVoice({ projectId, language: 'uk', voice: VOICE });
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт' });
    await s.caller.voice.setText({ projectId, segmentId: 's2', language: 'uk', text: 'Світе' });
    await readyLine(s, projectId, { segmentId: 's1', language: 'uk', text: 'Привіт' }).catch(() => undefined);

    const list = await s.caller.voice.list();
    expect(list.map((c) => c.id)).not.toContain(plain);
    const card = list.find((c) => c.id === projectId)!;
    expect(card).toMatchObject({ title: 'Озвучка', format: '16:9', base: 'uk' });
    expect(card.languages).toEqual([
      { code: 'uk', state: 'empty' },
      { code: 'en', state: 'empty' },
    ]);
  });

  it('aggregates ready / partial / stale / failed', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s, ['uk', 'en', 'de', 'fr']);
    for (const lang of ['uk', 'en', 'de', 'fr']) {
      await s.caller.voice.setVoice({ projectId, language: lang, voice: VOICE });
      for (const seg of ['s1', 's2'])
        await s.caller.voice.setText({ projectId, segmentId: seg, language: lang, text: `${lang}-${seg}` });
    }
    const set = async (language: string, seg: string, patch: Partial<typeof voiceLines.$inferInsert>) => {
      const rows = await s.deps.db.select().from(voiceLines).where(eq(voiceLines.projectId, projectId));
      const row = rows.find((r) => r.language === language && r.segmentId === seg)!;
      await s.deps.db.update(voiceLines).set(patch).where(eq(voiceLines.id, row.id));
    };
    const ready = async (language: string, seg: string) => {
      const audio = await insertAsset(s, { kind: 'audio', mime: 'audio/wav' });
      await set(language, seg, {
        voice: VOICE,
        voicedHash: voicedHash(`${language}-${seg}`, VOICE),
        audioAssetId: audio,
        durationMs: 1000,
        status: 'ready',
      });
    };
    await ready('uk', 's1');
    await ready('uk', 's2');
    await ready('en', 's1');
    await ready('de', 's1');
    await ready('de', 's2');
    await set('de', 's2', { voicedHash: 'old' });
    await set('fr', 's1', { status: 'failed', error: 'x' });

    const card = (await s.caller.voice.list()).find((c) => c.id === projectId)!;
    expect(card.languages).toEqual([
      { code: 'uk', state: 'ready' },
      { code: 'en', state: 'partial' },
      { code: 'de', state: 'stale' },
      { code: 'fr', state: 'failed' },
    ]);
  });

  it('a project with orphan lines only is still listed', async () => {
    const s = await startApp();
    const { id } = await s.caller.projects.create({ title: 'Лише рядки', format: '9:16' });
    await s.deps.db
      .insert(voiceLines)
      .values({ userId: LOCAL_USER_ID, projectId: id, segmentId: 'old', language: 'uk', text: 'x' });
    expect((await s.caller.voice.list()).map((c) => c.id)).toContain(id);
  });
});

describe('voice.preview', () => {
  it('synthesises a sample once per (model, voice, language) and serves it from storage', async () => {
    const s = await startApp();
    const tts = await s.deps.ai.tts(LOCAL_USER_ID, 'fake/tts');
    for (const lang of ['en', 'uk'])
      await s.deps.storage.delete(`u/${LOCAL_USER_ID}/voice-samples/fake/tts/fake-voice/${lang}.wav`);
    const spy = vi.spyOn(tts, 'synthesize');
    try {
      const voiceId = 'fake-voice';
      const first = await s.caller.voice.preview({ model: 'fake/tts', voiceId, language: 'en' });
      const second = await s.caller.voice.preview({ model: 'fake/tts', voiceId, language: 'en' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({ voiceId, language: 'en' });
      const res = await fetch(second.url);
      expect(res.ok).toBe(true);
      expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4))).toBe('RIFF');
      expect(first.url).toContain('voice-samples');
      await s.caller.voice.preview({ model: 'fake/tts', voiceId, language: 'uk' });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('unknown voice → VALIDATION', async () => {
    const s = await startApp();
    await expect(s.caller.voice.preview({ model: 'fake/tts', voiceId: 'nope', language: 'en' })).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });
  });
});

describe('voice isolation', () => {
  it("another user's project → NOT_FOUND on every procedure", async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    const nf = { code: 'NOT_FOUND' };
    await expect(stranger.voice.get({ projectId })).rejects.toMatchObject(nf);
    await expect(
      stranger.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'a' }),
    ).rejects.toMatchObject(nf);
    await expect(stranger.voice.setLanguages({ projectId, base: 'uk', languages: ['uk'] })).rejects.toMatchObject(nf);
    await expect(stranger.voice.setVoice({ projectId, language: 'uk', voice: null })).rejects.toMatchObject(nf);
    await expect(
      stranger.voice.setOriginal({ projectId, original: { mode: 'duck', level: 0.25, duckLevel: 0.08 } }),
    ).rejects.toMatchObject(nf);
    await expect(
      stranger.voice.setCaptions({ projectId, language: 'uk', enabled: false, styleId: 'preset:pop' }),
    ).rejects.toMatchObject(nf);
    expect(await stranger.voice.list()).toEqual([]);
  });
});

describe('voice fixes from review', () => {
  it('list survives a project with a broken document', async () => {
    const s = await startApp();
    const good = await voiceProject(s);
    const { id: broken } = await s.caller.projects.create({ title: 'Зламаний', format: '9:16' });
    await s.deps.db
      .update(projects)
      .set({ timeline: { garbage: true } as never })
      .where(eq(projects.id, broken));
    await s.deps.db
      .insert(voiceLines)
      .values({ userId: LOCAL_USER_ID, projectId: broken, segmentId: 'x', language: 'uk', text: 'a' });
    const list = await s.caller.voice.list();
    expect(list.map((c) => c.id)).toContain(good);
    expect(list.find((c) => c.id === broken)).toMatchObject({
      thumbUrl: null,
      languages: [{ code: 'uk', state: 'empty' }],
    });
  });

  it('setText on a failed line resets it to empty and clears the error', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт' });
    await s.deps.db
      .update(voiceLines)
      .set({ status: 'failed', error: 'TTS впав' })
      .where(eq(voiceLines.projectId, projectId));
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Привіт знову' });
    const line = (await s.caller.voice.get({ projectId })).lines.s1!.uk!;
    expect(line.state).toBe('empty');
    expect(line.error).toBeUndefined();
  });
});

// ---------- задачі ----------

const fakeAi = () => createAiRegistry({ credentials: createEnvCredentialStore({ AI_FAKE: '1' }), media: tools });

/** Fake-TTS з хуком: `before` викликається перед синтезом (затримка, помилка), `words: false` — без міток. */
function hookedAi(o: {
  before?: (text: string, signal?: AbortSignal) => Promise<void> | void;
  words?: boolean;
  whisper?: STT;
  text?: (base: TextGen) => TextGen;
}): AiRegistry {
  const base = fakeAi();
  return {
    ...base,
    async catalog(userId) {
      const list = await base.catalog(userId);
      if (!o.whisper) return list.map((e) => (e.ref === 'openai/whisper-1' ? { ...e, available: false } : e));
      return list.map((e) => (e.ref === 'openai/whisper-1' ? ({ ...e, available: true } as CatalogItem) : e));
    },
    async tts(userId, ref) {
      const inner = await base.tts(userId, ref);
      const tts: TTS = {
        async synthesize(req) {
          await o.before?.(req.text, req.signal);
          const r = await inner.synthesize(req);
          return o.words === false ? { audio: r.audio } : r;
        },
      };
      return tts;
    },
    async stt(userId, ref) {
      if (ref === 'openai/whisper-1' && o.whisper) return o.whisper;
      return base.stt(userId, ref);
    },
    async text(userId, ref) {
      const t = await base.text(userId, ref);
      return o.text ? o.text(t) : t;
    },
  };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const lineOf = async (s: Started, projectId: string, segmentId: string, language: string) =>
  (
    await s.deps.db
      .select()
      .from(voiceLines)
      .where(
        and(
          eq(voiceLines.projectId, projectId),
          eq(voiceLines.segmentId, segmentId),
          eq(voiceLines.language, language),
        ),
      )
  )[0]!;

const waitJobs = (s: Started, ids: string[]) =>
  waitFor(async () => {
    const rows = await s.deps.db.select().from(jobs).where(inArray(jobs.id, ids));
    return rows.length === ids.length && rows.every((j) => ['done', 'failed', 'cancelled'].includes(j.status)) && rows;
  });

/** Контекст обробника з наявним рядком `jobs` (job_id рядка — зовнішній ключ). */
async function jobCtx(s: Started, signal = new AbortController().signal) {
  const [j] = await s.deps.db
    .insert(jobs)
    .values({ userId: LOCAL_USER_ID, type: 'voice.synthesize', payload: {}, status: 'running' })
    .returning();
  return { jobId: j!.id, userId: LOCAL_USER_ID, progress: async () => {}, signal };
}

async function textProject(s: Started, texts: Record<string, string>, language = 'uk') {
  const projectId = await voiceProject(s);
  await s.caller.voice.setVoice({ projectId, language, voice: VOICE });
  for (const [segmentId, text] of Object.entries(texts))
    await s.caller.voice.setText({ projectId, segmentId, language, text });
  return projectId;
}

describe('voice.synthesize', () => {
  it('voices a line: generated audio asset, tts transcript, duration, voiced_hash, ready, tts generation', async () => {
    const s = await startApp({}, { ai: hookedAi({}) });
    const projectId = await textProject(s, { s1: 'Привіт усім друзі' });
    const { jobIds } = await s.caller.voice.synthesize({ projectId });
    expect(jobIds).toHaveLength(1);
    await waitJobs(s, jobIds);

    const line = await lineOf(s, projectId, 's1', 'uk');
    expect(line).toMatchObject({
      status: 'ready',
      error: null,
      durationMs: 1200,
      voice: VOICE,
      voicedHash: voicedHash('Привіт усім друзі', VOICE),
    });
    const [a] = await s.deps.db.select().from(assets).where(eq(assets.id, line.audioAssetId!));
    expect(a).toMatchObject({ kind: 'audio', source: 'generated', status: 'ready', language: 'uk', mime: 'audio/wav' });
    expect(a!.storageKey).toBe(`u/${LOCAL_USER_ID}/assets/${a!.id}/original.wav`);
    expect(a!.tags).toEqual(expect.arrayContaining(['uk', 'озвучка']));
    const [t] = await s.deps.db.select().from(transcripts).where(eq(transcripts.id, line.transcriptId!));
    expect(t).toMatchObject({ source: 'tts', timing: 'aligned', language: 'uk', assetId: a!.id });
    expect(t!.words.map((w) => w.text)).toEqual(['Привіт', 'усім', 'друзі']);
    const [g] = await s.deps.db.select().from(generations).where(eq(generations.id, a!.generationId!));
    expect(g).toMatchObject({ capability: 'tts', status: 'done', provider: 'fake', model: 'tts' });
    expect(g!.costEstimate).not.toBeNull();

    const view = (await s.caller.voice.get({ projectId })).lines.s1!.uk!;
    expect(view).toMatchObject({ state: 'ready', durationMs: 1200, timing: 'aligned' });
  }, 30_000);

  it('re-running the job with an unchanged voiced_hash creates no second asset', async () => {
    const s = await startApp({}, { ai: hookedAi({}) });
    const projectId = await textProject(s, { s1: 'Один два' });
    await waitJobs(s, (await s.caller.voice.synthesize({ projectId })).jobIds);
    const line = await lineOf(s, projectId, 's1', 'uk');
    const ctx = await jobCtx(s);
    expect(await synthesizeJob(s.deps).handler({ lineId: line.id }, ctx)).toEqual({ assetId: line.audioAssetId });
    expect(await lineOf(s, projectId, 's1', 'uk')).toMatchObject({ status: 'ready', audioAssetId: line.audioAssetId });
    const gens = (await s.deps.db.select().from(generations).where(eq(generations.capability, 'tts'))).filter(
      (g) => (g.params as { lineId?: string }).lineId === line.id,
    );
    expect(gens).toHaveLength(1);
    expect(await s.deps.db.select().from(assets).where(eq(assets.generationId, gens[0]!.id))).toHaveLength(1);
  }, 30_000);

  it('text changed while the job runs → result is stale, voiced_hash of the old text (Review Focus 3)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const s = await startApp(
      {},
      {
        ai: hookedAi({
          before: async () => {
            entered = true;
            await gate;
          },
        }),
      },
    );
    const projectId = await textProject(s, { s1: 'Старий текст' });
    const { jobIds } = await s.caller.voice.synthesize({ projectId });
    await waitFor(async () => entered);
    expect((await s.caller.voice.get({ projectId })).lines.s1!.uk!.state).toBe('running');
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Новий текст' });
    release();
    await waitJobs(s, jobIds);
    const line = await lineOf(s, projectId, 's1', 'uk');
    expect(line).toMatchObject({ status: 'ready', text: 'Новий текст', voicedHash: voicedHash('Старий текст', VOICE) });
    expect((await s.caller.voice.get({ projectId })).lines.s1!.uk!.state).toBe('stale');
    // «Озвучити все» бере застарілий рядок знову
    await waitJobs(s, (await s.caller.voice.synthesize({ projectId })).jobIds);
    expect((await s.caller.voice.get({ projectId })).lines.s1!.uk!.state).toBe('ready');
  }, 30_000);

  it('TTS error → only that line fails with the message, the others are ready', async () => {
    const s = await startApp(
      {},
      {
        ai: hookedAi({
          before: (text) => {
            if (text.includes('погане')) throw new Error('Контент-політика провайдера');
          },
        }),
      },
    );
    const projectId = await textProject(s, { s1: 'погане слово', s2: 'добре слово' });
    await waitJobs(s, (await s.caller.voice.synthesize({ projectId })).jobIds);
    const v = (await s.caller.voice.get({ projectId })).lines;
    expect(v.s1!.uk).toMatchObject({ state: 'failed', error: 'Контент-політика провайдера' });
    expect(v.s2!.uk!.state).toBe('ready');
    const failedGen = (
      await s.deps.db
        .select()
        .from(generations)
        .where(eq(generations.jobId, (await lineOf(s, projectId, 's1', 'uk')).jobId!))
    )[0];
    expect(failedGen).toMatchObject({ capability: 'tts', status: 'failed' });
  }, 30_000);

  it('no TTS words + whisper-1 available → whisper words aligned to the script', async () => {
    const whisperCalls: unknown[] = [];
    const whisper: STT = {
      async transcribe(req) {
        whisperCalls.push({ language: req.language, prompt: req.prompt, mime: req.mime });
        return {
          text: 'привіт усім',
          segments: [{ start: 0, end: 0.8, text: 'привіт усім' }],
          words: [
            { text: 'привіт', startMs: 0, endMs: 400 },
            { text: 'усім', startMs: 400, endMs: 800 },
          ],
        };
      },
    };
    const s = await startApp({}, { ai: hookedAi({ words: false, whisper }) });
    const projectId = await textProject(s, { s1: 'Привіт, усім!' });
    const { jobIds } = await s.caller.voice.synthesize({ projectId });
    await waitJobs(s, jobIds);
    expect(whisperCalls).toEqual([{ language: 'uk', prompt: 'Привіт, усім!', mime: 'audio/wav' }]);
    const v = (await s.caller.voice.get({ projectId })).lines.s1!.uk!;
    expect(v).toMatchObject({
      state: 'ready',
      timing: 'aligned',
      words: [
        { text: 'Привіт,', startMs: 0, endMs: 400 },
        { text: 'усім!', startMs: 400, endMs: 800 },
      ],
    });
    const gens = await s.deps.db.select().from(generations).where(eq(generations.jobId, jobIds[0]!));
    expect(gens.map((g) => g.capability).sort()).toEqual(['stt', 'tts']);
  }, 30_000);

  it('no TTS words and no whisper → estimated words', async () => {
    const s = await startApp({}, { ai: hookedAi({ words: false }) });
    const projectId = await textProject(s, { s1: 'Три слова тут' });
    await waitJobs(s, (await s.caller.voice.synthesize({ projectId })).jobIds);
    const v = (await s.caller.voice.get({ projectId })).lines.s1!.uk!;
    expect(v).toMatchObject({ state: 'ready', timing: 'estimated' });
    expect(v.words!.map((w) => w.text)).toEqual(['Три', 'слова', 'тут']);
    for (const w of v.words!) expect(w.endMs).toBeLessThanOrEqual(v.durationMs!);
  }, 30_000);

  it('picks only empty / failed / stale lines with text; segmentIds narrows; missing voice → VALIDATION', async () => {
    const s = await startApp({}, { ai: hookedAi({}) });
    const projectId = await textProject(s, { s1: 'Раз', s2: 'Два' });
    await readyLine(s, projectId, { segmentId: 's1', language: 'en', text: 'One' }); // мова без голосу, але готова
    await s.caller.voice.setText({ projectId, segmentId: 's2', language: 'en', text: 'Two' });
    await expect(s.caller.voice.synthesize({ projectId })).rejects.toMatchObject({
      cause: { code: 'VALIDATION', message: 'Не вибрано голос для мови «Англійська»' },
    });
    const only = await s.caller.voice.synthesize({ projectId, language: 'uk', segmentIds: ['s2'] });
    expect(only.jobIds).toHaveLength(1);
    await waitJobs(s, only.jobIds);
    expect((await lineOf(s, projectId, 's1', 'uk')).status).toBe('empty');
    expect((await lineOf(s, projectId, 's2', 'uk')).status).toBe('ready');
    const rest = await s.caller.voice.synthesize({ projectId, language: 'uk' });
    expect(rest.jobIds).toHaveLength(1);
    await waitJobs(s, rest.jobIds);
    expect((await s.caller.voice.synthesize({ projectId, language: 'uk' })).jobIds).toEqual([]);
  }, 30_000);

  it('cancelling a running job returns the line to its previous state', async () => {
    let entered = false;
    const s = await startApp(
      {},
      {
        ai: hookedAi({
          // провайдер перериває запит за сигналом задачі
          before: (_text, signal) =>
            new Promise((_, reject) => {
              entered = true;
              signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            }),
        }),
      },
    );
    const projectId = await textProject(s, { s1: 'Довго' });
    const { jobIds } = await s.caller.voice.synthesize({ projectId });
    await waitFor(async () => entered);
    await s.deps.jobs.queue.cancel(jobIds[0]!);
    await waitFor(async () => (await lineOf(s, projectId, 's1', 'uk')).status === 'empty');
    expect((await lineOf(s, projectId, 's1', 'uk')).error).toBeNull();
  }, 30_000);

  it('two concurrent «Озвучити все» → one job, one TTS call, one asset', async () => {
    let calls = 0;
    const s = await startApp({}, { ai: hookedAi({ before: () => void calls++ }) });
    const projectId = await textProject(s, { s1: 'Паралельно' });
    const [a, b] = await Promise.all([
      s.caller.voice.synthesize({ projectId }),
      s.caller.voice.synthesize({ projectId }),
    ]);
    const ids = [...a.jobIds, ...b.jobIds];
    expect(ids).toHaveLength(1);
    await waitJobs(s, ids);
    expect(calls).toBe(1);
    const line = await lineOf(s, projectId, 's1', 'uk');
    expect(line).toMatchObject({ status: 'ready', jobId: ids[0] });
  }, 30_000);

  it('two handlers for the same line at once → only one claims it and synthesises', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = await startApp(
      {},
      {
        ai: hookedAi({
          before: async () => {
            calls++;
            await gate;
          },
        }),
      },
    );
    const projectId = await textProject(s, { s1: 'Двічі' });
    const line = await lineOf(s, projectId, 's1', 'uk');
    const job = synthesizeJob(s.deps);
    const first = job.handler({ lineId: line.id }, await jobCtx(s));
    await waitFor(async () => calls === 1);
    expect(await job.handler({ lineId: line.id }, await jobCtx(s))).toEqual({ assetId: null });
    release();
    expect((await first).assetId).toBeTruthy();
    expect(calls).toBe(1);
  }, 30_000);

  it('a job cancelled before it starts leaves no line stuck in «running»', async () => {
    const s = await startApp({}, { ai: hookedAi({}) });
    const projectId = await textProject(s, { s1: 'Скасовано' });
    const line = await lineOf(s, projectId, 's1', 'uk');
    const ctrl = new AbortController();
    const ctx = await jobCtx(s, ctrl.signal);
    await s.deps.db.update(voiceLines).set({ status: 'queued', jobId: ctx.jobId }).where(eq(voiceLines.id, line.id));
    ctrl.abort();
    await expect(synthesizeJob(s.deps).handler({ lineId: line.id }, ctx)).rejects.toThrow();
    expect((await lineOf(s, projectId, 's1', 'uk')).status).toBe('queued');
    await releaseCancelledLines(s.deps, [line.id], ctx.jobId);
    expect((await lineOf(s, projectId, 's1', 'uk')).status).toBe('empty');
  }, 30_000);

  it('a retried job (new job id) can take a failed line', async () => {
    const s = await startApp({}, { ai: hookedAi({}) });
    const projectId = await textProject(s, { s1: 'Повтор' });
    const line = await lineOf(s, projectId, 's1', 'uk');
    await s.deps.db.update(voiceLines).set({ status: 'failed', error: 'x' }).where(eq(voiceLines.id, line.id));
    const ctx = await jobCtx(s);
    expect((await synthesizeJob(s.deps).handler({ lineId: line.id }, ctx)).assetId).toBeTruthy();
    expect(await lineOf(s, projectId, 's1', 'uk')).toMatchObject({ status: 'ready', jobId: ctx.jobId, error: null });
  }, 30_000);

  it('whisper error → falls back to estimated words, the paid audio is kept', async () => {
    const whisper: STT = {
      async transcribe() {
        throw new Error('whisper недоступний');
      },
    };
    const s = await startApp({}, { ai: hookedAi({ words: false, whisper }) });
    const projectId = await textProject(s, { s1: 'Слова без міток' });
    const { jobIds } = await s.caller.voice.synthesize({ projectId });
    expect((await waitJobs(s, jobIds))[0]!.status).toBe('done');
    const v = (await s.caller.voice.get({ projectId })).lines.s1!.uk!;
    expect(v).toMatchObject({ state: 'ready', timing: 'estimated' });
    expect(v.words).toHaveLength(3);
    const gens = await s.deps.db.select().from(generations).where(eq(generations.jobId, jobIds[0]!));
    expect(gens.find((g) => g.capability === 'stt')).toMatchObject({ status: 'failed', error: 'whisper недоступний' });
    expect(gens.find((g) => g.capability === 'tts')).toMatchObject({ status: 'done' });
  }, 30_000);

  it('a line stale only by translation (source_hash) is not picked by «Озвучити все»', async () => {
    const s = await startApp({}, { ai: hookedAi({}) });
    const projectId = await textProject(s, { s1: 'Привіт' });
    await s.caller.voice.setVoice({ projectId, language: 'en', voice: VOICE });
    await readyLine(s, projectId, {
      segmentId: 's1',
      language: 'en',
      text: 'Hello',
      textOrigin: 'translated',
      sourceHash: textHash('Привіт'),
    });
    await s.caller.voice.setText({ projectId, segmentId: 's1', language: 'uk', text: 'Вітаю' });
    expect((await s.caller.voice.get({ projectId })).lines.s1!.en!.state).toBe('stale');
    expect((await s.caller.voice.synthesize({ projectId, language: 'en' })).jobIds).toEqual([]);
  }, 30_000);
});

describe('voice.translate', () => {
  it('translates all base texts into translated lines with source_hash', async () => {
    const calls: string[] = [];
    const s = await startApp(
      {},
      {
        ai: hookedAi({
          text: (t) => ({
            ...t,
            generateObject: (schema, req) => {
              calls.push(req.prompt);
              return t.generateObject(schema, req);
            },
          }),
        }),
      },
    );
    const projectId = await textProject(s, { s1: 'Привіт', s2: 'Світе' });
    await s.deps.db.insert(voiceLines).values({
      userId: LOCAL_USER_ID,
      projectId,
      segmentId: 's1',
      language: 'en',
      text: 'old',
      status: 'failed',
      error: 'x',
    });
    const { jobId } = await s.caller.voice.translate({ projectId, language: 'en' });
    expect((await waitJobs(s, [jobId]))[0]!.status).toBe('done');
    expect(calls).toHaveLength(1);
    const v = (await s.caller.voice.get({ projectId })).lines;
    expect(v.s1!.en).toMatchObject({ text: '[en] Привіт', origin: 'translated', state: 'empty' });
    expect(v.s1!.en!.error).toBeUndefined();
    expect(v.s2!.en).toMatchObject({ text: '[en] Світе', origin: 'translated' });
    expect((await lineOf(s, projectId, 's1', 'en')).sourceHash).toBe(textHash('Привіт'));
    const [g] = await s.deps.db
      .select()
      .from(generations)
      .where(and(eq(generations.capability, 'text'), eq(generations.jobId, jobId)));
    expect(g).toMatchObject({ status: 'done' });
  }, 30_000);

  it('more than 60 segments → several calls, later ones with previous context', async () => {
    const calls: string[] = [];
    const s = await startApp(
      {},
      {
        ai: hookedAi({
          text: (t) => ({
            ...t,
            generateObject: (schema, req) => {
              calls.push(req.prompt);
              return t.generateObject(schema, req);
            },
          }),
        }),
      },
    );
    const { id: projectId } = await s.caller.projects.create({ title: 'Довгий', format: '16:9' });
    const p = await s.caller.projects.get({ id: projectId });
    const segments = Array.from({ length: 61 }, (_, i) => ({ id: `g${i}`, start: i, end: i + 1 }));
    await s.caller.projects.save({ id: projectId, baseVersion: p.version, timeline: { ...p.timeline, segments } });
    await s.caller.voice.setLanguages({ projectId, base: 'uk', languages: ['uk', 'de'] });
    for (const seg of segments)
      await s.deps.db
        .insert(voiceLines)
        .values({ userId: LOCAL_USER_ID, projectId, segmentId: seg.id, language: 'uk', text: `фраза ${seg.id}` });
    const { jobId } = await s.caller.voice.translate({ projectId, language: 'de' });
    await waitJobs(s, [jobId]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain('Попередній контекст');
    expect(calls[1]).toContain('Попередній контекст');
    expect(calls[1]).toContain('[de] фраза g59');
    expect((await lineOf(s, projectId, 'g60', 'de')).text).toBe('[de] фраза g60');
  }, 60_000);

  it('base language or no base text → VALIDATION', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    await expect(s.caller.voice.translate({ projectId, language: 'uk' })).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });
    await expect(s.caller.voice.translate({ projectId, language: 'en' })).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });
  });
});

describe('voice.transcribe', () => {
  async function videoProject(s: Started) {
    const assetId = await upload(s.caller, 'mova.mp4', 'video/mp4', await toneMp4Bytes(6));
    await waitForAsset(s.deps, assetId, ['ready']);
    return (await s.caller.voice.createFromAsset({ assetId })).projectId;
  }

  it('original sound → segments in the document (version +1) and stt base lines; a repeat replaces them', async () => {
    const s = await startApp();
    const projectId = await videoProject(s);
    const before = await s.caller.projects.get({ id: projectId });
    const { jobId } = await s.caller.voice.transcribe({ projectId });
    expect((await waitJobs(s, [jobId]))[0]).toMatchObject({ status: 'done' });

    const after = await s.caller.projects.get({ id: projectId });
    expect(after.version).toBe(before.version + 1);
    const segs = after.timeline.segments!;
    expect(segs.length).toBeGreaterThan(0);
    expect(segs[0]!.start).toBe(0);
    expect(segs.at(-1)!.end).toBeCloseTo(6, 1);
    const v = await s.caller.voice.get({ projectId });
    const texts = segs.map((x) => v.lines[x.id]?.uk).filter(Boolean);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((l) => l!.origin === 'stt')).toBe(true);
    expect(texts.map((l) => l!.text).join(' ')).toBe('це перша тестова фраза а це друга фраза і наприкінці третя');
    const [g] = await s.deps.db.select().from(generations).where(eq(generations.jobId, jobId));
    expect(g).toMatchObject({ capability: 'stt', status: 'done' });

    const again = await s.caller.voice.transcribe({ projectId });
    await waitJobs(s, [again.jobId]);
    const third = await s.caller.projects.get({ id: projectId });
    expect(third.version).toBe(after.version + 1);
    expect(third.timeline.segments!.map((x) => x.id)).not.toEqual(segs.map((x) => x.id));
    const v2 = await s.caller.voice.get({ projectId });
    expect(Object.keys(v2.lines).sort()).toEqual(
      third.timeline
        .segments!.filter((x) => v2.lines[x.id])
        .map((x) => x.id)
        .sort(),
    );
    expect(Object.values(v2.lines).flatMap((l) => Object.values(l))).toHaveLength(texts.length);
  }, 60_000);

  it('an unsupported detected language → VALIDATION, the project is unchanged', async () => {
    const base = fakeAi();
    const ai: AiRegistry = {
      ...base,
      async stt(userId, ref) {
        const inner = await base.stt(userId, ref);
        return { transcribe: async (req) => ({ ...(await inner.transcribe(req)), language: 'japanese' }) };
      },
    };
    const s = await startApp({}, { ai });
    const projectId = await videoProject(s);
    const before = await s.caller.projects.get({ id: projectId });
    const { jobId } = await s.caller.voice.transcribe({ projectId });
    const [job] = await waitJobs(s, [jobId]);
    expect(job).toMatchObject({ status: 'failed', error: 'Мова «japanese» не підтримується — виберіть мову вручну' });
    expect((await s.caller.projects.get({ id: projectId })).version).toBe(before.version);
  }, 60_000);

  it('languageCode maps whisper names and strips BCP-47 regions', () => {
    expect(languageCode('english')).toBe('en');
    expect(languageCode('uk-UA')).toBe('uk');
    expect(languageCode('pt_BR')).toBe('pt');
    expect(languageCode('japanese')).toBeNull();
  });

  it('a project without sound → VALIDATION «У відео немає звуку»', async () => {
    const s = await startApp();
    const assetId = await insertAsset(s, { hasAudio: false });
    const { projectId } = await s.caller.voice.createFromAsset({ assetId });
    await expect(s.caller.voice.transcribe({ projectId })).rejects.toMatchObject({
      cause: { code: 'VALIDATION', message: 'У відео немає звуку' },
    });
  });

  it('long audio is split into 60-min parts with 5 s overlap and stitched without duplicates', () => {
    expect(chunkRanges(90 * 60)).toEqual([{ start: 0, end: 5400 }]);
    expect(chunkRanges(150 * 60)).toEqual([
      { start: 0, end: 3600 },
      { start: 3595, end: 7195 },
      { start: 7190, end: 9000 },
    ]);
    const parts = [
      {
        start: 0,
        end: 3600,
        segments: [
          { start: 3590, end: 3598, text: 'a' },
          { start: 3598, end: 3600, text: 'b' },
        ],
      },
      {
        start: 3595,
        end: 7195,
        segments: [
          { start: 3596, end: 3598, text: 'a2' },
          { start: 3598, end: 3601, text: 'b' },
          { start: 3700, end: 3702, text: 'c' },
        ],
      },
    ];
    expect(stitchParts(parts).map((x) => x.text)).toEqual(['a', 'b', 'c']);
  });

  it('sanitises STT segments: no reversed, sorted, clamped to duration', () => {
    expect(
      sanitizeSegments(
        [
          { start: 3, end: 4, text: ' два ' },
          { start: 2, end: 1, text: 'зворотний' },
          { start: -1, end: 1, text: 'один' },
          { start: 5, end: 9, text: 'кінець' },
          { start: 12, end: 13, text: 'поза' },
          { start: 6, end: 7, text: '  ' },
        ],
        8,
      ),
    ).toEqual([
      { start: 0, end: 1, text: 'один' },
      { start: 3, end: 4, text: 'два' },
      { start: 5, end: 8, text: 'кінець' },
    ]);
  });
});

describe('voice recovery after restart', () => {
  it('lines of interrupted jobs → failed «Перервано перезапуском сервера»; cancelled ones are released', async () => {
    const s = await startApp();
    const projectId = await voiceProject(s);
    const [cancelled] = await s.deps.db
      .insert(jobs)
      .values({ userId: LOCAL_USER_ID, type: 'voice.synthesize', payload: {}, status: 'cancelled' })
      .returning();
    await s.deps.db.insert(voiceLines).values([
      { userId: LOCAL_USER_ID, projectId, segmentId: 's1', language: 'uk', text: 'a', status: 'running' },
      {
        userId: LOCAL_USER_ID,
        projectId,
        segmentId: 's2',
        language: 'uk',
        text: 'b',
        status: 'queued',
        jobId: cancelled!.id,
      },
    ]);
    await startApp();
    expect(await lineOf(s, projectId, 's1', 'uk')).toMatchObject({ status: 'failed', error: RESTART_ERROR });
    expect(await lineOf(s, projectId, 's2', 'uk')).toMatchObject({ status: 'empty', error: null });
  });
});
