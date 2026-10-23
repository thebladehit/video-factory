import type { AudioClip, CaptionClip, Effect, MediaClip, OriginalSound, TimelineDoc, Track } from '@vf/shared';
import { addLinkedAudio, cutEnvelope, findClip, insertTrack } from './ops';
import { sourceTimeAt } from './evaluate';
import { docDuration, quantize, quantizeDown } from './time';
import { voiceTrackOf, withoutForeignVoice } from './voice-track';

/** Пауза перед озвучкою сегмента й після неї (с). */
export const LEAD = 0.15;
export const TAIL = 0.35;
/** Межі темпу відео (голос не прискорюється ніколи). */
export const SPEED_MIN = 0.8;
export const SPEED_MAX = 1.25;
/** Тривалість рампи приглушення оригіналу (с). */
export const DUCK_RAMP = 0.2;

export interface VoiceTake {
  segmentId: string;
  assetId: string;
  durationSec: number;
  transcriptId: string;
}

export interface SegmentFit {
  segmentId: string;
  /** Базова довжина сегмента D. */
  base: number;
  /** Довжина сегмента в мові (`LEAD + V + TAIL`, або D без озвучки). */
  target: number;
  speed: number;
  /** Використано джерела (с базового таймлайну). */
  used: number;
  /** Стоп-кадр у кінці використаної частини. */
  hold: number;
  /** Обрізаний хвіст сегмента. */
  trimmed: number;
}

export interface LocalizeOptions {
  language: string;
  takes: VoiceTake[];
  original: OriginalSound;
  captions: { enabled: boolean; styleId: string } | null;
  newId?: () => string;
}

type AnyClip = MediaClip | AudioClip;
type Envelope = { t: number; gain: number }[];

const EPS = 1e-6;
const defaultId = () => crypto.randomUUID();
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
/** Прибирає похибку float, не зсуваючи час із сітки кадрів. */
const clean = (v: number) => Math.round(v * 1e9) / 1e9;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Підгонка сегмента довжини `D` під озвучку `V` (усі значення — на сітці кадрів):
 * `T = LEAD + V + TAIL`, `s = clamp(D/T, 0.8, 1.25)`, `used = min(D, T·s)`, `hold = T − used/s`, `trimmed = D − used`.
 */
export function fitSegment(D: number, V: number | null, fps: number): Omit<SegmentFit, 'segmentId'> {
  if (V === null) return { base: D, target: D, speed: 1, used: D, hold: 0, trimmed: 0 };
  const frame = 1 / fps;
  const target = Math.max(frame, quantize(LEAD + V + TAIL, fps));
  const s0 = D / target;
  // темп у межах — весь сегмент відтворюється без стоп-кадру й обрізання (округлений `speed` не має
  // «з'їдати» кадр через `target·speed < D`)
  if (s0 >= SPEED_MIN && s0 <= SPEED_MAX) return { base: D, target, speed: round6(s0), used: D, hold: 0, trimmed: 0 };
  const speed = clamp(s0, SPEED_MIN, SPEED_MAX);
  const used = Math.max(frame, Math.min(D, quantizeDown(target * speed, fps)));
  // відтворення округлюється до кадру; стоп-кадр — залишок до цілі (≥ 0, на сітці)
  const play = Math.min(target, Math.max(frame, quantize(used / speed, fps)));
  return { base: D, target, speed, used, hold: quantize(target - play, fps), trimmed: quantize(D - used, fps) };
}

/** Відрізок базового таймлайну з власним законом часу. */
interface Region {
  a: number;
  b: number;
  /** Початок у мові. */
  lang: number;
  kind: 'gap' | 'used' | 'tail';
  speed: number;
  /** Стоп-кадр на кінці `used`. */
  hold: number;
}

const langAt = (r: Region, t: number) => (r.kind === 'tail' ? r.lang : r.lang + (t - r.a) / r.speed);

/** Регіони, що покривають `[0, ∞)`: проміжки (темп 1), використані частини сегментів, обрізані хвости. */
function buildRegions(fits: { start: number; end: number; fit: Omit<SegmentFit, 'segmentId'> }[]): Region[] {
  const out: Region[] = [];
  let shift = 0;
  let cursor = 0;
  for (const { start: a, end: b, fit } of fits) {
    // сегмент без змін (без озвучки або рівно за довжиною) — частина проміжку
    if (fit.speed === 1 && fit.hold === 0 && fit.trimmed === 0) continue;
    if (a > cursor + EPS) out.push({ a: cursor, b: a, lang: cursor + shift, kind: 'gap', speed: 1, hold: 0 });
    const A = a + shift;
    out.push({ a, b: a + fit.used, lang: A, kind: 'used', speed: fit.speed, hold: fit.hold });
    if (fit.trimmed > EPS) out.push({ a: a + fit.used, b, lang: A + fit.target, kind: 'tail', speed: 1, hold: 0 });
    shift += fit.target - fit.base;
    cursor = b;
  }
  out.push({ a: cursor, b: Infinity, lang: cursor + shift, kind: 'gap', speed: 1, hold: 0 });
  return out;
}

