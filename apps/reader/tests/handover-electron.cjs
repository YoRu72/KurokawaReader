// CI (tauri-check-reader.yml, «Hand-over»): the REAL Electron Reader (apps/reader/desktop, run as `electron .`, its own
// profile in its own data folder) filled with a library — an EPUB, a PDF, a long text read to its 120th paragraph, a
// book only linked from a folder, highlights, notes, bookmarks, a PDF's pins and ink, per-book settings, folders,
// tags, translations, a font, a custom icon set through the shell, sign-ins —, then its hand-over made exactly as the
// bridge build makes it before installing the Rust build (window.__KR_HANDOVER__.make → desktop/handover.cjs). The
// profile's snapshot is written to <out> for the Tauri build's check (desktop-tauri/handovercheck.js, KRH_EXPECT).
//   node tests/handover-electron.cjs <expected.json> [work folder]
// Needs: desktop/node_modules (electron), desktop/dist (node desktop/prepare.cjs), and playwright-core (or playwright).
const fs = require('fs'); const path = require('path'); const os = require('os');
let pw; try { pw = require('playwright-core'); } catch { pw = require('playwright'); }
const ROOT = path.resolve(__dirname, '..'); const DESK = path.join(ROOT, 'desktop'); const FIX = path.join(__dirname, 'fixtures');
// (The books it imports: the copies in the repository — tests/fixtures/ is git-ignored, a local folder that CI never
// has; a local copy there is used when present.)
const pickFile = (...c) => c.find((f) => fs.existsSync(f)) || c[c.length - 1];
const EPUB_FILE = pickFile(path.join(FIX, 'alice-in-wonderland.epub'), path.join(__dirname, '..', 'public', 'samples', 'alice-in-wonderland.epub'));
const PDF_FILE = pickFile(path.join(FIX, 'sample.pdf'), path.join(__dirname, 'pdfsearch', 'sample.pdf'));
const [outFile, workArg] = process.argv.slice(2);
if (!outFile) { console.error('usage: node tests/handover-electron.cjs <expected.json> [work folder]'); process.exit(2); }
const WORK = workArg || fs.mkdtempSync(path.join(os.tmpdir(), 'kr-handover-e-'));
fs.mkdirSync(WORK, { recursive: true });
const ICON = 'data:image/png;base64,' + fs.readFileSync(path.join(DESK, 'icon.png')).toString('base64');
const log = (...a) => console.log('[handover-electron]', ...a);

async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 240; i++) {
    const b = await p.evaluate((re) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.map((x) => ({ id: x.id, title: x.title, fileName: x.fileName })).find((x) => new RegExp(re).test(x.title) || new RegExp(re).test(x.fileName || ''))); }; }), re);
    if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file);
}

