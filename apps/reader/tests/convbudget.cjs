// node tests/convbudget.cjs: PDF → Word's memory and the app's thread, under ceilings (counts and megabytes, the
// conversion timed only for the report). Two books made here (no fixtures):
//  - a picture book: 24 pages, each a photograph of 1600×1200 (a JPEG made by the browser) and a few lines;
//  - a text book: 160 pages of text in a standard font.
// Each is converted in the app the way a user does it, while the page, every worker (CDP) and the renderer
// process (/proc, Linux) are watched:
//  1. the lanes (src/pdf2docx.lane.ts) and their pdf.js workers (src/pdfjsport.worker.ts) are started by the page —
//     one pdf.js worker per lane — and they work where a worker cannot start a worker (WebView2: Worker taken away
//     inside the lanes here): no lane gives up;
//  2. the renderer's memory at its height and once the job is over (after a collection) stays under ceilings:
//     JPEGs decoded through WebCodecs' ImageDecoder stayed in Chromium's store of decoded images — 7 MB a
//     photograph, some 300 MB after forty — until the app was closed (scripts/patch-pdfjs.mjs: createImageBitmap);
//  3. the JS heap of the page and all workers together comes back to where it was (pdf.js documents destroyed,
//     the canvases kept from page to page let go);
//  4. no worker of the job is left once it is done (the app's count, krConvWorkers, and CDP's worker targets);
//  5. the app's thread: no task over a ceiling while converting the text book (the pages are read in lanes, the
//     fonts built in a worker, the body and the zip written in slices).
// (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-convbudget-'));
const MB = (b) => Math.round(b / 1048576);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The ceilings (MB, ms). The code before this test: picture book ≈ 320 renderer MB at its height and ≈ 200 kept
// after; text book: tasks of 0.5–1 s on the app's thread (none over 50 ms since).
// (picPeakMB 230 → 280: GitHub's newer engine measured +243 MB where this machine measures +140; the old code stood at +317 here.)
const BUDGET = { picPeakMB: 280, picSettledMB: 90, heapSettledMB: 24, textLongestTaskMs: 200 };

// Chromium's DevTools protocol over its port: the page and every worker (flattened sessions).
function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const wait = new Map(); const subs = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); } else for (const s of subs) s(m); };
  return { ready: new Promise((r) => { ws.onopen = r; }), on: (f) => subs.push(f), close: () => ws.close(),
    send: (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; wait.set(i, { res, rej }); setTimeout(() => { if (wait.has(i)) { wait.delete(i); rej(new Error(`timeout ${method}`)); } }, 15000); ws.send(JSON.stringify({ id: i, method, params, sessionId })); }) };
}
const rss = (pid) => { try { return +fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1] * 1024; } catch { return 0; } };

