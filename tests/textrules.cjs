// node tests/textrules.cjs: text rules (src/textrules.ts) — a rule kept for every book takes words out as a book
// is laid out; one made from the words picked (More → Remove or replace everywhere) applies at once.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5491, r));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1100, height: 900 }, locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://localhost:5491/');
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.textRules', JSON.stringify([{ id: 'a', find: 'Rabbit', replace: 'Hare' }, { id: 'b', find: 'CHAPTER\\s+I\\.', replace: '', regex: true, caseSensitive: true }])); });
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [path.resolve('public/samples/alice-in-wonderland.epub')]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(600);
  const id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0].id); }; }));
  await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForSelector('.kr-content'); await p.waitForTimeout(2500);
  const text = await p.evaluate(() => document.querySelector('.kr-content').textContent);
  ok('a rule for every book replaces as the book is laid out', !/Rabbit/.test(text) && /Hare/.test(text), text.slice(0, 200));
  // A rule from the words picked: "Alice" taken out.
  await p.evaluate(() => { const w = document.createTreeWalker(document.querySelector('.kr-content'), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('Alice'); if (i >= 0 && n.parentElement.getClientRects().length) { n.parentElement.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 5); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 'found ' + getSelection().toString(); } } return 'none'; });
  await p.waitForTimeout(600);
  await p.waitForTimeout(400); await p.evaluate(() => document.dispatchEvent(new Event('selectionchange'))); await p.waitForTimeout(500);
  await p.click('.sel-toolbar button:has-text("More")');
  await p.waitForTimeout(400);
  await p.click('.sheet button:has-text("Remove or replace everywhere")'); await p.waitForTimeout(400);
  const found = await p.inputValue('.rule-find');
  if (process.env.OUT) await p.screenshot({ path: path.join(process.env.OUT, 'textrule.png') });
  await p.click('.sheet button:has-text("Save")'); await p.waitForTimeout(600);
  const after = await p.evaluate(() => document.querySelector('.kr-content').textContent);
  const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.textRules')));
  ok('a rule made from the words picked, for this book, applies at once', found === 'Alice' && !/Alice/.test(after) && kept.some((r) => r.find === 'Alice' && r.book), { found, n: (after.match(/Alice/g) || []).length });
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
