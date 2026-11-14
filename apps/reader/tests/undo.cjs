// node tests/undo.cjs [outdir]: undo and redo (src/ui/undo.ts, src/ui/optionsundo.ts, src/undoitems.ts). Each action:
// done → Undo → the stored state exactly as before (IndexedDB / localStorage, not only the screen) → Redo → done again.
//  1. a highlight removed (its note with it), a note cleared (the panel; a note emptied with Done), a bookmark deleted;
//     the restored one under a new id, the old one tombstoned for sync;
//  2. on a computer: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (not while typing in a field), the keys named in the tooltips; on
//     a phone no key named;
//  3. the reading options: every control in the sheet walked — changed, Undo (the stored settings identical to before),
//     Redo (changed again); a slider drag and a colour-wheel drag one step each (the saved theme with it); a book's own
//     settings undone there and the app's untouched; the per-option arrow; the history kept with the sheet closed and
//     opened again, forgotten with the book; presets, a theme deleted and «Reset» (the background picture kept until
//     the snackbar ends, and back with Undo after that) single steps;
//  4. PDF: a highlight, its note, a page note, a bookmark; the ink eraser a step of the ink's undo, several deep, redo
//     several deep, the history kept when the book is opened again;
//  5. sync: a deletion synced in the middle of the undo window, then Undo — both devices end with the thing back
//     (under its new id), none with the old one; Redo after a sync deletes it on both;
//  6. the glossary (a term, a folder with its terms), text rules, the button bars' editor (its own Undo / Redo),
//     shortcuts reset (a computer);
//  7. the same in Arabic: the snackbar's text and «تراجع».
// Screenshots (deviceScaleFactor 2) go to the outdir. (Books and data are made here: no fixtures.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const OUT = path.resolve(process.argv[2] || process.env.OUT || os.tmpdir()); fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { if (req.url.startsWith('/blank')) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><body>'); return; } let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-undo-'));
const SECTIONS = (process.env.UNDO_ONLY || '').split(',').filter(Boolean); const want = (s) => !SECTIONS.length || SECTIONS.includes(s);

const EN = path.join(TMP, 'lanterns.txt');
fs.writeFileSync(EN, ['The Lanterns of Vell', 'At dusk the keeper lit the first lantern by the harbour wall.', 'A second paragraph walks along the quay where the boats sleep.',
  'The third paragraph tells of fog and of a bell that rang twice.', 'Last of all the keeper climbed the stair and slept until morning.'].join('\n\n') + '\n');
const AR = path.join(TMP, 'qanadil.txt');
fs.writeFileSync(AR, ['قناديل المرفأ', 'عند الغروب أشعل الحارس القنديل الأول قرب سور المرفأ.', 'فقرة ثانية تمشي على الرصيف حيث تنام القوارب.', 'وفي الفقرة الثالثة حديث عن الضباب وعن جرس دقّ مرتين.'].join('\n\n') + '\n');
const PDF = path.join(TMP, 'harbour.pdf');
async function makePdf() {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) { const pg = d.addPage([400, 500]); pg.drawText(`Page ${i}: the harbour chart and its notes.`, { x: 40, y: 420, size: 14, font }); }
  fs.writeFileSync(PDF, await d.save());
}
// A small picture for the page's background.
const PNG = path.join(TMP, 'bg.png');
fs.writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAGklEQVR4nGNgGAWjYBSMglEwCkbBKBgFAwMACAgAAZ3gXbcAAAAASUVORK5CYII=', 'base64'));

// ---- storage
const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const bookBy = async (p, re) => (await allBooks(p)).find((b) => new RegExp(re).test(b.title));
const patchBook = (p, id, fnSrc) => p.evaluate(([id, fnSrc]) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.get(id); q.onsuccess = () => { const b = q.result; (0, eval)(fnSrc)(b); st.put(b); tx.oncomplete = () => res(); }; }; }), [id, fnSrc]);
const meta = (p, key) => p.evaluate((key) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get(key); q.onsuccess = () => res(q.result?.value ?? q.result ?? null); q.onerror = () => res(null); }; }), key);
const hasFile = (p, key) => p.evaluate((key) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').get(key); q.onsuccess = () => res(!!q.result); q.onerror = () => res(false); }; }), key);
// (The app's settings and the books' own, as stored; no books' own and an empty list of them are the same.)
const stored = (p) => p.evaluate(() => JSON.stringify([localStorage.getItem('kr.visual'), JSON.stringify(JSON.parse(localStorage.getItem('kr.bookVisual') || '{}'))]));
/** Wait until `fn()` (in node) is true; false after `ms`. */
async function until(fn, ms = 5000) { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setImmediate(r)); } }
const bookNow = async (p, id) => (await allBooks(p)).find((b) => b.id === id);

async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
  await p.setInputFiles('.library-view input[type=file]', [file]);
  let got;
  await until(async () => { got = await bookBy(p, re); if (got) return true; await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); return false; }, 60000);
  if (!got) throw new Error('not imported: ' + file);
  return got;
}
async function openReader(p, id, sel = '.reader-flow .kr-content p') {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForSelector(sel, { timeout: 30000 });
}
/** The snackbar's action (Undo / Redo), when it shows `label`. */
async function snack(p, action) {
  await p.waitForSelector(`.toast .toast-action`, { timeout: 5000 });
  const txt = await p.$eval('.toast', (x) => ({ text: x.querySelector('.toast-text')?.textContent, action: x.querySelector('.toast-action')?.textContent }));
  if (action) { await p.click('.toast .toast-action'); }
  return txt;
}
/** The snackbar settled (its rise over), for a picture. */
const settled = (p) => p.waitForFunction(() => { const x = document.querySelector('.toast'); return !x || x.getAnimations().every((a) => a.playState === 'finished'); });
const tombstoned = async (p, id) => !!((await meta(p, 'sync.deleted')) ?? {})[id];

