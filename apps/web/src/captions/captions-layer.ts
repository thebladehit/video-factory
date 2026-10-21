import type JASSUB from 'jassub';
import workerUrl from 'jassub/dist/worker/worker.js?worker&url';
import wasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url';
import modernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url';
import { FONT_URLS } from './fonts';

/**
 * Шар субтитрів прев'ю: прозорий canvas поверх canvas прев'ю, JASSUB (libass у WASM, воркер) малює в нього кадр
 * ASS за нашим годинником (`manualRender`) — той самий ASS і ті самі TTF, що й у рендері ffmpeg.
 */
export interface CaptionsLayer {
  /** Новий ASS (`null` — без субтитрів). Перший — одразу (лениве завантаження JASSUB), далі — з debounce. */
  setAss(ass: string | null): void;
  /** Кадр субтитрів на час `t` документа; `repaint` — примусово (seek/пауза). */
  setTime(t: number, repaint?: boolean): void;
  /** CSS-розмір полотна прев'ю; пікселі overlay = CSS × DPR (рахує сам JASSUB). */
  resize(cssW: number, cssH: number, dpr: number): void;
  destroy(): void;
}

export const CAPTIONS_ERROR = 'Не вдалося завантажити субтитри';
/** Зміни стилю/тексту приходять пачками — оновлювати трек не частіше. */
const DEBOUNCE_MS = 300;
/** Воркер, що не стартував (немає файлу воркера), `ready` не завершує ніколи. */
const LOAD_TIMEOUT_MS = 20_000;

/** Сімейство (нижній регістр) → URL: libass шукає шрифт за `Fontname` стилю. */
const AVAILABLE = Object.fromEntries(Object.entries(FONT_URLS).map(([family, url]) => [family.toLowerCase(), url]));

/** URL-и шрифтів, які використовують стилі ASS (`Style: Name,Fontname,…`). */
function usedFonts(ass: string): string[] {
  const out = new Set<string>();
  for (const m of ass.matchAll(/^Style:\s*[^,]*,([^,]+),/gm)) {
    const url = AVAILABLE[m[1]!.trim().toLowerCase()];
    if (url) out.add(url);
  }
  return [...out];
}

/** Розмір «відео» для libass = `PlayResX/Y` документа. */
function playRes(ass: string): { width: number; height: number } {
  const x = /^PlayResX:\s*(\d+)/m.exec(ass);
  const y = /^PlayResY:\s*(\d+)/m.exec(ass);
  return { width: Number(x?.[1] ?? 1920), height: Number(y?.[1] ?? 1080) };
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('JASSUB: час очікування вичерпано')), ms);
    p.then(
      (v) => (clearTimeout(id), resolve(v)),
      (e: unknown) => (clearTimeout(id), reject(e)),
    );
  });
}

export function createCaptionsLayer(
  host: HTMLElement,
  urls: { workerUrl: string; wasmUrl: string; modernWasmUrl: string } = { workerUrl, wasmUrl, modernWasmUrl },
): CaptionsLayer {
  let ass: string | null = null;
  /** ASS, який зараз у треку JASSUB */
  let applied: string | null = null;
  let size = { width: 1920, height: 1080 };
  let t = 0;
  let dpr = 0;
  let jassub: JASSUB | null = null;
  let loading = false;
  let failed = false;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loadedFonts = new Set<string>();

  const canvas = document.createElement('canvas');
  canvas.dataset.testid = 'captions-canvas';
  // не display:none — JASSUB бере розмір з layout (ResizeObserver)
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    visibility: 'hidden',
  });
  const message = document.createElement('div');
  message.textContent = CAPTIONS_ERROR;
  message.dataset.testid = 'captions-error';
  message.className =
    'pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded bg-black/70 px-2 py-1 text-xs text-white';
  message.hidden = true;
  host.append(canvas, message);

  function render(repaint: boolean) {
    if (!jassub || !ass) return;
    void jassub
      .manualRender({ mediaTime: t, ...size, expectedDisplayTime: performance.now() }, repaint)
      .catch(() => {});
  }

  function fail(e: unknown) {
    console.error('Субтитри прев’ю:', e);
    failed = true;
    loading = false;
    canvas.style.visibility = 'hidden';
    message.hidden = false;
  }

  async function load(first: string) {
    loading = true;
    let j: JASSUB | null = null;
    try {
      const { default: JASSUBCtor } = await import('jassub');
      if (destroyed) return;
      const fonts = usedFonts(first);
      j = new JASSUBCtor({
        canvas,
        subContent: first,
        ...urls,
        fonts,
        availableFonts: AVAILABLE,
        defaultFont: 'montserrat',
        queryFonts: false,
      });
      await timeout(j.ready, LOAD_TIMEOUT_MS);
      // помилку ініціалізації воркер лише логує — `ready` завершується без renderer
      if (!j.renderer) throw new Error('JASSUB: воркер не ініціалізувався');
      fonts.forEach((f) => loadedFonts.add(f));
      if (destroyed) return void j.destroy();
      jassub = j;
      applied = first;
      loading = false;
      if (ass !== applied) await apply();
      else {
        canvas.style.visibility = ass ? 'visible' : 'hidden';
        render(true);
      }
    } catch (e) {
      if (j) {
        void j.destroy().catch(() => {});
        j._worker.terminate();
      }
      fail(e);
    }
  }

  /** Поточний `ass` — у трек JASSUB (нові шрифти — до треку). */
  async function apply() {
    timer = undefined;
    if (!jassub) return;
    const next = ass;
    if (next === null) {
      canvas.style.visibility = 'hidden';
      return;
    }
    if (next !== applied) {
      const fonts = usedFonts(next).filter((f) => !loadedFonts.has(f));
      try {
        if (fonts.length) {
          await jassub.renderer.addFonts(fonts);
          fonts.forEach((f) => loadedFonts.add(f));
        }
        await jassub.renderer.setTrack(next);
        applied = next;
      } catch (e) {
        return fail(e);
      }
    }
    canvas.style.visibility = 'visible';
    render(true);
  }

  return {
    setAss(next) {
      if (destroyed || next === ass) return;
      const wasEmpty = ass === null;
      ass = next;
      if (next) size = playRes(next);
      if (failed) return;
      if (!jassub) {
        if (next && !loading) void load(next);
        return;
      }
      clearTimeout(timer);
      if (next === null || wasEmpty) void apply();
      else timer = setTimeout(() => void apply(), DEBOUNCE_MS);
    },
    setTime(time, repaint = false) {
      t = time;
      render(repaint);
    },
    resize(cssW, cssH, ratio) {
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      // зміну DPR (вікно на інший екран) ResizeObserver не бачить
      if (dpr && ratio !== dpr && jassub) void jassub.resize(true).catch(() => {});
      dpr = ratio;
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      message.remove();
      if (jassub) void jassub.destroy().catch(() => {});
      else canvas.remove();
      jassub = null;
    },
  };
}
