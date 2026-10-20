import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '@vf/media';
import { createAiRegistry, createEnvCredentialStore } from '../index';
import { taggerPrompt, taggerSchema } from '../prompts/tagger';

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

  it('tts returns one monotonic word timing per word', async () => {
    const tts = await registry.tts(u, 'fake/tts');
    const { audio, words } = await tts.synthesize({ text: 'один два три', voiceId: 'v', language: 'uk' });
    expect(words).toHaveLength(3);
    expect(words![0]!.startMs).toBe(0);
    expect(words![1]!.startMs).toBeGreaterThan(words![0]!.startMs);
    expect(words![2]!.startMs).toBeGreaterThan(words![1]!.startMs);
    expect(audio.mime).toBe('audio/wav');
    expect(audio.durationMs).toBe(words![2]!.endMs);
  });

  it('stt words compose its text', async () => {
    const stt = await registry.stt(u, 'fake/stt');
    const { text, words } = await stt.transcribe({ audio: new Uint8Array(10), mime: 'audio/wav' });
    expect(words.map((w) => w.text).join(' ')).toBe(text);
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
