// node tests/readbar.cjs: the reading bar (src/ui/readbar.ts, views/reader.ts) on an imitated phone (412×915, touch):
//  - hidden by default; switched on from the reader's «More» it shows the items it showed before they could be chosen;
//  - the page in the chapter and the pages left are right — by the scroller's own arithmetic (its height and the
//    chapter's) — at the start, the middle and the end of a chapter, after a larger font and a turned screen, in a
//    long plain text laid out lazily in runs, and in the continuous and «scroll on» modes;
//  - items switched on, moved and placed in the options' editor are kept (the page reloaded);
//  - with the chrome hidden by a tap the bar stays (the option on) or hides (off);
//  - the text ends above the floating toolbar and the bar (rects compared), and the place read does not move on the
//    screen when the chrome is hidden or shown;
//  - in the Arabic interface its figures are in the interface's digits for prose (١٢٣; src/i18n localDigits), the clock
//    as the locale writes it, and its start is on the right;
//  - a PDF shows its page in the book and in its chapter (its outline);
//  - the bar does not add layout reads per scroll (getBoundingClientRect counted, the bar on and off);
//  - settings of an older version: the bar shows as before (the minutes left kept off where they were switched off).
// The books are made here (no fixtures).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const SRC = path.resolve(DIST, '../src'); // (the sources of the build tested, for the settings' own check)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-readbar-'));

async function makeEpub(file, id, title, lang, chapters) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  chapters.forEach(([t, body], i) => z.file(`OEBPS/c${i + 1}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"${lang === 'ar' ? ' dir="rtl"' : ''}><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`));
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>${chapters.map(([t], i) => `<li><a href="c${i + 1}.xhtml">${t}</a></li>`).join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${lang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
/** A PDF of `pages` pages with an outline: «Part A» at page 1, «Part B» at page 6. */
async function makePdf(file, pages) {
  const { PDFDocument, StandardFonts, PDFName, PDFString, PDFArray, PDFNumber } = require(path.resolve(__dirname, '../node_modules/pdf-lib'));
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) { const pg = d.addPage([432, 648]); pg.drawText(`Page ${i}`, { x: 40, y: 600, size: 18, font }); }
  const ctx = d.context; const outlinesRef = ctx.nextRef(); const refs = [ctx.nextRef(), ctx.nextRef()];
  const items = [['Part A', 0], ['Part B', 5]];
  items.forEach(([title, pi], k) => {
    const dest = PDFArray.withContext(ctx); dest.push(d.getPage(pi).ref); dest.push(PDFName.of('Fit'));
    const m = { Title: PDFString.of(title), Parent: outlinesRef, Dest: dest };
    if (k > 0) m.Prev = refs[k - 1]; if (k < items.length - 1) m.Next = refs[k + 1];
    ctx.assign(refs[k], ctx.obj(m));
  });
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: PDFNumber.of(items.length) }));
  d.catalog.set(PDFName.of('Outlines'), outlinesRef);
  fs.writeFileSync(file, await d.save());
}

const para = (i, lang) => lang === 'ar'
  ? `<p>هذه فقرة من فقرات الكتاب رقمها ${i}، فيها كلام يملأ السطر ويمتد إلى السطر الذي يليه ليُرى شكل الصفحة عند القراءة.</p>`
  : `<p>[P${i}] The river ran past the old city, and the people in their houses read their books and talked of the sea and of the ships.</p>`;