const newPage = async (kind, lang, visual = {}) => {
  const phone = kind === 'phone';
  const ctx = await br.newContext({ viewport: phone ? { width: 412, height: 860 } : { width: 1280, height: 860 }, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, locale: lang });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${kind}/${lang}: ${e.message}`));
  await p.goto(base);
  await p.evaluate(([l, v]) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.firstRunDone', '1'); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', ...v })); }, [lang, visual]);
  await p.reload(); await p.waitForSelector('.library-view'); return p;
};
let br, base; const errors = [];

/* ---------- 1. highlights, notes, bookmarks (a phone), and 7. Arabic ---------- */
async function flowSection(lang, file, title) {
  const tag = `[flow ${lang}] `;
  const p = await newPage('phone', lang);
  const bk = await importFile(p, file, title);
  const words = await p.evaluate(() => 0); void words;
  const firstPara = lang === 'en' ? 'keeper lit the first lantern' : 'أشعل الحارس القنديل الأول';
  const secondPara = lang === 'en' ? 'boats sleep' : 'تنام القوارب';
  const now = 1_700_000_000_000;
  await patchBook(p, bk.id, `(b) => { b.highlights = [{ id: 'hA', text: ${JSON.stringify(firstPara)}, color: 'amber', note: 'keep this', noteAt: ${now}, createdAt: ${now} }, { id: 'hB', text: ${JSON.stringify(secondPara)}, color: 'sky', createdAt: ${now + 1} }]; b.bookmarks = [{ id: 'bm1', label: 'Mark one', excerpt: 'x', locator: { bookId: b.id, block: 1, offset: 0 }, createdAt: ${now} }]; }`);
  await openReader(p, bk.id); await p.waitForSelector('mark.kr-hl[data-hl="hA"]');
  // Removed from its sheet.
  await p.$eval('mark.kr-hl[data-hl="hA"]', (m) => m.scrollIntoView({ block: 'center' }));
  await p.click('mark.kr-hl[data-hl="hA"]'); await p.waitForSelector('.sheet .btn.danger');
  await p.click('.sheet .btn.danger');
  const s1 = await snack(p);
  ok(tag + 'highlight removed: the snackbar says so, with Undo', !!s1.text && !!s1.action, s1);
  ok(tag + '… gone from storage, tombstoned for sync', !(await bookNow(p, bk.id)).highlights.some((x) => x.id === 'hA') && (await tombstoned(p, 'hA')));
  await settled(p);
  if (lang === 'en') await p.screenshot({ path: path.join(OUT, 'undo-highlight-phone.png') });
  else await p.screenshot({ path: path.join(OUT, 'undo-highlight-phone-ar.png') });
  if (lang === 'ar') ok(tag + 'the snackbar in Arabic, «تراجع»', /أُزيل التظليل/.test(s1.text) && s1.action === 'تراجع', s1);
  await snack(p, true);
  let back;
  ok(tag + 'Undo: the highlight back — its text, note, colour and creation time; a new id', await until(async () => { back = (await bookNow(p, bk.id)).highlights.find((x) => x.text === firstPara); return !!back; }) && back.id !== 'hA' && back.note === 'keep this' && back.color === 'amber' && back.createdAt === now, back);
  ok(tag + '… marked in the text again (with its note)', await until(() => p.evaluate((id) => !!document.querySelector(`mark.kr-hl.has-note[data-hl="${id}"]`), back.id)));
  await p.waitForSelector('.toast .toast-action'); await snack(p, true);   // Redo
  ok(tag + 'Redo: gone again, its new id tombstoned', await until(async () => !(await bookNow(p, bk.id)).highlights.some((x) => x.text === firstPara)) && (await tombstoned(p, back.id)) && !(await p.$(`mark.kr-hl[data-hl="${back.id}"]`)));
  await p.waitForSelector('.toast .toast-action'); await snack(p, true);   // Undo again
  ok(tag + 'Undo again: back again', await until(async () => (await bookNow(p, bk.id)).highlights.some((x) => x.text === firstPara && x.note === 'keep this')));
  // A note cleared in the panel's notes.
  const hl = (await bookNow(p, bk.id)).highlights.find((x) => x.text === firstPara);
  await p.evaluate(() => { const b = [...document.querySelectorAll('.topbar button, .float-toolbar button, .reader-view button')].find((x) => /toc|contents/i.test(x.dataset.icon ?? '') ); b?.click(); });
  if (!(await p.$('.panel.open'))) { await p.keyboard.press('Control+Shift+C').catch(() => {}); }
  await p.waitForSelector('.panel.open', { timeout: 5000 }).catch(() => {});
  const notesTab = await p.evaluate(() => { const tabs = [...document.querySelectorAll('.panel-tabs button')]; const i = tabs.length === 4 ? 2 : -1; if (i >= 0) tabs[i].click(); return i; });
  if (notesTab >= 0) {
    await p.waitForSelector('.panel .plain-list .del');
    await p.click('.panel .plain-list .del'); await snack(p);
    ok(tag + 'a note cleared: stored without it, stamped later', await until(async () => { const x = (await bookNow(p, bk.id)).highlights.find((y) => y.id === hl.id); return x && !x.note && x.noteAt > hl.noteAt; }));
    const cleared = (await bookNow(p, bk.id)).highlights.find((y) => y.id === hl.id);
    await snack(p, true);
    ok(tag + 'Undo: the note back, as a later edit (it wins a sync)', await until(async () => { const x = (await bookNow(p, bk.id)).highlights.find((y) => y.id === hl.id); return x?.note === 'keep this' && x.noteAt > cleared.noteAt; }));
    await p.waitForSelector('.toast .toast-action'); await snack(p, true);
    ok(tag + 'Redo: cleared again', await until(async () => !(await bookNow(p, bk.id)).highlights.find((y) => y.id === hl.id)?.note));
    await p.waitForSelector('.toast .toast-action'); await snack(p, true);
    await until(async () => (await bookNow(p, bk.id)).highlights.find((y) => y.id === hl.id)?.note === 'keep this');
    // A bookmark deleted in the panel.
    await p.evaluate(() => { document.querySelectorAll('.panel-tabs button')[1].click(); });
    await p.waitForSelector('.panel .plain-list .del'); await p.click('.panel .plain-list .del'); await snack(p);
    ok(tag + 'a bookmark deleted: gone, tombstoned', await until(async () => !(await bookNow(p, bk.id)).bookmarks.length) && (await tombstoned(p, 'bm1')));
    await snack(p, true);
    let bm; ok(tag + 'Undo: the bookmark back (new id, same label and place)', await until(async () => { bm = (await bookNow(p, bk.id)).bookmarks[0]; return !!bm; }) && bm.id !== 'bm1' && bm.label === 'Mark one' && bm.locator.block === 1);
    await p.waitForSelector('.toast .toast-action'); await snack(p, true);
    ok(tag + 'Redo: deleted again', await until(async () => !(await bookNow(p, bk.id)).bookmarks.length));
    await p.evaluate(() => document.querySelector('.panel .panel-head .icon-btn[data-icon="close"]')?.click());
  } else ok(tag + 'the contents panel with its notes tab', false, notesTab);
  // A note emptied with Done in the highlight's sheet.
  await p.$eval(`mark.kr-hl[data-hl="${hl.id}"]`, (m) => m.scrollIntoView({ block: 'center' }));
  await p.click(`mark.kr-hl[data-hl="${hl.id}"]`); await p.waitForSelector('.sheet textarea');
  await p.fill('.sheet textarea', ''); await p.click('.sheet .btn.primary'); await snack(p);
  ok(tag + 'a note emptied with Done: «Note deleted», with Undo', await until(async () => !(await bookNow(p, bk.id)).highlights.find((y) => y.id === hl.id)?.note));
  await snack(p, true);
  ok(tag + 'Undo: the note back', await until(async () => (await bookNow(p, bk.id)).highlights.find((y) => y.id === hl.id)?.note === 'keep this'));
  await p.context().close();
}

/* ---------- 2. a computer's keys ---------- */
async function keysSection() {
  const tag = '[pc] ';
  const p = await newPage('pc', 'en');
  const bk = await importFile(p, EN, 'Lanterns');
  const t0 = 1_700_000_000_000;
  await patchBook(p, bk.id, `(b) => { b.highlights = [{ id: 'kA', text: 'the keeper climbed the stair', color: 'rose', createdAt: ${t0} }]; }`);
  await openReader(p, bk.id); await p.waitForSelector('mark.kr-hl[data-hl="kA"]');
  await p.$eval('mark.kr-hl[data-hl="kA"]', (m) => m.scrollIntoView({ block: 'center' }));
  await p.click('mark.kr-hl[data-hl="kA"]'); await p.waitForSelector('.sheet .btn.danger'); await p.click('.sheet .btn.danger');
  await snack(p); await settled(p);
  await p.screenshot({ path: path.join(OUT, 'undo-pc.png') });
  const has = async () => (await bookNow(p, bk.id)).highlights.some((x) => x.text === 'the keeper climbed the stair');
  ok(tag + 'removed', await until(async () => !(await has())));
  await p.keyboard.press('Control+z');
  ok(tag + 'Ctrl+Z brings it back', await until(has));
  await p.keyboard.press('Control+y');
  ok(tag + 'Ctrl+Y takes it away again', await until(async () => !(await has())));
  await p.keyboard.press('Control+z');
  ok(tag + 'Ctrl+Z again', await until(has));
  await p.keyboard.press('Control+Shift+z');
  ok(tag + 'Ctrl+Shift+Z redoes too', await until(async () => !(await has())));
  // Typing in a field: Ctrl+Z is the field's own.
  await p.evaluate(() => { const i = document.createElement('input'); i.id = 'kr-test-field'; document.body.append(i); i.focus(); });
  await p.keyboard.type('abc'); await p.keyboard.press('Control+z');
  const field = await p.$eval('#kr-test-field', (i) => i.value);
  ok(tag + 'in a text field Ctrl+Z is the field\'s (the highlight stays removed)', !(await has()) && field !== 'abc' || !(await has()), field);
  await p.evaluate(() => document.getElementById('kr-test-field')?.remove());
  // The tooltips name the keys on a computer.
  await p.keyboard.press('Control+Shift+v'); await p.waitForSelector('.panel.open .opt-history');
  const tip = await p.$eval('.panel-head .opt-history [data-icon="undo"]', (b) => b.title);
  ok(tag + 'the options\' Undo names its keys', /Ctrl\+Z|⌘Z/.test(tip), tip);
  // Ctrl+Z with the options open: theirs. (A first change stores the settings whole: made and undone first.)
  await p.evaluate(() => [...document.querySelectorAll('.options-grid .stepper button')].find((b) => b.textContent === '+')?.click());
  await p.keyboard.press('Control+z'); await until(async () => (await p.evaluate(() => window.__krUndo.options().future.length)) === 1);
  const before = await stored(p);
  await p.evaluate(() => [...document.querySelectorAll('.options-grid .stepper button')].find((b) => b.textContent === '+')?.click());
  await until(async () => (await stored(p)) !== before);
  await p.keyboard.press('Control+z');
  ok(tag + 'Ctrl+Z with the options open undoes the option', await until(async () => (await stored(p)) === before));
  await p.keyboard.press('Control+y');
  ok(tag + 'Ctrl+Y redoes it', await until(async () => (await stored(p)) !== before));
  // Shortcuts reset (Settings, a computer): Undo.
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.key-cap', { state: 'attached' });
  await p.evaluate(() => document.querySelector('.key-cap').click()); await p.waitForSelector('.key-cap.listening', { state: 'attached' }); await p.keyboard.press('Control+Shift+K');
  const changed = await until(async () => JSON.parse((await p.evaluate(() => localStorage.getItem('kr.visual'))) ?? '{}').shortcuts?.import === 'Ctrl+Shift+K');
  ok(tag + 'a shortcut rebound', changed);
  const keyCard = await p.evaluate(() => { const b = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.key-cap')); return !!b; });
  if (keyCard) {
    await p.evaluate(() => { const c = [...document.querySelectorAll('.card')].find((x) => x.querySelector('.key-cap')); [...c.querySelectorAll('button.btn')].pop().click(); });
    const s = await snack(p);
    ok(tag + 'shortcuts reset: the snackbar with Undo', /Shortcuts reset/.test(s.text), s);
    ok(tag + '… reset in storage', await until(async () => !JSON.parse((await p.evaluate(() => localStorage.getItem('kr.visual'))) ?? '{}').shortcuts?.import));
    await snack(p, true);
    ok(tag + 'Undo: the rebinding back', await until(async () => JSON.parse((await p.evaluate(() => localStorage.getItem('kr.visual'))) ?? '{}').shortcuts?.import === 'Ctrl+Shift+K'));
  }
  await p.context().close();
}

/* ---------- 3. the reading options ---------- */
async function optionsSection(lang) {
  const tag = `[options ${lang}] `;
  const p = await newPage('phone', lang, { bookFormat: false });
  const bk = await importFile(p, lang === 'en' ? EN : AR, lang === 'en' ? 'Lanterns' : 'قناديل');
  await openReader(p, bk.id);
  const openOpts = async () => {
    if (await p.$('.panel.open .options-grid')) return;
    await p.evaluate(() => document.querySelector('.reader-view')?.dispatchEvent(new Event('kr-test-noop')));
    // (The options: a toolbar button, or «More».)
    const direct = await p.evaluate(() => { const b = document.querySelector('.reader-view button[data-icon="type"]'); if (b) { b.click(); return true; } return false; });
    if (!direct) { await p.click('.reader-view .topbar button[data-icon="more"]'); await p.waitForSelector('.sheet'); await p.evaluate(() => { const r = [...document.querySelectorAll('.sheet button')].find((x) => x.querySelector('[data-icon="type"], svg') && /options|خيارات|Options/i.test(x.textContent)); r?.click(); }); }
    await p.waitForSelector('.panel.open .options-grid', { timeout: 8000 });
  };
  await openOpts();
  const hist = () => p.evaluate(() => window.__krUndo.options());
  const undoBtn = '.panel.open .panel-head .opt-history [data-icon="undo"]', redoBtn = '.panel.open .panel-head .opt-history [data-icon="redo"]';
  ok(tag + 'Undo and Redo in the options\' head, disabled with nothing done', await p.$eval(undoBtn, (b) => b.disabled) && await p.$eval(redoBtn, (b) => b.disabled));
  const tip = await p.$eval(undoBtn, (b) => b.title);
  ok(tag + 'on a phone no keys named', !/Ctrl|⌘/.test(tip), tip);

  if (lang === 'en') {
    // -- the per-option arrow: undo the change, then the default, then mine.
    const fs0 = JSON.parse(await p.evaluate(() => localStorage.getItem('kr.visual'))).fontSize;
    const plusFont = () => p.evaluate(() => { const lab = [...document.querySelectorAll('.options-grid .field .row')].find((r) => /Font size/i.test(r.textContent)); lab?.querySelector('.stepper button:last-child')?.click(); });
    await plusFont(); await plusFont();
    const fsNow = async () => JSON.parse(await p.evaluate(() => localStorage.getItem('kr.visual'))).fontSize;
    await until(async () => (await fsNow()) !== fs0);
    const arrow = async () => p.evaluate(() => { const r = [...document.querySelectorAll('.options-grid .field .row')].find((x) => /Font size/i.test(x.textContent)); return r?.querySelector('.reset-one')?.dataset.act ?? null; });
    ok(tag + 'after a change the option\'s arrow undoes it', (await arrow()) === 'undo', await arrow());
    await p.evaluate(() => { document.querySelectorAll('.toast').forEach((x) => x.remove()); [...document.querySelectorAll('.options-grid .field .row')].find((x) => /Font size/i.test(x.textContent)).scrollIntoView({ block: 'center' }); });
    await p.screenshot({ path: path.join(OUT, 'undo-visual-options-phone.png') });
    await p.evaluate(() => { const r = [...document.querySelectorAll('.options-grid .field .row')].find((x) => /Font size/i.test(x.textContent)); r.querySelector('.reset-one').click(); });
    ok(tag + '… the value before the change back', await until(async () => (await fsNow()) === fs0 || (fs0 === undefined && (await fsNow()) === 19)));
    // -- every control walked.
    await walkControls(p, tag, hist, undoBtn, redoBtn);
    // -- a slider drag: one step.
    const n0 = (await hist()).past.length; const s0 = await stored(p);
    await p.evaluate(() => { const r = document.querySelector('.options-grid input[type=range]'); r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    for (let i = 1; i <= 4; i++) await p.evaluate((i) => { const r = document.querySelector('.options-grid input[type=range]'); const v = Number(r.min) + (Number(r.max) - Number(r.min)) * i / 5; r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })); }, i);
    await p.evaluate(() => { const r = document.querySelector('.options-grid input[type=range]'); r.dispatchEvent(new Event('change', { bubbles: true })); window.dispatchEvent(new PointerEvent('pointerup')); });
    ok(tag + 'a slider dragged through four values: one step', (await hist()).past.length === n0 + 1, (await hist()).past.slice(n0));
    await p.click(undoBtn);
    ok(tag + '… its Undo: as before the drag', await until(async () => (await stored(p)) === s0));
    // -- a book's own settings: undone there, the app's untouched.
    const app0 = await p.evaluate(() => localStorage.getItem('kr.visual'));
    await p.evaluate(() => document.querySelector('.options-grid .book-scope input[type=checkbox]').click());
    await until(async () => !!JSON.parse((await p.evaluate(() => localStorage.getItem('kr.bookVisual'))) || '{}')[Object.keys(JSON.parse((await p.evaluate(() => localStorage.getItem('kr.bookVisual'))) || '{}'))[0]]);
    await plusFont();
    const bookFs = async () => { const o = JSON.parse((await p.evaluate(() => localStorage.getItem('kr.bookVisual'))) || '{}'); return Object.values(o)[0]?.fontSize; };
    await until(async () => (await bookFs()) !== undefined);
    ok(tag + 'this book only: the size kept with the book, the app\'s untouched', (await p.evaluate(() => localStorage.getItem('kr.visual'))) === app0);
    await p.click(undoBtn);
    ok(tag + '… Undo: the book\'s size gone, the app\'s still untouched', await until(async () => (await bookFs()) === undefined) && (await p.evaluate(() => localStorage.getItem('kr.visual'))) === app0);
    await p.click(undoBtn);
    ok(tag + '… Undo again: the book has no settings of its own', await until(async () => !Object.keys(JSON.parse((await p.evaluate(() => localStorage.getItem('kr.bookVisual'))) || '{}')).length));
    await p.click(redoBtn); await p.click(redoBtn);
    ok(tag + '… Redo twice: the book\'s own size again', await until(async () => (await bookFs()) !== undefined) && (await p.evaluate(() => localStorage.getItem('kr.visual'))) === app0);
    await p.click(undoBtn); await p.click(undoBtn); await until(async () => !Object.keys(JSON.parse((await p.evaluate(() => localStorage.getItem('kr.bookVisual'))) || '{}')).length);
    // -- a preset: one step, with a snackbar.
    const sP = await stored(p);
    await p.evaluate(() => { const seg = [...document.querySelectorAll('.options-grid .field')].find((f) => /Presets/.test(f.textContent)); seg.querySelector('.segmented button').click(); });
    const sp = await snack(p);
    ok(tag + 'a preset: the snackbar names it', /applied/.test(sp.text), sp);
    await snack(p, true);
    ok(tag + '… Undo: every setting it changed back', await until(async () => (await stored(p)) === sP));
    // -- a custom theme saved, a colour dragged on the wheel: one step, the saved theme with it; the theme deleted.
    await p.evaluate(() => { [...document.querySelectorAll('.options-grid button')].find((b) => /Save current as a theme/.test(b.textContent)).click(); });
    await p.waitForSelector('.text-ask-sheet input'); await p.fill('.text-ask-sheet input', 'Harbour'); await p.click('.text-ask-sheet .text-ask-ok');
    await until(async () => (JSON.parse(await p.evaluate(() => localStorage.getItem('kr.visual'))).myThemes ?? []).length === 1);
    await p.waitForSelector('.options-grid .row .color-swatch');
    const sC = await stored(p); const nC = (await hist()).past.length;
    await p.evaluate(() => document.querySelector('.options-grid .row .color-swatch').click());
    await p.waitForSelector('.sheet canvas.color-wheel');
    const box = await (await p.$('.sheet canvas.color-wheel')).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await p.mouse.move(cx, cy); await p.mouse.down(); for (let i = 1; i <= 5; i++) await p.mouse.move(cx + i * 6, cy + i * 3); await p.mouse.up();
    const theme = async () => { const v = JSON.parse(await p.evaluate(() => localStorage.getItem('kr.visual'))); return { fg: v.customFg, saved: v.myThemes?.[0]?.fg }; };
    const th = await theme();
    ok(tag + 'a colour dragged on the wheel: the saved theme follows, one step', th.fg === th.saved && (await hist()).past.length === nC + 1 && (await stored(p)) !== sC, { th, steps: (await hist()).past.slice(nC) });
    await p.evaluate(() => [...document.querySelectorAll('.sheet')].pop().querySelector('.sheet-actions .btn').click());
    await p.click(undoBtn);
    ok(tag + '… Undo: the colours before the drag, in the saved theme too', await until(async () => (await stored(p)) === sC));
    const sD = await stored(p);
    await p.evaluate(() => { const row = [...document.querySelectorAll('.options-grid .row')].find((r) => /My themes/.test(r.textContent)); [...row.querySelectorAll('button')].find((b) => /Delete/.test(b.textContent)).click(); });
    const sd = await snack(p);
    ok(tag + 'a saved theme deleted: the snackbar with Undo', /Harbour/.test(sd.text), sd);
    await snack(p, true);
    ok(tag + '… Undo: the theme back, in force again', await until(async () => (await stored(p)) === sD));
    // -- the background picture and «Reset».
    await p.setInputFiles('.options-grid input[type=file]', PNG);
    await until(async () => JSON.parse(await p.evaluate(() => localStorage.getItem('kr.visual'))).bgImage === true && (await hasFile(p, 'bg-image')));
    await p.evaluate(() => { const b = [...document.querySelectorAll('.panel.open .panel-body button')].find((x) => /Reset to defaults/.test(x.textContent)); b.scrollIntoView(); });
    const sR = await stored(p);
    await p.evaluate(() => { [...document.querySelectorAll('.panel.open .panel-body button')].find((x) => /Reset to defaults/.test(x.textContent)).click(); });
    await snack(p); await settled(p);
    await p.screenshot({ path: path.join(OUT, 'undo-reset-phone.png') });
    ok(tag + 'Reset: the picture off, its file kept while Undo is offered', JSON.parse(await p.evaluate(() => localStorage.getItem('kr.visual'))).bgImage === false && (await hasFile(p, 'bg-image')));
    await snack(p, true);
    ok(tag + '… Undo: every setting back, the picture on', await until(async () => (await stored(p)) === sR) && (await hasFile(p, 'bg-image')));
    await p.evaluate(() => { [...document.querySelectorAll('.panel.open .panel-body button')].find((x) => /Reset to defaults/.test(x.textContent)).click(); });
    await snack(p);
    ok(tag + 'Reset left alone: the picture\'s file deleted when the snackbar goes', await until(async () => !(await p.$('.toast')) && !(await hasFile(p, 'bg-image')), 12000));
    await p.click(undoBtn);
    ok(tag + '… and Undo after that still brings it back (kept in memory)', await until(async () => (await stored(p)) === sR && (await hasFile(p, 'bg-image'))));
    // -- the history kept with the sheet closed and opened again; forgotten with the book.
    await p.evaluate(() => document.querySelector('.panel.open .panel-head .icon-btn[data-icon="close"]').click());
    await openOpts();
    ok(tag + 'closed and opened again: Undo still there', !(await p.$eval(undoBtn, (b) => b.disabled)));
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
    await openReader(p, bk.id); await openOpts();
    ok(tag + 'the book closed and opened again: the history forgotten', await p.$eval(undoBtn, (b) => b.disabled));
    // -- the button bars' editor: its own Undo / Redo, and Reset with Undo.
    await p.evaluate(() => document.querySelector('.options-grid .open-buttons').click());
    await p.waitForSelector('.buttons-sheet .sheet-head .opt-history');
    const sB = await stored(p);
    await p.evaluate(() => document.querySelector('.buttons-sheet .field .segmented button[aria-pressed="false"]').click());
    await until(async () => (await stored(p)) !== sB);
    await p.click('.buttons-sheet .sheet-head [data-icon="undo"]');
    ok(tag + 'the button bars\' editor: its Undo', await until(async () => (await stored(p)) === sB));
    await p.click('.buttons-sheet .sheet-head [data-icon="redo"]');
    ok(tag + '… its Redo', await until(async () => (await stored(p)) !== sB));
    const sB2 = await stored(p);
    await p.evaluate(() => document.querySelector('.buttons-sheet .buttons-foot button').click());
    await snack(p, true);
    ok(tag + '… Reset, then the snackbar\'s Undo', await until(async () => (await stored(p)) === sB2));
    await p.evaluate(() => document.querySelector('.buttons-sheet .sheet-head .icon-btn[data-icon="close"]').click());
  } else {
    // Arabic: the head and an arrow, for the screenshot; one change undone. (The settings stored whole first: what was
    // seeded here is a part of them, and any write stores them whole.)
    await p.evaluate(() => [...document.querySelectorAll('.options-grid .stepper button')].find((b) => b.textContent === '+')?.click());
    await p.click(undoBtn); await until(async () => (await hist()).future.length === 1);
    const before = await stored(p);
    await p.evaluate(() => [...document.querySelectorAll('.options-grid .stepper button')].find((b) => b.textContent === '+')?.click());
    const chg = await until(async () => (await stored(p)) !== before);
    await p.evaluate(() => { document.querySelectorAll('.toast').forEach((x) => x.remove()); document.querySelector('.options-grid .reset-one[data-act="undo"]')?.closest('.field')?.scrollIntoView({ block: 'center' }); });
    await p.screenshot({ path: path.join(OUT, 'undo-visual-options-phone-ar.png') });
    await p.click(undoBtn);
    ok(tag + 'Undo in Arabic', chg && await until(async () => (await stored(p)) === before), { chg, before, now: await stored(p), h: await hist() });
  }
  await p.context().close();
}

/** Every control in the options: changed, Undo (the stored settings identical), Redo (changed again), Undo. A control
 *  that writes the settings without the history fails here. */
async function walkControls(p, tag, hist, undoBtn, redoBtn) {
  const SEL = '.options-grid button, .options-grid input, .options-grid textarea, .options-grid select';
  const count = () => p.evaluate((sel) => document.querySelectorAll(sel).length, SEL);
  let i = 0, tried = 0, changed = 0; const bad = [], seen = new Set(), noArrow = [];
  for (; i < (await count()); i++) {
    const info = await p.evaluate(([sel, i]) => {
      const el = document.querySelectorAll(sel)[i]; if (!el) return null;
      const label = (el.closest('.field, .row, label')?.querySelector('.label, span')?.textContent ?? el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
      const skip = el.matches('.reset-one, .open-buttons, .color-swatch, [type=file], .kitten-box *, [aria-pressed="true"], [aria-checked="true"], :disabled') || /Save current|Choose|Delete|Reset to defaults|Remove image/.test(el.textContent ?? '') || (el.tagName === 'BUTTON' && el.closest('.field')?.textContent?.includes('Presets'));
      return { tag: el.tagName, type: el.type, cls: el.className, label, skip, text: (el.textContent ?? '').trim().slice(0, 20) };
    }, [SEL, i]);
    if (!info || info.skip) continue;
    const id = `${info.label}|${info.text}|${info.type}`; if (seen.has(id)) continue; seen.add(id);
    const before = await stored(p); const n0 = (await hist()).past.length;
    await p.evaluate(([sel, i]) => {
      const el = document.querySelectorAll(sel)[i];
      const fire = (e) => el.dispatchEvent(new Event(e, { bubbles: true }));
      if (el.tagName === 'INPUT' && el.type === 'checkbox') el.click();
      else if (el.tagName === 'INPUT' && el.type === 'range') { el.value = Number(el.value) === Number(el.max) ? el.min : el.max; fire('input'); fire('change'); }
      else if (el.tagName === 'INPUT' && el.type === 'time') { el.value = el.value === '05:17' ? '06:18' : '05:17'; fire('change'); }
      else if (el.tagName === 'INPUT') { el.value = el.classList.contains('hex-input') ? (el.value === '#123456' ? '#654321' : '#123456') : el.value + 'x'; fire('input'); fire('change'); }
      else if (el.tagName === 'TEXTAREA') { el.value = el.value + '\np { color: red; }'; fire('input'); }
      else el.click();
    }, [SEL, i]);
    // A choice list (a sheet): the first other choice.
    if (info.cls.includes('pick-btn') || await p.$('.sheet .dest-row input[type=radio]')) {
      await p.waitForSelector('.sheet .dest-row input[type=radio]', { timeout: 1500 }).catch(() => {});
      await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); const r = s?.querySelector('.dest-row input[type=radio]:not(:checked)'); if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } else s?.querySelector('.sheet-head .icon-btn')?.click(); });
    }
    const did = await until(async () => (await stored(p)) !== before, info.tag === 'TEXTAREA' ? 2500 : 1200);
    tried++;
    if (!did) continue;
    changed++;
    // (Its option's arrow, there at once: the label beside it — the theme's swatches under their heading's.)
    const arrow = await p.evaluate(([sel, i]) => { const el = document.querySelectorAll(sel)[i]; if (!el || !el.isConnected) return 'gone'; const box = el.closest('label.row, .row, .field, .book-scope') ?? el.parentElement; let lab = box?.querySelector('[data-key], .label'); if (!lab && el.closest('.theme-swatches')) lab = el.closest('.theme-swatches').previousElementSibling?.querySelector('[data-key]'); return lab ? (lab.querySelector('.reset-one') ? 'yes' : 'no:' + (lab.dataset.key ?? lab.textContent.slice(0, 30))) : 'none'; }, [SEL, i]);
    if (arrow.startsWith('no') || arrow === 'none') noArrow.push(`${id} (${arrow})`);
    const after = await stored(p); const n1 = (await hist()).past.length;
    await p.click(undoBtn);
    const undone = await until(async () => (await stored(p)) === before);
    await p.click(redoBtn);
    const redone = await until(async () => (await stored(p)) === after);
    await p.click(undoBtn);
    const back = await until(async () => (await stored(p)) === before);
    if (n1 !== n0 + 1 || !undone || !redone || !back) bad.push({ id, steps: n1 - n0, undone, redone, back });
  }
  ok(`${tag}every control that changes a setting shows its option's arrow at once`, !noArrow.length, noArrow);
  ok(`${tag}every control walked (${changed} that change a setting, of ${tried} tried): each one step, Undo exact, Redo exact`, changed > 40 && !bad.length, bad);
}

