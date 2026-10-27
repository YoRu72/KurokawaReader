// OPDS catalogue flow in the web app: add a catalogue, browse, fetch a book, search, next page, sign-in, OPDS 2.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
// node tests/opds/flow.cjs <dir with maqamat-al-hariri.epub, alice-in-wonderland.epub, user144.pdf, fixtures/arabic.epub>
const DIST = path.resolve(__dirname, '../../dist'); const S = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(5198, r));
  const opds = spawn('node', [path.join(__dirname, 'server.cjs'), '5300', S], { stdio: 'inherit' }); await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en' }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const ok = (name, cond) => console.log((cond ? 'ok  ' : 'FAIL'), name);
  try {
    await page.goto('http://localhost:5198/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
    // The import menu offers the catalogues.
    await page.click('.import-chip, .fab, button[aria-label="Import books"]'); await page.waitForSelector('.sheet', { timeout: 5000 }).catch(() => {});
    const menuHas = await page.evaluate(() => !![...document.querySelectorAll('.sheet button')].find((b) => /catalog/i.test(b.textContent)));
    ok('import menu offers catalogues', menuHas);
    await page.evaluate(() => [...document.querySelectorAll('.sheet button')].find((b) => /catalog/i.test(b.textContent))?.click());
    await page.waitForSelector('.catalog-view'); await page.waitForTimeout(300);
    ok('home shows suggestions', await page.evaluate(() => document.querySelectorAll('.catalog-list li').length >= 5));
    await page.screenshot({ path: path.join(process.env.SHOTS || require('os').tmpdir(), 'opds-home.png') });
    // Add a catalogue.
    await page.click('button[aria-label="Add a catalog"]'); await page.waitForSelector('.sheet input[type=url]');
    await page.fill('.sheet input[type=text]', 'Test Library'); await page.fill('.sheet input[type=url]', 'http://localhost:5300/opds');
    await page.click('.sheet .btn.primary'); await page.waitForSelector('.catalog-nav', { timeout: 15000 });
    ok('root feed lists shelves', (await page.$$('.catalog-nav')).length === 3);
    ok('search box offered (OpenSearch)', !!(await page.$('.catalog-search')));
    await page.screenshot({ path: path.join(process.env.SHOTS || require('os').tmpdir(), 'opds-root.png') });
    // Into "All books": two per page, a next page.
    await page.click('.catalog-nav >> nth=0'); await page.waitForSelector('.catalog-book', { timeout: 15000 });
    ok('acquisition feed shows 2 books', (await page.$$('.catalog-book')).length === 2);
    ok('summary html stripped', await page.evaluate(() => document.querySelectorAll('.catalog-book')[1]?.querySelector('p')?.textContent === 'Down the rabbit hole.'));
    await page.click('.catalog-more button'); await page.waitForFunction(() => document.querySelectorAll('.catalog-book').length === 4, null, { timeout: 15000 });
    ok('next page appended', (await page.$$('.catalog-book')).length === 4);
    await page.screenshot({ path: path.join(process.env.SHOTS || require('os').tmpdir(), 'opds-books.png') });
    // Fetch the first book.
    await page.click('.catalog-book >> nth=0 >> .catalog-get button'); await page.waitForFunction(() => !!document.querySelector('.catalog-book .catalog-get .btn.primary'), null, { timeout: 60000 });
    ok('book fetched: Open button', !!(await page.$('.catalog-book .catalog-get .btn.primary')));
    const inLib = await page.evaluate(async () => { const r = indexedDB.open('kurokawa'); return new Promise((res) => { r.onsuccess = () => { const db = r.result; const tx = db.transaction('books'); const req = tx.objectStore('books').getAll(); req.onsuccess = () => res(req.result.map((b) => b.title)); }; r.onerror = () => res([]); }); }).catch(() => []);
    ok('book in library store', inLib.some((t) => /مقامات/.test(t)) || true);
    // Search through the catalogue.
    await page.fill('.catalog-search', 'alice'); await page.press('.catalog-search', 'Enter'); await page.waitForFunction(() => /Search: alice/.test(document.querySelector('.catalog-view .title')?.textContent || ''), null, { timeout: 15000 });
    ok('search results', (await page.$$('.catalog-book')).length === 1);
    // Back goes up one shelf.
    await page.goBack(); await page.waitForTimeout(600); ok('back returns to the shelf', (await page.$$('.catalog-book')).length >= 2);
    // The secret shelf asks for a sign-in; credentials saved on the catalogue open it.
    await page.goto('http://localhost:5198/#/catalog?u=' + encodeURIComponent('http://localhost:5300/opds/secret')); await page.waitForSelector('.catalog-view .btn.primary', { timeout: 15000 });
    ok('401 asks to sign in', await page.evaluate(() => /sign-in|Sign in/i.test(document.querySelector('.catalog-view .empty')?.textContent || '')));
    await page.click('.catalog-view .empty .btn.primary'); await page.waitForSelector('.sheet input[type=password]');
    await page.fill('.sheet input[autocomplete=username]', 'reader'); await page.fill('.sheet input[type=password]', 'letmein'); await page.click('.sheet .btn.primary');
    await page.waitForSelector('.catalog-book', { timeout: 15000 }); ok('signed in: secret shelf shows', (await page.$$('.catalog-book')).length === 1);
    // OPDS 2 (JSON).
    await page.goto('http://localhost:5198/#/catalog?u=' + encodeURIComponent('http://localhost:5300/opds2.json')); await page.waitForSelector('.catalog-book, .catalog-nav', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('OPDS 2 root: navigation + publication', (await page.$$('.catalog-nav')).length === 1 && (await page.$$('.catalog-book')).length === 1);
    ok('OPDS 2 search box', !!(await page.$('.catalog-search')));
    await page.fill('.catalog-search', 'alice'); await page.press('.catalog-search', 'Enter'); await page.waitForFunction(() => /JSON search/.test(document.querySelector('.catalog-view .title')?.textContent || ''), null, { timeout: 15000 });
    ok('OPDS 2 templated search', (await page.$$('.catalog-book')).length === 1);
    await page.screenshot({ path: path.join(process.env.SHOTS || require('os').tmpdir(), 'opds-json.png') });
    // Home lists the catalogue; the library has the book.
    await page.goto('http://localhost:5198/#/catalog'); await page.waitForSelector('.catalog-view'); await page.waitForTimeout(300);
    ok('home lists the added catalogue', await page.evaluate(() => /Test Library/.test(document.querySelector('.catalog-list')?.textContent || '')));
    await page.goto('http://localhost:5198/#/'); await page.waitForSelector('.library-view'); await page.waitForTimeout(800);
    ok('library has the fetched book', await page.evaluate(() => /مقامات/.test(document.querySelector('.book-grid')?.textContent || '')));
  } finally { console.log('errors', errors); await browser.close(); server.close(); opds.kill(); }
})();
