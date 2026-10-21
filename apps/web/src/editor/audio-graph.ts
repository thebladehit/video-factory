import type { AudioRole } from '@vf/shared';
import type { AudioItem } from '@vf/timeline';

export type EnvelopePoint = AudioItem['envelope'][number];

/** Множник огинаючої в локальному часі кліпу: до першої / після останньої точки — їхній `gain`, між — лінійно. */
export function envelopeAt(points: readonly EnvelopePoint[], local: number): number {
  const first = points[0];
  if (!first) return 1;
  if (local <= first.t) return first.gain;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (local <= b.t) return a.gain + ((b.gain - a.gain) * (local - a.t)) / (b.t - a.t);
  }
  return points[points.length - 1]!.gain;
}

/**
 * Огинаюча на `AudioParam`: поточне значення зараз, далі `linearRampToValueAtTime` у кожну майбутню точку
 * `clipStart + t` (секунди годинника `AudioContext`, `clipStart` — момент, коли локальний час кліпу = 0).
 */
export function scheduleEnvelope(param: AudioParam, points: readonly EnvelopePoint[], clipStart: number, now: number) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(envelopeAt(points, now - clipStart), now);
  for (const p of points) if (clipStart + p.t > now) param.linearRampToValueAtTime(p.gain, clipStart + p.t);
}

/**
 * Що робить звуковий елемент у локальний момент кліпу: грає лише до зони `hold` (далі тиша, як `apad` у рендері);
 * темп = `speed`, крім озвучки — голос ніколи не прискорюється. `role` — роль доріжки (`undefined` — звук відео-кліпу).
 */
export function audioTarget(
  item: AudioItem,
  role: AudioRole | undefined,
  local: number,
): { active: boolean; time: number; rate: number } {
  const rate = role === 'voiceover' ? 1 : item.speed;
  return { active: local >= 0 && local < item.duration - item.hold, time: item.in + local * rate, rate };
}

/** Темп елемента без зміни висоти тону. */
export function applyRate(el: HTMLMediaElement, rate: number) {
  el.preservesPitch = true;
  if (el.playbackRate !== rate) el.playbackRate = rate;
}

interface Nodes {
  /** `volume × fade` — значення ставиться щокадру */
  level: GainNode;
  /** огинаюча — заплановані рампи */
  envelope: GainNode;
  /** ключ запланованої огинаючої: момент старту кліпу + точки */
  scheduled: string;
}

/**
 * Звук прев'ю: на кожен звуковий кліп `<audio>` → MediaElementAudioSourceNode → GainNode (рівень) → GainNode
 * (огинаюча) → вихід. Годинник програвання — `AudioContext.currentTime`.
 */
export class AudioGraph {
  private ctx: AudioContext | null = null;
  private nodes = new WeakMap<HTMLMediaElement, Nodes>();

  /** Створюється в обробнику жесту користувача (політика автозапуску). */
  ensure(): AudioContext | null {
    if (!this.ctx && typeof AudioContext !== 'undefined') this.ctx = new AudioContext();
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Секунди годинника; без Web Audio — performance.now(). */
  now(): number {
    return this.ctx ? this.ctx.currentTime : performance.now() / 1000;
  }

  private chain(el: HTMLMediaElement): Nodes | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    let n = this.nodes.get(el);
    if (!n) {
      // джерело для елемента можна створити лише раз
      const src = ctx.createMediaElementSource(el);
      n = { level: ctx.createGain(), envelope: ctx.createGain(), scheduled: '' };
      src.connect(n.level).connect(n.envelope).connect(ctx.destination);
      this.nodes.set(el, n);
    }
    return n;
  }

  /**
   * Гучність елемента: `value` (volume × fade) — зараз, огинаюча — запланованими рампами від `clipStart`
   * (секунди годинника, коли локальний час кліпу = 0); перепланування лише при зміні старту або точок.
   * Без Web Audio — `el.volume` з поточним значенням огинаючої (≤ 1).
   */
  setGain(el: HTMLMediaElement, value: number, envelope: readonly EnvelopePoint[] = [], clipStart = this.now()) {
    const n = this.chain(el);
    if (!n || !this.ctx) {
      el.volume = Math.max(0, Math.min(1, value * envelopeAt(envelope, this.now() - clipStart)));
      return;
    }
    n.level.gain.value = value;
    const key = `${clipStart.toFixed(4)}|${JSON.stringify(envelope)}`;
    if (n.scheduled !== key) {
      n.scheduled = key;
      scheduleEnvelope(n.envelope.gain, envelope, clipStart, this.ctx.currentTime);
    }
  }

  destroy() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
