// node tests/pdfzoom.cjs: the PDF viewer's zoom buttons on a phone — each tap zooms by its step from the size the last one
// reached (taps within the 220 ms animation were lost, or placed by the old layout: the page jumped elsewhere, or the
// picture stayed stretched), and the point at the middle of the screen stays there, across and down.
// Pinching with two real fingers (CDP touch points): the point under the fingers stays under them while pinching and
// once laid out — on the first, a middle and the last page, between two pages, panning with no zoom; letting go below
// the width or above the most glides back instead of jumping; a finger lifted and put back, a third finger, a cancelled
// touch, a pinch on a gliding page, two pinches in a row, a double tap just after, a pinch during a button's zoom —
// nothing stuck, nothing lost; the pages are sharp and their text where the words are after; no layout read per move.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// Two fingers: down one after the other at (cx ± d0/2, cy), spread to d1 while moving by `pan`, then up. The sheet point
// first under them is followed every frame: where it is at release (the picture) and once laid out, and the biggest
// step it makes from one frame to the next after release (a jump).
async function pinchAt(p, T, cx, cy, d0, d1, { pan = [0, 0], steps = 10, hold = 700, end = 'up', late = false } = {}) {
  // (`late`: the point is taken once both fingers are down — on a moving page, what is under them then.)
  const follow = () => p.evaluate(([x, y]) => {
    const pages = [...document.querySelectorAll('.pdf-page')]; let n = 0; for (let i = 0; i < pages.length; i++) if (pages[i].getBoundingClientRect().bottom >= y) { n = i + 1; break; }
    const sh = pages[n - 1].querySelector('.pdf-sheet'); const r = sh.getBoundingClientRect(); const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
    const pos = () => { const r = sh.getBoundingClientRect(); return [r.left + fx * r.width, r.top + fy * r.height]; };
    const tr = window.__tr = { pos, log: [], n }; cancelAnimationFrame(window.__raf); const loop = () => { tr.log.push(pos()); window.__raf = requestAnimationFrame(loop); }; loop();
  }, [cx, cy]);
  if (!late) await follow();
  await T('touchStart', [[cx - d0 / 2, cy]]); await T('touchStart', [[cx - d0 / 2, cy], [cx + d0 / 2, cy]]);
  if (late) await follow();
  let ex = cx, ey = cy;
  for (let i = 1; i <= steps; i++) { const d = d0 + ((d1 - d0) * i) / steps; ex = cx + (pan[0] * i) / steps; ey = cy + (pan[1] * i) / steps; await T('touchMove', [[ex - d / 2, ey], [ex + d / 2, ey]]); await p.waitForTimeout(16); }
  await p.waitForTimeout(40); await p.evaluate(() => { window.__tr.rel = window.__tr.log.length; });
  if (end === 'cancel') await T('touchCancel', []); else await T('touchEnd', []);
  await p.waitForTimeout(hold);
  return p.evaluate(([ex, ey]) => {
    cancelAnimationFrame(window.__raf); const tr = window.__tr, L = tr.log, pic = L[tr.rel - 1], end = tr.pos(); let step = 0;
    for (let i = tr.rel; i < L.length; i++) step = Math.max(step, Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]));
    const sc = document.querySelector('.pdf-scroll'); const pg = document.querySelectorAll('.pdf-page')[tr.n - 1];
    return { n: tr.n, pic: [pic[0] - ex, pic[1] - ey], laid: [end[0] - ex, end[1] - ey], step, w: pg.getBoundingClientRect().width, sl: sc.scrollLeft, tf: document.querySelector('.pdf-inner').style.transform };
  }, [ex, ey]);
}
const show2 = (r) => `page ${r.n}: picture ${r.pic.map((v) => v.toFixed(1))} · laid out ${r.laid.map((v) => v.toFixed(1))} off the fingers · biggest step after ${r.step.toFixed(1)} · w ${r.w.toFixed(0)} · scrollLeft ${r.sl.toFixed(0)}${r.tf ? ` · left: ${r.tf}` : ''}`;
const held = (r, tol = 1.5) => Math.hypot(...r.pic) <= tol && Math.hypot(...r.laid) <= tol && r.step <= 3 && !r.tf;
// (Glided, not jumped: no frame takes more than half the way — the headless browser draws few frames in 200 ms.)
const glided = (r) => r.step <= Math.max(3, 0.5 * Math.hypot(...r.laid) + 1);

