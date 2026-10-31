// Screenshots of a book's page in the dark tones and in light, on a phone.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.join(__dirname, '..', '..', 'dist'); const FIX = path.join(__dirname, '..', 'fixtures'); const SHOTS = path.join(__dirname, '..', 'shots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(5191, r));
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5191/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [path.join(FIX, 'alice-in-wonderland.epub')]); await page.waitForSelector('.book-card'); await page.waitForTimeout(400);
  await page.click('.book-card'); await page.waitForSelector('.book-view .chapter-list li', { timeout: 20000 }); await page.waitForTimeout(500);
  for (const [tone, mode] of [['dim', 'dark'], ['grey', 'dark'], ['black', 'dark'], ['dim', 'light']]) {
    await page.evaluate(([tone, mode]) => { const v = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); v.darkTone = tone; v.uiMode = mode; localStorage.setItem('kr.visual', JSON.stringify(v)); }, [tone, mode]);
    await page.reload(); await page.waitForSelector('.book-view .chapter-list li', { timeout: 20000 }); await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/bookpage-${tone}-${mode}.png` });
  }
  console.log('errors', errors); await browser.close(); server.close();
})();
