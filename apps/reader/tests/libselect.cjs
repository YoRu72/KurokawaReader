// node tests/libselect.cjs: choosing books in the library (src/views/library.ts) — «Select all» chooses what is listed
// now (a search's books, not the whole library), books no longer listed after the search changes are let go, and
// deleting many says how many and that it cannot be undone.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
// (Small books made here: the sample books are not in the repository.)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-libselect-'));
const names = ['apple one', 'apple two', 'apple three', 'apple four', 'apple five', 'pear', 'plum'];
const files = names.map((n) => { const f = path.join(dir, `${n}.txt`); fs.writeFileSync(f, `${n}\n\n` + `Words of ${n}. `.repeat(30)); return f; });
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1000, height: 900 }, locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const dialogs = []; p.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  await p.goto(`http://127.0.0.1:${port}/`); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', files); await p.waitForFunction((n) => document.querySelectorAll('.book-card[data-book]').length >= n, files.length, { timeout: 60000 }); await p.waitForTimeout(500);
  const count = () => p.$eval('.sel-count', (e) => e.textContent).catch(() => '');
  const search = async (q) => { await p.fill('.library-view input[type=search]', q); await p.waitForTimeout(700); };
  await search('apple');
  ok('the search lists the five apples', (await p.$$('.book-card[data-book]')).length === 5, (await p.$$('.book-card[data-book]')).length);
  await p.click('.library-view [aria-label="Select"]'); await p.waitForSelector('.sel-head');
  await p.click('.sel-head .btn:has-text("Select all")'); await p.waitForTimeout(200);
  ok('«Select all» under a search chooses the five listed, not all seven', /^5 selected/.test(await count()), await count());
  ok('and then offers «Select none»', (await p.$('.sel-head .btn:has-text("Select none")')) !== null);
  // The search narrowed: the books no longer listed let go.
  await search('apple two');
  ok('narrowing the search lets go of the books no longer listed', /^1 selected/.test(await count()), await count());
  await search('apple');
  ok('widening it again does not bring them back', /^1 selected/.test(await count()), await count());
  await p.click('.sel-head .btn:has-text("Select all")'); await p.waitForTimeout(200);
  // Delete: the five, said with their number, and that it cannot be undone.
  await p.evaluate(() => { const b = [...document.querySelectorAll('.sel-act, .dest-row')].find((x) => /Delete/.test(x.textContent)); if (b) b.click(); else [...document.querySelectorAll('.sel-act')].find((x) => /More/.test(x.textContent)).click(); });
  await p.waitForTimeout(300);
  if (!dialogs.length) { await p.evaluate(() => [...document.querySelectorAll('.sheet .dest-row')].find((x) => /Delete/.test(x.textContent)).click()); await p.waitForTimeout(300); }
  await p.waitForTimeout(1200);
  ok('the confirmation says five and that it cannot be undone', dialogs.length === 1 && /\b5\b/.test(dialogs[0]) && /undone/i.test(dialogs[0]), dialogs);
  const left = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.map((b) => b.title).sort()); }; }));
  ok('only the five listed were deleted: the pear and the plum are still there', left.join() === 'pear,plum', left);
  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed');
  await b.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
