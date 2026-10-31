// node tests/startup.cjs: how long the app takes to show the library on a slow phone (CPU 4× slower, a 3G-ish
// network), with an empty library and with 40 books — and what is fetched before first paint.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = process.env.DIST || path.join(__dirname, '..', 'dist'); const FIX = path.join(__dirname, 'fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(5210, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU || 4) });
  const fetched = []; page.on('request', (r) => fetched.push(r.url().replace('http://localhost:5210', '')));
  const measure = async (label) => {
    fetched.length = 0;
    const t0 = Date.now();
    await page.goto('http://localhost:5210/', { waitUntil: 'commit' });
    await page.waitForSelector('.library-view');
    const shown = Date.now() - t0;
    await page.waitForFunction(() => document.querySelectorAll('.book-card, .empty').length > 0, null, { timeout: 30000 });
    const cards = Date.now() - t0;
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const p = performance.getEntriesByType('paint'); return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: Math.round(p.find((x) => x.name === 'first-contentful-paint')?.startTime ?? 0) }; });
    const js = fetched.filter((u) => u.endsWith('.js')); const fonts = fetched.filter((u) => /\.(ttf|woff2?)$/.test(u));
    console.log(`${label}: library shown ${shown} ms, cards ${cards} ms, fcp ${nav.fcp} dcl ${nav.dcl} load ${nav.load} | ${js.length} scripts, ${fonts.length} fonts, ${fetched.length} requests`);
    if (process.env.V) console.log(fetched.join('\n'));
  };
  await page.goto('http://localhost:5210/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); });
  await measure('empty');
  await measure('empty (warm)');
  const files = fs.readdirSync(FIX).map((f) => path.join(FIX, f));
  await page.setInputFiles('input[type=file]', files); await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 8, null, { timeout: 60000 });
  await measure('9 books');
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
