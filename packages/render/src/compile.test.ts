import { describe, expect, it } from 'vitest';
import {
  emptyTimeline,
  type AudioClip,
  type AudioRole,
  type MediaClip,
  type TimelineDoc,
  type Track,
} from '@vf/shared';
import { addClip, coverRect, evalExpr, setEffect, setTransition, setVolume, type AssetInfo } from '@vf/timeline';
import { compileAudioOnly, compileFfmpeg, envelopeExpr, outputSize, transformFilter, type SourceInfo } from './index';

let n = 0;
const ids = () => `c${++n}`;
const src = (assetId: string, kind: SourceInfo['kind'], extra: Partial<SourceInfo> = {}): [string, SourceInfo] => [
  assetId,
  {
    path: `/w/${assetId}`,
    kind,
    width: kind === 'audio' ? undefined : 640,
    height: kind === 'audio' ? undefined : 360,
    hasAudio: kind !== 'image',
    ...extra,
  },
];
const add = (doc: TimelineDoc, a: AssetInfo, at: number) => addClip(doc, a, { at }, ids);
const compile = (doc: TimelineDoc, sources: [string, SourceInfo][], preset: 'final' | 'draft' = 'draft') =>
  compileFfmpeg({ doc, preset, sources: new Map(sources), filterScriptPath: '/w/graph.txt', outPath: '/w/out.mp4' });

/** Аргументи кожного `-i` разом з опціями перед ним. */
function inputs(args: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-i') {
      out.push([...cur, '-i', args[i + 1]!]);
      cur = [];
      i++;
    } else if (['-ss', '-t', '-loop', '-framerate'].includes(args[i]!)) {
      cur.push(args[i]!, args[i + 1]!);
      i++;
    } else cur = [];
  }
  return out;
}