const chapter = (lang, n) => Array.from({ length: n }, (_, i) => para(i + 1, lang)).join('');

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const epub = path.join(TMP, 'bar.epub'); await makeEpub(epub, 'readbar-1', 'Bar Test', 'en', [['Chapter One', chapter('en', 70)], ['Chapter Two', chapter('en', 90)], ['Chapter Three', chapter('en', 40)]]);
  const epubAr = path.join(TMP, 'bar-ar.epub'); await makeEpub(epubAr, 'readbar-2', 'كتاب التجربة', 'ar', [['الفصل الأول', chapter('ar', 60)], ['الفصل الثاني', chapter('ar', 60)]]);
  const txt = path.join(TMP, 'long.txt'); fs.writeFileSync(txt, Array.from({ length: 700 }, (_, i) => `[T${i}] ` + 'The long text goes on and on through the night, line after line, as the lamp burns low over the page. '.repeat(2)).join('\n\n'));
  const pdf = path.join(TMP, 'parts.pdf'); await makePdf(pdf, 12);
  const br = await chromium.launch(); const errors = [];
  // (A part that throws — an element the code before the bar did not have — fails, and the rest still run.)
  const open = new Set();
  const sect = async (fn) => { try { await fn(); } catch (e) { ok('the part ran to its end', false, String(e.message ?? e).split('\n')[0]); } for (const c of open) await c.close().catch(() => undefined); open.clear(); };
  const phone = async (lang, visual) => {
    const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: lang === 'ar' ? 'ar' : 'en' });
    ctx.setDefaultTimeout(15000); open.add(ctx);
    await ctx.addInitScript(([l, v]) => {
      // (Every layout read counted, for the scroll budget below.)
      const g = Element.prototype.getBoundingClientRect; window.__rects = 0; Element.prototype.getBoundingClientRect = function () { window.__rects++; return g.call(this); };
      if (sessionStorage.getItem('kr.test.init')) return; sessionStorage.setItem('kr.test.init', '1');
      localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now()));
      if (v) localStorage.setItem('kr.visual', JSON.stringify(v));
    }, [lang, visual ?? null]);
    const p = await ctx.newPage(); p.on('pageerror', (e) => { errors.push(e.message); if (process.env.KR_DEBUG) console.log('PAGEERROR', e.stack); });
    await p.goto(base); await p.waitForSelector('.library-view');
    return p;
  };
  const importBook = async (p, file) => {
    const before = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.length); }; }));
    await p.setInputFiles('.library-view input[type=file]', [file]);
    for (let i = 0; i < 200; i++) {
      const id = await p.evaluate((n) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.length > n ? q.result.sort((a, b) => b.addedAt - a.addedAt)[0].id : null); }; }), before);
      if (id) return id;
      await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
      await p.waitForTimeout(250);
    }
    throw new Error('not imported: ' + file);
  };
  const visible = (p, sel, timeout = 30000) => p.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5; }), sel, { timeout, polling: 100 });
  const isShown = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return !e.hidden && r.height > 0 && r.top < innerHeight && cs.display !== 'none' && Number(cs.opacity) > 0.5 && cs.visibility !== 'hidden'; }, sel);
  const openBook = async (p, id, sel = '.reader-flow .kr-content p') => {
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
    await visible(p, sel); await p.waitForTimeout(1200);
  };
  const back = async (p) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(400); };
  const settle = (p, ms = 450) => p.waitForTimeout(ms);
  /** The bar's items shown, in their order on the line (by place group). */
  const barState = (p) => p.evaluate(() => {
    const el = document.querySelector('.read-status');
    let items = [...(el?.querySelectorAll('.rb-item') ?? [])].filter((s) => !s.hidden).map((s) => ({ id: s.dataset.item, text: s.textContent, at: s.parentElement.className }));
    // (The line before its items could be chosen: its fixed spans, read as the same items — to compare their text.)
    if (!items.length && el) items = [['.where', 'chapter'], ['.pg', 'page'], ['.clock', 'clock'], ['.batt', 'battery'], ['.pct', 'bookPct']].map(([sel, id]) => ({ id, text: el.querySelector(sel)?.textContent ?? '', at: '' })).filter((x) => x.text);
    return { hidden: !el || el.hidden, items };
  });
  const textOf = async (p, id) => (await barState(p)).items.find((x) => x.id === id)?.text ?? null;
  const nums = (s) => (s ?? '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).match(/\d+/g)?.map(Number) ?? [];
  /** What the page numbers must be, from the scroller's own sizes: one page is the scroller's height with the chrome
   *  hidden (the reading frame); the page is the one at its top, the last once the chapter's end is in it. */
  const expected = (p, unitSel) => p.evaluate((unitSel) => {
    const sc = document.querySelector('.reader-scroll'); const units = [...document.querySelectorAll(unitSel)].filter((u) => !u.hidden && u.getBoundingClientRect().height > 0);
    const sr = sc.getBoundingClientRect(); const fr = (document.querySelector('.read-frame') ?? sc).getBoundingClientRect();
    const H = fr.height; const imm = document.querySelector('.reader-view').classList.contains('immersive');
    // (The unit read: the one across the frame's top line.)
    const u = units.find((x) => { const r = x.getBoundingClientRect(); return r.bottom > fr.top + 8; }) ?? units[units.length - 1]; const ur = u.getBoundingClientRect();
    const pages = Math.max(1, Math.ceil(ur.height / H - 0.01)); const pos = fr.top - ur.top;
    const end = ur.bottom <= fr.top + H + 1 || sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1;
    const page = end ? pages : Math.min(pages, Math.max(1, Math.floor(pos / H + 0.01) + 1));
    return { page, pages, left: pages - page, H, clientH: sc.clientHeight, imm, frameTop: fr.top, scrollTop: sr.top, unitTop: ur.top, unitH: ur.height };
  }, unitSel);
  /** Scroll so that `screens` pages of the unit are above the frame's top (or to its end with Infinity). */
  const scrollInto = async (p, unitSel, screens) => {
    await p.evaluate(([unitSel, screens]) => {
      const sc = document.querySelector('.reader-scroll'); const u = [...document.querySelectorAll(unitSel)].find((x) => !x.hidden && x.getBoundingClientRect().height > 0 && x.getBoundingClientRect().bottom > (document.querySelector('.read-frame') ?? sc).getBoundingClientRect().top + 8) ?? document.querySelector(unitSel);
      const fr = (document.querySelector('.read-frame') ?? sc).getBoundingClientRect(); const ur = u.getBoundingClientRect();
      const toTop = ur.top - fr.top; // unit top relative to the frame
      sc.scrollTop += screens === null ? ur.bottom - fr.bottom + 4 : toTop + screens * fr.height;
    }, [unitSel, screens === Infinity ? null : screens]);
    await settle(p);
  };
  const checkPages = async (p, unitSel, what) => {
    const e = await expected(p, unitSel); const pg = nums(await textOf(p, 'page')); const left = nums(await textOf(p, 'chapterLeft'));
    const leftOk = e.left === 0 ? /last|آخر/i.test(await textOf(p, 'chapterLeft') ?? '') : left[0] === e.left;
    ok(`${what}: page ${e.page} of ${e.pages}, ${e.left} left`, pg[0] === e.page && pg[1] === e.pages && leftOk, { bar: [await textOf(p, 'page'), await textOf(p, 'chapterLeft')], want: e });
    return e;
  };
  const withItems = { showStatusLine: true, statusItems: [{ id: 'chapter', on: true, at: 'start' }, { id: 'page', on: true, at: 'start' }, { id: 'chapterLeft', on: true, at: 'end' }, { id: 'bookPct', on: true, at: 'end' }] };

  // ---- 1. Hidden by default; switched on from «More»: the items it showed before. The text clear of the bars; the place kept.
  await sect(async () => {
    const p = await phone('en'); const id = await importBook(p, epub);
    await openBook(p, id);
    ok('the reading bar is hidden by default', (await barState(p)).hidden && !(await isShown(p, '.read-status')));
    // (The text clear of the floating toolbar — the bar hidden — with the chrome showing.)
    const clear0 = await p.evaluate(() => { const s = document.querySelector('.reader-scroll').getBoundingClientRect(); const tb = document.querySelector('.float-toolbar').getBoundingClientRect(); return { scrollBottom: s.bottom, toolbarTop: tb.top }; });
    ok('the text ends above the floating toolbar', clear0.scrollBottom <= clear0.toolbarTop + 0.5, clear0);
    await p.click('.float-toolbar [aria-label="More"]'); await visible(p, '.panel button');
    const quick = await p.locator('.panel button', { hasText: 'Show the reading bar' }).click({ timeout: 3000 }).then(() => true, () => false);
    ok('«More» has «Show the reading bar»', quick);
    // (Without it — the code before the bar's options — switched on in the settings, to test the rest.)
    if (!quick) { await p.keyboard.press('Escape'); await back(p); await p.evaluate(() => localStorage.setItem('kr.visual', JSON.stringify({ ...JSON.parse(localStorage.getItem('kr.visual') ?? '{}'), showStatusLine: true }))); await p.reload(); await p.waitForSelector('.library-view'); await openBook(p, id); }
    await visible(p, '.read-status');
    await settle(p, 600);
    const st = await barState(p);
    ok('switched on from «More», it shows the chapter, the page in it, the clock, the battery (where known) and the percentage', !st.hidden && st.items.map((x) => x.id).filter((x) => x !== 'battery').join(',') === 'chapter,page,clock,bookPct', st);
    ok('… the page as «n / total», the percentage with «%»', /^\d+ \/ \d+$/.test(await textOf(p, 'page')) && /^\d+%$/.test(await textOf(p, 'bookPct')), [await textOf(p, 'page'), await textOf(p, 'bookPct')]);
    const clear1 = await p.evaluate(() => { const s = document.querySelector('.reader-scroll').getBoundingClientRect(); const tb = document.querySelector('.float-toolbar').getBoundingClientRect(); const b = document.querySelector('.read-status').getBoundingClientRect(); return { scrollBottom: s.bottom, toolbarTop: tb.top, barTop: b.top }; });
    ok('with the bar on: the text ends above the toolbar and the bar', clear1.scrollBottom <= clear1.toolbarTop + 0.5 && clear1.scrollBottom <= clear1.barTop + 0.5, clear1);
    // The place read stays where it is on the screen as the chrome hides and shows (at the chapter's start, and further on).
    for (const where of ['start', 'middle']) {
      if (where === 'middle') { await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 1500; }); await settle(p, 700); }
      const at = () => p.evaluate(() => { const fr = document.querySelector('.reader-scroll').getBoundingClientRect(); const ps = [...document.querySelectorAll('.reader-flow .kr-chapter:not([hidden]) p')]; const q = ps.find((x) => x.getBoundingClientRect().top > fr.top + 40); return { text: q.textContent.slice(0, 6), top: Math.round(q.getBoundingClientRect().top * 10) / 10 }; });
      const a = await at();
      await p.touchscreen.tap(206, 460); await settle(p, 800);
      const imm = await p.evaluate(() => document.querySelector('.reader-view').classList.contains('immersive'));
      const b = await p.evaluate((text) => { const q = [...document.querySelectorAll('.reader-flow .kr-chapter:not([hidden]) p')].find((x) => x.textContent.startsWith(text)); return Math.round(q.getBoundingClientRect().top * 10) / 10; }, a.text);
      await p.touchscreen.tap(206, 460); await settle(p, 800);
      const c = await p.evaluate((text) => { const q = [...document.querySelectorAll('.reader-flow .kr-chapter:not([hidden]) p')].find((x) => x.textContent.startsWith(text)); return Math.round(q.getBoundingClientRect().top * 10) / 10; }, a.text);
      ok(`the place read does not move when the bars hide and show (${where} of a chapter)`, imm && Math.abs(b - a.top) <= 1 && Math.abs(c - a.top) <= 1, { before: a.top, hidden: b, shown: c, imm });
    }
    // Immersive with the bar kept (the default): the bar stays, the text above it.
    await p.touchscreen.tap(206, 460); await settle(p, 800);
    const imm = await p.evaluate(() => { const s = document.querySelector('.reader-scroll').getBoundingClientRect(); const b = document.querySelector('.read-status').getBoundingClientRect(); return { on: document.querySelector('.reader-view').classList.contains('immersive'), scrollBottom: s.bottom, barTop: b.top }; });
    ok('immersive, the option on (default): the bar stays', imm.on && (await isShown(p, '.read-status')));
    ok('immersive: the text ends above the bar', imm.scrollBottom <= imm.barTop + 0.5, imm);
    await p.touchscreen.tap(206, 460); await settle(p, 600);
    await back(p); await p.context().close();
  });

  // ---- 2. Pages in a chapter (chapter by chapter): start, middle, end; a larger font; the screen turned.
  await sect(async () => {
    const p = await phone('en', withItems); const id = await importBook(p, epub);
    await openBook(p, id);
    const U = '.reader-flow .kr-chapter';
    await checkPages(p, U, 'chapter mode, the start');
    await scrollInto(p, U, 2.5); await checkPages(p, U, 'chapter mode, the middle');
    await scrollInto(p, U, Infinity); const end = await checkPages(p, U, 'chapter mode, the end');
    ok('… the end is the chapter\'s last page', nums(await textOf(p, 'page'))[0] === end.pages && end.pages >= 4, end);
    // The same with the chrome hidden: the frame is the scroller then, and the numbers do not change.
    await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 0; }); await settle(p);
    await scrollInto(p, U, 1.5);
    const shownPg = await textOf(p, 'page');
    await p.touchscreen.tap(206, 460); await settle(p, 800);
    const e = await expected(p, U);
    ok('immersive: one page is the scroller\'s height (the frame matches it)', e.imm && Math.abs(e.H - e.clientH) <= 1, e);
    ok('the page shown does not change when the chrome hides', (await textOf(p, 'page')) === shownPg, [shownPg, await textOf(p, 'page')]);
    await checkPages(p, U, 'immersive, the middle');
    await p.touchscreen.tap(206, 460); await settle(p, 600);
    // A larger font: more pages.
    const before = await expected(p, U);
    for (let i = 0; i < 6; i++) await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'fontUp' })));
    await settle(p, 900);
    const after = await checkPages(p, U, 'after a larger font');
    ok('… the chapter has more pages', after.pages > before.pages, [before.pages, after.pages]);
    // The screen turned.
    await p.setViewportSize({ width: 915, height: 412 }); await settle(p, 1200);
    const turned = await checkPages(p, U, 'the screen turned');
    await scrollInto(p, U, 1.2); await checkPages(p, U, 'the screen turned, further on');
    ok('… a page is the turned screen\'s height', turned.H < 412, turned);
    // Items as set: the pages left reads «n left in chapter».
    ok('pages left reads as words', /^\d+ pages? left$|^Last page of the chapter$/.test(await textOf(p, 'chapterLeft') ?? ''), await textOf(p, 'chapterLeft'));
    await back(p); await p.context().close();
  });

  // ---- 3. Continuous and «scroll on» modes.
  for (const mode of ['continuous', 'flow']) await sect(async () => {
    const p = await phone('en', { ...withItems, readingMode: mode }); const id = await importBook(p, epub);
    await openBook(p, id);
    const U = '.reader-flow .kr-chapter';
    await checkPages(p, U, `${mode}: the start`);
    if (mode === 'continuous') {
      // Into the second chapter.
      await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const c2 = document.querySelectorAll('.reader-flow .kr-chapter')[1]; const fr = (document.querySelector('.read-frame') ?? sc).getBoundingClientRect(); sc.scrollTop += c2.getBoundingClientRect().top - fr.top + fr.height * 2.4; });
      await settle(p, 800);
      const e = await checkPages(p, U, 'continuous: the middle of the second chapter');
      ok('… counted in the second chapter (its title on the bar)', /Chapter Two/.test(await textOf(p, 'chapter') ?? ''), await textOf(p, 'chapter'));
      void e;
    } else { await scrollInto(p, U, 3.3); await checkPages(p, U, 'scroll on: the middle'); await scrollInto(p, U, Infinity); await checkPages(p, U, 'scroll on: the end'); }
    await back(p); await p.context().close();
  });

  // ---- 4. A long plain text, laid out lazily in runs.
  await sect(async () => {
    const p = await phone('en', withItems); const id = await importBook(p, txt);
    await openBook(p, id);
    const runs = await p.evaluate(() => document.querySelectorAll('.reader-flow .kr-run').length);
    ok('the long text is in runs', runs > 3, runs);
    const U = '.reader-flow .kr-content';
    await checkPages(p, U, 'runs: the start');
    await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); sc.scrollTop = sc.scrollHeight * 0.45; }); await settle(p, 900);
    await checkPages(p, U, 'runs: the middle');
    await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); sc.scrollTop = sc.scrollHeight * 0.8; }); await settle(p, 900);
    await checkPages(p, U, 'runs: further on');
    await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); sc.scrollTop = sc.scrollHeight; }); await settle(p, 900);
    await checkPages(p, U, 'runs: the end');
    await back(p); await p.context().close();
  });

  // ---- 5. The editor: items switched on, moved, placed — kept. Immersive with the option off hides the bar. Pages left
  //         and time in the bar (a reading speed known).
  await sect(async () => {
    const p = await phone('en', { showStatusLine: true }); const id = await importBook(p, epub);
    // (A reading speed known to the book's statistics: 200 words a minute.)
    await p.evaluate((id) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.get(id); q.onsuccess = () => { const b = q.result; b.stats = { days: {}, ...(b.stats ?? {}), ms: 10 * 60000, words: 2000 }; st.put(b); }; tx.oncomplete = res; }; }), id);
    await openBook(p, id);
    await p.click('.float-toolbar [aria-label="Visual Options"]'); await visible(p, '.options-grid'); await p.locator('.placed-list').scrollIntoViewIfNeeded(); await settle(p, 300);
    const row = (rid) => p.locator(`.placed-row[data-id="${rid}"]`);
    await row('chapterLeft').locator('input').check(); await row('timeBook').locator('input').check();
    await row('chapterLeft').scrollIntoViewIfNeeded();
    // chapterLeft to the centre, and moved up above «timeChapter»… (up until it is the third row)
    await row('chapterLeft').locator('button[title="Centre"]').click();
    for (let i = 0; i < 8; i++) { const ids = await p.$$eval('.placed-row', (rs) => rs.map((r) => r.dataset.id)); if (ids.indexOf('chapterLeft') <= 2) break; await row('chapterLeft').locator('.mv-up').click(); }
    // … and the clock off.
    await row('clock').locator('input').uncheck();
    await p.keyboard.press('Escape'); await settle(p, 300);
    await p.evaluate(() => document.querySelector('.panel .panel-head button, .panel [aria-label="Close"]')?.click()); await settle(p, 600);
    await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 900; }); await settle(p, 900);
    const st = await barState(p);
    const ids = st.items.map((x) => x.id);
    ok('the editor: pages left shown, in the centre, the clock gone', ids.includes('chapterLeft') && st.items.find((x) => x.id === 'chapterLeft').at === 'rb-center' && !ids.includes('clock'), st);
    ok('time left (a reading speed known): in the chapter and in the book', /min|h/.test(await textOf(p, 'timeChapter') ?? '') && /left in book/.test(await textOf(p, 'timeBook') ?? ''), [await textOf(p, 'timeChapter'), await textOf(p, 'timeBook')]);
    // Kept: the page reloaded, the book opened again.
    await back(p); await p.reload(); await p.waitForSelector('.library-view'); await openBook(p, id);
    const st2 = await barState(p);
    ok('items switched, moved and placed are kept after a reload', JSON.stringify(st2.items.map((x) => [x.id, x.at])) === JSON.stringify(st.items.map((x) => [x.id, x.at])), { before: st.items.map((x) => x.id), after: st2.items.map((x) => x.id) });
    // The option «keep in immersive» off: the bar hides with the rest.
    await p.click('.float-toolbar [aria-label="Visual Options"]'); await visible(p, '.options-grid'); await p.locator('.placed-list').scrollIntoViewIfNeeded(); await settle(p, 300);
    { const sw = p.locator('.options-grid label', { hasText: 'Keep the reading bar when the bars are hidden' }); await sw.scrollIntoViewIfNeeded(); await sw.locator('.switch').click(); await settle(p, 300); }
    await p.evaluate(() => document.querySelector('.panel .panel-head button, .panel [aria-label="Close"]')?.click()); await p.keyboard.press('Escape'); await settle(p, 600);
    await p.touchscreen.tap(206, 460); await settle(p, 900);
    const immOff = await p.evaluate(() => { const s = document.querySelector('.reader-scroll').getBoundingClientRect(); return { on: document.querySelector('.reader-view').classList.contains('immersive'), scrollBottom: s.bottom, h: innerHeight }; });
    ok('immersive, the option off: the bar hides with the rest', immOff.on && !(await isShown(p, '.read-status')), immOff);
    ok('… and the text goes down to the foot of the screen', immOff.scrollBottom >= immOff.h - 1, immOff);
    await p.touchscreen.tap(206, 460); await settle(p, 600);
    // A quick way: the tap zone action «Show / hide the reading bar».
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'statusLine' }))); await settle(p, 400);
    ok('the reader\'s command «statusLine» hides the bar…', !(await isShown(p, '.read-status')));
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'statusLine' }))); await settle(p, 400);
    ok('… and shows it again', await isShown(p, '.read-status'));
    // The scroll budget: layout reads while scrolling, the bar on and off.
    const reads = async () => p.evaluate(async () => { const sc = document.querySelector('.reader-scroll'); sc.scrollTop = 0; await new Promise((r) => setTimeout(r, 400)); window.__rects = 0; for (let i = 0; i < 30; i++) { sc.scrollTop += 37; await new Promise((r) => setTimeout(r, 170)); } return window.__rects; });
    const on = await reads();
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'statusLine' }))); await settle(p, 400);
    const off = await reads();
    ok('the bar adds no layout reads per scroll (getBoundingClientRect over 30 scroll steps: on ≤ off + 3)', on <= off + 3, { on, off });
    await back(p); await p.context().close();
  });

  // ---- 6. The Arabic interface: Arabic digits, the clock as the locale writes it, the start on the right.
  await sect(async () => {
    const p = await phone('ar', withItems); const id = await importBook(p, epubAr);
    await openBook(p, id);
    await scrollInto(p, '.reader-flow .kr-chapter', 1.5);
    await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); v.statusItems = [{ id: 'chapter', on: true, at: 'start' }, { id: 'page', on: true, at: 'start' }, { id: 'clock', on: true, at: 'end' }, { id: 'bookPct', on: true, at: 'end' }, { id: 'chapterLeft', on: true, at: 'end' }]; localStorage.setItem('kr.visual', JSON.stringify(v)); });
    await back(p); await p.reload(); await p.waitForSelector('.library-view'); await openBook(p, id); await settle(p, 600);
    const page = await textOf(p, 'page'), pct = await textOf(p, 'bookPct'), clock = await textOf(p, 'clock');
    ok('Arabic: the page in Arabic digits', /^[٠-٩]+ \/ [٠-٩]+$/.test(page ?? ''), page);
    ok('Arabic: the percentage in Arabic digits, with «٪»', /^[٠-٩]+٪/.test(pct ?? '') && !/[0-9%]/.test(pct ?? ''), pct);
    ok('Arabic: the clock as the locale writes it (Arabic digits, «ص»/«م» after them)', /^[٠-٩]{1,2}:[٠-٩]{2}\s[صم]$/.test((clock ?? '').replace(/[‏؜]/g, '')), clock);
    ok('Arabic: pages left in words, «صفحة» counted', /^بقي .*صفح|^آخر صفحة/.test(await textOf(p, 'chapterLeft') ?? ''), await textOf(p, 'chapterLeft'));
    const order = await p.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { start: r('.read-status .rb-start').right, end: r('.read-status .rb-end').left, chapter: r('.read-status .rb-chapter').right, page: r('.read-status .rb-page').right, w: innerWidth }; });
    ok('Arabic: right to left — the start (the chapter, then the page) on the right, the end on the left', order.start > order.w - 30 && order.end < 30 && order.chapter > order.page, order);
    await back(p); await p.context().close();
  });

  // ---- 7. A PDF: the page in the book, and in its chapter (its outline).
  await sect(async () => {
    const p = await phone('en', { showStatusLine: true, statusItems: [{ id: 'chapter', on: true, at: 'start' }, { id: 'page', on: true, at: 'start' }, { id: 'bookPage', on: true, at: 'end' }, { id: 'bookLeft', on: true, at: 'end' }] }); const id = await importBook(p, pdf);
    await openBook(p, id, '.pdf-page canvas');
    await p.evaluate(() => window.__krPdfViewer.goTo(8)); await settle(p, 1500);
    const st = await barState(p);
    ok('PDF: page 8 of 12 in the book, 4 left', (await textOf(p, 'bookPage')) === '8 / 12' && /^4 pages left in book$/.test(await textOf(p, 'bookLeft') ?? ''), st);
    ok('PDF: page 3 of 7 in its chapter «Part B» (pages 6–12, by its outline)', (await textOf(p, 'page')) === '3 / 7' && (await textOf(p, 'chapter')) === 'Part B', st);
    await back(p); await p.context().close();
  });

  // ---- 8. Settings of an older version (src/settings.ts loaded in node, as tests/booksettings.cjs does).
  await sect(async () => {
    const esbuild = require(path.resolve(__dirname, '../node_modules/esbuild'));
    const load = (visual, books) => {
      const store = {}; if (visual) store['kr.visual'] = JSON.stringify(visual); if (books) store['kr.bookVisual'] = JSON.stringify(books);
      const ls = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
      const code = esbuild.buildSync({ entryPoints: [path.join(SRC, 'settings.ts')], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text;
      const m = { exports: {} }; new Function('module', 'exports', 'localStorage', 'require', code)(m, m.exports, ls, require); return m.exports;
    };
    const on = (S) => (S.getSettings().statusItems ?? []).filter((x) => x.on).map((x) => `${x.id}@${x.at}`).join(',');
    ok('the reading bar is off by default', load(null).getSettings().showStatusLine === false);
    const S1 = load({ showStatusLine: true, showTimeLeft: true });
    ok('older settings (status line on): the same items as before', S1.getSettings().showStatusLine === true && on(S1) === 'chapter@start,page@start,timeChapter@end,clock@end,battery@end,bookPct@end', on(S1));
    const S2 = load({ showStatusLine: true, showTimeLeft: false });
    ok('older settings with the minutes left off: the same, without them', on(S2) === 'chapter@start,page@start,clock@end,battery@end,bookPct@end', on(S2));
    const S3 = load({ showStatusLine: true }, { b1: { showTimeLeft: false, fontSize: 22 } }); S3.setActiveBook('b1');
    ok('… and so for a book of its own settings', on(S3) === 'chapter@start,page@start,clock@end,battery@end,bookPct@end' && S3.getSettings().fontSize === 22, on(S3));
  });

  ok('no page errors', errors.length === 0, errors.slice(0, 5));
  await br.close(); server.close();
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
