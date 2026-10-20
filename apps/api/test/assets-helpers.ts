import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthAudio, synthImage, synthVideo, type MediaTools } from '@vf/media';
import type { startApp } from './helpers';

type Caller = Awaited<ReturnType<typeof startApp>>['caller'];
export const tools: MediaTools = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };

async function synth(name: string, make: (path: string) => Promise<void>): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'vf-fixture-'));
  try {
    const path = join(dir, name);
    await make(path);
    return new Uint8Array(await readFile(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const pngBytes = (width = 64, height = 48, color = '#ff8800') =>
  synth('a.png', (p) => synthImage(tools, p, { width, height, color, format: 'png' }));
export const mp4Bytes = (durationSec = 2) =>
  synth('v.mp4', (p) => synthVideo(tools, p, { width: 320, height: 180, durationSec, color: '#2244aa' }));
export const mp3Bytes = () => synth('a.mp3', (p) => synthAudio(tools, p, { durationSec: 1, format: 'mp3' }));

/** Повний шлях браузера: createUpload → PUT на presigned URL → complete */
export async function upload(caller: Caller, name: string, mime: string, bytes: Uint8Array) {
  const ticket = await caller.assets.createUpload({ name, mime, size: bytes.length });
  if (ticket.mode !== 'single') throw new Error('expected single upload');
  const res = await fetch(ticket.url, { method: 'PUT', headers: { 'content-type': mime }, body: bytes });
  if (!res.ok) throw new Error(`PUT failed: ${res.status}`);
  await caller.assets.complete({ assetId: ticket.assetId });
  return ticket.assetId;
}

export async function waitForAsset(caller: Caller, id: string, statuses: string[], timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const a = await caller.assets.get({ id });
    if (statuses.includes(a.status)) return a;
    if (Date.now() - started > timeoutMs) throw new Error(`asset ${id} stuck in ${a.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
