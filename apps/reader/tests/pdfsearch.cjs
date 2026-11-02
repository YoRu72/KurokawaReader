// node tests/pdfsearch.cjs: searching a PDF — a hit opened shows a bar over the page that steps through the hits
// (↑ ↓) without the panel; the search opened again shows the last one as it was (kept unless the switch is off).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 412, height: 860 }, locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [path.join(__dirname, 'fixtures/sample.pdf')]); await p.waitForSelector('.book-card', { timeout: 60000 });
  await p.click('.book-card'); await p.waitForSelector('.pdf-page', { timeout: 30000 }); await p.waitForTimeout(1200);
  await p.keyboard.press('/'); await p.waitForSelector('.panel.open input[type=search]');
  await p.fill('.panel.open input[type=search]', 'line 3:'); await p.waitForSelector('.panel.open .hit', { timeout: 30000 }); await p.waitForTimeout(2500);
  const n = (await p.$$('.panel.open .hit')).length; console.log('hits:', n);
  await p.click('.panel.open .hit >> nth=0'); await p.waitForTimeout(300);
  if (await p.$('.panel.open')) await p.click('.panel.open .panel-head button');
  await p.waitForSelector('.search-nav'); const t1 = await p.$eval('.search-nav-text', (e) => e.textContent); console.log('nav:', t1);
  ok('a hit opened: the bar over the page, the first of all', /^1 \/ \d+/.test(t1) && n > 1);
  await p.click('.search-nav button[aria-label="Next result"]'); await p.waitForTimeout(200);
  const t2 = await p.$eval('.search-nav-text', (e) => e.textContent); console.log('next:', t2);
  ok('the next hit without the panel', /^2 \//.test(t2) && /Page 2/.test(t2));
  await p.click('.search-nav button[aria-label="Previous result"]'); await p.click('.search-nav button[aria-label="Previous result"]'); await p.waitForTimeout(200);
  ok('back past the first: the last', new RegExp(`^${n} /`).test(await p.$eval('.search-nav-text', (e) => e.textContent)));
  await p.click('.search-nav button[aria-label="Search in book"]'); await p.waitForSelector('.panel.open .hit');
  ok('opened again: the last search as it was', (await p.inputValue('.panel.open input[type=search]')) === 'line 3:' && (await p.$$('.panel.open .hit')).length === n && !!(await p.$('.panel.open .hit.current')));
  await p.click('.panel.open .search-keep input'); await p.click('.panel.open .panel-head button'); await p.keyboard.press('/'); await p.waitForSelector('.panel.open input[type=search]');
  ok('the switch off: a new search each time', (await p.inputValue('.panel.open input[type=search]')) === '');
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
