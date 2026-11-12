// node tests/staysinbook.cjs: a tap on a link inside a book's text never takes the reader out of the book.
// A web novel's chapter (sources/ext/source.ts cleanChapter keeps `#…` links: a translator's notes), a Markdown or
// an HTML book keep their links as written; a tap on `href="#fn1"` or `href="#"` changed the address's fragment,
// which is the app's own route (src/router.ts) — and the route `#fn1` is the library: the book closed. A relative link
// (`other.html`) loaded another page of the app: the app started again, in the library. Now: a link to a place in
// the book goes there; a link to nothing in it does nothing; the book stays open. (The book is made here.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-staysinbook-'));
const para = (i) => `<p>Paragraph ${i}. ${'The river ran past the old city and the people read their books. '.repeat(4)}</p>`;
const html = `<!doctype html><html><head><title>Links Book</title></head><body>
<h1>Links Book</h1>
<p id="intro">Intro with a note<a id="ref1" href="#fn1">[1]</a>, an empty link <a id="empty" href="#">here</a>, one to nowhere <a id="nowhere" href="#no-such-place">there</a> and another page <a id="rel" href="other.html">other</a>.</p>
${Array.from({ length: 80 }, (_, i) => para(i + 1)).join('\n')}
<p id="fn1">[1] The translator's note.</p>
</body></html>`;
const file = path.join(TMP, 'links.html'); fs.writeFileSync(file, html);

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'en' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  let loads = 0; p.on('load', () => loads++);
  await p.goto(base); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('.library-view input[type=file]', [file]);
  let id = null;
  for (let i = 0; i < 120 && !id; i++) { await p.waitForTimeout(250); id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0]?.id ?? null); }; })); }
  ok('the book is imported', !!id);
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForSelector('.reader-flow .kr-content a', { timeout: 30000 }); await p.waitForTimeout(1500);
  const where = () => p.evaluate(() => ({ hash: location.hash, reader: !!document.querySelector('.reader-flow .kr-content'), library: !!document.querySelector('.library-view') }));
  const tap = async (sel) => {
    const before = loads;
    await p.evaluate((sel) => { const a = [...document.querySelectorAll('.reader-flow .kr-content a')].find((x) => x.matches(sel)); a.scrollIntoView({ block: 'center' }); }, sel);
    await p.waitForTimeout(300);
    const box = await p.evaluate((sel) => { const r = [...document.querySelectorAll('.reader-flow .kr-content a')].find((x) => x.matches(sel)).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
    await p.touchscreen.tap(box.x, box.y); await p.waitForTimeout(1200);
    return { ...(await where()), reloaded: loads > before };
  };
  const inBook = (w) => w.reader && !w.library && !w.reloaded && /^#\/read\//.test(w.hash);
  let w = await tap('a[id="ref1"]');
  ok('a tap on a note link (#fn1) keeps the book open', inBook(w), w);
  const noteSeen = await p.evaluate(() => { const n = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith('[1] The translator')); const r = n?.getBoundingClientRect(); return !!r && r.bottom > 0 && r.top < innerHeight; });
  ok('… and goes to the note', noteSeen);
  w = await tap('a[id="empty"]');
  ok('a tap on an empty link (#) keeps the book open', inBook(w), w);
  w = await tap('a[id="nowhere"]');
  ok('a tap on a link to no place in the book keeps the book open', inBook(w), w);
  w = await tap('a[id="rel"]');
  ok('a tap on a link to another page keeps the book open (the app is not loaded again)', inBook(w), w);
  // The way back still works: the reader's back leaves the book for the library.
  await p.evaluate(() => history.back()); await p.waitForTimeout(800);
  ok('back from the book leaves it (one step, to the library)', await p.evaluate(() => !!document.querySelector('.library-view') && !document.querySelector('.reader-flow')));
  // The app ended under the open book and started again (the address the app starts at: the library's).
  const topPara = () => p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const r = sc.getBoundingClientRect(); for (let y = r.top + 10; y < r.top + 200; y += 6) { const e = document.elementFromPoint(r.left + r.width / 2, y)?.closest('.reader-flow p'); if (e) return /Paragraph (\d+)/.exec(e.textContent)?.[1] ?? e.textContent.slice(0, 12); } return null; });
  const restart = async () => { await p.goto(base); await p.waitForSelector('.library-view, .reader-view', { timeout: 20000 }); await p.waitForTimeout(3500); return where(); };
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id); await p.waitForSelector('.reader-flow .kr-content p'); await p.waitForTimeout(1500);
  await p.evaluate(() => { const el = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith('Paragraph 40.')); const sc = document.querySelector('.reader-scroll'); sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top; });
  await p.waitForTimeout(1500);
  const was = await topPara();
  w = await restart();
  ok('the app started again under an open book: the book is open again', w.reader && /^#\/read\//.test(w.hash), w);
  const now = await topPara();
  ok('… at its place', now === was, { was, now });
  await p.waitForTimeout(21000);   // (read a while: it did not end the app)
  // Left by the reader: the next start is the library's.
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(500);
  w = await restart();
  ok('a book left by the reader is not opened again at the next start', w.library && !w.reader, w);
  // A book that ends the app each time: opened again once, not twice in a row.
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id); await p.waitForSelector('.reader-flow .kr-content p'); await p.waitForTimeout(800);
  w = await restart();
  ok('ended once: opened again', w.reader, w);
  w = await restart();
  ok('ended again at once: not opened a third time (the library)', w.library && !w.reader, w);
  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed');
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
