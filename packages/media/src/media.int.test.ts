import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probe, run, synthAudio, synthImage, synthVideo, thumbnail, type MediaTools } from './index';

const tools: MediaTools = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vf-media-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const file = (name: string) => join(dir, name);

describe('probe', () => {
  it('probes a png', async () => {
    await synthImage(tools, file('a.png'), { width: 64, height: 48, color: '#ff0000', format: 'png' });
    const p = await probe(tools, file('a.png'));
    expect(p).toEqual({ kind: 'image', mime: 'image/png', width: 64, height: 48 });
  });

  it('probes a jpg', async () => {
    await synthImage(tools, file('a.jpg'), { width: 64, height: 48, color: '#00ff00', format: 'jpg' });
    expect(await probe(tools, file('a.jpg'))).toEqual({ kind: 'image', mime: 'image/jpeg', width: 64, height: 48 });
  });

  it('probes an mp4', async () => {
    await synthVideo(tools, file('v.mp4'), { width: 320, height: 180, durationSec: 2, color: '#0000ff' });
    const p = await probe(tools, file('v.mp4'));
    expect(p).toMatchObject({ kind: 'video', mime: 'video/mp4', width: 320, height: 180 });
    expect(p.durationMs).toBeGreaterThanOrEqual(1900);
    expect(p.durationMs).toBeLessThanOrEqual(2100);
  });

  it('probes an mp3', async () => {
    await synthAudio(tools, file('a.mp3'), { durationSec: 1, format: 'mp3' });
    const p = await probe(tools, file('a.mp3'));
    expect(p).toMatchObject({ kind: 'audio', mime: 'audio/mpeg' });
    expect(Math.abs(p.durationMs! - 1000)).toBeLessThanOrEqual(150);
  });

  it('probes a wav', async () => {
    await synthAudio(tools, file('a.wav'), { durationSec: 1, format: 'wav' });
    expect(await probe(tools, file('a.wav'))).toMatchObject({ kind: 'audio', mime: 'audio/wav' });
  });

  it.each(['mp3', 'm4a'])('%s with embedded cover art is audio, not video', async (ext) => {
    await synthAudio(tools, file('plain.mp3'), { durationSec: 1, format: 'mp3' });
    await synthImage(tools, file('cover.png'), { width: 300, height: 300, color: '#aa3366', format: 'png' });
    const out = file(`cover-art.${ext}`);
    await run(tools.ffmpegPath, [
      '-v',
      'error',
      '-y',
      '-i',
      file('plain.mp3'),
      '-i',
      file('cover.png'),
      '-map',
      '0:a',
      '-map',
      '1:v',
      ...(ext === 'm4a' ? ['-c:a', 'aac'] : ['-c:a', 'copy']),
      '-c:v',
      ext === 'm4a' ? 'png' : 'copy',
      '-disposition:v:0',
      'attached_pic',
      out,
    ]);
    expect(await probe(tools, out)).toMatchObject({ kind: 'audio', mime: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4' });
  });

  it('rotated phone video reports display size', async () => {
    await synthVideo(tools, file('r.mp4'), { width: 320, height: 180, durationSec: 1, color: '#00ffff', rotate: 90 });
    expect(await probe(tools, file('r.mp4'))).toMatchObject({ kind: 'video', width: 180, height: 320 });
  });

  it('rejects a text file with VALIDATION', async () => {
    await writeFile(file('t.mp4'), 'definitely not a video');
    const err = await probe(tools, file('t.mp4')).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(err.message).toContain('Не вдалося прочитати файл');
  });
});

describe('thumbnail', () => {
  it('thumbnail of a video is a 512px webp', async () => {
    await synthVideo(tools, file('big.mp4'), { width: 1280, height: 720, durationSec: 1, color: '#ffffff' });
    await thumbnail(tools, file('big.mp4'), file('big.webp'), { kind: 'video', durationMs: 1000 });
    expect(await probe(tools, file('big.webp'))).toEqual({
      kind: 'image',
      mime: 'image/webp',
      width: 512,
      height: 288,
    });
  });

  it('thumbnail of a small image is not upscaled', async () => {
    await synthImage(tools, file('s.png'), { width: 64, height: 48, color: '#123456', format: 'png' });
    await thumbnail(tools, file('s.png'), file('s.webp'), { kind: 'image' });
    expect(await probe(tools, file('s.webp'))).toMatchObject({ width: 64, height: 48 });
  });

  it('thumbnail of a rotated video is upright', async () => {
    await synthVideo(tools, file('r2.mp4'), { width: 640, height: 360, durationSec: 1, color: '#ff00ff', rotate: 90 });
    await thumbnail(tools, file('r2.mp4'), file('r2.webp'), { kind: 'video', durationMs: 1000 });
    const p = await probe(tools, file('r2.webp'));
    expect(p.height!).toBeGreaterThan(p.width!);
  });
});

describe('run', () => {
  it('times out', async () => {
    await expect(run('sleep', ['5'], { timeoutMs: 200 })).rejects.toThrow(/таймаут/i);
  });
});
