// node tests/epubcrash.cjs: an end of the app while an EPUB is read explains itself at the next start (src/diag.ts,
// ui/perfsheet.ts; the Android side: MainActivity's renderer-gone listener and onTrimMemory, KurokawaPlugin.takeCrashInfo),
// on an imitated phone (412×915, touch, Android imitated through window.Capacitor):
//  1. reading: memory samples (JS heap, elements, chapters made, pictures loaded) are kept with the session; an error
//     nothing caught and a promise rejected with no one to hear are kept by name only (never their message);
//     the system's memory warning (`kr:trim`) is kept as an event;
//  2. the app ended under the open book (storage as it was, no unload) and started again: the native app's word
//     (takeCrashInfo) tells the end apart — the renderer killed (its priority, the app on screen, the memory warning
//     just before, the last record's age), the renderer crashed, the app not responding (ANR, from the system's exit
//     record), the app killed for memory —, on the session, in the events, in the report and on the page;
//     with no word from the native app, a task of 5 s in the session's last minute marks it "ANR suspected";
//  3. the report holds no title, file name or text (an error's message included);
//  4. pictures far from the place read are let go (their decoded memory with them) and come back when near — the
//     place read does not move — (src/formats/shared.ts UrlPool);
//  5. reported, not required (NOTE lines — the engine decides when it lets go; see tests/perfbudget.cjs): elements
//     kept after a big EPUB is opened and closed three times in each reading mode, and the memory's shape while it is
//     read through in continuous mode.
// (The books are made here: no fixtures. Elements waited for are visible ones.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os'); const zlib = require('zlib');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 900))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epubcrash-'));
const TITLE = 'Velvet Harbour Secret'; const SECRET = 'plumtree-whisper';

