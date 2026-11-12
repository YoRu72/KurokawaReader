// node tests/lazychapters.cjs: a book of many chapters opens at its place with only that chapter (and its neighbours)
// made first, the rest made just after while it is read (src/formats/epub.ts render's `first` and `rest`; src/views/
// reader.ts firstChapter, placeFirst, layDoc) — and nothing of the whole book is lost for it:
//  1. the text shows with only a few chapters made, and the book is whole a moment later;
//  2. the contents asked for while the rest is still being made open once it is, and an entry far on is gone to;
//  3. a search finds a phrase in a chapter never opened, and opening the hit lands on it;
//  4. a highlight in a late chapter is on its words, and one in the chapter opened too (once each);
//  5. the place saved at three places, and its percentage, are those of the build before (KR_OLD_DIST, built from the
//     commit before: skipped with a note when not given); and opened again there, the book is at that paragraph from
//     the first moment — before the rest is made;
//  6. continuous reading: opened far in, the text scrolls on through chapters not made yet without a jump, and does not
//     move when they are made;
//  7. read aloud through the whole book goes on into the next chapter;
//  8. an Arabic book (right to left): its direction from the first moment and once whole, a search in a late chapter,
//     and its place and percentage as before.
// (The books are made here: no fixtures. Elements waited for are visible ones.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const OLD = process.env.KR_OLD_DIST ? path.resolve(process.env.KR_OLD_DIST) : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const serve = (dir) => http.createServer((req, res) => { let f = path.join(dir, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dir, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-lazychapters-'));

