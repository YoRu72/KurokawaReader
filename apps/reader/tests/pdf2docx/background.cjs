// node tests/pdf2docx/background.cjs <file.pdf>: a PDF → Word conversion started, then the app put out of sight
// (as when the phone's app is left: no more screen frames): the conversion must go on and finish there — pages
// drawn off the screen do not wait for screen frames, which never come to a page out of sight.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(process.env.DIST || path.join(__dirname, '../../dist'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const pdf = path.resolve(process.argv[2] || path.join(__dirname, '../fixtures/sample.pdf'));
(async () => {
  await new Promise((r) => server.listen(5198, r));
  const browser = await chromium.launch({ headless: !process.env.HEADED }); const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } }); const page = await ctx.newPage();
  const ok = (name, cond) => console.log((cond ? 'ok  ' : 'FAIL'), name);
  try {
    await page.goto('http://localhost:5198/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
    await page.setInputFiles('input[type=file]', [pdf]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(500);
    const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
    if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
    await page.waitForSelector('.convert-target');
    await page.click('.convert-target:has-text("Word")');
    // Out of sight at once — as a page out of sight is: no screen frames come any more (requestAnimationFrame
    // never calls back), and the page says it is hidden.
    await page.evaluate(() => { window.requestAnimationFrame = () => 0; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    const hidden = await page.evaluate(() => document.visibilityState);
    const t0 = Date.now(); let done = false;
    while (Date.now() - t0 < Number(process.env.WAIT || 60000)) {
      done = await page.evaluate(() => !!document.querySelector('.convert-result:not([hidden]) button')).catch(() => false);
      if (done) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    ok(`the app out of sight (${hidden}): the conversion went on and finished there${done ? ` (in ${Date.now() - t0} ms)` : ''}`, hidden === 'hidden' && done);
  } finally { await browser.close(); server.close(); }
})();
