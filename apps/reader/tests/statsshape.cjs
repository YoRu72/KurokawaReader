// node tests/statsshape.cjs: a book whose statistics were kept in another shape — no `days`, no counters (older data,
// or test data) — opens and is read without an error, and its statistics come out whole: the time read counted today
// on top of what it had (src/stats.ts ReadingTracker); its information sheet opens too (src/ui/bookinfo.ts).
// (The book is made here: no fixtures.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-statsshape-'));

(async () => {
  const txt = path.join(TMP, 'shape.txt');
  fs.writeFileSync(txt, ['The Shape Book', ...Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}: words to read on, and on, and on again.`)].join('\n\n') + '\n');
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 800, height: 800 }, locale: 'en' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('.library-view input[type=file]', [txt]);
  const book = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0] ?? null); }; }));
  let b = null; for (let i = 0; i < 80 && !b; i++) { b = await book(); if (!b) await p.waitForTimeout(250); }
  for (const [name, stats] of [['no days', { ms: 120000, words: 300 }], ['nothing but days of null', { days: null }]]) {
    await p.evaluate(([id, stats]) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const t = r.result.transaction('books', 'readwrite'); const s = t.objectStore('books'); const g = s.get(id); g.onsuccess = () => { const x = g.result; x.stats = stats; s.put(x); }; t.oncomplete = res; }; }), [b.id, stats]);
    await p.reload(); await p.waitForSelector('.library-view'); await p.waitForTimeout(400);
    const before = errors.length;
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, b.id);
    await p.waitForSelector('.reader-flow .kr-content p', { state: 'visible', timeout: 30000 });
    await p.waitForTimeout(6500);                                           // (a tick of the tracker: 5 s)
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'statusLine' })));
    await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.dataset.action === 'info'); b?.click(); });
    await p.waitForTimeout(400);
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(800);
    const after = (await book()).stats;
    const today = Object.values(after?.days ?? {})[0];
    ok(`${name}: opened and read without an error`, errors.length === before, errors.slice(before));
    ok(`${name}: the statistics come out whole — the time read today counted, on top of what was kept`, !!after && typeof after.days === 'object' && today && today.ms > 3000 && after.ms >= (stats.ms ?? 0) + 3000 && Number.isFinite(after.words), after);
  }
  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