const EN = 'The river ran past the old city and the people read their books. ';
const AR = 'وكان الليل طويلا على المدينة القديمة والناس يقرؤون الكتب. ';
async function makeEpub(file, { id, title, lang, chapters, text, extra = {} }) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items = [], spine = [], nav = [];
  for (let c = 1; c <= chapters; c++) {
    const head = lang === 'ar' ? `الفصل ${c}` : `Chapter ${c}`;
    const paras = Array.from({ length: 40 }, (_, p) => `<p>[C${c}-P${p}] ${(extra[`${c}-${p}`] ?? '')}${text(c).repeat(3)}</p>`).join('');
    z.file(`OEBPS/c${c}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"${lang === 'ar' ? ' xml:lang="ar" dir="rtl"' : ''}><head><title>C${c}</title></head><body><h1>${head}</h1>${paras}</body></html>`);
    items.push(`<item id="c${c}" href="c${c}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${c}"/>`); nav.push(`<li><a href="c${c}.xhtml">${head}</a></li>`);
  }
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${nav.join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${lang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

const INIT = () => {
  // (The chapters read from the book — XHTML parsed — counted, and the speech stubbed: each passage "spoken" at once.)
  window.__parsed = 0; const pf = DOMParser.prototype.parseFromString;
  DOMParser.prototype.parseFromString = function (s, type) { if (type === 'application/xhtml+xml' && /<body/i.test(s) && !/epub:type="toc"/.test(s)) window.__parsed++; return pf.call(this, s, type); };
  // (How many when the reader puts the text at its place — performance measure kr:restore —, read at that moment.)
  window.__parsedAtPlace = -1; const pm = performance.measure.bind(performance);
  performance.measure = (name, ...r) => { if (name === 'kr:restore' && window.__parsedAtPlace < 0) window.__parsedAtPlace = window.__parsed; return pm(name, ...r); };
  window.__spoken = [];
  try { const s = window.speechSynthesis; s.getVoices = () => [{ name: 'Test', lang: 'en-US', default: true, localService: true, voiceURI: 'test' }]; Object.defineProperty(SpeechSynthesisUtterance.prototype, 'voice', { set() { /* (the stub's voice is no real one) */ }, get() { return null; }, configurable: true }); s.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => { try { u.onend?.(new Event('end')); } catch { /* none */ } }, 5); }; s.cancel = () => undefined; } catch { /* none */ }
};
const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const putBook = (p, id, fn) => p.evaluate(([id, fn]) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const t = r.result.transaction('books', 'readwrite'); const s = t.objectStore('books'); const g = s.get(id); g.onsuccess = () => { const b = g.result; (0, eval)(`(${fn})`)(b); s.put(b); }; t.oncomplete = () => res(); }; }), [id, fn.toString()]);
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 200; i++) {
    const b = (await allBooks(p)).find((x) => new RegExp(re, 'i').test(x.title)); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file);
}
/** The marker of the paragraph at the top of the text, found by points (not by asking every paragraph). */
const topMark = (p) => p.evaluate(() => {
  const sc = document.querySelector('.reader-scroll'); if (!sc) return null; const r = sc.getBoundingClientRect();
  for (let y = r.top + 12; y < r.top + 260; y += 6) for (const fx of [0.5, 0.3, 0.7]) { const e = document.elementFromPoint(r.left + r.width * fx, y)?.closest('.reader-flow p, .reader-flow h1'); const m = /\[(C\d+-P\d+)\]/.exec(e?.textContent ?? ''); if (m) return m[1]; if (e && e.tagName === 'H1') return 'H:' + e.textContent.trim(); }
  return null;
});
/** Text on the screen (a paragraph at a point of it). */
const textShown = (p, timeout = 60000) => p.waitForFunction(() => { for (const fy of [0.3, 0.5, 0.7]) for (const fx of [0.3, 0.5, 0.7]) { const e = document.elementFromPoint(innerWidth * fx, innerHeight * fy)?.closest('.reader-flow .kr-content p'); if (e && e.textContent.trim()) return true; } return false; }, null, { timeout, polling: 'raf' });
const whole = (p) => p.waitForFunction(() => !document.querySelector('.kr-content .kr-shell') && !!document.querySelector('.reader-flow .kr-content'), null, { timeout: 60000 });
async function open(p, id, { waitWhole = true } = {}) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(300);
  await p.evaluate((id) => { window.__parsed = 0; window.__parsedAtPlace = -1; location.hash = `#/read/${id}`; }, id);
  await textShown(p);
  const atFirst = { parsed: await p.evaluate(() => window.__parsedAtPlace), shells: await p.evaluate(() => document.querySelectorAll('.kr-content .kr-shell').length), top: await topMark(p), dir: await p.evaluate(() => document.querySelector('.reader-flow .kr-content')?.getAttribute('dir')) };
  if (waitWhole) { await whole(p); await p.waitForTimeout(1500); }
  return atFirst;
}
/** Go to a chapter by the contents, then bring a paragraph to the top; the place saved then. */
async function placeAt(p, chapterLabel, mark) {
  await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'toc' })));
  await p.waitForSelector('.panel.open .toc-list button'); await p.waitForTimeout(200);
  await p.evaluate((l) => { const b = [...document.querySelectorAll('.panel.open .toc-list button')].find((x) => x.querySelector('.toc-label')?.textContent.trim() === l || x.textContent.trim().startsWith(l + ' ') || x.textContent.trim() === l); b.click(); }, chapterLabel);
  await p.waitForTimeout(500);
  await p.evaluate(() => { const c = document.querySelector('.panel.open .panel-head button'); if (c) c.click(); });
  await p.waitForTimeout(300);
  await p.evaluate((m) => { const sc = document.querySelector('.reader-scroll'); const el = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith(`[${m}]`)); sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 2; }, mark);
  await p.waitForTimeout(1400);
}

