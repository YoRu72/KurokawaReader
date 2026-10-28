// node tests/sweep.cjs <books dir> <outdir>: every view, phone and PC sizes, English and Arabic, light and dark:
// errors in the console, the page scrolling sideways (something wider than the screen), elements spilling
// out of the screen, and a screenshot of each. A book of each kind imported first so the reader and the book
// page are seen too.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.epub': 'application/epub+zip' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [booksDir, out] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(booksDir).filter((f) => /\.(epub|pdf|docx|txt|md|xlsx|csv|fb2|cbz)$/i.test(f)).map((f) => path.join(booksDir, f));
let problems = 0; const report = (k, msg) => { problems++; console.log(`PROBLEM [${k}] ${msg}`); };
(async () => {
  await new Promise((r) => server.listen(5449, r));
  const b = await chromium.launch();
  for (const [size, opts] of [['phone', devices['Pixel 7']], ['pc', { viewport: { width: 1280, height: 800 } }]]) for (const lang of ['en', 'ar']) for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ ...opts, colorScheme: scheme, serviceWorkers: 'block' }); const p = await ctx.newPage();
    const tag = `${size}-${lang}-${scheme}`; const errs = [];
    p.on('pageerror', (e) => errs.push('pageerror ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|favicon/.test(m.text())) errs.push('console ' + m.text().slice(0, 200)); });
    p.on('dialog', (d) => void d.dismiss());
    await p.goto('http://localhost:5449/'); await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, lang); await p.reload(); await p.waitForSelector('.library-view');
    await p.setInputFiles('input[type=file]', files); await p.waitForFunction((n) => document.querySelectorAll('.book-card').length >= n, files.length, { timeout: 120000 }).catch(() => {}); await p.waitForTimeout(1500);
    const ids = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.map((x) => ({ id: x.id, f: x.format }))); }; }));
    const routes = ['/', '/settings', '/notes', '/sources', '/sources/~all', '/sources/~all?q=alice', '/sources/archive', '/sources/shamela', '/catalog', ...ids.slice(0, 12).flatMap((x) => [`/book/${x.id}`, `/read/${x.id}`])];
    for (const r of routes) {
      const before = errs.length;
      await p.evaluate((h) => { location.hash = h; }, r); await p.waitForTimeout(r.startsWith('/read') ? 2500 : 900);
      const lay = await p.evaluate(() => {
        const W = document.documentElement.clientWidth; const sideways = document.documentElement.scrollWidth > W + 1;
        const spill = [];
        for (const el of document.querySelectorAll('.view *')) {
          // (Inside a box that scrolls or clips sideways — a row of chips, a blurred backdrop — is no spill.)
          let clip = false; for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if (ox !== 'visible') { clip = true; break; } }
          if (clip) continue;
          const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || el.closest('[hidden], .panel:not(.open)') || el.closest('.reader-content, .pdf-pages, .epub-page, [data-kr-scroll], .gs-row, .series-row, .src-shelves, .chips, .ext-grid, .lb-strip, .page-strip, .tabs-scroll, .toolbar-scroll, pre, table, .sheet')) continue;
          const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
          if (r.right > W + 2 || r.left < -2) { spill.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} ${Math.round(r.left)}..${Math.round(r.right)}`); if (spill.length > 3) break; }
        }
        return { sideways, spill };
      });
      const name = `${tag}${r.replace(/[^a-z0-9~]+/gi, '_')}`;
      if (lay.sideways) report(name, 'page scrolls sideways');
      if (lay.spill.length) report(name, 'spills: ' + lay.spill.join(' | '));
      for (const e of errs.slice(before)) report(name, e);
      if (scheme === 'light' || r === '/') await p.screenshot({ path: path.join(out, name.slice(0, 80) + '.png') });
    }
    await ctx.close();
  }
  console.log(problems ? `${problems} problems` : 'no problems');
  await b.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
