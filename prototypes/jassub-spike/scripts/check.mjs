import { chromium } from '/Users/boosted/projects/video-creator-web/node_modules/.pnpm/playwright@1.64.1/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const [,, base, outDir, query = ''] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 640 }, deviceScaleFactor: Number(process.env.DPR ?? 4) });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const reqs = [];
page.on('requestfinished', async (r) => { const res = await r.response(); reqs.push(`${res?.status()} ${r.url().replace(base, '')}`); });
page.on('requestfailed', (r) => reqs.push(`FAILED ${r.url()} ${r.failure()?.errorText}`));
await page.goto(base + '/' + query);
try { await page.waitForFunction(() => window.__spike, null, { timeout: 15000 }); } catch { console.log("NO SPIKE"); console.log(logs.join("\n")); console.log(reqs.join("\n")); process.exit(1); }
try { await page.waitForFunction(() => document.querySelector('#status').textContent !== '…', null, { timeout: 15000 }); } catch (e) { console.log('NOT READY'); console.log(logs.join('\n')); console.log(reqs.join('\n')); process.exit(1); }
console.log('status:', await page.textContent('#status'));
const times = [0.2, 0.53, 0.56, 1.5, 3.3, 3.55, 4.0, 5.5, 6.55, 7.5, 9.6];
const tag = query.replace(/[^a-z0-9=]+/gi, '_') || 'default';
for (const t of times) {
  await page.evaluate((t) => window.__spike.setTime(t), t);
  await page.waitForTimeout(150);
  await page.locator('#stage').screenshot({ path: `${outDir}/${tag}-stage-${t.toFixed(2)}.png` });
  const cap = await page.evaluate((t) => window.__spike.capture(t), t);
  if (cap) fs.writeFileSync(`${outDir}/${tag}-cap-${t.toFixed(2)}.png`, Buffer.from(cap.png.split(',')[1], 'base64'));
  // пікселі overlay зі скріншоту: рахуємо жовті (активні) пікселі в центральній смузі
  console.log(`t=${t}: capture ${cap?.width}x${cap?.height} nonTransparent=${cap?.nonTransparent}`);
}
// setTrack
await page.evaluate(() => window.__spike.setTime(1.5));
await page.click('#swap');
await page.waitForTimeout(300);
await page.locator('#stage').screenshot({ path: `${outDir}/${tag}-settrack-1.50.png` });
const cap2 = await page.evaluate(() => window.__spike.capture(1.5));
console.log('after setTrack nonTransparent', cap2?.nonTransparent);
// play 1s
await page.evaluate(() => window.__spike.setTime(0));
await page.click('#play');
await page.waitForTimeout(1200);
console.log('after play ~1.2s label:', await page.textContent('#label'));
await page.locator('#stage').screenshot({ path: `${outDir}/${tag}-play.png` });
console.log('--- console');
console.log(logs.join('\n'));
console.log('--- requests');
console.log(reqs.filter((r) => /jassub|worker|wasm|ttf|woff/i.test(r)).join('\n'));
await browser.close();
