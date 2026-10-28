// node tests/coverview.cjs <book.epub with a cover> <picture.jpg> <outdir>: the cover view (Mihon's) from a book's
// page — opened by a tap, a double tap zooming in and out, a single tap hiding the bar, Escape closing it — and a
// picture of one's own put in the cover's place, then the original restored.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [bookFile, picture, out] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5433, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], locale: 'en' }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://localhost:5433/');
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [path.resolve(bookFile)]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(2500);
  const id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books'); const q = tx.objectStore('books').getAll(); q.onsuccess = () => res(q.result[0].id); }; }));
  await p.evaluate((id) => { location.hash = `#/book/${id}`; }, id); await p.waitForSelector('.book-hero-cover'); await p.waitForTimeout(500);
  const before = await p.$eval('.book-hero-cover', (e) => e.tagName);
  ok('the book page shows its cover', before === 'IMG');
  await p.click('.book-hero-cover'); await p.waitForSelector('.cover-view img'); await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(out, '1-cover.png') });
  ok('a tap opens the cover on its own, with close, share, save and edit', (await p.$$eval('.cover-view .cv-bar .icon-btn', (els) => els.map((e) => e.dataset.icon).join(','))) === 'close,share,download,pen');
  const box = await p.$eval('.cover-view img', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 3 }; });
  await p.mouse.click(box.x, box.y); await p.waitForTimeout(60); await p.mouse.click(box.x, box.y); await p.waitForTimeout(200);
  const z = await p.$eval('.cover-view img', (e) => e.style.transform);
  ok('a double tap zooms in', /scale\(2\.5\)/.test(z) && (await p.$('.cover-view.zoomed')) !== null);
  await p.screenshot({ path: path.join(out, '2-zoomed.png') });
  // Moving about while zoomed.
  await p.mouse.move(box.x, box.y); await p.mouse.down(); await p.mouse.move(box.x + 60, box.y + 120, { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(100);
  const z2 = await p.$eval('.cover-view img', (e) => e.style.transform);
  ok('dragging moves the zoomed cover', z2 !== z);
  await p.mouse.click(box.x, box.y); await p.waitForTimeout(60); await p.mouse.click(box.x, box.y); await p.waitForTimeout(200);
  ok('a double tap again zooms back out', /scale\(1\)/.test(await p.$eval('.cover-view img', (e) => e.style.transform)));
  await p.mouse.click(box.x, box.y); await p.waitForTimeout(500);
  ok('a single tap hides the bar', (await p.$('.cover-view.bare')) !== null);
  await p.mouse.click(box.x, box.y); await p.waitForTimeout(500);
  // Save: the browser's download of the cover's picture.
  // (The name the page gives the file; headless Chromium reports blob downloads made after an await as "download".)
  await p.evaluate(() => { const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { window.krSaved = this.download; return c.call(this); }; });
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }).catch(() => null), p.click('.cover-view .icon-btn[data-icon="download"]')]);
  const saved = await p.evaluate(() => window.krSaved);
  ok('Save hands over the picture (' + saved + ')', !!dl && /\.(jpe?g|png|webp|gif)$/.test(saved || ''));
  // Edit: a picture of one's own.
  await p.click('.cover-view .icon-btn[data-icon="pen"]'); await p.waitForSelector('.sheet .dest-row');
  ok('nothing to restore yet', (await p.$$('.sheet .dest-row')).length === 1);
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('.sheet .dest-row')]);
  await fc.setFiles(path.resolve(picture)); await p.waitForTimeout(1200);
  const custom = await p.evaluate((id) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').get(id); q.onsuccess = () => res({ size: q.result.cover?.size, orig: q.result.coverOrig?.size ?? q.result.coverOrig }); }; }), id);
  ok('the picture is the cover now, the original kept', custom.size > 0 && custom.orig > 0 && custom.size !== custom.orig);
  await p.screenshot({ path: path.join(out, '3-custom.png') });
  await p.click('.cover-view .icon-btn[data-icon="pen"]'); await p.waitForSelector('.sheet .dest-row');
  ok('the original can be had back', (await p.$$('.sheet .dest-row')).length === 2);
  await p.click('.sheet .dest-row:nth-child(2)'); await p.waitForTimeout(800);
  const back = await p.evaluate((id) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').get(id); q.onsuccess = () => res({ size: q.result.cover?.size, has: 'coverOrig' in q.result }); }; }), id);
  ok('the original restored', back.size === custom.orig && !back.has);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  ok('Escape closes the cover view', (await p.$('.cover-view')) === null);
  await p.screenshot({ path: path.join(out, '4-page.png') });
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
