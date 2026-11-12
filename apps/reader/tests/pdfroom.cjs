// node tests/pdfroom.cjs: a PDF's pages and its bars (src/views/reader.ts mountPdf — data-pb, --pb-room; reader.css):
//  1. the page bar lying at the foot (a floating pill, or docked): the pages end above it — the last page's foot, scrolled
//     to the end, is above the bar's top, and so is the scroller's end;
//  2. the page bar at the top: the pages begin below it;
//  3. a docked page bar down a side: the pages keep clear of it;
//  4. the chrome shown or hidden (a tap): no page moves on the screen — with the bar at the foot, at the top, and down
//     the side as it comes on a phone;
//  5. the floating bar down the side (a phone's own, upright) is as it was: the pages as wide as the screen.
// (The book is made here: no fixtures. On a phone, 412 × 915.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-pdfroom-'));

(async () => {
  const { PDFDocument, StandardFonts } = require(path.resolve(__dirname, '../node_modules/pdf-lib'));
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 12; i++) { const pg = d.addPage([400, 560]); pg.drawText(`Page ${i}`, { x: 40, y: 500, size: 18, font }); pg.drawText(`The foot of page ${i}`, { x: 40, y: 20, size: 12, font }); }
  const pdf = path.join(TMP, 'room.pdf'); fs.writeFileSync(pdf, await d.save());
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const page = async (visual) => {
    const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'en', serviceWorkers: 'block' });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base); await p.evaluate((v) => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify(v)); }, visual);
    await p.reload(); await p.waitForSelector('.library-view');
    await p.setInputFiles('.library-view input[type=file]', [pdf]);
    let id = null;
    for (let i = 0; i < 120 && !id; i++) {
      id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0]?.id ?? null); }; }));
      if (!id) { await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); await p.waitForTimeout(250); }
    }
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
    await p.waitForFunction(() => [...document.querySelectorAll('.pdf-page canvas.pdf-pic')].some((c) => { const r = c.getBoundingClientRect(); return r.height > 0 && r.bottom > 0 && r.top < innerHeight; }), null, { timeout: 30000 });
    await p.waitForTimeout(1200);
    return p;
  };
  const rects = (p) => p.evaluate(() => {
    const r = (e) => { if (!e) return null; const x = e.getBoundingClientRect(); return { t: Math.round(x.top), b: Math.round(x.bottom), l: Math.round(x.left), r: Math.round(x.right), w: Math.round(x.width) }; };
    const sc = document.querySelector('.pdf-scroll'); const pages = [...document.querySelectorAll('.pdf-page')];
    const mid = innerHeight / 2; const seen = pages.find((e) => { const x = e.getBoundingClientRect(); return x.top <= mid && x.bottom >= mid; }) ?? pages[0];
    return { bar: r(document.querySelector('.pdf-bar')), scroll: r(sc), page: r(seen), n: seen?.dataset.page, last: r(pages[pages.length - 1]) };
  });
  const toEnd = (p) => p.evaluate(() => new Promise((res) => { const sc = document.querySelector('.pdf-scroll'); sc.scrollTop = sc.scrollHeight; setTimeout(res, 600); }));
  const tap = async (p) => { await p.evaluate(() => document.querySelector('.reader-view').classList.toggle('immersive')); await p.waitForTimeout(500); };
  const still = async (p, name) => {
    await p.evaluate(() => { const sc = document.querySelector('.pdf-scroll'); sc.scrollTop = sc.scrollHeight * 0.4; }); await p.waitForTimeout(600);
    const a = await rects(p); await tap(p); const b = await rects(p); await tap(p); const c = await rects(p);
    ok(`4. ${name}: the chrome hidden and shown again, the page read does not move`, a.n === b.n && b.n === c.n && Math.abs(a.page.t - b.page.t) <= 1 && Math.abs(b.page.t - c.page.t) <= 1, { shown: a.page.t, hidden: b.page.t, again: c.page.t });
  };

  // 1. At the foot: a pill, and docked.
  for (const look of ['pill', 'docked']) {
    const p = await page({ pdfBar: 'rows', pdfBarRow: 'bottom', pdfBarLook: look });
    await toEnd(p); const r = await rects(p);
    ok(`1. bar at the foot (${look}): the last page ends above it, and so does the scroller`, r.last.b <= r.bar.t && r.scroll.b <= r.bar.t + 1, r);
    if (look === 'pill') await still(p, 'bar at the foot');
    await p.context().close();
  }
  // 2. At the top.
  {
    const p = await page({ pdfBar: 'row', pdfBarRow: 'top' });
    const r = await rects(p);
    ok('2. bar at the top: the pages begin below it', r.scroll.t >= r.bar.b - 1 && r.page.t >= r.bar.b, r);
    await still(p, 'bar at the top');
    await p.context().close();
  }
  // 3. Docked down a side.
  {
    const p = await page({ pdfBar: 'side', pdfBarSide: 'right', pdfBarLook: 'docked' });
    const r = await rects(p);
    ok('3. docked down the right side: the pages keep clear of it', r.page.r <= r.bar.l + 1 && r.scroll.r <= r.bar.l + 1, r);
    await tap(p); const h = await rects(p);
    ok('3. ...and are as wide with the chrome hidden (not fitted again)', Math.abs(h.page.w - r.page.w) <= 1, { shown: r.page.w, hidden: h.page.w });
    await p.context().close();
  }
  // 5. A phone's own: the floating bar down the side, as it was.
  {
    const p = await page({});
    const r = await rects(p);
    ok('5. the floating bar down the side (a phone upright): the pages as wide as the screen, as before', r.bar && r.scroll.w >= 410, r);
    await still(p, 'floating bar down the side');
    await p.context().close();
  }
  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
