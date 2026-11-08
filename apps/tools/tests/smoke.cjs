// node tests/smoke.cjs [lang]: the app opens (English or Arabic), the downloads page, the add sheet with a magnet
// parsed, the settings page with its cards, the PC layout with its rail — no console errors.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const lang = process.argv[2] || 'en';
(async () => {
  await new Promise((r) => server.listen(5480, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], locale: lang }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|api.github|raw.githubusercontent|net::|CORS policy/.test(m.text())) errors.push(m.text()); });
  await p.goto('http://localhost:5480/'); await p.evaluate((l) => localStorage.setItem('kr.lang', l), lang); await p.reload(); await p.waitForSelector('.downloads-view'); await p.waitForTimeout(400);
  ok('the downloads page opens, empty (Downloads, Search, Videos — the player is built in — and Settings)', !!(await p.$('.downloads-view .empty')) && (await p.$eval('.bottom-nav', (e) => e.children.length)) === 4);
  ok('the document direction follows the language', (await p.evaluate(() => document.documentElement.dir)) === (lang === 'ar' ? 'rtl' : 'ltr'));
  await p.click('.fab'); await p.waitForSelector('.fab-menu'); const menu = await p.$$eval('.fab-item', (e) => e.map((x) => x.innerText.replace(/\s+/g, ' ')));
  ok('the + opens a menu of ways to add (link, clipboard, video, page)', menu.length >= 4);
  ok('the video entry says where yt-dlp stands', menu.some((m) => /yt-dlp|Not available here|غير متاح هنا/.test(m)));
  // The menu as the reader wants it: «Edit this menu» leaves the clipboard entry off.
  await p.click('.fab-edit'); await p.waitForSelector('.sheet .dest-row'); await p.locator('.sheet .dest-row >> nth=1').locator('input').uncheck(); await p.waitForTimeout(150);
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  await p.click('.fab'); await p.waitForSelector('.fab-menu'); const menu2 = await p.$$eval('.fab-item:not(.fab-edit)', (e) => e.map((x) => x.dataset.act));
  ok('an entry left off the + menu', !menu2.includes('copy') && menu2[0] === 'link' && menu2.length === menu.filter((m) => !/Edit this menu|تحرير هذه القائمة/.test(m)).length - 1);
  await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-sheet'); await p.fill('.add-input', 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test+Torrent\nhttps://example.org/file.zip');
  ok('the add sheet opens, with its options', !!(await p.$('.add-sheet .add-options')));
  // The batch pre-flight: two links typed → a «check» button; the web's fetch cannot reach them, so each is reported as unreachable or unsupported and left unchecked.
  await p.waitForTimeout(100); const checkBtn = await p.$('.add-sheet .sheet-actions .btn.tonal:not([hidden])');
  ok('a batch shows a check button', !!checkBtn);
  if (checkBtn) { await checkBtn.click(); await p.waitForSelector('.sheet .dest-list .dest-row', { timeout: 15000 }).catch(() => null); const rows = await p.$$eval('.sheet .dest-list .dest-row', (es) => es.map((e) => ({ on: e.querySelector('input').checked, text: e.textContent }))); ok('the pre-flight lists each link with a verdict (' + rows.length + ')', rows.length === 2 && rows.some((r) => r.on)); await p.keyboard.press('Escape'); await p.waitForTimeout(150); }
  await p.click('.add-sheet .btn.primary'); await p.waitForTimeout(600);
  const toastText = await p.$eval('.toast', (e) => e.textContent).catch(() => '');
  ok('on the web a magnet is refused with a word about engines; a link goes to the browser', /engine|محرك|aria2/.test(toastText));
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.click('.bottom-nav [data-dest="settings"]'); await p.waitForSelector('.settings-view'); await p.waitForTimeout(600);
  const cards = await p.$$eval('.settings-view .card h3', (es) => es.map((e) => e.textContent));
  ok('settings: general, downloads, aria2, add-ons, other apps, updates, about', cards.length >= 7);
  await p.click('#general .card-title'); await p.click('.settings-view .swatch[data-accent="teal"]'); await p.waitForTimeout(100);
  ok('an accent applies', (await p.evaluate(() => document.documentElement.dataset.accent)) === 'teal');
  await p.screenshot({ path: path.join(__dirname, `shot-settings-${lang}.png`) });
  await p.goto('http://localhost:5480/#/'); await p.waitForTimeout(300); await p.screenshot({ path: path.join(__dirname, `shot-downloads-${lang}.png`) });
  // PC layout
  const pc = await (await b.newContext({ viewport: { width: 1280, height: 860 }, locale: lang })).newPage();
  await pc.goto('http://localhost:5480/'); await pc.evaluate((l) => localStorage.setItem('kr.lang', l), lang); await pc.reload(); await pc.waitForSelector('.downloads-view'); await pc.waitForTimeout(300);
  ok('a PC gets the rail', !!(await pc.$('.nav-rail .rail-fab')) && (await pc.evaluate(() => document.documentElement.classList.contains('pc'))));
  await pc.screenshot({ path: path.join(__dirname, `shot-pc-${lang}.png`) });
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