// ---- books made here
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
/** A picture (PNG) of w×h, its own colours. */
function png(seed, w = 600, h = 600) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = ((x >> 5) * 37 + seed * 7) & 255; raw[o + 1] = ((y >> 5) * 53 + seed * 13) & 255; raw[o + 2] = (((x >> 5) ^ (y >> 5)) * 29 + seed) & 255; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const EN = 'The river ran past the old city and the people read their books. ';
async function makeEpub(file, { title, chapters, paras = 30, pictureEvery = 0 }) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items = [], spine = [], nav = []; let pics = 0;
  for (let c = 1; c <= chapters; c++) {
    let body = Array.from({ length: paras }, (_, p) => `<p>[C${c}-P${p}] ${EN.repeat(3)}</p>`);
    if (pictureEvery && c % pictureEvery === 0) { pics++; z.file(`OEBPS/i${pics}.png`, png(pics), { compression: 'STORE' }); items.push(`<item id="i${pics}" href="i${pics}.png" media-type="image/png"/>`); body.splice(paras >> 1, 0, `<p class="pic"><img src="i${pics}.png" alt=""/></p>`); }
    z.file(`OEBPS/c${c}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>C${c}</title></head><body><h1>Chapter ${c}</h1>${body.join('')}</body></html>`);
    items.push(`<item id="c${c}" href="c${c}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${c}"/>`); nav.push(`<li><a href="c${c}.xhtml">Chapter ${c}</a></li>`);
  }
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${nav.join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${title.replace(/\W/g, '')}</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// (Android imitated: the app's listeners kept; the native app's word at the start is what the test puts in
// window.__crashInfo — taken once, as the plugin hands it over.)
const CAP = (info) => {
  window.__cap = {}; window.__crashTaken = 0;
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    App: { addListener: (ev, fn) => { window.__cap[ev] = fn; return Promise.resolve({ remove() {} }); }, getLaunchUrl: async () => null, minimizeApp: async () => undefined },
    Kurokawa: { takeCrashInfo: async () => { window.__crashTaken++; const v = sessionStorage.getItem('kr.test.crashTaken') ? { gone: [], exits: [] } : (info ?? { gone: [], exits: [] }); sessionStorage.setItem('kr.test.crashTaken', '1'); return v; } } } };
};
const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const visible = (p, sel, timeout = 60000) => p.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; }), sel, { timeout, polling: 200 });
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await visible(p, '.library-view'); await p.waitForTimeout(500);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 400; i++) {
    const b = (await allBooks(p)).find((x) => new RegExp(re, 'i').test(x.title)); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file);
}

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const SMALL = path.join(TMP, 'velvet-harbour-private.epub'); await makeEpub(SMALL, { title: TITLE, chapters: 12, pictureEvery: 4 });
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en' });
  const page = async (info, kept) => {
    const p = await ctx.newPage(); p.on('pageerror', (e) => { if (!e.message.includes(SECRET)) errors.push(e.message); });
    await p.addInitScript(CAP, info ?? null);
    await p.addInitScript(() => { window.__clip = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (x) => { window.__clip = x; }, readText: async () => window.__clip }, configurable: true }); });
    if (kept) await p.addInitScript((v) => { if (!sessionStorage.getItem('kr.test.started')) { sessionStorage.setItem('kr.test.started', '1'); localStorage.setItem('kr.diag', v.diag); if (v.reading) localStorage.setItem('kr.reading', v.reading); else localStorage.removeItem('kr.reading'); } }, kept);
    return p;
  };
  const data = (p) => p.evaluate(() => window.__krDiag.data());
  /** The app ended by the system under what is on show: storage as it was, the page closed without its unload seen. */
  const kill = async (p) => { const kept = await p.evaluate(() => { window.__krDiag.flush(); return { diag: localStorage.getItem('kr.diag'), reading: localStorage.getItem('kr.reading') }; }); const at = JSON.parse(kept.diag).s.slice(-1)[0].at; await p.close({ runBeforeUnload: true }); return { kept, at }; };

  // ---- 1. Reading: memory samples, errors by name, a memory warning.
  let p = await page();
  await p.goto(base); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await visible(p, '.library-view');
  const bk = await importFile(p, SMALL, 'Velvet Harbour');
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id); await visible(p, '.reader-flow .kr-content p'); await p.waitForTimeout(1500);
  const row = await p.evaluate(() => window.__krDiag.sample());
  ok('a memory sample while reading: [s, heap MB, elements (k), chapters made, pictures loaded]', Array.isArray(row) && row.length === 5 && row[0] >= 0 && (row[1] === -1 || row[1] > 0) && row[2] > 0.1 && row[3] >= 3, row);
  await p.evaluate((s) => { setTimeout(() => { throw new TypeError(`${s} broke`); }, 0); void Promise.reject(new RangeError(`${s} rejected`)); document.dispatchEvent(new CustomEvent('kr:trim', { detail: 40 })); }, SECRET);
  await p.waitForTimeout(800);
  let d = await data(p); let s = d.sessions[d.sessions.length - 1];
  ok('an error nothing caught, and a rejection no one heard, kept by name only', s.errs && s.errs.TypeError === 1 && s.errs['rejected RangeError'] === 1 && !JSON.stringify(d).includes(SECRET), s.errs);
  ok('… each once in the events (jserr)', d.events.filter((e) => e.k === 'jserr').map((e) => e.name).sort().join() === 'TypeError,rejected RangeError', d.events.filter((e) => e.k === 'jserr'));
  ok('the system\'s memory warning (kr:trim) kept with its level and the book open', d.events.some((e) => e.k === 'trim' && e.level === 40 && e.book === true), d.events.filter((e) => e.k === 'trim'));
  ok('the native app was asked once for its word at the start', (await p.evaluate(() => window.__crashTaken)) === 1);

  // ---- 2. Ended under the book; the native app says the renderer was killed.
  let k = await kill(p);
  let goneAt = Date.now() + 2000;  // (after the last record: the renderer ended 2 s after it)
  await new Promise((r) => setTimeout(r, 2200));
  p = await page({ gone: [{ at: goneAt, crashed: false, prio: 0, fg: true, trim: 40, trimAgo: 3000 }], exits: [], trim: 40, trimAt: goneAt - 3000, sdk: 37 }, k.kept);
  await p.goto(base); await visible(p, '.library-view, .reader-view'); await p.waitForTimeout(3000);
  d = await data(p); let prev = d.sessions.find((x) => x.at === k.at);
  ok('renderer killed: the session is told apart (why, priority, on screen, the warning before, the last record\'s age)', prev && prev.end === 'unexpected' && prev.why === 'renderer-killed' && /killed/.test(prev.det) && /priority waived/.test(prev.det) && /app on screen/.test(prev.det) && /memory warning 40/.test(prev.det) && /last record \d+ s before/.test(prev.det), prev && { end: prev.end, why: prev.why, det: prev.det });
  ok('… a "gone" event with how, priority and the quiet before it', d.events.some((e) => e.k === 'gone' && e.how === 'renderer killed' && e.prio === 'waived' && e.quiet >= 1), d.events.filter((e) => e.k === 'gone'));
  ok('… and the session kept its memory samples', Array.isArray(prev?.ms) && prev.ms.length >= 1, prev?.ms);
  ok('the book was opened again (src/resume.ts) after the renderer\'s end', await p.evaluate(() => /^#\/read\//.test(location.hash)));
  // (The report as the page makes it: Settings → About → Performance, "Copy report".)
  const copyReport = async (pg) => {
    await pg.evaluate(() => { location.hash = '#/settings'; }); await visible(pg, '.settings-view .card-title');
    await pg.evaluate(() => { const b = document.querySelector('.perf-entry button'); b.closest('.card').classList.remove('collapsed'); b.scrollIntoView({ block: 'center' }); });
    await visible(pg, '.perf-entry button'); await pg.click('.perf-entry button');
    await visible(pg, '.perf-sheet .perf-row'); await pg.waitForTimeout(400);
    const shown = await pg.evaluate(() => document.querySelector('.perf-sheet').innerText);
    await pg.locator('.perf-sheet .sheet-actions button').first().click(); await pg.waitForTimeout(300);
    const text = await pg.evaluate(() => window.__clip);
    return { shown, text };
  };
  let r = await copyReport(p);
  ok('the report names the end: "renderer killed by the system (memory)" with its detail', /ENDED UNEXPECTEDLY: renderer killed by the system \(memory\) \(killed, priority waived, app on screen, memory warning 40/.test(r.text), r.text.split('\n').filter((l) => /UNEXPECTED/.test(l)));
  ok('… and the memory while reading, the uncaught errors by name', /memory while reading \[s: heap MB\/elements k\/chapters made\/pictures\] \d+: /.test(r.text) && /uncaught TypeError x1, rejected RangeError x1/.test(r.text));
  ok('the page says it in the interface\'s words', /ended unexpectedly — the system ended the page's renderer \(most likely for memory\)/.test(r.shown), r.shown.split('\n').filter((l) => /unexpected/i.test(l)));
  ok('neither the record nor the report holds the title, the file\'s name or an error\'s message', !r.text.includes(TITLE) && !r.text.includes('velvet-harbour') && !r.text.includes(SECRET) && !JSON.stringify(await data(p)).includes(TITLE));

  // ---- the renderer crashed (not killed).
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id); await visible(p, '.reader-flow .kr-content p'); await p.waitForTimeout(1500);
  k = await kill(p); goneAt = Date.now() + 1000; await new Promise((r) => setTimeout(r, 1200));
  p = await page({ gone: [{ at: goneAt, crashed: true, prio: 2, fg: true }], exits: [] }, k.kept);
  await p.goto(base); await visible(p, '.library-view, .reader-view'); await p.waitForTimeout(3000);
  d = await data(p); prev = d.sessions.find((x) => x.at === k.at);
  ok('renderer crashed: told apart from killed', prev && prev.why === 'renderer-crash' && /^crashed, priority important/.test(prev.det), prev && { why: prev.why, det: prev.det });

  // ---- the app not responding: the system's exit record (ApplicationExitInfo REASON_ANR) for the main process.
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id); await visible(p, '.reader-flow .kr-content p'); await p.waitForTimeout(1500);
  k = await kill(p); let exitAt = Date.now() + 9000;
  p = await page({ gone: [], exits: [{ at: exitAt, reason: 6, status: 0, imp: 100, pss: 412, rss: 610, main: true }, { at: exitAt - 1, reason: 2, main: false }] }, k.kept);
  await p.goto(base); await visible(p, '.library-view, .reader-view'); await p.waitForTimeout(3000);
  d = await data(p); prev = d.sessions.find((x) => x.at === k.at);
  ok('the app not responding (ANR from the system\'s record): told apart, with importance, memory and the quiet before it', prev && prev.why === 'anr' && /^anr, importance 100, pss 412 MB, rss 610 MB, last record \d+ s before/.test(prev.det), prev && { why: prev.why, det: prev.det });
  ok('… an "exit" event for it, and the other process\'s exit kept apart (proc other)', d.events.some((e) => e.k === 'exit' && e.reason === 'anr') && d.events.some((e) => e.k === 'exit' && e.reason === 'signaled' && e.proc === 'other'));
  r = await copyReport(p);
  ok('the report: "app not responding (ANR)"', /ENDED UNEXPECTEDLY: app not responding \(ANR\) \(anr, importance 100/.test(r.text), r.text.split('\n').filter((l) => /UNEXPECTED/.test(l)));

  // ---- killed for memory (REASON_LOW_MEMORY).
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id); await visible(p, '.reader-flow .kr-content p'); await p.waitForTimeout(1500);
  k = await kill(p); exitAt = Date.now() + 500;
  p = await page({ gone: [], exits: [{ at: exitAt, reason: 3, imp: 400, pss: 900, main: true }] }, k.kept);
  await p.goto(base); await visible(p, '.library-view, .reader-view'); await p.waitForTimeout(3000);
  d = await data(p); prev = d.sessions.find((x) => x.at === k.at);
  ok('the app killed for memory (REASON_LOW_MEMORY): told apart', prev && prev.why === 'app-memory' && /^low memory, importance 400, pss 900 MB/.test(prev.det), prev && { why: prev.why, det: prev.det });

  // ---- no word from the native app: a task of 5 s in the last minute → ANR suspected; else "cause unknown".
  await p.evaluate(() => { location.hash = '#/'; }); await visible(p, '.library-view'); await p.waitForTimeout(500);
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id); await visible(p, '.reader-flow .kr-content p'); await p.waitForTimeout(1200);
  await p.evaluate(() => { const t = performance.now(); while (performance.now() - t < 5200) { /* the main thread held */ } });
  await p.waitForTimeout(1500);
  const sawLong = await p.evaluate(() => { const s = window.__krDiag.data().sessions.slice(-1)[0]; return (s.rlt ?? []).some(([ms]) => ms >= 5000); });
  k = await kill(p);
  p = await page({ gone: [], exits: [] }, k.kept);
  await p.goto(base); await visible(p, '.library-view, .reader-view'); await p.waitForTimeout(3000);
  d = await data(p); prev = d.sessions.find((x) => x.at === k.at);
  if (sawLong) ok('no word from the native app, a 5 s task in the last minute: "ANR suspected"', prev && prev.why === 'anr?', prev && { why: prev.why, det: prev.det, rlt: prev.rlt });
  else console.log('NOTE long tasks are not reported by this engine: the "ANR suspected" guess not checked');
  await p.close({ runBeforeUnload: true });

  // ---- 4 and 5 below.
  await partTwo(br, base);

  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed');
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

async function partTwo() { /* filled in below */ }
