// node tests/backpdf.cjs: the phone's Back never keeps a reader in a book or a place, on an imitated Android phone
// (Capacitor imitated as in tests/backkeys.cjs: its App listeners kept and called as the system would).
//  1. The owner's case (0.62.1, a 573-page PDF at page 531): the book opened again by the app itself at a start (src/resume.ts)
//     while the page was still loading. The browser then puts the reader's address IN PLACE of the start entry (its rule for
//     navigations no tap asked for, before the load), so the way back had nothing beneath the reader: Back and the top
//     bar's arrow called history.back() and nothing happened, again and again. Here the app is opened in a window of its
//     own (nothing beneath its first entry, as in the Android WebView) with a picture that keeps the page loading. Back
//     ×4 and the arrow must both leave; so must a start on the reader's address alone, and a book opened from another app
//     in an earlier run (no caller now).
//  2. The safety net: in every reading mode and format (EPUB by chapters and continuous, text, PDF, CBZ) and from every
//     "something is open" state (nothing, a panel, a sheet, the bars hidden, Back twice on, a page field focused, a sheet
//     that never closes), at most 3 Backs end outside the book; a Back that changed nothing is in the record and the
//     next one leaves.
//  3. The library's levels (English and Arabic): folder → Back → the main page where it was scrolled → Back → the
//     "press again to leave" message; the same for a series, the search with its field open, the selection inside a
//     folder (first Back the selection, then the folder); Settings with a search typed.
// The books are made here.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
// (`?slowload=1`: the start page carries a picture that takes 30 s, so the page is still loading while the app starts —
// as on a phone, where the app's first moves come before the load is over.)
const server = http.createServer((req, res) => {
  const [u, q] = req.url.split('?');
  if (u.startsWith('/slow-load.png')) { setTimeout(() => { res.statusCode = 404; res.end(); }, 30000); return; }
  let f = path.join(DIST, decodeURIComponent(u)); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  if (f.endsWith('index.html') && /slowload=1/.test(q || '')) { res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(f, 'utf8').replace('<div id="app"', '<img src="/slow-load.png" alt="" style="display:none"><div id="app"')); return; }
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res);
});
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-backpdf-'));

