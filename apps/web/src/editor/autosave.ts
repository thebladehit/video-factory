import type { TimelineDoc } from '@vf/shared';

export type SaveState = 'saved' | 'saving' | 'error' | 'conflict';

interface Options {
  save(doc: TimelineDoc, baseVersion: number): Promise<{ version: number }>;
  debounceMs: number;
  onState(s: SaveState): void;
  version: number;
}

const isConflict = (e: unknown) => {
  const x = e as { data?: { code?: string }; code?: string } | null;
  return x?.data?.code === 'CONFLICT' || x?.code === 'CONFLICT';
};

/** Кліпи з файлами, що ще вантажаться з ОС (`local:…`), — такий документ на сервер не йде. */
const hasLocal = (doc: TimelineDoc) =>
  doc.tracks.some((t) => t.kind !== 'captions' && t.clips.some((c) => c.assetId.startsWith('local:')));

/**
 * Автозбереження: debounce, одне збереження за раз; наступне бере версію з відповіді попереднього
 * (зміни під час збереження не губляться і не конфліктують самі з собою). CONFLICT — зупинка до рішення користувача.
 */
export class Autosave {
  private pending: TimelineDoc | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private again = false;
  private conflict = false;
  private version: number;

  constructor(private readonly o: Options) {
    this.version = o.version;
  }

  change(doc: TimelineDoc): void {
    this.pending = doc;
    if (this.conflict) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.o.debounceMs);
  }

  /** Зберегти зараз (вихід зі сторінки, рендер, «Перезаписати моєю версією»). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.conflict = false;
    if (this.inFlight) await this.inFlight;
    await this.run();
    if (this.inFlight) await this.inFlight;
  }

  hasPending(): boolean {
    return this.pending !== null || this.inFlight !== null;
  }

  setVersion(v: number): void {
    this.version = v;
  }

  getVersion(): number {
    return this.version;
  }

  /** Після «Перезавантажити»: локальні зміни відкинуто. */
  reset(version: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.conflict = false;
    this.version = version;
    this.o.onState('saved');
  }

  private run(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    const doc = this.pending;
    if (!doc || this.conflict || hasLocal(doc)) return Promise.resolve();
    this.pending = null;
    this.o.onState('saving');
    this.inFlight = this.o
      .save(doc, this.version)
      .then(
        (r) => {
          this.version = r.version;
          if (!this.pending) this.o.onState('saved');
        },
        (e: unknown) => {
          this.pending ??= doc;
          if (isConflict(e)) this.conflict = true;
          this.o.onState(isConflict(e) ? 'conflict' : 'error');
          this.again = false;
        },
      )
      .finally(() => {
        this.inFlight = null;
        if (this.again && this.pending) {
          this.again = false;
          void this.run();
        }
      });
    return this.inFlight;
  }
}