describe('compileFfmpeg', () => {
  const photo: AssetInfo = { id: 'P', kind: 'image' };
  const video: AssetInfo = { id: 'V', kind: 'video', durationSec: 4, hasAudio: true };

  it('one input per visual clip with -ss in -t duration (video) / -loop 1 -framerate 30 -t duration (image)', () => {
    let doc = add(emptyTimeline('9:16'), photo, 0).doc;
    doc = add(doc, video, 5).doc;
    const c = compile(doc, [src('P', 'image'), src('V', 'video')]);
    const ins = inputs(c.args);
    expect(ins[0]).toEqual(['-loop', '1', '-framerate', '30', '-t', '5', '-i', '/w/P']);
    expect(ins[1]).toEqual(['-ss', '0', '-t', '4', '-i', '/w/V']);
  });

  it('overlay enable between(t,start,end) per clip in track order', () => {
    let doc = add(emptyTimeline('9:16'), photo, 1).doc;
    doc = { ...doc, tracks: [...doc.tracks, { id: 'top', kind: 'video', clips: [] }] };
    doc = addClip(doc, { id: 'Q', kind: 'image' }, { at: 0, trackId: 'top' }, ids).doc;
    const c = compile(doc, [src('P', 'image'), src('Q', 'image')]);
    const overlays = c.filterScript.match(/overlay=[^;\n]*/g)!;
    expect(overlays).toHaveLength(2);
    expect(overlays[0]).toContain("enable='between(t,1,6)'");
    expect(overlays[1]).toContain("enable='between(t,0,5)'");
    expect(overlays.every((o) => o.includes('eof_action=pass'))).toBe(true);
  });

  it('setpts shifts by start', () => {
    const doc = add(emptyTimeline('9:16'), photo, 2.5).doc;
    expect(compile(doc, [src('P', 'image')]).filterScript).toContain('setpts=PTS+2.5/TB');
  });

  it('tpad stop_mode=clone after video sources', () => {
    const doc = add(emptyTimeline('9:16'), video, 0).doc;
    expect(compile(doc, [src('V', 'video')]).filterScript).toMatch(
      /\[0:v\][^;]*tpad=stop_mode=clone:stop_duration=4[^;]*trim=duration=4/,
    );
  });

  it('fade alpha filters for fade and xfade', () => {
    let doc = add(emptyTimeline('9:16'), photo, 0).doc;
    doc = setEffect(doc, doc.tracks[0]!.clips[0]!.id, { type: 'fade', params: { in: 0.3, out: 1 } });
    const b = add(doc, { id: 'Q', kind: 'image' }, 5);
    doc = setTransition(b.doc, b.clipIds[0]!, 0.5);
    const g = compile(doc, [src('P', 'image'), src('Q', 'image')]).filterScript;
    expect(g).toContain('fade=t=in:st=0:d=0.3:alpha=1');
    expect(g).toContain('fade=t=out:st=4:d=1:alpha=1');
    expect(g).toContain('fade=t=in:st=0:d=0.5:alpha=1');
    expect(g).toContain('setpts=PTS+4.5/TB');
  });

  it('no zoompan anywhere', () => {
    const doc = add(emptyTimeline('9:16'), photo, 0).doc;
    const c = compile(doc, [src('P', 'image')]);
    expect([...c.args, c.filterScript].join(' ')).not.toContain('zoompan');
  });

  it('audio item → volume, afade, adelay=<ms>:all=1, amix normalize=0 with anullsrc of total duration', () => {
    let doc = add(emptyTimeline('9:16'), photo, 0).doc;
    const m = add(doc, { id: 'M', kind: 'audio', durationSec: 3 }, 1.5);
    doc = setVolume(m.doc, m.clipIds[0]!, 0.5);
    const c = compile(doc, [src('P', 'image'), src('M', 'audio')]);
    expect(inputs(c.args)[1]).toEqual(['-ss', '0', '-t', '3', '-i', '/w/M']);
    expect(c.filterScript).toMatch(/\[1:a\][^;]*volume=0\.5[^;]*adelay=1500:all=1/);
    expect(c.filterScript).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=5');
    expect(c.filterScript).toMatch(/amix=inputs=2:normalize=0:duration=first/);
  });

  it('mono audio goes to both channels at full level (as Web Audio plays it in the preview)', () => {
    const m = add(emptyTimeline('9:16'), { id: 'M', kind: 'audio', durationSec: 3 }, 0);
    expect(compile(m.doc, [src('M', 'audio', { audioChannels: 1 })]).filterScript).toMatch(
      /\[0:a\]pan=stereo\|c0=c0\|c1=c0,/,
    );
    expect(compile(m.doc, [src('M', 'audio', { audioChannels: 2 })]).filterScript).not.toContain('pan=');
  });

  it('audio fades are afade filters', () => {
    const m = add(emptyTimeline('9:16'), { id: 'M', kind: 'audio', durationSec: 3 }, 0);
    const doc = {
      ...m.doc,
      tracks: m.doc.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, fadeIn: 0.5, fadeOut: 1 })) })),
    } as TimelineDoc;
    const g = compile(doc, [src('M', 'audio')]).filterScript;
    expect(g).toContain('afade=t=in:st=0:d=0.5');
    expect(g).toContain('afade=t=out:st=2:d=1');
  });

  it('video clip with hasAudio false is not in amix even if volume > 0', () => {
    const v = add(emptyTimeline('9:16'), { id: 'S', kind: 'video', durationSec: 2, hasAudio: false }, 0);
    const c = compile(setVolume(v.doc, v.clipIds[0]!, 1), [src('S', 'video', { hasAudio: false })]);
    expect(inputs(c.args)).toHaveLength(1);
    expect(c.filterScript).not.toContain('amix');
    expect(c.filterScript).toMatch(/anullsrc=[^;]*\[aout\]/);
  });

  it('draft 9:16 → 720x1280 and -preset veryfast -crf 26', () => {
    const c = compile(add(emptyTimeline('9:16'), photo, 0).doc, [src('P', 'image')], 'draft');
    expect([c.width, c.height]).toEqual([720, 1280]);
    expect(c.args.join(' ')).toContain('-preset veryfast -crf 26');
    expect(c.filterScript).toContain('format=yuv420p[vout]');
    expect(outputSize(emptyTimeline('16:9'), 'draft')).toEqual({ width: 1280, height: 720 });
  });

  it('final → document size, -preset medium -crf 20', () => {
    const c = compile(add(emptyTimeline('16:9'), photo, 0).doc, [src('P', 'image')], 'final');
    expect([c.width, c.height]).toEqual([1920, 1080]);
    expect(c.args.join(' ')).toContain('-preset medium -crf 20');
    expect(c.args.join(' ')).toMatch(/-pix_fmt yuv420p -r 30 .*-c:a aac -b:a 192k -ar 48000/);
    expect(c.args).toContain('+faststart');
  });

  it('uses -filter_complex_script with filterScriptPath and maps outputs', () => {
    const c = compile(add(emptyTimeline('9:16'), photo, 0).doc, [src('P', 'image')]);
    expect(c.args.join(' ')).toContain('-filter_complex_script /w/graph.txt -map [vout] -map [aout]');
    expect(c.args.at(-1)).toBe('/w/out.mp4');
    expect(c.args.join(' ')).toContain('-progress pipe:1');
  });

  it('-t equals docDuration', () => {
    let doc = add(emptyTimeline('9:16'), photo, 0).doc;
    doc = add(doc, { id: 'M', kind: 'audio', durationSec: 7.5 }, 1).doc;
    const c = compile(doc, [src('P', 'image'), src('M', 'audio')]);
    expect(c.durationSec).toBe(8.5);
    expect(c.args[c.args.indexOf('-t', c.args.indexOf('-filter_complex_script')) + 1]).toBe('8.5');
  });

  it('ken burns composes at 2x and downsamples to the output size (smooth sub-pixel motion)', () => {
    const c = compile(add(emptyTimeline('9:16'), photo, 0).doc, [src('P', 'image')], 'draft');
    expect(c.filterScript).toContain('color=c=black:s=1440x2560:r=30');
    expect(c.filterScript).toMatch(/scale=720:1280:flags=area,format=yuv420p\[vout\]/);
    expect([c.width, c.height]).toEqual([720, 1280]);
  });

  it('without ken burns composes at 1x', () => {
    const c = compile(add(emptyTimeline('9:16'), video, 0).doc, [src('V', 'video')], 'draft');
    expect(c.filterScript).toContain('color=c=black:s=720x1280:r=30');
    expect(c.filterScript).not.toContain('flags=area');
  });

  it('missing source → VALIDATION with clip ids', () => {
    const r = add(emptyTimeline('9:16'), photo, 0);
    expect(() => compile(r.doc, [])).toThrow(
      expect.objectContaining({ code: 'VALIDATION', details: { clipIds: r.clipIds } }),
    );
  });

  it('200 clips compile and args stay under 32 KB (graph is in the file)', () => {
    let doc = emptyTimeline('9:16');
    const sources: [string, SourceInfo][] = [];
    for (let i = 0; i < 200; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      doc = add(doc, { id, kind: 'image' }, i * 5).doc;
      sources.push([
        id,
        { path: `/tmp/vf-render-abcdef/${id}.png`, kind: 'image', width: 1200, height: 800, hasAudio: false },
      ]);
    }
    const c = compile(doc, sources);
    expect(c.args.join(' ').length).toBeLessThan(32 * 1024);
    expect(c.filterScript.match(/overlay=/g)).toHaveLength(200);
  });
});

