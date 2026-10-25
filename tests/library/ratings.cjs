// Stars in the details sheet, the rating sort and badge, the «new» mark, the random book and the stats calendar.
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.join(__dirname, '..', '..', 'dist'); const FIX = path.join(__dirname, '..', 'fixtures'); const SHOTS = path.join(__dirname, '..', 'shots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(5187, r));
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:5187/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload();
  await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', fs.readdirSync(FIX).slice(0, 3).map((f) => path.join(FIX, f)));
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 3, null, { timeout: 60000 }); await page.waitForTimeout(500);
  // Leave and come back: books added since the last visit carry «جديد».
  await page.evaluate(() => { localStorage.setItem('kr.libraryVisit', '1'); const v = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); v.calendar = 'both'; localStorage.setItem('kr.visual', JSON.stringify(v)); });
  await page.reload(); await page.waitForSelector('.book-card');
  console.log('new marks', await page.$$eval('.badge.new', (b) => b.length));
  await page.evaluate(() => { const c = document.querySelector('.book-card'); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); });
  await page.waitForTimeout(400);
  const detailsBtn = await page.$('text=التفاصيل'); if (detailsBtn) { await detailsBtn.click(); await page.waitForTimeout(400); }
  await page.waitForSelector('.stars .star');
  await page.click('.stars .star:nth-child(4)'); await page.waitForTimeout(300);
  console.log('stars on', await page.$$eval('.stars .star.on', (b) => b.length));
  await page.screenshot({ path: `${SHOTS}/ratings-details.png` });
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  console.log('badge', await page.$eval('.stars-badge', (b) => b.textContent));
  await page.selectOption('select', 'rating').catch(() => {});
  await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/ratings-library.png` });
  await page.click('[aria-label="افتح كتابًا على غير اختيار"]'); await page.waitForSelector('.reader-view, .reader-scroll', { timeout: 20000 }); console.log('random opened', page.url());
  await page.goto('http://localhost:5187/'); await page.waitForSelector('.book-card');
  const statsBtn = await page.$('[aria-label="إحصاءات القراءة"], [aria-label="Reading statistics"]'); if (statsBtn) await statsBtn.click();
  await page.waitForSelector('.stats-cal i', { timeout: 5000 }).then(async () => { await page.waitForTimeout(600); console.log('calendar cells', await page.$$eval('.stats-cal i', (c) => c.length)); await page.screenshot({ path: `${SHOTS}/ratings-stats.png` }); }, () => console.log('stats not opened'));
  console.log('errors', errors); await browser.close(); server.close();
})();
