// node tests/backkeys.cjs: the phone's Back and volume buttons while reading (src/readkeys.ts, src/ui/backstack.ts,
// the reader's own Back in src/views/reader.ts), on an imitated Android phone (Capacitor imitated: its App listeners
// kept to be called as the system would, and the app's Kurokawa plugin replaced by one that records what it is asked):
//  1. "Back twice to leave a book": off, one Back leaves; on, Back first closes what is open (a panel, a sheet), then
//     shows a reminder and stays, a second Back within 2 s leaves, one after 2 s shows the reminder again; the press
//     held is in the app's own record (a "backheld" event); the top bar's arrow leaves at once; the library's
//     "press Back twice to leave the app" still works.
//  2. The screen's edges: off by default (never asked for); on, asked to be kept only while a book is read chapter by
//     chapter with its bars hidden; let go when the bars show, a panel or sheet opens, the book is left; never asked in
//     the continuous mode.
//  3. The volume keys: setting off, never asked for; on, asked for when a book opens, let go when a panel or sheet
//     opens, when reading aloud starts, when the book is left; a "volume down" from the shell turns the page forward
//     in a book read left to right, in an Arabic one (right to left), in the continuous mode and in a PDF; at a
//     chapter's end it goes to the next chapter; "Swap direction" turns the other way.
//  4. The settings in English and Arabic (and on a computer: only Back twice).
//  5. Back in the middle of a page-turn swipe (touches made in the page with exact timings): within 350 ms of a chapter
//     turned by the same swipe, ignored once (backheld why=swipe), a later or fresh Back leaves; Back with the finger
//     down waits for the touch (turned → ignored; cancelled, ended without a turn or never ended → leaves); a cancelled
//     touch turns nothing; with "Back twice" on, a Back the swipe took is not the first of two.
//  6. Where Back lands: the phone's Back and the top bar's arrow alike — the library where it was scrolled, the book's
//     page when the book was opened from it.
//  7. 0.61.0's stored default (edge guard on) turned off once; set on again afterwards, kept.
//  8. The Performance page and report tell a Back ignored as part of a swipe, and the edge guard on or off, apart.
// The books are made here.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-backkeys-'));
const SHOTS = process.env.KR_BACKKEYS_SHOTS ? path.resolve(process.env.KR_BACKKEYS_SHOTS) : null;

