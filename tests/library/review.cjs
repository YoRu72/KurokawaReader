// Rate a book, write a review, and make its picture in every style.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.join(__dirname, '..', '..', 'dist'); const FIX = path.join(__dirname, '..', 'fixtures'); const SHOTS = path.join(__dirname, '..', 'shots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(5188, r));
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:5188/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload();
  await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', fs.readdirSync(FIX).filter((f) => /alice|epub/i.test(f)).slice(0, 1).map((f) => path.join(FIX, f)));
  await page.waitForSelector('.book-card'); await page.waitForTimeout(600);
  // Hold the card: selection mode, then «تقييم ومراجعة».
  const card = await page.$('.book-card'); const b = await card.boundingBox();
  await page.mouse.move(b.x + 40, b.y + 40); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up(); await page.waitForTimeout(300);
  await page.click('.sel-act[aria-label="تقييم ومراجعة"]'); await page.waitForSelector('.review-text');
  await page.click('.stars.big .star:nth-child(5)');
  await page.fill('.review-text', 'كتابٌ بديع، قرأته في ليلتين. حكايةُ أليس لا تشيخ، وترجمتُه رشيقة.');
  await page.screenshot({ path: `${SHOTS}/review-1-sheet.png` });
  await page.click('button:has-text("بطاقة المراجعة")'); await page.waitForSelector('.snap-preview'); await page.waitForTimeout(600);
  // Words and the chapter count can be set from the card itself.
  await page.fill('.sheet:last-of-type .review-text', 'كتابٌ بديع، قرأته في ليلتين.'); await page.fill('.sheet:last-of-type input[type=number]', '12'); await page.$eval('.sheet:last-of-type input[type=number]', (e) => e.dispatchEvent(new Event('change')));
  await page.click('.chip.check:has-text("الفصول") input'); await page.waitForTimeout(900);
  await page.selectOption('.sheet:last-of-type select', 'both'); await page.waitForTimeout(600);
  const styles = ['ورق', 'ليل', 'الغلاف', 'بسيط', 'حبر'];
  for (const st of styles) { await page.click(`.chip[role=radio]:has-text("${st}")`); await page.waitForTimeout(500); const data = await page.$eval('.snap-preview', (c) => c.toDataURL('image/png')); fs.writeFileSync(`${SHOTS}/review-card-${st}.png`, Buffer.from(data.split(',')[1], 'base64')); }
  await page.screenshot({ path: `${SHOTS}/review-2-card.png` });
  console.log('errors', errors); await browser.close(); server.close();
})();
