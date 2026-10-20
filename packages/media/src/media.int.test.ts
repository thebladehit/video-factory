import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  jpegOrientation,
  peaks,
  probe,
  run,
  synthAudio,
  synthImage,
  synthVideo,
  thumbnail,
  type MediaTools,
} from './index';

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
    expect(p).toEqual({ kind: 'image', mime: 'image/png', width: 64, height: 48, hasAudio: false });
  });

  it('probes a jpg', async () => {
    await synthImage(tools, file('a.jpg'), { width: 64, height: 48, color: '#00ff00', format: 'jpg' });
    expect(await probe(tools, file('a.jpg'))).toEqual({
      kind: 'image',
      mime: 'image/jpeg',
      width: 64,
      height: 48,
      hasAudio: false,
    });
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
      hasAudio: false,
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

  it('with onStdout streams chunks and does not buffer stdout', async () => {
    const chunks: Buffer[] = [];
    const r = await run('printf', ['hello'], { onStdout: (c) => chunks.push(c) });
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(r.stdout.length).toBe(0);
  });
});

describe('audio detection and peaks', () => {
  it('probe reports hasAudio for a video with a tone and not for a silent one', async () => {
    await synthVideo(tools, file('tone.mp4'), { width: 160, height: 90, durationSec: 1, color: '#123456', tone: 440 });
    await synthVideo(tools, file('mute.mp4'), { width: 160, height: 90, durationSec: 1, color: '#123456' });
    expect(await probe(tools, file('tone.mp4'))).toMatchObject({ kind: 'video', hasAudio: true });
    expect(await probe(tools, file('mute.mp4'))).toMatchObject({ kind: 'video', hasAudio: false });
    await synthAudio(tools, file('h.wav'), { durationSec: 1, format: 'wav' });
    expect(await probe(tools, file('h.wav'))).toMatchObject({ kind: 'audio', hasAudio: true, audioChannels: 1 });
  });

  it('peaks of 2s tone ≈ 200 values all > 100', async () => {
    await synthVideo(tools, file('tone2.mp4'), { width: 160, height: 90, durationSec: 2, color: '#123456', tone: 440 });
    const p = await peaks(tools, file('tone2.mp4'));
    expect(Math.abs(p.length - 200)).toBeLessThanOrEqual(3);
    // перші/останні вікна AAC можуть бути тихішими (priming)
    expect([...p.slice(2, -2)].every((v) => v > 100)).toBe(true);
  });

  it('peaks of silence are all 0', async () => {
    await run(tools.ffmpegPath, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=mono',
      '-t',
      '1',
      file('sil.wav'),
    ]);
    const p = await peaks(tools, file('sil.wav'));
    expect(p.length).toBe(100);
    expect(p.every((v) => v === 0)).toBe(true);
  });

  it('peaks streams a 10-minute file without buffering stdout', async () => {
    await run(tools.ffmpegPath, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=8000:cl=mono',
      '-t',
      '600',
      file('long.wav'),
    ]);
    const p = await peaks(tools, file('long.wav'));
    expect(p.length).toBe(60_000);
  }, 60_000);
});

describe('EXIF orientation (phone photos)', () => {
  it('probe reports display size and orientation of a JPEG with Orientation=6', async () => {
    await synthImage(tools, file('rot6.jpg'), {
      width: 64,
      height: 32,
      color: '#ff0000',
      format: 'jpg',
      orientation: 6,
    });
    expect(await probe(tools, file('rot6.jpg'))).toMatchObject({
      kind: 'image',
      width: 32,
      height: 64,
      orientation: 6,
    });
  });

  it('plain JPEG has orientation 1 and stored size', async () => {
    await synthImage(tools, file('rot1.jpg'), { width: 64, height: 32, color: '#ff0000', format: 'jpg' });
    expect(await probe(tools, file('rot1.jpg'))).toMatchObject({ width: 64, height: 32 });
    expect(jpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(1);
  });
});
