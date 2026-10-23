import {
  DEFAULT_TRANSFORM,
  EFFECT_DEFAULTS,
  FORMATS,
  type AudioClip,
  type AudioRole,
  type ClipTransform,
  type Effect,
  type EffectType,
  type MediaClip,
  type TimelineDoc,
  type Track,
  type VideoFormat,
} from '@vf/shared';
import { quantize, quantizeDown } from './time';

export interface AssetInfo {
  id: string;
  kind: 'image' | 'video' | 'audio';
  durationSec?: number;
  hasAudio?: boolean | null;
}

/** Тривалість джерела в секундах за `assetId`; `undefined` — фото або невідомо (без меж). */
export type SourceLengths = Record<string, number | undefined>;

type AnyClip = MediaClip | AudioClip;
type ClipTrack = Exclude<Track, { kind: 'captions' }>;
interface Found {
  track: ClipTrack;
  clip: AnyClip;
}

export const PHOTO_DURATION = 5;
const EPS = 1e-6;
const defaultId = () => crypto.randomUUID();
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

const clipTracks = (doc: TimelineDoc) => doc.tracks.filter((t): t is ClipTrack => t.kind !== 'captions');

export function findClip(doc: TimelineDoc, clipId: string): Found | null {
  for (const track of clipTracks(doc)) {
    const clip = (track.clips as AnyClip[]).find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** Кліп і всі зв'язані з ним (той самий `linkId`). */
function group(doc: TimelineDoc, clipId: string): Found[] {
  const main = findClip(doc, clipId);
  if (!main) return [];
  const out = [main];
  if (!main.clip.linkId) return out;
  for (const track of clipTracks(doc))
    for (const clip of track.clips as AnyClip[])
      if (clip.linkId === main.clip.linkId && clip.id !== clipId) out.push({ track, clip });
  return out;
}

const sortClips = <T extends AnyClip>(clips: T[]) => [...clips].sort((a, b) => a.start - b.start);

/** Застосовує `fn` до кожного кліпу; `null` видаляє кліп. */
function mapClips(doc: TimelineDoc, fn: (clip: AnyClip, track: ClipTrack) => AnyClip | null): TimelineDoc {
  let changed = false;
  const tracks = doc.tracks.map((track) => {
    if (track.kind === 'captions') return track;
    const clips: AnyClip[] = [];
    let trackChanged = false;
    for (const c of track.clips as AnyClip[]) {
      const next = fn(c, track);
      if (next !== c) trackChanged = true;
      if (next) clips.push(next);
    }
    if (!trackChanged) return track;
    changed = true;
    return { ...track, clips: sortClips(clips) } as Track;
  });
  return changed ? { ...doc, tracks } : doc;
}

const xfadeOf = (clip: AnyClip): number =>
  'effects' in clip
    ? ((clip.effects.find((e) => e.type === 'xfade')?.params as { duration: number } | undefined)?.duration ?? 0)
    : 0;

/** Інтервал, який кліп «займає» на доріжці: голова в межах `xfade` може перекривати попередній кліп. */
function occupied(clip: AnyClip, fps: number): [number, number] {
  const head = Math.min(xfadeOf(clip), clip.duration - 1 / fps);
  return [clip.start + Math.max(0, head), clip.start + clip.duration];
}

interface Member {
  obstacles: AnyClip[];
  offset: number;
  duration: number;
  head: number;
}

/** Найближчий до `desired` старт, за якого жоден учасник не перетинає перешкод на своїй доріжці. */
function freeStart(desired: number, members: Member[], fps: number): number {
  const minStart = Math.max(...members.map((m) => -m.offset));
  const forbidden: [number, number][] = [];
  for (const m of members)
    for (const o of m.obstacles) {
      const [a, b] = occupied(o, fps);
      const lo = a - m.offset - m.duration;
      const hi = b - m.offset - m.head;
      if (hi - lo > EPS) forbidden.push([lo, hi]);
    }
  const ok = (s: number) => s >= minStart - EPS && forbidden.every(([lo, hi]) => s <= lo + EPS || s >= hi - EPS);
  const candidates = [Math.max(desired, minStart), ...forbidden.flat()].filter(ok);
  if (!candidates.length) return desired;
  candidates.sort((x, y) => Math.abs(x - desired) - Math.abs(y - desired) || y - x);
  return quantize(candidates[0]!, fps);
}

const TRACK_RANK: Record<string, number> = { video: 0, original: 1, music: 2, voiceover: 3, sfx: 4, captions: 5 };
const rank = (t: Track) => TRACK_RANK[t.kind === 'audio' ? t.role : t.kind] ?? 9;

export function insertTrack(doc: TimelineDoc, track: Track): TimelineDoc {
  const r = rank(track);
  let idx = 0;
  doc.tracks.forEach((t, i) => {
    if (rank(t) <= r) idx = i + 1;
  });
  return { ...doc, tracks: [...doc.tracks.slice(0, idx), track, ...doc.tracks.slice(idx)] };
}

function ensureTrack(
  doc: TimelineDoc,
  want: { kind: 'video' } | { kind: 'audio'; role: AudioRole },
  trackId: string | undefined,
  newId: () => string,
): { doc: TimelineDoc; track: ClipTrack } {
  const tracks = clipTracks(doc);
  const byId = trackId ? tracks.find((t) => t.id === trackId && t.kind === want.kind) : undefined;
  if (byId) return { doc, track: byId };
  const existing = tracks.find(
    (t) => t.kind === want.kind && (want.kind === 'video' || (t.kind === 'audio' && t.role === want.role)),
  );
  if (existing) return { doc, track: existing };
  const track: ClipTrack =
    want.kind === 'video'
      ? { id: newId(), kind: 'video', clips: [] }
      : { id: newId(), kind: 'audio', role: want.role, clips: [] };
  return { doc: insertTrack(doc, track), track };
}

function putClip(doc: TimelineDoc, trackId: string, clip: AnyClip): TimelineDoc {
  return {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t.id === trackId && t.kind !== 'captions'
        ? ({ ...t, clips: sortClips([...(t.clips as AnyClip[]), clip]) } as Track)
        : t,
    ),
  };
}

const lengthOf = (asset: AssetInfo, fps: number) =>
  asset.kind === 'image' || !asset.durationSec
    ? PHOTO_DURATION
    : Math.max(1 / fps, quantizeDown(asset.durationSec, fps));

const trackClips = (doc: TimelineDoc, trackId: string) =>
  (clipTracks(doc).find((t) => t.id === trackId)?.clips ?? []) as AnyClip[];

export function addClip(
  doc: TimelineDoc,
  asset: AssetInfo,
  opts: { at: number; trackId?: string },
  newId: () => string = defaultId,
): { doc: TimelineDoc; clipIds: string[] } {
  const fps = doc.fps;
  const at = quantize(Math.max(0, opts.at), fps);
  const duration = lengthOf(asset, fps);

  if (asset.kind === 'audio') {
    const r = ensureTrack(doc, { kind: 'audio', role: 'music' }, opts.trackId, newId);
    const start = freeStart(at, [{ obstacles: trackClips(r.doc, r.track.id), offset: 0, duration, head: 0 }], fps);
    const clip: AudioClip = { id: newId(), assetId: asset.id, start, in: 0, duration, volume: 1 };
    return { doc: putClip(r.doc, r.track.id, clip), clipIds: [clip.id] };
  }

  const v = ensureTrack(doc, { kind: 'video' }, opts.trackId, newId);
  const linked = asset.kind === 'video' && asset.hasAudio === true;
  let next = v.doc;
  let audioTrackId: string | null = null;
  const members: Member[] = [{ obstacles: trackClips(next, v.track.id), offset: 0, duration, head: 0 }];
  if (linked) {
    const a = ensureTrack(next, { kind: 'audio', role: 'original' }, undefined, newId);
    next = a.doc;
    audioTrackId = a.track.id;
    members.push({ obstacles: trackClips(next, a.track.id), offset: 0, duration, head: 0 });
  }
  const start = freeStart(at, members, fps);
  const linkId = linked ? newId() : undefined;
  const clip: MediaClip = {
    id: newId(),
    assetId: asset.id,
    start,
    in: 0,
    duration,
    fit: 'cover',
    effects: asset.kind === 'image' ? [{ type: 'kenburns', params: { ...EFFECT_DEFAULTS.kenburns } }] : [],
    ...(asset.kind === 'video' ? { volume: linked ? 0 : 1 } : {}),
    ...(linkId ? { linkId } : {}),
  };
  next = putClip(next, v.track.id, clip);
  if (!audioTrackId) return { doc: next, clipIds: [clip.id] };
  const audio: AudioClip = { id: newId(), assetId: asset.id, start, in: 0, duration, volume: 1, linkId };
  return { doc: putClip(next, audioTrackId, audio), clipIds: [clip.id, audio.id] };
}

/** Відео-кліп, у якого з'ясувалося, що є звук (після обробки файлу), отримує зв'язаний аудіокліп. */
export function addLinkedAudio(doc: TimelineDoc, videoClipId: string, newId: () => string = defaultId): TimelineDoc {
  const found = findClip(doc, videoClipId);
  if (!found || found.track.kind !== 'video' || found.clip.linkId) return doc;
  const video = found.clip as MediaClip;
  const linkId = newId();
  const a = ensureTrack(doc, { kind: 'audio', role: 'original' }, undefined, newId);
  const audio: AudioClip = {
    id: newId(),
    assetId: video.assetId,
    start: video.start,
    in: video.in,
    duration: video.duration,
    volume: video.volume ?? 1,
    linkId,
  };
  const next = mapClips(a.doc, (c) => (c.id === videoClipId ? { ...c, volume: 0, linkId } : c));
  return putClip(next, a.track.id, audio);
}

export function moveClip(
  doc: TimelineDoc,
  clipId: string,
  start: number,
  _sources: SourceLengths,
  trackId?: string,
): TimelineDoc {
  const members = group(doc, clipId);
  const main = members[0];
  if (!main) return doc;
  const fps = doc.fps;
  const target = trackId ? clipTracks(doc).find((t) => t.id === trackId && t.kind === main.track.kind) : undefined;
  const mainTrack = target ?? main.track;
  const moving = new Set(members.map((m) => m.clip.id));
  const placement: Member[] = members.map((m, i) => ({
    obstacles: trackClips(doc, i === 0 ? mainTrack.id : m.track.id).filter((c) => !moving.has(c.id)),
    offset: m.clip.start - main.clip.start,
    duration: m.clip.duration,
    head: Math.min(xfadeOf(m.clip), m.clip.duration - 1 / fps),
  }));
  const s = freeStart(quantize(start, fps), placement, fps);
  const delta = s - main.clip.start;
  if (Math.abs(delta) < EPS && mainTrack.id === main.track.id) return doc;
  let next = mapClips(doc, (c) =>
    moving.has(c.id)
      ? c.id === clipId && mainTrack.id !== main.track.id
        ? null
        : { ...c, start: quantize(c.start + delta, fps) }
      : c,
  );
  if (mainTrack.id !== main.track.id)
    next = putClip(next, mainTrack.id, { ...main.clip, start: quantize(main.clip.start + delta, fps) });
  return next;
}

/** Фото на відео-доріжці (тривалість джерела невідома) не має `in` — він лишається 0. */
const isUnbounded = (m: Found, sources: SourceLengths) => sources[m.clip.assetId] === undefined;

export function trimEnd(doc: TimelineDoc, clipId: string, t: number, sources: SourceLengths): TimelineDoc {
  const members = group(doc, clipId);
  const main = members[0];
  if (!main) return doc;
  const fps = doc.fps;
  let delta = quantize(t, fps) - (main.clip.start + main.clip.duration);
  let lo = -Infinity;
  let hi = Infinity;
  for (const m of members) {
    const end = m.clip.start + m.clip.duration;
    lo = Math.max(lo, 1 / fps - m.clip.duration);
    const len = sources[m.clip.assetId];
    if (len !== undefined) {
      const sp = m.clip.speed ?? 1;
      const used = m.clip.in + (m.clip.duration - (m.clip.hold ?? 0)) * sp;
      hi = Math.min(hi, (quantizeDown(len, fps) - used) / sp);
    }
    for (const o of m.track.clips as AnyClip[]) {
      if (o.id === m.clip.id) continue;
      const [a] = occupied(o, fps);
      if (a >= end - EPS) hi = Math.min(hi, a - end);
    }
  }
  delta = Math.min(Math.max(delta, lo), Math.max(hi, lo));
  if (Math.abs(delta) < EPS) return doc;
  const ids = new Set(members.map((m) => m.clip.id));
  return mapClips(doc, (c) =>
    ids.has(c.id) ? withHold({ ...c, duration: quantize(c.duration + delta, fps) }, c.hold ?? 0, fps) : c,
  );
}

/** Ставить `hold` так, щоб лишався ≥ 1 кадр відтворення (`duration − hold ≥ 1/fps`); нульовий `hold` прибирає. */
function withHold<T extends AnyClip>(clip: T, hold: number, fps: number): T {
  const h = Math.min(hold, clip.duration - 1 / fps);
  const out = { ...clip };
  if (h > EPS) out.hold = quantize(h, fps);
  else delete out.hold;
  return out;
}

export function trimStart(doc: TimelineDoc, clipId: string, t: number, sources: SourceLengths): TimelineDoc {
  const members = group(doc, clipId);
  const main = members[0];
  if (!main) return doc;
  const fps = doc.fps;
  let delta = quantize(t, fps) - main.clip.start;
  let lo = -Infinity;
  let hi = Infinity;
  const shiftsIn = new Set<string>();
  for (const m of members) {
    hi = Math.min(hi, m.clip.duration - 1 / fps);
    lo = Math.max(lo, -m.clip.start);
    if (!(m.track.kind === 'video' && isUnbounded(m, sources))) {
      shiftsIn.add(m.clip.id);
      lo = Math.max(lo, -m.clip.in / (m.clip.speed ?? 1));
    }
    const head = Math.max(0, Math.min(xfadeOf(m.clip), m.clip.duration - 1 / fps));
    const effStart = m.clip.start + head;
    for (const o of m.track.clips as AnyClip[]) {
      if (o.id === m.clip.id) continue;
      const b = o.start + o.duration;
      if (b <= effStart + EPS) lo = Math.max(lo, b - effStart);
    }
  }
  delta = Math.max(Math.min(delta, hi), Math.min(lo, hi));
  if (Math.abs(delta) < EPS) return doc;
  const ids = new Set(members.map((m) => m.clip.id));
  return mapClips(doc, (c) => {
    if (!ids.has(c.id)) return c;
    const hold = c.hold ?? 0;
    const playLen = c.duration - hold;
    // обрізання входить у зону `hold`: `in` не виходить за останній кадр, `hold` скорочується
    const advance = Math.min(Math.max(delta, 0), playLen) + Math.min(delta, 0);
    const next = {
      ...c,
      start: quantize(c.start + delta, fps),
      duration: quantize(c.duration - delta, fps),
      in: shiftsIn.has(c.id) ? quantize(c.in + advance * (c.speed ?? 1), fps) : c.in,
    };
    return withHold(next, hold - Math.max(0, delta - playLen), fps);
  });
}

type Envelope = { t: number; gain: number }[];

/** Огинаюча правої частини: зсув на `-cut` з інтерпольованою точкою на початку. */
function shiftEnvelope(env: Envelope, cut: number): Envelope {
  if (!env.length) return env;
  const after = env.filter((p) => p.t > cut + EPS).map((p) => ({ t: round6(p.t - cut), gain: p.gain }));
  const i = env.findIndex((p) => p.t > cut + EPS);
  let g: number;
  if (i < 0) g = env[env.length - 1]!.gain;
  else if (i === 0) g = env[0]!.gain;
  else {
    const a = env[i - 1]!;
    const b = env[i]!;
    g = a.gain + ((b.gain - a.gain) * (cut - a.t)) / (b.t - a.t);
  }
  return [{ t: 0, gain: round6(g) }, ...after];
}

/** Огинаюча лівої частини: точки після `cut` відкидаються, на `cut` — інтерпольована. */
export function cutEnvelope(env: Envelope, cut: number): Envelope {
  const i = env.findIndex((p) => p.t > cut + EPS);
  if (i < 0) return env;
  const kept = env.slice(0, i);
  const b = env[i]!;
  const a = env[i - 1];
  const g = a ? a.gain + ((b.gain - a.gain) * (cut - a.t)) / (b.t - a.t) : b.gain;
  return a && Math.abs(a.t - cut) < EPS ? kept : [...kept, { t: round6(cut), gain: round6(g) }];
}

function splitEffects(effects: Effect[], p: number): [Effect[], Effect[]] {
  const left: Effect[] = [];
  const right: Effect[] = [];
  const mid = (a: number, b: number) => round6(a + (b - a) * p);
  for (const e of effects) {
    switch (e.type) {
      case 'kenburns': {
        const k = e.params;
        const m = { scale: mid(k.fromScale, k.toScale), x: mid(k.fromX, k.toX), y: mid(k.fromY, k.toY) };
        left.push({ type: 'kenburns', params: { ...k, toScale: m.scale, toX: m.x, toY: m.y } });
        right.push({ type: 'kenburns', params: { ...k, fromScale: m.scale, fromX: m.x, fromY: m.y } });
        break;
      }
      case 'fade':
        left.push({ type: 'fade', params: { in: e.params.in, out: 0 } });
        right.push({ type: 'fade', params: { in: 0, out: e.params.out } });
        break;
      case 'xfade':
        left.push(e);
        break;
      default:
        left.push(e);
        right.push(e);
    }
  }
  return [left, right];
}

export function splitAt(doc: TimelineDoc, clipId: string, t: number, newId: () => string = defaultId): TimelineDoc {
  const members = group(doc, clipId);
  const main = members[0];
  if (!main) return doc;
  const fps = doc.fps;
  const at = quantize(t, fps);
  const inside = (c: AnyClip) => at > c.start + EPS && at < c.start + c.duration - EPS;
  if (!inside(main.clip)) return doc;
  const toSplit = members.filter((m) => inside(m.clip));
  const newLink = main.clip.linkId ? newId() : undefined;
  let next = doc;
  for (const m of toSplit) {
    const c = m.clip;
    const leftDur = quantize(at - c.start, fps);
    const rightDur = quantize(c.duration - leftDur, fps);
    // Темп і стоп-кадр: `in` правої = in + Δ × speed; `hold` лишається лише правій частині
    // (якщо розріз потрапив у зону `hold` — лівій дістається її початок, правій — решта).
    const speed = c.speed ?? 1;
    const hold = c.hold ?? 0;
    const playLen = c.duration - hold;
    const cutInPlay = leftDur <= playLen + EPS;
    const rightIn = quantize(c.in + Math.min(leftDur, playLen) * speed, fps);
    const leftHold = cutInPlay ? 0 : leftDur - playLen;
    const rightHold = cutInPlay ? hold : rightDur;
    let left: AnyClip;
    let right: AnyClip;
    if ('effects' in c) {
      const [le, re] = splitEffects(c.effects, leftDur / c.duration);
      left = { ...c, duration: leftDur, effects: le };
      right = { ...c, id: newId(), start: at, in: rightIn, duration: rightDur, effects: re };
    } else {
      left = {
        ...c,
        duration: leftDur,
        fadeOut: undefined,
        ...(c.envelope ? { envelope: cutEnvelope(c.envelope, leftDur) } : {}),
      };
      right = {
        ...c,
        id: newId(),
        start: at,
        in: rightIn,
        duration: rightDur,
        fadeIn: undefined,
        ...(c.envelope ? { envelope: shiftEnvelope(c.envelope, leftDur) } : {}),
      };
      if (left.fadeOut === undefined) delete left.fadeOut;
      if (right.fadeIn === undefined) delete right.fadeIn;
    }
    if (hold > 0) {
      if (leftHold > 0) left.hold = leftHold;
      else delete left.hold;
      right.hold = rightHold;
    }
    if (newLink) right.linkId = newLink;
    next = mapClips(next, (x) => (x.id === c.id ? left : x));
    next = putClip(next, m.track.id, right);
  }
  return next;
}

export function deleteClips(doc: TimelineDoc, ids: string[]): TimelineDoc {
  const del = new Set(ids);
  const orphanLinks = new Set<string>();
  for (const id of ids) {
    const f = findClip(doc, id);
    if (!f?.clip.linkId) continue;
    if (f.track.kind === 'video') {
      for (const m of group(doc, id)) del.add(m.clip.id);
    } else orphanLinks.add(f.clip.linkId);
  }
  // Видалені кліпи озвучки запам'ятовуємо за сегментом, щоб синхронізація їх не повернула.
  const removed = new Map<string, string[]>();
  for (const track of clipTracks(doc)) {
    if (track.kind !== 'audio' || track.role !== 'voiceover') continue;
    const ids = (track.clips as AudioClip[]).filter((c) => del.has(c.id) && c.sceneId).map((c) => c.sceneId!);
    if (ids.length) removed.set(track.id, ids);
  }
  const out = mapClips(doc, (c, track) => {
    if (del.has(c.id)) return null;
    if (track.kind === 'video' && c.linkId && orphanLinks.has(c.linkId)) {
      return { ...withoutLink(c), volume: 0 };
    }
    return c;
  });
  if (!removed.size) return out;
  return {
    ...out,
    tracks: out.tracks.map((t) => {
      if (t.kind !== 'audio') return t;
      // Лише якщо в доріжці не лишилось жодного кліпа цього сегмента (кліп могли розрізати).
      const add = (removed.get(t.id) ?? []).filter((sid) => !t.clips.some((c) => c.sceneId === sid));
      if (!add.length) return t;
      return { ...t, removedSegments: [...new Set([...(t.removedSegments ?? []), ...add])] };
    }),
  };
}

function withoutLink<T extends AnyClip>(c: T): T {
  const copy = { ...c };
  delete copy.linkId;
  return copy;
}

export function unlink(doc: TimelineDoc, linkId: string): TimelineDoc {
  return mapClips(doc, (c) => {
    if (c.linkId !== linkId) return c;
    return withoutLink(c);
  });
}

export function setVolume(doc: TimelineDoc, clipId: string, v: number): TimelineDoc {
  const volume = Math.min(2, Math.max(0, v));
  return mapClips(doc, (c) => (c.id === clipId ? { ...c, volume } : c));
}

/** Розмір і положення відео-кліпа; `null` чи значення за замовчуванням прибирає поле. Не-відео кліп — без змін. */
export function setClipTransform(doc: TimelineDoc, clipId: string, t: ClipTransform | null): TimelineDoc {
  const isDefault =
    t === null || (t.scale === DEFAULT_TRANSFORM.scale && t.x === DEFAULT_TRANSFORM.x && t.y === DEFAULT_TRANSFORM.y);
  return mapClips(doc, (c) => {
    if (c.id !== clipId || !('fit' in c)) return c;
    if (!isDefault) return { ...c, transform: t };
    if (!('transform' in c)) return c;
    const rest = { ...c } as Record<string, unknown>;
    delete rest.transform;
    return rest as AnyClip;
  });
}

export function setEffect(doc: TimelineDoc, clipId: string, effect: Effect): TimelineDoc {
  return mapClips(doc, (c) => {
    if (c.id !== clipId || !('effects' in c)) return c;
    const i = c.effects.findIndex((e) => e.type === effect.type);
    const effects = i < 0 ? [...c.effects, effect] : c.effects.map((e, j) => (j === i ? effect : e));
    return { ...c, effects };
  });
}

export function removeEffect(doc: TimelineDoc, clipId: string, type: EffectType): TimelineDoc {
  return mapClips(doc, (c) =>
    c.id === clipId && 'effects' in c && c.effects.some((e) => e.type === type)
      ? { ...c, effects: c.effects.filter((e) => e.type !== type) }
      : c,
  );
}

/** Попередній кліп тієї ж доріжки (для переходу). */
export function previousClip(doc: TimelineDoc, clipId: string): MediaClip | null {
  const f = findClip(doc, clipId);
  if (!f || f.track.kind !== 'video') return null;
  let prev: MediaClip | null = null;
  for (const c of f.track.clips)
    if (c.id !== clipId && c.start < f.clip.start - EPS && (!prev || c.start > prev.start)) prev = c;
  return prev;
}

/** Перехід (`xfade`) — кліп насувається на попередній на `duration` секунд. */
export function setTransition(doc: TimelineDoc, clipId: string, duration: number): TimelineDoc {
  const f = findClip(doc, clipId);
  const prev = previousClip(doc, clipId);
  if (!f || !prev) return doc;
  const fps = doc.fps;
  const max = Math.min(prev.duration, f.clip.duration) - 1 / fps;
  const d = quantize(Math.min(Math.max(0, duration), Math.max(0, max)), fps);
  const newStart = quantize(prev.start + prev.duration - d, fps);
  const delta = newStart - f.clip.start;
  const ids = new Set(group(doc, clipId).map((m) => m.clip.id));
  const shifted = mapClips(doc, (c) => (ids.has(c.id) ? { ...c, start: quantize(c.start + delta, fps) } : c));
  return d > 0
    ? setEffect(shifted, clipId, { type: 'xfade', params: { duration: d } })
    : removeEffect(shifted, clipId, 'xfade');
}

export function setFormat(doc: TimelineDoc, format: VideoFormat): TimelineDoc {
  return { ...doc, ...FORMATS[format] };
}

export function addVideoTrack(doc: TimelineDoc, newId: () => string = defaultId): TimelineDoc {
  return insertTrack(doc, { id: newId(), kind: 'video', clips: [] });
}

/** Усі кліпи відео- й звукових доріжок. */
export function allClips(doc: TimelineDoc): (MediaClip | AudioClip)[] {
  return clipTracks(doc).flatMap((t) => t.clips as AnyClip[]);
}
