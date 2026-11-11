// node tests/pdfcrop.cjs: margin cropping on a phone. A 1,000-page book (a phone's 1,061-page PDF froze and reset the
// device: every page was drawn and measured at once, and the whole book laid out again dozens of times while being
// read): only a sample and the pages near the screen are measured, one at a time, then nothing more while idle; the
// book is laid out once; scrolling never sees a page jump or change size; what was found is kept for next time (and
// what an older version found is not trusted). A book of tricky pages: light grey text, a tiny page number, hairlines,
// tinted, dark and blank pages, a picture to the edges, facing pages with their margins swapped — nothing is ever cut
// off, the ordinary pages are all one width and an exception no wider. Search, zoom and pinch with the margins cropped.
// (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Hooks from the test side: each measurement is a getImageData of a small picture (the crop finder's); a whole-book
// layout is a batch of style changes to most pages at once; tiles taken off the page are counted.
const HOOKS = () => {
  window.__meas = 0; const gid = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...a) { if (this.canvas.width <= 480 && this.canvas.height <= 640) window.__meas++; return gid.apply(this, a); };
  window.__watch = () => {
    window.__relayouts = 0; window.__tileDrops = 0; window.__mo?.disconnect();
    const inner = document.querySelector('.pdf-inner'); const total = inner.children.length;
    window.__mo = new MutationObserver((list) => {
      const pages = new Set();
      for (const m of list) {
        if (m.type === 'attributes' && m.target.classList?.contains('pdf-page')) pages.add(m.target);
        if (m.type === 'childList') for (const r of m.removedNodes) if (r.classList?.contains('pdf-tile')) window.__tileDrops++;
      }
      if (pages.size > total / 2) window.__relayouts++;
    });
    window.__mo.observe(inner, { subtree: true, attributes: true, attributeFilter: ['style'], childList: true });
  };
};

