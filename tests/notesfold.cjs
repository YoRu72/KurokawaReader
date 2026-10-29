// node tests/notesfold.cjs <book.epub>: Bookmarks & notes — each book's entries start folded; the head opens
// them (and folds them again); the book itself opened by the button beside it.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5462, r));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 420, height: 860 }, locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://localhost:5462/'); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [path.resolve(process.argv[2])]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(800);
  await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.getAll(); q.onsuccess = () => { const bk = q.result[0]; bk.bookmarks = [{ id: 'b1', label: 'Chapter one', cfi: '', createdAt: Date.now() }, { id: 'b2', label: 'Chapter two', cfi: '', createdAt: Date.now() }]; st.put(bk); tx.oncomplete = res; }; }; }));
  await p.evaluate(() => { location.hash = '#/notes'; }); await p.waitForSelector('.notes-book');
  const vis = () => p.evaluate(() => [...document.querySelectorAll('.notes-book .plain-list li')].filter((x) => x.offsetParent).length);
  ok('the entries start folded', (await vis()) === 0 && !!(await p.$('.notes-book.folded')));
  await p.click('.notes-head'); await p.waitForTimeout(200);
  ok('the head opens them', (await vis()) === 2 && (await p.getAttribute('.notes-head', 'aria-expanded')) === 'true');
  await p.screenshot({ path: path.join(process.env.OUT || '/tmp', 'notesfold.png') });
  await p.click('.notes-head'); await p.waitForTimeout(200);
  ok('…and folds them again', (await vis()) === 0);
  await p.click('.notes-head-row > .icon-btn'); await p.waitForTimeout(800);
  ok('the button beside it opens the book', /#\/read\//.test(await p.evaluate(() => location.hash)));
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
