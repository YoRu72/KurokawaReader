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
//     off the screen gets its toolbar once it is on the screen.
// Each as Chromium is, and as WebKit is (no scroll anchoring: the drift a Mac's text reader showed in CI).
// (The book is made here: no fixtures.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-resettle-'));
// (Paragraphs of different lengths: a change of width moves each by a different amount, as a real book's do.)
const BOOK = path.join(TMP, 'Resettle Book.txt');
fs.writeFileSync(BOOK, ['Resettle Book', ...Array.from({ length: 700 }, (_, i) => `[P${i + 1}] ` + `Words of paragraph ${i + 1}, a line to read on and on. `.repeat(2 + (i * 7) % 9))].join('\n\n') + '\n');

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

  for (const m of ['continuous', 'chapters']) {
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
  }

  // 4. The selection's toolbar over the selection after a resize; one made off the screen comes once it is on it.
  {
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