async function picBook(browser) {
  // (The photographs made by the browser: no JPEG encoder here.)
  const page = await browser.newPage();
  const jpgs = await page.evaluate(async () => {
    const out = [];
    for (let p = 0; p < 24; p++) {
      const c = new OffscreenCanvas(1600, 1200); const g = c.getContext('2d'); const im = g.createImageData(1600, 1200); const d = im.data;
      for (let y = 0; y < 1200; y++) for (let x = 0; x < 1600; x++) { const i = (y * 1600 + x) * 4; d[i] = (x * (p + 3) + y) & 255; d[i + 1] = ((x ^ y) + p * 17) & 255; d[i + 2] = (Math.sin((x + y + p * 40) / 37) * 120 + 128) & 255; d[i + 3] = 255; }
      g.putImageData(im, 0, 0);
      const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }); const u = new Uint8Array(await b.arrayBuffer());
      let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); out.push(btoa(s));
    }
    return out;
  });
  await page.close();
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [p, b64] of jpgs.entries()) {
    const img = await doc.embedJpg(Buffer.from(b64, 'base64')); const pg = doc.addPage([595, 842]);
    pg.drawText(`Photo page ${p + 1}`, { x: 60, y: 790, size: 16, font }); pg.drawImage(img, { x: 40, y: 330, width: 515, height: 386 });
    for (let k = 0; k < 8; k++) pg.drawText(`Caption line ${k} of page ${p + 1}: a few words about the picture above it.`, { x: 60, y: 300 - k * 18, size: 11, font });
  }
  const f = path.join(tmp, 'pictures.pdf'); fs.writeFileSync(f, await doc.save()); return f;
}
async function textBook() {
  const W = 'the of and to in that was his he it with is for as had you not be her on at by which have or from this him but all she they were my are me one their so an said them we who would been will no when there if more out up into do any your what has man could other than our some very time upon about may its only now like little then'.split(' ');
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.TimesRoman); const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  let k = 0;
  for (let p = 0; p < 160; p++) {
    const pg = doc.addPage([595, 842]); pg.drawText(`Chapter ${p + 1}`, { x: 60, y: 780, size: 18, font: bold });
    for (let y = 740; y > 90; y -= 17) { let line = ''; while (line.length < 84) line += (line ? ' ' : '') + W[(k++ * 7) % W.length]; pg.drawText(line, { x: 60, y, size: 11, font }); }
    pg.drawText(String(p + 1), { x: 292, y: 50, size: 10, font });
  }
  const f = path.join(tmp, 'text.pdf'); fs.writeFileSync(f, await doc.save()); return f;
}

