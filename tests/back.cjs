// node tests/back.cjs <a.epub> <b.epub>: "back" from inside the library — a series opened there is closed by
// a mouse's back button and by Alt+← (Android's back goes the same way), not left for the app to go away;
// a sheet open on top is closed first.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5463, r));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1100, height: 860 }, locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://localhost:5463/'); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', process.argv.slice(2).map((f) => path.resolve(f))); await p.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 60000 }); await p.waitForTimeout(800);
  // (The two made volumes of one series.)
  await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.getAll(); q.onsuccess = () => { q.result.forEach((bk, i) => { bk.series = { name: 'Test Saga', index: i + 1 }; st.put(bk); }); tx.oncomplete = res; }; }; }));
  await p.reload(); await p.waitForSelector('.library-view'); await p.waitForTimeout(800);
  const inSeries = () => p.evaluate(() => !!document.querySelector('.series-bar'));
  const openIt = async () => { await p.locator('.book-card').filter({ hasText: 'Test Saga' }).first().click(); await p.waitForTimeout(500); if (!(await inSeries())) { const row = p.locator('.sheet .dest-row').nth(1); if (await row.count()) { await row.click(); await p.waitForTimeout(400); } } };
  await openIt();
  ok('the series opens in the library', await inSeries());
  await p.mouse.move(500, 400); await p.mouse.down({ button: 'back' }).catch(() => undefined);
  await p.evaluate(() => { window.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true })); }); await p.waitForTimeout(400);
  ok('the mouse\'s back button closes it', !(await inSeries()) && /#\/?$|^$/.test(await p.evaluate(() => location.hash)));
  await openIt();
  await p.keyboard.press('Alt+ArrowLeft'); await p.waitForTimeout(400);
  ok('Alt+← closes it too', !(await inSeries()));
  await openIt();
  await p.setViewportSize({ width: 420, height: 860 }); await p.waitForTimeout(300);
  await p.click('.topbar .history-btn'); await p.waitForSelector('.history-sheet');
  await p.keyboard.press('Alt+ArrowLeft'); await p.waitForTimeout(500);
  ok('a sheet on top is closed first', !(await p.$('.history-sheet')) && await inSeries());
  // The cover viewer (a fixed full-screen overlay) is closed by back, the book's page left as it was.
  {
    const id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0].id); }; }));
    await p.evaluate((i) => { location.hash = `#/book/${i}`; }, id); await p.waitForSelector('.cover-tap'); await p.waitForTimeout(300);
    await p.click('.cover-tap'); await p.waitForSelector('.cover-view', { timeout: 5000 }).catch(() => undefined);
    const opened = !!(await p.$('.cover-view'));
    await p.keyboard.press('Alt+ArrowLeft'); await p.waitForTimeout(500);
    ok('back closes the cover viewer, staying on the book\'s page', opened && !(await p.$('.cover-view')) && (await p.evaluate(() => location.hash)).startsWith('#/book/'));
  }
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