async function pinches(p, ok) {
  const cdp = await p.context().newCDPSession(p);
  const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i, radiusX: 1, radiusY: 1, force: 1 })) });
  const scroll = (top) => p.evaluate((t) => { const sc = document.querySelector('.pdf-scroll'); sc.scrollTop = t < 0 ? sc.scrollHeight : t; }, top).then(() => p.waitForTimeout(500));
  const fit = async () => { await p.evaluate(() => document.querySelector('.pdf-bar button[aria-label="Fit width"]').click()); await p.waitForTimeout(700); };
  const state = () => p.evaluate(() => { const sc = document.querySelector('.pdf-scroll'); return { w: document.querySelector('.pdf-page').getBoundingClientRect().width, st: sc.scrollTop, sl: sc.scrollLeft, tf: document.querySelector('.pdf-inner').style.transform }; });
  const w0 = (await state()).w;
  // (Layout reads per move: the scroll's own box asked for while the fingers move. It was read on every move, with
  // the fit width worked out again — a style and layout pass each time.)
  await p.evaluate(() => { window.__rects = 0; const g = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function () { if (this.classList?.contains('pdf-scroll') && window.__moving) window.__rects++; return g.call(this); }; });
  // The point under the fingers (the picture was 12 px × (zoom − 1) off: the transform's origin ignored the scroll's
  // top padding, and jumped back when laid out — 18 px at 2.5 times).
  for (const [label, top, y] of [['a middle page', 3000, 420], ['the first page', 0, 220], ['the last page', -1, 420]]) {
    await scroll(top); const r = await pinchAt(p, T, 150, y, 100, 250); console.log(`pinch on ${label}:`, show2(r));
    ok(`pinch out on ${label}: the point stays under the fingers, picture and layout, no jump`, held(r) && near(r.w, w0 * 2.5, 3)); await fit();
  }
  // (The gap is put 400 px down the scroll, well inside it: a pinch on the bars would zoom the browser's own page.)
  const gy = await p.evaluate(() => { const sc = document.querySelector('.pdf-scroll'); const pg = document.querySelectorAll('.pdf-page')[5]; sc.scrollTop = pg.offsetTop + pg.offsetHeight + 7 - 400; return 0; }).then(() => p.waitForTimeout(400)).then(() => p.evaluate(() => document.querySelectorAll('.pdf-page')[5].getBoundingClientRect().bottom + 7));
  let r = await pinchAt(p, T, 200, gy, 100, 250); console.log('pinch between two pages:', show2(r)); ok('pinch with the fingers between two pages: no jump', held(r));
  // Two fingers that only pan (no zoom): it sprang back by the whole pan (94 px for 50 × 80).
  await p.evaluate(() => { window.__moving = true; });
  r = await pinchAt(p, T, 200, 420, 150, 150, { pan: [-50, -80] }); console.log('two-finger pan:', show2(r));
  const rects = await p.evaluate(() => { window.__moving = false; return window.__rects; });
  ok('two fingers panning without zooming: the page follows them, no spring back', held(r));
  ok(`no layout read of the scroll on each move (${rects} in 10 moves)`, rects <= 1);
  // Wider than the screen, pinched back below the width at the left: glides to the width, centred, nothing left over
  // (it jumped 40 px across and snapped in size; the shrinking picture also pulled the scroll back under the fingers).
  r = await pinchAt(p, T, 110, 420, 260, 60); let s = await state(); console.log('below the width:', show2(r), JSON.stringify(s));
  ok('let go below the width: no jump, back at the width, centred (scrollLeft 0), no transform left', Math.hypot(...r.pic) <= 1.5 && glided(r) && near(s.w, w0, 1) && s.sl === 0 && !s.tf);
  await scroll(3000); await pinchAt(p, T, 200, 420, 100, 250); r = await pinchAt(p, T, 200, 420, 100, 300); s = await state(); console.log('above the most:', show2(r));
  ok('let go above the most (4): no jump, at 4 times (1600 px), the point under the fingers', Math.hypot(...r.pic) <= 1.5 && glided(r) && near(s.w, 1600, 2) && Math.hypot(...r.laid) <= 2 && !s.tf);
  await fit(); await scroll(3000);
  // A finger lifted and put down again; a third finger; a cancelled touch.
  await T('touchStart', [[150, 420]]); await T('touchStart', [[150, 420], [250, 420]]); for (let i = 1; i <= 5; i++) { await T('touchMove', [[150 - i * 8, 420], [250 + i * 8, 420]]); await p.waitForTimeout(16); }
  await T('touchEnd', [[110, 420]]); await p.waitForTimeout(80); const lifted = await state();
  await T('touchStart', [[110, 420], [290, 420]]); for (let i = 1; i <= 5; i++) { await T('touchMove', [[110 - i * 8, 420], [290 + i * 8, 420]]); await p.waitForTimeout(16); } await T('touchEnd', []); await p.waitForTimeout(600); s = await state();
  console.log(`a finger lifted: w ${lifted.w.toFixed(0)}, put back and pinched on: w ${s.w.toFixed(0)}`);
  ok('a finger lifted mid-pinch: laid out there; put back, the pinch goes on from it; nothing left stretched', lifted.w > w0 * 1.5 && !lifted.tf && s.w > lifted.w * 1.3 && !s.tf);
  await fit(); await scroll(3000);
  await T('touchStart', [[150, 420]]); await T('touchStart', [[150, 420], [250, 420]]); for (let i = 1; i <= 5; i++) { await T('touchMove', [[150 - i * 8, 420], [250 + i * 8, 420]]); await p.waitForTimeout(16); }
  await T('touchStart', [[110, 420], [290, 420], [200, 600]]); await p.waitForTimeout(60); const third = await state(); await T('touchMove', [[100, 420], [300, 420], [200, 560]]); await T('touchEnd', []); await p.waitForTimeout(600); s = await state();
  ok('a third finger: the pinch is laid out where it was, nothing left stretched', third.w > w0 * 1.5 && !third.tf && near(s.w, third.w, 1) && !s.tf);
  await fit(); await scroll(3000);
  r = await pinchAt(p, T, 200, 420, 100, 200, { end: 'cancel' }); console.log('cancelled:', show2(r)); ok('a cancelled touch mid-pinch: laid out where it was, no jump', held(r));
  // On a page still gliding (a smooth scroll under way): it stops where it is, the pinch holds.
  await fit(); await scroll(3000);
  await p.evaluate(() => document.querySelector('.pdf-scroll').scrollTo({ top: 9000, behavior: 'smooth' })); await p.waitForTimeout(80);
  r = await pinchAt(p, T, 200, 420, 100, 200, { late: true }); const st1 = (await state()).st; await p.waitForTimeout(500); s = await state(); console.log('on a gliding page:', show2(r));
  ok('a pinch on a gliding page: the glide stops, the point stays under the fingers', held(r) && s.st === st1);
  // Two pinches in a row; a double tap just after one; a pinch while a button's zoom animates (the zoom's own layout
  // took away the text the finger was on: the touch's events no longer reached the scroll and the pinch hung, stretched).
  await fit(); await scroll(3000);
  const r1 = await pinchAt(p, T, 200, 420, 100, 160, { hold: 30 }); const r2 = await pinchAt(p, T, 200, 420, 100, 160); s = await state();
  ok('two pinches in a row: 1.6 × 1.6, each holding the point', held(r1, 2.5) && held(r2) && near(s.w, w0 * 2.56, 4));
  await fit(); await scroll(3000); await pinchAt(p, T, 200, 420, 100, 200, { hold: 100 }); const wz = (await state()).w;
  await T('touchStart', [[200, 420]]); await T('touchEnd', []); await p.waitForTimeout(80); await T('touchStart', [[200, 420]]); await T('touchEnd', []); await p.waitForTimeout(800); s = await state();
  console.log(`double tap 100 ms after a pinch: w ${wz.toFixed(0)} → ${s.w.toFixed(0)}`); ok('a double tap just after a pinch is not lost (back to the width)', near(s.w, w0, 1));
  await fit(); await scroll(3000); await p.evaluate(() => document.querySelector('.pdf-bar button[aria-label="Zoom in"]').click()); await p.waitForTimeout(60);
  // (The pinch begins on a picture still moving: a few pixels off, 2.5 here and 3.7 on the CI machine. The zoom itself is exact.)
  r = await pinchAt(p, T, 200, 420, 100, 200); s = await state(); console.log('pinch during a button zoom:', show2(r));
  ok('a pinch during a button\'s zoom: both count (1.15 × 2), nothing left stretched', held(r, 6) && near(s.w, w0 * 1.15 * 2, 3) && !s.tf);
  // Sharp after a pinch: the pages on the screen redrawn at the new size (no tiles missing), their text where the words are.
  await fit(); await scroll(3000); await pinchAt(p, T, 200, 420, 100, 250, { hold: 0 }); const t0 = Date.now();
  const sharp = await p.waitForFunction(() => { const sc = document.querySelector('.pdf-scroll'); const r0 = sc.getBoundingClientRect(); const vis = [...document.querySelectorAll('.pdf-page')].filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > r0.top && r.top < r0.bottom; }); return vis.length && vis.every((e) => e.dataset.res === 'full' && e.querySelector('.textLayer span')); }, null, { timeout: 5000 }).then(() => true, () => false);
  const words = await p.evaluate(() => { const sc = document.querySelector('.pdf-scroll'); const r0 = sc.getBoundingClientRect(); const pg = document.elementFromPoint(r0.left + sc.clientWidth / 2, r0.top + sc.clientHeight / 2)?.closest('.pdf-page'); const sh = pg.querySelector('.pdf-sheet').getBoundingClientRect();
    // (Line l's baseline is 500 − 34 l pt up from the bottom: 60 + 34 l from the top; a word's middle about 4.5 pt above it.)
    let worst = 0, n = 0; for (const sp of pg.querySelectorAll('.textLayer span')) { const r = sp.getBoundingClientRect(); if (!r.height) continue; const y = ((r.top + r.height / 2 - sh.top) / sh.height) * 560; const l = Math.round((y - 60 + 4.5) / 34); worst = Math.max(worst, Math.abs(y - (60 + 34 * l - 4.5))); n++; } return { n, worst }; });
  console.log(`after a pinch: sharp in ${Date.now() - t0} ms; ${words.n} words, the farthest ${words.worst.toFixed(1)} pt from its line`);
  ok('after a pinch the pages on the screen are redrawn sharp with their text, within 5 s', sharp);
  ok('after a pinch the text layer lies on the words (within 3 pt)', words.n > 20 && words.worst <= 3);
  await fit();
}

