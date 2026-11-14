// node tests/glassperf.cjs: what an interface style costs while reading, measured on an imitated phone (360×804 at 3×,
// touch) with the CPU slowed (KR_CPU, default 6×): a long EPUB scrolled (60 steps of 37 px, 120 ms apart) and a PDF
// scrolled the same way, with the bars hidden (how a book is read) and with them shown, under Classic, a glass style
// with its blur Off, and the same with it Full. Printed: long tasks (count, total ms), frames (median and 95th
// percentile ms between animation frames, frames over 50 ms). Checked — as counts, not times, so a slower machine does
// not fail it —: with the bars hidden no element has a backdrop filter under any style, and no style adds a long task
// to Classic's beyond one (scheduling noise).
// The books are made here.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const ROOT = path.resolve(__dirname, '..'); const CPU = Number(process.env.KR_CPU || 6);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-glassperf-'));

async function makeEpub(file) {
  const JSZip = require(path.join(ROOT, 'node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items = [], spine = [], nav = [];
  for (let c = 1; c <= 40; c++) {
    z.file(`OEBPS/c${c}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>C${c}</title></head><body><h1>Chapter ${c}</h1>${Array.from({ length: 60 }, (_, p) => `<p>[C${c}-P${p}] ${'The river ran past the old city and the people in their houses read their books and talked of the sea. '.repeat(3)}</p>`).join('')}</body></html>`);
    items.push(`<item id="c${c}" href="c${c}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${c}"/>`); nav.push(`<li><a href="c${c}.xhtml">Chapter ${c}</a></li>`);
  }
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>${nav.join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">glassperf</dc:identifier><dc:title>Long Book</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
async function makePdf(file) {
  const { PDFDocument, StandardFonts } = require(path.join(ROOT, 'node_modules/pdf-lib'));
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 60; i++) { const pg = d.addPage([432, 648]); for (let l = 0; l < 30; l++) pg.drawText(`Page ${i} line ${l}: the quick brown fox jumps over the lazy dog.`, { x: 36, y: 610 - l * 19, size: 10, font }); }
  fs.writeFileSync(file, await d.save());
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const epub = path.join(TMP, 'long.epub'); await makeEpub(epub); const pdf = path.join(TMP, 'long.pdf'); await makePdf(pdf);
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 360, height: 804 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en' });
  await ctx.addInitScript(() => {
    globalThis.krDeviceMemory = 8;
    window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask' }); } catch { /* none */ }
    if (sessionStorage.getItem('kr.t')) return; sessionStorage.setItem('kr.t', '1');
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now()));
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base); await p.waitForSelector('.library-view');
  const ids = {};
  for (const [k, f] of [['epub', epub], ['pdf', pdf]]) {
    const n0 = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.length); }; }));
    await p.setInputFiles('.library-view input[type=file]', [f]);
    for (let i = 0; i < 200 && !ids[k]; i++) { ids[k] = await p.evaluate((n) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.length > n ? q.result.sort((a, b) => b.addedAt - a.addedAt)[0].id : null); }; }), n0); if (!ids[k]) { await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); await p.waitForTimeout(250); } }
    if (!ids[k]) throw new Error('not imported: ' + k);
  }
  const cdp = await ctx.newCDPSession(p);
  const run = async (book, style, blur, bars) => {
    await p.evaluate(([s, b]) => { localStorage.setItem('kr.visual', JSON.stringify({ ...JSON.parse(localStorage.getItem('kr.visual') || '{}'), uiStyle: s, glassBlur: b })); location.hash = '#/'; }, [style, blur]);
    await p.reload(); await p.waitForSelector('.library-view');
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, ids[book]);
    await p.waitForSelector(book === 'pdf' ? '.pdf-page canvas, .pdf-page img' : '.reader-flow .kr-content p', { timeout: 60000, state: 'attached' }); await p.waitForTimeout(1500);
    await p.evaluate((bars) => document.querySelector('.reader-view').classList.toggle('immersive', !bars), bars); await p.waitForTimeout(600);
    const filters = await p.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.getClientRects().length && (getComputedStyle(e).backdropFilter || 'none') !== 'none').length);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    await p.evaluate(() => { window.__long = []; window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (!window.__stop) requestAnimationFrame(tick); }; window.__stop = false; requestAnimationFrame(tick); });
    const sel = book === 'pdf' ? '.pdf-scroll' : '.reader-scroll';
    for (let i = 0; i < 60; i++) { await p.evaluate(([sel]) => { const sc = document.querySelector(sel); sc.scrollTop += 37; }, [sel]); await p.waitForTimeout(120); }
    await p.waitForTimeout(800);
    const m = await p.evaluate(() => { window.__stop = true; const f = window.__frames.slice(2).sort((a, b) => a - b); const q = (x) => f[Math.min(f.length - 1, Math.floor(f.length * x))]; return { long: window.__long.length, longMs: Math.round(window.__long.reduce((a, b) => a + b, 0)), p50: Math.round(q(0.5) * 10) / 10, p95: Math.round(q(0.95) * 10) / 10, over50: f.filter((x) => x > 50).length, frames: f.length }; });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    return { ...m, filters };
  };
  const rows = [];
  for (const book of ['epub', 'pdf']) for (const bars of [false, true]) {
    const r = {};
    for (const [name, style, blur] of (process.env.KR_REVERSE ? [['Full', 'midnight-stacks', 'full'], ['Off', 'midnight-stacks', 'off'], ['Classic', 'classic', 'auto']] : [['Classic', 'classic', 'auto'], ['Off', 'midnight-stacks', 'off'], ['Full', 'midnight-stacks', 'full']])) { r[name] = await run(book, style, blur, bars); rows.push({ book, bars: bars ? 'shown' : 'hidden', style: name, ...r[name] }); }
    if (!bars) {
      ok(`${book}, bars hidden: no backdrop filter under any style`, r.Off.filters === 0 && r.Full.filters === 0, { Off: r.Off.filters, Full: r.Full.filters });
      ok(`${book}, bars hidden: no long task more than Classic's (beyond one) with blur Off or Full`, r.Off.long <= r.Classic.long + 1 && r.Full.long <= r.Classic.long + 1, { Classic: r.Classic.long, Off: r.Off.long, Full: r.Full.long });
    }
  }
  console.log(`\nCPU slowed ${CPU}×, 360×804 @3, 60 scroll steps of 37 px`);
  console.log('book  bars    style    longTasks  longMs  frame p50  p95  >50ms  frames  backdrop-filters');
  for (const r of rows) console.log(`${r.book.padEnd(5)} ${r.bars.padEnd(7)} ${r.style.padEnd(8)} ${String(r.long).padStart(9)} ${String(r.longMs).padStart(7)} ${String(r.p50).padStart(10)} ${String(r.p95).padStart(5)} ${String(r.over50).padStart(6)} ${String(r.frames).padStart(7)} ${String(r.filters).padStart(17)}`);
  ok('no page errors', !errors.length, errors);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
