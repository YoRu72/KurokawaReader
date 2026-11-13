// node tests/highlightplace.cjs: highlights and notes come back where they were made (src/ui/selection.ts findTextRange,
// src/views/reader.ts addHighlight / applyHighlights), and changes to notes reach sync:
//  1. a phrase that the chapter has twice, highlighted at its second place, comes back there (not at the first), in
//     English and in Arabic (right to left);
//  2. a highlight across two paragraphs, and one across two chapters, comes back (they vanished);
//  3. a highlight made with typographic punctuation on comes back with it off, and turning it off or on while the book
//     is open keeps the text whole and the highlight shown;
//  4. a highlight saved by an earlier version (only its words) still comes back at the first place, as before; the
//     new fields go through a backup and a sync untouched;
//  5. a note cleared (in the book's panel, in the notes view) or a PDF highlight's note edited is stamped and marked for
//     sync, and the edit reaches the other device.
// (The books are made here: no fixtures.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (req.url.startsWith('/blank')) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><body>'); return; } if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-hlplace-'));

const EN = path.join(TMP, 'bells.txt');
fs.writeFileSync(EN, ['The Bells of Arden', 'At noon the old bell rang over the square. Nobody came.', 'A paragraph between them, with words of its own and nothing more.',
  'At night the old bell rang over the square again. Everybody came running.', 'She whispered "come back" -- and the door closed... softly.', 'Last paragraph of the little book.'].join('\n\n') + '\n');
const AR = path.join(TMP, 'jaras.txt');
fs.writeFileSync(AR, ['أجراس القرية', 'في الصباح قال الشيخ كلمة طيبة للناس. ولم يحضر أحد.', 'فقرة بينهما فيها كلام آخر لا صلة له بما قبله.',
  'وفي المساء قال الشيخ كلمة طيبة مرة أخرى. فحضر الجميع مسرعين.', 'الفقرة الأخيرة من الكتاب الصغير.'].join('\n\n') + '\n');