const CAP = () => {
  window.__cap = {}; window.__acks = 0;
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    App: { addListener: (ev, fn) => { window.__cap[ev] = fn; return Promise.resolve({ remove() {} }); }, getLaunchUrl: async () => { const u = localStorage.getItem('test.launch'); return u ? { url: u } : null; }, minimizeApp: async () => { window.__minimized = true; } },
    Kurokawa: { setVolumeKeys: async () => {}, setEdgeGuard: async () => ({ ok: true }), getGestureInsets: async () => ({ left: 0, right: 0, nav: 'buttons' }), backAck: async () => { window.__acks++; },
      docInfo: async () => JSON.parse(localStorage.getItem('test.info') || 'null'), repaint: async () => {} },
  } };
};
async function makeEpub(file, id, title, lang, chapters) {
  const JSZip = require('jszip'); const z = new JSZip(); const dir = lang === 'ar' ? 'rtl' : 'ltr';
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  chapters.forEach(([t, body], i) => z.file(`OEBPS/c${i + 1}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" dir="${dir}"><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`));
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>${chapters.map(([t], i) => `<li><a href="c${i + 1}.xhtml">${t}</a></li>`).join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${lang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
async function makePdf(file, pages) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica); doc.setTitle('Long History PDF');
  for (let i = 1; i <= pages; i++) { const pg = doc.addPage([420, 595]); pg.drawText(`Page ${i}`, { x: 60, y: 520, size: 28, font }); pg.drawText(`The river ran past the old city, page ${i}.`, { x: 40, y: 470, size: 11, font }); }
  fs.writeFileSync(file, await doc.save());
}
async function makeCbz(file) {
  const JSZip = require('jszip'); const z = new JSZip();
  // (Three plain pictures: a 1×1 PNG scaled by the reader is enough to open the comic.)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  for (let i = 1; i <= 3; i++) z.file(`p00${i}.png`, png);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
const para = (c, i) => `<p>Chapter ${c}, paragraph ${i}. ${'The river ran past the old city and the people read their books by the water. '.repeat(3)}</p>`;

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en' });
  await ctx.addInitScript(CAP);
  // (The browser's rule, played exactly: a navigation the app makes by itself before its start page has finished loading
  // REPLACES the entry it is on — Chromium does so for `location.hash = …` with no tap behind it (see the note in
  // src/router.ts navigate). Whether the app's own start falls inside that window depends on the device's speed — on the
  // phone it did, here it seldom does —, so with `test.replaced` set the app's step to the book is made the way the
  // browser makes it then: the address changed in place, its hashchange said, no entry added.)
  await ctx.addInitScript(() => {
    let id = null; try { id = localStorage.getItem('test.replaced'); } catch { /* a blank page: no storage */ } if (!id) return;
    const go = () => { if (!document.querySelector('.library-view')) { setTimeout(go, 20); return; } history.replaceState(null, '', `#/read/${id}`); dispatchEvent(new HashChangeEvent('hashchange')); };
    setTimeout(go, 20);
  });
  // (Each change of address with the history's length then, for the record of a failure.)
  await ctx.addInitScript(() => { window.__H = [history.length]; addEventListener('hashchange', () => window.__H.push(`${history.length}${location.hash.slice(0, 7)}@${document.readyState[0]}`)); });
  const watch = (pg) => { pg.on('pageerror', (e) => errors.push(e.message)); return pg; };
  const visible = (p, sel, timeout = 30000) => p.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; }), sel, { timeout, polling: 100 });
  const p0 = watch(await ctx.newPage());
  await p0.goto(base);
  await p0.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ bookPage: 'never', readingMode: 'chapters', turnAnimation: 'none', doubleBackExit: true, libraryView: 'cards', groupSeries: true })); });
  await p0.reload(); await visible(p0, '.library-view');

  // The books.
  const files = { pdf: path.join(TMP, 'long-history.pdf'), epub: path.join(TMP, 'river.epub'), txt: path.join(TMP, 'plain-notes.txt'), cbz: path.join(TMP, 'comic-pages.cbz') };
  await makePdf(files.pdf, 573);
  await makeEpub(files.epub, 'kr-backpdf-en', 'River Chapters', 'en', [1, 2, 3].map((c) => [`Chapter ${c}`, Array.from({ length: 25 }, (_, i) => para(c, i + 1)).join('')]));
  fs.writeFileSync(files.txt, Array.from({ length: 200 }, (_, i) => `Line ${i + 1}: the river ran past the old city and the people read their books.`).join('\n\n'));
  await makeCbz(files.cbz);
  const lib = [];
  for (let i = 1; i <= 24; i++) { const f = path.join(TMP, `Shelf Book ${String(i).padStart(2, '0')}.txt`); fs.writeFileSync(f, `Shelf book ${i}.\n\n` + 'Some words of the book. '.repeat(40)); lib.push(f); }
  for (let i = 1; i <= 3; i++) { const f = path.join(TMP, `Moon Saga Volume ${i}.txt`); fs.writeFileSync(f, `Moon Saga Volume ${i}\n\n` + 'Words of the saga. '.repeat(40)); lib.push(f); }
  const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.map((b) => ({ id: b.id, title: b.title, format: b.format, fileName: b.fileName, size: b.size }))); }; }));
  await p0.setInputFiles('.library-view input[type=file]', [files.pdf, files.epub, files.txt, files.cbz, ...lib]);
  const ids = {}; let books = [];
  const want = { pdf: (b) => b.format === 'pdf', epub: (b) => b.format === 'epub', txt: (b) => /plain-notes/i.test(b.fileName || '') || /plain/i.test(b.title), cbz: (b) => b.format === 'cbz' || /comic/i.test(b.title) };
  for (let i = 0; i < 240; i++) { await p0.waitForTimeout(250); books = await allBooks(p0); for (const k of Object.keys(want)) { const b = books.find(want[k]); if (b) ids[k] = b.id; } if (Object.keys(ids).length === 4 && books.length >= 31) break; }
  ok('the books are imported (a 573-page PDF, EPUB, text, CBZ, 27 small ones)', Object.keys(ids).length === 4 && books.length >= 31, { ids, n: books.length });

  // (Read where the reader is: the route's name and whether the reader is on screen.)
  const where = (p) => p.evaluate(() => ({ app: !!document.querySelector('#app .view'), url: location.href.replace(/^https?:\/\/[^/]+/, ''), hash: location.hash, reader: !!document.querySelector('.reader-view'), lib: !!document.querySelector('.library-view'), min: !!window.__minimized, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ') }));
  const back = async (p, wait = 450) => { await p.evaluate(() => window.__cap.backButton({ canGoBack: true })); await p.waitForTimeout(wait); };
  // (Out of the book, and still in the app: a step back off the app's own first entry — to a blank page — is no way out.)
  const outOfBook = async (p) => { const w = await where(p); return w.app && !w.reader && !/#\/read\//.test(w.hash); };

  /* ---------- 1. The owner's case: a PDF opened again at a start, the page still loading ---------- */
  // (Read once at page 531, as he was: the place saved.)
  await p0.evaluate((id) => { location.hash = `#/read/${id}`; }, ids.pdf); await visible(p0, '.pdf-page'); await p0.waitForTimeout(800);
  await p0.evaluate(() => { const i = document.querySelector('.pdf-bar input[type=number]'); if (i) { i.value = '531'; i.form.requestSubmit(); } }); await p0.waitForTimeout(1200);
  await p0.evaluate(() => { location.hash = '#/'; }); await visible(p0, '.library-view');
  const markOpen = (p, id) => p.evaluate((id) => localStorage.setItem('kr.reading', JSON.stringify({ ids: [id], at: Date.now() })), id);
  // (A window of the app's own — nothing beneath its first entry, as in the WebView —, the start page slow to load.)
  const startApp = async (suffix = '?slowload=1') => {
    const [p] = await Promise.all([ctx.waitForEvent('page'), p0.evaluate((u) => { window.open(u, '_blank', 'noopener'); }, base + suffix)]);
    watch(p); await p.waitForFunction(() => window.__cap && window.__cap.backButton, null, { timeout: 30000 });
    return p;
  };
  const resumed = async (replaced = false) => {
    if (replaced) await p0.evaluate((id) => { localStorage.removeItem('kr.reading'); localStorage.setItem('test.replaced', id); }, ids.pdf); else await markOpen(p0, ids.pdf);
    const p = await startApp(); await visible(p, '.pdf-page'); await p.waitForTimeout(1200);
    await p0.evaluate(() => localStorage.removeItem('test.replaced'));
    return p;
  };
  for (const replaced of [true, false]) {
    const how = replaced ? 'its step to the book replacing the start entry (the phone)' : 'its step to the book an entry of its own';
    {
      const p = await resumed(replaced);
      const st = await p.evaluate(() => ({ hl: history.length, idx: window.navigation?.currentEntry?.index, H: window.__H }));
      let n = 0; for (; n < 4 && !(await outOfBook(p)); n++) await back(p, 800);
      ok(`1a. PDF at page 531 opened by the app at its start, ${how}: phone Back leaves it`, await outOfBook(p), { presses: n, st, ...(await where(p)) });
      ok(`1a. …at the first press (${replaced ? 'replaced' : 'pushed'})`, n === 1, { presses: n });
      await p.close();
    }
    {
      const p = await resumed(replaced);
      await p.evaluate(() => document.querySelector('.reader-view .topbar button[data-icon="back"]').click()); await p.waitForTimeout(1300);
      ok(`1a. …and the top bar's arrow leaves it (${replaced ? 'replaced' : 'pushed'})`, await outOfBook(p), await where(p));
      await p.close();
    }
  }
  {
    // 1b. The app started on the reader's address alone (a link, a shortcut): Back → the library.
    const p = await startApp(`?slowload=1#/read/${ids.pdf}`); await visible(p, '.pdf-page'); await p.waitForTimeout(1000);
    await back(p, 900);
    ok('1b. a start on the reader\'s address alone: Back leaves to the library', await outOfBook(p) && (await where(p)).lib, await where(p));
    await p.close();
  }
  {
    // 1c. Opened from another app in an earlier run, opened again now with the caller's request said again: Back leaves.
    const b = books.find((x) => x.id === ids.pdf);
    await p0.evaluate((b) => { localStorage.setItem('test.launch', 'content://files/long-history.pdf'); localStorage.setItem('test.info', JSON.stringify({ name: b.fileName, size: b.size, persistable: true })); }, b);
    const p = await resumed();
    let n = 0; for (; n < 3 && !(await outOfBook(p)); n++) await back(p, 700);
    ok('1c. a book from another app, opened again at a start: Back leaves (to the caller or the library)', await outOfBook(p), { presses: n, ...(await where(p)) });
    await p0.evaluate(() => { localStorage.removeItem('test.launch'); localStorage.removeItem('test.info'); });
    await p.close();
  }

  /* ---------- 2. The watchdog: every format and mode, every "something is open" state, ≤ 3 Backs ---------- */
  const p = p0;
  const setVisual = async (o) => { await p.evaluate((o) => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, o); localStorage.setItem('kr.visual', JSON.stringify(v)); location.hash = '#/'; }, o); await p.reload(); await visible(p, '.library-view'); await p.waitForTimeout(300); };
  const openBook = async (key) => {
    await p.evaluate(() => { location.hash = '#/'; }); await visible(p, '.library-view');
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, ids[key]);
    try { await visible(p, key === 'pdf' ? '.pdf-page' : key === 'cbz' ? '.reader-view img, .reader-view canvas, .reader-view .kr-content' : '.reader-view .kr-content p, .reader-view .kr-content', 15000); }
    catch (e) { console.log('open failed', key, JSON.stringify(await where(p)), await p.evaluate(() => document.querySelector('#app')?.innerHTML.slice(0, 600))); throw e; }
    await p.waitForTimeout(900);
  };
  const tapMiddle = async () => { await p.touchscreen.tap(206, 460); await p.waitForTimeout(300); };
  const barsShown = () => p.evaluate(() => !document.querySelector('.reader-view')?.classList.contains('immersive'));
  const states = {
    nothing: async () => {},
    barsHidden: async () => { if (await barsShown()) await tapMiddle(); },
    panel: async () => { await p.evaluate(() => (document.querySelector('.reader-view .topbar button[data-icon="more"], .reader-view .float-toolbar button[data-icon="more"]'))?.click()); await p.waitForTimeout(300); },
    sheet: async () => { await p.evaluate(() => { const s = document.createElement('div'); s.className = 'sheet'; s.setAttribute('role', 'dialog'); const hd = document.createElement('div'); hd.className = 'sheet-head'; const b = document.createElement('button'); b.addEventListener('click', () => s.remove()); hd.append(b); s.append(hd); document.body.append(s); }); },
    // (A sheet whose close does nothing — whatever a future bug leaves on the screen.)
    stuckSheet: async () => { await p.evaluate(() => { const s = document.createElement('div'); s.className = 'sheet'; s.setAttribute('role', 'dialog'); const hd = document.createElement('div'); hd.className = 'sheet-head'; hd.append(document.createElement('button')); s.append(hd); document.body.append(s); }); },
    // (A gate that holds every Back, as a future one might.)
    stuckGate: async () => { await p.evaluate(() => { document.querySelector('.reader-view .topbar button[data-icon="back"]')?.addEventListener('click', (e) => e.stopImmediatePropagation(), true); }); },
    pageField: async () => { await p.evaluate(() => document.querySelector('.pdf-bar input[type=number]')?.focus()); },
  };
  const formats = [['epub', 'chapters'], ['epub', 'continuous'], ['txt', 'chapters'], ['pdf', null], ['cbz', null]];
  for (const twice of [false, true]) {
    await setVisual({ backTwiceLeave: twice });
    for (const [fmt, mode] of formats) {
      if (mode) await setVisual({ readingMode: mode, backTwiceLeave: twice });
      for (const [name, put] of Object.entries(states)) {
        if (name === 'pageField' && fmt !== 'pdf') continue;
        await openBook(fmt); await put();
        let n = 0; for (; n < 3 && !(await outOfBook(p)); n++) await back(p, 800);
        const out = await outOfBook(p);
        ok(`2. ${fmt}${mode ? ' ' + mode : ''}, ${name}${twice ? ', Back twice on' : ''}: out of the book in ${n} Back(s) (≤ 3)`, out, { n, ...(await where(p)) });
        await p.evaluate(() => document.querySelectorAll('.sheet').forEach((s) => s.remove()));
      }
    }
  }
  await setVisual({ backTwiceLeave: false, readingMode: 'chapters' });
  const held = await p.evaluate(() => window.__krDiag?.data().events.filter((e) => e.k === 'backheld').map((e) => e.why) ?? []);
  ok('2. a Back that changed nothing is in the record, and the one after it (forced) too', held.includes('noeffect') && held.includes('forced'), held.slice(-8));

  /* ---------- 3. The library's levels ---------- */
  for (const lang of ['en', 'ar']) {
    await p.evaluate((l) => { localStorage.setItem('kr.lang', l); }, lang); await setVisual({});
    const msg = await p.evaluate(() => window.__krT?.('pressAgainToExit') ?? null);
    const exitText = lang === 'ar' ? 'اضغط «رجوع» مرةً أخرى للخروج' : 'Press Back again to leave';
    // A folder with eight of the books.
    await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction(['books', 'meta'], 'readwrite'); tx.objectStore('meta').put([{ id: 'f-one', name: 'Folder One', createdAt: Date.now() }], 'folders'); const st = tx.objectStore('books'); const q = st.getAll(); q.onsuccess = () => { for (const b of q.result) if (/Shelf Book 0[1-8]/.test(b.title)) { b.folderId = 'f-one'; st.put(b); } }; tx.oncomplete = res; }; }));
    await p.evaluate(() => { localStorage.removeItem('kr.folder'); localStorage.removeItem('kr.series'); localStorage.removeItem('kr.tag'); location.hash = '#/'; }); await p.reload(); await visible(p, '.library-view .folder-card');
    await p.waitForTimeout(500);
    const scroller = '.library-body';
    const setScroll = (y) => p.evaluate(([s, y]) => { document.querySelector(s).scrollTop = y; }, [scroller, y]);
    const scrollNow = () => p.evaluate((s) => Math.round(document.querySelector(s).scrollTop), scroller);
    const level = () => p.evaluate(() => document.querySelector('.library-view')?.dataset.level ?? '');
    const clearToasts = () => p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await setScroll(380); await p.waitForTimeout(150); const y0 = await scrollNow();
    await p.evaluate(() => document.querySelector('.library-view .folder-card[data-folder="f-one"]').click()); await p.waitForTimeout(400);
    ok(`3. [${lang}] the folder is entered`, (await level()).startsWith('f-one|'), await level());
    await clearToasts(); await back(p, 600);
    const w1 = await where(p);
    ok(`3. [${lang}] Back inside a folder goes up to the library's main page — no "press again to leave"`, (await level()).startsWith('||') && !w1.toast.includes(exitText) && !w1.min, { level: await level(), ...w1 });
    ok(`3. [${lang}] …where it was scrolled`, Math.abs((await scrollNow()) - y0) <= 2, { y0, now: await scrollNow() });
    await back(p, 600);
    ok(`3. [${lang}] the next Back, on the main page, shows the leave message`, (await where(p)).toast.includes(exitText), await where(p));
    await clearToasts(); await p.waitForTimeout(2100); await p.evaluate(() => { window.__minimized = false; });
    // A series.
    await setScroll(200); await p.waitForTimeout(150); const y1 = await scrollNow();
    const hasSeries = await p.evaluate(() => !!document.querySelector('.library-view .series-card'));
    ok(`3. [${lang}] the series is grouped as one card`, hasSeries);
    if (hasSeries) {
      await p.evaluate(() => document.querySelector('.library-view .series-card').click()); await p.waitForTimeout(400);
      ok(`3. [${lang}] the series is entered`, /^\|[^|]+\|/.test(await level()), await level());
      await back(p, 600);
      ok(`3. [${lang}] Back from the series: the main page, where it was scrolled, no leave message`, (await level()).startsWith('||') && Math.abs((await scrollNow()) - y1) <= 2 && !(await where(p)).toast.includes(exitText), { level: await level(), y1, now: await scrollNow() });
    }
    // The search, its field open.
    await p.click('.library-tools input[type=search]'); await p.keyboard.type('Shelf Book 1'); await p.waitForTimeout(400);
    await back(p, 500);
    ok(`3. [${lang}] Back with a search typed: the search emptied, still the library, no leave message`, (await p.inputValue('.library-tools input[type=search]')) === '' && !(await where(p)).toast.includes(exitText), await where(p));
    await back(p, 500);
    ok(`3. [${lang}] then Back on the main page: the leave message`, (await where(p)).toast.includes(exitText), await where(p));
    await clearToasts(); await p.waitForTimeout(2100);
    // The selection inside a folder.
    await p.evaluate(() => document.querySelector('.library-view .folder-card[data-folder="f-one"]').click()); await p.waitForTimeout(300);
    await p.evaluate(() => document.querySelector('.library-tools button[data-icon="check"], .library-tools .tool-btn[aria-pressed]')?.click()); await p.waitForTimeout(300);
    const selOn = (await level()).includes('|s|');
    await back(p, 500);
    ok(`3. [${lang}] selection inside a folder: the first Back lets the selection go, the folder stays`, selOn && (await level()).startsWith('f-one|') && !(await level()).includes('|s|'), { selOn, level: await level() });
    await back(p, 500);
    ok(`3. [${lang}] …the second leaves the folder for the main page`, (await level()).startsWith('||') && !(await where(p)).toast.includes(exitText), { level: await level() });
    // Settings with a search typed.
    await p.evaluate(() => { location.hash = '#/settings'; }); await visible(p, '.settings-view .settings-search');
    await p.fill('.settings-view .settings-search', 'font'); await p.waitForTimeout(200);
    await back(p, 500);
    ok(`3. [${lang}] Settings: Back with a search typed empties it, Settings stay`, (await where(p)).hash === '#/settings' && (await p.inputValue('.settings-view .settings-search')) === '', await where(p));
    await back(p, 700);
    ok(`3. [${lang}] …the next Back leaves Settings for the library`, (await where(p)).lib && !(await where(p)).toast.includes(exitText), await where(p));
    void msg;
  }
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); });

  ok('no errors on the pages', errors.length === 0, errors.slice(0, 5));
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