describe('transformFilter', () => {
  const out = { width: 720, height: 1280 };
  const cases = [
    {
      name: 'cover kenburns',
      fit: 'cover' as const,
      srcSize: { width: 1200, height: 1200 },
      kb: { fromScale: 1, toScale: 1.4, fromX: 0.2, fromY: 0.8, toX: 0.6, toY: 0.3 },
    },
    {
      name: 'contain zoom',
      fit: 'contain' as const,
      srcSize: { width: 1920, height: 1080 },
      kb: { fromScale: 0.8, toScale: 0.8, fromX: 0.3, fromY: 0.5, toX: 0.3, toY: 0.5 },
    },
  ];
  for (const c of cases)
    it(`${c.name}: scale/x/y expressions equal coverRect`, () => {
      const effects = [{ type: 'kenburns' as const, params: c.kb }];
      const tf = transformFilter(effects, c.srcSize, out, c.fit, 5, 2);
      for (const p of [0, 0.25, 0.5, 1]) {
        const local = p * 5;
        const s = c.kb.fromScale + (c.kb.toScale - c.kb.fromScale) * p;
        const r = coverRect(
          c.srcSize,
          out,
          c.fit,
          s,
          c.kb.fromX + (c.kb.toX - c.kb.fromX) * p,
          c.kb.fromY + (c.kb.toY - c.kb.fromY) * p,
        );
        const w = evalExpr(tf.w, { t: local });
        const h = evalExpr(tf.h, { t: local });
        expect(w).toBeCloseTo(r.w, 6);
        expect(h).toBeCloseTo(r.h, 6);
        // у оверлеї — глобальний час і фактичний (округлений) розмір кадру
        expect(evalExpr(tf.x, { t: local + 2, overlay_w: w, overlay_h: h })).toBeCloseTo(r.x, 6);
        expect(evalExpr(tf.y, { t: local + 2, overlay_w: w, overlay_h: h })).toBeCloseTo(r.y, 6);
      }
    });
});

