// node tests/pdfzoomperf.cjs: how a zoom feels on a phone, measured — a 412 × 915 screen at 2.6×, the processor slowed
// 4× (CDP), a dense Arabic and Latin book with tables (made here, by Chromium's own printing, made-up text, in a static
// TrueType font as most such books are: a variable font is printed as Type3 glyphs, several times slower to draw), page 8 of 36.
// Two real fingers pinch in and out several times, the zoom buttons are pressed; every frame the screen is sampled:
// • sharp: the time from the fingers' release (or the button's press) until every point of the screen on a page is
//   covered by a picture drawn at the screen's own resolution for the zoom (no stretched picture left);
// • the longest frame while the fingers move; • a band: the tallest run, down the screen, of points where nothing is
//   drawn — no page there, or a page with no picture (sampled every frame); • the most canvas pixels held at once.
// The targets — sharp ≤ 350 ms after a pinch, frames ≤ 32 ms while pinching — are printed (failed with PERF=strict); what
// fails always: sharp within 1.5 s, no band taller than a page gap, under 16 MP of canvases (PERF=report: all printed).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const CPU = Number(process.env.CPU || 4); const REPORT = process.env.PERF === 'report';
const SHOTS = process.env.SHOTS || '';   // a folder: a picture just after a pinch and one deep in

// Made-up text, the same every run (a small seeded generator).
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const AR = 'الميزانية الإيرادات النفقات العامة النمو الاقتصادي السنة المالية التقرير البيانات الربع الأول الثاني القطاع الخاص الاستثمار الأسواق السيولة التضخم الأسعار الصادرات الواردات الدين العجز الفائض الخطة الأهداف المؤشرات التحليل النتائج المقارنة ارتفاع انخفاض بنسبة نحو مليار ريال مقارنة بالفترة المماثلة من العام السابق وقد أظهرت حيث بلغ إجمالي'.split(' ');
const LA = ['GDP', 'Q3', 'IMF', 'Brent', 'OPEC+', 'index', 'fiscal', 'budget', 'yoy', 'revenue', 'outlook', 'growth'];
const sentence = () => { const n = 9 + Math.floor(rnd() * 9); const w = []; for (let i = 0; i < n; i++) w.push(rnd() < 0.12 ? pick(LA) : rnd() < 0.08 ? String(Math.floor(rnd() * 9000) + 100) : pick(AR)); return w.join(' ') + '.'; };
const para = () => Array.from({ length: 4 + Math.floor(rnd() * 3) }, sentence).join(' ');
const table = () => { const rows = []; for (let r = 0; r < 7; r++) { const c = []; for (let k = 0; k < 5; k++) c.push(r === 0 ? `<th>${pick(AR)} ${k + 1}</th>` : `<td>${k === 0 ? pick(AR) : (rnd() * 900).toFixed(1)}</td>`); rows.push(`<tr>${c.join('')}</tr>`); } return `<table>${rows.join('')}</table>`; };

async function makeBook(b, file) {
  const font = fs.readFileSync(path.resolve(__dirname, '../src/assets/fonts/AL-Mohanad.woff2')).toString('base64');
  const pages = []; for (let i = 1; i <= 36; i++) pages.push(`<section><h2>${pick(AR)} ${pick(AR)} — ${i}</h2><p>${para()}</p><p>${para()}</p>${table()}<p>${para()}</p><p>${para()}</p>${i % 2 ? table() : `<p>${para()}</p>`}<p>${para()}</p></section>`);
  const p = await b.newPage();
  await p.setContent(`<html dir="rtl"><style>@font-face{font-family:N;src:url(data:font/woff2;base64,${font})}@page{size:210mm 297mm;margin:0}body{margin:0;font:12px/1.55 N, sans-serif}section{box-sizing:border-box;height:297mm;padding:46px 52px;overflow:hidden;break-after:page}h2{font-size:17px;margin:0 0 8px;text-align:center}p{margin:0 0 7px;text-align:justify}table{border-collapse:collapse;width:100%;margin:6px 0 10px;font-size:11px}td,th{border:1px solid #444;padding:2px 5px;text-align:center}th{background:#ddd}</style>${pages.join('')}</html>`);
  await p.evaluate(() => document.fonts.ready);
  fs.writeFileSync(file, await p.pdf({ preferCSSPageSize: true, printBackground: true })); await p.close();
}

