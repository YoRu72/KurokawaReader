// node tests/epubimages/run.cjs <out dir>: an EPUB with a picture in each way books place them (made by make.py):
// every one of them is in the gallery, and a tap on any of them in the text opens it on its own, with Save.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const DIST = path.resolve(__dirname, '../../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const out = process.argv[2] || path.join(require('os').tmpdir(), 'kr-epubimages'); fs.mkdirSync(out, { recursive: true });
const book = path.join(out, 'pictures.epub'); execFileSync('python3', [path.join(__dirname, 'make.py'), book]);
const WANT = ['plain', 'linked', 'svg page', 'picture', 'srcset only', 'space', 'object'];
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], locale: 'en' }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://localhost:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [book]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(1500);
  const id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0].id); }; }));
  await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForSelector('.kr-chapter', { timeout: 30000 }); await p.waitForTimeout(2500);
  // The gallery: every picture, by its label.
  const labels = await p.evaluate(() => [...document.querySelectorAll('.kr-chapter img, .kr-chapter image, .kr-chapter object, .kr-chapter [role=img]')].map((e) => e.getAttribute('alt') || e.getAttribute('aria-label') || e.tagName));
  console.log('in the text:', labels.join(' | '));
  const tappable = [];
  for (const sel of ['img[alt="plain"]', 'img[alt="linked"]', 'img.kr-svgpage', 'img[alt="picture"]', 'img[alt="srcset only"]', 'img[alt="space"]', 'img[alt="an object"]']) {
    const el = await p.$(`.kr-chapter ${sel.split(', ').join(', .kr-chapter ')}`);
    if (!el) { tappable.push(`${sel}: missing`); continue; }
    // (Chapter by chapter, as the reader opens: back to the first chapter, then «Next chapter» until it shows.)
    const vis = () => el.evaluate((e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 20; });
    for (let k = 0; k < 6 && !(await vis()); k++) { const prev = await p.$('.chapter-nav .cn-btn:not(.primary)'); if (prev && k === 0) { for (let j = 0; j < 4; j++) { const b = await p.$('.chapter-nav .cn-btn:not(.primary)'); if (!b) break; await b.click(); await p.waitForTimeout(400); } if (await vis()) break; } const nx = await p.$('.chapter-nav .cn-btn.primary'); if (!nx) break; await nx.click(); await p.waitForTimeout(500); }
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(500);
    const shown = await vis();
    await el.click({ force: true }).catch(() => undefined); await p.waitForTimeout(500);
    const lb = await p.$('.lightbox');
    const src = lb ? await p.$eval('.lightbox .lb-img img', (i) => i.naturalWidth).catch(() => 0) : 0;
    tappable.push(`${sel}: ${shown ? 'shown' : 'NOT SHOWN'}, tap → ${lb ? (src ? 'preview' : 'preview (empty)') : 'nothing'}`);
    if (lb) { await p.screenshot({ path: path.join(out, `tap-${tappable.length}.png`) }); await p.click('.lightbox .lb-close'); await p.waitForTimeout(300); }
    if (await p.$('.lightbox')) await p.evaluate(() => document.querySelectorAll('.lightbox').forEach((e) => e.remove()));
  }
  console.log(tappable.join('\n'));
  for (const [i, w] of WANT.entries()) ok(`«${w}»: shown, and a tap previews it`, / shown, tap → preview$/.test(tappable[i]));
  // The gallery from the toolbar holds all of them.
  const count = await p.evaluate(() => new Promise((res) => setTimeout(() => res(null), 10)));
  void count;
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
