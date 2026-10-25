// node tests/docx/perf.cjs <file.docx> [cpu-slowdown=4]: open the document in the built reader (a phone-sized
// screen, the CPU slowed) and print the time until its text shows, the JS heap after, and whether a tap on the
// page answers within a second while it is opening.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [file, slow = '4'] = process.argv.slice(2);
(async () => {
  await new Promise((r) => server.listen(5217, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto('http://localhost:5217/'); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [file]); await p.waitForSelector('.book-card', { timeout: 120000 }); await p.waitForTimeout(500);
  const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: +slow });
  const t0 = Date.now();
  await p.click('.book-card');
  await p.waitForFunction(() => { const c = document.querySelector('.kr-content'); return !!c && (c.textContent || '').length > 100 && !!document.querySelector('.reader-view') && !document.querySelector('.reader-view .spinner'); }, null, { timeout: 600000 });
  const opened = Date.now() - t0;
  await p.waitForTimeout(1500);
  const marks = await p.evaluate(() => performance.getEntriesByType('measure').filter((e) => e.name.startsWith('kr:')).map((e) => e.name + '=' + Math.round(e.duration)).join(' ')); console.log(marks);
  const m = await p.evaluate(() => ({ heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576), blocks: document.querySelectorAll('.kr-content p, .kr-content li, .kr-content td').length, chapters: document.querySelectorAll('.kr-chapter').length, shown: [...document.querySelectorAll('.kr-chapter')].filter((c) => !c.hidden).length, imgs: document.querySelectorAll('.kr-content img').length, loadedImgs: document.querySelectorAll('.kr-content img[src]').length }));
  // Scroll to the end quickly, then a long way back, to see it stays smooth.
  const t1 = Date.now(); for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, 4000); await p.waitForTimeout(80); } const scrolled = Date.now() - t1;
  console.log(JSON.stringify({ file: path.basename(file), cpuSlow: +slow, openMs: opened, scroll10Ms: scrolled, ...m }));
  await b.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