// The in-page recorder: frames, and every frame the screen sampled (a 9 × 60 grid over the scroll's viewport).
function recorder() {
  const w = window; const R = w.__R = { on: false, frames: [], marks: [], sharpAt: null, from: 0, band: 0, px: 0, blankAt: [] };
  const dpr = devicePixelRatio;
  const sample = () => {
    const sc = document.querySelector('.pdf-scroll'); if (!sc) return null; const vr = sc.getBoundingClientRect();
    const pages = []; for (const el of document.querySelectorAll('.pdf-page')) { const r = el.getBoundingClientRect(); if (r.bottom > vr.top && r.top < vr.bottom && r.right > vr.left && r.left < vr.right) pages.push(r); }
    // Every canvas on a page, its box on the screen and how many device pixels it has per screen pixel.
    const cv = []; let px = 0;
    for (const c of document.querySelectorAll('.pdf-page canvas')) { px += c.width * c.height; const r = c.getBoundingClientRect(); if (!r.width || r.bottom < vr.top || r.top > vr.bottom || r.right < vr.left || r.left > vr.right) continue; if (getComputedStyle(c).visibility === 'hidden' || c.closest('[hidden]')) continue; cv.push({ r, d: c.width / r.width }); }
    let all = true, band = 0; const COLS = 9, ROWS = 60;
    for (let i = 0; i < COLS; i++) {
      const x = vr.left + ((i + 0.5) * vr.width) / COLS; let run = 0;
      for (let j = 0; j < ROWS; j++) {
        const y = vr.top + ((j + 0.5) * vr.height) / ROWS;
        const inPage = pages.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom);
        let best = 0; for (const c of cv) if (x >= c.r.left && x < c.r.right && y >= c.r.top && y < c.r.bottom && c.d > best) best = c.d;
        if (inPage && best < dpr * 0.9) all = false;
        // (Nothing drawn: a page with no picture there, or no page at all — but the gap between two pages and the room
        // either side of a page narrower than the screen are the layout's own.)
        const across = pages.some((r) => x >= r.left && x < r.right);
        const gap = !inPage && pages.some((r) => r.bottom <= y && x >= r.left && x < r.right) && pages.some((r) => r.top > y && x >= r.left && x < r.right);
        if (across && !best && !gap) { run++; band = Math.max(band, run); } else run = 0;
      }
    }
    const moved = Math.abs(document.querySelector('.pdf-page').offsetWidth - R.w0) > 1 && !document.querySelector('.pdf-inner').style.transform;
    return { all, band: (band * vr.height) / ROWS, px, moved };
  };
  w.__sample = sample;
  let last = performance.now();
  const tick = (t) => {
    if (R.on) {
      // (The sampling's own time is taken off the frame after it: the frame is the app's, not the recorder's.)
      R.frames.push([t, t - last - (R.cost || 0)]);
      const c0 = performance.now(); const s = R.quiet ? null : sample(); R.cost = performance.now() - c0; if (s) { R.px = Math.max(R.px, s.px); R.band = Math.max(R.band, s.band); if (s.band > 30) R.blankAt.push(Math.round(t - R.from)); if (R.from && t > R.from && R.sharpAt === null && s.all && s.moved) R.sharpAt = t - R.from; }
    }
    last = t; requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // (The time is taken in the page just before the release is sent, or as the button is clicked: not when the test is
  // told afterwards. A release often goes to a word of the text layer the zoom has since taken off — out of the page,
  // so no listener of the page's own hears it.)
  addEventListener('click', () => { if (R.arm) { R.from = performance.now(); R.cut = R.frames.length; R.arm = false; } }, { capture: true });
}