async function makeEpub(file) {
  const JSZip = require('jszip'); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const ch = (t, ps) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head><body><h1>${t}</h1>${ps.map((p) => `<p>${p}</p>`).join('')}</body></html>`;
  z.file('OEBPS/c1.xhtml', ch('Chapter One', ['The first chapter opens here with plain words.', 'The river ran past the mill and the miller slept. The end of chapter one comes now']));
  z.file('OEBPS/c2.xhtml', ch('Chapter Two', ['Morning came to the valley and the miller woke.', 'The second chapter closes here.']));
  z.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter One</a></li><li><a href="c2.xhtml">Chapter Two</a></li></ol></nav></body></html>');
  z.file('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-hlplace-mill</dc:identifier><dc:title>The Mill</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
async function makePdf(file) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  const pg = d.addPage([400, 500]); pg.drawText('A page of the paper with a line to mark.', { x: 40, y: 420, size: 14, font });
  fs.writeFileSync(file, await d.save());
}

// ---- page helpers
const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const bookBy = async (p, re) => (await allBooks(p)).find((b) => new RegExp(re).test(b.title));
const patchBook = (p, id, fnSrc) => p.evaluate(([id, fnSrc]) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.get(id); q.onsuccess = () => { const b = q.result; (0, eval)(fnSrc)(b); st.put(b); tx.oncomplete = () => res(); }; }; }), [id, fnSrc]);
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(800);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 120; i++) {
    const b = await bookBy(p, re); if (b) return b;
    // (A library with books asks where the new ones go: the library.)
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file + ' ' + JSON.stringify((await allBooks(p)).map((b) => b.title)) + (await p.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' / '))));
}
async function openReader(p, id, sel = '.reader-flow .kr-content') {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForSelector(sel, { timeout: 30000 }); await p.waitForTimeout(900);
}
/** Selects from `a` (in the block holding `aIn`) to the end of `b` (in the block holding `bIn`, else the same). */
const select = (p, aIn, a, bIn, b) => p.evaluate(([aIn, a, bIn, b]) => {
  const blocks = [...document.querySelectorAll('.reader-flow p')];
  const textAt = (blk, s) => { const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf(s); if (i >= 0) return [n, i]; } return null; };
  const A = blocks.find((x) => x.textContent.includes(aIn)); const B = blocks.find((x) => x.textContent.includes(bIn ?? aIn));
  const s = textAt(A, a); const e = textAt(B, b ?? a); if (!s || !e) return false;
  s[0].parentElement.scrollIntoView({ block: 'center' });
  const r = document.createRange(); r.setStart(s[0], s[1]); r.setEnd(e[0], e[1] + (b ?? a).length);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return true;
}, [aIn, a, bIn ?? null, b ?? null]);
async function highlightSelection(p) {
  await p.waitForSelector('.sel-toolbar .sel-colors .dot', { timeout: 5000 });
  await p.click('.sel-toolbar .sel-colors .dot'); await p.waitForTimeout(700);
}
/** Where the marks of the (only) highlight are: the texts of their paragraphs, and the marked words. */
const marks = (p) => p.evaluate(() => { const ms = [...document.querySelectorAll('.reader-flow mark.kr-hl')]; return { n: ms.length, paras: [...new Set(ms.map((m) => m.closest('p')?.textContent ?? ''))], text: ms.map((m) => m.textContent).join('|') }; });

(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port; const base = `http://127.0.0.1:${port}/`;
  const br = await chromium.launch(); const errors = [];
  const newPage = async (lang, visual = {}) => {
    const ctx = await br.newContext({ viewport: { width: 900, height: 900 }, locale: lang });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base);
    await p.evaluate(([l, v]) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', bookFormat: false, ...v })); }, [lang, visual]);
    await p.reload(); await p.waitForSelector('.library-view'); return p;
  };

  // ---- 1. the second of two places, in English and in Arabic
  for (const [lang, file, title, phrase, first, second] of [['en', EN, 'Bells', 'old bell rang over the square', 'Nobody', 'Everybody'], ['ar', AR, 'أجراس', 'قال الشيخ كلمة طيبة', 'يحضر أحد', 'الجميع']]) {
    const p = await newPage(lang); const tag = `[${lang}] `;
    const bk = await importFile(p, file, title); await openReader(p, bk.id);
    if (lang === 'ar') ok(tag + 'the Arabic book reads right to left', await p.evaluate(() => getComputedStyle(document.querySelector('.reader-flow p')).direction === 'rtl'));
    ok(tag + 'selected the second place', await select(p, second, phrase));
    await highlightSelection(p);
    let m = await marks(p); ok(tag + 'marked at once at the second place', m.paras.length === 1 && m.paras[0].includes(second), m);
    await p.reload(); await p.waitForSelector('.reader-flow .kr-content'); await p.waitForTimeout(900);
    m = await marks(p); ok(tag + 'opened again: the highlight is at the second place, not the first', m.n > 0 && m.paras.length === 1 && m.paras[0].includes(second) && !m.paras[0].includes(first), m);
    // a note on the first place of the same words: both come back, each at its own
    ok(tag + 'selected the first place', await select(p, first, phrase));
    await p.waitForSelector('.sel-toolbar'); await p.click('.sel-toolbar .sel-row button:nth-child(6)'); await p.waitForSelector('.sheet textarea');
    await p.fill('.sheet textarea', lang === 'en' ? 'a note on the first' : 'تعليق على الأولى'); await p.click('.sheet .btn.primary'); await p.waitForTimeout(700);
    await p.reload(); await p.waitForSelector('.reader-flow .kr-content'); await p.waitForTimeout(900);
    const both = await p.evaluate(() => [...document.querySelectorAll('.reader-flow mark.kr-hl')].map((m) => ({ note: m.classList.contains('has-note'), para: m.closest('p').textContent })));
    ok(tag + 'the note at the first place, the highlight at the second', both.some((x) => x.note && x.para.includes(first)) && both.some((x) => !x.note && x.para.includes(second)) && both.length >= 2, both);
    const stored = (await bookBy(p, title)).highlights;
    ok(tag + 'each kept with its place in the chapter', stored.length === 2 && stored.every((h) => typeof h.at === 'number'), stored);
    await p.context().close();
  }

  // ---- 2. across two paragraphs; across two chapters
  {
    const p = await newPage('en'); const bk = await importFile(p, EN, 'Bells'); await openReader(p, bk.id);
    ok('selected across two paragraphs', await select(p, 'A paragraph between', 'with words of its own', 'Everybody', 'At night the old bell'));
    await highlightSelection(p);
    await p.reload(); await p.waitForSelector('.reader-flow .kr-content'); await p.waitForTimeout(900);
    const m = await marks(p); ok('across two paragraphs: both parts marked when opened again', m.paras.length === 2 && m.text.includes('with words of its own') && m.text.includes('At night the old bell'), m);
    const ep = path.join(TMP, 'mill.epub'); await makeEpub(ep);
    const mill = await importFile(p, ep, 'Mill'); await openReader(p, mill.id);
    ok('selected across two chapters', await select(p, 'miller slept', 'the miller slept', 'Morning came', 'Morning came'));
    await highlightSelection(p);
    await p.reload(); await p.waitForSelector('.reader-flow .kr-content'); await p.waitForTimeout(1200);
    const c = await p.evaluate(() => { const ms = [...document.querySelectorAll('.reader-flow mark.kr-hl')]; return { chapters: new Set(ms.map((m) => m.closest('.kr-chapter')?.id)).size, text: ms.map((m) => m.textContent).join('|') }; });
    ok('across two chapters: both parts marked when opened again', c.chapters === 2 && c.text.includes('miller slept') && c.text.includes('Morning came'), c);
    await p.context().close();
  }

  // ---- 3. typographic punctuation
  {
    const p = await newPage('en', { smartTypography: true }); const bk = await importFile(p, EN, 'Bells'); await openReader(p, bk.id);
    ok('selected words with curly quotes, a dash and an ellipsis', await select(p, 'whispered', '“come back”', 'whispered', 'closed…'));
    await highlightSelection(p);
    const stored = (await bookBy(p, 'Bells')).highlights[0]?.text ?? '';
    ok('the highlight keeps the words as shown (curly)', /“come back” — and the door closed…/.test(stored), stored);
    // turned off in the settings while the book is open
    await p.evaluate(() => { [...document.querySelectorAll('.float-toolbar button')].find((b) => /Visual|Appearance|Display|Text/i.test(b.getAttribute('aria-label') ?? ''))?.click(); });
    await p.waitForSelector('.panel.open');
    const flip = () => p.evaluate(() => { const row = [...document.querySelectorAll('.panel label.row')].find((r) => /Typographic punctuation/.test(r.textContent)); row.querySelector('input').click(); });
    await flip(); await p.waitForTimeout(500);
    let para = await p.evaluate(() => [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.includes('whispered')).textContent);
    let m = await marks(p);
    ok('turned off while open: the paragraph whole, straight again', para === 'She whispered "come back" -- and the door closed... softly.', para);
    ok('turned off while open: still highlighted', m.n > 0 && m.text.replace(/\|/g, '').includes('come back'), m);
    await flip(); await p.waitForTimeout(500);
    para = await p.evaluate(() => [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.includes('whispered')).textContent); m = await marks(p);
    ok('turned on again: whole and still highlighted', para === 'She whispered “come back” — and the door closed… softly.' && m.n > 0, { para, m });
    await flip(); await p.waitForTimeout(500);
    await p.reload(); await p.waitForSelector('.reader-flow .kr-content'); await p.waitForTimeout(900);
    m = await marks(p); ok('opened again with it off: the highlight is shown on the straight text', m.n > 0 && m.text.replace(/\|/g, '').includes('"come back" -- and the door closed...'), m);
    await p.context().close();
  }

  // ---- 4. an earlier version's highlight; backup and sync keep the new fields
  {
    const p = await newPage('en'); const bk = await importFile(p, EN, 'Bells');
    await patchBook(p, bk.id, `(b) => { b.highlights = [{ id: 'old1', text: 'old bell rang over the square', color: 'rose', note: 'from before', createdAt: 1000 }]; }`);
    await openReader(p, bk.id);
    const m = await marks(p); ok('an earlier version\'s highlight: at the first place, as before, with its note', m.paras.length === 1 && m.paras[0].includes('Nobody') && (await p.$('mark.kr-hl.has-note')) !== null, m);
    await p.context().close();
  }
  {
    // Two devices with the app's own modules (as tests/syncmerge.cjs), syncing through a file kept here.
    const esbuild = require('esbuild'); const SRC = process.env.KR_SRC ? path.resolve(process.env.KR_SRC) : path.resolve(__dirname, '../src');
    const entry = path.join(TMP, 'entry.ts'); fs.writeFileSync(entry, ['db', 'sync', 'backup'].map((m, i) => `import * as m${i} from ${JSON.stringify(path.join(SRC, m))};`).join('\n') + `\n(window as any).T = { db: m0, sync: m1, B: m2 };\n`);
    const code = esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser', logLevel: 'error', define: { 'import.meta.url': '"http://127.0.0.1/"' } }).outputFiles[0].text;
    let remote = null;
    const device = async (name) => {
      const ctx = await br.newContext(); const q = await ctx.newPage(); q.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      await q.exposeFunction('__remoteRead', () => remote); await q.exposeFunction('__remoteWrite', (t) => { remote = t; return true; });
      await q.goto(`${base}blank`);
      await q.evaluate((n) => { localStorage.setItem('kr.device', n); localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.visual', JSON.stringify({ syncProvider: 'folder', syncFolder: '/cloud', syncAuto: false })); window.kurokawaDesktop = { readTextFile: () => window.__remoteRead(), writeTextFile: (_p, t) => window.__remoteWrite(t) }; }, name);
      await q.addScriptTag({ content: code }); await q.waitForFunction(() => !!window.T); return q;
    };
    const put = (q, hl, phl) => q.evaluate(([hl, phl]) => T.db.db.putBook({ id: 'bk1', title: 'Paper', format: 'pdf', fileName: 'paper.pdf', size: 1234, addedAt: 1, bookmarks: [], highlights: hl, pdfHighlights: phl, pins: [] }), [hl, phl]);
    const get = (q) => q.evaluate(() => T.db.db.getBook('bk1'));
    const A = await device('devA'), Bd = await device('devB');
    const hl = { id: 'n1', text: 'old bell rang', anchor: 'c1', at: 1, before: 'At night the ', after: ' over the square', color: 'amber', note: 'kept', noteAt: 5, createdAt: 10 };
    const phl = { id: 'p1', page: 1, rects: [[0.1, 0.1, 0.5, 0.05]], text: 'a line to mark', color: 'sky', note: 'first', noteAt: 5, createdAt: 10 };
    await put(A, [hl], [phl]); await put(Bd, [], []);
    for (const q of [A, Bd, A]) { const r = await q.evaluate(() => T.sync.syncNow()); if (!r.ok) errors.push('sync: ' + r.error); }
    const got = (await get(Bd)).highlights[0] ?? {};
    ok('sync: a highlight\'s place (at, before, after) reaches the other device', got.at === 1 && got.before === hl.before && got.after === hl.after && got.anchor === 'c1', got);
    // backup: written on A, the highlight taken away, the backup restored
    const restored = await A.evaluate(async () => { const e = await T.B.makeAutoBackup(); const f = await T.B.autoBackupFile(e); await T.db.db.updateBook('bk1', (b) => { b.highlights = []; }); await T.B.restoreBackup(f, undefined, { settings: false }); return (await T.db.db.getBook('bk1')).highlights[0] ?? {}; });
    ok('backup and restore keep a highlight\'s place', restored.at === 1 && restored.before === hl.before && restored.after === hl.after, restored);
    // a PDF highlight's note edited on B (stamped later) reaches A; a cleared note too
    await Bd.evaluate(() => T.db.db.updateBook('bk1', (b) => { b.pdfHighlights[0].note = 'edited on B'; b.pdfHighlights[0].noteAt = Date.now(); b.highlights[0].note = undefined; b.highlights[0].noteAt = Date.now(); }));
    for (const q of [Bd, A, Bd, A]) { const r = await q.evaluate(() => T.sync.syncNow()); if (!r.ok) errors.push('sync: ' + r.error); }
    const a = await get(A);
    ok('sync: a PDF highlight\'s note edited on one device reaches the other', a.pdfHighlights[0].note === 'edited on B', a.pdfHighlights);
    ok('sync: a note cleared on one device is cleared on the other', a.highlights[0].note === undefined && a.highlights[0].at === 1, a.highlights);
    for (const q of [A, Bd]) await q.context().close();
  }

  // ---- 5. a cleared note, a PDF highlight's note: stamped and marked for sync
  {
    const p = await newPage('en', { syncProvider: 'webdav', syncWebdavUrl: 'http://127.0.0.1:9/dav', syncAuto: false });
    const bk = await importFile(p, EN, 'Bells');
    await patchBook(p, bk.id, `(b) => { b.highlights = [{ id: 'h1', text: 'Nobody came', color: 'rose', note: 'one', noteAt: 1000, createdAt: 1000 }, { id: 'h2', text: 'Everybody came', color: 'sky', note: 'two', noteAt: 1000, createdAt: 2000 }]; }`);
    await openReader(p, bk.id);
    await p.evaluate(() => localStorage.removeItem('kr.sync.pending'));
    await p.evaluate(() => { [...document.querySelectorAll('.float-toolbar button')].find((b) => /Contents/.test(b.getAttribute('aria-label') ?? ''))?.click(); });
    await p.waitForSelector('.panel.open'); await p.evaluate(() => { [...document.querySelectorAll('.panel [role=tab], .panel .tabs button, .panel button')].find((b) => b.textContent.trim() === 'Notes')?.click(); });
    await p.waitForSelector('.panel .plain-list li .del'); await p.click('.panel .plain-list li .del'); await p.waitForTimeout(600);
    let h1 = (await bookBy(p, 'Bells')).highlights.find((x) => x.id === 'h1');
    ok('a note cleared in the book\'s panel: stamped', !h1.note && h1.noteAt > 1000, h1);
    ok('a note cleared in the book\'s panel: marked for sync', (await p.evaluate(() => localStorage.getItem('kr.sync.pending'))) === '1');
    // (Leaving the book saves its place, and marks that for sync: the mark looked at only after.)
    await p.evaluate(() => { location.hash = '#/notes'; }); await p.waitForSelector('.notes-book'); await p.click('.notes-head'); await p.waitForTimeout(800);
    await p.evaluate(() => localStorage.removeItem('kr.sync.pending'));
    await p.click('.notes-book .plain-list li .del'); await p.waitForTimeout(600);
    const h2 = (await bookBy(p, 'Bells')).highlights.find((x) => x.id === 'h2');
    ok('a note cleared in the notes view: stamped', !h2.note && h2.noteAt > 1000, h2);
    ok('a note cleared in the notes view: marked for sync', (await p.evaluate(() => localStorage.getItem('kr.sync.pending'))) === '1');
    // a PDF highlight's note
    const pdf = path.join(TMP, 'paper.pdf'); await makePdf(pdf);
    const pb = await importFile(p, pdf, 'paper|Paper|pdf');
    await patchBook(p, pb.id, `(b) => { b.pdfHighlights = [{ id: 'ph1', page: 1, rects: [[0.05, 0.1, 0.9, 0.08]], text: 'a line to mark', color: 'amber', note: 'old', noteAt: 1000, createdAt: 1000 }, { id: 'ph2', page: 1, rects: [[0.05, 0.6, 0.9, 0.05]], text: 'x', color: 'sky', note: 'gone soon', noteAt: 1000, createdAt: 2000 }]; }`);
    await openReader(p, pb.id, '.pdf-page .pdf-hl');
    await p.evaluate(() => localStorage.removeItem('kr.sync.pending'));
    await p.locator('.pdf-hl').first().click({ force: true }); await p.waitForSelector('.sheet textarea');
    await p.fill('.sheet textarea', 'edited'); await p.click('.sheet .btn.primary'); await p.waitForTimeout(600);
    const ph1 = (await bookBy(p, 'paper|Paper|pdf')).pdfHighlights.find((x) => x.id === 'ph1');
    ok('a PDF highlight\'s note edited: saved and stamped', ph1.note === 'edited' && ph1.noteAt > 1000, ph1);
    ok('a PDF highlight\'s note edited: marked for sync', (await p.evaluate(() => localStorage.getItem('kr.sync.pending'))) === '1');
    await p.evaluate(() => { location.hash = '#/notes'; }); await p.waitForSelector('.notes-book'); await p.waitForTimeout(800);
    await p.evaluate(() => localStorage.removeItem('kr.sync.pending'));
    await p.evaluate(() => { const s = [...document.querySelectorAll('.notes-book')].find((x) => /gone soon|edited/.test(x.textContent)); s.querySelector('.notes-head').click(); });
    await p.waitForTimeout(200);
    await p.evaluate(() => { const li = [...document.querySelectorAll('.notes-book .plain-list li')].find((x) => x.textContent.includes('gone soon')); li.querySelector('.del').click(); }); await p.waitForTimeout(600);
    const ph2 = (await bookBy(p, 'paper|Paper|pdf')).pdfHighlights.find((x) => x.id === 'ph2');
    ok('a PDF note cleared in the notes view: stamped and marked for sync', !ph2.note && ph2.noteAt > 1000 && (await p.evaluate(() => localStorage.getItem('kr.sync.pending'))) === '1', ph2);
    await p.context().close();
  }

  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed'); await br.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
