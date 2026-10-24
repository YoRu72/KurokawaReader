// node tests/bookview/perf.cjs <book> [mode]: how a flowing book (EPUB, DOCX…) feels on a phone — a 412×900 screen
// at 2.75×, the processor slowed 4×: time to open, frames while scrolling a chapter, and going to the next chapter.
// mode: chapters (default) | flow | continuous.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const book = path.resolve(process.argv[2]); const mode = process.argv[3] || 'chapters';
(async () => {
  await new Promise((r) => server.listen(5202, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto('http://localhost:5202/');
  await page.evaluate((m) => { localStorage.setItem('kr.update.lastCheck', String(Date.now())); const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); v.readingMode = m; localStorage.setItem('kr.visual', JSON.stringify(v)); }, mode);
  await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [book]); await page.waitForSelector('.book-card', { timeout: 120000 });
  const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU || 4) });
  await page.evaluate(() => { const w = window; w.__frames = []; w.__long = 0; let last = performance.now(); const tick = (t) => { w.__frames.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long += e.duration; }).observe({ type: 'longtask' }); } catch { /* none */ } });
  const frames = () => page.evaluate(() => { const f = window.__frames; window.__frames = []; const long = window.__long; window.__long = 0; return { n: f.length, janky: f.filter((x) => x > 50).length, worst: Math.round(Math.max(0, ...f)), longTask: Math.round(long) }; });
  let t0 = Date.now(); await page.click('.book-card'); await page.waitForFunction(() => (document.querySelector('.reader-scroll .kr-content')?.textContent?.length ?? 0) > 200, null, { timeout: 120000, polling: 50 });
  console.log(`open: text shown ${Date.now() - t0} ms`);
  await page.waitForTimeout(2000); await frames();
  if (process.env.PROF) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
  await page.evaluate(() => new Promise((res) => { const sc = document.querySelector('.reader-scroll'); const t0 = performance.now(); let last = t0; const step = (t) => { sc.scrollTop += (t - last) * 1.2; last = t; if (t - t0 < 5000) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); }));
  const f = await frames();
  console.log(`scroll 5 s: ${f.n} frames, ${f.janky} over 50 ms, worst ${f.worst} ms, long tasks ${f.longTask} ms`);
  if (process.env.PROF) {
    const { profile } = await cdp.send('Profiler.stop'); const dt = {}; const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (let i = 0; i < profile.samples.length; i++) { const n = byId.get(profile.samples[i]); const k = `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber}`; dt[k] = (dt[k] || 0) + (profile.timeDeltas[i] || 0); }
    for (const [k, v] of Object.entries(dt).sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log((v / 1000).toFixed(0).padStart(7), 'ms', k);
  }
  // Next chapter (the right/left arrow key turns chapters in chapter mode).
  t0 = Date.now();
  const before = await page.evaluate(() => document.querySelector('.reader-scroll .kr-content')?.textContent?.slice(0, 80));
  await page.keyboard.press(process.env.KEY || 'PageDown');
  await page.waitForFunction((b) => document.querySelector('.reader-scroll .kr-content')?.textContent?.slice(0, 80) !== b, before, { timeout: 15000, polling: 50 }).catch(() => {});
  console.log(`next: ${Date.now() - t0} ms`);
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
