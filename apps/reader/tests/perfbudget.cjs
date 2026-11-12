// node tests/perfbudget.cjs: performance budgets on an imitated phone (412×915, touch), as counts that do not
// depend on the machine's speed — not times, which flake in CI:
//  1. the first load: the scripts fetched before the library is shown stay under a ceiling, and pdf.js is not among them;
//     the performance recorder (src/diag.ts, always on) is among them, and small;
//  2. a library of 2,000 books with covers: the cards, images and DOM nodes made at first stay a screenful or two;
//  3. a 1,000-page PDF: pdf.js is asked for only a few pages before the first page is shown, and for a sample — not
//     every page — after it (views/../formats/pdf.ts measurePages);
//  4. an EPUB of 320 chapters: opening it does not test every block against every chapter (the translator's chapter
//     list, views/reader.ts blocksOfUnit) — counted as calls of Node.contains;
//  5. a plain text of several megabytes: only the paragraphs near the screen are laid out at open (runs of paragraphs
//     with content-visibility, formats/shared.ts textToParagraphs);
//  6. the 320-chapter EPUB shows its text with only its first chapters read (formats/epub.ts render's `first`,
//     views/reader.ts firstChapter) — chapters parsed when the text is put at its place —, and no string of the whole
//     book's text is made at open (the longest text read from the book's element: views/reader.ts headText);
//  7. the 1,000-page PDF scrolled through: the elements of pages gone by are let go of (the page's elements counted
//     after a garbage collection — formats/pdf.ts releasePage: a text layer taken off a page the browser was skipping
//     was kept by it for good);
//  8. the 1,000-page PDF's text read in idle moments goes on, at the next opening, from where it got to — the pages
//     read before are not asked of pdf.js again (formats/pdf.ts readAllWhenIdle, booksearch.ts partialPages).
// The books are made here (no fixtures).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-perfbudget-'));

const BUDGET = { startJsKB: 340, diagKB: 8, libCards: 130, libImgs: 160, libDom: 2600, pdfPagesBeforeFirst: 4, pdfPagesAfter: 80, epubContains: 200000, txtLaidOut: 800, epubParsedFirst: 3, epubTextRead: 100000, pdfNodesKept: 1500, pdfTextReread: 2 };

// Counters the app does not know of: pdf.js's page requests to its worker, and Node.contains calls.
const INIT = () => {
  window.__gp = 0; window.__contains = 0; window.__gpAtFirst = -1;
  // (The count when the first page's picture is put on the page, read at that moment.)
  new MutationObserver(() => { if (window.__gpAtFirst < 0 && document.querySelector('.pdf-page canvas.pdf-pic')) window.__gpAtFirst = window.__gp; }).observe(document, { childList: true, subtree: true });
  // (Idle-time work held off where asked — a PDF's text read for searching, page by page, while nothing else is done.)
  if (sessionStorage.getItem('kr.test.noIdle')) window.requestIdleCallback = () => 0;
  const pm = Worker.prototype.postMessage; Worker.prototype.postMessage = function (m, ...r) { try { if (m && m.action === 'GetPage') window.__gp++; } catch { /* none */ } return pm.call(this, m, ...r); };
  const c = Node.prototype.contains; Node.prototype.contains = function (o) { window.__contains++; return c.call(this, o); };
  // (A book's chapters parsed — XHTML with a body, the contents aside —, as many as when the reader puts the text at its
  // place (its kr:restore measure); the longest text read from a book's element; pdf.js asked for pages' text.)
  window.__parsed = 0; window.__parsedAtPlace = -1; window.__textMax = 0; window.__textPages = [];
  const pf = DOMParser.prototype.parseFromString;
  DOMParser.prototype.parseFromString = function (str, type) { if (type === 'application/xhtml+xml' && /<body/i.test(str) && !/epub:type="toc"/.test(str)) window.__parsed++; return pf.call(this, str, type); };
  const ms = performance.measure.bind(performance);
  performance.measure = (name, ...r) => { if (name === 'kr:restore' && window.__parsedAtPlace < 0) window.__parsedAtPlace = window.__parsed; return ms(name, ...r); };
  const tc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  Object.defineProperty(Node.prototype, 'textContent', { configurable: true, set: tc.set, get() { const v = tc.get.call(this); if (v && v.length > window.__textMax && this.nodeType === 1 && (this.classList.contains('kr-doc') || this.classList.contains('kr-content'))) window.__textMax = v.length; return v; } });
  const pm2 = Worker.prototype.postMessage; Worker.prototype.postMessage = function (m, ...r) { try { if (m && m.action === 'GetTextContent') window.__textPages.push(m.data?.pageIndex); } catch { /* none */ } return pm2.call(this, m, ...r); };
};
// (A flowing book's text is looked for at points on the screen: asking each of its paragraphs for its place would lay
// the whole book out — the very thing counted.)
const textShown = (p, timeout = 60000) => p.waitForFunction(() => { for (const fy of [0.3, 0.5, 0.7]) for (const fx of [0.3, 0.5, 0.7]) { const e = document.elementFromPoint(innerWidth * fx, innerHeight * fy)?.closest('.reader-flow .kr-content p'); if (e && e.textContent.trim()) return true; } return false; }, null, { timeout, polling: 100 });
const visible = (p, sel, timeout = 60000) => sel === 'text' ? textShown(p, timeout) : p.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; }), sel, { timeout, polling: 100 });

