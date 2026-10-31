// node tests/history.cjs <book> <book>: the History sheet (Mihon's) — the books opened, under today, latest
// first; a tap opens the book; one taken out of the history stays in the library; the whole history cleared.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5452, r));
  const b = await chromium.launch(); const p = await (await b.newContext({ ...devices['Pixel 7'], locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('dialog', (d) => void d.accept());
  await p.goto('http://localhost:5452/'); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', process.argv.slice(2).map((f) => path.resolve(f))); await p.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 60000 }); await p.waitForTimeout(800);
  const ids = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.map((x) => x.id)); }; }));
  for (const id of ids) { await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForTimeout(2500); await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(500); }
  await p.click('.topbar .history-btn'); await p.waitForSelector('.history-sheet .history-row');
  const seen = await p.evaluate(() => ({ day: document.querySelector('.history-day')?.textContent, rows: [...document.querySelectorAll('.history-row b')].map((e) => e.textContent) }));
  await p.waitForTimeout(600); await p.screenshot({ path: path.join(process.env.OUT || '/tmp', 'history.png') });
  ok('the books opened, under today, the latest first', seen.day === 'Today' && seen.rows.length === 2);
  await p.click('.history-row button[data-icon="trash"]'); await p.waitForTimeout(400);
  const left = await p.$$eval('.history-row', (e) => e.length);
  const inLib = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.length); }; }));
  ok('one taken out of the history, the book still in the library', left === 1 && inLib === 2);
  await p.click('.history-row .history-open'); await p.waitForTimeout(1500);
  ok('a tap carries on reading', /#\/read\//.test(await p.evaluate(() => location.hash)));
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(400);
  await p.click('.topbar .history-btn'); await p.waitForSelector('.history-sheet');
  await p.click('.history-sheet button:has-text("Clear the history")'); await p.waitForTimeout(500);
  ok('the whole history cleared', !!(await p.$('.history-empty')));
  // Incognito: switched on at the head of the history; a book read then is not put in it, nor counted.
  await p.click('.incognito-row input'); await p.waitForTimeout(300);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  const marked = await p.$eval('.topbar .history-btn', (e) => e.classList.contains('incognito'));
  const statsBefore = await p.evaluate((i) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').get(i); q.onsuccess = () => res(q.result.stats?.ms ?? 0); }; }), ids[1]);
  await p.evaluate((i) => { location.hash = `#/read/${i}`; }, ids[1]); await p.waitForTimeout(4000); await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);
  const after = await p.evaluate((i) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').get(i); q.onsuccess = () => res({ opened: q.result.lastOpenedAt ?? null, ms: q.result.stats?.ms ?? 0 }); }; }), ids[1]);
  ok('incognito: marked on the history button; a book read is not put in the history, nor its time counted', marked && after.opened === null && after.ms === statsBefore);
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