async function open(ctx, port, file, { fresh = true } = {}) {
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`);
  if (fresh) { await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); }
  await p.waitForSelector('.library-view');
  if (file) { await p.setInputFiles('input[type=file]', [file]); await p.waitForSelector('.book-card', { timeout: 60000 }); }
  await p.click('.book-card'); await p.waitForSelector('.pdf-page', { timeout: 60000 }); await p.waitForTimeout(800);
  return p;
}
const errors = [];
const toggleCrop = async (p, on) => { await p.click('button[aria-label="More"]'); await p.click(`.panel.open button:has-text("${on ? 'Crop the margins' : 'Show the whole page'}")`); };
const toPage = (p, n, off = 20) => p.evaluate(([n, off]) => { const sc = document.querySelector('.pdf-scroll'); sc.scrollTop = document.querySelectorAll('.pdf-page')[n - 1].offsetTop - off; }, [n, off]);
// The measurements stopped: the count unchanged for `quiet` ms (up to `most` ms).
const idle = async (p, quiet = 1500, most = 20000) => { const t0 = Date.now(); let last = -1, since = Date.now(); while (Date.now() - t0 < most) { const m = await p.evaluate(() => window.__meas); if (m !== last) { last = m; since = Date.now(); } else if (Date.now() - since >= quiet) break; await p.waitForTimeout(150); } return last; };
// The page under a point of the screen and where on its sheet (the whole page, as fractions) and its window.
const at = (p, vx, vy) => p.evaluate(([vx, vy]) => {
  const sc = document.querySelector('.pdf-scroll'); const r0 = sc.getBoundingClientRect(); const x = r0.left + vx * sc.clientWidth, y = r0.top + vy * sc.clientHeight;
  const pages = [...document.querySelectorAll('.pdf-page')]; let n = 0;
  for (let i = 0; i < pages.length; i++) { const r = pages[i].getBoundingClientRect(); if (r.bottom >= y) { n = i + 1; break; } }
  const w = pages[n - 1].getBoundingClientRect(), s = pages[n - 1].querySelector('.pdf-sheet').getBoundingClientRect();
  return { n, sx: (x - s.left) / s.width, sy: (y - s.top) / s.height, wx: (x - w.left) / w.width, wy: (y - w.top) / w.height, sh: s.height, wh: w.height, ww: w.width, count: document.querySelector('.pcount')?.textContent ?? '' };
}, [vx, vy]);
// What part of page n's sheet its window shows, in page points (left, top, right, bottom), and its size on screen.
const shows = (p, n, W, H) => p.evaluate(([n, W, H]) => {
  const pg = document.querySelectorAll('.pdf-page')[n - 1]; const w = pg.getBoundingClientRect(), s = pg.querySelector('.pdf-sheet').getBoundingClientRect();
  return { l: ((w.left - s.left) / s.width) * W, t: ((w.top - s.top) / s.height) * H, r: ((w.right - s.left) / s.width) * W, b: ((w.bottom - s.top) / s.height) * H, w: w.width, h: w.height, left: w.left, sl: s.left, sw: s.width };
}, [n, W, H]);

// Two fingers, as a phone sends them (CDP touch points with stable ids): the first, then the second, spread from d0
// to d1 about (cx, cy). Returns where the sheet point first under the fingers is at release and once laid out.
async function pinch(p, cdp, cx, cy, d0, d1, steps = 10) {
  const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i, radiusX: 1, radiusY: 1, force: 1 })) });
  await p.evaluate(([x, y]) => {
    const pages = [...document.querySelectorAll('.pdf-page')]; let n = 0; for (let i = 0; i < pages.length; i++) if (pages[i].getBoundingClientRect().bottom >= y) { n = i + 1; break; }
    const sh = pages[n - 1].querySelector('.pdf-sheet'); const r = sh.getBoundingClientRect(); const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
    window.__pos = () => { const r = sh.getBoundingClientRect(); return [r.left + fx * r.width, r.top + fy * r.height]; };
  }, [cx, cy]);
  await T('touchStart', [[cx - d0 / 2, cy]]); await T('touchStart', [[cx - d0 / 2, cy], [cx + d0 / 2, cy]]);
  for (let i = 1; i <= steps; i++) { const d = d0 + ((d1 - d0) * i) / steps; await T('touchMove', [[cx - d / 2, cy], [cx + d / 2, cy]]); await p.waitForTimeout(16); }
  await p.waitForTimeout(40); const pic = await p.evaluate(() => window.__pos());
  await T('touchEnd', []); await p.waitForTimeout(700); const laid = await p.evaluate(() => window.__pos());
  return { pic: [pic[0] - cx, pic[1] - cy], laid: [laid[0] - cx, laid[1] - cy], tf: await p.evaluate(() => document.querySelector('.pdf-inner').style.transform) };
}

(async () => {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  // Book A: 1,000 pages of 400 × 560 pt, the text in a column with wide margins and a small page number; every 97th
  // page has a rule across almost the whole width (an exception); "needle" on page 300.
  const fileA = path.join(os.tmpdir(), 'kr-pdfcrop-1000.pdf');
  { const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 1000; i++) { const pg = d.addPage([400, 560]);
      for (let l = 1; l <= 12; l++) pg.drawText(`line ${l} of page ${i}: ${i === 300 && l === 5 ? 'needle' : 'words'} here`, { x: 60, y: 480 - l * 32, size: 13, font });
      pg.drawText(String(i), { x: 196, y: 40, size: 7, font });
      if (i % 97 === 0) pg.drawLine({ start: { x: 12, y: 300 }, end: { x: 388, y: 300 }, thickness: 1, color: rgb(0, 0, 0) }); }
    fs.writeFileSync(fileA, await d.save()); }
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch();
  const phone = { viewport: { width: 412, height: 860 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'en' };

  /* ---------- the 1,000-page book ---------- */
  const ctx = await b.newContext(phone); await ctx.addInitScript(HOOKS);
  let p = await open(ctx, port, fileA); let cdp = await ctx.newCDPSession(p);
  await toPage(p, 300); await p.waitForTimeout(1200);
  const plainW = (await at(p, 0.5, 0.4)).ww;
  await p.evaluate(() => { window.__watch(); window.__meas = 0; });
  const before = await at(p, 0.5, 0.4);
  await toggleCrop(p, true); await p.waitForTimeout(3000);
  const m3 = await p.evaluate(() => window.__meas), r3 = await p.evaluate(() => window.__relayouts);
  const afterOn = await at(p, 0.5, 0.4);
  console.log(`crop on: ${m3} pages measured in 3 s, ${r3} whole-book layouts; page ${before.n} at ${before.sy.toFixed(3)} of its sheet → page ${afterOn.n} at ${afterOn.sy.toFixed(3)}; width ${plainW} → ${afterOn.ww}`);
  ok('crop on: well under 100 pages measured in the first seconds', m3 > 0 && m3 < 100);
  ok('crop on: the book laid out once or twice, not dozens of times', r3 >= 1 && r3 <= 2);
  ok('crop on: the pages are cropped (wider on the screen: the column fills it)', afterOn.ww >= 380 && afterOn.ww <= 389);
  ok('crop on: the same line of the same page stays at the same place on the screen', afterOn.n === before.n && near(afterOn.sy * afterOn.sh, before.sy * afterOn.sh, 4));
  const mIdle = await idle(p); await p.waitForTimeout(2500); const mIdle2 = await p.evaluate(() => window.__meas);
  console.log(`idle: ${mIdle} measured, ${mIdle2} after 2.5 s more; ${await p.evaluate(() => window.__relayouts)} layouts`);
  ok('crop on: measuring stops when idle (nothing more after 2.5 s)', mIdle2 === mIdle && mIdle < 100);
  // Scrolling for 3 s, 7 px a frame: the page at the middle of the screen moves exactly with the scroll, and no page
  // on the screen changes size.
  const scrollRun = await p.evaluate(() => new Promise((res) => {
    const sc = document.querySelector('.pdf-scroll'); const r0 = sc.getBoundingClientRect(); const cx = r0.left + sc.clientWidth / 2, cy = r0.top + sc.clientHeight / 2;
    let prev = null, jumps = 0, worst = 0, resized = 0, frames = 0; const sizes = new Map(); const t0 = performance.now(); const m0 = window.__meas;
    const step = () => {
      const pg = document.elementFromPoint(cx, cy)?.closest('.pdf-page');
      if (prev && prev.el.isConnected) { const dy = prev.el.getBoundingClientRect().top - prev.top, ds = sc.scrollTop - prev.st; const err = Math.abs(dy + ds); if (err > 1 || Math.abs(ds - 7) > 0.5) { jumps++; worst = Math.max(worst, err, Math.abs(ds - 7)); } }
      for (const el of document.querySelectorAll('.pdf-page')) { const r = el.getBoundingClientRect(); if (r.bottom < r0.top || r.top > r0.bottom) continue; const k = el.style.width + 'x' + el.style.height; if (sizes.has(el) && sizes.get(el) !== k) resized++; sizes.set(el, k); }
      if (performance.now() - t0 > 3000) { res({ jumps, worst, resized, frames, measured: window.__meas - m0, pages: sizes.size }); return; }
      prev = pg ? { el: pg, top: pg.getBoundingClientRect().top, st: sc.scrollTop } : null; sc.scrollTop += 7; frames++;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
  console.log('scrolling 3 s:', JSON.stringify(scrollRun));
  ok('scrolling: the page under the middle never jumps (it moves only by the scroll)', scrollRun.frames > 60 && scrollRun.jumps === 0);
  ok('scrolling: no page on the screen changes size, and nothing is measured meanwhile', scrollRun.resized === 0 && scrollRun.measured === 0);
  await idle(p);
  // Off, then on again: the same place.
  const s0 = await at(p, 0.5, 0.4); await toggleCrop(p, false); await p.waitForTimeout(800); const s1 = await at(p, 0.5, 0.4);
  await toggleCrop(p, true); await p.waitForTimeout(800); const s2 = await at(p, 0.5, 0.4);
  console.log(`on → off → on: page ${s0.n} at ${s0.wy.toFixed(4)} (sheet ${s0.sy.toFixed(4)}) → off page ${s1.n} sheet ${s1.sy.toFixed(4)}, width ${s1.ww} → on page ${s2.n} at ${s2.wy.toFixed(4)}`);
  ok('crop off: the same line of the same page at the same place, whole pages', s1.n === s0.n && near(s1.sy * s1.sh, s0.sy * s1.sh, 3) && near(s1.ww, plainW, 1));
  ok('crop on again: the same page and the same offset in it (within 3 px)', s2.n === s0.n && near(s2.wy * s2.wh, s0.wy * s0.wh, 3));
  // Search: the highlight lands on the word ("needle", line 5 of page 300, at x 60 pt).
  await p.keyboard.press('/'); await p.waitForSelector('.panel.open input[type=search]'); await p.fill('.panel.open input[type=search]', 'needle');
  await p.waitForSelector('.panel.open .hit', { timeout: 60000 }); await p.tap('.panel.open .hit >> nth=0');
  await p.waitForFunction(() => document.querySelectorAll('.pdf-page')[299].querySelector('.textLayer .highlight'), null, { timeout: 20000 }).catch(() => undefined); await p.waitForTimeout(400);
  const hl = await p.evaluate(() => { const pg = document.querySelectorAll('.pdf-page')[299]; const sp = pg.querySelector('.textLayer .highlight'); if (!sp) return null; const r = sp.getBoundingClientRect(), s = pg.querySelector('.pdf-sheet').getBoundingClientRect(), w = pg.getBoundingClientRect(); return { x: ((r.left - s.left) / s.width) * 400, y: ((r.top + r.height / 2 - s.top) / s.height) * 560, inside: r.left >= w.left - 1 && r.right <= w.right + 1 && r.top >= w.top - 1 && r.bottom <= w.bottom + 1, text: sp.textContent }; });
  // (Line 5's baseline is 560 - (480 - 160) = 240 pt from the top; the word's middle a few points above it; "needle" follows "line 5 of page 300: ".)
  console.log('search highlight:', JSON.stringify(hl));
  ok('search with the margins cropped: the highlight is on the word, inside the page', !!hl && hl.inside && near(hl.y, 236, 6) && hl.x > 100 && hl.x < 260);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  // Zoom buttons: the point at the middle stays.
  await idle(p, 800); const z0 = await at(p, 0.5, 0.5); await p.evaluate(() => document.querySelector('.pdf-bar button[aria-label="Zoom in"]').click()); await p.waitForTimeout(700); const z1 = await at(p, 0.5, 0.5);
  console.log(`zoom in: page ${z0.n} at ${z0.wx.toFixed(3)}, ${z0.wy.toFixed(3)} w ${z0.ww} → page ${z1.n} at ${z1.wx.toFixed(3)}, ${z1.wy.toFixed(3)} w ${z1.ww}`);
  ok('zoom in with the margins cropped: 1.15 times, the middle point stays', near(z1.ww, z0.ww * 1.15, 2) && z1.n === z0.n && near(z1.wx, z0.wx, 0.01) && near(z1.wy, z0.wy, 0.01));
  await p.evaluate(() => document.querySelector('.pdf-bar button[aria-label="Zoom out"]').click()); await p.waitForTimeout(700); const z2 = await at(p, 0.5, 0.5);
  ok('zoom out with the margins cropped: back, the middle point stays', near(z2.ww, z0.ww * 1.15 * 0.85, 2) && z2.n === z0.n && near(z2.wx, z0.wx, 0.01) && near(z2.wy, z0.wy, 0.01));
  await p.evaluate(() => document.querySelector('.pdf-bar button[aria-label="Fit width"]').click()); await p.waitForTimeout(700);
  // Pinch: the point under the fingers stays under them.
  const pz = await pinch(p, cdp, 150, 420, 100, 220); console.log('pinch, cropped:', JSON.stringify(pz));
  ok('pinch with the margins cropped: the point under the fingers stays (picture and layout, within 2 px)', Math.hypot(...pz.pic) <= 2 && Math.hypot(...pz.laid) <= 2 && !pz.tf);
  // Zoomed in on a page not measured yet: measuring the pages there takes none of the tiles off the screen.
  await p.evaluate(() => document.querySelector('.pdf-bar button[aria-label="Fit width"]').click()); await p.waitForTimeout(600);
  await toPage(p, 700); await p.waitForTimeout(100); await p.evaluate(() => { window.__meas = 0; });
  for (let i = 0; i < 3; i++) { await p.evaluate(() => document.querySelector('.pdf-bar button[aria-label="Zoom in"]').click()); await p.waitForTimeout(400); }
  await p.waitForTimeout(400); await p.evaluate(() => window.__watch()); const tilesBefore = await p.evaluate(() => document.querySelectorAll('.pdf-tile').length);
  const mz = await idle(p, 1500); const td = await p.evaluate(() => [window.__tileDrops, document.querySelectorAll('.pdf-tile').length, window.__relayouts]);
  console.log(`zoomed in at page 700: ${mz} measured, ${td[0]} tiles taken off (${tilesBefore} → ${td[1]} tiles), ${td[2]} whole-book layouts`);
  ok('zoomed in: the pages near are measured, no tile is taken off, no whole-book layout', mz > 0 && td[0] === 0 && td[1] >= tilesBefore && td[2] === 0);
  await p.evaluate(() => document.querySelector('.pdf-bar button[aria-label="Fit width"]').click()); await p.waitForTimeout(600);
  // Reopened: what was found is used (nothing measured again near where the reader was), laid out cropped at once.
  await toPage(p, 300); await idle(p, 1500); await p.waitForTimeout(4500);   // (saved every few seconds)
  const cropW = (await at(p, 0.5, 0.4)).ww;
  await p.close(); p = await open(ctx, port, null, { fresh: false }); await toPage(p, 300); await p.waitForTimeout(400);
  await p.evaluate(() => window.__watch()); const mr = await idle(p, 1500); const re = await at(p, 0.5, 0.4); const rr = await p.evaluate(() => window.__relayouts);
  console.log(`reopened: ${mr} measured, width ${re.ww} (was ${cropW}), ${rr} whole-book layouts`);
  ok('reopened: the kept boxes are used — nothing measured again, cropped from the start', mr === 0 && near(re.ww, cropW, 1) && rr === 0);
  // A box list kept by the old version (a bare array): not trusted, found again the new way.
  await p.evaluate(() => new Promise((res, rej) => { const q = indexedDB.open('kurokawa-reader'); q.onsuccess = () => { const db = q.result; const t = db.transaction(['books', 'meta'], 'readwrite'); t.objectStore('books').getAll().onsuccess = (e) => { const id = e.target.result[0].id; t.objectStore('meta').put(Array.from({ length: 1000 }, () => [0.4, 0.4, 0.2, 0.2]), `crop:${id}`); }; t.oncomplete = () => res(); t.onerror = rej; }; }));
  await p.close(); p = await open(ctx, port, null, { fresh: false }); await toPage(p, 300); await p.waitForTimeout(300);
  const mo = await idle(p, 1500); const ro = await at(p, 0.5, 0.4); const sho = await shows(p, ro.n, 400, 560);
  console.log(`old-format boxes: ${mo} measured, width ${ro.ww}, page ${ro.n} shows ${sho.l.toFixed(0)}–${sho.r.toFixed(0)} × ${sho.t.toFixed(0)}–${sho.b.toFixed(0)} pt`);
  ok('an old-format box list is ignored: found again, the text shown whole', mo > 0 && mo < 100 && near(ro.ww, cropW, 1) && sho.l <= 60 && sho.r >= 245 && sho.t <= 100 && sho.b >= 525);
  await ctx.close();

  /* ---------- tricky pages ---------- */
  // Book B: 40 pages of 400 × 560; ordinary pages have their column at x 90 (odd) or 40 (even) — facing pages — and
  // a page number; the pages below are each hard in their own way. Every drawing's place is known (`ink`).
  const fileB = path.join(os.tmpdir(), 'kr-pdfcrop-tricky.pdf'); const ink = {}; const H = 560;
  { const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
    const box = (n, l, t, r, bb) => { const k = ink[n] ??= []; k.push([l, t, r, bb]); };
    const text = (pg, n, s, x, y, size, color = rgb(0, 0, 0)) => { pg.drawText(s, { x, y, size, font, color }); box(n, x, H - (y + size * 0.72), x + font.widthOfTextAtSize(s, size), H - (y - size * 0.21)); };
    const column = (pg, n, color) => { const x = n % 2 ? 90 : 40; for (let l = 0; l < 12; l++) text(pg, n, `ordinary line ${l + 1} on page ${n}`, x, 470 - l * 30, 12, color); text(pg, n, String(n), x + 120, 60, 8, color); };
    for (let n = 1; n <= 40; n++) {
      const pg = d.addPage([400, 560]);
      if (n === 5) { const g = rgb(0.784, 0.784, 0.784); column(pg, n, g); text(pg, n, 'light grey note far out', 12, 530, 11, g); }
      else if (n === 7) { column(pg, n); text(pg, n, '7', 197, 4, 6); }
      else if (n === 9) { column(pg, n); pg.drawLine({ start: { x: 30, y: 552 }, end: { x: 370, y: 552 }, thickness: 0.4, color: rgb(0, 0, 0) }); box(n, 30, H - 552.2, 370, H - 551.8); }
      else if (n === 11) { pg.drawRectangle({ x: 0, y: 0, width: 400, height: 560, color: rgb(0.95, 0.91, 0.82) }); column(pg, n); text(pg, n, 'a line low on tinted paper', 90, 14, 10); }
      else if (n === 13) { pg.drawRectangle({ x: 0, y: 0, width: 400, height: 560, color: rgb(0.12, 0.12, 0.12) }); const w = rgb(0.88, 0.88, 0.88); column(pg, n, w); text(pg, n, 'light on dark, far left', 10, 300, 11, w); }
      else if (n === 15) { /* blank */ }
      else if (n === 17) { for (let i = 0; i < 10; i++) pg.drawRectangle({ x: i * 40, y: 0, width: 40, height: 560, color: rgb((i * 0.37) % 1, (i * 0.61) % 1, (i * 0.13 + 0.2) % 1) }); box(n, 0, 0, 400, 560); }
      else if (n === 19) { column(pg, n); pg.drawLine({ start: { x: 8, y: 60 }, end: { x: 8, y: 500 }, thickness: 0.5, color: rgb(0.784, 0.784, 0.784) }); box(n, 7.75, H - 500, 8.25, H - 60); }
      else if (n === 21) { column(pg, n); text(pg, n, 'light blue words reaching right', 230, 250, 12, rgb(0.66, 0.78, 0.94)); }
      else column(pg, n);
    }
    fs.writeFileSync(fileB, await d.save()); }
  const ctx2 = await b.newContext(phone); await ctx2.addInitScript(HOOKS);
  p = await open(ctx2, port, fileB); cdp = await ctx2.newCDPSession(p);
  await toggleCrop(p, true); await idle(p, 1500);
  const widths = {}; const names = { 5: 'light grey text far out', 7: 'a tiny page number at the very bottom', 9: 'a hairline near the top edge', 11: 'tinted paper, a line low down', 13: 'a dark page with light text', 17: 'a picture to the edges', 19: 'a light grey hairline near the left edge', 21: 'light blue words reaching right' };
  for (let n = 1; n <= 40; n++) {
    await toPage(p, n); await idle(p, 700, 8000);
    const s = await shows(p, n, 400, 560); widths[n] = s.w;
    if (!ink[n]) { if (n === 15) ok(`page ${n} (blank): shown, ${s.w.toFixed(0)} × ${s.h.toFixed(0)} px`, s.h > 50); continue; }
    const L = Math.min(...ink[n].map((q) => q[0])), T = Math.min(...ink[n].map((q) => q[1])), R = Math.max(...ink[n].map((q) => q[2])), B = Math.max(...ink[n].map((q) => q[3]));
    const inside = s.l <= L + 0.5 && s.t <= T + 0.5 && s.r >= R - 0.5 && s.b >= B - 0.5;
    if (names[n] || !inside) { console.log(`page ${n}: ink ${L.toFixed(1)}–${R.toFixed(1)} × ${T.toFixed(1)}–${B.toFixed(1)} pt; shown ${s.l.toFixed(1)}–${s.r.toFixed(1)} × ${s.t.toFixed(1)}–${s.b.toFixed(1)}, ${s.w.toFixed(1)} px wide`); ok(`page ${n}${names[n] ? ` (${names[n]})` : ''}: all its ink is shown`, inside); }
    else if (n % 10 === 0) ok(`pages up to ${n}: all their ink shown`, true);
  }
  const ord = Object.keys(widths).map(Number).filter((n) => !names[n] && n !== 15);
  const ow = ord.map((n) => widths[n]); console.log('ordinary widths:', Math.min(...ow).toFixed(1), '–', Math.max(...ow).toFixed(1), '· exceptions:', Object.keys(names).map((n) => `${n}: ${widths[n].toFixed(1)}`).join(', '));
  ok('the ordinary pages are all one width on the screen (and fill it)', Math.max(...ow) - Math.min(...ow) <= 1 && Math.min(...ow) >= 380);
  ok('no exception is wider than the ordinary pages', Object.keys(names).every((n) => widths[n] <= Math.min(...ow) + 1));
  // Facing pages: the column of odd and even pages starts at the same place on the screen.
  await toPage(p, 2); await p.waitForTimeout(300); const e2 = await shows(p, 2, 400, 560); await toPage(p, 3); await p.waitForTimeout(300); const o3 = await shows(p, 3, 400, 560);
  const startE = e2.sl + (40 / 400) * e2.sw, startO = o3.sl + (90 / 400) * o3.sw; console.log(`facing pages: text starts at ${startE.toFixed(1)} px (even) and ${startO.toFixed(1)} px (odd)`);
  ok('facing pages (margins swapped): odd and even pages\' text starts at the same place', near(startE, startO, 3));
  // Pinch on a facing page.
  await toPage(p, 4); await p.waitForTimeout(500); const pf = await pinch(p, cdp, 220, 380, 100, 240); console.log('pinch, facing page:', JSON.stringify(pf));
  ok('pinch on a cropped page: the point under the fingers stays', Math.hypot(...pf.pic) <= 2 && Math.hypot(...pf.laid) <= 2 && !pf.tf);
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
