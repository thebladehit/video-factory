import JASSUB from 'jassub';
// Явні URL воркера й WASM (працюють і в dev, і у vite build)
import workerUrl from 'jassub/dist/worker/worker.js?worker&url';
import wasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url';
import modernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url';
import fontUrl from './fonts/Montserrat-Bold.ttf?url';
import assText from './sample.ass?raw';

const W = 1080;
const H = 1920;
const params = new URLSearchParams(location.search);
// mode=a: JASSUB малює прямо в overlay-canvas поверх нашого canvas (canvas замість video + manualRender)
// mode=b: JASSUB малює у прихований canvas, ми копіюємо його drawImage у наш canvas
const mode = params.get('mode') ?? 'a';
// urls=explicit (за замовчуванням) — передаємо workerUrl/wasmUrl; urls=default — покладаємось на new URL(…, import.meta.url) всередині jassub
const urls = params.get('urls') ?? 'explicit';
const bgBlack = params.has('black');

const video = document.querySelector<HTMLCanvasElement>('#video')!;
const subs = document.querySelector<HTMLCanvasElement>('#subs')!;
const slider = document.querySelector<HTMLInputElement>('#t')!;
const label = document.querySelector<HTMLSpanElement>('#label')!;
const status = document.querySelector<HTMLSpanElement>('#status')!;
const vctx = video.getContext('2d')!;

let target = subs;
if (mode === 'b') {
  // прихований (але з розміром у layout — інакше ResizeObserver дасть 0×0) canvas поза екраном
  target = document.createElement('canvas');
  Object.assign(target.style, { position: 'fixed', left: '-10000px', top: '0', width: '270px', height: '480px' });
  document.body.append(target);
  subs.style.display = 'none';
}

const jassub = new JASSUB({
  canvas: target,
  subContent: assText,
  fonts: [fontUrl],
  availableFonts: { montserrat: fontUrl },
  defaultFont: 'montserrat',
  queryFonts: false,
  ...(urls === 'explicit' ? { workerUrl, wasmUrl, modernWasmUrl } : {}),
});

let t = 0;
let playing = false;
let playStart = 0;
let playFrom = 0;

function drawVideoFrame(time: number) {
  // «відео» — градієнт і час, щоб бачити, що субтитри йдуть поверх нашого кадру
  if (bgBlack) {
    vctx.fillStyle = '#000';
    vctx.fillRect(0, 0, W, H);
  } else {
    const g = vctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `hsl(${(time * 36) % 360} 60% 35%)`);
    g.addColorStop(1, '#111');
    vctx.fillStyle = g;
    vctx.fillRect(0, 0, W, H);
    vctx.fillStyle = '#fff';
    vctx.font = '60px monospace';
    vctx.fillText(`t=${time.toFixed(3)}`, 40, 100);
  }
  if (mode === 'b') vctx.drawImage(target, 0, 0, W, H);
}

async function renderAt(time: number, repaint = false) {
  t = time;
  label.textContent = time.toFixed(3);
  await jassub.manualRender({ mediaTime: time, width: W, height: H, expectedDisplayTime: performance.now() }, repaint);
  drawVideoFrame(time);
}

slider.addEventListener('input', () => {
  playing = false;
  void renderAt(Number(slider.value));
});

document.querySelector('#play')!.addEventListener('click', () => {
  playing = !playing;
  playStart = performance.now();
  playFrom = t >= 10 ? 0 : t;
  if (playing) requestAnimationFrame(tick);
});

function tick(now: number) {
  if (!playing) return;
  const time = Math.min(10, playFrom + (now - playStart) / 1000);
  slider.value = String(time);
  void renderAt(time);
  if (time >= 10) playing = false;
  else requestAnimationFrame(tick);
}

document.querySelector('#swap')!.addEventListener('click', async () => {
  await jassub.renderer.setTrack(assText.replace('ПРИВІТ, ЇЖАЧКУ!', 'НОВИЙ ТЕКСТ'));
  await renderAt(t, true);
});

// хуки для Playwright
declare global {
  interface Window {
    __spike: {
      ready: Promise<void>;
      setTime: (time: number) => Promise<void>;
      setTrack: (ass: string) => Promise<void>;
      capture: (time: number) => Promise<{ width: number; height: number; nonTransparent: number; png: string } | null>;
      assText: string;
    };
  }
}

window.__spike = {
  ready: jassub.ready,
  setTime: (time) => renderAt(time, true),
  setTrack: async (ass) => {
    await jassub.renderer.setTrack(ass);
    await renderAt(t, true);
  },
  // піксельне зчитування overlay напряму з воркера (_drawCapture — «single-frame readback for tests»)
  capture: async (time) => {
    const r = await jassub.renderer._drawCapture(time);
    if (!r) return null;
    let nonTransparent = 0;
    for (let i = 3; i < r.data.length; i += 4) if (r.data[i]! > 0) nonTransparent++;
    const c = document.createElement('canvas');
    c.width = r.width;
    c.height = r.height;
    const cx = c.getContext('2d')!;
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, r.width, r.height);
    const tmp = new OffscreenCanvas(r.width, r.height);
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
    cx.drawImage(tmp, 0, 0);
    return { width: r.width, height: r.height, nonTransparent, png: c.toDataURL('image/png') };
  },
  assText,
};

jassub.ready.then(
  async () => {
    status.textContent = `ready (mode=${mode}, urls=${urls}, SIMD=${String(JASSUB._supportsSIMD)}, COI=${String(crossOriginIsolated)})`;
    await renderAt(0, true);
  },
  (e: unknown) => {
    status.textContent = `error: ${String(e)}`;
  },
);