async function run(dist, label) {
  const server = serve(dist); await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const page = async (visual = {}) => {
    const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'en', serviceWorkers: 'block' });
    await ctx.addInitScript(INIT);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base); await p.evaluate((v) => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify(v)); }, visual);
    await p.reload(); await p.waitForSelector('.library-view');
    return p;
  };
  const out = { places: {}, ar: {} };
  // ---- the long book, chapter by chapter
  {
    const p = await page({ readingMode: 'chapters' });
    const bk = await importFile(p, LONG, 'Lazy Long');
    // (Highlights kept with the book: one far on, one in the first chapter.)
    await putBook(p, bk.id, `(b) => { b.highlights = [
      { id: 'hl-far', text: '[C250-P3] The river ran', anchor: '${bk.id}-c249', at: 0, color: 'rose', createdAt: 1 },
      { id: 'hl-near', text: '[C1-P2] The river ran', anchor: '${bk.id}-c0', at: 0, color: 'mint', note: 'n', noteAt: 2, createdAt: 2 } ]; }`);
    const first = await open(p, bk.id, { waitWhole: false });
    out.first = first;
    // The contents asked for at once (the toolbar's button), while the rest is still being made.
    const asked = await p.evaluate(() => { const b = document.querySelector('[data-action="toc"]'); if (!b) return false; b.click(); return true; });
    await whole(p);
    if (asked) {
      await p.waitForSelector('.panel.open .toc-list button', { state: 'visible', timeout: 20000 });
      await p.evaluate(() => [...document.querySelectorAll('.panel.open .toc-list button')].find((x) => x.textContent.trim().startsWith('Chapter 300')).click());
      await p.waitForTimeout(900);
      await p.evaluate(() => { const c = document.querySelector('.panel.open .panel-head button'); if (c) c.click(); }); await p.waitForTimeout(300);
      out.tocTop = await topMark(p);
    }
    out.toolbarToc = asked;
    // Search: a phrase in a chapter never opened.
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'search' })));
    await p.waitForSelector('.panel.open input[type=search]', { state: 'visible' });
    await p.fill('.panel.open input[type=search]', 'zephyr quokka');
    await p.waitForFunction(() => document.querySelectorAll('.panel.open .hit').length > 0, null, { timeout: 20000 }).catch(() => undefined);
    await p.waitForTimeout(600);
    out.hits = await p.evaluate(() => [...document.querySelectorAll('.panel.open .hit')].map((h) => h.textContent));
    if (out.hits.length) {
      await p.evaluate(() => document.querySelector('.panel.open .hit button').click()); await p.waitForTimeout(900);
      out.hitShown = await p.evaluate(() => { const hl = CSS.highlights?.get('kr-search-current'); const r = hl && [...hl][0]; if (!r) return null; const rect = r.getBoundingClientRect(); const para = r.startContainer.parentElement.closest('p'); return { text: r.toString(), inView: rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight, para: /\[(C\d+-P\d+)\]/.exec(para?.textContent ?? '')?.[1] }; });
    }
    await p.evaluate(() => { const c = document.querySelector('.panel.open .panel-head button'); if (c) c.click(); }); await p.waitForTimeout(300);
    out.marks = await p.evaluate(() => ({ far: [...document.querySelectorAll('mark[data-hl="hl-far"]')].map((m) => m.textContent).join(''), near: [...document.querySelectorAll('mark[data-hl="hl-near"]')].map((m) => m.textContent).join(''), badges: document.querySelectorAll('.kr-note-badge').length }));
    // Three places, and what is saved there.
    for (const [ch, m] of [['Chapter 5', 'C5-P10'], ['Chapter 160', 'C160-P3'], ['Chapter 300', 'C300-P30']]) {
      await placeAt(p, ch, m);
      const b = (await allBooks(p)).find((x) => x.id === bk.id);
      out.places[m] = { block: b.progress?.block, chapter: b.progress?.chapter, toc: b.progress?.toc, pct: b.progress?.pct, offset: b.progress?.offset, top: await topMark(p) };
    }
    // Opened again at the last place: there from the first moment.
    const again = await open(p, bk.id);
    out.again = { ...again, after: await topMark(p) };
    // Read aloud through the book: on into the next chapter.
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(500);
    await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); v.speechScope = 'book'; localStorage.setItem('kr.visual', JSON.stringify(v)); });
    await putBook(p, bk.id, `(b) => { b.progress = { bookId: b.id, block: ${out.places['C5-P10'].block} + 26, offset: 0, pct: 0.01, chapter: 4 }; }`);
    await p.reload(); await p.waitForSelector('.library-view');
    await open(p, bk.id);
    out.speakFrom = await topMark(p);
    await p.evaluate(() => { window.__spoken = []; document.dispatchEvent(new CustomEvent('kr:command', { detail: 'speak' })); });
    await p.waitForTimeout(2500);
    out.spoken = await p.evaluate(() => window.__spoken.slice(0, 30));
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'speak' })));
    await p.context().close();
  }
  // ---- continuous reading, opened far in
  {
    const p = await page({ readingMode: 'continuous' });
    const bk = await importFile(p, LONG, 'Lazy Long');
    await open(p, bk.id);                     // (once: the chapters' sizes kept)
    await placeAt(p, 'Chapter 150', 'C150-P5');
    const saved = (await allBooks(p)).find((x) => x.id === bk.id).progress;
    out.contPlace = { block: saved?.block, pct: saved?.pct, top: await topMark(p) };
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(300);
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id);
    await textShown(p);
    const startTop = await topMark(p);
    // Scrolled on at once, a little each frame, the marks at the top read each frame — through the moment it is whole.
    const trail = await p.evaluate(() => new Promise((res) => {
      const sc = document.querySelector('.reader-scroll'); const marks = []; let n = 0; let wholeAt = -1;
      sc.dispatchEvent(new WheelEvent('wheel', { deltaY: 6, bubbles: true }));   // (the reader's own hand on it)
      const mark = () => { const r = sc.getBoundingClientRect(); for (let y = r.top + 12; y < r.top + 200; y += 6) { const e = document.elementFromPoint(r.left + r.width / 2, y)?.closest('.reader-flow p'); const m = /\[C(\d+)-P(\d+)\]/.exec(e?.textContent ?? ''); if (m) return +m[1] * 1000 + +m[2]; } return -1; };
      const step = () => { if (wholeAt < 0 && !document.querySelector('.kr-content .kr-shell')) wholeAt = marks.length; if (n < 400) sc.scrollTop += 6; marks.push(mark()); n++; if (n < 520) requestAnimationFrame(step); else res({ marks, wholeAt }); };
      requestAnimationFrame(step);
    }));
    const seen = trail.marks.filter((m) => m >= 0);
    let back = 0, leap = 0; for (let i = 1; i < seen.length; i++) { if (seen[i] < seen[i - 1]) back++; const d = (Math.floor(seen[i] / 1000) - Math.floor(seen[i - 1] / 1000)) * 40 + (seen[i] % 1000) - (seen[i - 1] % 1000); if (d > 3) leap++; }
    out.cont = { startTop, wholeAt: trail.wholeAt, n: seen.length, first: seen[0], last: seen[seen.length - 1], back, leap, unreadable: trail.marks.length - seen.length };
    await p.context().close();
  }
  // ---- an Arabic book
  {
    const p = await page({ readingMode: 'chapters' });
    const bk = await importFile(p, ARB, 'كتاب طويل');
    const first = await open(p, bk.id);
    out.ar.dirFirst = first.dir; out.ar.dirWhole = await p.evaluate(() => document.querySelector('.reader-flow .kr-content')?.getAttribute('dir'));
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'search' })));
    await p.waitForSelector('.panel.open input[type=search]', { state: 'visible' });
    await p.fill('.panel.open input[type=search]', 'الطائر الأزرق');
    await p.waitForFunction(() => document.querySelectorAll('.panel.open .hit').length > 0, null, { timeout: 20000 }).catch(() => undefined);
    await p.waitForTimeout(500);
    out.ar.hits = await p.evaluate(() => document.querySelectorAll('.panel.open .hit').length);
    if (out.ar.hits) { await p.evaluate(() => document.querySelector('.panel.open .hit button').click()); await p.waitForTimeout(900); out.ar.hitPara = await p.evaluate(() => { const hl = CSS.highlights?.get('kr-search-current'); const r = hl && [...hl][0]; return r ? /\[(C\d+-P\d+)\]/.exec(r.startContainer.parentElement.closest('p')?.textContent ?? '')?.[1] : null; }); }
    await p.evaluate(() => { const c = document.querySelector('.panel.open .panel-head button'); if (c) c.click(); }); await p.waitForTimeout(300);
    await placeAt(p, 'الفصل 33', 'C33-P7');
    const b = (await allBooks(p)).find((x) => x.id === bk.id);
    out.ar.place = { block: b.progress?.block, chapter: b.progress?.chapter, toc: b.progress?.toc, pct: b.progress?.pct, top: await topMark(p) };
    const again = await open(p, bk.id);
    out.ar.again = { top: again.top, shells: again.shells, dir: again.dir, after: await topMark(p) };
    await p.context().close();
  }
  out.errors = errors;
  await br.close(); server.close();
  console.log(`(${label} done)`);
  return out;
}