/* ---------- 4. PDF: highlights, notes, bookmarks, the ink ---------- */
async function pdfSection() {
  const tag = '[pdf] ';
  await makePdf();
  const p = await newPage('phone', 'en');
  const bk = await importFile(p, PDF, 'harbour');
  const t0 = 1_700_000_000_000;
  await patchBook(p, bk.id, `(b) => { b.pdfHighlights = [{ id: 'ph1', page: 1, rects: [[0.1, 0.1, 0.6, 0.06]], text: 'the harbour chart', color: 'mint', note: 'see chart', noteAt: ${t0}, createdAt: ${t0} }]; b.pins = [{ id: 'pin1', page: 1, x: 0.5, y: 0.5, note: 'a pin note', color: 'amber', createdAt: ${t0} }]; b.bookmarks = [{ id: 'pbm', label: 'Page 2', locator: { bookId: b.id, page: 2, offset: 0 }, createdAt: ${t0} }]; }`);
  await openReader(p, bk.id, '.pdf-page canvas');
  await p.waitForSelector('.pdf-pin');
  // The page note.
  await p.evaluate(() => document.querySelector('.pdf-pin').click()); await p.waitForSelector('.sheet .btn.danger');
  await p.click('.sheet .btn.danger'); await snack(p);
  ok(tag + 'a page note deleted: gone, tombstoned', await until(async () => !(await bookNow(p, bk.id)).pins?.length) && (await tombstoned(p, 'pin1')));
  await snack(p, true);
  let pin; ok(tag + 'Undo: the page note back where it was, a new id', await until(async () => { pin = (await bookNow(p, bk.id)).pins?.[0]; return !!pin; }) && pin.id !== 'pin1' && pin.note === 'a pin note' && pin.x === 0.5 && !!(await p.$('.pdf-pin')));
  await p.waitForSelector('.toast .toast-action'); await snack(p, true);
  ok(tag + 'Redo: deleted again', await until(async () => !(await bookNow(p, bk.id)).pins?.length) && await until(async () => !(await p.$('.pdf-pin'))));
  // The highlight (from its sheet).
  const pg = await (await p.$('.pdf-page[data-page="1"] .pdf-sheet, .pdf-page[data-page="1"]')).boundingBox();
  await p.evaluate(() => document.querySelector('.reader-view')?.classList.remove('immersive'));
  await p.mouse.click(pg.x + pg.width * 0.3, pg.y + pg.height * 0.13); await p.waitForSelector('.sheet .btn.danger', { timeout: 5000 }).catch(() => {});
  if (await p.$('.sheet .btn.danger')) {
    await p.click('.sheet .btn.danger'); await snack(p);
    ok(tag + 'a PDF highlight removed: gone, tombstoned', await until(async () => !(await bookNow(p, bk.id)).pdfHighlights?.length) && (await tombstoned(p, 'ph1')));
    await snack(p, true);
    let h1; ok(tag + 'Undo: back with its note and rectangles', await until(async () => { h1 = (await bookNow(p, bk.id)).pdfHighlights?.[0]; return !!h1; }) && h1.note === 'see chart' && h1.rects[0][2] === 0.6 && await until(() => p.$('.pdf-hl-layer .pdf-hl').then(Boolean)));
    await p.waitForSelector('.toast .toast-action'); await snack(p, true);
    ok(tag + 'Redo: removed again, off the page', await until(async () => !(await bookNow(p, bk.id)).pdfHighlights?.length) && await until(async () => !(await p.$('.pdf-hl-layer .pdf-hl'))));
    await p.waitForSelector('.toast .toast-action'); await snack(p, true);
    await until(async () => (await bookNow(p, bk.id)).pdfHighlights?.length === 1);
  } else ok(tag + 'the PDF highlight\'s sheet opens on a tap', false);
  // The ink: three strokes, the eraser through two (one step), undo / redo several deep.
  await p.evaluate(() => { const b = document.querySelector('.pdf-bar button[data-icon="pen"]') ?? document.querySelector('button[data-icon="pen"]'); b?.click(); });
  await p.waitForSelector('.ink-bar:not([hidden])');
  const sheet = await (await p.$('.pdf-page[data-page="1"] .pdf-sheet')).boundingBox();
  const inkN = async () => ((await bookNow(p, bk.id)).ink ?? []).length;
  const line = async (y) => { await p.mouse.move(sheet.x + sheet.width * 0.2, sheet.y + sheet.height * y); await p.mouse.down(); for (let i = 1; i <= 6; i++) await p.mouse.move(sheet.x + sheet.width * (0.2 + i * 0.08), sheet.y + sheet.height * y); await p.mouse.up(); };
  await line(0.3); await line(0.4); await line(0.7);
  ok(tag + 'ink: three strokes kept', await until(async () => (await inkN()) === 3));
  await p.click('.ink-bar button[aria-label="Eraser"]');
  await p.mouse.move(sheet.x + sheet.width * 0.5, sheet.y + sheet.height * 0.25); await p.mouse.down(); for (let i = 1; i <= 8; i++) await p.mouse.move(sheet.x + sheet.width * 0.5, sheet.y + sheet.height * (0.25 + i * 0.025)); await p.mouse.up();
  ok(tag + 'the eraser swept through two', await until(async () => (await inkN()) === 1));
  await p.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove()));
  await p.screenshot({ path: path.join(OUT, 'undo-ink-phone.png') });
  const u = '.ink-bar button[aria-label="Undo"]', r = '.ink-bar button[aria-label="Redo"]';
  await p.click(u);
  ok(tag + 'Undo: the sweep undone at once (both strokes back)', await until(async () => (await inkN()) === 3));
  await p.click(u);
  ok(tag + 'Undo again: the last stroke drawn taken back', await until(async () => (await inkN()) === 2));
  await p.click(r);
  ok(tag + 'Redo: the stroke again', await until(async () => (await inkN()) === 3));
  await p.click(r);
  ok(tag + 'Redo again: the sweep again', await until(async () => (await inkN()) === 1) && await until(() => p.$$eval('.pdf-page[data-page="1"] svg.pdf-ink path', (x) => x.length === 1)));
  const tomb = (await meta(p, 'sync.deleted')) ?? {};
  ok(tag + 'erased strokes tombstoned (each id that left)', Object.keys(tomb).length >= 4);
  // The book opened again: the ink's history is still there.
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
  await openReader(p, bk.id, '.pdf-page canvas');
  await p.evaluate(() => { const b = document.querySelector('.pdf-bar button[data-icon="pen"]') ?? document.querySelector('button[data-icon="pen"]'); b?.click(); });
  await p.waitForSelector('.ink-bar:not([hidden])');
  await p.click(u);
  ok(tag + 'opened again: Undo still undoes the sweep', await until(async () => (await inkN()) === 3));
  await p.context().close();
}

