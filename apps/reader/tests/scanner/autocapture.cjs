// node tests/scanner/autocapture.cjs <feed.y4m> [screenshot-dir]: the scanner's camera on a fake camera feed
// (tests/scanner/camvideo.py): open it, leave "Auto" on, and count the photos it takes by itself — two pages held
// steady in turn should give two photos, no more. Screenshots of the camera view as it goes.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [feed, shots = '/tmp'] = process.argv.slice(2);
(async () => {
  await new Promise((r) => server.listen(5206, r));
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve(feed)}`] });
  const ctx = await b.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] }); const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.type(), m.text()); });
  await p.goto('http://localhost:5206/'); await p.evaluate(() => localStorage.setItem('kr.update.lastCheck', String(Date.now()))); await p.reload(); await p.waitForSelector('.library-view');
  await p.click('.library-tools .tool-btn[data-icon="file"]'); await p.waitForSelector('.sheet .convert-target');
  await p.click('.sheet .convert-targets .convert-target:nth-child(2)'); await p.waitForSelector('.scan-sheet');
  const t0 = Date.now();
  await p.evaluate(() => { window.__cam = []; });
  await p.click('.scan-sheet .tool-bar .btn.primary'); await p.waitForSelector('.cam-view');
  const log = [];
  for (let k = 0; k < 24; k++) {
    await p.waitForTimeout(500);
    const st = await p.evaluate(() => ({ hint: document.querySelector('.cam-hint')?.textContent, count: document.querySelector('.cam-count')?.textContent, ring: document.querySelector('.cam-shutter')?.style.getPropertyValue('--ring') }));
    log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${st.hint} | ${st.count || '-'} | ring ${st.ring}`);
    if (k === 3 || k === 7) await p.screenshot({ path: path.join(shots, `cam-${k}.png`) });
  }
  console.log(log.join('\n'));
  if (process.env.DBG) console.log((await p.evaluate(() => window.__cam)).join('\n'));
  await p.click('.cam-view .cam-done, .cam-view .cam-close'); await p.waitForSelector('.cam-view', { state: 'detached' });
  await p.waitForFunction(() => !document.querySelector('.scan-sheet .page-tile.pending'), null, { timeout: 120000 });
  const n = await p.$$eval('.scan-sheet .page-tile', (e) => e.length);
  console.log('pages in the scanner:', n);
  await p.screenshot({ path: path.join(shots, 'cam-after.png') });
  await b.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
