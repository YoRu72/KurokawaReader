// How fast covers come on a far site: the mock OTL with a delay on every answer (as a far server, or the app's
// browser in between, adds), the shelf's first screen of covers timed, the requests per file counted; a
// series' page; then the app opened again (covers from the device). node tests/sources/covers-bench.cjs <fixtures> [ms]
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const DIST = path.resolve(process.env.DIST || path.join(__dirname, '../../dist')); const BOOKS = path.resolve(process.argv[2] || '.'); const DELAY = Number(process.argv[3] || 150);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const MOCK = 'http://localhost:5431';
(async () => {
  await new Promise((r) => server.listen(5432, r));
  const mock = spawn('node', [path.join(__dirname, 'server.cjs'), '5431', BOOKS], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 700));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en' }); const page = await ctx.newPage();
  await ctx.route('https://raw.githubusercontent.com/YoRu72/KurokawaReader/main/extensions/otl.json', async (route) => route.fulfill({ response: await route.fetch({ url: `${MOCK}/extensions/otl.json` }) }));
  await ctx.route('https://server.elscione.com/**', async (route) => { const req = route.request(); const u = new URL(req.url()); if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' } }); return route.fulfill({ response: await route.fetch({ url: MOCK + u.pathname + u.search }) }); });
  const base = 'http://localhost:5432/';
  const hits = async () => (await fetch(`${MOCK}/__otl/files`)).json();
  try {
    await page.goto(base); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
    await page.goto(base + '#/sources'); await page.waitForSelector('.sources-hub');
    await page.click('.topbar-actions button[data-icon="plus"]'); await page.waitForSelector('.sheet input[type=url]');
    await page.fill('.sheet input[type=url]', 'OTL'); await page.press('.sheet input[type=url]', 'Enter');
    await page.waitForSelector('.folder-card', { timeout: 20000 });
    await fetch(`${MOCK}/__otl/latency?ms=${DELAY}`);
    let t0 = Date.now();
    await page.click('.folder-card .source-head');
    await page.waitForFunction(() => /Indexed:/.test(document.querySelector('.src-index')?.textContent || ''), null, { timeout: 60000 });
    const tIndex = Date.now() - t0;
    // The first screen of cards: every one with its cover.
    const onScreen = () => page.evaluate(() => [...document.querySelectorAll('.src-card.folder')].filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).map((c) => !!c.querySelector('.src-cover.has-img img')));
    await page.waitForFunction(() => document.querySelectorAll('.src-card.folder').length > 6, null, { timeout: 20000 });
    t0 = Date.now();
    await page.waitForFunction(() => { const cs = [...document.querySelectorAll('.src-card.folder')].filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && !/EPUB|Reader/.test(c.title); }); return cs.length && cs.every((c) => c.querySelector('.src-cover.has-img img')); }, null, { timeout: 60000, polling: 50 });
    const tShelf = Date.now() - t0;
    const shown = (await onScreen()).length;
    const per = {}; for (const [f] of await hits()) per[f] = (per[f] || 0) + 1;
    const counts = Object.values(per);
    console.log(`delay ${DELAY} ms · index ${tIndex} ms · first screen (${shown} cards) covered in ${tShelf} ms · requests per file: ${counts.length ? (counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2) : '-'} (max ${Math.max(0, ...counts)})`);
    // A series' page with many volumes: every row on the screen with its cover.
    const hash = await page.evaluate(() => location.hash);
    t0 = Date.now();
    await page.goto(base + hash.replace(/\?.*$/, '') + '?shelf=' + encodeURIComponent('Series%20015%20Chronicle%20of%20Tides'));
    await page.waitForSelector('.vol-row', { timeout: 20000 });
    const tRows = Date.now() - t0;
    await page.waitForFunction(() => { const rs = [...document.querySelectorAll('.vol-row')].filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; }); return rs.length && rs.every((r) => r.querySelector('.vol-cover img')); }, null, { timeout: 60000, polling: 50 });
    const tSeries = Date.now() - t0;
    console.log(`series page: rows in ${tRows} ms, the screen's covers in ${tSeries} ms (${await page.$$eval('.vol-row', (rs) => rs.length)} rows)`);
    // The app opened again: the shelf's covers from the device.
    await page.goto(base + '#/sources'); await page.reload(); await page.waitForSelector('.sources-hub');
    const before = (await hits()).length;
    t0 = Date.now();
    await page.goto(base + hash);
    await page.waitForFunction(() => { const cs = [...document.querySelectorAll('.src-card.folder')].filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && !/EPUB|Reader/.test(c.title); }); return cs.length > 3 && cs.every((c) => c.querySelector('.src-cover.has-img img')); }, null, { timeout: 60000, polling: 50 });
    console.log(`opened again: the first screen covered in ${Date.now() - t0} ms, ${(await hits()).length - before} file requests`);
  } finally { await browser.close(); server.close(); mock.kill(); }
})();