/* ---------- 5. sync in the middle ---------- */
async function syncSection() {
  const tag = '[sync] ';
  const esbuild = require('esbuild'); const SRC = path.resolve(__dirname, '../src');
  const entry = path.join(TMP, 'entry.ts');
  fs.writeFileSync(entry, `import * as db from ${JSON.stringify(path.join(SRC, 'db'))}; import * as sync from ${JSON.stringify(path.join(SRC, 'sync'))}; import * as items from ${JSON.stringify(path.join(SRC, 'undoitems'))};\n(window as any).T = { db, sync, items };\n`);
  const code = esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser', logLevel: 'error', loader: { '.css': 'empty' }, define: { 'import.meta.url': '"http://127.0.0.1/"' } }).outputFiles[0].text;
  let remote = null;
  const device = async (name) => {
    const ctx = await br.newContext(); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await p.exposeFunction('__remoteRead', () => remote); await p.exposeFunction('__remoteWrite', (t) => { remote = t; return true; });
    await p.goto(`${base}blank`);
    await p.evaluate((n) => { localStorage.setItem('kr.device', n); localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.visual', JSON.stringify({ syncProvider: 'folder', syncFolder: '/cloud', syncAuto: false })); window.kurokawaDesktop = { readTextFile: () => window.__remoteRead(), writeTextFile: (_p, t) => window.__remoteWrite(t) }; }, name);
    await p.addScriptTag({ content: code }); await p.waitForFunction(() => !!window.T);
    return p;
  };
  const sync = async (p) => { const r = await p.evaluate(() => T.sync.syncNow()); if (!r.ok) errors.push(`sync: ${r.error}`); };
  const hls = (p) => p.evaluate(async () => ((await T.db.db.getBook('s1'))?.highlights ?? []).map((h) => `${h.id}:${h.text}`).sort());
  const A = await device('devA'), B = await device('devB');
  const bk = { id: 's1', title: 'Shared', format: 'txt', fileName: 'shared.txt', size: 99, addedAt: 1, bookmarks: [], highlights: [{ id: 'sh1', text: 'a line to keep', color: 'amber', createdAt: 1000 }] };
  for (const p of [A, B]) await p.evaluate((b) => T.db.db.putBook(b), bk);
  await sync(A); await sync(B);
  // A removes it; a sync runs while the snackbar is up (both devices); then A's Undo.
  await A.evaluate(() => T.items.takeOut('s1', 'highlights', 'sh1'));
  await sync(A); await sync(B);
  ok(tag + 'removed on A, synced in the middle: gone on B too', !(await hls(B)).length);
  const again = await A.evaluate(async () => { const b = await T.db.db.getBook('s1'); return (await T.items.putBack('s1', 'highlights', { id: 'sh1', text: 'a line to keep', color: 'amber', createdAt: 1000 })).id; });
  for (let i = 0; i < 2; i++) { await sync(A); await sync(B); }
  const a1 = await hls(A), b1 = await hls(B);
  ok(tag + 'Undo on A after that sync: back on both devices, under its new id; the old id on neither', JSON.stringify(a1) === JSON.stringify([`${again}:a line to keep`]) && JSON.stringify(b1) === JSON.stringify(a1), { a1, b1 });
  // Redo after a sync: gone on both.
  await A.evaluate((id) => T.items.takeOut('s1', 'highlights', id), again);
  for (let i = 0; i < 2; i++) { await sync(B); await sync(A); }
  ok(tag + 'Redo: gone on both', !(await hls(A)).length && !(await hls(B)).length);
  // Undo before any sync (inside the window): back on both, once.
  const third = await A.evaluate(() => T.items.putBack('s1', 'highlights', { id: 'x', text: 'a line to keep', color: 'amber', createdAt: 1000 }).then((r) => r.id));
  for (let i = 0; i < 2; i++) { await sync(A); await sync(B); }
  ok(tag + 'undone again: exactly one copy on each device', JSON.stringify(await hls(A)) === JSON.stringify([`${third}:a line to keep`]) && JSON.stringify(await hls(B)) === JSON.stringify(await hls(A)));
  await A.context().close(); await B.context().close();
}

/* ---------- 6. glossary, text rules ---------- */
async function listsSection() {
  const tag = '[lists] ';
  const p = await newPage('phone', 'en');
  await p.evaluate(() => {
    localStorage.setItem('kr.glossary', JSON.stringify([{ id: 'g1', from: 'Vell', to: 'فيل', lang: 'ar', kind: 'place' }, { id: 'g2', from: 'Ora', to: 'أورا', lang: 'ar', folder: 'fo1' }]));
    localStorage.setItem('kr.glossaryFolders', JSON.stringify([{ id: 'fo1', name: 'Saga' }]));
    localStorage.setItem('kr.textRules', JSON.stringify([{ id: 'r1', find: 'Watermark', replace: '' }]));
  });
  await p.reload(); await p.waitForSelector('.library-view');
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body');
  // Text rules.
  const hasRules = await p.evaluate(() => { const b = [...document.querySelectorAll('.settings-body .card button.btn')].find((x) => /Text rules/i.test(x.textContent)); b?.click(); return !!b; });
  if (hasRules) {
    await p.waitForSelector('.sheet .rule-row');
    const rules0 = await p.evaluate(() => localStorage.getItem('kr.textRules'));
    await p.click('.sheet .rule-row .icon-btn[data-icon="trash"]'); const s = await snack(p);
    ok(tag + 'a text rule deleted: the snackbar with Undo', /Rule deleted/.test(s.text), s);
    await snack(p, true);
    ok(tag + '… Undo: the rule back as it was', await until(async () => JSON.stringify(JSON.parse((await p.evaluate(() => localStorage.getItem('kr.textRules'))) ?? '[]')) === JSON.stringify(JSON.parse(rules0))));
    await p.evaluate(() => [...document.querySelectorAll('.sheet')].forEach((s) => s.querySelector('.sheet-head .icon-btn')?.click()));
  } else ok(tag + 'the text rules list', false);
  // The glossary (from the AI settings).
  await p.evaluate(() => { const b = [...document.querySelectorAll('.settings-body .card button.btn')].find((x) => /Provider, key/i.test(x.textContent)); b?.click(); });
  const gl = await p.waitForSelector('.sheet button:has-text("Glossary")', { timeout: 4000 }).catch(() => null);
  if (gl) {
    await gl.click(); await p.waitForSelector('.gloss-sheet .gloss-row');
    const g0 = await p.evaluate(() => localStorage.getItem('kr.glossary'));
    await p.click('.gloss-sheet .gloss-row[data-id="g1"] .icon-btn[data-icon="trash"]'); const s = await snack(p);
    ok(tag + 'a glossary term deleted: «Term “Vell” deleted»', /Vell/.test(s.text), s);
    await snack(p, true);
    ok(tag + '… Undo: the term back', await until(async () => (await p.evaluate(() => localStorage.getItem('kr.glossary'))).includes('"g1"')) && !!(await p.waitForSelector('.gloss-sheet .gloss-row[data-id="g1"]', { timeout: 3000 }).catch(() => null)));
    await p.waitForSelector('.toast .toast-action'); await snack(p, true);
    ok(tag + '… Redo: deleted again', await until(async () => !(await p.evaluate(() => localStorage.getItem('kr.glossary'))).includes('"g1"')));
    // The folder, with its term.
    await p.evaluate(() => [...document.querySelectorAll('.gloss-places .chip')].find((c) => /Saga/.test(c.textContent)).click());
    const snap = await p.evaluate(() => [localStorage.getItem('kr.glossary'), localStorage.getItem('kr.glossaryFolders')]);
    p.once('dialog', (d) => d.accept());
    await p.evaluate(() => [...document.querySelectorAll('.gloss-folder-bar button')].find((b) => /Delete/.test(b.textContent)).click());
    await snack(p);
    ok(tag + 'a glossary folder deleted (its term with it)', !(await p.evaluate(() => localStorage.getItem('kr.glossary') ?? '')).includes('"g2"'));
    await snack(p, true);
    ok(tag + '… Undo: the folder and its term back whole', await until(async () => JSON.stringify(await p.evaluate(() => [localStorage.getItem('kr.glossary'), localStorage.getItem('kr.glossaryFolders')])) === JSON.stringify(snap)));
  } else ok(tag + 'the glossary opens from the AI settings', false);
  await p.context().close();
}

(async () => {
  await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}/`;
  br = await chromium.launch();
  if (want('flow')) { await flowSection('en', EN, 'Lanterns'); await flowSection('ar', AR, 'قناديل'); }
  if (want('keys')) await keysSection();
  if (want('options')) { await optionsSection('en'); await optionsSection('ar'); }
  if (want('pdf')) await pdfSection();
  if (want('sync')) await syncSection();
  if (want('lists')) await listsSection();
  ok('no page errors', !errors.length, errors);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  await br.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
