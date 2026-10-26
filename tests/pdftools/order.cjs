// node tests/pdftools/order.cjs <outdir> <big.pdf> <photo...>: putting pages in order — the scanner (type a page's
// new place; hold and drag), then organising a long PDF (choose by numbers, the page-by-page view, jumping,
// moving the chosen pages, saving) with the finished file's buttons in view.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [out, pdf, ...photos] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
(async () => {
  await new Promise((r) => server.listen(5183, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 420, height: 880 }, deviceScaleFactor: 2, acceptDownloads: true }); const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message)); p.on('dialog', (d) => void d.accept(process.env.MOVE_TO || '1'));
  await p.goto('http://localhost:5183/'); await p.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  // Scanner
  await p.click('.library-tools .tool-btn[data-icon="file"]'); await p.waitForSelector('.sheet .convert-target');
  await p.click('.sheet .convert-targets .convert-target:nth-child(2)'); await p.waitForSelector('.scan-sheet');
  const [ch] = await Promise.all([p.waitForEvent('filechooser'), p.click('.scan-sheet .tool-bar .btn.tonal')]); await ch.setFiles(photos.map((x) => path.resolve(x)));
  await p.waitForFunction((n) => document.querySelectorAll('.scan-sheet .page-tile:not(.pending)').length >= n, photos.length, { timeout: 300000 });
  const srcs = () => p.$$eval('.scan-sheet .page-tile img', (e) => e.map((x) => x.src.slice(-8)));
  const before = await srcs();
  await p.click('.scan-sheet .page-tile:nth-child(1) .page-pos'); await p.fill('.scan-sheet .page-pos-input', '3'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  const afterNum = await srcs();
  console.log('typed place 3: first went to 3rd?', afterNum[2] === before[0], afterNum.join(' '));
  const t = await (await p.$('.scan-sheet .page-tile:nth-child(4) .page-frame')).boundingBox(), d = await (await p.$('.scan-sheet .page-tile:nth-child(1) .page-frame')).boundingBox();
  await p.mouse.move(t.x + t.width / 2, t.y + t.height / 2); await p.mouse.down(); await p.mouse.move(t.x + t.width / 2 + 10, t.y + t.height / 2 + 10, { steps: 3 });
  await p.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 12 }); await p.screenshot({ path: path.join(out, '1-dragging.png') }); await p.mouse.up(); await p.waitForTimeout(300);
  const afterDrag = await srcs();
  console.log('dragged 4th onto 1st: now first?', afterDrag[0] === afterNum[3], afterDrag.join(' '));
  await p.screenshot({ path: path.join(out, '2-scanner.png') });
  await p.keyboard.press('Escape'); await p.waitForTimeout(200); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  // Organise a long PDF
  await p.setInputFiles('input[type=file]', [path.resolve(pdf)]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(400);
  await p.click('.library-tools .tool-btn[data-icon="file"]'); await p.waitForSelector('.sheet .convert-target');
  await p.click('.sheet .convert-targets .convert-target:nth-child(6)'); await p.waitForSelector('.sheet .dest-row'); await p.click('.sheet .dest-row');
  const t0 = Date.now(); await p.waitForSelector('.organize-grid .page-tile', { timeout: 60000 });
  console.log('organize opened in', Date.now() - t0, 'ms, tiles', await p.$$eval('.organize-grid .page-tile', (e) => e.length));
  await p.waitForTimeout(1500); await p.screenshot({ path: path.join(out, '3-grid.png') });
  const t1 = Date.now(); await p.fill('.organize-range', '5-7, 300'); await p.waitForTimeout(300);
  console.log('typed 5-7, 300 in', Date.now() - t1, 'ms →', await p.textContent('.organize-count'));
  await p.fill('.organize-jump', '300'); await p.press('.organize-jump', 'Enter'); await p.waitForTimeout(1200); await p.screenshot({ path: path.join(out, '4-jump.png') });
  await p.click('.organize-views button:nth-child(2)'); await p.waitForTimeout(1500); await p.screenshot({ path: path.join(out, '5-one-page.png') });
  await p.fill('.organize-pos', '120'); await p.press('.organize-pos', 'Enter'); await p.waitForTimeout(1200);
  await p.click('.organize-select'); await p.waitForTimeout(300); console.log('chose page 120 →', await p.textContent('.organize-count'));
  await p.click('.organize-vbar .icon-btn:nth-child(3)'); await p.waitForTimeout(1000); console.log('next → place', await p.inputValue('.organize-pos'));
  await p.screenshot({ path: path.join(out, '6-page-121.png') });
  await p.click('.organize-views button:nth-child(1)'); await p.waitForTimeout(400);
  await p.click('.organize-tools .chip:has-text("نقل")'); await p.waitForTimeout(500);
  console.log('after moving chosen to 1, first places:', await p.$$eval('.organize-grid .page-tile .page-orig', (e) => e.slice(0, 6).map((x) => x.textContent).join(' ')));
  await p.click('.sheet:last-of-type .sheet-actions .btn.primary'); await p.waitForSelector('.runner-panel .convert-result:not([hidden]) button', { timeout: 120000 });
  const box = await (await p.$('.runner-panel .convert-result button')).boundingBox();
  console.log('save button in view without scrolling:', box.y > 0 && box.y + box.height < 880, Math.round(box.y));
  await p.screenshot({ path: path.join(out, '7-saved.png') });
  await b.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
