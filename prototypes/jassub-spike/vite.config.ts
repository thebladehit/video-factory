import { defineConfig } from 'vite';

// COI=1 вмикає COOP/COEP (SharedArrayBuffer → багатопотоковий libass). Без них JASSUB сам падає в однопотоковий режим.
const coi = process.env.COI === '1'
  ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
  : {};

export default defineConfig({
  server: { headers: coi },
  preview: { headers: coi },
  // jassub шукає worker/wasm через new URL('./…', import.meta.url) — пре-бандлинг ламає ці шляхи в dev
  optimizeDeps: process.env.EXCLUDE === '1' ? { exclude: ['jassub'], include: ['jassub > throughput'] } : {},
});
