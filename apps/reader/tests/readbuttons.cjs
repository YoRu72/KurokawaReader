// node tests/readbuttons.cjs: the reader's buttons placed by the reader (src/readbuttons.ts, src/ui/buttonbars.ts,
// src/ui/buttonsheet.ts, views/reader.ts), on an imitated phone (412×915, touch), a narrow one (320) and a computer
// (1280×800):
//  - by default the top bar, the toolbar and the PDF's bars are what they were (the ids and order compared with the
//    build before the placing — KR_OLD_DIST, built from the commit before; skipped with a note when it is not there);
//  - an action moved in «Customise buttons» to the top bar, «More» or hidden is there, works when pressed there, and
//    stays after a reload; order changes stay;
//  - too many buttons for a 320-px screen: the rest go to «More», nothing is cut (every button inside the screen);
//  - the back arrow and «More» (and «Customise buttons» in it) are always there, whatever is chosen;
//  - the toolbar at the top, at a side and docked: the text is not under it (rects), and the place read stays when it
//    moves; the PDF's page bar likewise, and its older settings (`pdfBar`, `pdfBarSide`, `pdfBarRow`) keep their look;
//  - an older `readerToolbar` (the app's, and one book's) carries over;
//  - in Arabic the bars are mirrored (start on the right);
//  - a hidden action still answers its key and its tap zone;
//  - «Reset» brings the defaults back.
// Screenshots (KR_SHOTS=dir) of the default and customised bars and of the editor. The books are made here.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const OLD = process.env.KR_OLD_DIST ? path.resolve(process.env.KR_OLD_DIST) : null;
const SHOTS = process.env.KR_SHOTS ? path.resolve(process.env.KR_SHOTS) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const serve = (dir) => http.createServer((req, res) => { let f = path.join(dir, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dir, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-readbuttons-'));

async function makeEpub(file, id, title, lang, chapters) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  chapters.forEach(([t, body], i) => z.file(`OEBPS/c${i + 1}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"${lang === 'ar' ? ' dir="rtl"' : ''}><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`));
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>${chapters.map(([t], i) => `<li><a href="c${i + 1}.xhtml">${t}</a></li>`).join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${lang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
async function makePdf(file, pages) {
  const { PDFDocument, StandardFonts } = require(path.resolve(__dirname, '../node_modules/pdf-lib'));
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) { const pg = d.addPage([432, 648]); pg.drawText(`Page ${i}`, { x: 40, y: 600, size: 18, font }); for (let l = 0; l < 20; l++) pg.drawText(`Line ${l} of page ${i}: the text of the page runs here.`, { x: 40, y: 560 - l * 24, size: 12, font }); }
  fs.writeFileSync(file, await d.save());
}
const para = (i, lang) => lang === 'ar'
  ? `<p>[P${i}] هذه فقرة من فقرات الكتاب، فيها كلام يملأ السطر ويمتد إلى السطر الذي يليه ليُرى شكل الصفحة عند القراءة.</p>`
  : `<p>[P${i}] The river ran past the old city, and the people in their houses read their books and talked of the sea and of the ships.</p>`;
const chapter = (lang, n) => Array.from({ length: n }, (_, i) => para(i + 1, lang)).join('');

(async () => {
  const srv = serve(DIST); await new Promise((r) => srv.listen(0, r)); const base = `http://127.0.0.1:${srv.address().port}/`;
  let oldBase = null; let srvOld = null;
  if (OLD && fs.existsSync(path.join(OLD, 'index.html'))) { srvOld = serve(OLD); await new Promise((r) => srvOld.listen(0, r)); oldBase = `http://127.0.0.1:${srvOld.address().port}/`; }
  const epub = path.join(TMP, 'b.epub'); await makeEpub(epub, 'readbuttons-1', 'Buttons Test', 'en', [['Chapter One', chapter('en', 80)], ['Chapter Two', chapter('en', 60)]]);
  const epubAr = path.join(TMP, 'b-ar.epub'); await makeEpub(epubAr, 'readbuttons-2', 'كتاب الأزرار', 'ar', [['الفصل الأول', chapter('ar', 60)]]);
  const pdf = path.join(TMP, 'b.pdf'); await makePdf(pdf, 8);
  const br = await chromium.launch(); const errors = [];
  const open = new Set();
  const sect = async (name, fn) => { try { await fn(); } catch (e) { ok(`${name}: the part ran to its end`, false, String(e.message ?? e).split('\n')[0]); } for (const c of open) await c.close().catch(() => undefined); open.clear(); };
  /** A page of the app: a phone (touch) or a computer; the language; settings to start with. */
  const page = async (o = {}) => {
    const { lang = 'en', visual = null, w = 412, h = 915, pc = false, at = base, books = null } = o;
    const ctx = await br.newContext(pc ? { viewport: { width: w, height: h }, serviceWorkers: 'block', locale: lang } : { viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: lang });
    ctx.setDefaultTimeout(15000); open.add(ctx);
    await ctx.addInitScript(([l, v, bv]) => {
      if (sessionStorage.getItem('kr.test.init')) return; sessionStorage.setItem('kr.test.init', '1');
      localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now()));
      if (v) localStorage.setItem('kr.visual', JSON.stringify(v));
      if (bv) localStorage.setItem('kr.bookVisual', JSON.stringify(bv));
    }, [lang, visual, books]);
    const p = await ctx.newPage(); p.on('pageerror', (e) => { errors.push(e.message); if (process.env.KR_DEBUG) console.log('PAGEERROR', e.stack); });
    await p.goto(at); await p.waitForSelector('.library-view, .view');
    return p;
  };
  const importBook = async (p, file) => {
    const count = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.sort((a, b) => b.addedAt - a.addedAt).map((b) => b.id)); }; }));
    const before = (await count()).length;
    await p.setInputFiles('.library-view input[type=file]', [file]);
    for (let i = 0; i < 200; i++) { const ids = await count(); if (ids.length > before) return ids[0]; await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); await p.waitForTimeout(250); }
    throw new Error('not imported: ' + file);
  };
  const visible = (p, sel, timeout = 30000) => p.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5; }), sel, { timeout, polling: 100 });
  const openBook = async (p, id, sel = '.reader-flow .kr-content p') => { await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id); await visible(p, sel); await p.waitForTimeout(1200); };
  const openPdf = (p, id) => openBook(p, id, '.pdf-page canvas, .pdf-page');
  const reload = async (p) => { await p.reload(); await p.waitForTimeout(1500); };
  const settle = (p, ms = 500) => p.waitForTimeout(ms);
  /** The bars as drawn: the top bar's buttons, the toolbar's (a PDF's page bar's), what «More» would show (opened). */
  const bars = (p) => p.evaluate(() => {
    const sig = (e) => (e.classList.contains('sep') ? 'sep' : e.classList.contains('title') ? 'title' : e.tagName === 'FORM' ? 'goToPage' : e.dataset.icon ?? e.tagName);
    const tb = document.querySelector('.reader-view .float-toolbar'); const pdfTools = document.querySelector('.pdf-bar .pdf-bar-tools'); const pdfBar = document.querySelector('.pdf-bar');
    return {
      top: [...document.querySelector('.reader-view .topbar').children].map(sig),
      bar: tb && !tb.hidden ? [...tb.children].map(sig) : [],
      tools: pdfTools ? [...pdfTools.children].map(sig) : [],
      nav: pdfBar ? !!pdfBar.querySelector('.pdf-bar-nav input[type=range]') && getComputedStyle(pdfBar.querySelector('.pdf-bar-nav')).display !== 'none' : null,
      layout: pdfBar ? { layout: pdfBar.dataset.layout, side: pdfBar.dataset.side, row: pdfBar.dataset.row } : null,
    };
  });
  const rect = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);
  const moreIds = async (p) => {
    await p.click('.reader-view button[data-icon="more"]'); await visible(p, '.panel.open .plain-list button');
    const ids = await p.evaluate(() => [...document.querySelectorAll('.panel.open .plain-list button')].map((b) => b.dataset.action ?? b.textContent.trim()));
    await p.keyboard.press('Escape'); await settle(p, 400);
    return ids;
  };
  /** «Customise buttons», from «More» (always there). */
  const editor = async (p, kind) => {
    await p.click('.reader-view button[data-icon="more"]'); await visible(p, '.panel.open .plain-list button');
    await p.click('.panel.open button[data-action="customise"]'); await visible(p, '.buttons-sheet');
    if (kind) { await p.click(`.buttons-sheet .buttons-kind button[data-kind="${kind}"]`); await settle(p, 200); }
  };
  const closeSheet = async (p) => { await p.keyboard.press('Escape'); await settle(p, 400); };
  const placeIn = async (p, id, at) => { await p.click(`.buttons-sheet .placed-row[data-id="${id}"] button[data-place="${at}"]`); await settle(p, 250); };
  const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, name) }); };
  const firstPara = (p) => p.evaluate(() => { const sc = document.querySelector('.reader-scroll').getBoundingClientRect(); const ps = [...document.querySelectorAll('.reader-flow .kr-chapter:not([hidden]) p, .reader-flow .kr-content p')]; const q = ps.find((x) => { const r = x.getBoundingClientRect(); return r.top >= sc.top - 2; }); return q ? q.textContent.slice(0, 6) : null; });
  /** The text's paragraphs on the screen that a bar covers (none should). */
  const covered = (p) => p.evaluate(() => {
    const boxes = ['.reader-view .float-toolbar:not([hidden])', '.reader-view > .topbar', '.read-status:not([hidden])'].map((s) => document.querySelector(s)).filter((e) => e && getComputedStyle(e).opacity > 0.5 && getComputedStyle(e).display !== 'none').map((e) => e.getBoundingClientRect());
    const sc = document.querySelector('.reader-scroll').getBoundingClientRect();
    const hits = [];
    for (const el of document.querySelectorAll('.reader-flow p')) { for (const r of el.getClientRects()) { if (r.bottom <= sc.top || r.top >= sc.bottom || r.height === 0) continue; const vis = { top: Math.max(r.top, sc.top), bottom: Math.min(r.bottom, sc.bottom), left: r.left, right: r.right }; for (const b of boxes) if (vis.left < b.right - 0.5 && vis.right > b.left + 0.5 && vis.top < b.bottom - 0.5 && vis.bottom > b.top + 0.5) hits.push(el.textContent.slice(0, 6)); } }
    return [...new Set(hits)];
  });

  // Books made once per page (each context has its own storage).
  const withBook = async (p, file) => importBook(p, file);

  // ---- 1. Defaults: the bars as they were (compared with the build before the placing).
  await sect('defaults', async () => {
    const take = async (at, o) => {
      const p = await page({ ...o, at }); const id = await withBook(p, epub); await openBook(p, id);
      const flow = await bars(p); const tbR = await rect(p, '.reader-view .float-toolbar'); const topR = await rect(p, '.reader-view .topbar');
      const labels = await p.evaluate(() => [...document.querySelectorAll('.float-toolbar .tb-label')].filter((x) => x.offsetParent).map((x) => x.textContent));
      if (o.shot) await shot(p, o.shot);
      await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
      const pid = await withBook(p, pdf); await openPdf(p, pid); await settle(p, 800);
      const pdfB = await bars(p); const pdfR = await rect(p, '.pdf-bar');
      if (o.shotPdf) await shot(p, o.shotPdf);
      await p.context().close(); open.delete(p.context());
      return { flow, tbR, topR, labels, pdfB, pdfR };
    };
    for (const [name, o] of [['phone 412', { w: 412, h: 915, shot: 'phone-en-default.png', shotPdf: 'phone-en-pdf-default.png' }], ['computer 1280', { w: 1280, h: 800, pc: true, shot: 'desktop-en-default.png' }], ['phone landscape 915', { w: 915, h: 412, shot: 'landscape-en-default.png' }]]) {
      const now = await take(base, o);
      ok(`${name}: the top bar is back, title, full screen`, now.flow.top.join() === 'back,title,fullscreen', now.flow.top);
      ok(`${name}: the toolbar is contents, search, pictures, bookmark, a line, options, More`, now.flow.bar.join() === 'toc,search,images,bookmarkAdd,sep,type,more', now.flow.bar);
      ok(`${name}: a PDF's top bar is back, title, search, contents, pages, More`, now.pdfB.top.join() === 'back,title,search,toc,grid,more', now.pdfB.top);
      ok(`${name}: a PDF's page bar: the slider, then go to, zoom out, zoom in, fit, ink, page strip`, now.pdfB.nav && now.pdfB.tools.join() === 'goToPage,zoomOut,zoomIn,fullscreen,pen,images', now.pdfB);
      if (oldBase) {
        const was = await take(oldBase, { ...o, shot: null, shotPdf: null });
        ok(`${name}: the same buttons in the same order as the build before`, JSON.stringify([now.flow.top, now.flow.bar, now.pdfB.top, now.pdfB.tools, now.pdfB.layout]) === JSON.stringify([was.flow.top, was.flow.bar, was.pdfB.top, was.pdfB.tools, was.pdfB.layout]), { now: [now.flow, now.pdfB], was: [was.flow, was.pdfB] });
        const near = (a, b) => a && b && ['l', 't', 'r', 'b'].every((k) => Math.abs(a[k] - b[k]) <= 2);
        ok(`${name}: the toolbar, the top bar and the page bar where they were`, near(now.tbR, was.tbR) && near(now.topR, was.topR) && near(now.pdfR, was.pdfR), { now: [now.tbR, now.topR, now.pdfR], was: [was.tbR, was.topR, was.pdfR] });
        ok(`${name}: the toolbar's names as before`, JSON.stringify(now.labels) === JSON.stringify(was.labels), { now: now.labels, was: was.labels });
      } else console.log('note: KR_OLD_DIST not given — the comparison with the build before is skipped');
    }
  });

  // ---- 2. Moving actions: top bar, «More», hidden; pressed where they are; kept after a reload; order kept.
  await sect('move', async () => {
    const p = await page({ visual: { tapToTurn: true, tapZones: ['bookmark', 'prev', 'prev', 'menu', 'menu', 'menu', 'next', 'next', 'next'] } }); const id = await withBook(p, epub); await openBook(p, id);
    await editor(p);
    await placeIn(p, 'info', 'topStart');
    await placeIn(p, 'toc', 'more');
    await placeIn(p, 'search', 'hidden');
    await placeIn(p, 'bookmark', 'hidden');
    await placeIn(p, 'speak', 'bar');
    // (Order: the visual options moved up, before the line.)
    await p.click('.buttons-sheet .placed-row[data-id="type"] .mv-up'); await settle(p, 200);
    await shot(p, 'phone-en-editor.png');
    await closeSheet(p);
    let b = await bars(p);
    ok('moved: book info at the top bar\'s start', b.top.join() === 'back,info,title,fullscreen', b.top);
    ok('moved: the toolbar without contents, search, bookmark; read aloud on it; the options before the line', b.bar.join() === 'images,type,sep,speak,more', b.bar);
    await p.click('.reader-view .topbar button[data-action="info"]'); await visible(p, '.sheet');
    ok('book info pressed in the top bar opens it', await p.evaluate(() => !!document.querySelector('.sheet')));
    await closeSheet(p);
    const more = await moreIds(p);
    ok('contents is in «More» now (and the hidden ones are not)', more.includes('toc') && !more.includes('search') && !more.includes('bookmark') && more[more.length - 1] === 'customise', more);
    await p.click('.reader-view button[data-icon="more"]'); await visible(p, '.panel.open .plain-list button'); await p.click('.panel.open button[data-action="toc"]'); await settle(p, 600);
    ok('contents pressed in «More» opens the contents', await p.evaluate(() => !!document.querySelector('.panel.open .toc-list, .panel.open [class*=toc]')));
    await closeSheet(p);
    // Hidden: the key still opens the search; the tap zone still adds a bookmark.
    await p.keyboard.press('/'); await settle(p, 600);
    ok('search, hidden: «/» still opens it', await p.evaluate(() => !!document.querySelector('.panel.open input[type=search]')));
    await closeSheet(p);
    const marks = () => p.evaluate((id) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').get(id); q.onsuccess = () => res((q.result.bookmarks ?? []).length); }; }), id);
    const m0 = await marks(); const sr = await rect(p, '.reader-scroll');
    await p.touchscreen.tap(sr.l + 30, sr.t + 40); await settle(p, 800);
    ok('bookmark, hidden: its tap zone still adds one', (await marks()) === m0 + 1, { before: m0, after: await marks() });
    // Kept.
    await reload(p); await openBook(p, id);
    b = await bars(p);
    ok('after a reload: the same places and order', b.top.join() === 'back,info,title,fullscreen' && b.bar.join() === 'images,type,sep,speak,more', b);
    ok('… «More» the same', JSON.stringify(await moreIds(p)) === JSON.stringify(more));
    // Reset.
    await editor(p); await p.click('.buttons-sheet .buttons-foot button'); await settle(p, 300); await closeSheet(p);
    b = await bars(p);
    ok('«Reset» brings the defaults back', b.top.join() === 'back,title,fullscreen' && b.bar.join() === 'toc,search,images,bookmarkAdd,sep,type,more', b);
  });

  // ---- 3. Too many for the width: the rest in «More», nothing cut (320, 412, 1280).
  const crowded = { readerButtons: [
    { id: 'info', at: 'topStart' }, { id: 'bookmarks', at: 'topStart' },
    { id: 'fullscreen', at: 'topEnd' }, { id: 'dayNight', at: 'topEnd' }, { id: 'glossary', at: 'topEnd' }, { id: 'favorite', at: 'topEnd' },
    ...['toc', 'search', 'images', 'bookmark', 'sep', 'type', 'translate', 'speak', 'scroll', 'highlights', 'speedReading', 'sleepTimer', 'exportNotes'].map((id) => ({ id, at: 'bar' })),
  ] };
  await sect('overflow', async () => {
    for (const [w, h, pc] of [[320, 700, false], [412, 915, false], [1280, 800, true]]) {
      const p = await page({ w, h, pc, visual: crowded }); const id = await withBook(p, epub); await openBook(p, id); await settle(p, 600);
      const st = await p.evaluate(() => {
        const vw = innerWidth; const out = [];
        const shown = [...document.querySelectorAll('.reader-view .topbar > *, .reader-view .float-toolbar:not([hidden]) > *')].filter((e) => getComputedStyle(e).display !== 'none');
        for (const e of shown) { const r = e.getBoundingClientRect(); const box = e.parentElement.getBoundingClientRect(); if (r.left < -0.5 || r.right > vw + 0.5 || r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push([e.dataset.action ?? e.className, Math.round(r.left), Math.round(r.right)]); }
        const tb = document.querySelector('.float-toolbar').getBoundingClientRect(); const title = document.querySelector('.reader-view .topbar .title').getBoundingClientRect();
        const onBars = shown.map((e) => e.dataset.action).filter(Boolean);
        return { out, tb: [Math.round(tb.left), Math.round(tb.right)], vw, titleW: Math.round(title.width), onBars, over: document.querySelector('.reader-view').dataset.overflow, tbScroll: document.querySelector('.float-toolbar').scrollWidth - document.querySelector('.float-toolbar').clientWidth, topScroll: document.querySelector('.reader-view .topbar').scrollWidth - document.querySelector('.reader-view .topbar').clientWidth };
      });
      ok(`${w} px: every button inside the screen and its bar (nothing cut)`, !st.out.length && st.tb[0] >= 0 && st.tb[1] <= st.vw && st.tbScroll <= 1 && st.topScroll <= 1, st);
      ok(`${w} px: the title keeps room`, st.titleW >= 60, st.titleW);
      const more = await moreIds(p);
      const all = crowded.readerButtons.map((x) => x.id).filter((x) => x !== 'sep');
      const missing = all.filter((x) => !st.onBars.includes(x) && !more.includes(x));
      ok(`${w} px: what did not fit is in «More»${w === 320 ? ' (some did not)' : ''}`, !missing.length && (w !== 320 || Number(st.over) > 0), { missing, over: st.over, more: more.slice(0, 8) });
      if (w === 320) await shot(p, 'phone320-en-overflow.png');
      if (w === 1280) await shot(p, 'desktop-en-crowded.png');
      await p.context().close(); open.delete(p.context());
    }
  });

  // ---- 4. Never locked out: everything hidden — the back arrow, «More» and «Customise buttons» stay.
  await sect('fixed', async () => {
    const hidden = { readerButtons: [...['toc', 'search', 'images', 'bookmark', 'type', 'fullscreen', 'info'].map((id) => ({ id, at: 'hidden' })), { id: 'back', at: 'hidden' }, { id: 'more', at: 'hidden' }, { id: 'customise', at: 'hidden' }] };
    const p = await page({ visual: hidden }); const id = await withBook(p, epub); await openBook(p, id);
    const b = await bars(p);
    ok('all hidden: the back arrow stays at the top bar\'s start', b.top[0] === 'back', b.top);
    ok('… «More» moves to the top bar\'s end (the toolbar is empty)', b.top[b.top.length - 1] === 'more' && !b.bar.length, b);
    await visible(p, '.reader-view .topbar button[data-icon="more"]');
    const more = await moreIds(p);
    ok('… «More» still lists what is not hidden, and «Customise buttons» last', more.includes('bookmarks') && more[more.length - 1] === 'customise' && !more.includes('toc'), more);
    await editor(p);
    ok('… the editor opens; the back arrow and «More» are shown fixed (no place to choose)', await p.evaluate(() => document.querySelectorAll('.buttons-sheet .placed-row.fixed').length >= 3 && !document.querySelector('.buttons-sheet .placed-row[data-id="back"], .buttons-sheet .placed-row[data-id="more"]')));
    await closeSheet(p);
    // The back arrow still leaves the book.
    await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(800);
    ok('… and the back arrow leaves the book', await p.evaluate(() => !document.querySelector('.reader-view')));
  });

  // ---- 5. The toolbar at the top, at a side, docked: the text clear of it; the place read kept as it moves.
  await sect('positions', async () => {
    const p = await page({ w: 412, h: 915 }); const id = await withBook(p, epub); await openBook(p, id);
    await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 2400; }); await settle(p, 900);
    const at0 = await firstPara(p);
    for (const [where, look] of [['top', 'pill'], ['start', 'pill'], ['end', 'pill'], ['bottom', 'docked'], ['top', 'docked'], ['end', 'docked'], ['bottom', 'pill']]) {
      await editor(p, 'flow');
      await p.click(`.buttons-sheet .segmented button[data-v="${where}"]`); await settle(p, 200);
      await p.click(`.buttons-sheet .segmented button[data-v="${look}"]`); await settle(p, 200);
      await closeSheet(p); await settle(p, 900);
      const st = await p.evaluate(() => ({ tb: document.querySelector('.reader-view').dataset.tb, look: document.querySelector('.reader-view').dataset.tblook }));
      ok(`${where}, ${look}: the toolbar there`, st.tb === where && st.look === look, st);
      const tbR = await rect(p, '.reader-view .float-toolbar'); const vw = 412, vh = 915;
      const placed = where === 'top' ? tbR.t < 200 : where === 'bottom' ? tbR.b > vh - 120 : where === 'start' ? tbR.l < 30 && tbR.h > tbR.w : tbR.r > vw - 30 && tbR.h > tbR.w;
      ok(`${where}, ${look}: drawn at that edge`, placed && tbR.l >= 0 && tbR.r <= vw && tbR.t >= 0 && tbR.b <= vh, tbR);
      const cov = await covered(p);
      ok(`${where}, ${look}: no line of text under a bar`, !cov.length, cov);
      const at1 = await firstPara(p);
      ok(`${where}, ${look}: the place read is the same`, at1 === at0, { before: at0, after: at1 });
      if (where === 'end' && look === 'pill') await shot(p, 'phone-en-side.png');
      // The chrome hidden and shown: the text does not move.
      const top = () => p.evaluate((t) => { const q = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith(t)); return Math.round(q.getBoundingClientRect().top * 10) / 10; }, at1);
      const a = await top(); await p.touchscreen.tap(206, 460); await settle(p, 800); const imm = await p.evaluate(() => document.querySelector('.reader-view').classList.contains('immersive')); const b2 = await top(); await p.touchscreen.tap(206, 460); await settle(p, 800); const c = await top();
      ok(`${where}, ${look}: the text does not move when the bars hide and show`, imm && Math.abs(a - b2) <= 1 && Math.abs(a - c) <= 1, { a, hidden: b2, shown: c, imm });
    }
  });

  // ---- 6. A phone on its side and a computer with the toolbar at the side (screenshots); the text clear of it.
  await sect('side', async () => {
    for (const [w, h, pc, name] of [[915, 412, false, 'landscape-en-side.png'], [1280, 800, true, 'desktop-en-side.png']]) {
      const p = await page({ w, h, pc, visual: { toolbarAt: 'end', readerButtons: [{ id: 'info', at: 'topStart' }, { id: 'fullscreen', at: 'topEnd' }, { id: 'dayNight', at: 'topEnd' }, ...['toc', 'search', 'images', 'bookmark', 'sep', 'type', 'speak', 'translate'].map((id) => ({ id, at: 'bar' }))] } });
      const id = await withBook(p, epub); await openBook(p, id); await settle(p, 600);
      const cov = await covered(p); const tbR = await rect(p, '.reader-view .float-toolbar');
      ok(`${w}×${h}: the toolbar down the end side, the text clear of it`, !cov.length && tbR.r > w - 30 && tbR.b <= h && tbR.t >= 0, { cov, tbR });
      await shot(p, name);
      if (pc) { await editor(p); await shot(p, 'desktop-en-editor.png'); await closeSheet(p); }
      await p.context().close(); open.delete(p.context());
    }
  });

  // ---- 7. A PDF: its buttons placed the same way; its older bar settings keep their look.
  await sect('pdf', async () => {
    const p = await page({ w: 412, h: 915 }); const id = await withBook(p, pdf); await openPdf(p, id); await settle(p, 800);
    await editor(p, 'pdf');
    await placeIn(p, 'zoomIn', 'topEnd'); await placeIn(p, 'search', 'more'); await placeIn(p, 'fitWidth', 'hidden'); await placeIn(p, 'crop', 'bar');
    await closeSheet(p);
    const b = await bars(p);
    ok('PDF: zoom in at the top bar\'s end, search gone from it', b.top.join() === 'back,title,toc,grid,zoomIn,more', b.top);
    const tools = await p.evaluate(() => [...document.querySelectorAll('.pdf-bar-tools > *')].map((e) => e.dataset.action));
    ok('PDF: the page bar without zoom in and fit, with the margins\' crop at its end', tools.join() === 'goToPage,zoomOut,ink,pageStrip,crop', tools);
    const w0 = await p.evaluate(() => document.querySelector('.pdf-page').getBoundingClientRect().width);
    await p.click('.reader-view .topbar button[data-action="zoomIn"]'); await settle(p, 900);
    const w1 = await p.evaluate(() => document.querySelector('.pdf-page').getBoundingClientRect().width);
    ok('PDF: zoom in pressed in the top bar zooms', w1 > w0 + 5, { w0, w1 });
    const more = await moreIds(p);
    ok('PDF: search in «More», fit nowhere, «Customise buttons» last', more.includes('search') && !more.includes('fitWidth') && more[more.length - 1] === 'customise', more);
    await p.keyboard.press('0'); await settle(p, 900);
    const w2 = await p.evaluate(() => document.querySelector('.pdf-page').getBoundingClientRect().width);
    ok('PDF: fit width, hidden, still answers its key («0»)', Math.abs(w2 - w0) < 3, { w0, w2 });
    // The page bar's place and look from the editor.
    await editor(p, 'pdf'); await p.click('.buttons-sheet .segmented button[data-v="start"]'); await settle(p, 200); await closeSheet(p);
    const r = await rect(p, '.pdf-bar');
    ok('PDF: the page bar at the start side (left in English)', r.l < 40 && r.h > r.w, r);
    await editor(p, 'pdf'); await p.click('.buttons-sheet .segmented button[data-v="bottom"]'); await settle(p, 200); await p.click('.buttons-sheet .segmented button[data-v="docked"]'); await settle(p, 200); await closeSheet(p);
    const d = await rect(p, '.pdf-bar');
    ok('PDF: docked at the foot, the full width', d.l <= 0 && d.r >= 412 && d.b >= 915 - 2, d);
    await shot(p, 'phone-en-pdf-docked.png');
    await p.context().close(); open.delete(p.context());
    // Older settings: the same look as the build before (or, without it, where they put the bar).
    for (const [v, want] of [[{ pdfBar: 'side', pdfBarSide: 'left' }, (r) => r.l < 40 && r.h > r.w], [{ pdfBar: 'row', pdfBarRow: 'top' }, (r) => r.t < 200 && r.w > r.h], [{ pdfBar: 'rows', pdfBarRow: 'bottom' }, (r) => r.b > 700 && r.w > r.h], [{ pdfBar: 'side', pdfBarSide: 'right' }, (r) => r.r > 372 && r.h > r.w]]) {
      const look = async (at) => { const q = await page({ visual: v, at }); const pid = await withBook(q, pdf); await openPdf(q, pid); await settle(q, 800); const r = await rect(q, '.pdf-bar'); const bb = await bars(q); await q.context().close(); open.delete(q.context()); return { r, l: bb.layout }; };
      const now = await look(base);
      ok(`older ${JSON.stringify(v)}: the bar where it was put`, want(now.r), now);
      if (oldBase) { const was = await look(oldBase); ok(`older ${JSON.stringify(v)}: the same as the build before`, ['l', 't', 'r', 'b'].every((k) => Math.abs(now.r[k] - was.r[k]) <= 2) && JSON.stringify(now.l) === JSON.stringify(was.l), { now, was }); }
    }
  });

  // ---- 8. An older `readerToolbar` carries over (the app's, and one book's).
  await sect('older', async () => {
    const p = await page({ visual: { readerToolbar: ['search', 'info', 'sep', 'toc', 'more'] } }); const id = await withBook(p, epub); await openBook(p, id);
    let b = await bars(p);
    ok('an older toolbar carries over: search, info, a line, contents, More', b.bar.join() === 'search,info,sep,toc,more' && b.top.join() === 'back,title,fullscreen', b);
    const more = await moreIds(p);
    ok('… and what it did not hold is in «More»', more.includes('images') && more.includes('bookmark') && more.includes('type'), more);
    // One book's own, from before.
    await p.evaluate((id) => { localStorage.setItem('kr.bookVisual', JSON.stringify({ [id]: { readerToolbar: ['speak', 'fullscreen', 'more'] } })); }, id);
    await reload(p); await openBook(p, id);
    b = await bars(p);
    ok('a book\'s own older toolbar carries over (and full screen, on it, leaves the top bar)', b.bar.join() === 'speak,fullscreen,more' && b.top.join() === 'back,title', b);
  });

  // ---- 9. Arabic: mirrored.
  await sect('arabic', async () => {
    const p = await page({ lang: 'ar', visual: { readerButtons: [{ id: 'info', at: 'topStart' }, { id: 'fullscreen', at: 'topEnd' }, { id: 'toc', at: 'topEnd' }, ...['search', 'images', 'bookmark', 'sep', 'type'].map((id) => ({ id, at: 'bar' }))] } });
    const id = await withBook(p, epubAr); await openBook(p, id);
    const r = await p.evaluate(() => Object.fromEntries(['back', 'info', 'toc'].map((k) => { const e = document.querySelector(`.reader-view .topbar [data-icon="${k}"], .reader-view .topbar [data-action="${k}"]`); return [k, Math.round(e.getBoundingClientRect().left)]; })));
    ok('Arabic: the back arrow at the right, the start\'s buttons after it leftwards, the end\'s at the left', r.back > r.info && r.info > r.toc && r.back > 300 && r.toc < 120, r);
    await shot(p, 'phone-ar-custom.png');
    await editor(p, 'flow'); await p.click('.buttons-sheet .segmented button[data-v="start"]'); await settle(p, 300);
    await shot(p, 'phone-ar-editor.png');
    await closeSheet(p); await settle(p, 700);
    const tb = await rect(p, '.reader-view .float-toolbar');
    ok('Arabic: the toolbar at the start side is on the right', tb.r > 412 - 30 && tb.h > tb.w, tb);
    ok('Arabic: no line of text under it', !(await covered(p)).length, await covered(p));
    await shot(p, 'phone-ar-side.png');
    await p.context().close(); open.delete(p.context());
    const q = await page({ lang: 'ar' }); const qid = await withBook(q, epubAr); await openBook(q, qid); await shot(q, 'phone-ar-default.png');
    ok('Arabic default: the same buttons', JSON.stringify(await bars(q)).includes('"back","title","fullscreen"'), await bars(q));
    await q.context().close(); open.delete(q.context());
    const d = await page({ lang: 'ar', w: 1280, h: 800, pc: true }); const did = await withBook(d, epubAr); await openBook(d, did); await shot(d, 'desktop-ar-default.png');
  });

  const benign = (m) => /ResizeObserver loop/.test(m);
  ok('no page errors', !errors.filter((m) => !benign(m)).length, errors);
  await br.close(); srv.close(); srvOld?.close();
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
