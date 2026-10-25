// The book page: chapters listed with the read ones marked, resume, and AniList tracking against a mock server.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.join(__dirname, '..', '..', 'dist'); const FIX = path.join(__dirname, '..', 'fixtures'); const SHOTS = path.join(__dirname, '..', 'shots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(5189, r));
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // A pretend AniList.
  let entry = null;
  await page.route('https://graphql.anilist.co', async (route) => {
    const { query, variables } = JSON.parse(route.request().postData());
    const media = { id: 30044, title: { romaji: 'Alice in Wonderland', english: "Alice's Adventures in Wonderland", native: '不思議の国のアリス' }, coverImage: {}, format: 'NOVEL', status: 'FINISHED', startDate: { year: 1865 }, averageScore: 77, chapters: 12, volumes: 1, description: 'A girl falls down a rabbit hole.', siteUrl: 'https://anilist.co/manga/30044', mediaListEntry: entry };
    let data;
    if (query.includes('Viewer')) data = { Viewer: { id: 1, name: 'maomao', avatar: {}, mediaListOptions: { scoreFormat: 'POINT_10' } } };
    else if (query.includes('Page(')) data = { Page: { media: [media] } };
    else if (query.includes('SaveMediaListEntry')) { entry = { id: 9, status: variables.status, progress: variables.progress, score: variables.score, startedAt: variables.startedAt, completedAt: variables.completedAt }; data = { SaveMediaListEntry: entry }; }
    else if (query.includes('Media(')) data = { Media: media };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  await page.goto('http://localhost:5189/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); const v = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); v.anilistEnabled = true; v.anilistClientId = '1'; localStorage.setItem('kr.visual', JSON.stringify(v)); localStorage.setItem('kr.anilist.token', 'tok'); localStorage.setItem('kr.anilist.user', JSON.stringify({ id: 1, name: 'maomao', scoreFormat: 'POINT_10' })); }); await page.reload();
  await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', fs.readdirSync(FIX).filter((f) => /alice/i.test(f)).slice(0, 1).map((f) => path.join(FIX, f)));
  await page.waitForSelector('.book-card'); await page.waitForTimeout(500);
  await page.click('.book-card'); await page.waitForSelector('.book-view .chapter-list li', { timeout: 20000 }); await page.waitForTimeout(400);
  console.log('chapters', await page.$$eval('.chapter-list li', (l) => l.length), 'url', page.url());
  await page.screenshot({ path: `${SHOTS}/bookpage-1.png` });
  // Jump to chapter 4, read a little, come back: it is current and earlier ones read.
  await page.click('.chapter-list li:nth-child(4) button'); await page.waitForSelector('.reader-scroll', { timeout: 20000 }); await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('.reader-scroll').scrollBy(0, 400)); await page.waitForTimeout(1500);
  // The reader's own back arrow returns to the book's page, not the library.
  await page.click('.reader-view .topbar .icon-btn[data-icon="back"]'); await page.waitForSelector('.book-view .chapter-list li', { timeout: 20000 }); await page.waitForTimeout(500); console.log('back lands on', page.url().split('#')[1].split('/')[1]);
  console.log('read', await page.$$eval('.chapter-list li.read', (l) => l.length), 'current', await page.$eval('.chapter-list li.current span', (e) => e.textContent).catch(() => 'none'));
  // Tracking: search, bind, set status/progress/score.
  await page.click('.book-tile:has-text("المتابعة")'); await page.waitForSelector('.track-hit', { timeout: 10000 }); await page.screenshot({ path: `${SHOTS}/bookpage-2-search.png` });
  await page.click('.track-hit'); await page.waitForSelector('.track-grid'); await page.waitForTimeout(300);
  await page.fill('.track-grid input[type=number]', '4'); await page.fill('.track-grid input[step]', '8'); await page.screenshot({ path: `${SHOTS}/bookpage-3-entry.png` });
  await page.click('.sheet-actions .btn.primary'); await page.waitForTimeout(600);
  console.log('entry', JSON.stringify(entry), 'tile', await page.$eval('.book-tile.on span', (e) => e.textContent).catch(() => '-'));
  console.log('facts', await page.$eval('.book-facts', (e) => e.innerText.replace(/\n/g, ' | ')));
  await page.screenshot({ path: `${SHOTS}/bookpage-4-tracked.png` });
  // Right-click the heart: the tags sheet; tick a new tag.
  await page.click('.book-tile.has-more', { button: 'right' }); await page.waitForSelector('.dest-row'); await page.fill('.sheet input[type=text]', 'قصص'); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  console.log('tag rows', await page.$$eval('.dest-row', (r) => r.length), 'tile', await page.$eval('.book-tile.has-more span', (e) => e.textContent));
  await page.screenshot({ path: `${SHOTS}/bookpage-5-tags.png` });
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  // A long press does the same on touch.
  const tileEl = await page.$('.book-tile.has-more'); await tileEl.scrollIntoViewIfNeeded(); const tb = await tileEl.boundingBox(); await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up(); await page.waitForTimeout(300);
  console.log('held opens sheet', !!(await page.$('.dest-row')), 'sheets', await page.$$eval('.sheet', (x) => x.length), 'tiles', await page.$$eval('.book-tile.has-more', (x) => x.length));
  console.log('errors', errors); await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
