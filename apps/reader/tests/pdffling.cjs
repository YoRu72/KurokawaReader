// Scrolling a PDF fast on a phone: two quick flicks ending at much the same spot are not a double tap (the page zoomed
// in mid-scroll); a real double tap still zooms in.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message)); const check = (w, ok) => { console.log(ok ? 'ok  ' : 'FAIL', w); if (!ok) errors.push(w); };
  await page.goto(`http://localhost:${port}/`); await page.evaluate(() => localStorage.setItem('kr.update.lastCheck', String(Date.now()))); await page.reload(); await page.waitForSelector('.library-view, .library', { timeout: 30000 }).catch(() => undefined);
  await page.setInputFiles('input[type=file]', [path.join(__dirname, 'pdfsearch', 'sample.pdf')]); await page.waitForSelector('.book-card', { timeout: 60000 });
  await page.click('.book-card'); await page.waitForSelector('.pdf-page', { timeout: 60000 }); await page.waitForTimeout(1200);
  const cdp = await ctx.newCDPSession(page);
  const width = () => page.evaluate(() => document.querySelector('.pdf-page').getBoundingClientRect().width);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const flick = async () => { await touch('touchStart', 200, 700); for (let y = 650; y >= 250; y -= 50) { await touch('touchMove', 200, y); } await touch('touchEnd', 200, 250); };
  const w0 = await width();
  await flick(); await page.waitForTimeout(60); await flick(); await page.waitForTimeout(700);
  check('two fast flicks do not zoom in', Math.abs((await width()) - w0) < 2);
  await page.waitForTimeout(500);
  const tap = async () => { await touch('touchStart', 14, 450); await touch('touchEnd', 14, 450); };
  await tap(); await page.waitForTimeout(90); await tap(); await page.waitForTimeout(900);
  check('a real double tap still zooms in', (await width()) > w0 * 1.5);
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed'); await browser.close(); server.close(); process.exit(errors.length ? 1 : 0);
})();