(async () => {
  const exe = require(path.join(DESK, 'node_modules', 'electron'));
  const args = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), DESK];
  log('electron', exe, args.join(' '));
  const app = await pw._electron.launch({ executablePath: exe, args, cwd: DESK, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, timeout: 120000 });
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  log('userData', userData);
  const p = await app.firstWindow(); p.setDefaultTimeout(60000);
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.waitForSelector('.library-view');
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); localStorage.setItem('kr.visual', JSON.stringify({ ...v, readingMode: 'continuous', fontSize: 23, theme: 'sepia' })); });
  await p.reload(); await p.waitForSelector('.library-view');
  if (!(await p.evaluate(() => !!window.kurokawaHandover && !!window.__KR_HANDOVER__))) throw new Error('this Electron build has no hand-over (preload.cjs kurokawaHandover, main.ts __KR_HANDOVER__)');

  const txt = path.join(WORK, 'Long Text.txt');
  fs.writeFileSync(txt, ['Long Text', ...Array.from({ length: 260 }, (_, i) => `[P${i + 1}] ` + `Words of paragraph ${i + 1}, a line to read on and on. `.repeat(6))].join('\n\n') + '\n');
  const epub = await importFile(p, EPUB_FILE, 'Alice');
  const pdf = await importFile(p, PDF_FILE, 'sample');
  const tb = await importFile(p, txt, 'Long Text');
  log('imported', epub.title, '|', pdf.title, '|', tb.title);
  // The text book read to its 120th paragraph: the reader saves the place.
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, tb.id);
  await p.waitForFunction(() => [...document.querySelectorAll('.reader-flow .kr-content')].some((e) => e.offsetParent !== null), null, { timeout: 60000 }); await p.waitForTimeout(3200);
  await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const el = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith('[P120]')); sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 2; });
  await p.waitForTimeout(1500);
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(1000);

  const LINKED = path.join(WORK, 'outside', 'Linked Book.txt'); fs.mkdirSync(path.dirname(LINKED), { recursive: true }); fs.writeFileSync(LINKED, 'A book that lives in the reader\'s own folder.\n');
  await p.evaluate(async ({ epub, pdf, tb, LINKED, size }) => {
    const NOW = 1_700_000_000_000;
    const d = await new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => res(r.result); });
    await new Promise((res) => { const tx = d.transaction(['books', 'meta', 'files'], 'readwrite'); const st = tx.objectStore('books');
      const q1 = st.get(epub); q1.onsuccess = () => { const b = q1.result; b.progress = { bookId: epub, block: 14, offset: 0.3, pct: 0.12, chapter: 2, toc: 3 }; b.progressAt = NOW; b.highlights = [{ id: 'h1', text: 'Down the Rabbit-Hole', color: 'rose', note: 'a note', noteAt: NOW, createdAt: NOW }, { id: 'h2', text: 'curiouser', color: 'mint', createdAt: NOW }]; b.bookmarks = [{ id: 'bm1', label: 'Here', locator: { bookId: epub, block: 9, pct: 0.1 }, createdAt: NOW }]; b.tags = ['fav', '★']; b.tagsAt = NOW; b.folderId = 'fA'; b.rating = 5; b.ratingAt = NOW; b.review = 'مراجعة'; b.reviewAt = NOW; b.prefs = { fontSize: 21 }; st.put(b); };
      const q2 = st.get(pdf); q2.onsuccess = () => { const b = q2.result; b.progress = { bookId: pdf, page: 1, pct: 0.5 }; b.progressAt = NOW; b.pdfHighlights = [{ id: 'ph1', page: 1, rects: [[0.1, 0.1, 0.3, 0.02]], text: 'pdf words', color: 'sky', createdAt: NOW }]; b.pins = [{ id: 'pin1', page: 1, x: 0.5, y: 0.5, note: 'a pin', color: 'amber', createdAt: NOW }]; b.ink = [{ id: 'ink1', page: 1, color: '#f00', w: 0.01, pts: [0.1, 0.1, 0.2, 0.2], createdAt: NOW }]; st.put(b); };
      const q3 = st.get(tb); q3.onsuccess = () => { const b = q3.result; b.highlights = [{ id: 'h3', text: 'paragraph 5', color: 'amber', createdAt: NOW }]; st.put(b); };
      st.put({ id: 'linked1', title: 'Linked Book', format: 'txt', fileName: 'Linked Book.txt', size, addedAt: NOW, bookmarks: [], highlights: [{ id: 'hl', text: 'lives', color: 'violet', createdAt: NOW }], source: { path: LINKED }, progress: { bookId: 'linked1', block: 0, pct: 0.5 }, progressAt: NOW });
      const meta = tx.objectStore('meta');
      meta.put([{ id: 'fA', name: 'Shelf', createdAt: 1 }], 'folders'); meta.put([{ name: 'fav', createdAt: 1 }], 'tags');
      meta.put({ cards: { c1: { due: 5 } }, day: 1 }, `anki:${epub}`); meta.put({ k1: 'ترجمة' }, `tr:${epub}`);
      meta.put([{ id: 'myfont', name: 'My Font', family: 'MyFont', file: 'my.ttf' }], 'fonts');
      tx.objectStore('files').put(new File(['FONTDATA'], 'my.ttf', { type: 'font/ttf' }), 'font:myfont');
      tx.oncomplete = res; });
    d.close();
    localStorage.setItem('kr.bookVisual', JSON.stringify({ [epub]: { fontSize: 19 } }));
    localStorage.setItem('kr.dbx.access', JSON.stringify({ token: 'CI-not-a-real-token' })); localStorage.setItem('kr.anilist.token', 'CI-not-a-real-token');
    localStorage.setItem('kr.glossary', JSON.stringify([{ id: 'g1', from: 'Alice', to: 'أليس' }])); localStorage.setItem('kr.vocab', JSON.stringify([{ w: 'word', at: NOW }]));
    // (A local AI model, as wllama keeps one: the origin's private files.)
    try { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('models', { create: true }); const fh = await dir.getFileHandle('tiny.gguf', { create: true }); const w = await fh.createWritable(); await w.write(new Blob(['GGUF' + 'x'.repeat(5000)])); await w.close(); } catch (e) { console.warn('no private files here', e); }
  }, { epub: epub.id, pdf: pdf.id, tb: tb.id, LINKED, size: fs.statSync(LINKED).size });
  // The custom icon, through the shell as Settings sets it (desktop/appicon.cjs: <userData>/custom-icon.png).
  await p.evaluate(async (ICON) => { await window.kurokawaDesktop.appIcon({ set: ICON }); localStorage.setItem('app.icon', ICON); }, ICON);
  await p.reload(); await p.waitForSelector('.library-view'); await p.waitForTimeout(2000);

  // (Made again if the library changed meanwhile — a cover drawn late —: the snapshot is what was handed over.)
  let snap, made;
  for (let i = 0; i < 3; i++) {
    snap = await p.evaluate(() => window.__KR_HANDOVER__.snapshot());
    log('profile:', snap.books.length, 'books;', Object.keys(snap.files).length, 'files;', snap.meta.length, 'records;', Object.keys(snap.local).length, 'keys');
    const t0 = Date.now();
    made = await p.evaluate(() => window.__KR_HANDOVER__.make());
    log('hand-over:', JSON.stringify(made), `${Date.now() - t0} ms`);
    const after = await p.evaluate(() => window.__KR_HANDOVER__.snapshot());
    if (JSON.stringify([after.books, after.files]) === JSON.stringify([snap.books, snap.files])) break;
    log('the library changed while it was made: again'); await p.waitForTimeout(2000);
  }
  const status = await p.evaluate(() => window.kurokawaHandover.status());
  await app.close();
  const fails = [];
  if (!made.ok) fails.push('the hand-over was not made: ' + JSON.stringify(made));
  if (snap.books.length !== 4) fails.push(`4 books expected, ${snap.books.length}`);
  if (!status || status.marker.id !== made.id) fails.push('no marker after it: ' + JSON.stringify(status));
  if (!fs.existsSync(path.join(userData, 'custom-icon.png'))) fails.push('the custom icon was not set by the shell');
  const marker = status && status.marker;
  if (marker && !marker.files.some((f) => f.rel === 'shell/custom-icon.png')) fails.push('the shell\'s icon not in the hand-over');
  fs.writeFileSync(outFile, JSON.stringify({ ...snap, handover: { dir: made.dir, id: made.id, counts: made.counts, userData } }));
  log('expected written to', outFile);
  if (errors.length) log('page errors:', errors.slice(0, 5));
  if (fails.length) { console.error('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  log('ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
