// node tests/backkeys.cjs: the phone's Back and volume buttons while reading (src/readkeys.ts, src/ui/backstack.ts,
// the reader's own Back in src/views/reader.ts), on an imitated Android phone (Capacitor imitated: its App listeners
// kept to be called as the system would, and the app's Kurokawa plugin replaced by one that records what it is asked):
//  1. "Back twice to leave a book": off, one Back leaves; on, Back first closes what is open (a panel, a sheet), then
//     shows a reminder and stays, a second Back within 2 s leaves, one after 2 s shows the reminder again; the press
//     held is in the app's own record (a "backheld" event); the top bar's arrow leaves at once; the library's
//     "press Back twice to leave the app" still works.
//  2. The screen's edges: asked to be kept from the back gesture when a book opens chapter by chapter with the setting
//     on; let go when a panel or sheet opens and when the book is left; never asked in the continuous mode.
//  3. The volume keys: setting off, never asked for; on, asked for when a book opens, let go when a panel or sheet
//     opens, when reading aloud starts, when the book is left; a "volume down" from the shell turns the page forward
//     in a book read left to right, in an Arabic one (right to left), in the continuous mode and in a PDF; at a
//     chapter's end it goes to the next chapter; "Swap direction" turns the other way.
//  4. The settings in English and Arabic (and on a computer: only Back twice).
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
  const openInfoSheet = async () => { await p.click('.float-toolbar button[data-icon="more"]'); await visible(p, '.panel.open'); await p.click('.panel.open .plain-list button:has-text("Book info")'); await visible(p, '.sheet'); await p.waitForTimeout(150); };
  const diagLast = (k) => p.evaluate((k) => window.__krDiag.data().events.filter((e) => e.k === k).pop(), k);

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
  let m = await mark();
  await openBook('en');
  ok('edges: asked to be kept when a book opens chapter by chapter', (await since(m)).some((c) => c[0] === 'edge' && c[1] === true) && await lastOf('edge') === true, await since(m));
  await openPanel();
  ok('edges: let go when a panel opens', await lastOf('edge') === false);
  await back();
  ok('edges: kept again when it closes', await lastOf('edge') === true);
  await openInfoSheet();
  ok('edges: let go when a sheet opens', await lastOf('edge') === false);
  await back(); await p.waitForTimeout(100);
  ok('edges: kept again when it closes', await lastOf('edge') === true);
  await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);
  ok('edges: let go when the book is left', await lastOf('edge') === false);
  ok('volume keys never asked for while the setting is off', !(await calls()).some((c) => c[0] === 'vol' && c[1] === true), await calls());
  await setVisual({ readingMode: 'continuous' });
  m = await mark();
  await openBook('en');
  ok('edges: never asked for in the continuous mode', !(await since(m)).some((c) => c[0] === 'edge' && c[1] === true), await since(m));
  await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);
  await setVisual({ readingMode: 'chapters', edgeGuard: false });
  m = await mark();
  await openBook('en');
  ok('edges: never asked for with the setting off', !(await since(m)).some((c) => c[0] === 'edge' && c[1] === true), await since(m));
  await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);

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

  /* ---------- 4. The settings, in English and Arabic ---------- */
  const labels = () => p.evaluate(() => [...document.querySelectorAll('.panel.open .options-grid .label')].map((l) => l.textContent.trim()));
  await openPanel();
  let L = await labels();
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
