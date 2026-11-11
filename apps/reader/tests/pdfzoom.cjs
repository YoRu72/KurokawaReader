// node tests/pdfzoom.cjs: the PDF viewer's zoom buttons on a phone — each tap zooms by its step from the size the last one
// reached (taps within the 220 ms animation were lost, or placed by the old layout: the page jumped elsewhere, or the
// picture stayed stretched), and the point at the middle of the screen stays there, across and down.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
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
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
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
  // Margins cropped (from the More menu).
  await p.click('.pdf-bar button[aria-label="More"], button[aria-label="More"]'); await p.click('.panel.open button:has-text("Crop the margins")'); await p.waitForTimeout(1500);
  await scroll(3000); e = await st(); await zin(); await p.waitForTimeout(600); z = await st(); console.log('margins cropped:', show(e), '→', show(z));
  ok('margins cropped: 1.15 times, the middle point stays', near(z.w, e.w * 1.15, 2) && stays(e, z));
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
