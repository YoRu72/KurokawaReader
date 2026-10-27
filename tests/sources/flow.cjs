// The sources, end to end against tests/sources/server.cjs: the hub; archive.org browsed (shelf, search, tag,
// filter), a book's page and a file fetched into the library; Shamela's categories, a category's list, a
// book's page with its contents, reading it online (pages arriving as scrolled), fetching it whole, the
// catalogue of titles and a title search. node tests/sources/flow.cjs <dir with alice-in-wonderland.epub>
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const DIST = path.resolve(__dirname, '../../dist'); const BOOKS = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(5402, r));
  const mock = spawn('node', [path.join(__dirname, 'server.cjs'), '5401', BOOKS], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en' }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  const ok = (name, cond) => console.log((cond ? 'ok  ' : 'FAIL'), name);
  const base = 'http://localhost:5402/';
  try {
    await page.goto(base); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.shamela.base', 'http://localhost:5401'); localStorage.setItem('kr.archive.base', 'http://localhost:5401'); }); await page.reload(); await page.waitForSelector('.library-view');
    // The hub, from the settings.
    await page.goto(base + '#/settings'); await page.waitForSelector('.settings-view, .view'); await page.click('section.card h3:has-text("Sources")'); await page.waitForTimeout(300); await page.click('button:has-text("Sources: Internet Archive")'); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(300);
    ok('hub lists both sources', (await page.$$('.source-card')).length === 2);
    await page.screenshot({ path: path.join(__dirname, 'hub.png') });
    // archive.org: the default shelf.
    await page.click('.source-card >> nth=0 >> .source-head'); await page.waitForSelector('.src-grid .src-card', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('archive shelf shows books (lending-only left out)', (await page.$$('.src-grid .src-card')).length === 3);
    ok('tags offered from results', (await page.$$('.src-tags .chip')).length >= 1);
    await page.screenshot({ path: path.join(__dirname, 'archive.png') });
    // A tag narrows.
    await page.click('.src-tags .chip:has-text("Fantasy")'); await page.waitForTimeout(800);
    ok('tag narrows to two', (await page.$$('.src-grid .src-card')).length === 2);
    // Search.
    await page.fill('.src-search', 'Adab'); await page.press('.src-search', 'Enter'); await page.waitForTimeout(800);
    ok('search finds the Arabic book', await page.evaluate(() => /مقامات/.test(document.querySelector('.src-grid')?.textContent || '')));
    // The book: files, fetch.
    await page.click('.src-grid .src-card'); await page.waitForSelector('.src-files .src-file', { timeout: 15000 });
    ok('details show an EPUB file', await page.evaluate(() => /EPUB/.test(document.querySelector('.src-files')?.textContent || '')));
    await page.click('.src-files .src-file'); await page.waitForSelector('.src-files .btn.primary', { timeout: 60000 });
    ok('file fetched into the library', true);
    // Shamela: categories as shelves.
    await page.goto(base + '#/sources/shamela'); await page.waitForSelector('.src-shelves .chip', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('shamela categories as shelves', (await page.$$('.src-shelves .chip')).length >= 3);
    await page.click('.src-shelves .chip >> nth=1'); await page.waitForSelector('.src-grid .src-card', { timeout: 15000 });
    ok('a category lists its books', (await page.$$('.src-grid .src-card')).length === 2);
    await page.screenshot({ path: path.join(__dirname, 'shamela.png') });
    // A book's page: contents, read online.
    await page.click('.src-grid .src-card >> nth=1'); await page.waitForSelector('.src-chapters li', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('book page shows the contents', (await page.$$('.src-chapters li')).length >= 5);
    ok('book page shows pages and card', await page.evaluate(() => /pages/.test(document.querySelector('.src-chips')?.textContent || '') && /الناشر/.test(document.querySelector('.src-meta')?.textContent || '')));
    await page.screenshot({ path: path.join(__dirname, 'shamela-book.png') });
    await page.click('.src-files .btn.primary'); await page.waitForSelector('.reader-scroll .kr-shamela', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('.kr-shamela .kr-page:not(.pending)').length >= 2, null, { timeout: 20000 });
    const shown = await page.evaluate(() => ({ pages: document.querySelectorAll('.kr-shamela .kr-page').length, loaded: document.querySelectorAll('.kr-shamela .kr-page:not(.pending)').length, first: document.querySelector('.kr-shamela .kr-page:not(.pending) .kr-page-body')?.textContent?.slice(0, 40) }));
    ok('reads online: pages arrive as scrolled', shown.pages >= 92 && shown.loaded >= 2 && /بِسم الله|بَيَان/.test(shown.first || ''));
    if (!(shown.pages >= 92 && shown.loaded >= 2)) console.log('  shown:', JSON.stringify(shown));
    await page.screenshot({ path: path.join(__dirname, 'shamela-read.png') });
    // Scroll on: more pages load.
    await page.evaluate(() => { document.querySelector('.reader-scroll').scrollTop += 2500; }); await page.waitForTimeout(2500);
    ok('more pages after scrolling', (await page.$$('.kr-shamela .kr-page:not(.pending)')).length > shown.loaded);
    // The library shows it as online; back to the source page and fetch whole.
    await page.goto(base + '#/'); await page.waitForSelector('.book-card'); await page.waitForTimeout(400);
    ok('library badge: online book', !!(await page.$('.book-card .badge.online')));
    await page.goto(base + '#/sources/shamela/book/6388'); await page.waitForSelector('.src-files', { timeout: 15000 }); await page.waitForTimeout(500);
    await page.click('.src-files button:has-text("Fetch")'); await page.waitForFunction(() => /reads offline/.test(document.querySelector('.src-files')?.textContent || ''), null, { timeout: 120000 });
    ok('fetched whole for offline', true);
    await page.goto(base + '#/'); await page.waitForSelector('.book-card'); await page.waitForTimeout(400);
    ok('library badge gone once offline', !(await page.$('.book-card .badge.online')));
    // The catalogue of titles, and a title search without a sign-in.
    await page.goto(base + '#/sources'); await page.waitForSelector('.source-status button', { timeout: 15000 });
    await page.click('.source-status button:has-text("Fetch")'); await page.waitForFunction(() => /titles, fetched/.test(document.querySelector('.source-status')?.textContent || ''), null, { timeout: 60000 });
    ok('catalogue fetched', true);
    await page.goto(base + '#/sources/shamela?q=' + encodeURIComponent('الفقه')); await page.waitForSelector('.src-grid .src-card', { timeout: 15000 });
    ok('title search over the catalogue', (await page.$$('.src-grid .src-card')).length >= 1);
    // Text search asks for the sign-in.
    await page.evaluate(() => localStorage.setItem('kr.src.shamela.filters', JSON.stringify({ mode: 'texts' })));
    await page.goto(base + '#/sources/shamela?q=' + encodeURIComponent('الذكر') + '&v=1'); await page.waitForTimeout(1200);
    ok('text search on the site, no account: hits with the page and a snippet', (await page.$$('.src-grid .src-card')).length >= 3 && /ص 5/.test(await page.$eval('.src-grid .src-card', (e) => e.textContent)) && /نتيجة/.test(await page.$eval('.title', (e) => e.textContent)));
    await page.evaluate(() => { document.querySelector('.src-body').scrollTop = 99999; window.scrollTo(0, 99999); }); await page.waitForTimeout(1200);
    ok('every page of hits (the short pages ask for the next)', (await page.$$('.src-grid .src-card')).length === 4);
    // Chapter titles need وصلة الشاملة: a sign-in note, not an error.
    await page.evaluate(() => localStorage.setItem('kr.src.shamela.filters', JSON.stringify({ mode: 'chapters' })));
    await page.goto(base + '#/sources/shamela?q=الإيمان&v=2'); await page.waitForTimeout(1500);
    ok('chapter-title search asks to sign in', await page.evaluate(() => /sign in/i.test(document.querySelector('.src-status')?.textContent || '')));
    // Searching inside a book, on the site.
    await page.goto(base + '#/sources/shamela/book/6388'); await page.waitForSelector('.src-book-search input', { timeout: 15000 }); await page.waitForTimeout(400);
    await page.fill('.src-book-search input', 'الإيمان'); await page.press('.src-book-search input', 'Enter'); await page.waitForTimeout(1500);
    ok('in-book search on the site finds the pages', (await page.$$('.src-hits .src-hit')).length === 2 && /mark/.test(await page.$eval('.src-hits', (e) => e.innerHTML)));
  } finally { console.log('errors', errors); await browser.close(); server.close(); mock.kill(); }
})();