const law = (a: number, b: number, p: number) => (p <= 0 ? a : p >= 1 ? b : a + (b - a) * p);

/** Ефекти шматка `[p0, p1]` (прогрес у базовому кліпі): Ken Burns — значення базового закону на кінцях. */
function pieceEffects(effects: Effect[], p0: number, p1: number, first: boolean, last: boolean): Effect[] {
  const out: Effect[] = [];
  for (const e of effects) {
    if (e.type === 'kenburns') {
      const k = e.params;
      out.push({
        type: 'kenburns',
        params: {
          fromScale: law(k.fromScale, k.toScale, p0),
          toScale: law(k.fromScale, k.toScale, p1),
          fromX: law(k.fromX, k.toX, p0),
          toX: law(k.fromX, k.toX, p1),
          fromY: law(k.fromY, k.toY, p0),
          toY: law(k.fromY, k.toY, p1),
        },
      });
    } else if (e.type === 'fade') {
      if (first && last) out.push(e);
      else if (first && e.params.in > 0) out.push({ type: 'fade', params: { in: e.params.in, out: 0 } });
      else if (last && e.params.out > 0) out.push({ type: 'fade', params: { in: 0, out: e.params.out } });
    } else if (e.type === 'xfade') {
      // тривалість переходу перераховується після розкладки доріжки
      if (first) out.push(e);
    } else out.push(e);
  }
  return out;
}

interface Piece {
  clip: AnyClip;
  region: number;
  baseStart: number;
  start: number;
  duration: number;
  hold: number;
  first: boolean;
  last: boolean;
  p0: number;
  p1: number;
}

/** Розрізає кліп по регіонах (кінець — `end`, можливо скорочений під перехід); шматки хвостів відкидаються. */
function cutClip(clip: AnyClip, end: number, regions: Region[], fps: number): Piece[] {
  const frame = 1 / fps;
  const pieces: Piece[] = [];
  regions.forEach((r, i) => {
    const p = Math.max(clip.start, r.a);
    const q = Math.min(end, r.b);
    if (q - p < EPS || r.kind === 'tail') return;
    const start = quantize(langAt(r, p), fps);
    const playEnd = quantize(langAt(r, q), fps);
    // шматок, коротший за кадр після прискорення, зливається з сусідом (кадр той самий)
    if (playEnd - start < frame - EPS) return;
    const hold = r.kind === 'used' && Math.abs(q - r.b) < EPS ? r.hold : 0;
    pieces.push({
      clip,
      region: i,
      baseStart: p,
      start,
      duration: quantize(playEnd - start + hold, fps),
      hold,
      first: false,
      last: false,
      p0: (p - clip.start) / clip.duration,
      p1: (q - clip.start) / clip.duration,
    });
  });
  if (pieces.length) {
    pieces[0]!.first = true;
    pieces[pieces.length - 1]!.last = true;
  }
  return pieces;
}

/** Перехід (`xfade`) через межу регіону: попередній кліп (і зв'язані) закінчується на межі. */
function xfadeCutoffs(doc: TimelineDoc, regions: Region[]): Map<string, number> {
  const cuts = regions.flatMap((r) => [r.a, r.b]).filter((t) => Number.isFinite(t));
  const ends = new Map<string, number>();
  for (const track of doc.tracks) {
    if (track.kind !== 'video') continue;
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    for (const b of clips) {
      if (!b.effects.some((e) => e.type === 'xfade')) continue;
      for (const a of clips) {
        if (a === b || a.start >= b.start - EPS) continue;
        const aEnd = a.start + a.duration;
        if (aEnd <= b.start + EPS) continue;
        const c = cuts.find((t) => t > b.start + EPS && t < aEnd - EPS);
        if (c !== undefined) ends.set(a.id, Math.min(ends.get(a.id) ?? Infinity, c));
      }
    }
  }
  // зв'язаний «Звук відео» скорочується разом із відео
  const byLink = new Map<string, number>();
  for (const track of doc.tracks)
    if (track.kind === 'video')
      for (const c of track.clips) if (c.linkId && ends.has(c.id)) byLink.set(c.linkId, ends.get(c.id)!);
  for (const track of doc.tracks)
    if (track.kind === 'audio' && track.role === 'original')
      for (const c of track.clips) if (c.linkId && byLink.has(c.linkId)) ends.set(c.id, byLink.get(c.linkId)!);
  return ends;
}

