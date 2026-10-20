/**
 * Звук прев'ю: на кожен звуковий кліп `<audio>` → MediaElementAudioSourceNode → GainNode → вихід.
 * Годинник програвання — `AudioContext.currentTime`.
 */
export class AudioGraph {
  private ctx: AudioContext | null = null;
  private nodes = new WeakMap<HTMLMediaElement, GainNode>();

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

  gain(el: HTMLMediaElement): GainNode | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    let g = this.nodes.get(el);
    if (!g) {
      // джерело для елемента можна створити лише раз
      const src = ctx.createMediaElementSource(el);
      g = ctx.createGain();
      src.connect(g).connect(ctx.destination);
      this.nodes.set(el, g);
    }
    return g;
  }

  setGain(el: HTMLMediaElement, value: number) {
    const g = this.gain(el);
    if (g) g.gain.value = value;
    else el.volume = Math.min(1, value);
  }

  destroy() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