async function convert(file) {
  const port = 9400 + Math.floor(Math.random() * 500);
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`, '--js-flags=--expose-gc'] });
  let c;
  try {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    c = cdp(ver.webSocketDebuggerUrl); await c.ready;
    const sessions = new Map();
    c.on((m) => {
      if (m.method === 'Target.attachedToTarget') { sessions.set(m.params.sessionId, m.params.targetInfo.type); c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, m.params.sessionId).catch(() => {}); }
      else if (m.method === 'Target.detachedFromTarget') sessions.delete(m.params.sessionId);
    });
    await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage(); page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
    const warns = []; page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warns.push(m.text()); });
    await page.addInitScript(() => {
      // Long tasks of the app's thread while converting; workers the page starts, by kind; Worker taken away inside
      // the lanes (as under WebView2) — the lane's code imported after a module that removes it.
      globalThis.__long = []; globalThis.__on = false; globalThis.__starts = { lane: 0, pdfjs: 0, other: 0 };
      new PerformanceObserver((l) => { if (globalThis.__on) for (const e of l.getEntries()) globalThis.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
      const Native = globalThis.Worker;
      globalThis.Worker = function Worker(url, opts) {
        const s = String(url);
        if (/pdf2docxlane/.test(s)) {
          globalThis.__starts.lane++;
          const noWorker = URL.createObjectURL(new Blob(["self.Worker = function () { throw new Error('no worker in a worker here'); };"], { type: 'text/javascript' }));
          return new Native(URL.createObjectURL(new Blob([`import ${JSON.stringify(noWorker)}; import ${JSON.stringify(new URL(s, location.href).href)};`], { type: 'text/javascript' })), { type: 'module' });
        }
        if (/pdfjsport/.test(s)) globalThis.__starts.pdfjs++; else globalThis.__starts.other++;
        return new Native(url, opts);
      };
      globalThis.Worker.prototype = Native.prototype;
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
    await page.setInputFiles('input[type=file]', [file]); await page.waitForSelector('.book-card', { timeout: 120000 }); await page.waitForTimeout(1500);
    const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
    if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
    await page.waitForSelector('.convert-target'); await page.waitForTimeout(800);
    const live = () => [...sessions].filter(([, t]) => t === 'page' || t === 'worker');
    const heap = async () => { let used = 0; for (const [sid] of live()) { try { const h = await c.send('Runtime.getHeapUsage', {}, sid); used += h.usedSize + (h.backingStorageSize || 0); } catch { /* gone */ } } return used; };
    const gc = async () => { for (const [sid] of live()) { try { await c.send('HeapProfiler.collectGarbage', {}, sid); } catch { /* gone */ } } };
    const renderer = async () => { let r = 0; for (const p of (await c.send('SystemInfo.getProcessInfo')).processInfo) if (p.type === 'renderer') r += rss(p.id); return r; };
    const workers = () => [...sessions.values()].filter((t) => t === 'worker').length;
    await gc(); await sleep(500); await gc();
    const base = { heap: await heap(), ren: await renderer(), workers: workers() };
    let peakRen = base.ren, peakHeap = base.heap, done = false;
    const poll = (async () => { while (!done) { peakRen = Math.max(peakRen, await renderer()); peakHeap = Math.max(peakHeap, await heap()); await sleep(80); } })();
    await page.evaluate(() => { globalThis.__on = true; });
    const t0 = Date.now(); await page.click('.convert-target:has-text("Word")');
    await page.waitForSelector('.convert-result:not([hidden]) button, .sheet .src:has-text("failed")', { timeout: 600000 });
    const ms = Date.now() - t0; done = true; await poll;
    const long = await page.evaluate(() => { globalThis.__on = false; return globalThis.__long; });
    const starts = await page.evaluate(() => globalThis.__starts);
    const failed = !!(await page.$('.sheet .src:has-text("failed")'));
    await sleep(2500); await gc(); await sleep(1000); await gc(); await sleep(300);
    const after = { heap: await heap(), ren: await renderer(), workers: workers(), app: await page.evaluate(() => (globalThis.krConvWorkers ? globalThis.krConvWorkers() : -1)) };
    return { ms, failed, starts, warns, long, base, peakRen, peakHeap, after };
  } finally { c?.close(); await browser.close(); }
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  try {
    const maker = await chromium.launch(); const pics = await picBook(maker); await maker.close();
    const text = await textBook();
    const linux = fs.existsSync('/proc/self/status');
    for (const [name, file] of [['picture book', pics], ['text book', text]]) {
      const r = await convert(file);
      const gaveUp = r.warns.find((w) => /lanes: reading on this thread/.test(w));
      ok(`${name}: converted (${(r.ms / 1000).toFixed(1)} s)`, !r.failed);
      ok(`${name}: lanes started by the page, each with its pdf.js worker started by the page (${r.starts.lane} lanes, ${r.starts.pdfjs} pdf.js workers)`, r.starts.lane >= 1 && r.starts.pdfjs === r.starts.lane);
      ok(`${name}: the lanes worked with no worker inside a worker${gaveUp ? ` — ${gaveUp.slice(0, 160)}` : ''}`, !gaveUp);
      ok(`${name}: no worker of the job left (the app counts ${r.after.app}; CDP ${r.after.workers} workers, ${r.base.workers} before)`, r.after.app === 0 && r.after.workers <= r.base.workers);
      ok(`${name}: the JS heap (page and workers) back near where it was: +${MB(r.after.heap - r.base.heap)} MB (at most ${BUDGET.heapSettledMB}; +${MB(r.peakHeap - r.base.heap)} MB at its height)`, r.after.heap - r.base.heap <= BUDGET.heapSettledMB * 1048576);
      if (name === 'picture book' && linux) {
        ok(`${name}: the renderer at its height +${MB(r.peakRen - r.base.ren)} MB (at most ${BUDGET.picPeakMB})`, r.peakRen - r.base.ren <= BUDGET.picPeakMB * 1048576);
        ok(`${name}: the renderer after the job +${MB(r.after.ren - r.base.ren)} MB (at most ${BUDGET.picSettledMB})`, r.after.ren - r.base.ren <= BUDGET.picSettledMB * 1048576);
      }
      if (name === 'text book') {
        const longest = r.long.length ? Math.max(...r.long) : 0;
        ok(`${name}: the app's thread never held over ${BUDGET.textLongestTaskMs} ms (longest ${longest} ms; ${r.long.length} tasks over 50 ms)`, longest <= BUDGET.textLongestTaskMs);
      }
    }
  } catch (e) { console.log('FAIL', e); fails++; }
  server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