/** Множник гучності оригіналу в часі мови: 1 поза голосом, `ratio` під голосом, рампи `DUCK_RAMP`. */
function duckCurve(voices: [number, number][], ratio: number): Envelope {
  const zones: [number, number][] = [];
  for (const [s, e] of [...voices].sort((x, y) => x[0] - y[0])) {
    const prev = zones[zones.length - 1];
    // рампи сусідніх голосів перекрилися б — тримаємо приглушення між ними
    if (prev && s - prev[1] <= 2 * DUCK_RAMP + EPS) prev[1] = Math.max(prev[1], e);
    else zones.push([s, e]);
  }
  return zones.flatMap(([s, e]) => [
    { t: s - DUCK_RAMP, gain: 1 },
    { t: s, gain: ratio },
    { t: e, gain: ratio },
    { t: e + DUCK_RAMP, gain: 1 },
  ]);
}

function sample(curve: Envelope, t: number): number {
  if (!curve.length || t <= curve[0]!.t) return curve[0]?.gain ?? 1;
  for (let i = 1; i < curve.length; i++) {
    const b = curve[i]!;
    if (t <= b.t) {
      const a = curve[i - 1]!;
      return a.gain + ((b.gain - a.gain) * (t - a.t)) / (b.t - a.t);
    }
  }
  return curve[curve.length - 1]!.gain;
}

/** Огинаюча кліпа `[start, start + duration]` з кривої мови; `undefined`, якщо скрізь 1. */
function clipEnvelope(curve: Envelope, start: number, duration: number): Envelope | undefined {
  const end = start + duration;
  const pts: Envelope = [{ t: 0, gain: round6(sample(curve, start)) }];
  for (const p of curve)
    if (p.t > start + EPS && p.t < end - EPS) pts.push({ t: round6(p.t - start), gain: round6(p.gain) });
  pts.push({ t: round6(duration), gain: round6(sample(curve, end)) });
  return pts.every((p) => Math.abs(p.gain - 1) < EPS) ? undefined : pts;
}

/**
 * Документ мови: відео підлаштовується під озвучку кожного сегмента (голос не прискорюється).
 * Вихід — звичайний `TimelineDoc` без `segments` + кусково-лінійна карта часу «база → мова». Вхід не мутується.
 * Доріжки `voiceover` інших мов прибираються. Якщо в документі є доріжка озвучки цієї мови (базова мова,
 * спека §3.3) — підгонки немає, доріжка лишається як є, а приглушення й субтитри будуються за її кліпами
 * (`transcriptId` — з дубля з тим самим `assetId`).
 */
