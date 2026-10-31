// node tests/autobackup.cjs: automatic backups (src/backup.ts, ui/restoresheet.ts) — one made from Settings,
// listed when restoring, and only the parts asked for brought back.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5493, r));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1000, height: 900 }, locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('dialog', (d) => void d.accept());
  await p.goto('http://localhost:5493/'); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [path.resolve('public/samples/maqamat-al-hariri.epub')]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(600);
  const idb = (fn) => p.evaluate(`new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const st = r.result.transaction('books', 'readwrite').objectStore('books'); const q = st.getAll(); q.onsuccess = () => { const b = q.result[0]; (${fn})(b, st); res({ marks: b.bookmarks.length, theme: null }); }; }; })`);
  await idb(`(b, st) => { b.bookmarks = [{ id: 'bm1', label: 'Here', locator: { bookId: b.id, pct: 0.3 }, createdAt: 1 }]; st.put(b); }`);
  await p.reload(); await p.waitForSelector('.library-view');
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('section.card h3');
  await p.locator('h3.card-title').filter({ hasText: /Backup/ }).first().click().catch(() => undefined); await p.waitForTimeout(300);
  await p.click('.auto-backup button:has-text("Back up now")'); await p.waitForTimeout(800);
  // The bookmark lost, a setting changed: then restored with the reading only.
  await idb(`(b, st) => { b.bookmarks = []; st.put(b); }`);
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); v.fontSize = 31; localStorage.setItem('kr.visual', JSON.stringify(v)); });
  await p.reload(); await p.waitForSelector('section.card h3');
  await p.locator('h3.card-title').filter({ hasText: /Backup/ }).first().click().catch(() => undefined); await p.waitForTimeout(300);
  await p.click('section.card button:has-text("Restore")'); await p.waitForSelector('.sheet .dest-row');
  const rows = await p.$$eval('.sheet .dest-row', (es) => es.map((e) => e.textContent));
  ok('the automatic backup listed when restoring, with its book count', rows.length === 2 && /1 (file|book)\b/.test(rows[1]), rows);
  await p.click('.sheet .dest-row >> nth=1'); await p.waitForSelector('.sheet .check-row');
  await p.click('.sheet .check-row:has-text("Settings") input');
  await p.click('.sheet .btn.primary:has-text("Restore")'); await p.waitForTimeout(1200);
  const after = await idb('() => {}');
  const size = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') || '{}').fontSize);
  ok('restored with the reading only: the bookmark back, the setting left as it is', after.marks === 1 && size === 31, { after, size });
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
