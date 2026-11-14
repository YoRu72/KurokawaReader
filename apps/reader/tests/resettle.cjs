// node tests/resettle.cjs: the text reader's place re-settled after the window changes size (src/views/reader.ts,
// «re-settled after a resize»; src/ui/selection.ts). A Mac's window animates into full screen as a book opens
// (setImmersive), a zoom change or a phone turned reflows the text over many frames, and the scroll events that reflow
// causes are not the reader's. In both reading modes:
//  1. a book opened at a saved place, the window resized step by step at once (as full screen enters, ~0.7 s): once it
//     is still, the same paragraph is at the top, at the same offset within it — and the saved place is not
//     overwritten by the drift meanwhile;
//     — also when full screen comes later, after the reader's own settling passes, and when the engine moves the
//     scroll itself as the view resizes (a WKWebView does), which is neither the reader's scroll nor saved;
//  2. the width changed again later (a zoom change, full screen left), no scrolling: the same place;
//  3. the reader scrolls (the wheel) while the window is still changing size: their place stands, not put back;
//  4. a selection's toolbar is placed over the selection again after a resize, and a selection made while the text was
//     off the screen gets its toolbar once it is on the screen;
//  5. layout changes the reader did not cause, late — after restore's own passes (2.5 s) —, the place held by its own
//     anchor (src/views/reader.ts, «held through layout changes»): the runs of the long text above the place taking
//     their real height (a WebKit learning their sizes as they are measured: the macOS engine test's drift, 347 → 418),
//     a font's metrics changing, pictures above decoding, the engine moving the offset just before the window starts
//     to grow, and while it grows in height only (full screen entering) — the same paragraph at the same offset, the
//     saved place unchanged; after a wheel, the reader's own place is the one held;
//  6. a book of many chapters opened at a chapter first (formats/epub.ts first/rest), the reader scrolling while the
//     rest is made slowly: the chapters made above their place (taller or shorter than the 3000 px kept) do not move it.
// Each as Chromium is, and as WebKit is (no scroll anchoring: the drift a Mac's text reader showed in CI).
// (The book is made here: no fixtures.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
// (A picture that comes late: served after SLOW_MS — a picture above the place decoding after the book has settled.)
const SLOW_MS = 4500;
const server = http.createServer((req, res) => { if (req.url.startsWith('/__slow.svg')) { setTimeout(() => { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="#88a"/></svg>'); }, SLOW_MS); return; } let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-resettle-'));
// (Paragraphs of different lengths: a change of width moves each by a different amount, as a real book's do.)
const BOOK = path.join(TMP, 'Resettle Book.txt');
fs.writeFileSync(BOOK, ['Resettle Book', ...Array.from({ length: 700 }, (_, i) => `[P${i + 1}] ` + `Words of paragraph ${i + 1}, a line to read on and on. `.repeat(2 + (i * 7) % 9))].join('\n\n') + '\n');

// A book of many chapters (an EPUB), for 6.
const EPUB = path.join(TMP, 'Resettle Chapters.epub');
async function makeEpub(file, chapters) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items = [], spine = [], nav = [];
  for (let c = 1; c <= chapters; c++) {
    const paras = Array.from({ length: 30 + (c * 7) % 25 }, (_, q) => `<p>[C${c}-P${q}] ${'The river ran past the old city and the people read their books. '.repeat(1 + (q * 5) % 6)}</p>`).join('');
    z.file(`OEBPS/c${c}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>C${c}</title></head><body><h1>Chapter ${c}</h1>${paras}</body></html>`);
    items.push(`<item id="c${c}" href="c${c}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${c}"/>`); nav.push(`<li><a href="c${c}.xhtml">Chapter ${c}</a></li>`);
  }
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${nav.join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-resettle-chapters</dc:identifier><dc:title>Resettle Chapters</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
/** The paragraph of the EPUB at the top of the reading area, and how far into it. */
// (Found by what is drawn there — elementFromPoint —: a paragraph of a chapter not laid out is measured as if it were,
// past its chapter's reckoned box, over the text below.)
const whereE = (p) => p.evaluate(() => {
  const sc = document.querySelector('.reader-scroll'); const sr = sc.getBoundingClientRect(); const y = sr.top + 8;
  let hit = null; for (const dy of [0, 8, 16, 28, 40]) { hit = document.elementFromPoint(sr.left + sr.width / 2, y + dy)?.closest('p'); if (hit) break; }
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return { n: /^\[(C\d+-P\d+)\]/.exec(hit.textContent)?.[1] ?? '?', offset: Math.min(1, Math.max(0, (y - r.top) / Math.max(1, r.height))) };
});

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const bookBy = async (p, re) => (await allBooks(p)).find((b) => new RegExp(re).test(b.title) || new RegExp(re).test(b.fileName ?? ''));
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(800);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 160; i++) {
    const b = await bookBy(p, re); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file);
}
const toLibrary = async (p) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); };
/** Opened, and back as soon as its text shows (the window is then resized at once, as a Mac's full screen does). */
async function open(p, id) {
  await toLibrary(p); await p.waitForTimeout(300);
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForFunction(() => [...document.querySelectorAll('.reader-flow .kr-content')].some((e) => e.offsetParent !== null && e.getClientRects().length), null, { timeout: 30000 });
}
/** The paragraph at the top of the reading area (the reader's own probe: 8 px down) and how far into it, 0…1. */
const where = (p) => p.evaluate(() => {
  const sc = document.querySelector('.reader-scroll'); const y = sc.getBoundingClientRect().top + 8;
  const ps = [...document.querySelectorAll('.reader-flow p')].filter((x) => x.offsetParent);
  const hit = ps.find((x) => x.getBoundingClientRect().bottom > y); if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return { n: Number(/^\[P(\d+)\]/.exec(hit.textContent)?.[1] ?? -1), offset: Math.min(1, Math.max(0, (y - r.top) / Math.max(1, r.height))), w: innerWidth, h: innerHeight };
});
const scrollToPara = (p, n, frac = 0) => p.evaluate(({ n, frac }) => { const sc = document.querySelector('.reader-scroll'); const el = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith(`[P${n}]`)); el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect(); sc.scrollTop += r.top - sc.getBoundingClientRect().top - 8 + frac * r.height; }, { n, frac });
/** The window resized step by step, as a full-screen animation does it (no input). */
async function animate(p, from, to, steps = 10, ms = 70, engineScroll = 0) {
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await p.setViewportSize({ width: Math.round(from.width + (to.width - from.width) * k), height: Math.round(from.height + (to.height - from.height) * k) });
    // (The engine moving the scroll by itself as the view resizes — a WKWebView keeps its offset in proportion —: no
    // input from the reader.)
    if (engineScroll) await p.evaluate((d) => { document.querySelector('.reader-scroll').scrollTop += d; }, engineScroll);
    await p.waitForTimeout(ms);
  }
}
const saved = async (p, id) => (await allBooks(p)).find((b) => b.id === id)?.progress;
const same = (a, b, tol = 0.06) => !!a && !!b && a.n === b.n && Math.abs(a.offset - b.offset) <= tol;

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const SMALL = { width: 800, height: 700 }, BIG = { width: 1440, height: 900 }, ZOOM = { width: 1040, height: 900 };
  // Twice: as Chromium is (WebView2, Electron: scroll anchoring keeps a place through a reflow by itself), and as
  // WebKit is (a Mac's WKWebView, Linux's WebKitGTK: no scroll anchoring — `overflow-anchor: none` everywhere).
  for (const [engine, css] of [['scroll anchoring', ''], ['as WebKit: no scroll anchoring', '*, *::before, *::after { overflow-anchor: none !important; }']]) {
  const ctx = await br.newContext({ viewport: SMALL });
  if (css) await ctx.addInitScript((css) => { const add = () => { const st = document.createElement('style'); st.textContent = css; document.documentElement.appendChild(st); }; if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add); }, css);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous' })); });
  await p.reload(); await p.waitForSelector('.library-view');
  if (css) ok(`[${engine}] the page has no scroll anchoring`, await p.evaluate(() => getComputedStyle(document.querySelector('body')).overflowAnchor === 'none'));
  const book = await importFile(p, BOOK, 'Resettle Book|Resettle');

  // (KR_RESETTLE_ONLY=6: the book of many chapters alone — a quick run while working on it.)
  for (const m of process.env.KR_RESETTLE_ONLY === '6' ? [] : ['continuous', 'chapters']) {
    const mode = `${engine}, ${m}`;
    await p.setViewportSize(SMALL);
    await toLibrary(p); await p.evaluate((m) => { const s = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); s.readingMode = m; localStorage.setItem('kr.visual', JSON.stringify(s)); }, m);
    await p.reload(); await p.waitForSelector('.library-view');
    // The place to come back to: a paragraph in the middle, a third of the way into it.
    await open(p, book.id); await p.waitForTimeout(3200);
    await scrollToPara(p, 347, 0.33); await p.waitForTimeout(1500);
    const left = await where(p);
    const kept = await saved(p, book.id);
    ok(`[${mode}] read to paragraph 347, the place saved`, left && left.n === 347 && kept && typeof kept.block === 'number', { left, kept });

    // 1. Opened again, and the window at once animated into a larger size (full screen entering).
    await toLibrary(p); await p.waitForTimeout(600);
    await open(p, book.id); await p.waitForTimeout(120);
    const atOpen = await where(p);
    await animate(p, SMALL, BIG);
    await p.waitForTimeout(1600);
    const after = await where(p);
    ok(`[${mode}] full screen entered as the book opened: the same paragraph at the top, at the same offset`, same(after, left), { left, atOpen, after });
    await p.waitForTimeout(3000); // (restore's later passes, fonts: nothing moves it after)
    const later = await where(p);
    ok(`[${mode}] … and it stays there`, same(later, left), { left, later });
    const kept2 = await saved(p, book.id);
    ok(`[${mode}] the saved place is not the drift's`, kept2 && kept2.block === kept.block && Math.abs((kept2.offset ?? 0) - (kept.offset ?? 0)) <= 0.06, { kept, kept2 });

    // 2. The width changed again later, no scrolling (a zoom change, full screen left).
    await animate(p, BIG, ZOOM, 6, 50); await p.waitForTimeout(1200);
    const zoomed = await where(p);
    ok(`[${mode}] the width changed again later: the same place`, same(zoomed, left), { left, zoomed });
    await animate(p, ZOOM, SMALL, 6, 50); await p.waitForTimeout(1200);
    const back = await where(p);
    ok(`[${mode}] back to the first size: the same place`, same(back, left), { left, back });

    // 1b. Full screen entered later — after restore's own passes (2.5 s) are over —: the same place.
    await toLibrary(p); await p.waitForTimeout(600);
    await open(p, book.id); await p.waitForTimeout(3000);
    const before = await where(p);
    await animate(p, SMALL, BIG);
    await p.waitForTimeout(1600);
    const late = await where(p);
    ok(`[${mode}] full screen entered 3 s after the book opened: the same place`, same(before, left) && same(late, left), { left, before, late });
    await animate(p, BIG, SMALL, 6, 50); await p.waitForTimeout(1200);

    // 1c. The engine moves the scroll itself while the view resizes (no input): not the reader's — put back, not saved.
    await toLibrary(p); await p.waitForTimeout(600);
    await open(p, book.id); await p.waitForTimeout(300);
    await animate(p, SMALL, BIG, 10, 70, 140);
    await p.waitForTimeout(1600);
    const nudged = await where(p);
    await p.waitForTimeout(3000);
    const nudgedLater = await where(p);
    const kept3 = await saved(p, book.id);
    ok(`[${mode}] the engine moved the scroll while resizing: the same place, and not saved as the reader's`, same(nudged, left) && same(nudgedLater, left) && kept3 && kept3.block === kept.block, { left, nudged, nudgedLater, kept, kept3 });
    await animate(p, BIG, SMALL, 6, 50); await p.waitForTimeout(1200);

    // 1d. The engine moves the scroll once more just AFTER the resize has settled (a Mac's window ending its full-screen
    // animation; no input): put back too, not saved. A wheel just after it is the reader's: it stands.
    await toLibrary(p); await p.waitForTimeout(600);
    await open(p, book.id); await p.waitForTimeout(300);
    await animate(p, SMALL, BIG); await p.waitForTimeout(600);
    await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop += 900; });
    await p.waitForTimeout(1500);
    const lateNudge = await where(p); const kept4 = await saved(p, book.id);
    ok(`[${mode}] the engine moved the scroll just after the resize settled: put back, not saved`, same(lateNudge, left) && kept4 && kept4.block === kept.block, { left, lateNudge, kept, kept4 });
    await animate(p, BIG, SMALL, 6, 50); await p.waitForTimeout(600);
    await p.mouse.move(SMALL.width / 2, SMALL.height / 2); await p.mouse.wheel(0, 1800); await p.waitForTimeout(1500);
    const wheeled = await where(p);
    ok(`[${mode}] a wheel just after a resize settled: the reader's place stands`, wheeled && wheeled.n > 352, { left, wheeled });
    await scrollToPara(p, 347, 0.33); await p.waitForTimeout(1500);

    // 3. The reader scrolls while the window is still changing size: their place stands.
    await p.mouse.move(SMALL.width / 2, SMALL.height / 2);
    const steps = [];
    for (let i = 1; i <= 8; i++) {
      const k = i / 8;
      await p.setViewportSize({ width: Math.round(SMALL.width + (BIG.width - SMALL.width) * k), height: Math.round(SMALL.height + (BIG.height - SMALL.height) * k) });
      if (i === 4) { await p.mouse.wheel(0, 2400); }
      await p.waitForTimeout(70);
    }
    await p.waitForTimeout(1600);
    const mine = await where(p);
    steps.push(mine);
    ok(`[${mode}] scrolled during a resize: the reader's place stands (not put back at 347)`, mine && mine.n > 352, { left, mine });
    await p.setViewportSize(SMALL); await p.waitForTimeout(1200);

    // 5. Layout changes the reader did not cause, late: the place held, the saved place unchanged. (Each case from its
    // own place read and saved: a drift one case saved is not the next one's start.)
    const lateCase = async (name, change, { settle = 1800, extra } = {}) => {
      await toLibrary(p); await p.waitForTimeout(600);
      await open(p, book.id); await p.waitForTimeout(2600);
      await scrollToPara(p, 347, 0.33); await p.waitForTimeout(1500);
      const left5 = await where(p); const kept5 = await saved(p, book.id);
      await toLibrary(p); await p.waitForTimeout(600);
      await open(p, book.id); await p.waitForTimeout(3300);
      const before = await where(p);
      const info = await change();
      await p.waitForTimeout(settle);
      const after = await where(p); await p.waitForTimeout(1200); const after2 = await where(p);
      const keptNow = await saved(p, book.id);
      const log = await p.evaluate(() => (window.__krPlaceLog || []).slice(-6));
      ok(`[${mode}] ${name}: the same paragraph at the same offset`, same(before, left5) && same(after, left5) && same(after2, left5), { left: left5, before, after, after2, info, log });
      ok(`[${mode}] ${name}: the saved place unchanged`, keptNow && keptNow.block === kept5.block && Math.abs((keptNow.offset ?? 0) - (kept5.offset ?? 0)) <= 0.06, { kept: kept5, keptNow });
      if (extra) await extra();
      await p.evaluate(() => document.getElementById('kr-test-late')?.remove());
    };
    // (a) The runs of the long text above the place take their real height — laid out, and their reckoned height put
    // right — with no event: what a WebKit does as it learns their sizes.
    await lateCase('the runs above take their real height late', () => p.evaluate(() => {
      const el = document.querySelector('.reader-flow .kr-content'); const runs = [...el.querySelectorAll(':scope > .kr-run')];
      const sc = document.querySelector('.reader-scroll'); const y = sc.getBoundingClientRect().top;
      const above = runs.filter((r) => r.getBoundingClientRect().bottom < y - 50);
      const h0 = above.map((r) => Math.round(r.getBoundingClientRect().height));
      const cpx = parseFloat(el.style.getPropertyValue('--kr-cpx')) || 0.45;
      el.style.setProperty('--kr-cpx', `${(cpx * 0.7).toFixed(4)}px`);
      above.slice(-2).forEach((r) => { r.style.contentVisibility = 'visible'; });
      return { runsAbove: above.length, before: h0, after: above.map((r) => Math.round(r.getBoundingClientRect().height)) };
    }));
    // (b) A font's metrics change (a font swapped in late: the lines wider, the paragraphs taller).
    await lateCase('a font swapped in late', () => p.evaluate(() => { const st = document.createElement('style'); st.id = 'kr-test-late'; st.textContent = '.reader-flow p { letter-spacing: .09em; word-spacing: .2em; }'; document.head.appendChild(st); return 'letter-spacing'; }));
    // (c) Pictures above the place decode late (served after SLOW_MS), in the place's own run.
    await lateCase('pictures above decode late', () => p.evaluate(() => {
      const sc = document.querySelector('.reader-scroll'); const y = sc.getBoundingClientRect().top;
      const ps = [...document.querySelectorAll('.reader-flow p')].filter((x) => x.getBoundingClientRect().bottom < y - 20).slice(-6, -1);
      ps.forEach((x, i) => { const img = document.createElement('img'); img.src = `/__slow.svg?${Date.now()}-${i}`; img.alt = ''; x.prepend(img); });
      return `${ps.length} pictures`;
    }), { settle: 6000 });
    // (d) The engine moves the offset (no input) just before the window starts to grow — the resize told after it.
    await lateCase('the engine moved the offset just before the window grew', async () => { await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); sc.scrollTop = Math.round(sc.scrollTop * 1.2); }); await animate(p, SMALL, BIG); return 'scrollTop × 1.2, then the window grew'; }, { extra: () => animate(p, BIG, SMALL, 6, 50) });
    // (e) The window grows in height only (full screen entering) while the engine keeps the offset in proportion.
    await lateCase('the window grew in height only, the engine moving the offset', async () => { await animate(p, SMALL, { width: SMALL.width, height: 900 }, 8, 60, 90); return 'height 700 → 900, +90 px a step'; }, { extra: () => p.setViewportSize(SMALL) });
    // (f) After a wheel, the reader's own place is the one held: a font swapped in after it leaves them there.
    {
      await toLibrary(p); await p.waitForTimeout(600);
      await open(p, book.id); await p.waitForTimeout(2600);
      await scrollToPara(p, 347, 0.33); await p.waitForTimeout(1500);
      const left5 = await where(p);
      await toLibrary(p); await p.waitForTimeout(600);
      await open(p, book.id); await p.waitForTimeout(3300);
      await p.mouse.move(SMALL.width / 2, SMALL.height / 2); await p.mouse.wheel(0, 1500); await p.waitForTimeout(1500);
      const mine5 = await where(p); const keptMine = await saved(p, book.id);
      await p.evaluate(() => { const st = document.createElement('style'); st.id = 'kr-test-late'; st.textContent = '.reader-flow p { letter-spacing: .09em; word-spacing: .2em; }'; document.head.appendChild(st); });
      await p.waitForTimeout(1800);
      const after = await where(p); const keptAfter = await saved(p, book.id);
      ok(`[${mode}] a wheel, then a font swapped in: the reader's own place held (and saved)`, mine5 && mine5.n > left5.n + 5 && same(after, mine5) && keptMine && keptAfter && keptAfter.block === keptMine.block, { left: left5, mine: mine5, after, keptMine, keptAfter });
      await p.evaluate(() => document.getElementById('kr-test-late')?.remove());
      await scrollToPara(p, 347, 0.33); await p.waitForTimeout(1500);
    }
  }

  // 6. A book of many chapters opened at a chapter first, its other chapters made slowly (the CPU slowed): the reader
  // scrolls while they are made; then the chapters above take their real height (a WebKit learning their sizes). Their
  // place stands — continuous reading, where the chapters above are in the same page.
  {
    const m6 = `${engine}, continuous, chapters made late`;
    await p.setViewportSize(SMALL); await toLibrary(p);
    await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); s.readingMode = 'continuous'; localStorage.setItem('kr.visual', JSON.stringify(s)); });
    await p.reload(); await p.waitForSelector('.library-view');
    if (!fs.existsSync(EPUB)) await makeEpub(EPUB, 24);
    const eb = await importFile(p, EPUB, 'Resettle Chapters');
    // (Opened whole once — the chapters' sizes kept —, read to chapter 14.)
    await open(p, eb.id); await p.waitForTimeout(3000);
    await p.evaluate(() => { const el = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith('[C14-P12]')); const sc = document.querySelector('.reader-scroll'); el.scrollIntoView({ block: 'start' }); sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8 + 0.3 * el.getBoundingClientRect().height; });
    await p.waitForTimeout(1500);
    const left = await whereE(p);
    await toLibrary(p); await p.waitForTimeout(600);
    const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 25 });
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, eb.id);
    await p.waitForFunction(() => [...document.querySelectorAll('.reader-flow p')].some((e) => e.offsetParent !== null), null, { timeout: 60000 });
    const shellsAtOpen = await p.evaluate(() => document.querySelectorAll('.kr-chapter.kr-shell').length);
    const atOpen = await whereE(p);
    await p.mouse.move(SMALL.width / 2, SMALL.height / 2); await p.mouse.wheel(0, 500); await p.waitForTimeout(900);
    const mine = await whereE(p);
    await p.waitForFunction(() => !document.querySelector('.kr-chapter.kr-shell'), null, { timeout: 90000 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await p.waitForTimeout(1500);
    const whole = await whereE(p);
    const dbg = async () => p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const r = sc.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + 12); return { pt: e?.closest('p')?.textContent.slice(0, 10) ?? e?.tagName, top: sc.scrollTop, chapters: [...document.querySelectorAll('.reader-flow .kr-chapter')].map((c) => Math.round(c.getBoundingClientRect().top)).slice(10, 16) }; });
    if (process.env.KR_RESETTLE_DEBUG) console.log('dbg whole', JSON.stringify(await dbg()));
    // (The chapters above laid out at their real height, with no event.)
    const sizes = await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const y = sc.getBoundingClientRect().top; const above = [...document.querySelectorAll('.reader-flow .kr-chapter')].filter((c) => c.getBoundingClientRect().bottom < y - 50); const h0 = above.map((c) => Math.round(c.getBoundingClientRect().height)); above.forEach((c) => { c.style.contentVisibility = 'visible'; }); return { above: above.length, before: h0.slice(-4), after: above.map((c) => Math.round(c.getBoundingClientRect().height)).slice(-4) }; });
    await p.waitForTimeout(1500);
    const end = await whereE(p);
    if (process.env.KR_RESETTLE_DEBUG) console.log('dbg end', JSON.stringify(await dbg()));
    const kept = (await allBooks(p)).find((b) => b.id === eb.id)?.progress;
    const log = await p.evaluate(() => (window.__krPlaceLog || []).slice(-6));
    const near = (a, b) => !!a && !!b && a.n === b.n && Math.abs(a.offset - b.offset) <= 0.08;
    ok(`[${m6}] opened at its place with chapters still to make`, near(atOpen, left) && shellsAtOpen > 0, { left, atOpen, shellsAtOpen });
    ok(`[${m6}] scrolled while they were made: the reader's place stands once the book is whole, and after the chapters above take their real height`, mine && mine.n !== left.n && near(whole, mine) && near(end, mine), { left, mine, whole, end, sizes, log });
    await cdp.detach();
    await toLibrary(p); await p.waitForTimeout(600);
    await open(p, eb.id); await p.waitForTimeout(2500);
    const again = await whereE(p);
    ok(`[${m6}] … and it is the place saved: opened again, there`, near(again, mine), { mine, again, kept });
  }

  // 4. The selection's toolbar over the selection after a resize; one made off the screen comes once it is on it.
  if (process.env.KR_RESETTLE_ONLY !== '6') {
    const e4 = engine;
    await p.setViewportSize(SMALL);
    await open(p, book.id); await p.waitForTimeout(3200);
    const select = (n) => p.evaluate((n) => { const el = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith(`[P${n}]`)); const t = el.firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, Math.min(40, t.textContent.length)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, n);
    const geo = () => p.evaluate(() => { const bar = document.querySelector('.sel-toolbar'); const s = getSelection(); if (!s.rangeCount) return { bar: null }; const r = s.getRangeAt(0).getBoundingClientRect(); const b = bar?.getBoundingClientRect(); return { sel: { top: r.top, bottom: r.bottom, cx: r.left + r.width / 2 }, bar: b ? { top: b.top, bottom: b.bottom, cx: b.left + b.width / 2, w: b.width } : null, w: innerWidth, h: innerHeight }; });
    const over = (g) => !!g.bar && g.bar.top >= 0 && g.bar.bottom <= g.h && (g.bar.bottom <= g.sel.top + 2 || g.bar.top >= g.sel.bottom - 2) && Math.abs(g.bar.cx - Math.max(g.bar.w / 2 + 8, Math.min(g.w - g.bar.w / 2 - 8, g.sel.cx))) < 4;
    const first = await where(p);
    await select(first.n + 1); await p.waitForTimeout(600);
    const g1 = await geo();
    ok(`[${e4}] a selection: its toolbar over it`, over(g1), g1);
    await animate(p, SMALL, BIG, 8, 60); await p.waitForTimeout(1200);
    const g2 = await geo();
    ok(`[${e4}] after a resize: the toolbar over the selection again`, over(g2), g2);
    // (Made while it is below the screen — the text still reflowing —: no toolbar; brought on the screen: there.)
    await p.setViewportSize(SMALL); await p.waitForTimeout(1200);
    const now = await where(p);
    await p.evaluate(() => getSelection().removeAllRanges()); await p.waitForTimeout(400);
    await select(now.n + 40); await p.waitForTimeout(600);
    const g3 = await geo();
    ok(`[${e4}] a selection off the screen: no toolbar yet`, !g3.bar, g3);
    await p.evaluate((n) => { const el = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith(`[P${n}]`)); const sc = document.querySelector('.reader-scroll'); sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 200; }, now.n + 40);
    await p.waitForTimeout(800);
    const g4 = await geo();
    ok(`[${e4}] … on the screen: its toolbar comes, over it`, over(g4), g4);
  }

  await ctx.close();
  }

  ok('no page errors', !errors.length, errors.slice(0, 5));
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `resettle: ${fails} failed` : 'resettle: ok');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
