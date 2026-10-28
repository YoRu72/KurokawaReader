// node tests/pdfink.cjs <file.pdf> <outdir>: ink on a PDF page — the pen drawn with a mouse and with a touch,
// the stroke kept with the book (and still there after the page is opened again), the eraser, undo.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [pdf, out] = [path.resolve(process.argv[2]), path.resolve(process.argv[3] || '.')]; fs.mkdirSync(out, { recursive: true });
(async () => {
  await new Promise((r) => server.listen(5431, r));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en', hasTouch: true }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const ok = (name, cond) => console.log((cond ? 'ok  ' : 'FAIL'), name);
  await page.goto('http://localhost:5431/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [pdf]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(500);
  await page.click('.book-card'); await page.waitForSelector('.pdf-page canvas', { timeout: 60000 }); await page.waitForTimeout(800);
  // The pen on.
  await page.click('.pdf-bar button[data-icon="pen"]'); await page.waitForSelector('.ink-bar:not([hidden])');
  const sheet = await page.$('.pdf-page[data-page="1"] .pdf-sheet'); const b = await sheet.boundingBox();
  const strokes = async () => page.evaluate(async () => { const req = indexedDB.open('kurokawa-reader'); const dbx = await new Promise((r) => { req.onsuccess = () => r(req.result); }); const all = await new Promise((r) => { const q = dbx.transaction('books').objectStore('books').getAll(); q.onsuccess = () => r(q.result); }); return (all[0].ink ?? []).length; });
  // A stroke with the mouse.
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.2); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width * (0.2 + i * 0.04), b.y + b.height * (0.2 + i * 0.02)); await page.mouse.up(); await page.waitForTimeout(600);
  const layer = await page.$eval('.pdf-page[data-page="1"] svg.pdf-ink', (svg) => { const r = svg.getBoundingClientRect(); const sheet = svg.parentElement.getBoundingClientRect(); return { paths: svg.querySelectorAll('path').length, fits: Math.abs(r.width - sheet.width) < 2 && Math.abs(r.height - sheet.height) < 2, w: r.width, h: r.height }; });
  ok('a stroke drawn with the mouse is on the page, its layer the sheet\'s size', layer.paths === 1 && layer.fits);
  if (!layer.fits) console.log('  layer', JSON.stringify(layer));
  ok('… and kept with the book', (await strokes()) === 1);
  // A stroke with a finger (a touch), as on the phone.
  await page.touchscreen.tap(b.x + b.width * 0.5, b.y + b.height * 0.5); await page.waitForTimeout(200);
  const cdp = await ctx.newCDPSession(page);
  const pt = (x, y) => ({ x: Math.round(x), y: Math.round(y), radiusX: 2, radiusY: 2, force: 1, id: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(b.x + b.width * 0.3, b.y + b.height * 0.6)] });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(b.x + b.width * (0.3 + i * 0.05), b.y + b.height * 0.6)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(600);
  const n2 = await strokes();
  // (The tap before it is a dot, a stroke of its own: three in all.)
  ok('a stroke drawn with a finger is kept too (and a tap is a dot)', n2 === 3 && (await page.$$('.pdf-page[data-page="1"] svg.pdf-ink path')).length === 3);
  await page.screenshot({ path: path.join(out, 'ink.png') });
  if (await page.$('.ink-swatch:visible')) { await page.click('.ink-swatch'); await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, 'ink-palette.png') }); await page.click('.ink-swatch'); }
  // Undo takes the last one back.
  await page.click('.ink-bar button[aria-label="Undo"]'); await page.waitForTimeout(600);
  ok('undo removes the last stroke', (await strokes()) === 2);
  // The eraser over the first stroke removes it.
  await page.click('.ink-bar button[aria-label="Eraser"]'); await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.25); await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.32, b.y + b.height * 0.26); await page.mouse.up(); await page.waitForTimeout(600);
  ok('the eraser removes the stroke it touches', (await strokes()) === 1);
  // Drawn again, then the book opened again: still there.
  await page.click('.ink-bar button[aria-label="Pen"]'); await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.3); await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.4); await page.mouse.up(); await page.waitForTimeout(700);
  await page.goto('http://localhost:5431/#/'); await page.waitForSelector('.book-card'); await page.click('.book-card'); await page.waitForSelector('.pdf-page canvas', { timeout: 60000 }); await page.waitForTimeout(1000);
  ok('the strokes are still on the page after the book is opened again', (await page.$$('.pdf-page[data-page="1"] svg.pdf-ink path')).length === 2);
  console.log('errors', errors);
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
