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
// Part 2 (0.67.0, S5b): the repairs (the slider's fill in a right-to-left book — the rule and the pixels —, the page count
//  once, the zones' overlay and the pill, the arrow of the page between volumes); wide pages (split in LTR and RTL and
//  reversed, the counts and the place kept across the setting, rotate, two pages side by side: the cover alone, a wide page
//  alone, shift by one page, «on wide screens» on a turned viewport); borders trimmed (within 2 px on white and on black, not an
//  animated GIF, the 45 % cap, the strip's own setting, the bar's button); the background (grey, white, automatic by the
//  border); colour (brightness, greyscale, inversion, the blended tint, the bars not covered, the third tab); the page's menu
//  (save through the app's save, cover set and undone, the whole page or as shown, off when set off, the right click on a
//  computer); the strip (an 800×40,000 page as 10 slices, every part sharp at its own size, the pixels held at most, side
//  padding, zooming out and its switch, wide pages stacked); the rotation lock (a phone's); the pair at 1280×800 and 1920×1080.
// Screenshots (KR_SHOTS=<dir>; KR_DSF=2 for a phone at twice the pixels): S5b-paged-rtl, S5b-split, S5b-crop-before-after,
// S5b-colour-tab, S5b-wide-settings, S5b-longpress, S5b-strip, S5b-spread-phone, S5b-spread-pc;
// S5a-paged-rtl, S5a-strip, S5a-settings-mode, S5a-settings-general, S5a-zones-overlay,
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
  const ctx = await br.newContext(phone ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: Number(process.env.KR_DSF ?? 1), isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: LANG, colorScheme: 'dark' } : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: LANG, colorScheme: 'dark' });
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

  /* ---------------------------------------------------------------- 0.67.0 part 2 (S5b): wide pages, borders, colour, the page's menu, the long strip */
  const extra = {
    crop: path.join(TMP, 'Crop Test.cbz'), tall: path.join(TMP, 'Tall Strip.cbz'),
  };
  // Crop test: 300×400 pages — 1 plain, 2 white borders, 3 black borders, 4 an animated GIF, 5 nearly nothing but a speck.
  fs.writeFileSync(extra.crop, await makeCbz({ pages: 5, width: 300, height: 400, bordered: [2], blackBordered: [3], gif: [4], faint: [5] }));
  // The tall book: a normal page, then one 800×40,000 px.
  fs.writeFileSync(extra.tall, await makeCbz({ pages: 2, width: 800, height: 1200, strip: [2] }));
  const ids2 = (books) => { const f = (re) => books.find((b) => re.test(b.fileName || b.title))?.id; return { v1: f(/Lantern Comic Vol\. 1/), v2: f(/Lantern Comic Vol\. 2/), crop: f(/Crop Test/), tall: f(/Tall Strip/) }; };
  const iconHas = (p, sel, frag) => p.evaluate(([sel, frag]) => !!document.querySelector(sel)?.innerHTML.includes(frag), [sel, frag]);
  const track = (p) => p.evaluate(() => getComputedStyle(document.querySelector('.cm-slider'), '::-webkit-slider-runnable-track').backgroundImage);
  const display = (p) => p.evaluate(() => { const v = window.__krComic.viewer; return { n: v.displayPos, total: v.displayTotal, page: v.page, count: document.querySelector('.cm-bar .pcount').textContent, max: document.querySelector('.cm-slider').max }; });
  const onShow = (p) => p.evaluate(() => [...document.querySelectorAll('.cm-current .cm-part')].map((e) => ({ page: Number(e.dataset.page), x: Math.round(e.getBoundingClientRect().left) })));
  const bars = (p, on) => p.evaluate((on) => document.querySelector('.reader-view').classList[on ? 'remove' : 'add']('immersive'), on);
  const importAll = async (p, list, want) => { await p.setInputFiles('.library-view input[type=file]', list); let books = []; for (let i = 0; i < 600; i++) { books = await allBooks(p); if (books.length >= want) break; await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); await p.waitForTimeout(250); } return ids2(books); };
  const settle2 = (p) => p.waitForTimeout(250);
  const sized = async (p) => { await until(p, () => window.__krComic.source.pages.every((x) => x.width && x.height), null, 10000); await p.waitForTimeout(300); };
  const ensureTotal = (p, n) => until(p, (n) => window.__krComic.viewer.displayTotal === n, n, 8000);

  await session(true, async (p) => {
    const ids = await importAll(p, [files.v1, files.v2, extra.crop, extra.tall], 4);
    ok('S5b: the books are imported', ids.v1 && ids.v2 && ids.crop && ids.tall, ids);
    await p.evaluate(() => localStorage.setItem('kr.comicZonesSeen', '1'));

    // ---- Part 0: the repairs
    await open(p, ids.v1);
    await p.evaluate(() => window.__krComic.viewer.goTo(2)); await settle2(p); await bars(p, true);
    await noToast(p); await p.waitForTimeout(500);
    // (A slider's track is a shadow part whose computed style the browser does not give: the rule that paints it is read, and
    // the pixels are looked at.)
    const rule = (p, dir) => p.evaluate((dir) => { const out = []; for (const sh of document.styleSheets) { let rs; try { rs = sh.cssRules; } catch { continue; } for (const r of rs) if (r.selectorText && r.selectorText.includes('.cm-slider::-webkit-slider-runnable-track') && r.selectorText.includes(`data-dir="${dir}"`)) out.push(r.style.background || r.style.backgroundImage); } return out.join(' | '); }, dir);
    const g1 = await rule(p, 'rtl');
    ok('0a: the rule for a right-to-left book fills the track from the right (to left)', /to left/.test(g1), g1);
    ok('0a: …and the slider\'s direction is right to left', await p.evaluate(() => getComputedStyle(document.querySelector('.cm-slider')).direction) === 'rtl');
    const thumb = await p.evaluate(() => { const s = document.querySelector('.cm-slider'); return { p: s.style.getPropertyValue('--p'), v: s.value, max: s.max }; });
    ok('0a: the fill ends at the thumb (page 3 of 12)', Math.abs(parseFloat(thumb.p) - (2 / 11) * 100) < 0.5, thumb);
    const px = await p.evaluate(() => { const s = document.querySelector('.cm-slider'); const r = s.getBoundingClientRect(); return { l: r.left + 6, r: r.right - 6, y: r.top + r.height / 2 }; });
    const shot = await p.screenshot({ clip: { x: px.l - 4, y: px.y - 6, width: px.r - px.l + 8, height: 12 } });
    const pixels = await p.evaluate(async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const at = (x) => [...g.getImageData(x, img.height >> 1, 1, 1).data].slice(0, 3);
      const probe = (v) => { const d = document.createElement('div'); d.style.background = `var(${v})`; document.body.append(d); const c2 = getComputedStyle(d).backgroundColor; d.remove(); return c2.match(/\d+/g).slice(0, 3).map(Number); };
      return { left: at(8), right: at(img.width - 8), primary: probe('--md-primary'), rest: probe('--md-secondary-container') }; }, shot.toString('base64'));
    const nearRgb = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 8);
    if (SHOTS) { await noToast(p); await p.screenshot({ path: path.join(SHOTS, 'S5b-paged-rtl.png') }); }
    ok('0a: by pixels the right end of the track (the part read) is the fill colour and the left end the rest', nearRgb(pixels.right, pixels.primary) && nearRgb(pixels.left, pixels.rest), pixels);
    await setMode(p, 4); await settle(p);
    await p.waitForTimeout(500); ok('0a: in the strip the rule fills from the left (to right)', /to right/.test(await rule(p, 'ltr')) && (await p.evaluate(() => document.querySelector('.cm-bar').dataset.dir)) === 'ltr', await rule(p, 'ltr'));
    await setMode(p, 0);
    // 0b: the count once.
    await bars(p, true); await settle(p);
    const once = await p.evaluate(() => ({ pill: getComputedStyle(document.querySelector('.cm-pnum')).display, bar: document.querySelector('.cm-bar .pcount').textContent }));
    ok('0b: with the bars up the count is in the bar only, not on a pill over the page', once.pill === 'none' && /\d+ \/ 12/.test(once.bar), once);
    await bars(p, false); await settle(p);
    const hidden = await p.evaluate(() => { const e = document.querySelector('.cm-pnum'); return { pill: getComputedStyle(e).display, text: e.textContent }; });
    ok('0b: with the bars hidden the pill shows it', hidden.pill !== 'none' && /\d+ \/ 12/.test(hidden.text), hidden);
    // 0c: the zones' overlay and the pill.
    await p.evaluate(() => localStorage.removeItem('kr.comicZonesSeen')); await open(p, ids.v1);
    await until(p, () => !!document.querySelector('.cm-zones'), null, 3000);
    const zr = await p.evaluate(() => { const hint = document.querySelector('.cm-zones-hint').getBoundingClientRect(); const pill = document.querySelector('.cm-pnum'); const labels = [...document.querySelectorAll('.cm-zones span')].map((e) => e.getBoundingClientRect()); const hit = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top); return { pill: getComputedStyle(pill).display, hint: { top: Math.round(hint.top), bottom: Math.round(hint.bottom) }, vh: innerHeight, over: labels.some((l) => hit(l, hint)), rb: !!document.querySelector('.reader-readbar:not([hidden])') }; });
    ok('0c: under the zones\' overlay the page-number pill is hidden and the hint is inside the screen, clear of the zone names', zr.pill === 'none' && zr.hint.bottom <= zr.vh && !zr.over, zr);
    await p.evaluate(() => localStorage.setItem('kr.comicZonesSeen', '1')); await dismissZones(p);
    // 0d: the arrow of the page between volumes.
    await p.evaluate(() => window.__krComic.viewer.goLast()); await until(p, () => window.__krComic.viewer.itemKind === 'after', null, 2000);
    ok('0d: right to left: the open button points left', await iconHas(p, '.cm-current .cm-open-volume', 'M19 12H5'));
    await setMode(p, 1); await p.evaluate(() => window.__krComic.viewer.goLast()); await until(p, () => window.__krComic.viewer.itemKind === 'after', null, 2000);
    ok('0d: left to right: it points right', await iconHas(p, '.cm-current .cm-open-volume', 'M5 12h14'));
    await setMode(p, 3); await p.evaluate(() => window.__krComic.viewer.goLast()); await until(p, () => window.__krComic.viewer.itemKind === 'after', null, 2000);
    ok('0d: vertical: it points down', await iconHas(p, '.cm-current .cm-open-volume', 'M12 5v14'));
    await setMode(p, 0);

    // ---- Part A: split, reverse, rotate (page 4 of Vol. 1 is wide: 1350×900)
    await visual(p, { comicSplit: true }); await reload(p); await open(p, ids.v1);
    ok('A: split: 12 pages with one wide page count 13', await ensureTotal(p, 13), await display(p));
    let pcs = await p.evaluate(() => window.__krComic.viewer.piecesOf(3).map((x) => x.piece.crop));
    ok('A: split, right to left: the right half is read first', pcs.length === 2 && pcs[0][0] === 0.5 && pcs[1][0] === 0, pcs);
    await p.evaluate(() => window.__krComic.viewer.goToDisplay(4)); await bars(p, false); await p.waitForTimeout(700);
    if (SHOTS) { await noToast(p); await p.screenshot({ path: path.join(SHOTS, 'S5b-split.png') }); }
    await p.evaluate(() => window.__krComic.viewer.goToDisplay(5)); await settle2(p);
    let d = await display(p); ok('A: the second half is its own page (5 of 13), the source page 4', d.n === 5 && d.page === 3 && d.count === '5 / 13' && d.max === '13', d);
    await stored(p, ids.v1, (b) => b?.progress?.page === 4);
    await visual(p, { comicSplit: false }); await reload(p); await open(p, ids.v1);
    d = await display(p); ok('A: split turned off: the place is the same source page (4 of 12)', d.page === 3 && d.n === 4 && d.total === 12, d);
    await visual(p, { comicSplit: true }); await reload(p); await open(p, ids.v1); await ensureTotal(p, 13);
    d = await display(p); ok('A: split turned on again: back on page 4, its first half', d.page === 3 && d.n === 4, d);
    await setMode(p, 1); await settle(p); await ensureTotal(p, 13);
    pcs = await p.evaluate(() => window.__krComic.viewer.piecesOf(3).map((x) => x.piece.crop));
    ok('A: split, left to right: the left half is read first', pcs[0][0] === 0 && pcs[1][0] === 0.5, pcs);
    await setMode(p, 0);
    await visual(p, { comicSplit: true, comicSplitInvert: true }); await reload(p); await open(p, ids.v1); await ensureTotal(p, 13);
    pcs = await p.evaluate(() => window.__krComic.viewer.piecesOf(3).map((x) => x.piece.crop));
    ok('A: reverse the halves (right to left): the left half first', pcs[0][0] === 0 && pcs[1][0] === 0.5, pcs);
    // Rotate (wins over split).
    await visual(p, { comicSplit: true, comicSplitInvert: false, comicRotate: true }); await reload(p); await open(p, ids.v1);
    await p.evaluate(() => window.__krComic.viewer.goTo(3)); await settle2(p);
    pcs = await p.evaluate(() => window.__krComic.viewer.piecesOf(3).map((x) => x.piece.rotate));
    d = await display(p);
    ok('A: rotate to fit: one piece, turned a quarter (and it wins over the split, as in the reference reader)', pcs.length === 1 && pcs[0] === 1 && d.total === 12, { pcs, d });
    const rot = await p.evaluate(() => { const el = document.querySelector('.cm-current .cm-rot'); const cs = el && getComputedStyle(el).transform; return { transform: cs, drawn: window.__krComic.viewer.drawn() }; });
    ok('A: …drawn turned, and filling the screen\'s width as a portrait page', /matrix\(0, 1, -1, 0/.test(rot.transform) && Math.abs(rot.drawn.w - 412) <= 1 && rot.drawn.h > 600, rot);
    await visual(p, { comicSplit: false, comicRotate: true, comicRotateInvert: true }); await reload(p); await open(p, ids.v1);
    pcs = await p.evaluate(() => window.__krComic.viewer.piecesOf(3).map((x) => x.piece.rotate)); ok('A: rotate the other way: three quarters', pcs[0] === 3, pcs);
    await visual(p, { comicRotate: false, comicRotateInvert: false });

    // Spreads: two pages side by side.
    await visual(p, { comicDual: 'always' }); await reload(p); await open(p, ids.v1); await bars(p, false);
    await sized(p);
    const seq = async () => { await p.evaluate(() => window.__krComic.viewer.goTo(0)); await settle2(p); const out = []; for (let i = 0; i < 9; i++) { out.push((await onShow(p)).map((x) => x.page).join('+')); const b = await st(p); await p.evaluate(() => window.__krComic.viewer.step(1, { pan: false })); await until(p, (it) => window.__krComic.viewer.item !== it, b.item, 1500); } return out; };
    let sq = await seq();
    ok('A: two pages side by side: the cover alone, then pairs; a wide page (4) alone; the pairing starts again after it', JSON.stringify(sq.slice(0, 6)) === JSON.stringify(['0', '1+2', '3', '4+5', '6+7', '8+9']), sq);
    await p.evaluate(() => window.__krComic.viewer.goTo(1)); await settle2(p);
    const pos = await onShow(p); ok('A: right to left: the first page of a pair stands on the right', pos.length === 2 && pos[0].page === 1 && pos[0].x > pos[1].x, pos);
    if (SHOTS) { await noToast(p); await p.screenshot({ path: path.join(SHOTS, 'S5b-spread-phone.png') }); }
    // Shift by one page (in the bar; kept per book).
    await bars(p, true); await p.click('.cm-shift-btn'); await settle2(p); await bars(p, false);
    sq = await seq(); ok('A: shift by one page: the cover pairs with the next, the pairing is off by one', sq[0] === '0+1' && sq[1] === '2' && sq[2] === '3', sq);
    ok('A: …kept with the book', (await bookOf(p, ids.v1)).prefs?.comicShift === 1);
    await p.evaluate(() => { document.querySelector('.reader-view').classList.remove('immersive'); }); await p.click('.cm-shift-btn'); await settle2(p);
    // «On wide screens»: a portrait phone no, a turned one yes.
    await visual(p, { comicDual: 'wide' }); await reload(p); await open(p, ids.v1); await p.evaluate(() => window.__krComic.viewer.goTo(1)); await settle2(p);
    ok('A: «on wide screens»: a portrait screen shows one page', (await onShow(p)).length === 1);
    await p.setViewportSize({ width: 915, height: 412 }); await until(p, () => document.querySelectorAll('.cm-current .cm-part').length === 2, null, 4000);
    ok('A: …turned on its side it shows two', (await onShow(p)).length === 2, await onShow(p));
    await p.setViewportSize({ width: 412, height: 915 }); await until(p, () => document.querySelectorAll('.cm-current .cm-part').length === 1, null, 4000);
    ok('A: …turned back, one again', (await onShow(p)).length === 1);
    await visual(p, { comicDual: 'never' }); await reload(p);

    // ---- Part B: crop borders (300×400 pages)
    await open(p, ids.crop);
    const crops = async (n) => { await p.evaluate((n) => window.__krComic.viewer.goTo(n), n); await settle2(p); return p.evaluate((n) => ({ b: window.__krComic.viewer.borderOf(n), c: window.__krComic.viewer.piecesOf(n)[0].piece.crop }), n); };
    let c = await crops(1); ok('B: off: nothing is measured and the page is shown whole', !c.b && c.c.join() === '0,0,1,1', c);
    await visual(p, { comicCrop: true }); await reload(p); await open(p, ids.crop);
    c = await crops(1);
    ok('B: a page with white borders: trimmed to within 2 px of its picture (36 px margin)', await until(p, () => !!window.__krComic.viewer.borderOf(1), null, 3000), c);
    c = await crops(1);
    const near = (box, W, H) => Math.abs(box[0] * W - 36) <= 2 && Math.abs(box[1] * H - 36) <= 2 && Math.abs((box[0] + box[2]) * W - (W - 36)) <= 2 && Math.abs((box[1] + box[3]) * H - (H - 36)) <= 2;
    ok('B: white borders: the rectangle is the picture to within 2 px', near(c.c, 300, 400) && c.b.edge === 'white', c);
    await until(p, () => !!window.__krComic.viewer.borderOf(2), null, 1); c = await crops(2); await until(p, () => !!window.__krComic.viewer.borderOf(2), null, 3000); c = await crops(2);
    ok('B: black borders: the same, to within 2 px', near(c.c, 300, 400) && c.b?.edge === 'black', c);
    c = await crops(3); await settle2(p); c = await crops(3);
    ok('B: an animated GIF is not trimmed', !c.b && c.c.join() === '0,0,1,1', c);
    await crops(4); await until(p, () => !!window.__krComic.viewer.borderOf(4), null, 3000); c = await crops(4);
    ok('B: a page of nearly nothing: no axis loses more than 45 %', c.c[2] >= 0.549 && c.c[3] >= 0.549, c);
    const meas = await p.evaluate(() => { const b = window.__krComic.viewer.borderOf(1); return { b }; });
    ok('B: the measurement is kept for the page (asked again, the same)', JSON.stringify((await crops(1)).b) === JSON.stringify(meas.b));
    const imgRect = await p.evaluate(() => { const part = document.querySelector('.cm-current .cm-part'); const img = part.querySelector('img'); return { w: part.getBoundingClientRect().width, h: part.getBoundingClientRect().height, iw: img.getBoundingClientRect().width, ih: img.getBoundingClientRect().height }; });
    await p.evaluate(() => window.__krComic.viewer.goTo(1)); await settle2(p);
    const shown = await p.evaluate(() => { const part = document.querySelector('.cm-current .cm-part'); const img = part.querySelector('img'); const a = part.getBoundingClientRect(), b = img.getBoundingClientRect(); return { part: [a.width, a.height], img: [b.width, b.height] }; });
    ok('B: the page drawn cut to its rectangle (the picture larger than the part showing it)', shown.img[0] > shown.part[0] * 1.2 && shown.img[1] > shown.part[1] * 1.1, { shown, imgRect });
    if (SHOTS) {
      await p.evaluate(() => window.__krComic.viewer.goTo(1)); await bars(p, false); await settle(p); await p.waitForTimeout(500); await noToast(p);
      const after = await p.screenshot(); fs.writeFileSync(path.join(TMP, 'crop-after.png'), after);
      await visual(p, { comicCrop: false }); await reload(p); await open(p, ids.crop); await p.evaluate(() => window.__krComic.viewer.goTo(1)); await bars(p, false); await p.waitForTimeout(600); await noToast(p);
      const before = await p.screenshot(); fs.writeFileSync(path.join(TMP, 'crop-before.png'), before);
      const both = await p.evaluate(async ([a, b]) => { const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; }; const A = await load(a), B = await load(b); const c = document.createElement('canvas'); c.width = A.width * 2 + 20; c.height = A.height; const g = c.getContext('2d'); g.fillStyle = '#222'; g.fillRect(0, 0, c.width, c.height); g.drawImage(B, 0, 0); g.drawImage(A, A.width + 20, 0); return c.toDataURL('image/png').split(',')[1]; }, [after.toString('base64'), before.toString('base64')]);
      fs.writeFileSync(path.join(SHOTS, 'S5b-crop-before-after.png'), Buffer.from(both, 'base64'));
      await visual(p, { comicCrop: false }); await reload(p); await open(p, ids.crop);
    }
    // The strip's own setting; the quick toggle.
    await visual(p, { comicCrop: true, comicCropStrip: false, comicMode: 4 }); await reload(p); await open(p, ids.crop);
    await p.evaluate(() => window.__krComic.viewer.goTo(1)); await settle2(p);
    ok('B: the strip has its own setting: off there, the pages whole', (await p.evaluate(() => window.__krComic.viewer.piecesOf(1)[0].piece.crop.join())) === '0,0,1,1');
    await bars(p, true); await p.click('.cm-crop-btn'); await until(p, () => JSON.parse(localStorage.getItem('kr.visual')).comicCropStrip === true, null, 2000);
    ok('B: the quick button in the bar turns the strip\'s borders on', JSON.parse(await p.evaluate(() => localStorage.getItem('kr.visual'))).comicCropStrip === true);
    ok('B: …and shows pressed', (await p.getAttribute('.cm-crop-btn', 'aria-pressed')) === 'true');
    await visual(p, { comicCrop: false, comicCropStrip: false, comicMode: 2 });

    // Background «Automatic»: the border sampled.
    await visual(p, { comicBackground: 'auto', comicMode: 2 }); await reload(p); await open(p, ids.crop);
    const bg = () => p.evaluate(() => getComputedStyle(document.querySelector('.cm-view')).backgroundColor);
    await p.evaluate(() => window.__krComic.viewer.goTo(1)); await until(p, () => window.__krComic.viewer.borderOf(1)?.edge === 'white', null, 4000); await settle2(p);
    ok('F: background «Automatic»: a white-bordered page gives white', (await bg()) === 'rgb(255, 255, 255)', await bg());
    await p.evaluate(() => window.__krComic.viewer.goTo(2)); await until(p, () => window.__krComic.viewer.borderOf(2)?.edge === 'black', null, 4000); await settle2(p);
    ok('F: …a black-bordered page gives dark', (await bg()) === 'rgb(0, 0, 0)', await bg());
    await visual(p, { comicBackground: 'grey' }); await reload(p); await open(p, ids.crop); ok('F: grey', (await bg()) === 'rgb(74, 74, 74)', await bg());
    await visual(p, { comicBackground: 'white' }); await reload(p); await open(p, ids.crop); ok('F: white', (await bg()) === 'rgb(255, 255, 255)', await bg());
    await visual(p, { comicBackground: 'black' });

    // ---- Part C: colour
    await visual(p, { comicBrightOn: true, comicBrightness: -50, comicGrey: true, comicInvertColours: true, comicTintOn: true, comicTintR: 40, comicTintG: 90, comicTintB: 200, comicTintA: 128, comicTintBlend: 'multiply' });
    await reload(p); await open(p, ids.v1); await bars(p, true); await settle(p);
    const col = await p.evaluate(() => { const q = (s) => document.querySelector(s); const cs = (e) => getComputedStyle(e); const bar = q('.cm-bar').getBoundingClientRect(); const at = document.elementFromPoint(bar.left + bar.width / 2, bar.top + bar.height / 2); const top = document.elementFromPoint(40, 30);
      return { dim: cs(q('.cm-dim')).opacity, dimOn: cs(q('.cm-dim')).display, filter: cs(q('.cm-track')).filter, blend: cs(q('.cm-tint')).mixBlendMode, tint: cs(q('.cm-tint')).backgroundColor, barOk: !!at?.closest('.cm-bar'), topOk: !!top?.closest('.topbar'), pe: cs(q('.cm-tint')).pointerEvents }; });
    ok('C: custom brightness below 0 darkens with a black layer (−50: half)', col.dimOn !== 'none' && Math.abs(Number(col.dim) - 0.5) < 0.01, col);
    ok('C: greyscale and inverted colours are a filter on the pages', /grayscale\(1\)/.test(col.filter) && /invert\(1\)/.test(col.filter), col.filter);
    ok('C: the colour filter is a blended layer (multiply) of the colour mixed', col.blend === 'multiply' && /rgba\(40, 90, 200, 0\.5/.test(col.tint), col);
    ok('C: …that does not cover the bars (they are above it, and it takes no touch)', col.barOk && col.topOk && col.pe === 'none', col);
    await visual(p, { comicBrightness: 40, comicGrey: false, comicInvertColours: false, comicTintOn: false }); await reload(p); await open(p, ids.v1);
    const up = await p.evaluate(() => ({ filter: getComputedStyle(document.querySelector('.cm-track')).filter, dim: getComputedStyle(document.querySelector('.cm-dim')).display }));
    ok('C: above 0 (no device brightness here): the pages lightened by a CSS brightness', /brightness\(1\.4/.test(up.filter) && up.dim === 'none', up);
    // The tab.
    await visual(p, { comicBrightOn: true, comicBrightness: 20, comicTintOn: true }); await reload(p); await open(p, ids.v1); await bars(p, true);
    await p.click('.cm-settings-btn'); await p.waitForSelector('.panel.open [data-key="comicMode"]', { timeout: 5000 });
    ok('C: the settings sheet has a third tab «Colour filter»', await p.evaluate(() => document.querySelectorAll('.panel.open .panel-tabs button').length === 3));
    await p.evaluate(() => [...document.querySelectorAll('.panel.open .panel-tabs button')][2].click()); await p.waitForSelector('.panel.open [data-key="comicTintR"]', { timeout: 4000 });
    const tab = await p.evaluate(() => ({ ranges: [...document.querySelectorAll('.panel.open input[type=range]')].map((r) => ({ k: r.dataset.key, p: r.style.getPropertyValue('--p'), min: r.min, max: r.max })), switches: document.querySelectorAll('.panel.open .switch input').length, blend: !!document.querySelector('.panel.open [data-key="comicTintBlend"]'), presets: document.querySelectorAll('.panel.open .preset, .panel.open [data-preset]').length }));
    ok('C: sliders: brightness −75…100, R G B A 0…255, each with its fill; a blend mode; no colour presets', tab.ranges.length === 5 && tab.ranges[0].min === '-75' && tab.ranges[0].max === '100' && tab.ranges.every((r) => r.p) && tab.blend && !tab.presets, tab);
    await p.evaluate(() => { const r = document.querySelector('.panel.open [data-key="comicTintA"]'); r.value = '200'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('C: a slider sets the setting as it moves', await until(p, () => JSON.parse(localStorage.getItem('kr.visual')).comicTintA === 200, null, 2000));
    if (SHOTS) { await p.waitForTimeout(500); await noToast(p); await p.screenshot({ path: path.join(SHOTS, 'S5b-colour-tab.png') }); }
    await p.evaluate(() => document.querySelector('.panel.open .panel-head .icon-btn')?.click());
    await visual(p, { comicBrightOn: false, comicTintOn: false, comicBrightness: 0 });

    // ---- the wide-pages group in the settings (phone)
    await reload(p); await open(p, ids.v1); await bars(p, true);
    await p.click('.cm-settings-btn'); await p.waitForSelector('.panel.open [data-key="comicMode"]', { timeout: 5000 });
    const wide = await p.evaluate(() => ({ split: !!document.querySelector('.panel.open [data-key="comicSplit"]'), rot: !!document.querySelector('.panel.open [data-key="comicRotateInvert"]'), dual: !!document.querySelector('.panel.open [data-key="comicDual"]'), head: [...document.querySelectorAll('.panel.open .cm-group-sub')].map((e) => e.textContent) }));
    ok('A: «Reading mode» has the wide-pages group: split, reverse, rotate, the other way, two pages side by side', wide.split && wide.rot && wide.dual && wide.head.length >= 2, wide);
    if (SHOTS) { await p.evaluate(() => document.querySelector('.panel.open [data-key="comicSplit"]').scrollIntoView({ block: 'start' })); await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, 'S5b-wide-settings.png') }); }
    await p.evaluate(() => document.querySelector('.panel.open .panel-head .icon-btn')?.click());

    // ---- Part D: the page's menu
    await reload(p); await open(p, ids.v1);
    const press = async () => { await p.mouse.move(206, 450); await p.mouse.down(); await p.waitForSelector('.cm-page-menu', { timeout: 3000 }); await p.mouse.up(); };
    await press();
    const menu = await p.evaluate(() => ({ save: !!document.querySelector('.cm-page-menu .cm-save'), share: !!document.querySelector('.cm-page-menu .cm-share'), cover: !!document.querySelector('.cm-page-menu .cm-cover'), copy: !!document.querySelector('.cm-page-menu .cm-copy'), which: !!document.querySelector('.cm-page-menu .cm-which'), clip: typeof ClipboardItem !== 'undefined' && !!navigator.clipboard && 'write' in navigator.clipboard }));
    ok('D: a long press opens the page\'s menu: save, share (a phone), set as the cover; copy where the browser can', menu.save && menu.share && menu.cover && menu.copy === menu.clip && !menu.which, menu);
    if (SHOTS) { await p.waitForTimeout(500); await noToast(p); await p.screenshot({ path: path.join(SHOTS, 'S5b-longpress.png') }); }
    const dl = p.waitForEvent('download', { timeout: 5000 });
    await p.click('.cm-page-menu .cm-save'); const d1 = await dl;
    ok('D: «Save the page» goes through the app\'s save: a file named for the book and page', /Lantern Comic Vol\. 1 - p\d+\.png$/.test(d1.suggestedFilename()), d1.suggestedFilename());
    await until(p, () => !document.querySelector('.cm-page-menu'), null, 3000);
    // Set as the cover, then undo.
    await p.evaluate(() => window.__krComic.viewer.goTo(6)); await settle2(p);
    // (A Blob does not travel out of the page as it is: its size is read there.)
    const cov = (id) => p.evaluate((id) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').get(id); q.onsuccess = () => { const b = q.result; res({ cover: b.cover?.size, orig: b.coverOrig === undefined ? 'none' : b.coverOrig === null ? 'null' : b.coverOrig.size }); }; }; }), id);
    const covWait = async (test, ms = 5000) => { const end = Date.now() + ms; for (;;) { const c = await cov(ids.v1); if (test(c)) return c; if (Date.now() > end) return null; await p.waitForTimeout(100); } };
    const beforeCov = await cov(ids.v1);
    await press(); await p.click('.cm-page-menu .cm-cover'); await p.waitForSelector('.cm-cover-ask', { timeout: 3000 });
    const ask = await p.evaluate(() => { const bs = [...document.querySelectorAll('.cm-cover-ask .sheet-actions button')].map((b) => Math.round(b.getBoundingClientRect().width)); return { bs, text: document.querySelector('.cm-cover-ask .confirm-line').textContent }; });
    ok('D: setting the cover is asked first (two buttons of one width)', ask.bs.length === 2 && Math.abs(ask.bs[0] - ask.bs[1]) <= 1 && /7/.test(ask.text), ask);
    await p.click('.cm-cover-ask .confirm-ok');
    const afterCov = await covWait((c) => c.orig !== 'none' && c.cover !== beforeCov.cover);
    ok('D: the cover is set: the book keeps the page\'s picture, its own cover kept to restore', !!afterCov && afterCov.orig === beforeCov.cover, { beforeCov, afterCov });
    await p.waitForSelector('.toast button, .toast .toast-action', { timeout: 3000 });
    await p.evaluate(() => (document.querySelector('.toast .toast-action') ?? document.querySelector('.toast button')).click());
    const undone = await covWait((c) => c.orig === 'none' && c.cover === beforeCov.cover);
    ok('D: Undo puts the old cover back', !!undone, await cov(ids.v1));
    // A cropped page offers the whole page or the page as shown.
    await visual(p, { comicCrop: true }); await reload(p); await open(p, ids.crop); await p.evaluate(() => window.__krComic.viewer.goTo(1)); await until(p, () => !!window.__krComic.viewer.borderOf(1), null, 4000); await settle2(p);
    await press();
    ok('D: a cropped page offers «the whole page» and «as shown»', await p.evaluate(() => document.querySelectorAll('.cm-page-menu .cm-which button').length === 2));
    const dlShown = p.waitForEvent('download', { timeout: 5000 }); await p.click('.cm-page-menu .cm-save'); const ds = await dlShown; const sShown = fs.statSync(await ds.path()).size;
    await press(); await p.click('.cm-page-menu .cm-which button[data-which="whole"]');
    const dlWhole = p.waitForEvent('download', { timeout: 5000 }); await p.click('.cm-page-menu .cm-save'); const dw = await dlWhole; const sWhole = fs.statSync(await dw.path()).size;
    ok('D: …the two are different pictures (as shown is the trimmed one)', sShown !== sWhole && sShown > 0 && sWhole > 0, { sShown, sWhole });
    await visual(p, { comicLongPress: false }); await reload(p); await open(p, ids.v1);
    await p.mouse.move(206, 450); await p.mouse.down(); await p.waitForTimeout(900); await p.mouse.up();
    ok('D: «Actions on long press» off: no menu', !(await p.$('.cm-page-menu')));
    await visual(p, { comicLongPress: true, comicCrop: false });

    // ---- Part F: rotation lock (a phone's), kept per book
    await reload(p); await open(p, ids.v1); await bars(p, true);
    ok('F: a phone has the rotation button in the bar', !!(await p.$('.cm-orient-btn')));
    await p.click('.cm-orient-btn'); await p.waitForSelector('.sheet .dest-row'); 
    ok('F: Free · Portrait · Landscape', await p.evaluate(() => document.querySelectorAll('.sheet .dest-row').length === 3));
    await p.evaluate(() => [...document.querySelectorAll('.sheet .dest-row')][2].click());
    ok('F: the choice is kept with the book', await stored(p, ids.v1, (b) => b?.prefs?.comicOrient === 'landscape'));
    await p.evaluate(async (id) => { await new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const os = tx.objectStore('books'); os.get(id).onsuccess = (e) => { const b = e.target.result; b.prefs = { ...(b.prefs ?? {}), comicOrient: 'auto' }; os.put(b); }; tx.oncomplete = res; }; }); }, ids.v1);
  });

  // ---- Part E: the long strip, a page of 800×40,000 px
  await session(true, async (p) => {
    const ids = await importAll(p, [extra.tall, files.v1], 2);
    await p.evaluate(() => localStorage.setItem('kr.comicZonesSeen', '1'));
    await visual(p, { comicMode: 4 }); await reload(p); await open(p, ids.tall); await bars(p, false);
    await p.evaluate(() => window.__krComic.viewer.goTo(1)); await settle2(p);
    const slots = await p.evaluate(() => document.querySelectorAll('.cm-slice').length);
    ok('E: the 800×40,000 page is a stack of 10 slices', slots === 10, slots);
    // Every slice scrolled to: drawn at its own size (800 wide: not downscaled), its rows right (the colour tells the row).
    const sh = 4096; let allSharp = true; const bad = []; let peak = 0;
    for (let j = 0; j < 10; j++) {
      await p.evaluate((j) => { const slot = document.querySelectorAll('.cm-slice')[j]; const sc = document.querySelector('.cm-scroll'); const r = slot.getBoundingClientRect(), s = sc.getBoundingClientRect(); sc.scrollTop += r.top - s.top + r.height / 2 - sc.clientHeight / 2; }, j);
      const drawn = await until(p, (j) => !!document.querySelectorAll('.cm-slice')[j]?.querySelector('canvas'), j, 8000);
      const info = await p.evaluate((j) => { const slot = document.querySelectorAll('.cm-slice')[j]; const c = slot.querySelector('canvas'); if (!c) return null; const g = c.getContext('2d'); const rows = [0, 1, Math.floor(c.height / 2), c.height - 1]; const base = j * 4096;
        return { w: c.width, h: c.height, ok: rows.every((r) => { const d = g.getImageData(5, r, 1, 1).data; const y = base + r; return d[0] === (y & 255) && d[1] === ((y >> 8) & 255); }), stats: window.__krComic.viewer.sliceStats() }; }, j);
      if (!drawn || !info || info.w !== 800 || info.h !== Math.min(sh, 40000 - j * sh) || !info.ok) { allSharp = false; bad.push({ j, info }); }
      if (info) peak = Math.max(peak, info.stats.peakPx);
    }
    ok('E: every part of the page, scrolled to, is drawn at its own size with the right rows (800 px wide, none downscaled)', allSharp, bad);
    const stats = await p.evaluate(() => window.__krComic.viewer.sliceStats());
    console.log(`  numbers: 800×40,000 page (32,000,000 px): ${stats.drawn} slices drawn over a scroll through it; most pixels held at once ${stats.peakPx} (${Math.round((stats.peakPx / 32e6) * 100)} % of the page), live slices now ${stats.live}`);
    ok('E: peak decoded pixels held at once bounded (≤ 4 slices, a third of the page or less)', stats.peakPx <= 4 * 800 * 4096 && stats.peakPx < 32e6 / 2, stats);
    ok('E: slices far from the screen are let go (at most 4 live)', stats.live <= 4, stats);
    if (SHOTS) { await p.evaluate(() => { const slot = document.querySelectorAll('.cm-slice')[3]; const sc = document.querySelector('.cm-scroll'); const r = slot.getBoundingClientRect(), s = sc.getBoundingClientRect(); sc.scrollTop += r.top - s.top + 40; }); await p.waitForTimeout(900); await noToast(p); await p.screenshot({ path: path.join(SHOTS, 'S5b-strip.png') }); }
    // Side padding.
    await visual(p, { comicStripPadding: 10 }); await reload(p); await open(p, ids.v1);
    const wdt = await p.evaluate(() => { const b = document.querySelector('.cm-block[data-page]').getBoundingClientRect(); return { w: Math.round(b.width), left: Math.round(b.left) }; });
    ok('E: side padding 10 %: the pages 80 % of the width, centred', Math.abs(wdt.w - 330) <= 2 && Math.abs(wdt.left - 41) <= 2, wdt);
    await visual(p, { comicStripPadding: 0 }); await reload(p); await open(p, ids.v1);
    // Zooming out: allowed to half unless disabled.
    const zoomOut = async () => { await p.keyboard.down('Control'); for (let i = 0; i < 8; i++) { await p.mouse.move(206, 450); await p.mouse.wheel(0, 200); await p.waitForTimeout(40); } await p.keyboard.up('Control'); await settle2(p); return p.evaluate(() => window.__krComic.viewer.zoom); };
    const z1 = await zoomOut(); ok('E: zooming out is allowed (the strip narrows to half the width)', z1 < 1 && z1 >= 0.5, z1);
    await visual(p, { comicStripNoZoomOut: true }); await reload(p); await open(p, ids.v1);
    const z2 = await zoomOut(); ok('E: «Disable zooming out»: the width is the least', z2 === 1, z2);
    await visual(p, { comicStripNoZoomOut: false });
    // Wide pages stacked.
    await visual(p, { comicSplitStrip: true }); await reload(p); await open(p, ids.v1);
    await until(p, () => document.querySelectorAll('.cm-block[data-page]').length === 13, null, 8000);
    const st2 = await p.evaluate(() => ({ n: document.querySelectorAll('.cm-block[data-page]').length, crops: window.__krComic.viewer.piecesOf(3).map((x) => x.piece.crop[0]), tops: [...document.querySelectorAll('.cm-block[data-page="3"]')].map((b) => Math.round(b.getBoundingClientRect().top)) }));
    ok('E: wide pages split in the strip: the halves stacked, the right one on top', st2.n === 13 && st2.crops[0] === 0.5 && st2.crops[1] === 0, st2);
    await visual(p, { comicSplitStrip: false, comicMode: 2 });
  });

  // ---- the computer: pairs at 1280×800, the right click
  await session(false, async (p) => {
    const ids = await importAll(p, [files.v1, files.v2, extra.crop, extra.tall], 4);
    await visual(p, { comicDual: 'always' }); await reload(p); await open(p, ids.v1);
    await sized(p); await p.evaluate(() => window.__krComic.viewer.goTo(4)); await settle2(p);
    const pr = await p.evaluate(() => { const v = document.querySelector('.cm-view').getBoundingClientRect(); const parts = [...document.querySelectorAll('.cm-current .cm-part')].map((e) => { const r = e.getBoundingClientRect(); return { page: Number(e.dataset.page), l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) }; }); return { v: [Math.round(v.width), Math.round(v.height)], parts }; });
    ok('PC 1280×800: a pair fills the height side by side, no overlap, in the window', pr.parts.length === 2 && (pr.parts[0].r <= pr.parts[1].l + 1 || pr.parts[1].r <= pr.parts[0].l + 1), pr);
    ok('PC: …the pair\'s height is the window\'s', pr.parts.every((x) => Math.abs(x.b - x.t - 800) <= 2), pr);
    if (SHOTS) { await noToast(p); await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, 'S5b-spread-pc.png') }); }
    await p.setViewportSize({ width: 1920, height: 1080 }); await settle2(p); await p.waitForTimeout(300);
    const big = await p.evaluate(() => [...document.querySelectorAll('.cm-current .cm-part')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    ok('PC 1920×1080: the pair fills the height there too', big.length === 2 && big.every((x) => Math.abs(x[1] - 1080) <= 2), big);
    await p.setViewportSize({ width: 1280, height: 800 });
    await visual(p, { comicDual: 'wide' }); await reload(p); await open(p, ids.v1); await p.evaluate(() => window.__krComic.viewer.goTo(1)); await settle2(p);
    ok('PC: «on wide screens»: a window wider than tall shows pairs', (await onShow(p)).length === 2);
    ok('PC: no rotation button (a phone\'s)', !(await p.$('.cm-orient-btn')));
    // Right click: the page's menu; no share on a computer.
    await p.mouse.click(640, 400, { button: 'right' }); await p.waitForSelector('.cm-page-menu', { timeout: 3000 });
    const m = await p.evaluate(() => ({ save: !!document.querySelector('.cm-page-menu .cm-save'), share: !!document.querySelector('.cm-page-menu .cm-share'), cover: !!document.querySelector('.cm-page-menu .cm-cover') }));
    ok('PC: a right click opens the page\'s menu: save and cover, no share', m.save && m.cover && !m.share, m);
    await p.keyboard.press('Escape'); await until(p, () => !document.querySelector('.cm-page-menu'), null, 2000);
    ok('PC: the settings of the pairing and the wide pages are there', await (async () => { await p.evaluate(() => document.querySelector('.reader-view').classList.remove('immersive')); await p.click('.cm-settings-btn'); await p.waitForSelector('.panel.open [data-key="comicDual"]', { timeout: 4000 }); return true; })());
    await p.evaluate(() => document.querySelector('.panel.open .panel-head .icon-btn')?.click());
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
