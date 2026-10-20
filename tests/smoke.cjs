const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const FIX = path.join(__dirname, 'fixtures');
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.map': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  let f = path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(5180, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  const lang = process.argv[2] || 'en';
  await page.goto('http://localhost:5180/');
  await page.evaluate((l) => localStorage.setItem('kr.lang', l), lang);
  await page.reload();
  await page.waitForSelector('.library-view');
  await page.screenshot({ path: `${SHOTS}/${lang}-01-empty.png` });

  const files = fs.readdirSync(FIX).map((f) => path.join(FIX, f));
  await page.setInputFiles('input[type=file]', files);
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 8, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/${lang}-02-library.png` });

  const titles = await page.$$eval('.book-card .bt', (els) => els.map((e) => e.textContent));
  console.log('library:', titles.join(' | '));

  // Multi-book: select both EPUBs and read together.
  const selectBtn = await page.$('.topbar button[aria-pressed]');
  await selectBtn.click();
  for (const t of ['Alice', 'مقامات']) await page.click(`.book-card:has-text("${t}")`);
  await page.click('.selection-bar .primary');
  await page.waitForSelector('.kr-doc .kr-content', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.kr-doc .kr-content').length === 2, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${lang}-03-epub-multi-top.png` });
  const ndocs = await page.$$eval('.kr-doc', (d) => d.length);
  const nimgs = await page.$$eval('.kr-content img', (d) => d.length);
  console.log('multi-read docs:', ndocs, 'images:', nimgs);
  // Scroll into the second book
  await page.evaluate(() => { const s = document.querySelector('.reader-scroll'); s.scrollTop = s.scrollHeight * 0.7; });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${lang}-04-epub-multi-arabic.png` });
  console.log('footer:', await page.textContent('.read-footer'));
  // TOC panel
  await page.click('[aria-label="' + (lang === 'ar' ? 'الفهرس' : 'Contents') + '"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${lang}-05-toc.png` });
  console.log('toc entries:', await page.$$eval('.toc-list li', (l) => l.length));
  await page.keyboard.press('Escape');
  // Search
  await page.keyboard.press('/');
  await page.fill('.panel input[type=search]', lang === 'ar' ? 'الحارث' : 'white rabbit');
  await page.waitForTimeout(600);
  console.log('search:', await page.textContent('.panel-body div'));
  await page.screenshot({ path: `${SHOTS}/${lang}-06-search.png` });
  await page.keyboard.press('Escape');
  // Visual options
  await page.keyboard.press('v');
  await page.waitForTimeout(300);
  await page.click('.theme-swatches button >> nth=2');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${lang}-07-options-sepia.png` });
  await page.click('.theme-swatches button >> nth=0');
  await page.keyboard.press('Escape');
  // Gallery
  await page.keyboard.press('g');
  await page.waitForTimeout(500);
  console.log('gallery images:', await page.$$eval('.gallery-grid img', (l) => l.length));
  await page.screenshot({ path: `${SHOTS}/${lang}-08-gallery.png` });
  await page.keyboard.press('Escape');
  // Selection toolbar
  await page.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const ps = [...document.querySelectorAll('.kr-content p')]; const top = sc.getBoundingClientRect().top; const p = ps.find((x) => x.getBoundingClientRect().top > top + 20 && x.getBoundingClientRect().bottom < top + sc.clientHeight - 20) || ps[0]; const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.waitForTimeout(500);
  console.log('selection toolbar buttons:', await page.$$eval('.sel-toolbar button', (b) => b.map((x) => x.textContent).join(',')));
  await page.screenshot({ path: `${SHOTS}/${lang}-09-selection.png` });
  await page.click('.sel-toolbar button:has-text("' + (lang === 'ar' ? 'تمييز' : 'Highlight') + '")');
  await page.waitForTimeout(300);
  console.log('highlights:', await page.$$eval('mark.kr-hl', (m) => m.length));
  // Bookmark
  await page.keyboard.press('b');
  await page.waitForTimeout(300);
  // Back to library — progress saved?
  await page.goto('http://localhost:5180/#/');
  await page.waitForSelector('.book-card');
  await page.waitForTimeout(500);

  async function openBook(title, shot, waitSel) {
    await page.click(`.book-card:has-text("${title}")`);
    await page.waitForSelector(waitSel, { timeout: 30000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${SHOTS}/${lang}-${shot}.png` });
    await page.goto('http://localhost:5180/#/');
    await page.waitForSelector('.book-card');
    await page.waitForTimeout(300);
  }
  // PDF
  await page.click('.book-card:has-text("Sample Report")');
  await page.waitForSelector('.pdf-page canvas', { timeout: 30000 });
  await page.waitForTimeout(800);
  console.log('pdf count:', await page.textContent('.pcount'));
  await page.screenshot({ path: `${SHOTS}/${lang}-10-pdf.png` });
  await page.fill('.pdf-bar input[type=number]', '5');
  await page.press('.pdf-bar input[type=number]', 'Enter');
  await page.waitForTimeout(700);
  console.log('pdf after goto:', await page.textContent('.pcount'));
  await page.keyboard.press('/');
  await page.fill('.panel input[type=search]', 'line 7');
  await page.waitForTimeout(1500);
  console.log('pdf search:', await page.textContent('.panel-body div'));
  await page.screenshot({ path: `${SHOTS}/${lang}-11-pdf-search.png` });
  await page.keyboard.press('Escape');
  await page.click('[aria-label="' + (lang === 'ar' ? 'الفهرس' : 'Contents') + '"]');
  await page.waitForTimeout(500);
  console.log('pdf outline:', await page.$$eval('.toc-list li', (l) => l.length));
  await page.keyboard.press('Escape');
  await page.goto('http://localhost:5180/#/');
  await page.waitForSelector('.book-card');
  await page.waitForTimeout(300);

  await openBook('Meeting Notes', '12-docx', '.kr-docx');
  await openBook('Budget', '13-xlsx', '.kr-sheet table');
  await openBook('Quarterly Review', '14-pptx', '.kr-slide');
  await openBook('Markdown Notes', '15-md', '.kr-md');
  await openBook('A Plain Text Title', '16-txt', '.kr-text');
  await openBook('data', '17-csv', '.kr-sheet table');

  // Settings
  await page.goto('http://localhost:5180/#/settings');
  await page.waitForSelector('.settings-view');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${lang}-18-settings.png`, fullPage: true });

  // Mobile viewport check
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await mobile.newPage();
  mp.on('pageerror', (e) => errors.push('[mobile pageerror] ' + e.message));
  await mp.goto('http://localhost:5180/');
  await mp.evaluate((l) => localStorage.setItem('kr.lang', l), lang);
  await mp.reload();
  await mp.waitForSelector('.library-view');
  await mp.setInputFiles('input[type=file]', [path.join(FIX, 'maqamat-al-hariri.epub'), path.join(FIX, 'alice-in-wonderland.epub')]);
  await mp.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 60000 });
  await mp.waitForTimeout(500);
  await mp.screenshot({ path: `${SHOTS}/${lang}-m1-library.png` });
  await mp.click('.book-card:has-text("مقامات")');
  await mp.waitForSelector('.kr-content');
  await mp.waitForTimeout(800);
  await mp.screenshot({ path: `${SHOTS}/${lang}-m2-arabic-epub.png` });

  console.log('\nconsole errors/warnings:\n' + (errors.filter((e) => !e.includes('favicon')).join('\n') || '(none)'));
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
