// node tests/readpos.cjs: the reading position (src/views/reader.ts):
//  1. books read together (a series, a merged session) open again at the book and place read last — not at the start
//     of the first book;
//  2. the place is saved at once when the app is hidden (a phone's system may end it then), and when the book is left
//     within a moment of the last scroll or page turn — in a flowing book and in a PDF;
//  3. a book closed while it is still opening leaves nothing behind: its keys (Space, +, -, 0, /, b) do not act on the
//     next screen — a flowing book and a PDF;
//  4. a larger or smaller text, or other line spacing or margins, keeps the paragraph being read at the top.
// (The books are made here: no fixtures.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-readpos-'));
const vol = (n, paras = 160, len = 6) => { const f = path.join(TMP, `volume-${n}.txt`); fs.writeFileSync(f, [`Volume ${n}`, ...Array.from({ length: paras }, (_, i) => `[V${n}-P${i + 1}] ` + `Words of the volume ${n}, paragraph ${i + 1}, to read on. `.repeat(len))].join('\n\n') + '\n'); return f; };
async function makePdf(file, pages) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) { const pg = d.addPage([400, 560]); pg.drawText(`Page ${i} of the paper.`, { x: 40, y: 500, size: 16, font }); }
  fs.writeFileSync(file, await d.save());
}

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const bookBy = async (p, re) => (await allBooks(p)).find((b) => new RegExp(re).test(b.title) || new RegExp(re).test(b.fileName ?? ''));
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(800);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 160; i++) {
    const b = await bookBy(p, re); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file);
}
const toLibrary = async (p) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); };
async function openIds(p, ids, sel = '.reader-flow .kr-content') {
  await toLibrary(p); await p.waitForTimeout(300);
  await p.evaluate((ids) => { location.hash = `#/read/${ids.join(',')}`; }, ids);
  await p.waitForSelector(sel, { timeout: 30000 }); await p.waitForTimeout(3200); // (the passes that settle the place: up to 2.5 s)
}
/** The marker of the paragraph at the top of the reading area. */
const topPara = (p) => p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const top = sc.getBoundingClientRect().top + 10; const ps = [...document.querySelectorAll('.reader-flow p')].filter((x) => x.offsetParent); const hit = ps.find((x) => x.getBoundingClientRect().bottom > top); return /\[(V\d+-P\d+)\]/.exec(hit?.textContent ?? '')?.[1] ?? (hit?.textContent ?? 'none').slice(0, 30); });
const scrollToPara = (p, marker) => p.evaluate((m) => { const sc = document.querySelector('.reader-scroll'); const el = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith(`[${m}]`)); sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 2; }, marker);
const num = (m) => Number(/P(\d+)/.exec(m ?? '')?.[1] ?? -1);

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const newPage = async (visual = {}) => {
    const ctx = await br.newContext({ viewport: { width: 800, height: 800 } });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base);
    await p.evaluate((v) => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', ...v })); }, visual);
    await p.reload(); await p.waitForSelector('.library-view'); return p;
  };
  const p = await newPage();
  const v = [];
  for (const n of [1, 2, 3]) v.push(await importFile(p, vol(n), `Volume ${n}|volume-${n}`));
  const ids = v.map((b) => b.id);

  // ---- 1. a series opened again
  for (const mode of ['continuous', 'chapters']) {
    await toLibrary(p); await p.evaluate((m) => { const s = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); s.readingMode = m; localStorage.setItem('kr.visual', JSON.stringify(s)); }, mode);
    // (Each from no place read.)
    await p.evaluate((ids) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); for (const id of ids) { const q = st.get(id); q.onsuccess = () => { const b = q.result; delete b.progress; delete b.progressAt; st.put(b); }; } tx.oncomplete = res; }; }), ids);
    await p.reload(); await p.waitForSelector('.library-view');
    await openIds(p, ids);
    // (By chapters, one book is shown at a time: the next one reached with the arrow key.)
    if (mode === 'chapters') { await p.locator('.reader-scroll').press('ArrowRight'); await p.waitForTimeout(800); }
    await scrollToPara(p, mode === 'continuous' ? 'V2-P90' : 'V2-P60'); await p.waitForTimeout(1500);
    const was = await topPara(p);
    ok(`[${mode}] read on into the second book`, /^V2-/.test(was ?? ''), was);
    await toLibrary(p); await p.waitForTimeout(800);
    await openIds(p, ids);
    const now = await topPara(p);
    ok(`[${mode}] read together: opened again in the second book, at its place`, was && now && now.startsWith('V2-') && Math.abs(num(now) - num(was)) <= 2, { was, now });
  }
  await toLibrary(p); await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); s.readingMode = 'continuous'; localStorage.setItem('kr.visual', JSON.stringify(s)); });
  await p.reload(); await p.waitForSelector('.library-view');

  // ---- 2. saved at once: hidden, or left within a moment
  {
    await openIds(p, [ids[0]]);
    await scrollToPara(p, 'V1-P40'); await p.waitForTimeout(80);
    await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForTimeout(150);
    let b = (await allBooks(p)).find((x) => x.id === ids[0]);
    ok('a flowing book hidden right after a scroll: the place saved at once', b.progress && Math.abs((b.progress.block ?? 0) - 40) <= 2, b.progress);
    await p.evaluate(() => { delete document.visibilityState; });
    await scrollToPara(p, 'V1-P70'); await p.waitForTimeout(60);
    await p.evaluate(() => { window.dispatchEvent(new Event('pagehide')); }); await p.waitForTimeout(150);
    b = (await allBooks(p)).find((x) => x.id === ids[0]);
    ok('a flowing book, the page hidden (pagehide) right after a scroll: saved at once', b.progress && Math.abs((b.progress.block ?? 0) - 70) <= 2, b.progress);
    // PDF
    const pdf = path.join(TMP, 'paper.pdf'); await makePdf(pdf, 8); const pb = await importFile(p, pdf, 'paper');
    await openIds(p, [pb.id], '.pdf-page');
    await p.evaluate(() => window.__krPdfViewer.goTo(5)); await p.waitForTimeout(100);
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(150);
    let pp = (await allBooks(p)).find((x) => x.id === pb.id).progress;
    ok('a PDF left right after a page turn: the page saved as it is left', pp?.page === 5, pp);
    await openIds(p, [pb.id], '.pdf-page');
    const cur = await p.evaluate(() => window.__krPdfViewer.current);
    ok('the PDF opens again at that page', cur === 5, cur);
    // within the page: no page turn, only a scroll
    await p.evaluate(() => { const v = window.__krPdfViewer; v.goTo(3); }); await p.waitForTimeout(1200);
    await p.evaluate(() => { const v = window.__krPdfViewer; v.scroll.scrollTop += 120; }); await p.waitForTimeout(100);
    const off = await p.evaluate(() => window.__krPdfViewer.currentOffset());
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(150);
    pp = (await allBooks(p)).find((x) => x.id === pb.id).progress;
    ok('a PDF left right after a scroll within the page: the place within the page saved', pp?.page === 3 && Math.abs((pp.offset ?? 0) - off) < 0.02, { pp, off });
    // a PDF closed while it opens does not overwrite its place with the first page
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, pb.id); await p.waitForSelector('.reader-view'); await p.waitForTimeout(30);
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(1500);
    pp = (await allBooks(p)).find((x) => x.id === pb.id).progress;
    ok('a PDF closed while opening keeps its place', pp?.page === 3, pp);
  }

  // ---- 3. closed while opening: no keys left behind
  {
    const big = path.join(TMP, 'big-book.txt'); fs.writeFileSync(big, Array.from({ length: 30000 }, (_, i) => `Paragraph ${i + 1} of a long book that takes a while to lay out.`).join('\n\n'));
    const bb = await importFile(p, big, 'big-book|Paragraph 1');
    const pdf2 = path.join(TMP, 'slow.pdf'); await makePdf(pdf2, 120); const pb2 = await importFile(p, pdf2, 'slow');
    for (const [what, id] of [['a flowing book', bb.id], ['a PDF', pb2.id]]) {
      await toLibrary(p);
      const size0 = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') ?? '{}').fontSize ?? 19);
      // (Left the moment the book starts to open: its spinner on the page.)
      const left = await p.evaluate((id) => new Promise((res) => { const obs = new MutationObserver(() => { if (document.querySelector('.reader-view #kr-loading')) { obs.disconnect(); location.hash = '#/'; res(true); } }); obs.observe(document.body, { childList: true, subtree: true }); location.hash = `#/read/${id}`; setTimeout(() => res(false), 10000); }), id);
      ok(`${what}: left while it was opening`, left);
      await p.waitForSelector('.library-view'); await p.waitForTimeout(6000);
      const bm0 = ((await allBooks(p)).find((x) => x.id === id).bookmarks ?? []).length;
      await p.locator('body').press('+'); await p.locator('body').press('b'); await p.waitForTimeout(500);
      const size1 = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') ?? '{}').fontSize ?? 19);
      const bm1 = ((await allBooks(p)).find((x) => x.id === id).bookmarks ?? []).length;
      ok(`${what} closed while opening: its keys do nothing on the library (+ and b)`, size0 === size1 && bm0 === bm1, { size0, size1, bm0, bm1 });
      const rest = await p.evaluate(() => document.querySelectorAll('.reader-view, .pdf-bar, .read-footer').length);
      ok(`${what} closed while opening: nothing of it on the page`, rest === 0, rest);
    }
  }

  // ---- 4. text size, line spacing and margins keep the place
  {
    await openIds(p, [ids[2]]);
    await scrollToPara(p, 'V3-P100'); await p.waitForTimeout(800);
    const was = await topPara(p);
    for (let i = 0; i < 4; i++) { await p.locator('.reader-scroll').press('+'); await p.waitForTimeout(150); }
    await p.waitForTimeout(600);
    let now = await topPara(p);
    ok('a larger text: the same paragraph at the top', now === was, { was, now });
    for (let i = 0; i < 6; i++) { await p.locator('.reader-scroll').press('-'); await p.waitForTimeout(150); }
    await p.waitForTimeout(600); now = await topPara(p);
    ok('a smaller text: the same paragraph at the top', now === was, { was, now });
    // line spacing and margins, from the options
    await p.evaluate(() => { [...document.querySelectorAll('.float-toolbar button')].find((b) => /Visual|Appearance|Display|Text/i.test(b.getAttribute('aria-label') ?? ''))?.click(); });
    await p.waitForSelector('.panel.open'); await p.waitForTimeout(300);
    const setRange = (label) => p.evaluate((label) => { const inp = document.querySelector(`.panel input[type=range][aria-label="${label}"]`); if (!inp) return false; inp.value = String(Number(inp.max) * 0.8 + Number(inp.min) * 0.2); inp.dispatchEvent(new Event('input', { bubbles: true })); return true; }, label);
    ok('a line spacing slider in the options', await setRange('Line height'));
    await p.waitForTimeout(700); now = await topPara(p);
    ok('wider line spacing: the same paragraph at the top', now === was, { was, now });
    ok('a margins slider in the options', await setRange('Margins'));
    await p.waitForTimeout(700); now = await topPara(p);
    ok('wider margins: the same paragraph at the top', now === was, { was, now });
  }
  await p.context().close();

  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed'); await br.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