let LONG, ARB;
(async () => {
  LONG = path.join(TMP, 'lazy-long.epub');
  await makeEpub(LONG, { id: 'kr-lazy-long', title: 'Lazy Long', lang: 'en', chapters: 320, text: () => EN, extra: { '280-12': 'zephyr quokka seventy ' } });
  ARB = path.join(TMP, 'kitab.epub');
  await makeEpub(ARB, { id: 'kr-lazy-ar', title: 'كتاب طويل', lang: 'ar', chapters: 60, text: () => AR, extra: { '50-20': 'الطائر الأزرق ' } });

  const now = await run(DIST, 'this build');
  const f = now.first;
  ok('1. the text shows with only the first chapters made (few chapters read, the rest still empty)', f.parsed >= 1 && f.parsed <= 3 && f.shells > 200, f);
  ok('1. ...at the start of the book', f.top === 'H:Chapter 1' || f.top === 'C1-P0', f.top);
  ok('2. the contents asked for while the rest was being made opens once it is, and Chapter 300 is gone to', now.toolbarToc && /^(H:Chapter 300|C300-P0)$/.test(now.tocTop ?? ''), { asked: now.toolbarToc, top: now.tocTop });
  ok('3. a phrase in a chapter never opened is found', now.hits.length === 1 && /zephyr quokka/.test(now.hits[0]), now.hits);
  ok('3. ...and opening the hit lands on it, in view', now.hitShown?.text === 'zephyr quokka' && now.hitShown.inView && now.hitShown.para === 'C280-P12', now.hitShown);
  ok('4. the highlight far on is on its words; the one in the chapter opened too, once each, its note numbered', now.marks.far === '[C250-P3] The river ran' && now.marks.near === '[C1-P2] The river ran' && now.marks.badges === 1, now.marks);
  for (const [m, v] of Object.entries(now.places)) ok(`5. ${m}: the place is there`, v.top === m, v);
  ok('5. opened again at the last place: there from the first moment, the rest still being made, and still there once whole', now.again.top === 'C300-P30' && now.again.parsed >= 1 && now.again.parsed <= 3 && now.again.shells > 200 && now.again.after === 'C300-P30', now.again);
  ok('7. read aloud through the book goes on into the next chapter', /^C5-P3\d$/.test(now.speakFrom ?? '') && now.spoken.some((x) => /^\[C5-P3\d\]/.test(x)) && now.spoken.some((x) => /Chapter 6|\[C6-P0\]/.test(x)), { from: now.speakFrom, spoken: now.spoken.map((x) => x.slice(0, 24)) });
  const c = now.cont;
  ok('6. continuous: opened far in, at its place from the first moment', c.startTop === 'C150-P5', c);
  ok('6. continuous: scrolled on through chapters not made yet and through the moment they are, never back and never leaping', c.wholeAt > 0 && c.back === 0 && c.leap === 0 && c.unreadable === 0 && c.n > 300, c);
  ok('8. Arabic: right to left from the first moment and once whole', now.ar.dirFirst === 'rtl' && now.ar.dirWhole === 'rtl', now.ar);
  ok('8. Arabic: a phrase in a late chapter found and landed on', now.ar.hits === 1 && now.ar.hitPara === 'C50-P20', now.ar);
  ok('8. Arabic: the place kept, and there again from the first moment', now.ar.place.top === 'C33-P7' && now.ar.again.top === 'C33-P7' && now.ar.again.after === 'C33-P7' && now.ar.again.dir === 'rtl', now.ar);
  ok('no page errors', now.errors.length === 0, now.errors);

  if (OLD) {
    const was = await run(OLD, 'the build before');
    const same = (a, b) => a && b && a.block === b.block && a.chapter === b.chapter && a.toc === b.toc && Math.abs((a.pct ?? 0) - (b.pct ?? 0)) < 1e-6;
    for (const m of Object.keys(now.places)) ok(`5. ${m}: the place saved and its percentage are those of the build before`, same(now.places[m], was.places[m]), { now: now.places[m], was: was.places[m] });
    ok('6. continuous: the place saved and its percentage are those of the build before', now.contPlace.block === was.contPlace.block && Math.abs(now.contPlace.pct - was.contPlace.pct) < 0.002, { now: now.contPlace, was: was.contPlace });
    ok('8. Arabic: the place saved and its percentage are those of the build before', same(now.ar.place, was.ar.place), { now: now.ar.place, was: was.ar.place });
    ok('the build before: the same hits and marks (the test itself checked)', was.hits.length === 1 && was.marks.far === now.marks.far, { hits: was.hits.length, marks: was.marks });
  } else console.log('note: KR_OLD_DIST not given — the comparison with the build before is skipped');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