async function makeEpub(file, id, title, lang, chapters) {
  const JSZip = require('jszip'); const z = new JSZip();
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  chapters.forEach(([t, body], i) => z.file(`OEBPS/c${i + 1}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" dir="${dir}"><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`));
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>${chapters.map(([t], i) => `<li><a href="c${i + 1}.xhtml">${t}</a></li>`).join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${lang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
async function makePdf(file) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle('Volume Pages PDF');
  for (let i = 1; i <= 6; i++) { const pg = doc.addPage([420, 595]); pg.drawText(`Page ${i}`, { x: 60, y: 520, size: 28, font }); for (let l = 0; l < 20; l++) pg.drawText(`Line ${l + 1} of page ${i}: the river ran past the old city.`, { x: 40, y: 470 - l * 20, size: 11, font }); }
  fs.writeFileSync(file, await doc.save());
}
const enPara = (c, i) => `<p>Chapter ${c}, paragraph ${i}. ${'The river ran past the old city and the people read their books by the water. '.repeat(3)}</p>`;
const arPara = (c, i) => `<p>الفصل ${c}، الفقرة ${i}. ${'جرى النهر بمحاذاة المدينة القديمة، وقرأ الناس كتبهم على ضفته في المساء. '.repeat(3)}</p>`;

// (Capacitor imitated: the app's listeners kept; the Kurokawa plugin records each ask, in order.)
const CAP = () => {
  window.__cap = {}; window.__calls = [];
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    App: { addListener: (ev, fn) => { window.__cap[ev] = fn; return Promise.resolve({ remove() {} }); }, getLaunchUrl: async () => null, minimizeApp: async () => { window.__minimized = true; } },
    Kurokawa: { setVolumeKeys: async (o) => { window.__calls.push(['vol', !!o.on]); }, setEdgeGuard: async (o) => { window.__calls.push(['edge', !!o.on]); return { ok: true }; } },
  } };
};

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en' });
  const visible = (p, sel, timeout = 30000) => p.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; }), sel, { timeout, polling: 100 });
  const isVisible = (p, sel) => p.evaluate((sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; }), sel);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(CAP);
  const setVisual = async (o) => { await p.evaluate((o) => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, o); localStorage.setItem('kr.visual', JSON.stringify(v)); location.hash = '#/'; }, o); await p.reload(); await visible(p, '.library-view'); await p.waitForTimeout(300); };
  await p.goto(base);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ bookPage: 'never', readingMode: 'chapters', turnAnimation: 'none' })); });
  await p.reload(); await visible(p, '.library-view');

  // The books.
  const en = path.join(TMP, 'river-en.epub'), ar = path.join(TMP, 'river-ar.epub'), pdf = path.join(TMP, 'pages.pdf');
  await makeEpub(en, 'kr-backkeys-en', 'River Chapters', 'en', [1, 2, 3].map((c) => [`Chapter ${c}`, Array.from({ length: 30 }, (_, i) => enPara(c, i + 1)).join('')]));
  await makeEpub(ar, 'kr-backkeys-ar', 'فصول النهر', 'ar', [1, 2, 3].map((c) => [`الفصل ${c}`, Array.from({ length: 30 }, (_, i) => arPara(c, i + 1)).join('')]));
  await makePdf(pdf);
  const allBooks = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.map((b) => ({ id: b.id, title: b.title, format: b.format }))); }; }));
  const ids = {};
  await p.setInputFiles('.library-view input[type=file]', [en, ar, pdf]);
  const want = { en: (b) => b.format === 'epub' && /River/.test(b.title), ar: (b) => b.format === 'epub' && /النهر/.test(b.title), pdf: (b) => b.format === 'pdf' };
  for (let i = 0; i < 160 && Object.keys(ids).length < 3; i++) { await p.waitForTimeout(250); const all = await allBooks(); for (const k of Object.keys(want)) { const b = all.find(want[k]); if (b) ids[k] = b.id; } }
  ok('the three books are imported', Object.keys(ids).length === 3, await allBooks());
  await p.evaluate(() => { location.hash = '#/'; }); await visible(p, '.library-view');

  const calls = () => p.evaluate(() => window.__calls.slice());
  const mark = () => p.evaluate(() => window.__calls.length);
  const since = async (n) => (await calls()).slice(n);
  const lastOf = async (kind) => (await calls()).filter((c) => c[0] === kind).map((c) => c[1]).pop();
  const inReader = () => isVisible(p, '.reader-view .reader-scroll, .reader-view .pdf-page');
  const inLibrary = () => isVisible(p, '.library-view');
  const openBook = async (key) => {
    await p.evaluate(() => { location.hash = '#/'; }); await visible(p, '.library-view');
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, ids[key]);
    await visible(p, key === 'pdf' ? '.pdf-page' : '.reader-flow .kr-content p'); await p.waitForTimeout(900);
  };
  const back = async () => { await p.evaluate(() => window.__cap.backButton({ canGoBack: true })); await p.waitForTimeout(250); };
  const toastText = () => p.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
  const openPanel = async () => { await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'options' }))); await visible(p, '.panel.open'); await p.waitForTimeout(150); };
  const openInfoSheet = async () => { await p.evaluate(() => document.querySelector('.float-toolbar button[data-icon="more"]').click()); await visible(p, '.panel.open'); await p.click('.panel.open .plain-list button:has-text("Book info")'); await visible(p, '.sheet'); await p.waitForTimeout(150); };
  const diagLast = (k) => p.evaluate((k) => window.__krDiag.data().events.filter((e) => e.k === k).pop(), k);
  const barsShown = () => p.evaluate(() => !document.querySelector('.reader-view').classList.contains('immersive'));
  // (A tap in the middle of the page shows or hides the bars, as the reader does it.)
  const tapMiddle = async () => { await p.touchscreen.tap(206, 420); await p.waitForTimeout(250); };
  const hideBars = async () => { if (await barsShown()) await tapMiddle(); await p.waitForTimeout(100); };
  const showBars = async () => { if (!(await barsShown())) await tapMiddle(); await p.waitForTimeout(100); };
  const leaveBook = async () => { if (await inReader()) { await showBars(); await p.click('.reader-view .topbar button[data-icon="back"]'); } await p.waitForTimeout(300); };

  /* ---------- 1. Back twice to leave a book ---------- */
  await openBook('en');
  await back();
  ok('Back twice off: one Back leaves the book', await inLibrary() && !(await inReader()));
  await setVisual({ backTwiceLeave: true });
  await openBook('en');
  await openPanel();
  await back();
  ok('Back twice on: the first Back closes an open panel, the book stays', !(await isVisible(p, '.panel.open')) && await inReader());
  await openInfoSheet();
  await back();
  ok('… and an open sheet', !(await isVisible(p, '.sheet')) && await inReader());
  await back();
  ok('… then a Back with nothing open shows the reminder and stays', await inReader() && /Press Back again to leave the book/.test(await toastText()), await toastText());
  await visible(p, '.toast');
  const held = await diagLast('backheld');
  ok('… the press held is in the record (backheld, why=twice, on the reader)', held && held.why === 'twice' && held.scr === 'read', held);
  await back();
  ok('… a second Back within 2 s leaves', await inLibrary() && !(await inReader()));
  const left = await diagLast('leave');
  ok('… recorded as left by the back button', left && left.why === 'back-button', left);
  await openBook('en');
  await back();
  ok('a first Back shows the reminder', await inReader() && /Press Back again/.test(await toastText()));
  await p.waitForTimeout(2300);
  await back();
  ok('a Back more than 2 s later shows the reminder again, the book stays', await inReader() && /Press Back again/.test(await toastText()));
  await back();
  ok('… and the next one leaves', await inLibrary());
  await openBook('en');
  await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);
  ok('the top bar\'s arrow leaves at once', await inLibrary() && !(await inReader()));
  // The library's own "press Back twice to leave the app" (doubleBackExit, on by default) is another thing.
  await p.evaluate(() => { window.__minimized = false; document.querySelectorAll('.toast').forEach((t) => t.remove()); });
  await back();
  ok('library: the first Back warns (the app stays)', /Press Back again to leave$|Press Back again to leave(?! the book)/.test(await toastText()) && !(await p.evaluate(() => window.__minimized)), await toastText());
  await back();
  ok('library: the second Back puts the app away', await p.evaluate(() => window.__minimized === true));

  /* ---------- 2. The screen's edges ---------- */
  // Off by default (0.61.1): never asked for, in any mode, unless the reader turns it on.
  let m = await mark();
  ok('edges: the setting is off by default', await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') || '{}').edgeGuard !== true));
  await openBook('en');
  await hideBars();
  ok('edges: by default never asked for, even chapter by chapter with the bars hidden', !(await since(m)).some((c) => c[0] === 'edge' && c[1] === true), await since(m));
  await leaveBook();
  await setVisual({ edgeGuard: true });
  m = await mark();
  await openBook('en');
  ok('edges on: not asked for while the bars are shown (the book just opened)', !(await since(m)).some((c) => c[0] === 'edge' && c[1] === true), await since(m));
  await hideBars();
  ok('edges on: asked to be kept once the bars are hidden (reading chapter by chapter)', await lastOf('edge') === true, await since(m));
  await showBars();
  ok('edges on: let go the moment the bars are shown again', await lastOf('edge') === false, await since(m));
  await hideBars();
  ok('… kept again when they hide', await lastOf('edge') === true);
  await openPanel();
  ok('edges: let go when a panel opens', await lastOf('edge') === false);
  await back();
  ok('edges: kept again when it closes', await lastOf('edge') === true);
  await openInfoSheet();
  ok('edges: let go when a sheet opens', await lastOf('edge') === false);
  await back(); await p.waitForTimeout(100);
  ok('edges: kept again when it closes', await lastOf('edge') === true);
  await leaveBook();
  ok('edges: let go when the book is left', await lastOf('edge') === false);
  ok('volume keys never asked for while the setting is off', !(await calls()).some((c) => c[0] === 'vol' && c[1] === true), await calls());
  await setVisual({ readingMode: 'continuous' });
  m = await mark();
  await openBook('en'); await hideBars();
  ok('edges: never asked for in the continuous mode', !(await since(m)).some((c) => c[0] === 'edge' && c[1] === true), await since(m));
  await leaveBook();
  await setVisual({ readingMode: 'chapters', edgeGuard: false });
  m = await mark();
  await openBook('en'); await hideBars();
  ok('edges: never asked for with the setting off', !(await since(m)).some((c) => c[0] === 'edge' && c[1] === true), await since(m));
  await leaveBook();

  /* ---------- 3. The volume keys ---------- */
  await setVisual({ volumeKeys: true, edgeGuard: true, backTwiceLeave: false });
  m = await mark();
  await openBook('en');
  ok('volume: asked for when a book opens', await lastOf('vol') === true, await since(m));
  await openPanel();
  ok('volume: let go when a panel opens', await lastOf('vol') === false);
  await back();
  ok('volume: asked for again when it closes', await lastOf('vol') === true);
  await openInfoSheet();
  ok('volume: let go when a sheet opens', await lastOf('vol') === false);
  await back(); await p.waitForTimeout(100);
  ok('volume: asked for again', await lastOf('vol') === true);
  // A "volume down" from the shell (MainActivity sends kr:volume 'down').
  const where = () => p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const shown = [...document.querySelectorAll('.reader-flow .kr-chapter')].findIndex((c) => !c.hidden); return { top: Math.round(sc.scrollTop), max: sc.scrollHeight - sc.clientHeight, chapter: shown }; });
  const vol = async (dir) => { await p.evaluate((d) => document.dispatchEvent(new CustomEvent('kr:volume', { detail: d })), dir); await p.waitForTimeout(700); };
  let a = await where(); await vol('down'); let b = await where();
  ok('volume down turns forward (left-to-right book, chapter mode)', b.top > a.top + 300, { a, b });
  await vol('up'); let c = await where();
  ok('volume up turns back', c.top < b.top - 300, { b, c });
  // At the chapter's end: the next chapter, as Space does.
  await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); sc.scrollTop = sc.scrollHeight; }); await p.waitForTimeout(300);
  a = await where(); await vol('down'); b = await where();
  ok('volume down at a chapter\'s end opens the next chapter', b.chapter === a.chapter + 1 && b.top < 50, { a, b });
  // Reading aloud: the keys go back to the volume.
  m = await mark();
  await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'speak' }))); await p.waitForTimeout(300);
  ok('volume: let go when reading aloud starts', (await since(m)).some((c) => c[0] === 'vol' && c[1] === false), await since(m));
  await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'speak' }))); await p.waitForTimeout(300);
  if (await lastOf('vol') !== true) { await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'speak' }))); await p.waitForTimeout(300); }
  ok('volume: asked for again when reading aloud stops', await lastOf('vol') === true);
  await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);
  ok('volume: let go when the book is left', await lastOf('vol') === false && await lastOf('edge') === false);
  m = await mark();
  await vol('down');
  ok('a volume press in the library does nothing (no error, no ask)', (await since(m)).length === 0 && await inLibrary());

  await openBook('ar');
  ok('Arabic book: laid right to left', await p.evaluate(() => getComputedStyle(document.querySelector('.reader-flow .kr-content p')).direction === 'rtl'));
  a = await where(); await vol('down'); b = await where();
  ok('volume down turns forward in an Arabic (right-to-left) book', b.top > a.top + 300, { a, b });
  await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);

  await setVisual({ readingMode: 'continuous' });
  await openBook('en');
  ok('continuous mode: volume keys asked for, edges not', await lastOf('vol') === true && await lastOf('edge') === false);
  a = await where(); await vol('down'); b = await where();
  const screen = await p.evaluate(() => document.querySelector('.reader-scroll').clientHeight);
  ok('volume down scrolls a screen less a little (continuous mode)', b.top - a.top > screen * 0.8 && b.top - a.top < screen, { a, b, screen });
  await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);

  await openBook('pdf');
  ok('PDF: volume keys asked for, edges not (its pages run downwards)', await lastOf('vol') === true && await lastOf('edge') === false);
  const pdfPage = () => p.evaluate(() => Number(document.querySelector('.pdf-bar input[type=range]').value));
  const p0 = await pdfPage(); await vol('down'); await p.waitForTimeout(500); const p1 = await pdfPage();
  ok('volume down turns to the next PDF page', p1 === p0 + 1, { p0, p1 });
  await vol('up'); await p.waitForTimeout(500);
  ok('volume up turns back', await pdfPage() === p0);
  await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);

  await setVisual({ volumeSwap: true, readingMode: 'chapters' });
  await openBook('en');
  a = await where(); await vol('up'); b = await where();
  ok('swapped: volume up turns forward', b.top > a.top + 300, { a, b });
  await vol('down'); c = await where();
  ok('swapped: volume down turns back', c.top < b.top - 300, { b, c });
  await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);
  await setVisual({ volumeKeys: false });
  m = await mark();
  await openBook('en'); a = await where(); await vol('down'); b = await where();
  ok('setting off again: never asked for, and a stray press does not turn', !(await since(m)).some((c) => c[0] === 'vol' && c[1] === true) && b.top === a.top && b.chapter === a.chapter, { calls: await since(m), a, b });

  /* ---------- 5. Back in the middle of a page-turn swipe ---------- */
  // Touches made in the page, with exact timings (the WebView's own: touchstart, touchmove, touchend or touchcancel
  // when Android's back gesture takes the touch), and Capacitor's backButton called as the shell would.
  await setVisual({ readingMode: 'chapters', edgeGuard: false, backTwiceLeave: false, volumeKeys: false });
  // steps: ['s'|'m'|'e'|'c', x, y] touch events; ['b'] the system's Back; ['w', ms] a wait. All in one go in the page.
  const gesture = (steps) => p.evaluate(async (steps) => {
    const el = document.querySelector('.reader-scroll'); let last = null;
    if (!el) { if (steps.some((st) => st[0] === 'b')) window.__cap.backButton({ canGoBack: true }); return; }
    const fire = (type, x, y) => { const t = new Touch({ identifier: 7, target: el, clientX: x, clientY: y }); last = t; const on = type === 'touchend' || type === 'touchcancel' ? [] : [t]; el.dispatchEvent(new TouchEvent(type, { touches: on, targetTouches: on, changedTouches: [t], bubbles: true, cancelable: type !== 'touchcancel' })); };
    const T = { s: 'touchstart', m: 'touchmove', e: 'touchend', c: 'touchcancel' };
    for (const st of steps) {
      if (st[0] === 'b') window.__cap.backButton({ canGoBack: true });
      else if (st[0] === 'w') await new Promise((r) => setTimeout(r, st[1]));
      else if (document.querySelector('.reader-scroll') === el) fire(T[st[0]], st[1], st[2]);
    }
  }, steps);
  const chapterNow = () => p.evaluate(() => [...document.querySelectorAll('.reader-flow .kr-chapter')].findIndex((c) => !c.hidden));
  const heldSwipes = () => p.evaluate(() => window.__krDiag.data().events.filter((e) => e.k === 'backheld' && e.why === 'swipe').length);
  const fromRight = [['s', 400, 450], ['m', 330, 452], ['m', 250, 455], ['m', 200, 456]];
  const clearToasts = () => p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  const toFirst = async () => { for (let i = 0; i < 3; i++) await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'prevChapter' }))); await p.waitForTimeout(300); };
  await openBook('en'); await toFirst(); await hideBars();
  let ch0 = await chapterNow(); let h0 = await heldSwipes();
  // A swipe from the right edge turns the chapter; the Back it fired comes 120 ms after: part of the swipe.
  await gesture([...fromRight, ['e', 200, 456], ['w', 120], ['b']]); await p.waitForTimeout(300);
  ok('swipe then Back 120 ms later: the chapter turned and the book stays (the Back ignored once)', await inReader() && await chapterNow() === ch0 + 1, { ch0, now: await chapterNow(), inReader: await inReader() });
  const hs = await diagLast('backheld');
  ok('… recorded: backheld why=swipe how=after-turn, the touch began at the right edge', hs && hs.why === 'swipe' && hs.how === 'after-turn' && hs.edge0 === 'right' && hs.ms >= 100 && hs.ms <= 350 && await heldSwipes() === h0 + 1, hs);
  ok('… with no reminder shown', !/Back again/.test(await toastText()), await toastText());
  ok('… and no leave recorded for it', (await diagLast('leave'))?.t < hs.t, await diagLast('leave'));
  // Ignored once only: the next Back (a deliberate one, 400 ms on) leaves.
  await gesture([['w', 400], ['b']]); await p.waitForTimeout(400);
  ok('a deliberate Back after that (no new turn) leaves the book at once', await inLibrary() && !(await inReader()));
  // After the window: a Back 450 ms after the turn is the reader's own.
  await openBook('en'); await toFirst(); await hideBars(); ch0 = await chapterNow();
  await gesture([...fromRight, ['e', 200, 456], ['w', 450], ['b']]); await p.waitForTimeout(400);
  ok('a Back 450 ms after a swipe\'s turn (outside 350 ms) leaves', await inLibrary());
  // A fresh gesture after the turn: Android's own back swipe (the page sees it start, then cancelled) leaves at once.
  await openBook('en'); await toFirst(); await hideBars(); ch0 = await chapterNow(); h0 = await heldSwipes();
  await gesture([...fromRight, ['e', 200, 456], ['w', 60], ['s', 2, 450], ['m', 30, 452], ['c', 30, 452], ['w', 40], ['b']]); await p.waitForTimeout(400);
  ok('a fresh back swipe right after a turn (touch cancelled by the system) leaves at once, not held', await inLibrary() && await heldSwipes() === h0);
  // The system took the swipe (touchcancel): no chapter turn as well.
  await openBook('en'); await toFirst(); await hideBars(); ch0 = await chapterNow();
  await gesture([...fromRight, ['c', 200, 456]]); await p.waitForTimeout(300);
  ok('a swipe the system took (touchcancel): the chapter does not turn', await inReader() && await chapterNow() === ch0, { ch0, now: await chapterNow() });
  await gesture([['b']]); await p.waitForTimeout(400);
  ok('… and the Back that follows it leaves at once', await inLibrary());
  // Back while the finger is still down: it waits for the touch; the touch turns the chapter → part of the swipe.
  await openBook('en'); await toFirst(); await hideBars(); ch0 = await chapterNow(); h0 = await heldSwipes();
  await gesture([...fromRight, ['b'], ['w', 80], ['e', 200, 456]]); await p.waitForTimeout(400);
  ok('Back with the finger still down, then the touch turns the chapter: the book stays, the chapter turned', await inReader() && await chapterNow() === ch0 + 1, { ch0, now: await chapterNow() });
  const hd = await diagLast('backheld');
  ok('… recorded: backheld why=swipe how=down', hd && hd.why === 'swipe' && hd.how === 'down' && await heldSwipes() === h0 + 1, hd);
  // …the touch cancelled instead (the system's back gesture): the Back goes on, nothing turns.
  ch0 = await chapterNow();
  await gesture([['s', 400, 450], ['m', 380, 452], ['b'], ['w', 60], ['c', 380, 452]]); await p.waitForTimeout(400);
  ok('Back with the finger down, then the touch cancelled: the book is left', await inLibrary());
  // …the touch ends without a turn (a tap): the Back goes on.
  await openBook('en'); await hideBars();
  await gesture([['s', 200, 450], ['b'], ['w', 60], ['e', 200, 450]]); await p.waitForTimeout(400);
  ok('Back with a finger down that ends without a turn: the book is left', await inLibrary());
  // …the touch never ends (a lost touchend): the Back goes on by itself within 350 ms.
  await openBook('en'); await hideBars();
  await gesture([['s', 200, 450], ['b'], ['w', 500]]); await p.waitForTimeout(200);
  ok('Back with a finger down that never ends: the book is left within the wait', await inLibrary());
  // A Back with no touch at all (the 3-button bar, a key): at once.
  await openBook('en'); await hideBars();
  await gesture([['b']]); await p.waitForTimeout(300);
  ok('a Back with no touch leaves at once', await inLibrary());
  // "Back twice to leave a book": a Back the swipe took does not count as the first of two.
  await setVisual({ backTwiceLeave: true });
  await openBook('en'); await toFirst(); await hideBars(); await clearToasts(); ch0 = await chapterNow();
  await gesture([...fromRight, ['e', 200, 456], ['w', 100], ['b']]); await p.waitForTimeout(300);
  ok('Back twice on: a Back that came with a swipe is ignored, no reminder', await inReader() && !/Back again/.test(await toastText()) && (await diagLast('backheld')).why === 'swipe', await toastText());
  await gesture([['w', 400], ['b']]); await p.waitForTimeout(300);
  ok('… the next Back is the first of two: the reminder, the book stays', await inReader() && /Press Back again to leave the book/.test(await toastText()), await toastText());
  await gesture([['b']]); await p.waitForTimeout(400);
  ok('… and the second leaves', await inLibrary());
  await setVisual({ backTwiceLeave: false });

  /* ---------- 6. Where Back lands ---------- */
  // The library scrolled: a book opened from it, then left by the phone's Back or by the top bar's arrow, comes back
  // to the library where it was.
  await p.setViewportSize({ width: 412, height: 420 });
  await p.evaluate(() => { location.hash = '#/'; }); await visible(p, '.library-view'); await p.waitForTimeout(400);
  const libScroller = () => p.evaluate(() => { const all = [document.scrollingElement, ...document.querySelectorAll('.library-view, .library-view *')]; const el = all.find((e) => e && e.scrollHeight > e.clientHeight + 40 && (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowY))); if (!el) return null; el.scrollTop = el.scrollHeight; return el === document.scrollingElement ? 'doc' : 'el'; });
  const libTop = () => p.evaluate(() => { const all = [document.scrollingElement, ...document.querySelectorAll('.library-view, .library-view *')]; const el = all.find((e) => e && e.scrollHeight > e.clientHeight + 40 && (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowY))); return el ? Math.round(el.scrollTop) : -1; });
  const scroller = await libScroller(); await p.waitForTimeout(300);
  const top0 = await libTop();
  ok('the library can be scrolled for this check', !!scroller && top0 > 40, { scroller, top0 });
  for (const how of ['phone Back', 'top bar arrow']) {
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, ids.en); await visible(p, '.reader-flow .kr-content p'); await p.waitForTimeout(700);
    if (how === 'phone Back') await back(); else await p.click('.reader-view .topbar button[data-icon="back"]');
    await visible(p, '.library-view'); await p.waitForTimeout(900);
    const top1 = await libTop();
    ok(`${how}: back in the library where it was scrolled (not its top)`, Math.abs(top1 - top0) <= 2 , { top0, top1, hash: await p.evaluate(() => location.hash) });
  }
  await p.setViewportSize({ width: 412, height: 915 });
  // Opened from the book's page: both ways back go to that page.
  for (const how of ['phone Back', 'top bar arrow']) {
    await p.evaluate((id) => { location.hash = `#/book/${id}`; }, ids.en); await p.waitForTimeout(800);
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, ids.en); await visible(p, '.reader-flow .kr-content p'); await p.waitForTimeout(700);
    if (how === 'phone Back') await back(); else await p.click('.reader-view .topbar button[data-icon="back"]');
    await p.waitForTimeout(700);
    ok(`${how}: opened from the book's page, back on the book's page`, await p.evaluate((id) => location.hash === `#/book/${id}`, ids.en) && !(await inReader()), await p.evaluate(() => location.hash));
  }
  await p.evaluate(() => { location.hash = '#/'; }); await visible(p, '.library-view');

  /* ---------- 7. The default changed: 0.61.0's stored "on" turned off once ---------- */
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); v.edgeGuard = true; localStorage.setItem('kr.visual', JSON.stringify(v)); localStorage.removeItem('kr.edgeGuardOff'); });
  await p.reload(); await visible(p, '.library-view');
  ok('an install coming from 0.61.0 (edge guard stored on, the old default): off after the update', await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual')).edgeGuard === false && localStorage.getItem('kr.edgeGuardOff') === '1'));
  await setVisual({ edgeGuard: true });
  await p.reload(); await visible(p, '.library-view');
  ok('… turned on again by the reader after that: stays on', await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual')).edgeGuard === true));
  await setVisual({ edgeGuard: false });

  /* ---------- 8. The Performance report tells these apart ---------- */
  await p.evaluate(() => { window.__clip = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => { window.__clip = s; } }, configurable: true }); location.hash = '#/settings'; });
  await visible(p, '.settings-view .card-title');
  await p.evaluate(() => { const b = document.querySelector('.perf-entry button'); b.closest('.card').classList.remove('collapsed'); b.scrollIntoView({ block: 'center' }); });
  await visible(p, '.perf-entry button'); await p.click('.perf-entry button'); await visible(p, '.perf-sheet .perf-row'); await p.waitForTimeout(300);
  const perfText = await p.evaluate(() => document.querySelector('.perf-sheet').innerText);
  ok('the page counts the Backs ignored as part of a swipe apart', /Back presses taken as part of a page-turn swipe \(ignored\): \d/.test(perfText), perfText.slice(-500));
  await p.locator('.perf-sheet .sheet-actions button').first().click(); await p.waitForTimeout(300);
  const rep = await p.evaluate(() => window.__clip);
  ok('the report: a Back ignored after a turn, with its timing', /IGNORED AS PART OF A PAGE-TURN SWIPE \(\d+ ms after the chapter turned; the touch began at the right edge\)/.test(rep), rep.slice(rep.indexOf('Back held'), rep.indexOf('Back held') + 600));
  ok('the report: a Back ignored with the finger down', /IGNORED AS PART OF A PAGE-TURN SWIPE \(came with the finger down; that touch then turned the chapter/.test(rep));
  ok('the report: the edge guard at the last book open (on/off) and how often it was on', /Edge guard \("Protect page-turn swipes at the screen edges"\) at the last book open: (ON|off); on at \d+ of the last \d+ opens\./.test(rep), (rep.match(/Edge guard.*$/m) || [])[0]);
  ok('the report: a deliberate Back still shows as the reason the reader was left', /back-button -> library/.test(rep));
  await p.evaluate(() => document.querySelector('.perf-sheet .sheet-head button').click()); await p.waitForTimeout(200);
  await openBook('en');

  /* ---------- 4. The settings, in English and Arabic ---------- */
  const labels = () => p.evaluate(() => [...document.querySelectorAll('.panel.open .options-grid .label')].map((l) => l.textContent.trim()));
  await openPanel();
  let L = await labels();
  const hints = await p.evaluate(() => [...document.querySelectorAll('.panel.open .options-grid .hint')].map((l) => l.textContent.trim()));
  ok('the edge guard\'s hint says plainly it is off by default and takes over Back swipes from the middle of the edge', hints.some((x) => /^Off by default\. When on, Android's Back swipe from the middle of the left or right edge is taken over/.test(x) && /whenever the bars are shown/.test(x)), hints.filter((x) => /edge/.test(x)));
  ok('settings (English): the three toggles with the reader\'s behaviour', ['Volume buttons turn pages', 'Back twice to leave a book', 'Protect page-turn swipes at the screen edges'].every((x) => L.some((l) => l.startsWith(x))), L.filter((l) => /Volume|Back|swipes/.test(l)));
  ok('… "Swap direction" only while the volume buttons turn pages', !L.some((l) => l.startsWith('Swap direction')));
  await p.click('.panel.open .options-grid label.row:has(.label:text-is("Volume buttons turn pages")) .switch'); await p.waitForTimeout(300);
  L = await labels();
  ok('… and shown when they do', L.some((l) => l.startsWith('Swap direction')));
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.evaluate(() => [...document.querySelectorAll('.panel.open .options-grid .label')].find((l) => l.textContent.startsWith('Volume'))?.scrollIntoView({ block: 'center' })); await p.screenshot({ path: path.join(SHOTS, 'settings-en.png') }); }
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); }); await setVisual({});
  await openBook('en'); await openPanel();
  L = await labels();
  ok('settings (Arabic): the toggles in Arabic', ['تقليب الصفحات بزرَّي الصوت', 'عكس الاتجاه', 'لا يُغادَر الكتاب إلا بضغط «رجوع» مرتين', 'صَونُ سحب تقليب الصفحات عند حافتَي الشاشة'].every((x) => L.some((l) => l.startsWith(x))), L.slice(-30));
  if (SHOTS) { await p.evaluate(() => [...document.querySelectorAll('.panel.open .options-grid .label')].find((l) => l.textContent.startsWith('تقليب'))?.scrollIntoView({ block: 'center' })); await p.screenshot({ path: path.join(SHOTS, 'settings-ar.png') }); }
  await back(); await p.waitForTimeout(200);
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); v.backTwiceLeave = true; localStorage.setItem('kr.visual', JSON.stringify(v)); }); await setVisual({});
  await openBook('en'); await back();
  ok('the reminder in Arabic', /اضغط «رجوع» مرةً أخرى لمغادرة الكتاب/.test(await toastText()), await toastText());
  await back();
  ok('… and the second Back leaves', await inLibrary());

  // A computer (no Capacitor): Back twice is there, the phone's keys and edges are not.
  const pc = await ctx.newPage(); pc.on('pageerror', (e) => errors.push(e.message));
  await pc.goto(base); await pc.evaluate(() => localStorage.setItem('kr.lang', 'en')); await pc.reload(); await visible(pc, '.library-view');
  await pc.evaluate((id) => { location.hash = `#/read/${id}`; }, ids.en); await visible(pc, '.reader-flow .kr-content p'); await pc.waitForTimeout(600);
  await pc.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'options' }))); await visible(pc, '.panel.open');
  L = await pc.evaluate(() => [...document.querySelectorAll('.panel.open .options-grid .label')].map((l) => l.textContent.trim()));
  ok('without Android: "Back twice" shown, volume buttons and edges hidden', L.some((l) => l.startsWith('Back twice')) && !L.some((l) => /^Volume buttons|^Protect page-turn/.test(l)), L.filter((l) => /Volume|Back|swipes/.test(l)));
  await pc.evaluate(() => document.querySelector('.panel.open .panel-head button').click());
  await pc.keyboard.press('Alt+ArrowLeft'); await pc.waitForTimeout(300);
  ok('a computer\'s Alt+← goes through the same Back: the reminder, the book stays', await pc.evaluate(() => !!document.querySelector('.reader-view .reader-scroll')) && /Press Back again/.test(await pc.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '))));
  await pc.keyboard.press('Alt+ArrowLeft'); await pc.waitForTimeout(400);
  ok('… and a second one leaves', await pc.evaluate(() => !!document.querySelector('.library-view') && !document.querySelector('.reader-view')));
  await pc.close();

  const real = errors.filter((e) => !/ResizeObserver|speechSynthesis|NotAllowedError|play\(\)/.test(e));
  ok('no page errors', real.length === 0, real);
  await br.close(); server.close();
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
