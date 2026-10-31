// node tests/pdfview/perf.cjs <file.pdf>: how the PDF viewer feels on a phone — a 412×900 screen at 2.75×, the
// processor slowed 4× — measured: first page shown, frames during a fling, how long pages stay blank after it,
// a jump far into the book, a zoom, and the pixels held in canvases (memory).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const pdf = path.resolve(process.argv[2]);
const CPU = Number(process.env.CPU || 4);
(async () => {
  await new Promise((r) => server.listen(5201, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto('http://localhost:5201/'); await page.evaluate(() => { localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [pdf]); await page.waitForSelector('.book-card', { timeout: 120000 });
  const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  // Frame and long-task recorders.
  await page.evaluate(() => {
    const w = window; w.__frames = []; w.__long = 0; let last = performance.now();
    const tick = (t) => { w.__frames.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long += e.duration; }).observe({ type: 'longtask', buffered: false }); } catch { /* none */ }
    // A page is "shown" when its picture is in (a canvas or an image), and "sharp" when it is drawn at full resolution.
    w.__state = () => {
      const sc = document.querySelector('.pdf-scroll'); if (!sc) return null; const r = sc.getBoundingClientRect();
      const pages = [...document.querySelectorAll('.pdf-page')].filter((p) => { const b = p.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; });
      const shown = pages.filter((p) => p.querySelector('canvas, img.native-page')).length;
      const sharp = pages.filter((p) => p.dataset.res ? p.dataset.res === 'full' : !!p.querySelector('canvas, img.native-page')).length;
      let px = 0; for (const c of document.querySelectorAll('.pdf-page canvas')) px += c.width * c.height;
      return { visible: pages.length, shown, sharp, px, canvases: document.querySelectorAll('.pdf-page canvas').length };
    };
  });
  const waitFor = async (what, timeout = 120000) => { const t0 = Date.now(); await page.waitForFunction((k) => { const s = window.__state(); return s && s.visible > 0 && s[k] >= s.visible; }, what, { timeout, polling: 50 }).catch(() => {}); return Date.now() - t0; };
  const frames = async () => page.evaluate(() => { const f = window.__frames; window.__frames = []; const long = window.__long; window.__long = 0; const bad = f.filter((x) => x > 50).length; return { n: f.length, janky: bad, worst: Math.round(Math.max(0, ...f)), longTask: Math.round(long) }; });

  let t0 = Date.now(); await page.click('.book-card'); await page.waitForSelector('.pdf-page', { timeout: 120000 });
  const firstShown = await waitFor('shown') + (Date.now() - t0 - 0); const firstSharp = await waitFor('sharp');
  console.log(`open: first page shown ${firstShown} ms, sharp +${firstSharp} ms`);
  await page.waitForTimeout(1500); await frames();
  // A fling: 4 s at ~2500 px/s.
  if (process.env.PROF) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
  await page.evaluate(() => new Promise((res) => { const sc = document.querySelector('.pdf-scroll'); const t0 = performance.now(); let last = t0; const step = (t) => { sc.scrollTop += (t - last) * 2.5; last = t; if (t - t0 < 4000) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); }));
  const fl = await frames();
  if (process.env.PROF) {
    const { profile } = await cdp.send('Profiler.stop'); const dt = {}; const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (let i = 0; i < profile.samples.length; i++) { const n = byId.get(profile.samples[i]); const k = `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber}`; dt[k] = (dt[k] || 0) + (profile.timeDeltas[i] || 0); }
    for (const [k, v] of Object.entries(dt).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log((v / 1000).toFixed(0).padStart(7), 'ms', k);
  }
  const st0 = await page.evaluate(() => window.__state());
  t0 = Date.now(); const afterShown = await waitFor('shown'); const afterSharp = await waitFor('sharp');
  console.log(`fling: ${fl.n} frames, ${fl.janky} over 50 ms, worst ${fl.worst} ms, long tasks ${fl.longTask} ms | at stop ${st0.shown}/${st0.visible} shown → all shown ${afterShown} ms, sharp ${afterSharp} ms`);
  // Slow reading scroll: 6 s at 300 px/s.
  await page.waitForTimeout(800); await frames();
  await page.evaluate(() => new Promise((res) => { const sc = document.querySelector('.pdf-scroll'); const t0 = performance.now(); let last = t0; const step = (t) => { sc.scrollTop += (t - last) * 0.3; last = t; if (t - t0 < 6000) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); }));
  const rd = await frames(); const st1 = await page.evaluate(() => window.__state());
  console.log(`reading scroll: ${rd.n} frames, ${rd.janky} over 50 ms, worst ${rd.worst} ms, long tasks ${rd.longTask} ms | at stop ${st1.shown}/${st1.visible} shown`);
  // Jump far.
  const total = await page.evaluate(() => document.querySelectorAll('.pdf-page').length);
  t0 = Date.now(); await page.evaluate((n) => { const el = document.querySelectorAll('.pdf-page')[n]; document.querySelector('.pdf-scroll').scrollTop = el.offsetTop; }, Math.floor(total * 0.7));
  const jShown = await waitFor('shown'); const jSharp = await waitFor('sharp');
  console.log(`jump to page ${Math.floor(total * 0.7) + 1}: shown ${jShown} ms, sharp +${jSharp} ms`);
  // Zoom in (as the + button does), then wait for it to be sharp again.
  await page.waitForTimeout(800); await frames();
  t0 = Date.now();
  await page.evaluate(() => { const v = window.__krPdfViewer; if (v) { v.zoom(1.5); } });
  const zShown = await waitFor('shown'); const zSharp = await waitFor('sharp'); const zf = await frames();
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace('.png', '-zoom.png') });
  if (process.env.DBG) console.log(await page.evaluate(() => { const v = window.__krPdfViewer; const sc = document.querySelector('.pdf-scroll'); const r = sc.getBoundingClientRect(); return [...document.querySelectorAll('.pdf-page')].filter((p) => { const b = p.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; }).map((p) => { const n = +p.dataset.page; const s = v.shown.get(n); return { n, res: p.dataset.res, level: s?.level, at: s?.at, scale: v.scale, tiles: s?.tiles?.size, busy: v.busy, scrolling: v.scrolling, first: v.first, last: v.last }; }); }));
  const st2 = await page.evaluate(() => window.__state());
  console.log(`zoom ×2.5: shown ${zShown} ms, sharp +${zSharp} ms, worst frame ${zf.worst} ms | canvases ${st2.canvases}, ${(st2.px / 1e6).toFixed(1)} Mpx held`);
  // Pan around zoomed.
  await page.evaluate(() => new Promise((res) => { const sc = document.querySelector('.pdf-scroll'); const t0 = performance.now(); let last = t0; const step = (t) => { sc.scrollTop += (t - last) * 0.8; sc.scrollLeft += (t - last) * 0.2; last = t; if (t - t0 < 3000) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); }));
  const pz = await frames(); const st3 = await page.evaluate(() => window.__state());
  const pzSharp = await waitFor('sharp');
  console.log(`zoomed pan: ${pz.n} frames, ${pz.janky} over 50 ms, worst ${pz.worst} ms, long tasks ${pz.longTask} ms | ${(st3.px / 1e6).toFixed(1)} Mpx held, sharp after ${pzSharp} ms`);
  // Two-finger pinch out (on by default): the page grows under the fingers, then is drawn sharp.
  await page.evaluate(() => window.__krPdfViewer.fitToWidth()); await page.waitForTimeout(1200);
  const before = await page.evaluate(() => window.__krPdfViewer.scale);
  const tp = (pts) => pts.map(([x, y], i) => ({ x, y, id: i + 1 }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp([[180, 450], [230, 450]]) });
  for (let k = 1; k <= 8; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp([[180 - k * 12, 450], [230 + k * 12, 450]]) }); await page.waitForTimeout(30); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const pSharp = await waitFor('sharp', 30000);
  console.log(`pinch: scale ${before.toFixed(2)} → ${(await page.evaluate(() => window.__krPdfViewer.scale)).toFixed(2)}, sharp after ${pSharp} ms`);
  const mem = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1));
  console.log(`JS heap ${mem} MB`);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
