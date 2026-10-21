import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { PRESETS } from '@vf/captions';
import { assets, projects, userSettings, voiceLines } from '@vf/db';
import { LOCAL_USER_ID, type VoiceChoice } from '@vf/shared';
import { appRouter } from '../src/index';
import { textHash, voicedHash } from '../src/modules/voice/stale';
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