(async () => {
  const file = path.join(os.tmpdir(), 'kr-pdfzoomperf.pdf');
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch();
  await makeBook(b, file);
  const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, locale: 'en', serviceWorkers: 'block' });
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [file]); await p.waitForSelector('.book-card', { timeout: 60000 });
  await p.click('.book-card'); await p.waitForSelector('.pdf-page', { timeout: 30000 });
  await p.waitForFunction(() => document.querySelectorAll('.pdf-page').length === 36, null, { timeout: 30000 });
  await p.evaluate(() => { const sc = document.querySelector('.pdf-scroll'); sc.scrollTop = document.querySelectorAll('.pdf-page')[7].offsetTop + 120; });
  await p.evaluate(recorder);
  const cdp = await ctx.newCDPSession(p);
  const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i, radiusX: 1, radiusY: 1, force: 1 })) });
  // Still and sharp before each measure (a deadline, not a fixed wait).
  const settled = (ms = 20000) => p.waitForFunction(() => { const s = window.__sample(); return s && s.all && !document.querySelector('.pdf-inner').style.transform; }, null, { timeout: ms, polling: 100 }).then(() => true, () => false);
  await settled(30000);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await settled(30000);
  const scaleNow = () => p.evaluate(() => document.querySelector('.pdf-page').getBoundingClientRect().width / document.querySelector('.pdf-scroll').clientWidth);
  const begin = () => p.evaluate(() => { const R = window.__R; R.frames = []; R.sharpAt = null; R.from = 0; R.band = 0; R.px = 0; R.blankAt = []; R.w0 = document.querySelector('.pdf-page').offsetWidth; R.on = true; });
  const mark = () => p.evaluate(() => { const R = window.__R; if (!R.from) { R.from = performance.now(); R.cut = R.frames.length; } R.arm = false; });
  const arm = () => p.evaluate(() => { window.__R.arm = true; });
  const result = async () => {
    await p.waitForFunction(() => window.__R.sharpAt !== null, null, { timeout: 15000, polling: 50 }).catch(() => undefined);
    await p.waitForTimeout(300);
    return p.evaluate(() => { const R = window.__R; R.on = false; const during = R.frames.slice(1, R.cut).map((f) => f[1]); const sorted = during.slice().sort((a, b) => a - b); const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0; return { sharp: R.sharpAt, frame: Math.max(0, ...during), p90, nf: during.length, band: R.band, px: R.px, blankAt: R.blankAt.slice(0, 6) }; });
  };
  const rows = [];
  const pinch = async (label, d0, d1, shot) => {
    const cx = 206, cy = 430; const z0 = await scaleNow(); await begin();
    await arm(); await T('touchStart', [[cx - d0 / 2, cy]]); await T('touchStart', [[cx - d0 / 2, cy], [cx + d0 / 2, cy]]);
    for (let i = 1; i <= 14; i++) { const d = d0 + ((d1 - d0) * i) / 14; await T('touchMove', [[cx - d / 2, cy], [cx + d / 2, cy]]); await p.waitForTimeout(16); }
    await p.evaluate(() => { const R = window.__R; R.from = performance.now(); R.cut = R.frames.length; R.arm = false; }); await T('touchEnd', []);
    if (shot) { await p.waitForTimeout(120); await p.screenshot({ path: path.join(SHOTS, shot) }); }
    const r = await result(); r.scale = await scaleNow(); r.z0 = z0; rows.push([label, r]); show(label, r); if (!(await settled())) console.log('  (not settled within 20 s)');
  };
  const button = async (label, aria) => {
    await begin(); await arm(); await p.evaluate((l) => document.querySelector(`.pdf-bar button[aria-label="${l}"]`).click(), aria); await mark();
    const r = await result(); r.scale = await scaleNow(); rows.push([label, r]); show(label, r); await settled();
  };
  const show = (l, r) => console.log(`${l.padEnd(28)} sharp ${r.sharp === null ? '> 15000' : r.sharp.toFixed(0).padStart(5)} ms · longest pinch frame ${r.frame.toFixed(0).padStart(4)} ms${r.nf ? ` (${r.nf} frames, 90% ≤ ${r.p90.toFixed(0)})` : ''} · band ${r.band.toFixed(0).padStart(3)} px${r.blankAt.length ? ` (at ${r.blankAt.join(', ')} ms)` : ''} · canvas ${(r.px / 1e6).toFixed(1)} MP · zoom ${r.z0 ? `${r.z0.toFixed(2)} → ` : ''}${r.scale.toFixed(2)}`);
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  // (The browser's own pace here, the page still: frames under the slowed processor with nothing to do.)
  await p.waitForFunction(() => !document.querySelector('.pdf-page.loading'), null, { timeout: 30000, polling: 100 }).catch(() => console.log('(pages near still loading)'));
  await begin(); await p.evaluate(() => { window.__R.quiet = true; });
  await p.waitForTimeout(1500);
  await mark(); const idle = await p.evaluate(() => { const R = window.__R; R.on = false; R.quiet = false; const f = R.frames.slice(1).map((x) => x[1]).sort((a, b) => a - b); return { max: f[f.length - 1], p90: f[Math.floor(f.length * 0.9)], n: f.length }; });
  console.log(`still page: ${idle.n} frames in 1.5 s, the longest ${idle.max.toFixed(0)} ms, 90% under ${idle.p90.toFixed(0)} ms`);
  await pinch('pinch in 1 → 2.5', 100, 250, SHOTS && 'R2-after-pinch.png');
  await pinch('pinch out 2.5 → 1.6', 250, 160);
  await pinch('pinch in 1.6 → 3.2', 120, 240);
  await pinch('pinch in deep → 4', 150, 220, SHOTS && 'R2-deep.png');
  await pinch('pinch out 4 → 2', 260, 130);
  await pinch('pinch out to the width', 260, 80);
  await button('button zoom in', 'Zoom in');
  await button('button zoom in again', 'Zoom in');
  await button('button zoom out', 'Zoom out');
  await button('button fit width', 'Fit width');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const pin = rows.filter(([l]) => l.startsWith('pinch')).map((r) => r[1]), all = rows.map((r) => r[1]);
  const worst = (k, a = all) => Math.max(...a.map((r) => (r[k] === null ? Infinity : r[k])));
  console.log(`worst: sharp after a pinch ${worst('sharp', pin).toFixed(0)} ms, after a button ${worst('sharp', all.slice(pin.length)).toFixed(0)} ms · pinch frame ${worst('frame', pin).toFixed(0)} ms · band ${worst('band').toFixed(0)} px · canvas ${(worst('px') / 1e6).toFixed(1)} MP`);
  // The browser's own floor for frames here: a bare page of five still canvases (as many pixels as the book's) scaled
  // every frame, nothing else — in a headless browser with no GPU each frame's commit copies the canvases, so frames
  // under the slowed processor are long whatever the page does. (A phone composites them on its GPU.)
  const cal = await (async () => {
    const q = await ctx.newPage(); await q.setContent('<div id=i style="will-change:transform;transform-origin:200px 400px"></div>');
    await q.evaluate(() => { const i = document.getElementById('i'); for (let k = 0; k < 5; k++) { const c = document.createElement('canvas'); c.width = 1071; c.height = 1515; c.style.cssText = 'display:block;width:412px;height:583px;margin-bottom:14px'; const g = c.getContext('2d', { alpha: false }); g.fillStyle = '#fff'; g.fillRect(0, 0, 1071, 1515); i.append(c); } });
    const qc = await ctx.newCDPSession(q); await qc.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    const r = await q.evaluate(() => new Promise((res) => { const i = document.getElementById('i'); const f = []; let last = performance.now(); const t0 = last; const tick = (t) => { f.push(t - last); last = t; i.style.transform = `scale(${1 + (t - t0) / 1000})`; if (t - t0 < 1200) requestAnimationFrame(tick); else { f.sort((a, b) => a - b); res({ max: f[f.length - 1], p90: f[Math.floor(f.length * 0.9)] }); } }; requestAnimationFrame(tick); }));
    await q.close(); return r;
  })();
  const p90 = Math.max(...pin.map((r) => r.p90));
  console.log(`frames' floor here (a bare page of still canvases, scaled): the longest ${cal.max.toFixed(0)} ms, 90% under ${cal.p90.toFixed(0)} ms; while pinching the book: 90% under ${p90.toFixed(0)} ms`);
  // The targets, printed (timings on a shared machine vary: they fail only under PERF=strict).
  const STRICT = process.env.PERF === 'strict';
  const t = (n, c) => (STRICT ? ok(n, c) : console.log((c ? 'ok   ' : 'MISS ') + 'target: ' + n));
  t('sharp screen ≤ 350 ms after each pinch ends (CPU ×4)', worst('sharp', pin) <= 350);
  t('sharp screen ≤ 350 ms after each button press, its 220 ms animation aside (CPU ×4)', worst('sharp', all.slice(pin.length)) <= 350 + 220);
  t('the longest frame while pinching ≤ 32 ms (CPU ×4)', worst('frame', pin) <= 32);
  // What must hold anywhere (before: 5 to 7.5 s to sharp, a band of 827 px, 23 MP of canvases).
  const must = REPORT ? t : ok;
  must('sharp screen within 1.5 s after each pinch and each button press (CPU ×4)', worst('sharp') <= 1500);
  must('pinching frames no slower than twice the browser\'s own floor here (90% of them)', p90 <= Math.max(34, 2 * cal.p90));
  must('no band of nothing drawn taller than a page gap (≤ 30 px) at any sampled frame', worst('band') <= 30);
  must('canvas pixels held stay under 16 MP', worst('px') < 16e6);
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
