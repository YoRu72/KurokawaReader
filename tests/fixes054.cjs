// node tests/fixes054.cjs <alice.epub>: the fixes of 0.54 —
// - a book added in another tab (or by a download done) shows in the library at once;
// - the app's own words (the library's "N books · …") are not selectable, a book's text is;
// - a picture in a book opens on a tap and zooms (pinch, double tap, the wheel), and the setting turns it off;
// - a book whose file came broken (its zip cut short) says so, and "Download again" fetches it into the same book;
// - a download checked before it is kept (filecheck: a page in the file's place, a zip with no end).
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); 
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.epub': 'application/epub+zip' };
const EPUB = path.resolve(process.argv[2] || path.join(__dirname, 'fixtures/alice-in-wonderland.epub'));
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url.startsWith('/files/alice.epub')) { res.setHeader('Content-Type', 'application/epub+zip'); res.end(fs.readFileSync(EPUB)); return; }
  if (req.url.startsWith('/files/page.epub')) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><title>Just a moment...</title></head><body>check</body></html>'); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res);
});
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const BASE = 'http://localhost:5471/';

// filecheck.ts, built on its own for Node.
function fileCheck() {
  const out = path.join(require('os').tmpdir(), `filecheck-${process.pid}.cjs`);
  require(path.join(__dirname, '../node_modules/esbuild')).buildSync({ entryPoints: [path.join(__dirname, '../src/filecheck.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent' });
  return require(out);
}

(async () => {
  await new Promise((r) => server.listen(5471, r));
  // ---- filecheck ----
  {
    const { fileFault } = fileCheck();
    const good = fs.readFileSync(EPUB);
    const B = (x) => new Blob([x]);
    ok('a whole EPUB passes', (await fileFault(B(good), 'a.epub', good.length)) === null);
    ok('an EPUB cut short is "cut" (no end of its zip)', (await fileFault(B(good.subarray(0, Math.floor(good.length * 0.6))), 'a.epub')) === 'cut');
    ok('a web page in its place is "page"', (await fileFault(B('<!DOCTYPE html><html><title>Just a moment...</title></html>'), 'a.epub')) === 'page');
    ok('a PDF that is a page is "page"', (await fileFault(B('\n<html><body>Sign in</body></html>'), 'b.pdf')) === 'page');
    ok('nothing at all is "empty"', (await fileFault(B(''), 'c.cbz')) === 'empty');
    ok('a PDF smaller than the site said is "cut"', (await fileFault(B('%PDF-1.7\n' + 'x'.repeat(5000)), 'd.pdf', 20000)) === 'cut');
    ok('an HTML file itself is no fault', (await fileFault(B('<html></html>'), 'e.html')) === null);
  }

  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], locale: 'en' });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('dialog', (d) => void d.accept());
  await p.goto(BASE); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [EPUB]); await p.waitForFunction(() => document.querySelectorAll('.book-card').length >= 1, null, { timeout: 60000 }); await p.waitForTimeout(600);

  // ---- a book added elsewhere shows at once ----
  {
    const p2 = await ctx.newPage(); await p2.goto(BASE); await p2.waitForSelector('.library-view'); await p2.waitForTimeout(600);
    const before = await p2.$$eval('.book-card[data-book]', (e) => e.length);
    await p.setInputFiles('input[type=file]', [path.join(__dirname, 'fixtures/maqamat-al-hariri.epub')]);
    { const done = await p.waitForSelector('.sheet button:has-text("Done")', { timeout: 4000 }).catch(() => null); if (done) await done.click(); }
    await p2.waitForFunction((n) => document.querySelectorAll('.book-card[data-book]').length > n, before, { timeout: 30000 }).catch(() => undefined);
    ok('a book added in another tab shows in the library at once', (await p2.$$eval('.book-card[data-book]', (e) => e.length)) > before);
    await p2.close();
  }

  // ---- selection ----
  {
    const us = await p.$eval('.library-view .sub', (e) => getComputedStyle(e).userSelect || getComputedStyle(e).webkitUserSelect);
    const inp = await p.$eval('.library-view input[type=search]', (e) => getComputedStyle(e).userSelect || getComputedStyle(e).webkitUserSelect);
    ok('the library\'s line "N books · …" is not selectable; the search field is', us === 'none' && inp !== 'none');
  }

  // ---- pictures zoom ----
  {
    const aliceId = await p.locator('.book-card[data-book]').filter({ hasText: 'Alice' }).first().getAttribute('data-book');
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, aliceId);
    await p.waitForSelector('.kr-content img', { timeout: 30000 }); await p.waitForTimeout(800);
    const us = await p.$eval('.kr-content p', (e) => getComputedStyle(e).userSelect || getComputedStyle(e).webkitUserSelect);
    ok('a book\'s text stays selectable', us !== 'none');
    // (The first picture brought on screen and tapped.)
    const img = p.locator('.kr-content img').first();
    await img.scrollIntoViewIfNeeded(); await p.waitForTimeout(800);
    const loaded = await img.evaluate((e) => e.complete && e.naturalWidth > 0 && !e.classList.contains('kr-img-pending'));
    ok('the picture has loaded by the time it is on the screen (no empty or broken box)', loaded);
    await img.click(); await p.waitForSelector('.lightbox .lb-img img', { timeout: 5000 }).catch(() => undefined);
    ok('a tap on a picture opens it', !!(await p.$('.lightbox .lb-img img')));
    const box = await p.$eval('.lightbox .lb-img', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await p.mouse.move(box.x, box.y); await p.dispatchEvent('.lightbox .lb-img', 'wheel', { deltaY: -300, clientX: box.x, clientY: box.y });
    await p.waitForTimeout(200);
    const z = await p.$eval('.lightbox .lb-img', (e) => ({ zoomed: e.classList.contains('zoomed'), t: e.querySelector('img').style.transform }));
    ok('… and zooms in (the wheel; pinch and double tap the same way)', z.zoomed && /scale\(/.test(z.t));
    await p.keyboard.press('0'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    if (await p.$('.lightbox')) { await p.click('.lightbox .lb-close'); await p.waitForTimeout(300); }
    // (The setting off: a tap on a picture is a tap on the page.)
    await p.evaluate(() => { const k = 'kr.visual'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.pictureZoom = false; localStorage.setItem(k, JSON.stringify(s)); });
    await p.reload(); await p.waitForSelector('.kr-content img', { timeout: 30000 }); await p.waitForTimeout(800);
    const img2 = p.locator('.kr-content img').first(); await img2.scrollIntoViewIfNeeded(); await p.waitForTimeout(500); await img2.click(); await p.waitForTimeout(500);
    ok('with the setting off, a tap on a picture does not open it', !(await p.$('.lightbox')));
    await p.evaluate(() => { const k = 'kr.visual'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.pictureZoom = true; localStorage.setItem(k, JSON.stringify(s)); });
  }

  // ---- a broken book, downloaded again ----
  {
    const good = fs.readFileSync(EPUB);
    const cut = good.subarray(0, Math.floor(good.length * 0.5));
    const id = await p.evaluate(async ({ bytes, url }) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/epub+zip' });
      const id = 'broken1';
      await new Promise((res, rej) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction(['books', 'files'], 'readwrite'); tx.objectStore('books').put({ id, title: 'Broken Alice', format: 'epub', fileName: 'alice.epub', mime: 'application/epub+zip', size: blob.size, addedAt: Date.now(), bookmarks: [], highlights: [], remote: { source: 'link', id: url } }); tx.objectStore('files').put(blob, id); tx.oncomplete = res; tx.onerror = rej; }; r.onerror = rej; });
      return id;
    }, { bytes: [...cut], url: `${BASE}files/alice.epub` });
    await p.goto(`${BASE}#/read/${id}`); await p.reload(); await p.waitForSelector('.broken-file', { timeout: 30000 }).catch(() => undefined);
    ok('a book whose file came cut short says so, with "Download again"', !!(await p.$('.broken-file button')));
    await p.click('.broken-file button'); await p.waitForSelector('.kr-content.kr-epub', { timeout: 30000 }).catch(() => undefined);
    const size = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').get('broken1'); q.onsuccess = () => res(q.result?.size ?? 0); }; }));
    ok('… which fetches it whole into the same book, and it opens', !!(await p.$('.kr-content.kr-epub')) && !(await p.$('.broken-file')) && size === good.length);
  }

  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
