// node tests/librarysearch.cjs <outdir> <query> <file...>: import books, search across them from the library, print
// the grouped results, open the first hit, and save screenshots.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [out, query, ...files] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
(async () => {
  await new Promise((r) => server.listen(5190, r));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: Number(process.env.W || 430), height: 900 }, deviceScaleFactor: 2 })).newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message)); p.on('dialog', (d) => void d.dismiss());
  await p.goto('http://localhost:5190/'); await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, process.env.LANG2 || 'ar'); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', files.map((f) => path.resolve(f))); await p.waitForFunction((n) => document.querySelectorAll('.book-card').length >= n, files.length, { timeout: 120000 }); await p.waitForTimeout(800);
  await p.screenshot({ path: path.join(out, '1-library.png') });
  await p.click('.library-tools .tool-btn:last-child'); await p.waitForSelector('.libsearch-sheet .ls-input');
  await p.fill('.ls-input', query); const t0 = Date.now(); await p.click('.ls-go.primary');
  await p.waitForTimeout(300); await p.waitForFunction(() => !!document.querySelector('.libsearch-sheet .btn.tonal.ls-go[hidden]'), null, { timeout: 600000 });
  console.log('first search ms', Date.now() - t0, '|', await p.textContent('.ls-status'));
  for (const g of await p.$$eval('.ls-group', (els) => els.map((e) => e.querySelector('.ls-title b').textContent + ' [' + e.querySelector('.ls-count').textContent + '] ' + [...e.querySelectorAll('.ls-hit')].slice(0, 3).map((x) => x.innerText.replace(/\s*\n\s*/g, ' | ')).join('  //  ')))) console.log(g);
  await p.screenshot({ path: path.join(out, '2-results.png') });
  // Again (from the stored text): quick.
  const t1 = Date.now(); await p.click('.ls-go.primary'); await p.waitForTimeout(300); await p.waitForFunction(() => !!document.querySelector('.libsearch-sheet .btn.tonal.ls-go[hidden]'), null, { timeout: 600000 }); console.log('second search ms', Date.now() - t1);
  await p.click('.ls-filters > summary'); await p.waitForTimeout(300); await p.screenshot({ path: path.join(out, '3-filters.png') });
  await p.click('.ls-filters > summary'); await p.waitForTimeout(200);
  // Scrolled down a little, open a hit; going back from the book opens the search again where it was.
  const hits = await p.$$('.ls-hit'); const pick = hits[Math.min(3, hits.length - 1)];
  await pick.scrollIntoViewIfNeeded(); const scrolled = await p.$eval('.libsearch-sheet .sheet-body', (e) => e.scrollTop);
  await pick.click(); await p.waitForTimeout(4000); await p.screenshot({ path: path.join(out, '4-opened.png') });
  await p.click('.reader-view .topbar .icon-btn[data-icon="back"]');
  await p.waitForSelector('.libsearch-sheet .ls-hit', { timeout: 60000 }); await p.waitForTimeout(800);
  console.log('back: query', await p.$eval('.ls-input', (e) => e.value), '| scroll', scrolled, '->', await p.$eval('.libsearch-sheet .sheet-body', (e) => e.scrollTop), '|', await p.textContent('.ls-status'));
  await p.screenshot({ path: path.join(out, '5-back.png') });
  await b.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