describe('speed / hold / envelope / subtitles (language docs from localize)', () => {
  const vclip = (extra: Partial<MediaClip>): MediaClip => ({
    id: 'v1',
    assetId: 'V',
    start: 0,
    duration: 2,
    in: 1,
    fit: 'cover',
    effects: [],
    ...extra,
  });
  const aclip = (extra: Partial<AudioClip>): AudioClip => ({
    id: 'a1',
    assetId: 'A',
    start: 0.5,
    duration: 2,
    in: 1,
    volume: 1,
    ...extra,
  });
  const docOf = (tracks: Track[]): TimelineDoc => ({ ...emptyTimeline('9:16'), tracks });
  const vtrack = (...clips: MediaClip[]): Track => ({ id: 'tv', kind: 'video', clips });
  const atrack = (role: AudioRole, ...clips: AudioClip[]): Track => ({ id: `t-${role}`, kind: 'audio', role, clips });
  const chainOf = (g: string, input: string) => g.split(';\n').find((l) => l.startsWith(`[${input}]`))!;

  it('video speed 0.8 → -t = (duration − hold) × speed, setpts=(PTS-STARTPTS)/0.8; hold → tpad clone', () => {
    const doc = docOf([vtrack(vclip({ speed: 0.8, hold: 0.5 }))]);
    const c = compile(doc, [src('V', 'video', { hasAudio: false })]);
    expect(inputs(c.args)[0]).toEqual(['-ss', '1', '-t', '1.2', '-i', '/w/V']);
    const chain = chainOf(c.filterScript, '0:v');
    expect(chain).toMatch(/^\[0:v\]setpts=\(PTS-STARTPTS\)\/0\.8,fps=30,/);
    // 1.5 с відтворення, потім 0.5 с останнього кадру, разом — тривалість кліпу
    expect(chain).toMatch(/trim=duration=1\.5,tpad=stop_mode=clone:stop_duration=0\.5,trim=duration=2,/);
  });

  it('speed 1 and no hold keep the plain chain', () => {
    const c = compile(docOf([vtrack(vclip({}))]), [src('V', 'video', { hasAudio: false })]);
    expect(inputs(c.args)[0]).toEqual(['-ss', '1', '-t', '2', '-i', '/w/V']);
    expect(chainOf(c.filterScript, '0:v')).toMatch(
      /^\[0:v\]setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=2,trim=duration=2,/,
    );
  });

  it('photo ignores speed/hold: it is simply shown for the whole clip', () => {
    const doc = docOf([vtrack(vclip({ assetId: 'P', speed: 1.25, hold: 0.7 }))]);
    const c = compile(doc, [src('P', 'image')]);
    expect(inputs(c.args)[0]).toEqual(['-loop', '1', '-framerate', '30', '-t', '2', '-i', '/w/P']);
    const chain = chainOf(c.filterScript, '0:v');
    expect(chain).toMatch(/^\[0:v\]setpts=PTS-STARTPTS,fps=30,trim=duration=2,/);
    expect(chain).not.toContain('tpad');
  });

  it('original audio speed 1.25 → atempo=1.25, hold → apad=pad_dur, -t = (duration − hold) × speed', () => {
    const doc = docOf([atrack('original', aclip({ speed: 1.25, hold: 0.4 }))]);
    const c = compile(doc, [src('A', 'audio')]);
    expect(inputs(c.args)[0]).toEqual(['-ss', '1', '-t', '2', '-i', '/w/A']);
    expect(chainOf(c.filterScript, '0:a')).toMatch(
      /asetpts=PTS-STARTPTS,atrim=duration=2,atempo=1\.25,apad=pad_dur=0\.4,atrim=duration=2,volume=1,.*adelay=500:all=1/,
    );
  });

  it('own sound of a video clip with speed also gets atempo', () => {
    const doc = docOf([vtrack(vclip({ speed: 0.8, volume: 1 }))]);
    const c = compile(doc, [src('V', 'video')]);
    expect(c.filterScript).toMatch(/\[1:a\][^;]*atempo=0\.8/);
  });

  it('voiceover never gets atempo (voice is never sped up)', () => {
    const doc = docOf([
      atrack('voiceover', aclip({ speed: 1.25, hold: 0.3 })),
      atrack('original', aclip({ id: 'a2', assetId: 'B' })),
    ]);
    const c = compile(doc, [src('A', 'audio'), src('B', 'audio')]);
    expect(c.filterScript).not.toContain('atempo');
    expect(inputs(c.args)[0]).toEqual(['-ss', '1', '-t', '1.7', '-i', '/w/A']);
    expect(chainOf(c.filterScript, '0:a')).toContain('apad=pad_dur=0.3');
  });

  it("envelope → volume='…':eval=frame equal to linear interpolation × volume", () => {
    const envelope = [
      { t: 0, gain: 1 },
      { t: 0.3, gain: 1 },
      { t: 0.5, gain: 0.32 },
      { t: 1.5, gain: 0.32 },
      { t: 1.7, gain: 1 },
    ];
    const doc = docOf([atrack('original', aclip({ volume: 0.25, envelope }))]);
    const g = compile(doc, [src('A', 'audio')]).filterScript;
    const m = /volume='([^']+)':eval=frame/.exec(chainOf(g, '0:a'));
    expect(m).not.toBeNull();
    const lin = (t: number) => {
      if (t <= envelope[0]!.t) return envelope[0]!.gain;
      for (let i = 1; i < envelope.length; i++) {
        const a = envelope[i - 1]!;
        const b = envelope[i]!;
        if (t <= b.t) return a.gain + ((b.gain - a.gain) * (t - a.t)) / (b.t - a.t);
      }
      return envelope.at(-1)!.gain;
    };
    for (let i = 0; i <= 10; i++) {
      const t = (i / 10) * 2;
      expect(evalExpr(m![1]!, { t })).toBeCloseTo(0.25 * lin(t), 9);
    }
  });

  it('envelopeExpr: start shifts time, outside the points the gain holds, single point is constant', () => {
    const env = [
      { t: 0.2, gain: 0.5 },
      { t: 1, gain: 1.5 },
    ];
    expect(evalExpr(envelopeExpr(2, env, 3), { t: 3 })).toBeCloseTo(1, 9);
    expect(evalExpr(envelopeExpr(2, env, 3), { t: 3.6 })).toBeCloseTo(2, 9);
    expect(evalExpr(envelopeExpr(2, env, 3), { t: 9 })).toBeCloseTo(3, 9);
    expect(evalExpr(envelopeExpr(0.5, [{ t: 0.3, gain: 0.4 }], 0), { t: 7 })).toBeCloseTo(0.2, 9);
  });

  it('subtitles=f=…:fontsdir=… is the last video filter, after the 2× → 1× scale', () => {
    const doc = add(emptyTimeline('9:16'), { id: 'P', kind: 'image' }, 0).doc; // Ken Burns → 2×
    const c = compileFfmpeg({
      doc,
      preset: 'draft',
      sources: new Map([src('P', 'image')]),
      filterScriptPath: '/w/graph.txt',
      outPath: '/w/out.mp4',
      subtitlesPath: '/w/subs.ass',
      fontsDir: '/app/packages/captions/fonts',
    });
    expect(c.filterScript).toMatch(
      /scale=720:1280:flags=area,subtitles=f='\/w\/subs\.ass':fontsdir='\/app\/packages\/captions\/fonts',format=yuv420p\[vout\]/,
    );
  });

  it('subtitles without 2× and without fontsDir', () => {
    const doc = add(emptyTimeline('9:16'), { id: 'V', kind: 'video', durationSec: 4, hasAudio: true }, 0).doc;
    const c = compileFfmpeg({
      doc,
      preset: 'draft',
      sources: new Map([src('V', 'video')]),
      filterScriptPath: '/w/graph.txt',
      outPath: '/w/out.mp4',
      subtitlesPath: '/w/subs.ass',
    });
    expect(c.filterScript).toMatch(/\]subtitles=f='\/w\/subs\.ass',format=yuv420p\[vout\]/);
  });
});

