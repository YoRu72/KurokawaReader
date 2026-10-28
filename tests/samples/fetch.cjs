// node tests/samples/fetch.cjs: the sample books when the app does not carry Alice (the Android and iOS apps
// leave it out): Maqāmāt from the app, Alice fetched from the web app's copy; offline, Maqāmāt alone.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.epub': 'application/epub+zip' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(req.url.split('?')[0]); if (/alice/.test(u)) { res.writeHead(404); res.end(); return; } let f = path.join(DIST, u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5447, r));
  const b = await chromium.launch();
  for (const online of [true, false]) {
    const ctx = await b.newContext({ locale: 'en', serviceWorkers: 'block' }); const p = await ctx.newPage();
    let asked = 0;
    await p.route('https://yoru72.github.io/**', (r) => { asked++; if (!online) return r.abort(); return r.fulfill({ status: 200, contentType: 'application/epub+zip', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(path.join(DIST, 'samples/alice-in-wonderland.epub')) }); });
    await p.goto('http://localhost:5447/'); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
    // (Through the app's own button on the empty library.)
    await p.waitForSelector('button:has-text("Add two books to start")', { timeout: 15000 });
    await p.click('button:has-text("Add two books to start")'); await p.waitForFunction(() => /Imported|Added|imported/.test(document.querySelector('.toast')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(1500);
    const books = await p.$$eval('.book-card .title, .book-card .book-title, .book-card', (els) => els.map((e) => e.textContent.trim().slice(0, 40)));
    const both = books.some((x) => /Alice/i.test(x)) && books.some((x) => /مقامات|Maq/i.test(x));
    if (online) ok('online: Maqāmāt from the app, Alice from the web app (' + asked + ' fetch)', both && asked === 1);
    else ok('offline: Maqāmāt alone, no error', books.length === 1 && /مقامات|Maq/i.test(books[0]));
    if (!(online ? both : books.length === 1)) console.log('  books', books);
    await ctx.close();
  }
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