export function localize(
  input: TimelineDoc,
  opts: LocalizeOptions,
): { doc: TimelineDoc; fits: SegmentFit[]; map: (tBase: number) => number } {
  const fps = input.fps;
  const frame = 1 / fps;
  const newId = opts.newId ?? defaultId;
  const doc = withOwnSoundLinked(withoutForeignVoice(input, opts.language), newId);
  const baseDur = docDuration(doc);
  const voiceTrack = voiceTrackOf(doc, opts.language);

  // 1. Сегменти в межах документа (частини за `docDuration` відкидаються) і їхня підгонка
  const takes = new Map<string, VoiceTake>();
  // доріжка озвучки є — дублі не підганяють сегменти
  if (!voiceTrack) for (const t of opts.takes) if (!takes.has(t.segmentId)) takes.set(t.segmentId, t);
  const segs = [...(doc.segments ?? [])]
    .sort((a, b) => a.start - b.start)
    .map((s) => ({
      id: s.id,
      start: quantize(Math.max(0, s.start), fps),
      end: quantize(Math.min(baseDur, s.end), fps),
    }))
    .filter((s) => s.end - s.start >= frame - EPS);
  const fitted = segs.map((s) => {
    const take = takes.get(s.id);
    return { ...s, take, fit: fitSegment(s.end - s.start, take ? take.durationSec : null, fps) };
  });
  const fits: SegmentFit[] = fitted.map((s) => ({ segmentId: s.id, ...s.fit }));

  // 2. Карта часу
  const regions = buildRegions(fitted);
  // неперервна справа: на межі сегмента зі стоп-кадром — початок наступного регіону (після `hold`)
  const map = (tBase: number): number => {
    const t = Math.max(0, tBase);
    const r = regions.find((x) => t < x.b - EPS) ?? regions[regions.length - 1]!;
    return quantize(langAt(r, Math.max(t, r.a)), fps);
  };
  const newDur = quantize(baseDur + (regions[regions.length - 1]!.lang - regions[regions.length - 1]!.a), fps);

  // 5. Озвучка (потрібна раніше за оригінал — для приглушення)
  const voiceClips: AudioClip[] = [];
  const captionClips: CaptionClip[] = [];
  const langStart = new Map(fitted.map((s) => [s.id, map(s.start)]));
  if (voiceTrack) {
    const byAsset = new Map<string, VoiceTake>();
    for (const t of opts.takes) if (!byAsset.has(t.assetId)) byAsset.set(t.assetId, t);
    for (const clip of voiceTrack.clips) {
      voiceClips.push(clip);
      const take = byAsset.get(clip.assetId);
      if (take && opts.captions?.enabled)
        captionClips.push({
          id: newId(),
          audioClipId: clip.id,
          transcriptId: take.transcriptId,
          styleId: opts.captions.styleId,
        });
    }
  }
  for (const s of fitted) {
    if (!s.take) continue;
    const clip: AudioClip = {
      id: newId(),
      assetId: s.take.assetId,
      start: quantize(langStart.get(s.id)! + LEAD, fps),
      duration: Math.max(frame, quantizeDown(s.take.durationSec, fps)),
      in: 0,
      volume: 1,
    };
    voiceClips.push(clip);
    if (opts.captions?.enabled)
      captionClips.push({
        id: newId(),
        audioClipId: clip.id,
        transcriptId: s.take.transcriptId,
        styleId: opts.captions.styleId,
      });
  }

  // 6. Гучність оригіналу
  const { mode, level, duckLevel } = opts.original;
  const gain = mode === 'replace' ? 0 : level;
  const curve =
    mode === 'duck' && level > 0
      ? duckCurve(
          voiceClips.map((c) => [c.start, c.start + c.duration]),
          clamp(duckLevel / level, 0, 2),
        )
      : [];

  // 3. Візуальні кліпи й «Звук відео»: розрізання по регіонах
  const cutoffs = xfadeCutoffs(doc, regions);
  const piecesByTrack = new Map<string, Piece[]>();
  for (const track of doc.tracks) {
    if (track.kind === 'video' || (track.kind === 'audio' && track.role === 'original')) {
      const pieces = (track.clips as AnyClip[]).flatMap((c) =>
        cutClip(c, cutoffs.get(c.id) ?? c.start + c.duration, regions, fps),
      );
      piecesByTrack.set(track.id, pieces);
    }
  }
  // нові `linkId` для шматків: регіон, де група починається, зберігає старий
  const firstRegion = new Map<string, number>();
  for (const pieces of piecesByTrack.values())
    for (const p of pieces)
      if (p.clip.linkId) firstRegion.set(p.clip.linkId, Math.min(firstRegion.get(p.clip.linkId) ?? Infinity, p.region));
  const links = new Map<string, string>();
  const linkFor = (linkId: string, region: number) => {
    if (firstRegion.get(linkId) === region) return linkId;
    const key = `${linkId}#${region}`;
    if (!links.has(key)) links.set(key, newId());
    return links.get(key)!;
  };

  const build = (p: Piece, isAudio: boolean): AnyClip => {
    const c = p.clip;
    const r = regions[p.region]!;
    const out = {
      ...c,
      id: p.first ? c.id : newId(),
      start: p.start,
      duration: p.duration,
      in: clean(sourceTimeAt(c, p.baseStart)),
    } as AnyClip;
    delete out.speed;
    delete out.hold;
    const speed = r.kind === 'used' ? r.speed : (c.speed ?? 1);
    if (speed !== 1) out.speed = speed;
    if (p.hold > EPS) out.hold = p.hold;
    if (c.linkId) out.linkId = linkFor(c.linkId, p.region);
    if (isAudio) {
      const a = out as AudioClip;
      delete a.fadeIn;
      delete a.fadeOut;
      delete a.envelope;
      const src = c as AudioClip;
      if (p.first && src.fadeIn !== undefined) a.fadeIn = src.fadeIn;
      if (p.last && src.fadeOut !== undefined) a.fadeOut = src.fadeOut;
      a.volume = a.volume * gain;
      const env = clipEnvelope(curve, a.start, a.duration);
      if (env && a.volume > 0) a.envelope = env;
    } else {
      const m = out as MediaClip;
      m.effects = pieceEffects((c as MediaClip).effects, p.p0, p.p1, p.first, p.last);
      if (m.volume) m.volume = m.volume * gain;
    }
    return out;
  };

  const tracks: Track[] = [];
  for (const track of doc.tracks) {
    const pieces = piecesByTrack.get(track.id);
    if (track.kind === 'video') {
      const clips = (pieces ?? []).map((p) => build(p, false) as MediaClip).sort((a, b) => a.start - b.start);
      fixTransitions(clips, pieces ?? [], fps);
      tracks.push({ ...track, clips });
    } else if (track.kind === 'audio' && pieces) {
      const clips = pieces.map((p) => build(p, true) as AudioClip).sort((a, b) => a.start - b.start);
      tracks.push({ ...track, clips });
    } else if (track.kind === 'audio') {
      // 4. Музика, sfx і базова озвучка: позиції як є, обрізання по новій тривалості
      const clips: AudioClip[] = [];
      for (const c of track.clips) {
        if (c.start >= newDur - EPS) continue;
        if (c.start + c.duration <= newDur + EPS) {
          clips.push(c);
          continue;
        }
        const duration = quantize(newDur - c.start, fps);
        if (duration < frame - EPS) continue;
        const cut: AudioClip = { ...c, duration };
        if (c.envelope) cut.envelope = cutEnvelope(c.envelope, duration);
        if (c.hold !== undefined) {
          const h = Math.min(c.hold, duration - frame);
          if (h > EPS) cut.hold = quantize(h, fps);
          else delete cut.hold;
        }
        clips.push(cut);
      }
      tracks.push({ ...track, clips });
    } else tracks.push(track);
  }

  let out: TimelineDoc = { schemaVersion: 1, width: doc.width, height: doc.height, fps, tracks };
  if (voiceClips.length && !voiceTrack)
    out = insertTrack(out, {
      id: newId(),
      kind: 'audio',
      role: 'voiceover',
      language: opts.language,
      clips: voiceClips,
    });
  if (captionClips.length)
    out = insertTrack(out, { id: newId(), kind: 'captions', language: opts.language, clips: captionClips });
  return { doc: out, fits, map };
}