describe('compileAudioOnly', () => {
  const docOf = (tracks: Track[]): TimelineDoc => ({ ...emptyTimeline('9:16'), tracks });
  const sound = (id: string, assetId: string, start: number): AudioClip => ({
    id,
    assetId,
    start,
    duration: 2,
    in: 0,
    volume: 1,
  });
  const doc = docOf([
    {
      id: 'tv',
      kind: 'video',
      clips: [
        { id: 'v1', assetId: 'V', start: 0, duration: 4, in: 0, fit: 'cover', effects: [], volume: 0.5 },
        { id: 'p1', assetId: 'P', start: 4, duration: 2, in: 0, fit: 'cover', effects: [] },
      ],
    },
    { id: 'to', kind: 'audio', role: 'original', clips: [sound('o1', 'O', 1)] },
    { id: 'tm', kind: 'audio', role: 'music', clips: [sound('m1', 'M', 0)] },
  ]);
  const sources = new Map([src('V', 'video'), src('P', 'image'), src('O', 'audio'), src('M', 'audio')]);
  const compileA = (roles: AudioRole[]) =>
    compileAudioOnly({ doc, sources, roles, outPath: '/w/mix.webm', filterScriptPath: '/w/mix.txt' });

  it('mono 16 kHz Opus 32k WebM, no video inputs', () => {
    const c = compileA(['original']);
    const a = c.args.join(' ');
    expect(a).toContain('-ac 1 -ar 16000 -c:a libopus -b:a 32k');
    expect(a).toContain('-filter_complex_script /w/mix.txt -map [aout]');
    expect(a).not.toContain('[vout]');
    expect(a).not.toContain('-loop');
    expect(c.args.at(-1)).toBe('/w/mix.webm');
    expect(c.durationSec).toBe(6);
    expect(c.args[c.args.indexOf('-t', c.args.indexOf('-filter_complex_script')) + 1]).toBe('6');
  });

  it("only the requested roles; 'original' includes own sound of video clips", () => {
    const orig = inputs(compileA(['original']).args).map((i) => i.at(-1));
    expect(orig).toEqual(['/w/V', '/w/O']);
    expect(compileA(['original']).filterScript).toMatch(/\[0:a\][^;]*volume=0\.5/);
    expect(inputs(compileA(['music']).args).map((i) => i.at(-1))).toEqual(['/w/M']);
  });

  it('no matching sounds → silence of the document duration', () => {
    const c = compileA(['voiceover']);
    expect(inputs(c.args)).toHaveLength(0);
    expect(c.filterScript).toMatch(/anullsrc=[^;]*atrim=duration=6\[aout\]/);
  });
});
