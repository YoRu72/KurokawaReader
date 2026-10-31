// Library selection: Ctrl+click and right-click pick books; the bar converts several at once.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.join(__dirname, '..', '..', 'dist'); const FIX = path.join(__dirname, '..', 'fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(5193, r));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, acceptDownloads: true }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:5193/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', fs.readdirSync(FIX).filter((f) => /\.(txt|md)$/.test(f)).map((f) => path.join(FIX, f))); await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2); await page.waitForTimeout(400);
  await page.click('.book-card:nth-child(1)', { modifiers: ['Control'] }); await page.waitForTimeout(200);
  await page.click('.book-card:nth-child(2)', { button: 'right' }); await page.waitForTimeout(200);
  console.log('selected', await page.$eval('.sel-count', (e) => e.textContent), 'bar', !!(await page.$('.selection-bar:not([hidden]) .sel-act')));
  await page.click('.sel-act[aria-label="تحويل"]'); await page.waitForSelector('.convert-targets'); await page.waitForTimeout(200);
  await page.click('.convert-target:has-text("EPUB")'); await page.waitForSelector('.convert-result:not([hidden]) button', { timeout: 60000 });
  console.log('status', await page.$eval('.sheet .src', (e) => e.textContent));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.convert-result button:has-text("ZIP")')]); console.log('zip', dl.suggestedFilename());
  console.log('errors', errors); await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