/**
 * Власний звук відео-кліпів (`volume > 0` без зв'язаного аудіо) виноситься в кліп ролі `original`,
 * щоб на нього діяли `replace`/`duck` з огинаючою; `fade` відео переходить у `fadeIn/fadeOut` звуку.
 */
function withOwnSoundLinked(doc: TimelineDoc, newId: () => string): TimelineDoc {
  let out = doc;
  for (const track of doc.tracks) {
    if (track.kind !== 'video') continue;
    for (const v of track.clips) {
      if (!v.volume || v.linkId) continue;
      out = addLinkedAudio(out, v.id, newId);
      const linkId = (findClip(out, v.id)?.clip as MediaClip | undefined)?.linkId;
      const fade = v.effects.find((e) => e.type === 'fade');
      if (!linkId || fade?.type !== 'fade') continue;
      out = {
        ...out,
        tracks: out.tracks.map((t) =>
          t.kind === 'audio'
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.linkId === linkId
                    ? {
                        ...c,
                        ...(fade.params.in > 0 ? { fadeIn: fade.params.in } : {}),
                        ...(fade.params.out > 0 ? { fadeOut: fade.params.out } : {}),
                      }
                    : c,
                ),
              }
            : t,
        ),
      };
    }
  }
  return out;
}

/** `xfade` першого шматка = перекриття з попередніми кліпами доріжки в мові; без перекриття — прибирається. */
function fixTransitions(clips: MediaClip[], pieces: Piece[], fps: number) {
  const frame = 1 / fps;
  const firstPiece = new Map(pieces.filter((p) => p.first).map((p) => [p.clip.id, p]));
  for (const c of clips) {
    const i = c.effects.findIndex((e) => e.type === 'xfade');
    if (i < 0) continue;
    const p = firstPiece.get(c.id);
    // перехід лише там, де кліп справді починається (не обрізаний хвостом сегмента)
    const prevEnd = Math.max(
      -Infinity,
      ...clips.filter((o) => o !== c && o.start < c.start - EPS).map((o) => o.start + o.duration),
    );
    const d = quantize(prevEnd - c.start, fps);
    if (p && Math.abs(p.baseStart - p.clip.start) < EPS && d >= frame - EPS)
      c.effects[i] = { type: 'xfade', params: { duration: d } };
    else c.effects.splice(i, 1);
  }
}
