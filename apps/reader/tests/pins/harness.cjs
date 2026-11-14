// Shared by tests/pins.cjs and tests/deletebooks.cjs: the app served from dist/, a library seeded straight into its
// database (made-up books: small text files), long holds made with real touch events, and the database read back.
const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
function serve() {
  const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
  return new Promise((r) => server.listen(0, () => r({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}
/** A book record as the app keeps it (made-up). */
const book = (id, title, o = {}) => ({ id, title, author: o.author ?? 'A. Writer', format: 'txt', fileName: `${title}.txt`, size: 100 + title.length, addedAt: o.addedAt ?? 1700000000000, bookmarks: [], highlights: o.highlights ?? [], ...o.extra });
/** The page's database filled: books (each with a small text file unless linked), meta keys. */
async function seed(p, books, meta = {}) {
  await p.evaluate(async ({ books, meta }) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const t = db.transaction(['books', 'files', 'meta'], 'readwrite');
    for (const b of books) { t.objectStore('books').put(b); if (!b.source) t.objectStore('files').put(new Blob([`${b.title}\n\nSome words of ${b.title}.`], { type: 'text/plain' }), b.id); }
    for (const [k, v] of Object.entries(meta)) t.objectStore('meta').put(v, k);
    await new Promise((res) => { t.oncomplete = res; });
    db.close();
  }, { books, meta });
}
async function meta(p, key) {
  return p.evaluate((key) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get(key); q.onsuccess = () => { res(q.result ?? null); r.result.close(); }; }; }), key);
}
async function bookIds(p) {
  return p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAllKeys(); q.onsuccess = () => { res(q.result.map(String).sort()); r.result.close(); }; }; }));
}
/** Open the app at its library, in this language, with nothing in the way (no update check). */
async function open(p, url, lang = 'en') {
  await p.goto(url); await p.waitForSelector('.library-view');
  // (The app has made its database by the time the library has asked it for books.)
  await until(p, () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const ok = r.result.objectStoreNames.contains('meta'); r.result.close(); res(ok); }; })));
  await p.evaluate((lang) => { localStorage.setItem('kr.lang', lang); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.firstRun', '1'); }, lang);
}
/** The grid's cards in order: 'b:<id>' / 'f:<id>' / 's:<key>', with a * when marked pinned. */
async function order(p) {
  return p.$$eval('.book-grid > .book-card', (els) => els.map((e) => (e.dataset.book ? `b:${e.dataset.book}` : e.dataset.folder ? `f:${e.dataset.folder}` : e.dataset.series ? `s:${e.dataset.series}` : '?') + (e.querySelector('.pin-mark') ? '*' : '')));
}
/** A long hold with a finger (CDP touch events), let go once `until` is true. */
async function hold(p, cdp, sel, until) {
  const el = await p.waitForSelector(sel); await el.scrollIntoViewIfNeeded(); const box = await el.boundingBox();
  const x = box.x + box.width / 2, y = box.y + Math.min(box.height / 3, 60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await p.waitForFunction(until, null, { timeout: 5000 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const tap = async (p, cdp, sel) => { const el = await p.waitForSelector(sel); await el.scrollIntoViewIfNeeded(); const box = await el.boundingBox(); const x = box.x + box.width / 2, y = box.y + box.height / 2; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
/** Asked again (a frame of the page between tries) until `fn` answers true, or `ms` pass. */
async function until(p, fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 16)))); }
  return false;
}
module.exports = { until, serve, book, seed, meta, bookIds, open, order, hold, tap };
