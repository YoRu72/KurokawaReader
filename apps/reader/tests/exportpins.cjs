// node tests/exportpins.cjs: a PDF's page notes (pins) go into "Export highlights & notes" and "Export for Anki"
// (src/ui/exportnotes.ts notesMarkdown / notesAnkiTsv) — they were left out of both. The book is made here.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 800))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-exportpins-'));

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const patchBook = (p, id, fnSrc) => p.evaluate(([id, fnSrc]) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.get(id); q.onsuccess = () => { const b = q.result; (0, eval)(fnSrc)(b); st.put(b); tx.oncomplete = () => res(); }; }; }), [id, fnSrc]);

(async () => {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) d.addPage([400, 500]).drawText(`Page ${i} of the pinned paper.`, { x: 40, y: 420, size: 14, font });
  const file = path.join(TMP, 'pinned.pdf'); fs.writeFileSync(file, await d.save());
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 900, height: 900 }, locale: 'en', acceptDownloads: true });
  // (No system share sheet: the file is saved — a download here.)
  await ctx.addInitScript(() => { try { delete Navigator.prototype.share; delete Navigator.prototype.canShare; } catch { /* */ } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); });
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('.library-view input[type=file]', [file]);
  let bk; for (let i = 0; i < 120 && !bk; i++) { bk = (await allBooks(p)).find((b) => /pinned/i.test(b.title)); if (!bk) await p.waitForTimeout(250); }
  ok('imported', !!bk); if (!bk) process.exit(1);
  await patchBook(p, bk.id, `(b) => {
    b.pins = [{ id: 'pin-a', page: 2, x: 0.3, y: 0.4, note: 'PIN NOTE ON PAGE TWO', color: 'yellow', createdAt: 1700000000000 },
              { id: 'pin-b', page: 3, x: 0.5, y: 0.5, note: 'ملاحظة على الصفحة الثالثة', color: 'blue', createdAt: 1700000100000 }];
    b.pdfHighlights = [{ id: 'ph-a', page: 1, rects: [[0.1, 0.1, 0.5, 0.05]], text: 'Page 1 of the pinned paper.', color: 'yellow', note: 'highlight note', createdAt: 1700000050000 }];
  }`);
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id);
  await p.waitForSelector('.pdf-page', { timeout: 30000 }); await p.waitForTimeout(1000);
  const exportVia = async (label) => {
    await p.click('button[aria-label="More"]'); await p.waitForSelector('.panel.open .plain-list button');
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 10000 }), p.evaluate((label) => [...document.querySelectorAll('.panel.open .plain-list button')].find((b) => b.textContent.trim() === label).click(), label)]);
    const out = path.join(TMP, dl.suggestedFilename()); await dl.saveAs(out); return fs.readFileSync(out, 'utf8');
  };
  const md = await exportVia('Export highlights & notes');
  ok('Markdown: the PDF highlight is there (as before)', md.includes('Page 1 of the pinned paper.') && md.includes('highlight note'), md);
  ok('Markdown: both page notes, with their pages', md.includes('PIN NOTE ON PAGE TWO') && md.includes('ملاحظة على الصفحة الثالثة') && /Page 2 of 3[^\n]*PIN NOTE ON PAGE TWO/.test(md) && /Page 3 of 3[^\n]*ملاحظة/.test(md), md);
  await p.waitForTimeout(400);
  const tsv = await exportVia('Export for Anki');
  const rows = tsv.split('\n').filter((l) => l && !l.startsWith('#'));
  ok('Anki: a card for the highlight and one for each page note', rows.length === 3 && rows.some((r) => r.startsWith('PIN NOTE ON PAGE TWO\t') && /Page 2 of 3/.test(r)) && rows.some((r) => r.startsWith('ملاحظة على الصفحة الثالثة\t')), tsv);
  const stored = (await allBooks(p)).find((b) => b.id === bk.id);
  ok('the book\'s notes untouched by the export', stored.pins.length === 2 && stored.pdfHighlights.length === 1);
  ok('no page errors', !errors.length, errors);
  await br.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
