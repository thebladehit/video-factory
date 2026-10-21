import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '@vf/media';
import { createAiRegistry, createEnvCredentialStore } from '../index';
import { taggerPrompt, taggerSchema } from '../prompts/tagger';
import { buildTranslatePrompt, translateSchema } from '../prompts/translate';
import {
  buildOutlinePrompt,
  buildScenePrompt,
  buildScriptPrompt,
  outlineSchema,
  sceneSchema,
  scriptSchema,
} from '../prompts/script';

const registry = createAiRegistry({
  credentials: createEnvCredentialStore({ AI_FAKE: '1' }),
  media: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
});
const u = 'user-1';

describe('fake provider', () => {
  it('generateText is deterministic and echoes the prompt', async () => {
    const t = await registry.text(u, 'fake/text');
    const a = await t.generateText({ prompt: 'Привіт' });
    expect(a).toContain('Привіт');
    expect(await t.generateText({ prompt: 'Привіт' })).toBe(a);
  });

  it('generateObject returns a value valid for the schema', async () => {
    const schema = z.object({
      title: z.string(),
      scenes: z.array(z.object({ n: z.number(), kind: z.enum(['a', 'b']) })).min(2),
      note: z.string().optional(),
    });
    const t = await registry.text(u, 'fake/text');
    const value = await t.generateObject(schema, { prompt: 'x' });
    expect(schema.parse(value)).toEqual(value);
    expect(value.scenes.length).toBeGreaterThanOrEqual(2);
  });

  it('image returns a PNG with 9:16 dimensions', async () => {
    const img = await registry.image(u, 'fake/image');
    const [file] = await img.generate({ prompt: 'кіт', aspect: '9:16', n: 1 });
    expect([...file!.bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(file).toMatchObject({ mime: 'image/png', width: 540, height: 960 });
  });

  it('tts returns a silent WAV of 0.4 s per word with exact word timings', async () => {
    const tts = await registry.tts(u, 'fake/tts');
    const { audio, words } = await tts.synthesize({ text: 'один два три', voiceId: 'fake-voice', language: 'uk' });
    expect(words).toEqual([
      { text: 'один', startMs: 0, endMs: 400 },
      { text: 'два', startMs: 400, endMs: 800 },
      { text: 'три', startMs: 800, endMs: 1200 },
    ]);
    expect(audio.mime).toBe('audio/wav');
    expect(audio.durationMs).toBe(1200);
    expect(Buffer.from(audio.bytes).toString('ascii', 0, 4)).toBe('RIFF');
  });

  it('stt returns three fixed phrases with segments and words', async () => {
    const stt = await registry.stt(u, 'fake/stt');
    const { text, segments, words } = await stt.transcribe({ audio: new Uint8Array(10), mime: 'audio/wav' });
    expect(segments.map((s) => [s.start, s.end])).toEqual([
      [0, 1.2],
      [2, 3.5],
      [4, 5.5],
    ]);
    expect(text).toBe(segments.map((s) => s.text).join(' '));
    expect(words!.map((w) => w.text).join(' ')).toBe(text);
    for (const [i, w] of words!.entries()) {
      expect(w.endMs).toBeGreaterThan(w.startMs);
      if (i) expect(w.startMs).toBeGreaterThanOrEqual(words![i - 1]!.endMs);
    }
    expect(words![0]!.startMs).toBe(0);
    expect(words!.at(-1)!.endMs).toBe(5500);
  });

  it('fake generateObject(translateSchema) prefixes each item with the target language', async () => {
    const t = await registry.text(u, 'fake/text');
    const { prompt } = buildTranslatePrompt({
      from: 'uk',
      to: 'en',
      items: [
        { id: 'a', text: 'Привіт' },
        { id: 'b', text: 'Світ' },
      ],
    });
    const v = await t.generateObject(translateSchema, { prompt });
    expect(v).toEqual({
      items: [
        { id: 'a', text: '[en] Привіт' },
        { id: 'b', text: '[en] Світ' },
      ],
    });
  });

  it('fake video completes after two polls', async () => {
    const video = await registry.video(u, 'fake/video');
    const ref = await video.start({ prompt: 'кіт', aspect: '9:16', durationSec: 2 });
    expect(await video.poll(ref)).toMatchObject({ state: 'running' });
    expect(await video.poll(ref)).toMatchObject({ state: 'running' });
    const files = (await video.poll(ref)) as { bytes: Uint8Array; mime: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]!.mime).toBe('video/mp4');
    const dir = await mkdtemp(join(tmpdir(), 'vf-fake-'));
    await writeFile(join(dir, 'v.mp4'), files[0]!.bytes);
    const p = await probe({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, join(dir, 'v.mp4'));
    expect(p).toMatchObject({ kind: 'video', width: 540, height: 960 });
    expect(Math.abs(p.durationMs! - 2000)).toBeLessThan(200);
  });

  it('fake tagger returns tags from the prompt', async () => {
    const t = await registry.text(u, 'fake/text');
    const { system, prompt } = taggerPrompt({ mode: 'prompt', prompt: 'рудий кіт летить у відкритому космосі' });
    expect(system.length).toBeGreaterThan(0);
    const v = await t.generateObject(taggerSchema, { prompt });
    expect(v.tags).toEqual(expect.arrayContaining(['рудий', 'кіт', 'космосі']));
    expect(v.tags.length).toBeGreaterThanOrEqual(5);
    expect(taggerSchema.parse(v)).toEqual(v);
  });
});

describe('fake script objects', () => {
  it('script returns N scenes from the prompt marker', async () => {
    const t = await registry.text(u, 'fake/text');
    const { system, prompt } = buildScriptPrompt({
      topic: 'Чому небо блакитне вдень',
      format: '9:16',
      targetSec: 45,
      language: 'uk',
      channelStyle: '',
      style: '',
    });
    const res = await t.generateObject(scriptSchema, { system, prompt });
    expect(res.scenes).toHaveLength(9);
    expect(res.scenes[0]!.narration).toMatch(/^Сцена 1\. /);
    expect(res.scenes[2]!.visualPrompt).toBe('scene 3 Чому небо блакитне вдень');
    expect(res.scenes[0]!.keywords.length).toBeGreaterThan(0);
  });

  it('outline covers targetSec; scene gets a new-version prefix', async () => {
    const t = await registry.text(u, 'fake/text');
    const o = buildOutlinePrompt({
      topic: 'Історія Риму',
      targetSec: 900,
      language: 'uk',
      channelStyle: '',
      style: '',
    });
    const outline = await t.generateObject(outlineSchema, o);
    expect(outline.sections.reduce((a, s) => a + s.sec, 0)).toBe(900);
    const s = buildScenePrompt({
      topic: 'Історія Риму',
      format: '9:16',
      language: 'uk',
      channelStyle: '',
      style: '',
      current: 'Старий текст',
    });
    const res = await t.generateObject(sceneSchema, s);
    expect(res.narration.startsWith('Нова версія.')).toBe(true);
  });

  it('image with FAIL in prompt rejects with PROVIDER_ERROR', async () => {
    const img = await registry.image(u, 'fake/image');
    await expect(img.generate({ prompt: 'кіт FAIL', aspect: '9:16', n: 1 })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'Fake: відмова',
    });
  });
});
