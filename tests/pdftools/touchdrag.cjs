// node tests/pdftools/touchdrag.cjs <photo...>: drag a page in the scanner with a finger (real touch events, a
// phone screen): hold, move onto the first page, let go — and say whether it moved.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const photos = process.argv.slice(2);
(async () => {
  await new Promise((r) => server.listen(5204, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true }); const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto('http://localhost:5204/'); await p.evaluate(() => localStorage.setItem('kr.update.lastCheck', String(Date.now()))); await p.reload(); await p.waitForSelector('.library-view');
  await p.click('.library-tools .tool-btn[data-icon="file"]'); await p.waitForSelector('.sheet .convert-target');
  await p.click('.sheet .convert-targets .convert-target:nth-child(2)'); await p.waitForSelector('.scan-sheet');
  const [ch] = await Promise.all([p.waitForEvent('filechooser'), p.click('.scan-sheet .tool-bar .btn.tonal')]); await ch.setFiles(photos);
  await p.waitForFunction((n) => document.querySelectorAll('.scan-sheet .page-tile:not(.pending)').length >= n, photos.length, { timeout: 300000 });
  await p.evaluate(() => { window.__ev = []; for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'contextmenu', 'dragstart']) document.addEventListener(t, (e) => { const last = window.__ev[window.__ev.length - 1]; if (last !== e.type) window.__ev.push(e.type); }, { capture: true, passive: true }); });
  const srcs = () => p.$$eval('.scan-sheet .page-tile img', (e) => e.map((x) => x.src.slice(-6)));
  const before = await srcs();
  const box = async (k) => (await p.$(`.scan-sheet .page-tile:nth-child(${k}) .page-frame`)).boundingBox();
  const from = await box(photos.length), to = await box(1);
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  let x = from.x + from.width / 2, y = from.y + from.height / 2;
  await touch('touchStart', x, y); await p.waitForTimeout(450);
  const tx = to.x + to.width / 2, ty = to.y + to.height / 2;
  for (let k = 1; k <= 15; k++) { await touch('touchMove', x + ((tx - x) * k) / 15, y + ((ty - y) * k) / 15); await p.waitForTimeout(25); }
  await p.screenshot({ path: '/tmp/claude-0/touchdrag.png' });
  await touch('touchEnd', tx, ty); await p.waitForTimeout(400);
  const after = await srcs();
  console.log('before', before.join(' '), '\nafter ', after.join(' '), '\nmoved last to first?', after[0] === before[before.length - 1]);
  console.log('events', (await p.evaluate(() => window.__ev)).join(' > '));
  await b.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