async function makePdf(file, pages) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) { const pg = d.addPage([432, 648]); pg.drawText(`Page ${i}`, { x: 40, y: 600, size: 16, font }); for (let l = 0; l < 10; l++) pg.drawText(`${i}.${l} The river ran past the old city.`, { x: 40, y: 570 - l * 15, size: 10, font }); }
  fs.writeFileSync(file, await d.save());
}
async function makeEpub(file, chapters) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items = [], spine = [], nav = [];
  for (let c = 1; c <= chapters; c++) {
    const ar = c % 2 === 0; const line = ar ? 'وكان الليل طويلا على المدينة القديمة والناس يقرؤون. ' : 'The river ran past the old city and the people read. ';
    z.file(`OEBPS/c${c}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>C${c}</title></head><body><h1>Chapter ${c}</h1>${Array.from({ length: 40 }, (_, p) => `<p>[C${c}-P${p}] ${line.repeat(3)}</p>`).join('')}</body></html>`);
    items.push(`<item id="c${c}" href="c${c}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${c}"/>`); nav.push(`<li><a href="c${c}.xhtml">Chapter ${c}</a></li>`);
  }
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${nav.join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">perf-budget</dc:identifier><dc:title>Budget Epub</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
function makeText(file) {
  const en = 'The river ran past the old city and the people in their houses read their books and talked of the sea. ';
  const ar = 'وكان الليل طويلا على المدينة القديمة، والناس في بيوتهم يقرؤون الكتب ويتحدثون عن البحر والسفر. ';
  const out = ['Budget Long Text']; for (let c = 1; c <= 300; c++) { out.push(`Chapter ${c}`); for (let p = 1; p <= 30; p++) out.push(`[C${c}-P${p}] ` + (c % 2 ? en : ar).repeat(3)); }
  fs.writeFileSync(file, out.join('\n\n'));
}

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const phone = async () => {
    const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en' });
    await ctx.addInitScript(INIT);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    return p;
  };
  const fresh = async () => {
    const p = await phone();
    await p.goto(base); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
    return p;
  };
  const importBook = async (p, file) => {
    await p.setInputFiles('.library-view input[type=file]', [file]);
    for (let i = 0; i < 400; i++) {
      const id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0]?.id ?? null); }; }));
      if (id) return id;
      await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
      await p.waitForTimeout(250);
    }
    throw new Error('not imported: ' + file);
  };
  const openBook = async (p, id, sel) => {
    await p.reload(); await p.waitForSelector('.library-view'); await p.waitForTimeout(800);
    await p.evaluate((id) => { window.__gp = 0; window.__contains = 0; window.__gpAtFirst = -1; location.hash = `#/read/${id}`; }, id);
    await visible(p, sel);
  };

  // 1. The first load.
  {
    const p = await phone(); const js = [];
    p.on('response', async (r) => { if (/\.m?js(\?|$)/.test(r.url())) { try { js.push({ url: r.url(), body: (await r.body()).toString('utf8') }); } catch { /* none */ } } });
    await p.goto(base); await visible(p, '.library-view .btn, .library-view .book-card'); await p.waitForTimeout(1500);
    const kb = Math.round(js.reduce((a, f) => a + Buffer.byteLength(f.body), 0) / 1024);
    ok(`the scripts loaded before the library shows are under ${BUDGET.startJsKB} KB`, kb > 0 && kb <= BUDGET.startJsKB, `${kb} KB in ${js.length} files`);
    const pdfjs = js.filter((f) => f.body.includes('GlobalWorkerOptions')).map((f) => path.basename(f.url));
    ok('pdf.js is not loaded on the library screen', pdfjs.length === 0, pdfjs);
    // (The performance recorder, always on, loaded at the start: src/diag.ts — kept small.)
    const diag = js.filter((f) => f.body.includes('"kr.diag"')).map((f) => ({ file: path.basename(f.url), kb: Math.round(Buffer.byteLength(f.body) / 102.4) / 10 }));
    ok(`the performance recorder is loaded at the start and is under ${BUDGET.diagKB} KB`, diag.length === 1 && diag[0].kb <= BUDGET.diagKB, diag);
    await p.context().close();
  }

  // 2. A library of 2,000 books with covers.
  {
    const p = await fresh();
    await p.evaluate(async (n) => {
      const covers = [];
      for (let i = 0; i < 20; i++) { const c = new OffscreenCanvas(240, 360); const x = c.getContext('2d'); x.fillStyle = `hsl(${i * 18},60%,45%)`; x.fillRect(0, 0, 240, 360); x.fillStyle = '#fff'; x.fillText('Book ' + i, 20, 180); covers.push(await (await c.convertToBlob({ type: 'image/jpeg' })).arrayBuffer()); }
      const db = await new Promise((r) => { const q = indexedDB.open('kurokawa-reader'); q.onsuccess = () => r(q.result); });
      await new Promise((res) => { const t = db.transaction('books', 'readwrite'); const st = t.objectStore('books');
        for (let i = 0; i < n; i++) st.put({ id: 'bk' + i, bookmarks: [], highlights: [], title: `Book number ${i}`, author: `Author ${i % 97}`, format: 'epub', fileName: `b${i}.epub`, size: 1000 + i, addedAt: Date.now() - i * 60000, cover: new Blob([covers[i % 20]], { type: 'image/jpeg' }) });
        t.oncomplete = res; });
    }, 2000);
    await p.reload(); await visible(p, '.book-card[data-book] img'); await p.waitForTimeout(1500);
    const st = await p.evaluate(() => ({ cards: document.querySelectorAll('.book-card[data-book]').length, imgs: document.querySelectorAll('.library-view img').length, decoded: [...document.querySelectorAll('.library-view img')].filter((i) => i.complete && i.naturalWidth).length, dom: document.getElementsByTagName('*').length }));
    ok(`2,000 books: no more than ${BUDGET.libCards} cards made at first`, st.cards > 0 && st.cards <= BUDGET.libCards, st);
    ok(`2,000 books: no more than ${BUDGET.libImgs} cover images, ${BUDGET.libDom} DOM nodes`, st.imgs <= BUDGET.libImgs && st.decoded <= BUDGET.libImgs && st.dom <= BUDGET.libDom, st);
    await p.context().close();
  }

  // 3. A 1,000-page PDF.
  {
    const file = path.join(TMP, 'thousand.pdf'); await makePdf(file, 1000);
    const p = await fresh(); const id = await importBook(p, file);
    // (Opened once and left: what is done once for a new book — its text read for searching — is not counted.)
    await openBook(p, id, '.pdf-page canvas.pdf-pic'); await p.waitForTimeout(6000);
    await p.evaluate(() => { location.hash = '#/'; sessionStorage.setItem('kr.test.noIdle', '1'); }); await p.waitForTimeout(1000);
    await openBook(p, id, '.pdf-page canvas.pdf-pic');
    const before = await p.evaluate(() => window.__gpAtFirst);
    await p.waitForTimeout(4000);
    const after = await p.evaluate(() => window.__gp);
    ok(`1,000-page PDF: no more than ${BUDGET.pdfPagesBeforeFirst} pages asked of pdf.js before the first page shows`, before <= BUDGET.pdfPagesBeforeFirst, before);
    ok(`1,000-page PDF: no more than ${BUDGET.pdfPagesAfter} pages asked in all in the 4 s after (a sample, not every page; idle-time text reading held off)`, after <= BUDGET.pdfPagesAfter, after);
    // Still laid out right: a page far on is where its number says.
    const far = await p.evaluate(() => { const sc = document.querySelector('.pdf-scroll'); const el = document.querySelector('.pdf-page[data-page="700"]'); sc.scrollTop = el.offsetTop; return new Promise((r) => setTimeout(() => r(Math.abs(el.getBoundingClientRect().top - sc.getBoundingClientRect().top) < 40), 300)); });
    ok('1,000-page PDF: page 700 is reached by its place', far);
    // Scrolled through: the elements of the pages gone by let go of (counted after a garbage collection).
    const cdp = await p.context().newCDPSession(p);
    const nodes = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Memory.getDOMCounters')).nodes; };
    await p.evaluate(() => { const sc = document.querySelector('.pdf-scroll'); sc.scrollTop = 0; }); await p.waitForTimeout(1500);
    const n0 = await nodes();
    for (const f of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) { await p.evaluate((f) => { const sc = document.querySelector('.pdf-scroll'); sc.scrollTop = sc.scrollHeight * f; }, f); await p.waitForTimeout(1200); await p.evaluate(() => { const sc = document.querySelector('.pdf-scroll'); sc.scrollTop += 300; }); await p.waitForTimeout(900); }
    const n1 = await nodes();
    ok(`1,000-page PDF: scrolled through, no more than ${BUDGET.pdfNodesKept} more elements kept than at the start`, n1 - n0 <= BUDGET.pdfNodesKept, { start: n0, after: n1 });
    await p.context().close();
  }

  // 4. An EPUB of 320 chapters.
  {
    const file = path.join(TMP, 'chapters.epub'); await makeEpub(file, 320);
    const p = await fresh(); const id = await importBook(p, file);
    await openBook(p, id, 'text'); await p.waitForTimeout(4000);
    const n = await p.evaluate(() => window.__contains);
    ok(`320-chapter EPUB: no more than ${BUDGET.epubContains} Node.contains calls at open`, n <= BUDGET.epubContains, n);
    const st = await p.evaluate(() => ({ parsed: window.__parsedAtPlace, all: window.__parsed, textMax: window.__textMax }));
    ok(`320-chapter EPUB: the text is put at its place with no more than ${BUDGET.epubParsedFirst} chapters read (the rest after)`, st.parsed >= 1 && st.parsed <= BUDGET.epubParsedFirst && st.all >= 320, st);
    ok(`320-chapter EPUB: no string of the whole book's text made at open (the longest read from the book's element under ${BUDGET.epubTextRead} letters)`, st.textMax <= BUDGET.epubTextRead, st);
    await p.context().close();
  }

  // 5. A plain text of several megabytes.
  {
    const file = path.join(TMP, 'long.txt'); makeText(file);
    const p = await fresh(); const id = await importBook(p, file);
    await openBook(p, id, 'text'); await p.waitForTimeout(2500);
    const st = await p.evaluate(() => { const ps = [...document.querySelectorAll('.reader-flow .kr-content p')]; return { paras: ps.length, laidOut: ps.filter((e) => e.checkVisibility({ contentVisibilityAuto: true })).length, first: (ps[0]?.textContent ?? '').slice(0, 20) }; });
    ok(`multi-megabyte text: no more than ${BUDGET.txtLaidOut} of its paragraphs laid out at open`, st.paras > 8000 && st.laidOut <= BUDGET.txtLaidOut, st);
    // The book's end is still there and reachable.
    const end = await p.evaluate(() => new Promise((r) => { const sc = document.querySelector('.reader-scroll'); const last = [...document.querySelectorAll('.reader-flow .kr-content p')].pop(); last.scrollIntoView(); setTimeout(() => r(/\[C300-P30\]/.test(last.textContent) && last.getBoundingClientRect().top < sc.getBoundingClientRect().bottom), 500); }));
    ok('multi-megabyte text: its last paragraph is reached', end);
    await p.context().close();
  }

  // 8. A long PDF's text read in idle moments: on from where it got to.
  {
    // (Long enough not to be read through before it is left: the reading starts 3 s after the opening.)
    const file = path.join(TMP, 'long-b.pdf'); await makePdf(file, 2500);
    const p = await fresh(); const id = await importBook(p, file);
    await openBook(p, id, '.pdf-page canvas.pdf-pic'); await p.waitForTimeout(4500);
    const first = await p.evaluate(() => [...new Set(window.__textPages)]);
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(2000);
    await openBook(p, id, '.pdf-page canvas.pdf-pic'); await p.waitForTimeout(6000);
    const again = await p.evaluate(() => [...new Set(window.__textPages)]);
    // (Pages near the top — the first screens' text layers — are asked again as they are shown: left out.)
    const read = new Set(first.filter((i) => i >= 8)); const twice = again.filter((i) => read.has(i));
    ok(`2,500-page PDF: the text read in idle moments goes on at the next opening — no more than ${BUDGET.pdfTextReread} of the ${read.size} pages read before asked again`, read.size >= 10 && read.size < 2400 && twice.length <= BUDGET.pdfTextReread, { readBefore: read.size, askedAgain: twice.length, firstAgain: again.filter((i) => i >= 8).slice(0, 5) });
    await p.context().close();
  }

  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed');
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