(async () => {
  // (A book made here: 60 pages of 400 × 560 pt with wide margins, for the margin cropping.)
  const { PDFDocument, StandardFonts } = require('pdf-lib'); const file = path.join(require('os').tmpdir(), 'kr-pdfzoom.pdf');
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 60; i++) { const pg = d.addPage([400, 560]); for (let l = 1; l <= 12; l++) pg.drawText(`line ${l} of page ${i}`, { x: 60, y: 500 - l * 34, size: 14, font }); }
  fs.writeFileSync(file, await d.save());
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const p = await (await b.newContext({ ...devices['Pixel 7'], locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [file]); await p.waitForSelector('.book-card', { timeout: 60000 });
  await p.click('.book-card'); await p.waitForSelector('.pdf-page', { timeout: 30000 }); await p.waitForTimeout(1200);
  // Where things are: the page's width, the page under the middle of the screen and the fraction of it there.
  const st = () => p.evaluate(() => {
    const sc = document.querySelector('.pdf-scroll'); const r0 = sc.getBoundingClientRect(); const cx = r0.left + sc.clientWidth / 2, cy = r0.top + sc.clientHeight / 2;
    const pages = [...document.querySelectorAll('.pdf-page')]; let n = 0, fx = 0, fy = 0;
    for (let i = 0; i < pages.length; i++) { const r = pages[i].getBoundingClientRect(); if (r.top <= cy && r.bottom >= cy) { n = i + 1; fx = (cx - r.left) / r.width; fy = (cy - r.top) / r.height; break; } }
    return { w: pages[n ? n - 1 : 0].getBoundingClientRect().width, n, fx: +fx.toFixed(3), fy: +fy.toFixed(3), sl: Math.round(sc.scrollLeft), count: document.querySelector('.pcount')?.textContent ?? '', tf: document.querySelector('.pdf-inner').style.transform };
  });
  const show = (s) => `w ${s.w.toFixed(1)} · page ${s.n} at ${s.fx}, ${s.fy}${s.tf ? ` · left stretched: ${s.tf}` : ''}`;
  const btn = (label) => p.evaluate((l) => document.querySelector(`.pdf-bar button[aria-label="${l}"]`).click(), label);
  const zin = () => btn('Zoom in'), zout = () => btn('Zoom out'), fit = async () => { await btn('Fit width'); await p.waitForTimeout(600); };
  const stays = (a, z) => z.n === a.n && near(z.fx, a.fx, 0.01) && near(z.fy, a.fy, 0.01) && !z.tf;
  const scroll = (top) => p.evaluate((t) => { const sc = document.querySelector('.pdf-scroll'); sc.scrollTop = t < 0 ? sc.scrollHeight : t; }, top).then(() => p.waitForTimeout(500));
  await scroll(3000); const a = await st(); const w0 = a.w; console.log('start:', show(a), '·', a.count);
  // One tap (a real tap on the button).
  await p.tap('.pdf-bar button[aria-label="Zoom in"]'); await p.waitForTimeout(600); let z = await st(); console.log('one tap:', show(z));
  ok('one tap: 1.15 times, the middle point stays, the page number too', near(z.w, w0 * 1.15, 2) && stays(a, z) && z.count === a.count);
  await zin(); await p.waitForTimeout(600); await zin(); await p.waitForTimeout(600); let a2 = await st();
  await p.evaluate(() => { document.querySelector('.pdf-scroll').scrollLeft += 90; }); await p.waitForTimeout(300); a2 = await st();
  await zin(); await p.waitForTimeout(600); z = await st(); console.log('wider than the screen, moved across:', show(a2), '→', show(z));
  ok('wider than the screen and moved across: the middle point stays across and down', a2.sl > 0 && near(z.w, a2.w * 1.15, 2) && stays(a2, z));
  await fit(); z = await st(); ok('fit width: back to the width, at the same place', near(z.w, w0, 1) && stays(a, z));
  // Quick taps: each counts, from the size the last one reached.
  for (const gap of [40, 120, 200, 260]) {
    const s = await st(); await zin(); await p.waitForTimeout(gap); await zin(); await p.waitForTimeout(gap); await zin(); await p.waitForTimeout(800); z = await st();
    console.log(`three taps ${gap} ms apart:`, show(z), `(want w ${(s.w * 1.15 ** 3).toFixed(1)})`);
    ok(`three taps ${gap} ms apart: 1.52 times, the middle point stays`, near(z.w, s.w * 1.15 ** 3, 3) && stays(s, z));
    const s2 = await st(); await zin(); await p.waitForTimeout(gap); await zout(); await p.waitForTimeout(800); z = await st();
    console.log(`in then out ${gap} ms apart:`, show(z), `(want w ${(s2.w * 1.15 * 0.85).toFixed(1)})`);
    ok(`in then out ${gap} ms apart: 1.15 × 0.85, the middle point stays`, near(z.w, s2.w * 1.15 * 0.85, 3) && stays(s2, z));
    await fit();
  }
  // Up to the most (4 times the page's own size) and back.
  for (let i = 0; i < 14; i++) { await zin(); await p.waitForTimeout(120); } await p.waitForTimeout(600); z = await st(); console.log('the most:', show(z));
  ok('zoomed in up to the most: 4 (1600 px for a 400 pt page), the middle point stays', near(z.w, 1600, 2) && stays(a, z));
  for (let i = 0; i < 6; i++) { await zout(); await p.waitForTimeout(120); } await p.waitForTimeout(600); z = await st(); console.log('six out:', show(z));
  ok('back out six taps: 4 × 0.85⁶, the middle point stays', near(z.w, 1600 * 0.85 ** 6, 3) && stays(a, z));
  await fit();
  // The last page and the first.
  await scroll(-1); let e = await st(); await zin(); await p.waitForTimeout(600); z = await st(); console.log('last page:', show(e), '→', show(z), '·', z.count);
  ok('the last page: zoomed in where it is', e.n === 60 && near(z.w, w0 * 1.15, 2) && stays(e, z) && /Page 60 of 60/.test(z.count));
  await fit(); await scroll(0); e = await st(); await zin(); await p.waitForTimeout(600); z = await st(); console.log('first page:', show(e), '→', show(z), '·', z.count);
  ok('the first page: zoomed in where it is', e.n === 1 && near(z.w, w0 * 1.15, 2) && stays(e, z) && /Page 1 of 60/.test(z.count));
  await fit();
  await pinches(p, ok);
  await fit();
  // Margins cropped (from the More menu).
  await p.click('.pdf-bar button[aria-label="More"], button[aria-label="More"]'); await p.click('.panel.open button:has-text("Crop the margins")'); await p.waitForTimeout(1500);
  await scroll(3000); e = await st(); await zin(); await p.waitForTimeout(600); z = await st(); console.log('margins cropped:', show(e), '→', show(z));
  ok('margins cropped: 1.15 times, the middle point stays', near(z.w, e.w * 1.15, 2) && stays(e, z));
  await fit(); await scroll(3000);
  { const cdp = await p.context().newCDPSession(p); const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
    const r = await pinchAt(p, T, 140, 420, 100, 240); console.log('margins cropped, pinch:', show2(r));
    ok('margins cropped: a pinch keeps the point under the fingers', held(r, 2)); }
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
