// node tests/comicreader.cjs [en|ar]: the comic reader (src/views/comic.ts, src/comic/*.ts) with made-up CBZ books
// (tests/helpers/comicfixture.cjs — numbered pages of made-up art, no real comic pages), on a phone (412×915) and a
// computer (1280×800):
//  1. a CBZ opens in the comic reader, not the flow reader; pages in natural order, system entries left out, folders
//     as chapters in the contents;
//  2. right to left by default; in each of the five modes a tap, a key and a swipe (a scroll in the strips) go the
//     right way; the slider runs the way the book reads; the page number «n / total»;
//  3. a book's own mode is kept with it (reopened: the same); another book follows the default, and changes with it;
//  4. fit screen, stretch, fit width, fit height, original size and smart fit draw a known page at the expected size;
//     a double tap zooms in to 2× and back; navigate by pan moves a zoomed page a screen, then turns; landscape zoom
//     fills the height with a wide page;
//  5. every tap-zone layout hit-tested at sample points, with each inversion; the zones' overlay shown once to a new
//     reader; a long press is told (kr:comic-longpress);
//  6. the place restored after the book is left and opened again; the last page marks it finished; the page after the
//     last says «Finished» and offers the next volume, which opens;
//  7. a 300-page archive (≈400 MB; KR_COMIC_MB to change): at most 6 decoded pictures one page per screen, the strip's
//     pictures in the page bounded, the first page shown within 600 ms (numbers printed);
//  8. the settings panel's two tabs (a computer: no tap zones, the keys' list; a phone: the zones, no keys' list), the
//     Comics group in Settings → Reader; «Open comics the old way» still opens the flow reader;
//  9. a computer: ← → by direction, ↑ ↓, Page Up / Down, Space, Home / End, the wheel a page per notch group, clicks.
// Screenshots (KR_SHOTS=<dir>): S5a-paged-rtl, S5a-strip, S5a-settings-mode, S5a-settings-general, S5a-zones-overlay,
// S5a-transition (phone, dark), S5a-paged-pc.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { makeCbz } = require('./helpers/comicfixture.cjs');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const SHOTS = process.env.KR_SHOTS ? path.resolve(process.env.KR_SHOTS) : null; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
// (The big archive once — in English: what it measures does not depend on the language.)
const BIG_MB = Number(process.env.KR_COMIC_MB ?? (process.argv[2] === 'ar' ? 0 : 400));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-comic-'));
const AR = LANG === 'ar';
const W = { finished: AR ? 'انتهى' : 'Finished', next: AR ? 'التالي' : 'Next:', general: AR ? 'عامّ' : 'General', mode: AR ? 'طريقة القراءة' : 'Reading mode', comics: AR ? 'القصص المصوَّرة' : 'Comics' };

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const bookOf = async (p, id) => (await allBooks(p)).find((b) => b.id === id);
const visual = async (p, patch) => { await p.evaluate((patch) => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, patch); localStorage.setItem('kr.visual', JSON.stringify(v)); }, patch); };
const st = (p) => p.evaluate(() => { const c = window.__krComic; if (!c) return null; const v = c.viewer; const sc = document.querySelector('.cm-scroll'); return { page: v.page, item: v.item, kind: v.itemKind, total: v.total, decoded: v.decoded(), urls: c.source.liveUrls(), drawn: v.drawn(), mode: c.mode(), rtl: v.rtl, top: sc ? Math.round(sc.scrollTop) : null, openMs: c.openMs, domImgs: document.querySelectorAll('.cm-view img[src]').length }; });
/** Wait (with a deadline) until the stored book satisfies `test`. */
async function stored(p, id, test, ms = 5000) { const end = Date.now() + ms; for (;;) { const b = await bookOf(p, id); if (test(b)) return true; if (Date.now() > end) return false; await p.waitForTimeout(100); } }
const until = (p, fn, arg, ms = 5000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const noToast = (p) => until(p, () => !document.querySelector('.toast'), null, 8000);
const home = async (p) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view', { timeout: 15000 }); };
/** Open a book in the reader and wait until its first picture is drawn. */
async function open(p, id, wantComic = true) {
  await home(p);
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  if (!wantComic) { await p.waitForSelector('.reader-view .kr-content img:not(.kr-img-failed)', { timeout: 15000 }); return; }
  await p.waitForFunction(() => window.__krComic && window.__krComic.openMs > 0, null, { timeout: 15000 });
}
const reload = async (p) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view', { timeout: 15000 }); await p.reload(); await p.waitForSelector('.library-view', { timeout: 15000 }); };
/** Wait until the strip stops moving (a wheel's or a smooth scroll's glide). */
const still = (p) => p.waitForFunction(() => { const sc = document.querySelector('.cm-scroll'); const w = window; const v = Math.round(sc ? sc.scrollTop : 0); const same = w.__lastTop === v; w.__lastTop = v; return same; }, null, { timeout: 4000, polling: 150 }).catch(() => undefined);
const dismissZones = async (p) => { if (await p.$('.cm-zones')) { await p.mouse.click(5, 5); await until(p, () => !document.querySelector('.cm-zones'), null, 3000); } };
/** A tap at fractions of the screen, then wait until the state's `key` changes (or a short deadline). */
async function tapAt(p, fx, fy, key = 'page') {
  const vp = p.viewportSize(); const before = await st(p);
  await p.mouse.click(Math.round(vp.width * fx), Math.round(vp.height * fy));
  await until(p, ([k, v]) => { const c = window.__krComic; if (!c) return false; const sc = document.querySelector('.cm-scroll'); const now = k === 'top' ? Math.round(sc ? sc.scrollTop : 0) : c.viewer[k]; return now !== v; }, [key, key === 'top' ? before.top : before[key]], 1500);
  await p.waitForTimeout(80);
  return st(p);
}
async function swipe(p, from, to) {
  const vp = p.viewportSize(); const a = { x: vp.width * from[0], y: vp.height * from[1] }, b = { x: vp.width * to[0], y: vp.height * to[1] };
  await p.mouse.move(a.x, a.y); await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
  await p.mouse.up();
  await p.waitForTimeout(350);
  return st(p);
}
const key = async (p, k, prop = 'page') => { const b = await st(p); await p.keyboard.press(k); await until(p, ([prop, v]) => { const c = window.__krComic; const sc = document.querySelector('.cm-scroll'); return (prop === 'top' ? Math.round(sc ? sc.scrollTop : 0) : c.viewer[prop]) !== v; }, [prop, prop === 'top' ? b.top : b[prop]], 1500); return st(p); };
/** This book's mode chosen with the bar's mode button (0: the default), the bars hidden again after. */
async function setMode(p, m) {
  await p.evaluate(() => document.querySelector('.reader-view').classList.remove('immersive'));
  await p.click('.cm-mode-btn'); await p.waitForSelector('.sheet .dest-row');
  await p.evaluate((m) => [...document.querySelectorAll('.sheet .dest-row')][m].click(), m);
  await until(p, () => !document.querySelector('.sheet'), null, 2000);
  await p.evaluate(() => document.querySelector('.reader-view').classList.add('immersive'));
}
async function settle(p) { await p.waitForTimeout(120); }

async function session(phone, fn) {
  const br = await chromium.launch({ args: ['--js-flags=--max-old-space-size=2048'] }); const errors = [];
  const ctx = await br.newContext(phone ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: LANG, colorScheme: 'dark' } : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: LANG, colorScheme: 'dark' });
  await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (r) => r.abort());
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ bookPage: 'never', doubleBackExit: false })); }, LANG);
  await reload(p);
  try { await fn(p, errors); } finally { ok(`${phone ? 'phone' : 'computer'}: no page errors`, errors.length === 0, errors); await ctx.close(); await br.close(); }
}
async function importBooks(p, files, want) {
  await p.setInputFiles('.library-view input[type=file]', files);
  let books = [];
  for (let i = 0; i < 600; i++) { books = await allBooks(p); if (books.length >= want) break; await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); await p.waitForTimeout(250); }
  const id = (re) => books.find((b) => re.test(b.fileName || b.title))?.id;
  return { v1: id(/Lantern Comic Vol\. 1/), v2: id(/Lantern Comic Vol\. 2/), other: id(/Harbour Sketches/), big: id(/Long Archive/), pic: id(/single-picture/) };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const files = {
    v1: path.join(TMP, 'Lantern Comic Vol. 1.cbz'), v2: path.join(TMP, 'Lantern Comic Vol. 2.cbz'), other: path.join(TMP, 'Harbour Sketches.cbz'),
  };
  // Volume 1: 12 pages in two folders (chapters), page 4 wide, page 10 bordered; volume 2: 3 pages; another book: 5.
  fs.writeFileSync(files.v1, await makeCbz({ pages: 12, folders: [5, 7], wide: [4], bordered: [10] }));
  fs.writeFileSync(files.v2, await makeCbz({ pages: 3 }));
  fs.writeFileSync(files.other, await makeCbz({ pages: 5 }));

  /* ---------------------------------------------------------------- phone */
  await session(true, async (p) => {
    const ids = await importBooks(p, [files.v1, files.v2, files.other], 3);
    ok('three made-up comics imported', ids.v1 && ids.v2 && ids.other, ids);
    const b1 = await bookOf(p, ids.v1);
    ok('pages counted as the reader reads them (system entries and the text file left out)', b1.pageCount === 12, b1.pageCount);
    await open(p, ids.v1);
    ok('a CBZ opens in the comic reader, not the flow reader', !!(await p.$('.cm-view')) && !(await p.$('.reader-flow')));
    // The zones' overlay: shown to a new reader, once.
    ok('the tap zones are shown to a new reader', await until(p, () => !!document.querySelector('.cm-zones .cm-zone'), null, 3000));
    if (SHOTS) { await noToast(p); await p.screenshot({ path: path.join(SHOTS, 'S5a-zones-overlay.png') }); }
    await dismissZones(p);
    let s = await st(p);
    ok('right to left by default; the first page; 12 pages', s.mode === 2 && s.rtl && s.page === 0 && s.total === 12, s);
    ok('at most the current page and its neighbours decoded', s.decoded <= 3 && s.urls <= 3, s);
    const pn = await p.evaluate(() => { const e = document.querySelector('.cm-pnum'); return { text: e.textContent, shown: !!e.offsetParent || getComputedStyle(e).display !== 'none' }; });
    ok('the page number «1 / 12» over the page', pn.text === '1 / 12' && pn.shown, pn);
    if (SHOTS) { await noToast(p); await p.evaluate(() => { window.__krComic.viewer.goTo(2); document.querySelector('.reader-view').classList.remove('immersive'); }); await p.waitForTimeout(700); await p.screenshot({ path: path.join(SHOTS, 'S5a-paged-rtl.png') }); await p.evaluate(() => { window.__krComic.viewer.goTo(0); document.querySelector('.reader-view').classList.add('immersive'); }); await p.waitForTimeout(400); }

    // 2. Each mode: a tap, a key and a swipe go the right way.
    s = await tapAt(p, 0.15, 0.5); ok('RTL: a tap on the left is the next page', s.page === 1, s);
    s = await tapAt(p, 0.85, 0.5); ok('RTL: a tap on the right is the previous page', s.page === 0, s);
    s = await key(p, 'ArrowLeft'); ok('RTL: ← is the next page', s.page === 1, s);
    s = await key(p, 'ArrowRight'); ok('RTL: → is the previous page', s.page === 0, s);
    s = await swipe(p, [0.2, 0.5], [0.8, 0.5]); ok('RTL: a swipe to the right is the next page', s.page === 1, s);
    s = await swipe(p, [0.8, 0.5], [0.2, 0.5]); ok('RTL: a swipe to the left is the previous page', s.page === 0, s);
    s = await swipe(p, [0.5, 0.5], [0.56, 0.5]); ok('RTL: a short slow drag snaps back', s.page === 0, s);
    const dir = async () => p.evaluate(() => ({ slider: getComputedStyle(document.querySelector('.cm-slider')).direction }));
    ok('the slider runs right to left in a right-to-left book', (await dir()).slider === 'rtl');
    await setMode(p, 1); await settle(p);
    s = await tapAt(p, 0.85, 0.5); ok('LTR: a tap on the right is the next page', s.page === 1 && !s.rtl, s);
    s = await key(p, 'ArrowRight'); ok('LTR: → is the next page', s.page === 2, s);
    s = await swipe(p, [0.8, 0.5], [0.2, 0.5]); ok('LTR: a swipe to the left is the next page', s.page === 3, s);
    s = await tapAt(p, 0.15, 0.5); ok('LTR: a tap on the left is the previous page', s.page === 2, s);
    await setMode(p, 3); await settle(p);
    s = await tapAt(p, 0.5, 0.85); ok('vertical: a tap at the foot is the next page (L-shaped)', s.page === 3, s);
    s = await key(p, 'ArrowDown'); ok('vertical: ↓ is the next page', s.page === 4, s);
    s = await swipe(p, [0.5, 0.8], [0.5, 0.2]); ok('vertical: a swipe up is the next page', s.page === 5, s);
    s = await tapAt(p, 0.5, 0.15); ok('vertical: a tap at the top is the previous page', s.page === 4, s);
    for (const m of [4, 5]) {
      await setMode(p, m); await settle(p);
      const t0 = (await st(p)).top;
      s = await tapAt(p, 0.5, 0.85, 'top'); ok(`${m === 4 ? 'long strip' : 'continuous vertical'}: a tap at the foot scrolls on`, s.top > t0, { t0, s });
      const t1 = s.top; s = await key(p, 'ArrowDown', 'top'); ok(`${m === 4 ? 'long strip' : 'continuous vertical'}: ↓ scrolls on`, s.top > t1, { t1, s });
      await still(p); const t2 = (await st(p)).top; await p.mouse.move(206, 450); await p.mouse.wheel(0, 400); await until(p, (v) => Math.round(document.querySelector('.cm-scroll').scrollTop) > v, t2, 1500); await still(p); s = await st(p);
      ok(`${m === 4 ? 'long strip' : 'continuous vertical'}: the wheel (a finger's scroll) scrolls on`, s.top > t2, { t2, s });
      const t3 = s.top; s = await tapAt(p, 0.5, 0.15, 'top'); ok(`${m === 4 ? 'long strip' : 'continuous vertical'}: a tap at the top scrolls back`, s.top < t3, { t3, s });
      const gap = await p.evaluate(() => { const b = document.querySelectorAll('.cm-block'); return b.length > 1 ? b[1].getBoundingClientRect().top - b[0].getBoundingClientRect().bottom : -1; });
      ok(`${m === 4 ? 'long strip: no gap between pages' : 'continuous vertical: a gap between pages'}`, m === 4 ? Math.abs(gap) < 1 : gap > 8, gap);
      ok(`${m === 4 ? 'long strip' : 'continuous vertical'}: the slider runs left to right`, (await dir()).slider === 'ltr');
    }
    if (SHOTS) { await setMode(p, 4); await p.evaluate(() => window.__krComic.viewer.goTo(2, 0.3)); await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, 'S5a-strip.png') }); }

    // 3. The book's own mode, kept; another book follows the default.
    await open(p, ids.v1);
    await setMode(p, 0); await open(p, ids.v1);
    ok('the book\'s mode back to «Default»: right to left again', (await st(p)).mode === 2);
    await setMode(p, 1); // (the rows: the default, then left to right, right to left…)
    let own = await st(p); const b1b = await bookOf(p, ids.v1);
    ok('the mode button sets this book\'s mode (kept with the book)', own.mode === 1 && b1b.prefs?.comicMode === 1, { mode: own.mode, prefs: b1b.prefs });
    await open(p, ids.v1); ok('opened again: the book\'s own mode', (await st(p)).mode === 1);
    await open(p, ids.other); ok('another book follows the default (right to left)', (await st(p)).mode === 2);
    await visual(p, { comicMode: 3 }); await reload(p); await open(p, ids.other);
    ok('the default changed: the other book follows it (vertical)', (await st(p)).mode === 3);
    await open(p, ids.v1); ok('… the book with its own mode keeps it', (await st(p)).mode === 1);
    await visual(p, { comicMode: 2 }); await p.evaluate(async (id) => { await new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const os = tx.objectStore('books'); os.get(id).onsuccess = (e) => { const b = e.target.result; delete b.prefs; os.put(b); }; tx.oncomplete = res; }; }); }, ids.v1);
    await reload(p);

    // 4. Fit modes, zoom, pan, landscape zoom.
    await open(p, ids.v1);
    const fit = async (scale) => p.evaluate((scale) => { const v = window.__krComic.viewer; v.set(2, { transitions: false, scale, zoomStart: 'auto', navPan: true, landscapeZoom: false, stripZoom: true, zones: 0, invert: 'none' }); v.goTo(0); return v.drawn(); }, scale);
    // (A page of 600×900 on a 412×915 screen.)
    const want = { fit: [412, 618], stretch: [412, 915], width: [412, 618], height: [610, 915], original: [600, 900], smart: [412, 618] };
    for (const [k, [w, h]] of Object.entries(want)) { const d = await fit(k); ok(`fit «${k}»: the page drawn ${w}×${h}`, Math.abs(d.w - w) <= 1 && Math.abs(d.h - h) <= 1, d); }
    ok('fit height in a right-to-left book starts at the right edge', (await fit('height')).x < -100);
    const smartWide = await p.evaluate(() => { const v = window.__krComic.viewer; v.set(2, { transitions: false, scale: 'smart', zoomStart: 'auto', navPan: true, landscapeZoom: false, stripZoom: true, zones: 0, invert: 'none' }); v.goTo(3); return v.drawn(); });
    ok('smart fit: a wide page (1350×900) fills the height', Math.abs(smartWide.h - 915) <= 1 && smartWide.w > 1300, smartWide);
    await fit('fit');
    await p.mouse.dblclick(206, 450); await until(p, () => window.__krComic.viewer.zoom > 1.9, null, 2000);
    ok('a double tap zooms in to 2×', Math.abs((await st(p)).drawn.z - 2) < 0.01, (await st(p)).drawn);
    await p.waitForTimeout(600); await p.mouse.dblclick(206, 450); await until(p, () => window.__krComic.viewer.zoom < 1.01, null, 2000);
    ok('a double tap again zooms back out', (await st(p)).drawn.z === 1);
    // Navigate by pan: fit height (the page wider than the screen), a tap on the next side pans, then turns.
    await fit('height'); await p.waitForTimeout(150);
    const x0 = (await st(p)).drawn.x; s = await tapAt(p, 0.15, 0.5, 'page');
    ok('navigate by pan: zoomed in, the tap moves the page a screen and does not turn', s.page === 0 && s.drawn.x !== x0, { x0, s: s.drawn, page: s.page });
    s = await tapAt(p, 0.15, 0.5); ok('… and at its edge the next tap turns', s.page === 1, s);
    // Landscape zoom: the wide page (4) eases in to fill the height.
    await p.evaluate(() => { const v = window.__krComic.viewer; v.set(2, { transitions: false, scale: 'fit', zoomStart: 'auto', navPan: true, landscapeZoom: true, stripZoom: true, zones: 0, invert: 'none' }); v.goTo(3); });
    const lz0 = (await st(p)).drawn; const filled = await until(p, () => Math.abs(window.__krComic.viewer.drawn().h - innerHeight) < 2, null, 3000);
    ok('landscape zoom: a wide page shown whole, then filling the height', lz0.h < 400 && filled, { lz0, now: (await st(p)).drawn });

    // 5. Tap-zone layouts and inversions (sample points as the reference reader's rectangles have them).
    const zoneCases = await p.evaluate(() => {
      const v = window.__krComic.viewer; const out = [];
      const at = (layout, inv, x, y) => { v.set(2, { transitions: false, scale: 'fit', zoomStart: 'auto', navPan: true, landscapeZoom: false, stripZoom: true, zones: layout, invert: inv }); const r = v.zones().find((z) => x >= z.r[0] && x < z.r[2] && y >= z.r[1] && y < z.r[3]); return r ? r.a : 'menu'; };
      const C = [
        [0, 'none', 0.1, 0.5, 'left'], [0, 'none', 0.9, 0.5, 'right'], [0, 'none', 0.5, 0.5, 'menu'],
        [1, 'none', 0.1, 0.5, 'prev'], [1, 'none', 0.5, 0.1, 'prev'], [1, 'none', 0.9, 0.5, 'next'], [1, 'none', 0.5, 0.9, 'next'], [1, 'none', 0.5, 0.5, 'menu'],
        [2, 'none', 0.7, 0.7, 'next'], [2, 'none', 0.1, 0.7, 'prev'], [2, 'none', 0.5, 0.1, 'menu'],
        [3, 'none', 0.1, 0.5, 'next'], [3, 'none', 0.9, 0.5, 'next'], [3, 'none', 0.5, 0.9, 'prev'], [3, 'none', 0.5, 0.4, 'menu'],
        [4, 'none', 0.1, 0.5, 'left'], [4, 'none', 0.9, 0.5, 'right'], [5, 'none', 0.1, 0.5, 'menu'], [5, 'none', 0.9, 0.9, 'menu'],
        [1, 'h', 0.1, 0.5, 'next'], [1, 'h', 0.9, 0.5, 'prev'], [1, 'v', 0.5, 0.1, 'next'], [1, 'v', 0.5, 0.9, 'prev'], [1, 'both', 0.9, 0.5, 'prev'], [1, 'both', 0.5, 0.1, 'next'],
        [2, 'h', 0.3, 0.7, 'next'], [2, 'h', 0.9, 0.7, 'prev'], [2, 'v', 0.7, 0.3, 'next'], [2, 'both', 0.1, 0.3, 'next'],
        [3, 'v', 0.5, 0.1, 'prev'], [4, 'h', 0.1, 0.5, 'right'],
      ];
      for (const [l, inv, x, y, want] of C) { const got = at(l, inv, x, y); out.push({ l, inv, x, y, want, got }); }
      return out;
    });
    const bad = zoneCases.filter((c) => c.got !== c.want);
    ok(`every tap-zone layout and inversion hit-tested at ${zoneCases.length} sample points`, !bad.length, bad);
    // (And one for real: Kindle-like set in the settings, a tap in its next zone.)
    await visual(p, { comicZonesPaged: 2 }); await reload(p); await open(p, ids.other);
    ok('the zones\' overlay is not shown again', !(await p.$('.cm-zones')));
    s = await tapAt(p, 0.7, 0.7); ok('Kindle-like zones from the settings: a tap low on the right is the next page', s.page === 1, s);
    await visual(p, { comicZonesPaged: 0 }); await reload(p);
    // A long press on a page is told (its menu comes later).
    await open(p, ids.other);
    await p.evaluate(() => { window.__lp = null; document.addEventListener('kr:comic-longpress', (e) => { window.__lp = e.detail; }, { once: true }); });
    await p.mouse.move(206, 450); await p.mouse.down(); await until(p, () => !!window.__lp, null, 2000); await p.mouse.up();
    ok('a long press on a page is told (kr:comic-longpress)', !!(await p.evaluate(() => window.__lp)), await p.evaluate(() => window.__lp));

    // 6. The place, the end, the next volume.
    await open(p, ids.v1);
    await p.evaluate(() => window.__krComic.viewer.goTo(5)); await stored(p, ids.v1, (b) => b?.progress?.page === 6);
    await open(p, ids.v1); s = await st(p);
    ok('opened again at the page it was left (6 of 12)', s.page === 5, s);
    const b1c = await bookOf(p, ids.v1); ok('the place kept as the page in the progress store', b1c.progress?.page === 6 && Math.abs(b1c.progress.pct - 0.5) < 0.01, b1c.progress);
    const chapters = await p.evaluate(() => window.__krComic.source.chapters.map((c) => c.label + '@' + c.start));
    ok('the archive\'s folders are its chapters', JSON.stringify(chapters) === JSON.stringify(['Chapter 01@0', 'Chapter 02@5']), chapters);
    await p.keyboard.press('End'); await until(p, () => window.__krComic.viewer.itemKind === 'after', null, 2000);
    const tr = await p.evaluate(() => { const c = document.querySelector('.cm-current .cm-between-card'); return c ? { text: c.textContent, open: !!c.querySelector('.cm-open-volume') } : null; });
    ok('after the last page: «Finished: …» and the next volume with an open button', !!tr && tr.text.includes(W.finished) && /Vol\. 2/.test(tr.text) && tr.open, tr);
    if (SHOTS) { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, 'S5a-transition.png') }); }
    await stored(p, ids.v1, (b) => b?.progress?.pct === 1);
    { const pr = (await bookOf(p, ids.v1)).progress; ok('the end reached: the book is read to its end (finished, as other books)', pr?.pct === 1, { pr, st: await st(p) }); }
    await p.click('.cm-current .cm-open-volume');
    await until(p, (id) => location.hash.includes(id) && window.__krComic && window.__krComic.viewer.total === 3, ids.v2, 8000);
    ok('the open button opens the next volume', (await p.evaluate(() => location.hash)).includes(ids.v2));
    const before = await p.evaluate(() => { const v = window.__krComic.viewer; return { first: v.itemKind, text: document.querySelector('.cm-between-card')?.textContent ?? '' }; });
    // (Volume 2 starts at its first page; the page before it — the volume before — lies one step back.)
    await p.evaluate(() => window.__krComic.viewer.goFirst()); await until(p, () => window.__krComic.viewer.itemKind === 'before', null, 3000);
    const bt = await p.evaluate(() => document.querySelector('.cm-current .cm-between-card')?.textContent ?? '');
    ok('before the first page of volume 2: the previous volume, to open', /Vol\. 1/.test(bt), { before, bt });

    // 8. The settings panel (a phone: the zones, no keys' list).
    await open(p, ids.other); await dismissZones(p);
    await p.click('.reader-view', { position: { x: 206, y: 450 } }).catch(() => undefined);
    await until(p, () => !document.querySelector('.reader-view').classList.contains('immersive'), null, 2000);
    await p.click('.cm-settings-btn'); await p.waitForSelector('.panel.open [data-key="comicMode"]', { timeout: 5000 });
    const modeTab = await p.evaluate(() => ({ book: !!document.querySelector('.panel.open [data-key="comicBookMode"]'), zones: !!document.querySelector('.panel.open [data-key="comicZonesPaged"]'), show: !!document.querySelector('.panel.open .cm-show-zones'), keys: !!document.querySelector('.panel.open .cm-keys-hint'), switches: document.querySelectorAll('.panel.open .switch input').length }));
    ok('settings «Reading mode»: this book\'s mode, the default, the tap zones, «Show the zones», switches', modeTab.book && modeTab.zones && modeTab.show && modeTab.switches >= 4, modeTab);
    if (SHOTS) { await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, 'S5a-settings-mode.png') }); }
    await p.evaluate((g) => [...document.querySelectorAll('.panel.open .panel-tabs button, .panel.open [role="tab"]')].find((b) => b.textContent.trim() === g)?.click(), W.general);
    await p.waitForSelector('.panel.open [data-key="comicScale"]', { timeout: 3000 });
    const gen = await p.evaluate(() => ({ keys: !!document.querySelector('.panel.open .cm-keys-hint'), scale: !!document.querySelector('.panel.open [data-key="comicScale"]'), between: !!document.querySelector('.panel.open [data-key="comicBetween"]'), awake: !!document.querySelector('.panel.open [data-key="keepAwake"]') }));
    ok('settings «General»: fit, page between volumes, the screen kept on; no keys\' list on a phone', gen.scale && gen.between && gen.awake && !gen.keys, gen);
    if (SHOTS) { await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, 'S5a-settings-general.png') }); }
    // Fit width chosen in the panel: the viewer follows.
    await p.click('.panel.open [data-key="comicScale"]'); await p.waitForSelector('.sheet .dest-row');
    await p.evaluate(() => [...document.querySelectorAll('.sheet .dest-row')][2].click());
    ok('fit width chosen in the panel: kept in the settings', await until(p, () => JSON.parse(localStorage.getItem('kr.visual')).comicScale === 'width', null, 2000));
    await p.evaluate(() => document.querySelector('.panel.open .panel-head .icon-btn')?.click());
    await visual(p, { comicScale: 'fit' }); await reload(p);
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body .card', { state: 'attached', timeout: 15000 });
    ok('Settings → Reader has the Comics group', await until(p, (w) => [...document.querySelectorAll('.cm-group-head')].some((x) => x.textContent === w) && !!document.querySelector('.cm-settings-group [data-key="comicOldWay"]'), W.comics, 5000));
    // «Open comics the old way».
    await visual(p, { comicOldWay: true }); await reload(p);
    await open(p, ids.other, false);
    ok('«Open comics the old way»: the flow reader, as before', !(await p.$('.cm-view')) && (await p.$$('.reader-view .kr-content img:not(.kr-img-failed)')).length === 5);
    await visual(p, { comicOldWay: false }); await reload(p);
  });

  /* ---------------------------------------------------------------- computer */
  await session(false, async (p) => {
    const ids = await importBooks(p, [files.v1, files.v2, files.other], 3);
    await open(p, ids.other);
    ok('a computer: no tap-zone overlay', !(await p.$('.cm-zones')));
    let s = await st(p); ok('a computer: right to left, page 1', s.rtl && s.page === 0, s);
    s = await key(p, 'ArrowLeft'); ok('a computer: ← is the next page (right to left)', s.page === 1, s);
    s = await key(p, 'ArrowRight'); ok('a computer: → is the previous page', s.page === 0, s);
    s = await key(p, 'PageDown'); ok('a computer: Page Down is the next page', s.page === 1, s);
    s = await key(p, 'PageUp'); ok('a computer: Page Up is the previous page', s.page === 0, s);
    s = await key(p, 'Space'); ok('a computer: Space is the next page', s.page === 1, s);
    s = await key(p, 'Shift+Space', 'page'); ok('a computer: Shift+Space is the previous page', s.page === 0, s);
    s = await key(p, 'End', 'item'); ok('a computer: End goes to the end', s.page === 4, s);
    s = await key(p, 'Home', 'item'); ok('a computer: Home goes to the first page', s.page === 0, s);
    await p.mouse.move(640, 400);
    for (let i = 0; i < 4; i++) await p.mouse.wheel(0, 60);
    await until(p, () => window.__krComic.viewer.page === 1, null, 1500); await p.waitForTimeout(400);
    s = await st(p); ok('a computer: one group of wheel notches turns one page', s.page === 1, s);
    s = await tapAt(p, 0.1, 0.5); ok('a computer: a click on the left is the next page (right to left)', s.page === 2, s);
    if (SHOTS) { await noToast(p); await p.evaluate(() => document.querySelector('.reader-view').classList.remove('immersive')); await p.waitForTimeout(700); await p.screenshot({ path: path.join(SHOTS, 'S5a-paged-pc.png') }); }
    await p.evaluate(() => document.querySelector('.reader-view').classList.remove('immersive'));
    await p.click('.cm-settings-btn'); await p.waitForSelector('.panel.open [data-key="comicMode"]', { timeout: 5000 });
    const mt = await p.evaluate(() => ({ zones: !!document.querySelector('.panel.open [data-key="comicZonesPaged"]'), show: !!document.querySelector('.panel.open .cm-show-zones') }));
    ok('a computer: no tap-zone options', !mt.zones && !mt.show, mt);
    await p.evaluate((g) => [...document.querySelectorAll('.panel.open .panel-tabs button, .panel.open [role="tab"]')].find((b) => b.textContent.trim() === g)?.click(), W.general);
    ok('a computer: the keys\' list in «General»', await until(p, () => !!document.querySelector('.panel.open .cm-keys-hint'), null, 3000));
  });

  /* ---------------------------------------------------------------- a big archive */
  if (BIG_MB > 0) await session(true, async (p) => {
    const big = path.join(TMP, 'Long Archive.cbz');
    // (300 pages, each a made-up page with random rows added to make the archive about BIG_MB.)
    fs.writeFileSync(big, await makeCbz({ pages: 300, width: 500, height: 750, noise: Math.round((BIG_MB * 1e6) / 300) - 3e4, store: true }));
    const mb = Math.round(fs.statSync(big).size / 1e6);
    const t0 = Date.now(); const ids = await importBooks(p, [big], 1); const imp = Date.now() - t0;
    ok(`the ${mb} MB, 300-page archive is imported (${imp} ms)`, !!ids.big, ids);
    await visual(p, {}); await p.evaluate(() => localStorage.setItem('kr.comicZonesSeen', '1'));
    await open(p, ids.big);
    let s = await st(p);
    console.log(`  numbers: first page shown ${s.openMs} ms after the open began; decoded ${s.decoded}, object URLs ${s.urls}`);
    ok('the first page shown within 600 ms', s.openMs > 0 && s.openMs < 600, s.openMs);
    let worst = 0, worstUrls = 0;
    for (let i = 0; i < 12; i++) { await p.keyboard.press('ArrowLeft'); await until(p, (n) => window.__krComic.viewer.page === n, i + 1, 3000); await until(p, () => [...document.querySelectorAll('.cm-slot img.cm-img')].every((i) => i.getAttribute('src')), null, 2000); s = await st(p); worst = Math.max(worst, s.decoded); worstUrls = Math.max(worstUrls, s.urls); }
    console.log(`  numbers: one page per screen over 12 turns: at most ${worst} decoded pictures, ${worstUrls} object URLs`);
    ok('one page per screen: never more than 6 decoded pictures nor 6 object URLs', worst <= 6 && worstUrls <= 6, { worst, worstUrls });
    await p.evaluate(() => { window.__krComic.viewer.set(4, { transitions: false, scale: 'fit', zoomStart: 'auto', navPan: true, landscapeZoom: false, stripZoom: true, zones: 0, invert: 'none' }); });
    let most = 0, mostUrls = 0;
    for (let i = 0; i < 25; i++) { await p.evaluate(() => { document.querySelector('.cm-scroll').scrollTop += 2400; }); await p.waitForTimeout(60); s = await st(p); most = Math.max(most, s.domImgs); mostUrls = Math.max(mostUrls, s.urls); }
    await p.evaluate(() => window.__krComic.viewer.goTo(250)); await p.waitForTimeout(400); s = await st(p); most = Math.max(most, s.domImgs);
    console.log(`  numbers: long strip scrolled through: at most ${most} pictures in the page, ${mostUrls} object URLs; at page ${s.page + 1}`);
    ok('the strip keeps only the pictures near the screen in the page', most <= 12 && mostUrls <= 12, { most, mostUrls });
    ok('the strip went to page 251 by its learned heights', Math.abs(s.page - 250) <= 1, s.page);
  });

  console.log(fails ? `${fails} FAILED` : 'all passed');
  server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
