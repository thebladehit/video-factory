import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaToolError, probe, run, synthAudio, synthImage, synthVideo, type MediaTools } from '@vf/media';
import { toAss } from '@vf/captions';
import {
  DEFAULT_ORIGINAL,
  emptyTimeline,
  type Effect,
  type MediaClip,
  type TimelineDoc,
  type VideoFormat,
} from '@vf/shared';
import {
  addClip,
  docDuration,
  drawFrame,
  evaluate,
  localize,
  removeEffect,
  setEffect,
  setTransition,
  setVolume,
  type AssetInfo,
  type VoiceTake,
} from '@vf/timeline';
import { compileFfmpeg, createFfmpegRenderer, type CompileInput, type Preset, type SourceInfo } from './index';

const tools: MediaTools = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vf-render-test-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
const file = (name: string) => join(dir, name);

let n = 0;
const ids = () => `c${++n}`;

async function checker(path: string, size = 1200, cells = 8) {
  const cell = size / cells;
  await run(tools.ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=white:s=${size}x${size},format=gray,geq=lum='if(mod(floor(X/${cell})+floor(Y/${cell}),2),255,0)'`,
    '-frames:v',
    '1',
    path,
  ]);
}

async function renderRaw(doc: TimelineDoc, sources: Map<string, SourceInfo>, preset: Preset, name: string) {
  const c = compileFfmpeg({
    doc,
    preset,
    sources,
    filterScriptPath: file(`${name}.txt`),
    outPath: file(`${name}.mp4`),
  });
  await writeFile(c.filterScript ? file(`${name}.txt`) : '', c.filterScript);
  await run(tools.ffmpegPath, c.args, { timeoutMs: 120_000 });
  return { ...c, out: file(`${name}.mp4`) };
}

/** Кадр за номером як grayscale. */
async function grayFrame(path: string, index: number, w: number, h: number): Promise<Uint8Array> {
  const { stdout } = await run(tools.ffmpegPath, [
    '-v',
    'error',
    '-i',
    path,
    '-vf',
    `select=eq(n\\,${index})`,
    '-vsync',
    '0',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ]);
  expect(stdout.length).toBe(w * h);
  return new Uint8Array(stdout);
}

async function grayFrames(path: string, w: number, h: number): Promise<Uint8Array[]> {
  const { stdout } = await run(
    tools.ffmpegPath,
    ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { timeoutMs: 120_000 },
  );
  const out: Uint8Array[] = [];
  for (let i = 0; i + w * h <= stdout.length; i += w * h) out.push(new Uint8Array(stdout.subarray(i, i + w * h)));
  return out;
}

async function expectedGray(doc: TimelineDoc, t: number, imagePath: string, w: number, h: number): Promise<Uint8Array> {
  const img = await loadImage(imagePath);
  const canvas = createCanvas(w, h);
  const layers = evaluate(doc, t, { T: 'image' });
  drawFrame(canvas.getContext('2d'), { width: w, height: h }, layers, () => ({
    image: img,
    width: img.width,
    height: img.height,
  }));
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    out[i] = Math.round(0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!);
  return out;
}

const meanAbsDiff = (a: Uint8Array, b: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};

/** Субпіксельні перетини рівня 127.5 уздовж рядка. */
function crossings(frame: Uint8Array, w: number, row: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < w - 1; x++) {
    const a = frame[row * w + x]!;
    const b = frame[row * w + x + 1]!;
    if (a > 127 !== b > 127) out.push(x + (127.5 - a) / (b - a));
  }
  return out;
}

/**
 * Масштаб кадру = розмір клітинки шахівниці: нахил МНК позицій усіх меж від їх номера,
 * усереднений по смузі рядків (стійко до шуму кодека). Центр — межа, найближча до середини кадру.
 */
function cellMetrics(frame: Uint8Array, w: number, h: number): { cell: number; center: number } {
  let cellSum = 0;
  let centerSum = 0;
  let rows = 0;
  for (let row = Math.floor(h / 2) + 10; row < Math.floor(h / 2) + 60; row += 2) {
    const xs = crossings(frame, w, row).filter((x) => x > 4 && x < w - 5);
    if (xs.length < 3) continue;
    const n = xs.length;
    const mi = (n - 1) / 2;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    xs.forEach((x, i) => {
      num += (i - mi) * (x - mx);
      den += (i - mi) ** 2;
    });
    cellSum += num / den;
    centerSum += xs.reduce((best, x) => (Math.abs(x - w / 2) < Math.abs(best - w / 2) ? x : best), xs[0]!);
    rows++;
  }
  return { cell: cellSum / rows, center: centerSum / rows };
}

describe('preview parity (spike: Ken Burns without zoompan)', () => {
  const W = 720;
  const H = 1280;
  const effectsCases: [string, Effect][] = [
    [
      'kenburns',
      { type: 'kenburns', params: { fromScale: 1, toScale: 1.3, fromX: 0.3, fromY: 0.3, toX: 0.7, toY: 0.6 } },
    ],
    ['zoom', { type: 'zoom', params: { scale: 1.2, x: 0.35, y: 0.6 } }],
  ];
  const kbEffect: Effect = {
    type: 'kenburns',
    params: { fromScale: 1, toScale: 1.3, fromX: 0.3, fromY: 0.3, toX: 0.7, toY: 0.6 },
  };
  const parityCases: [string, Effect | null, { scale: number; x: number; y: number } | null][] = [
    ...effectsCases.map(([n, e]) => [n, e, null] as [string, Effect, null]),
    ['transform 0.5 at (0.3, 0.7)', null, { scale: 0.5, x: 0.3, y: 0.7 }],
    ['transform 0.6 + kenburns', kbEffect, { scale: 0.6, x: 0.3, y: 0.7 }],
  ];
  for (const [name, effect, transform] of parityCases)
    it(`${name} frame matches drawFrame at 0.1 / 2.5 / 4.9 s`, async () => {
      await checker(file('checker.png'));
      const r = addClip(emptyTimeline('9:16'), { id: 'T', kind: 'image' }, { at: 0 }, ids);
      const base = removeEffect(r.doc, r.clipIds[0]!, 'kenburns');
      const withFx = effect ? setEffect(base, r.clipIds[0]!, effect) : base;
      const doc = transform
        ? ({
            ...withFx,
            tracks: withFx.tracks.map((tr) => ({
              ...tr,
              clips: tr.clips.map((c) => ('fit' in c ? { ...c, transform } : c)),
            })),
          } as typeof withFx)
        : withFx;
      const sources = new Map<string, SourceInfo>([
        ['T', { path: file('checker.png'), kind: 'image', width: 1200, height: 1200, hasAudio: false }],
      ]);
      const { out } = await renderRaw(doc, sources, 'draft', `parity-${name}`);
      const diffs: number[] = [];
      for (const t of [0.1, 2.5, 4.9]) {
        const got = await grayFrame(out, Math.round(t * 30), W, H);
        diffs.push(meanAbsDiff(got, await expectedGray(doc, t, file('checker.png'), W, H)));
      }
      console.log(`[spike] ${name} mean abs diff vs drawFrame:`, diffs.map((d) => d.toFixed(2)).join(' / '));
      // поріг = виміряне у спайку (≤ 1.7) × 1.5; критерій плану — ≤ 12
      for (const d of diffs) expect(d).toBeLessThanOrEqual(2.5);
    }, 60_000);

  it('ken burns zoom is smooth and monotonic (no zoompan jitter)', async () => {
    await checker(file('checker.png'));
    const r = addClip(emptyTimeline('9:16'), { id: 'T', kind: 'image' }, { at: 0 }, ids);
    const doc = setEffect(r.doc, r.clipIds[0]!, {
      type: 'kenburns',
      params: { fromScale: 1, toScale: 1.15, fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5 },
    });
    const sources = new Map<string, SourceInfo>([
      ['T', { path: file('checker.png'), kind: 'image', width: 1200, height: 1200, hasAudio: false }],
    ]);
    const { out } = await renderRaw(doc, sources, 'draft', 'smooth');
    const frames = await grayFrames(out, W, H);
    const metrics = frames.map((f) => cellMetrics(f, W, H));
    const cells = metrics.map((m) => m.cell);
    const steps = cells.slice(1).map((v, i) => v - cells[i]!);
    const mean = (cells.at(-1)! - cells[0]!) / steps.length;
    const maxStep = Math.max(...steps);
    const minStep = Math.min(...steps);
    // центр зуму — середина кадру; дозволено округлення позиції overlay до пікселя
    const drift = Math.max(...metrics.map((m) => Math.abs(m.center - metrics[0]!.center)));
    console.log(
      `[spike] cell size per frame: mean ${mean.toFixed(4)} min ${minStep.toFixed(4)} max ${maxStep.toFixed(4)}; center drift ${drift.toFixed(2)} px`,
    );
    expect(mean).toBeGreaterThan(0);
    expect(minStep).toBeGreaterThan(-0.02);
    expect(maxStep).toBeLessThanOrEqual(2 * mean);
    expect(drift).toBeLessThanOrEqual(1);
  }, 60_000);
});

// ---------- рендер на справжньому ffmpeg ----------

const renderer = createFfmpegRenderer(tools);
const fixtures = new Map<string, SourceInfo>();

async function image(id: string, color: string, width = 64, height = 48) {
  const path = file(`${id}.png`);
  await synthImage(tools, path, { width, height, color, format: 'png' });
  fixtures.set(id, { path, kind: 'image', width, height, hasAudio: false });
}
async function video(
  id: string,
  color: string,
  o: { durationSec: number; tone?: number; width?: number; height?: number; rotate?: 90 },
) {
  const path = file(`${id}.mp4`);
  await synthVideo(tools, path, {
    width: o.width ?? 160,
    height: o.height ?? 90,
    durationSec: o.durationSec,
    color,
    tone: o.tone,
    rotate: o.rotate,
  });
  const p = await probe(tools, path);
  fixtures.set(id, {
    path,
    kind: 'video',
    width: p.width,
    height: p.height,
    hasAudio: p.hasAudio,
    audioChannels: p.audioChannels,
  });
}
async function tone(id: string, hz: number, durationSec: number) {
  const path = file(`${id}.wav`);
  await synthAudio(tools, path, { durationSec, format: 'wav', tone: hz });
  fixtures.set(id, { path, kind: 'audio', hasAudio: true, audioChannels: (await probe(tools, path)).audioChannels });
}

const asset = (id: string, extra: Partial<AssetInfo> = {}): AssetInfo => {
  const s = fixtures.get(id)!;
  return { id, kind: s.kind, hasAudio: s.hasAudio, ...extra };
};
/** Фото без Ken Burns — щоб колір кадру був рівний. */
function put(doc: TimelineDoc, a: AssetInfo, at: number, trackId?: string): { doc: TimelineDoc; id: string } {
  const r = addClip(doc, a, { at, trackId }, ids);
  return { doc: removeEffect(r.doc, r.clipIds[0]!, 'kenburns'), id: r.clipIds[0]! };
}

async function renderDoc(doc: TimelineDoc, preset: Preset, name: string, onProgress: (p: number) => void = () => {}) {
  const input: CompileInput = {
    doc,
    preset,
    sources: fixtures,
    filterScriptPath: file(`${name}.txt`),
    outPath: file(`${name}.mp4`),
  };
  await renderer.render(input, { signal: new AbortController().signal, onProgress, timeoutMs: 120_000 });
  return file(`${name}.mp4`);
}

async function rgbAt(path: string, t: number, fx = 0.5, fy = 0.5): Promise<number[]> {
  const meta = await probe(tools, path);
  const x = Math.floor(meta.width! * fx);
  const y = Math.floor(meta.height! * fy);
  const { stdout } = await run(tools.ffmpegPath, [
    '-v',
    'error',
    '-i',
    path,
    '-vf',
    `select=eq(n\\,${Math.round(t * 30)}),format=rgb24,crop=1:1:${x}:${y}`,
    '-vsync',
    '0',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]);
  return [...stdout.subarray(0, 3)];
}
const near = (got: number[], want: number[], tol = 25) => got.every((v, i) => Math.abs(v - want[i]!) <= tol);

async function maxVolume(path: string, from: number, dur: number): Promise<number> {
  const { stderr } = await run(tools.ffmpegPath, [
    '-v',
    'info',
    '-ss',
    String(from),
    '-t',
    String(dur),
    '-i',
    path,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(stderr);
  if (!m) throw new Error(`no volumedetect in: ${stderr.slice(-300)}`);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

const durationOf = async (path: string) => (await probe(tools, path)).durationMs! / 1000;
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const BLACK = [0, 0, 0];

describe('FfmpegRenderer', () => {
  beforeAll(async () => {
    await image('red', '#ff0000');
    await image('blue', '#0000ff');
    await image('odd', '#00ff00', 333, 251);
    await video('vgreen', '#00ff00', { durationSec: 2 });
    await video('vtone', '#ffff00', { durationSec: 2, tone: 440 });
    await video('phone', '#ff00ff', { durationSec: 1, width: 320, height: 180, rotate: 90 });
    await tone('a440', 440, 1);
    await tone('a880', 880, 1);
  }, 60_000);

  it.each(['final', 'draft'] as const)(
    'duration matches docDuration ±1 frame (%s)',
    async (preset) => {
      let doc = put(emptyTimeline('9:16'), asset('red'), 0).doc;
      doc = put(doc, asset('vgreen'), 1.5).doc;
      const out = await renderDoc(doc, preset, `dur-${preset}`);
      expect(Math.abs((await durationOf(out)) - docDuration(doc))).toBeLessThanOrEqual(1 / 30 + 0.001);
    },
    60_000,
  );

  it.each([
    ['9:16', 720, 1280],
    ['16:9', 1280, 720],
  ] as const)(
    'draft output of %s is %ix%i',
    async (format: VideoFormat, w, h) => {
      const out = await renderDoc(put(emptyTimeline(format), asset('red'), 0).doc, 'draft', `size-${w}`);
      expect(await probe(tools, out)).toMatchObject({ width: w, height: h });
    },
    60_000,
  );

  it('gap is black, clip shows its color, upper track covers lower', async () => {
    let doc = put(emptyTimeline('9:16'), asset('red'), 1).doc; // [1,6)
    doc = { ...doc, tracks: [...doc.tracks, { id: 'top', kind: 'video', clips: [] }] };
    doc = put(doc, asset('blue'), 2, 'top').doc; // [2,7)
    const out = await renderDoc(doc, 'draft', 'layers');
    expect(near(await rgbAt(out, 0.5), BLACK)).toBe(true);
    expect(near(await rgbAt(out, 1.5), RED)).toBe(true);
    expect(near(await rgbAt(out, 2.5), BLUE)).toBe(true);
  }, 60_000);

  it('fade-in midpoint is ~50% of the color (±10%)', async () => {
    const r = put(emptyTimeline('9:16'), asset('red'), 0);
    const doc = setEffect(r.doc, r.id, { type: 'fade', params: { in: 1, out: 0 } });
    const [red] = await rgbAt(await renderDoc(doc, 'draft', 'fade'), 0.5);
    expect(Math.abs(red! - 128)).toBeLessThanOrEqual(26);
  }, 60_000);

  it('xfade midpoint blends both clips', async () => {
    const a = put(emptyTimeline('9:16'), asset('red'), 0); // [0,5)
    const b = put(a.doc, asset('blue'), 5);
    const doc = setTransition(b.doc, b.id, 1); // blue [4,9)
    const [r, , bl] = await rgbAt(await renderDoc(doc, 'draft', 'xfade'), 4.5);
    expect(Math.abs(r! - 128)).toBeLessThanOrEqual(26);
    expect(Math.abs(bl! - 128)).toBeLessThanOrEqual(26);
  }, 60_000);

  it('full-length video clip ends on its own color, not black', async () => {
    // durationMs з метаданих трохи більший за справжній потік (2.0 с при 25 кадр/с)
    const r = addClip(
      emptyTimeline('9:16'),
      { id: 'vgreen', kind: 'video', durationSec: 2.06, hasAudio: false },
      { at: 0 },
      ids,
    );
    const clip = r.doc.tracks[0]!.clips[0] as MediaClip;
    expect(clip.duration).toBeCloseTo(2.033, 2);
    const out = await renderDoc(r.doc, 'draft', 'tail');
    expect(near(await rgbAt(out, clip.duration - 1 / 30), [0, 255, 0], 40)).toBe(true);
  }, 60_000);

  it.each([
    ['cover', 'final'],
    ['contain', 'final'],
    ['cover', 'draft'],
    ['contain', 'draft'],
  ] as const)(
    'odd-sized 333x251 image and rotated phone video in 16:9 (%s, %s) render',
    async (fit, preset) => {
      let doc = emptyTimeline('16:9');
      const a = put(doc, asset('odd'), 0);
      const b = put(a.doc, asset('phone'), 5);
      doc = {
        ...b.doc,
        tracks: b.doc.tracks.map((t) =>
          t.kind === 'video' ? { ...t, clips: t.clips.map((c) => ({ ...c, fit })) } : t,
        ),
      } as TimelineDoc;
      const out = await renderDoc(doc, preset, `odd-${fit}-${preset}`);
      const meta = await probe(tools, out);
      expect([meta.width, meta.height]).toEqual(preset === 'final' ? [1920, 1080] : [1280, 720]);
      expect(near(await rgbAt(out, 2), [0, 255, 0], 40)).toBe(true);
      expect(near(await rgbAt(out, 5.5), [255, 0, 255], 40)).toBe(true);
      // contain портретного відео в 16:9 — по боках чорне
      if (fit === 'contain') expect(near(await rgbAt(out, 5.5, 0.05), BLACK)).toBe(true);
    },
    120_000,
  );

  it('phone photo with EXIF Orientation=6 renders upright and undistorted, like the browser shows it', async () => {
    // збережено 64×32: ліва половина червона, права синя; показується 32×64 (поворот на 90°) — червоне зверху
    const path = file('rot6.jpg');
    await synthImage(tools, path, {
      width: 64,
      height: 32,
      color: '#ff0000',
      rightColor: '#0000ff',
      format: 'jpg',
      orientation: 6,
    });
    const p = await probe(tools, path);
    fixtures.set('rot6', { path, kind: 'image', width: p.width, height: p.height, hasAudio: false });
    const r = put(emptyTimeline('16:9'), asset('rot6'), 0);
    const doc = {
      ...r.doc,
      tracks: r.doc.tracks.map((t) =>
        t.kind === 'video' ? { ...t, clips: t.clips.map((c) => ({ ...c, fit: 'contain' as const })) } : t,
      ),
    } as TimelineDoc;
    const out = await renderDoc(doc, 'draft', 'exif');
    // contain портретного 1:2 у 16:9 — смуга 360 px по центру, по боках чорне
    expect(near(await rgbAt(out, 1, 0.15, 0.5), BLACK)).toBe(true);
    expect(near(await rgbAt(out, 1, 0.5, 0.25), RED, 60)).toBe(true);
    expect(near(await rgbAt(out, 1, 0.5, 0.75), BLUE, 60)).toBe(true);
  }, 60_000);

  it('tone inside clip, silence outside', async () => {
    const doc = put(emptyTimeline('9:16'), asset('vtone'), 1).doc; // відео + зв'язане аудіо [1,3)
    const out = await renderDoc(doc, 'draft', 'tone');
    expect(await maxVolume(out, 0, 0.8)).toBeLessThan(-50);
    expect(await maxVolume(out, 1.2, 1.5)).toBeGreaterThan(-10);
  }, 60_000);

  it('volume 0 → silence', async () => {
    const r = addClip(emptyTimeline('9:16'), asset('vtone'), { at: 0 }, ids);
    const doc = setVolume(r.doc, r.clipIds[1]!, 0);
    expect(await maxVolume(await renderDoc(doc, 'draft', 'vol0'), 0, 2)).toBeLessThan(-50);
  }, 60_000);

  it('silent video with volume 1 renders and is silent', async () => {
    const r = addClip(emptyTimeline('9:16'), asset('vgreen'), { at: 0 }, ids);
    expect((r.doc.tracks[0]!.clips[0] as MediaClip).volume).toBe(1);
    // has_audio ще невідомий у документі, але в джерела потоку немає
    const out = await renderDoc(r.doc, 'draft', 'mute');
    expect(await maxVolume(out, 0, 2)).toBeLessThan(-50);
  }, 60_000);

  it('two audio clips mix without clipping normalization (normalize=0)', async () => {
    let doc = put(emptyTimeline('9:16'), asset('red'), 0).doc;
    doc = addClip(doc, asset('a440'), { at: 0 }, ids).doc;
    doc = { ...doc, tracks: [...doc.tracks, { id: 'sfx', kind: 'audio', role: 'sfx', clips: [] }] };
    doc = addClip(doc, asset('a880'), { at: 0.5, trackId: 'sfx' }, ids).doc;
    const out = await renderDoc(doc, 'draft', 'mix');
    // тон 0.5 сам по собі ≈ −6 dB; з нормалізацією amix було б ≈ −15 dB
    expect(await maxVolume(out, 0.05, 0.4)).toBeGreaterThan(-8);
  }, 60_000);

  it('progress reaches >= 95 and is monotonic', async () => {
    const seen: number[] = [];
    await renderDoc(put(emptyTimeline('9:16'), asset('red'), 0).doc, 'draft', 'progress', (p) => seen.push(p));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBeGreaterThanOrEqual(95);
    expect(Math.max(...seen)).toBeLessThanOrEqual(95);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!)).toBe(true);
  }, 60_000);

  it('abort kills ffmpeg and rejects with aborted', async () => {
    const doc = addClip(emptyTimeline('16:9'), asset('red'), { at: 0 }, ids).doc; // Ken Burns, 5 с final
    const ac = new AbortController();
    const started = Date.now();
    const p = renderer.render(
      { doc, preset: 'final', sources: fixtures, filterScriptPath: file('abort.txt'), outPath: file('abort.mp4') },
      { signal: ac.signal, onProgress: () => {}, timeoutMs: 120_000 },
    );
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toMatchObject({ reason: 'aborted' });
    expect(Date.now() - started).toBeLessThan(3000);
  }, 30_000);

  it('timeout rejects', async () => {
    const doc = addClip(emptyTimeline('16:9'), asset('red'), { at: 0 }, ids).doc;
    await expect(
      renderer.render(
        { doc, preset: 'final', sources: fixtures, filterScriptPath: file('to.txt'), outPath: file('to.mp4') },
        { signal: new AbortController().signal, onProgress: () => {}, timeoutMs: 300 },
      ),
    ).rejects.toBeInstanceOf(MediaToolError);
  }, 30_000);

  it('30 short clips render (long graph via file)', async () => {
    const clips: MediaClip[] = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      assetId: i % 2 ? 'red' : 'blue',
      start: Math.round(i * 0.2 * 30) / 30,
      duration: 0.2,
      in: 0,
      fit: 'cover',
      effects: [],
    }));
    const doc: TimelineDoc = { ...emptyTimeline('9:16'), tracks: [{ id: 'v', kind: 'video', clips }] };
    const out = await renderDoc(doc, 'draft', 'many');
    expect(Math.abs((await durationOf(out)) - 6)).toBeLessThanOrEqual(0.05);
    expect(near(await rgbAt(out, 0.1), BLUE)).toBe(true);
    expect(near(await rgbAt(out, 0.3), RED)).toBe(true);
  }, 120_000);
});

// ---------- мовна версія: документ від `localize` ----------

describe('language render (localize → compileFfmpeg)', () => {
  const FONTS = fileURLToPath(new URL('../../captions/fonts', import.meta.url));
  const original = { ...DEFAULT_ORIGINAL };
  const takeOf = (segmentId: string, assetId: string, durationSec: number): VoiceTake => ({
    segmentId,
    assetId,
    durationSec,
    transcriptId: `tr-${segmentId}`,
  });
  /** Рівень сірого в центрі кожного кадру лічильника: кадр N має рівень 10 + 4N. */
  let levels: number[] = [];

  /** Середній рівень сірого квадрата 8×8 у точці (fx, fy) кадру `index`. */
  async function grayAt(path: string, index: number, fx = 0.5, fy = 0.5): Promise<number> {
    const meta = await probe(tools, path);
    const x = Math.floor(meta.width! * fx) - 4;
    const y = Math.floor(meta.height! * fy) - 4;
    const { stdout } = await run(tools.ffmpegPath, [
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      `select=eq(n\\,${index}),crop=8:8:${x}:${y}`,
      '-vsync',
      '0',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      'pipe:1',
    ]);
    expect(stdout.length).toBe(64);
    return [...stdout].reduce((a, b) => a + b, 0) / 64;
  }
  /** Номер кадру лічильника, найближчого за рівнем. */
  const counterFrame = (level: number) =>
    levels.reduce((best, l, k) => (Math.abs(l - level) < Math.abs(levels[best]! - level) ? k : best), 0);

  /** RMS (dB) звуку нижче 800 Гц — тон оригіналу 440 Гц без голосу 3 кГц. */
  async function lowRms(path: string, from: number, dur: number): Promise<number> {
    const { stderr } = await run(tools.ffmpegPath, [
      '-v',
      'info',
      '-ss',
      String(from),
      '-t',
      String(dur),
      '-i',
      path,
      '-vn',
      '-af',
      'lowpass=f=800,lowpass=f=800,lowpass=f=800,volumedetect',
      '-f',
      'null',
      '-',
    ]);
    const m = /mean_volume: (-?[\d.]+) dB/.exec(stderr);
    if (!m) throw new Error(`no volumedetect in: ${stderr.slice(-300)}`);
    return Number(m[1]);
  }

  beforeAll(async () => {
    // лічильник: 2 с, 30 кадр/с, кадр N — сірий 10 + 4N; звук — тон 440 Гц
    const path = file('counter.mp4');
    await run(tools.ffmpegPath, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=160x90:r=30:d=2,format=gray,geq=lum='min(255,10+4*N)'`,
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.5*sin(2*PI*440*t):s=48000:d=2',
      '-c:v',
      'libx264',
      '-crf',
      '10',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      path,
    ]);
    const p = await probe(tools, path);
    fixtures.set('counter', {
      path,
      kind: 'video',
      width: p.width,
      height: p.height,
      hasAudio: p.hasAudio,
      audioChannels: p.audioChannels,
    });
    const frames = await grayFrames(path, p.width!, p.height!);
    levels = frames.map((f) => f[45 * p.width! + 80]!);
    expect(levels).toHaveLength(60);
    await tone('voice1', 3000, 1);
    await tone('voice3', 3000, 3);
    await image('photo', '#ff0000');
  }, 60_000);

  it('speed 0.8 + hold, duration, ducking of the original', async () => {
    let base = put(emptyTimeline('9:16'), asset('counter', { durationSec: 2 }), 0).doc;
    base = { ...base, segments: [{ id: 's1', start: 0, end: 1 }] };
    const { doc, fits } = localize(base, {
      language: 'en',
      takes: [takeOf('s1', 'voice1', 1)],
      original,
      captions: null,
    });
    // T = 0.15 + 1 + 0.35 = 1.5; s = clamp(1/1.5) = 0.8; 1 с джерела за 1.25 с (на сітці кадрів — 38 кадрів)
    // + стоп-кадр до 1.5 с
    expect(fits[0]).toMatchObject({ speed: 0.8, used: 1 });
    expect(fits[0]!.hold).toBeCloseTo(1.5 - 38 / 30, 6);
    const out = await renderDoc(doc, 'draft', 'lang-speed');
    expect(Math.abs((await durationOf(out)) - docDuration(doc))).toBeLessThanOrEqual(1 / 30 + 0.001);
    expect(docDuration(doc)).toBeCloseTo(2.5, 6);

    // середина сповільненої частини: 0.6 с мови = 0.48 с джерела = кадр 14.4
    expect(Math.abs(counterFrame(await grayAt(out, 18)) - 14)).toBeLessThanOrEqual(1);
    // після сегмента темп 1: 2.0 с мови = 1.5 с джерела = кадр 45
    expect(Math.abs(counterFrame(await grayAt(out, 60)) - 45)).toBeLessThanOrEqual(1);
    // стоп-кадр [1.25, 1.5): усі кадри однакові — останній кадр використаної частини (~ кадр 30)
    const held = await Promise.all([38, 40, 42, 44].map((i) => grayAt(out, i)));
    expect(Math.max(...held) - Math.min(...held)).toBeLessThanOrEqual(2);
    expect(Math.abs(counterFrame(held[0]!) - 30)).toBeLessThanOrEqual(1);

    // голос [0.15, 1.15): оригінал 0.08 замість 0.25 (рампи по 0.2 с поза вимірюваними вікнами)
    const under = await lowRms(out, 0.3, 0.7);
    const outside = await lowRms(out, 1.6, 0.8);
    const ratio = 10 ** ((under - outside) / 20);
    expect(Math.abs(ratio - 0.08 / 0.25)).toBeLessThanOrEqual(0.2 * (0.08 / 0.25));
  }, 120_000);

  it('ASS subtitles (preset:classic) appear in the lower third only while the word is on', async () => {
    let doc: TimelineDoc = emptyTimeline('9:16');
    doc = {
      ...doc,
      tracks: [
        {
          id: 'vo',
          kind: 'audio',
          role: 'voiceover',
          language: 'en',
          clips: [{ id: 'vo1', assetId: 'voice3', start: 0, duration: 2, in: 0, volume: 1 }],
        },
        {
          id: 'cap',
          kind: 'captions',
          language: 'en',
          clips: [{ id: 'cc1', audioClipId: 'vo1', transcriptId: 'tr', styleId: 'preset:classic' }],
        },
      ],
    };
    const subtitles = toAss({
      doc,
      transcripts: { tr: { words: [{ text: 'Привіт', startMs: 1000, endMs: 1500 }] } },
      styles: {},
    });
    await renderer.render(
      {
        doc,
        preset: 'draft',
        sources: fixtures,
        filterScriptPath: file('subs-graph.txt'),
        outPath: file('subs.mp4'),
        subtitles,
        fontsDir: FONTS,
      },
      { signal: new AbortController().signal, onProgress: () => {}, timeoutMs: 120_000 },
    );
    const out = file('subs.mp4');
    const W = 720;
    const H = 1280;
    const third = Math.floor((H * 2) / 3) * W;
    const max = (a: Uint8Array) => a.reduce((m, v) => Math.max(m, v), 0);
    const on = await grayFrame(out, 36, W, H); // 1.2 с
    const off = await grayFrame(out, 15, W, H); // 0.5 с
    expect(max(on.subarray(third))).toBeGreaterThan(100);
    expect(max(on.subarray(0, third))).toBeLessThan(20);
    expect(max(off)).toBeLessThan(20);
  }, 120_000);

  it('Review Focus 5: 1-frame segment with 3 s voice and a photo-only segment render with the expected duration', async () => {
    let base = put(emptyTimeline('9:16'), asset('counter', { durationSec: 2 }), 0).doc;
    base = put(base, asset('photo'), 2).doc; // фото [2, 7)
    base = {
      ...base,
      segments: [
        { id: 's1', start: 0, end: 1 / 30 },
        { id: 's2', start: 2, end: 4 },
      ],
    };
    const { doc, fits, map } = localize(base, {
      language: 'en',
      takes: [takeOf('s1', 'voice3', 3), takeOf('s2', 'voice1', 1)],
      original,
      captions: null,
    });
    // 1 кадр джерела + довгий стоп-кадр; фото прискорене (speed ігнорується — просто показ)
    expect(fits[0]).toMatchObject({ speed: 0.8 });
    expect(fits[0]!.hold).toBeGreaterThan(3);
    expect(fits[1]!.speed).toBe(1.25);
    const out = await renderDoc(doc, 'draft', 'lang-rf5');
    expect(Math.abs((await durationOf(out)) - docDuration(doc))).toBeLessThanOrEqual(1 / 30 + 0.001);
    // стоп-кадр першого сегмента — кадр 0 лічильника
    expect(counterFrame(await grayAt(out, Math.round(map(0) * 30) + 45))).toBeLessThanOrEqual(1);
    // фото видно всередині свого сегмента мови
    const mid = (map(2) + map(4 - 1e-3)) / 2;
    expect(near(await rgbAt(out, mid), RED)).toBe(true);
  }, 120_000);
});
