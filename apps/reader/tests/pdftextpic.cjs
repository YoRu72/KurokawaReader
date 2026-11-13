// node tests/pdftextpic.cjs: «Text as image» on a PDF, on a phone. Two ways offered, «As on the page» first: the lines
// picked cut out of the real page (drawn afresh: the picture matches the page itself there), its column only, tall
// marks above and below the line kept, «only the selected words» masking the rest of the lines, two pages stacked in
// order, the same with the margins cropped and zoomed in, a whole tall page within the pixel budget; «As a card» given
// the words as running text in reading order (a hyphen joined, a paragraph kept; Arabic with its harakat, right to
// left); the choice remembered; «Cut a part of the page» on a page with no text. Then tests/textpic.cjs (other books).
// The PDFs are made here: pdf-lib (Helvetica — pdf-lib cannot embed the app's fonts without fontkit, not installed)
// for the geometry, and Chromium's own printing for Arabic (shaped, with harakat, in the app's Noto Naskh Arabic).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { execFileSync } = require('child_process');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const BUDGET = 6000000;   // SNAP_PIXELS in src/ui/pdfsnap.ts

/* ---------- the PDFs ---------- */
const W = 400, H = 560, FS = 12, STEP = 22, TOP = 500, COLW = 160, LX = 30, RX = 220;
// (Lines set justified with word gaps of a normal page — a few points: gaps much wider, lined up from line to line,
// are read by the layout as gutters between blocks, as they would be in a real book.)
const LEFT = ['Alpha bravo charlie delta zeta', 'echo foxtrot golf hotel motel', 'india juliet kilo lima limbo lo', 'mike november oscar papa pi', 'quebec romeo sierra yew tan-', 'go uniform victor whiskey well', 'short end.', 'Amber basil cedar dune echo', 'iris jade kelp loam mire mud', 'quartz reed sage thyme tide', 'moss nettle olive pine pond ox', 'plum pear fig date lime kiwi', 'umber vine willow yarrow yew', 'ending words of page one ok'];
const R5 = ['xray yankee zulu one two hat', 'three four five six seven ten', 'eight nine ten eleven twelve', 'corn rice oat rye salt mint up', 'dill bay clay sand rock dust'];
const RIGHT = [...R5, ...R5, R5[0], R5[1], 'wind gust gale calm brisk sky', 'last right line ok done now'];
const PAGE2 = ['starting words page two now', 'second line of two here too', 'third line on page two now'];
const TALL = 2300;
// A line justified to the column's width word by word (a "full" line really reaches the edge), or as is when short.
function line(pg, font, rgb, text, x, y, color) {
  const words = text.split(' '); const ws = words.map((w) => font.widthOfTextAtSize(w, FS)); const sum = ws.reduce((a, b) => a + b, 0);
  const gap = text.length > 14 ? (COLW - sum) / (words.length - 1) : font.widthOfTextAtSize(' ', FS);
  const boxes = []; let cx = x; words.forEach((w, i) => { pg.drawText(w, { x: cx, y, size: FS, font, color: rgb(...color) }); boxes.push({ w, l: cx, r: cx + ws[i] }); cx += ws[i] + gap; });
  return boxes;
}
async function colsPdf(file) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  const geo = { left: [], right: [], p2: [] };
  // Page 1: two columns on tinted paper, the right one in blue; on line 2 marks well over and under the line's box
  // (red above, green below — as harakat over a tall letter or under a descender stand out of it).
  const p1 = d.addPage([W, H]); p1.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.97, 0.94, 0.84) });
  LEFT.forEach((tx, i) => geo.left.push({ y: H - (TOP - i * STEP), words: line(p1, font, rgb, tx, LX, TOP - i * STEP, [0, 0, 0]) }));
  RIGHT.forEach((tx, i) => geo.right.push({ y: H - (TOP - i * STEP), words: line(p1, font, rgb, tx, RX, TOP - i * STEP, [0, 0, 0.85]) }));
  const j = geo.left[2].words[1], by = TOP - 2 * STEP;
  p1.drawRectangle({ x: j.l + 4, y: by + FS * 1.05, width: 10, height: 3, color: rgb(0.9, 0, 0) });
  p1.drawRectangle({ x: j.l + 16, y: by - FS * 0.62, width: 10, height: 3, color: rgb(0, 0.7, 0) });
  geo.red = { t: H - (by + FS * 1.05 + 3), b: H - (by + FS * 1.05) }; geo.green = { t: H - (by - FS * 0.62 + 3), b: H - (by - FS * 0.62) };
  // Page 2: one column on white (so cropping its margins does something).
  const p2 = d.addPage([W, H]); PAGE2.forEach((tx, i) => geo.p2.push({ y: H - (TOP - i * STEP), words: line(p2, font, rgb, tx, LX, TOP - i * STEP, [0, 0, 0]) }));
  // Page 3: no text at all — coloured blocks.
  const p3 = d.addPage([W, H]); p3.drawRectangle({ x: 100, y: 300, width: 120, height: 80, color: rgb(0.1, 0.4, 0.9) }); p3.drawRectangle({ x: 250, y: 100, width: 60, height: 60, color: rgb(0.9, 0.5, 0.1) });
  // Page 4: a tall page of text (a whole page picked must stay within the pixel budget).
  const p4 = d.addPage([W, TALL]); for (let i = 0; i < 100; i++) line(p4, font, rgb, LEFT[i % LEFT.length].replace('-', ''), LX, TALL - 40 - i * STEP, [0, 0, 0]);
  fs.writeFileSync(file, await d.save());
  return geo;
}
const AR_HEAD = 'باب الدلالة';
const AR_PARA = 'اللَّفْظُ وَسَمَّيْنَاهُ فِي تَقْسِيمِنَا اللِّسَانَ، وقد سبق إلى ذكر هذه العلامات المناطقة حين قسموا الدلالة إلى دلالة وضعية ودلالة عقلية ودلالة طبيعية.';
async function arabicPdf(browser, file) {
  const font = fs.readFileSync(path.resolve(__dirname, '../src/assets/fonts/NotoNaskhArabic-Variable.woff2')).toString('base64');
  const p = await browser.newPage();
  await p.setContent(`<html dir="rtl"><style>@font-face{font-family:N;src:url(data:font/woff2;base64,${font})}@page{size:400px 560px;margin:0}body{margin:40px;font:20px/1.9 N}h2{font-size:24px;text-align:center;margin:0 0 10px}p{margin:0;text-align:justify}</style><h2>${AR_HEAD}</h2><p>${AR_PARA}</p></html>`);
  await p.evaluate(() => document.fonts.ready);
  fs.writeFileSync(file, await p.pdf({ width: '400px', height: '560px', printBackground: true }));
  await p.close();
}

/* ---------- helpers ---------- */
const errors = [];
async function open(b, port, file) {
  const ctx = await b.newContext({ viewport: { width: 412, height: 860 }, locale: 'en', isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [file]); await p.waitForSelector('.book-card', { timeout: 60000 });
  await p.click('.book-card'); await p.waitForSelector('.pdf-page .textLayer > span', { timeout: 30000 }); await p.waitForTimeout(1000);
  return { ctx, p };
}
// Page n's top `off` px below the top of the screen; its text layer (and the next page's, when asked) built.
async function toPage(p, n, off = 120, also, text = true) {
  await p.evaluate(([n, off]) => { const sc = document.querySelector('.pdf-scroll'); const pg = document.querySelectorAll('.pdf-page')[n - 1]; sc.scrollTop += pg.getBoundingClientRect().top - sc.getBoundingClientRect().top - off; }, [n, off]);
  for (const k of [n, also].filter(Boolean)) await p.waitForFunction(([k, text]) => { const pg = document.querySelectorAll('.pdf-page')[k - 1]; return pg?.dataset.res && (!text || pg.querySelector('.textLayer > span')); }, [k, text], { timeout: 20000 });
  await p.waitForTimeout(500);
}
// From word w1 on page n1 to word w2 on page n2 (the k-th span holding it), as a reader's selection.
const select = (p, n1, w1, n2, w2) => p.evaluate(([n1, w1, n2, w2]) => {
  // ('^' and '$': the page's first and last word.)
  const find = (n, w) => { const pg = document.querySelectorAll('.pdf-page')[n - 1]; const all = [...pg.querySelectorAll('.textLayer > span')].filter((s) => s.firstChild); if (w === '^') return [all[0].firstChild, 0, 0]; if (w === '$') { const z = all[all.length - 1].firstChild; return [z, 0, z.length]; } for (const s of all) { const i = s.textContent.indexOf(w); if (i >= 0) return [s.firstChild, i, i + w.length]; } return null; };
  const a = find(n1, w1), z = find(n2, w2); if (!a || !z) return 'missing ' + (!a ? w1 : w2);
  const r = document.createRange(); r.setStart(a[0], a[1]); r.setEnd(z[0], z[2]); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); return 'ok';
}, [n1, w1, n2, w2]);
const info = (p) => p.evaluate(() => { const c = document.querySelector('.snap-preview'); const k = document.querySelector('.snap-kind [aria-pressed="true"]'); return { kind: k?.dataset.kind ?? null, kinds: [...document.querySelectorAll('.snap-kind button')].map((b) => b.dataset.kind), w: c.width, h: c.height, cuts: c.dataset.cuts ? JSON.parse(c.dataset.cuts) : null, text: c.dataset.text ?? null, dir: c.dataset.dir ?? null }; });
// A new picture in the preview (after a change of kind or option), then what it is.
async function changed(p, before) { await p.waitForFunction((b) => { const c = document.querySelector('.snap-preview'); return c && (c.dataset.cuts ?? '') + (c.dataset.text ?? '') + c.width + 'x' + c.height !== b; }, before, { timeout: 20000 }).catch(() => undefined); await p.waitForTimeout(200); return info(p); }
const sig = (i) => (i.cuts ? JSON.stringify(i.cuts) : '') + (i.text ?? '') + i.w + 'x' + i.h;
async function snap(p, sel) {
  const s = await select(p, ...sel); if (s !== 'ok') { console.log(s); return null; }
  await p.waitForSelector('.sel-toolbar', { timeout: 5000 }); await p.waitForTimeout(300);
  await p.click('.sel-toolbar button:has-text("Text as image")'); await p.waitForSelector('.snap-preview', { timeout: 20000 }); await p.waitForTimeout(300);
  return info(p);
}
const closeSnap = async (p) => { await p.click('.sheet .sheet-head button[aria-label="Close"]').catch(() => p.keyboard.press('Escape')); await p.waitForTimeout(250); await p.evaluate(() => getSelection().removeAllRanges()); await p.waitForTimeout(250); };
const pick = async (p, sel) => { const before = sig(await info(p)); await p.click(sel); return changed(p, before); };
// Pixels of the preview within a part of page n given in page points (l, t, r, b), counted by kind.
const count = (p, cut, pw, ph, box) => p.evaluate(([cut, pw, ph, box]) => {
  const c = document.querySelector('.snap-preview'); const g = c.getContext('2d');
  const X = (x) => cut.x + ((x / pw - cut.box[0]) / cut.box[2]) * cut.w, Y = (y) => cut.y + ((y / ph - cut.box[1]) / cut.box[3]) * cut.h;
  const bx = box ?? [cut.box[0] * pw, cut.box[1] * ph, (cut.box[0] + cut.box[2]) * pw, (cut.box[1] + cut.box[3]) * ph];
  const x0 = Math.max(0, Math.floor(X(bx[0]))), y0 = Math.max(0, Math.floor(Y(bx[1]))), x1 = Math.min(c.width, Math.ceil(X(bx[2]))), y1 = Math.min(c.height, Math.ceil(Y(bx[3])));
  const r = { dark: 0, blue: 0, red: 0, green: 0, orange: 0, n: 0 }; if (x1 <= x0 || y1 <= y0) return r;
  const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  for (let i = 0; i < d.length; i += 4) { const [R, G, B] = [d[i], d[i + 1], d[i + 2]]; r.n++; if (R + G + B < 200) r.dark++; if (B > 150 && R < 110 && G < 140) r.blue++; if (R > 170 && G < 90 && B < 90) r.red++; if (G > 110 && R < 90 && B < 90) r.green++; if (R > 180 && G > 90 && G < 160 && B < 80) r.orange++; }
  return r;
}, [cut, pw, ph, box]);
// The preview's part against the same part of the page drawn whole by the viewer (both brought to one small size):
// the mean difference per channel.
const likePage = (p, cut) => p.evaluate(async (cut) => {
  const v = window.__krPdfViewer; const bmp = await createImageBitmap(await v.pageToBlob(cut.n, 1000));
  const w = Math.max(8, Math.round(cut.box[2] * 1000 / 2)), hh = Math.max(8, Math.round(cut.box[3] * bmp.height / 2));
  const a = document.createElement('canvas'); a.width = w; a.height = hh; const ga = a.getContext('2d'); ga.drawImage(bmp, cut.box[0] * bmp.width, cut.box[1] * bmp.height, cut.box[2] * bmp.width, cut.box[3] * bmp.height, 0, 0, w, hh);
  const b = document.createElement('canvas'); b.width = w; b.height = hh; const gb = b.getContext('2d'); gb.drawImage(document.querySelector('.snap-preview'), cut.x, cut.y, cut.w, cut.h, 0, 0, w, hh);
  const da = ga.getImageData(0, 0, w, hh).data, db = gb.getImageData(0, 0, w, hh).data; let s = 0; for (let i = 0; i < da.length; i += 4) s += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
  return +(s / (da.length / 4) / 3).toFixed(2);
}, cut);
const pts = (cut, pw = W, ph = H) => ({ l: +(cut.box[0] * pw).toFixed(1), t: +(cut.box[1] * ph).toFixed(1), r: +((cut.box[0] + cut.box[2]) * pw).toFixed(1), b: +((cut.box[1] + cut.box[3]) * ph).toFixed(1) });
const lineBox = (ln) => [Math.min(...ln.words.map((w) => w.l)), ln.y - FS * 0.75, Math.max(...ln.words.map((w) => w.r)), ln.y + FS * 0.22];

(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch();
  const colsF = path.join(os.tmpdir(), 'kr-pdftextpic-cols.pdf'), arF = path.join(os.tmpdir(), 'kr-pdftextpic-ar.pdf');
  const geo = await colsPdf(colsF); await arabicPdf(b, arF);

  /* ----- the two-column book ----- */
  let { ctx, p } = await open(b, port, colsF);
  await toPage(p, 1, 40);
  let i = await snap(p, [1, 'bravo', 1, 'golf']);
  console.log('lines 0–1:', JSON.stringify({ kind: i.kind, kinds: i.kinds, w: i.w, h: i.h, at: pts(i.cuts[0]) }));
  ok('both ways offered, «As on the page» first', i.kinds.join() === 'page,card' && i.kind === 'page' && !!i.cuts && i.cuts.length === 1 && i.cuts[0].n === 1);
  const c0 = pts(i.cuts[0]);
  if (process.env.OUT) await p.screenshot({ path: path.join(process.env.OUT, 'pdftextpic-page.png') });
  ok('the cut: whole lines 0–1 of the left column, up to (not into) the lines next to it and the other column', c0.l <= LX && c0.l >= LX - 12 && c0.r >= LX + COLW && c0.r < RX - 10 && c0.t <= geo.left[0].y - FS * 0.75 && c0.t >= geo.left[0].y - FS * 1.8 && c0.b >= geo.left[1].y + 2 && c0.b < geo.left[2].y - FS * 0.75, c0);
  const k0 = await count(p, i.cuts[0], W, H);
  ok('… its ink is there (the words picked and the rest of their lines), none of the other column\'s (blue)', k0.dark > 500 && k0.blue === 0, k0);
  ok('… sharp: drawn afresh 6 px to a point (at most 1800 px across), not the screen\'s picture', Math.abs(i.cuts[0].w - Math.min(1800, 6 * (c0.r - c0.l))) < 4, i.cuts[0].w);
  const d0 = await likePage(p, i.cuts[0]); console.log('difference from the page drawn whole:', d0);
  ok('… its pixels are the page\'s own at those coordinates (paper, letters, all)', d0 < 10, d0); // (5.6 here, 6.7 on the CI machine: the two are scaled by different paths; a wrong part of the page is far off)
  const paper = (await p.$eval('.snap-preview', (c) => c.dataset.paper)).split(',').map(Number);
  ok('… on the page\'s own paper (tinted)', [247, 240, 214].every((v, k) => Math.abs(v - paper[k]) <= 2), paper);
  // «As a card» on the same selection: the words in reading order as running text.
  i = await pick(p, '.snap-kind button[data-kind="card"]');
  ok('«As a card»: the words in reading order, the lines run together', i.text === 'bravo charlie delta zeta echo foxtrot golf' && i.dir === 'ltr', i.text);
  i = await pick(p, '.snap-kind button[data-kind="page"]'); await closeSnap(p);

  // Tall marks over and under a line are kept whole.
  if (process.env.OUT) await p.screenshot({ path: path.join(process.env.OUT, 'pdftextpic-card.png') });
  i = await snap(p, [1, 'india', 1, 'lima']); const cm = pts(i.cuts[0]); const km = await count(p, i.cuts[0], W, H);
  console.log('line 2 with marks:', JSON.stringify(cm), 'red', km.red, 'green', km.green, 'marks at', JSON.stringify([geo.red, geo.green]));
  ok('a line with tall marks: the marks over and under it are inside the cut, not clipped', cm.t <= geo.red.t && cm.b >= geo.green.b && km.red > 600 && km.green > 600, { cm, km });
  ok('… and the lines either side are not in it', cm.t > geo.left[1].y && cm.b < geo.left[3].y - FS * 0.75, cm);
  await closeSnap(p);

  // Only the selected words: the rest of the first and the last line masked with the paper.
  i = await snap(p, [1, 'charlie', 1, 'foxtrot']);
  const alpha = geo.left[0].words[0], hotel = geo.left[1].words[2];
  const inA = (ii) => count(p, ii.cuts[0], W, H, [alpha.l, geo.left[0].y - FS * 0.75, alpha.r, geo.left[0].y + FS * 0.22]);
  const inH = (ii) => count(p, ii.cuts[0], W, H, [hotel.l, geo.left[1].y - FS * 0.75, hotel.r, geo.left[1].y + FS * 0.22]);
  const colA = await inA(i), colH = await inH(i);
  i = await pick(p, '.snap-cut button[data-v="words"]'); const wA = await inA(i), wH = await inH(i);
  const wPicked = await count(p, i.cuts[0], W, H, [geo.left[0].words[2].l, geo.left[0].y - FS * 0.75, geo.left[0].words[2].r, geo.left[0].y + FS * 0.22]);
  console.log('«Alpha» / «golf» dark pixels — whole width:', colA.dark, colH.dark, '· only the words:', wA.dark, wH.dark, '· picked:', wPicked.dark);
  ok('«Whole width of the text column»: the words before and after the selection are in it', colA.dark > 100 && colH.dark > 100);
  ok('«Only the selected words»: they are masked with the paper, the words picked kept', wA.dark === 0 && wH.dark === 0 && wPicked.dark > 300, { wA, wH, wPicked });
  i = await pick(p, '.snap-cut button[data-v="column"]'); await closeSnap(p);

  // A selection from the bottom of page 1 (right column) into page 2: the two cuts one under the other, in order.
  await toPage(p, 1, -260, 2);
  i = await snap(p, [1, 'wind', 2, 'second']);
  console.log('two pages:', JSON.stringify(i.cuts?.map((c) => ({ n: c.n, y: Math.round(c.y), ...pts(c) }))));
  ok('across two pages: two cuts stacked in page order', i.cuts?.length === 2 && i.cuts[0].n === 1 && i.cuts[1].n === 2 && i.cuts[0].y + i.cuts[0].h <= i.cuts[1].y);
  const t1 = pts(i.cuts[0]), t2 = pts(i.cuts[1]);
  ok('… page 1: the right column\'s last two lines only; page 2: its first two lines', t1.l > LX + COLW + 10 && t1.t > geo.right[11].y && t1.t <= geo.right[12].y - FS * 0.75 && t2.t <= geo.p2[0].y - FS * 0.75 && t2.b >= geo.p2[1].y && t2.b < geo.p2[2].y - FS * 0.75, { t1, t2 });
  i = await pick(p, '.snap-kind button[data-kind="card"]');
  ok('«As a card» across the pages: in order, run on from page to page', i.text === 'wind gust gale calm brisk sky last right line ok done now starting words page two now second', i.text);
  await closeSnap(p);
  // A hyphen at a line's end joined, a paragraph's short last line kept as a break.
  await toPage(p, 1, 40);
  i = await snap(p, [1, 'quebec', 1, 'basil']);
  ok('«As a card»: «tan-/go» joined, the paragraph ending «short end.» kept', i.text === 'quebec romeo sierra yew tango uniform victor whiskey well short end.\nAmber basil' && i.kind === 'card', i.text);
  i = await pick(p, '.snap-kind button[data-kind="page"]'); await closeSnap(p);

  // The margins cropped and zoomed in: the same part of the page.
  await toPage(p, 2, 40);
  i = await snap(p, [2, 'second', 2, 'third']); const plain = pts(i.cuts[0]); await closeSnap(p);
  await p.click('button[aria-label="More"]'); await p.click('.panel.open button:has-text("Crop the margins")'); await p.waitForTimeout(2500);
  await p.evaluate(() => window.__krPdfViewer.zoom(0.8)); await p.waitForTimeout(1500);
  await toPage(p, 2, 40); await p.evaluate(() => { const sc = document.querySelector('.pdf-scroll'); sc.scrollLeft = 0; }); await p.waitForTimeout(800);
  const cropped = await p.evaluate(() => { const s = document.querySelectorAll('.pdf-page')[1].querySelector('.pdf-sheet'); return { left: parseFloat(s.style.left) || 0, scale: window.__krPdfViewer.scale ?? null }; });
  i = await snap(p, [2, 'second', 2, 'third']); const zc = i.cuts ? pts(i.cuts[0]) : null;
  console.log('page 2 lines 1–2 — whole page, 100%:', JSON.stringify(plain), '· cropped and zoomed:', JSON.stringify(zc), JSON.stringify(cropped));
  ok('margins cropped (the sheet moved in its window) and zoomed in: the same part of the page', cropped.left < -5 && zc && ['l', 't', 'r', 'b'].every((k) => Math.abs(zc[k] - plain[k]) < 1.5), { plain, zc, cropped });
  const dz = await likePage(p, i.cuts[0]);
  ok('… and the page\'s own pixels there', dz < 10, dz);
  await closeSnap(p);
  await p.click('button[aria-label="More"]'); await p.click('.panel.open button:has-text("Show the whole page")'); await p.waitForTimeout(1500);
  await p.evaluate(() => window.__krPdfViewer.fitToWidth()); await p.waitForTimeout(1200);

  // A whole tall page picked: within the pixel budget.
  await toPage(p, 4, 40);
  i = await snap(p, [4, '^', 4, '$']); const tall = i.cuts ? pts(i.cuts[0], W, TALL) : null;
  console.log('a whole tall page:', i.w, 'x', i.h, '=', i.w * i.h, 'px; cut', JSON.stringify(tall));
  ok('a whole page picked: the picture within the pixel budget, and the whole page\'s text in it', i.w * i.h <= BUDGET && i.w * i.h > BUDGET * 0.5 && tall && tall.t < 40 && tall.b >= 40 + 99 * STEP, { w: i.w, h: i.h, tall });
  await closeSnap(p);

  // «Cut a part of the page» on the page with no text: a frame dragged, a corner moved, Done.
  await toPage(p, 3, 40, undefined, false);
  const toScreen = (x, y) => p.evaluate(([x, y, W, H]) => { const s = document.querySelectorAll('.pdf-page')[2].querySelector('.pdf-sheet').getBoundingClientRect(); return [s.left + (x / W) * s.width, s.top + (y / H) * s.height]; }, [x, y, W, H]);
  await p.click('button[aria-label="More"]'); await p.click('.panel.open button:has-text("Cut a part of the page")'); await p.waitForSelector('.pdf-cutter');
  const [ax, ay] = await toScreen(80, 160), [bx, by] = await toScreen(200, 240), [cx, cy] = await toScreen(240, 280);
  await p.mouse.move(ax, ay); await p.mouse.down(); await p.mouse.move((ax + bx) / 2, (ay + by) / 2, { steps: 4 }); await p.mouse.move(bx, by, { steps: 4 }); await p.mouse.up();
  // (The corner handle dragged further out: the frame grows to it.)
  await p.mouse.move(bx, by); await p.mouse.down(); await p.mouse.move(cx, cy, { steps: 5 }); await p.mouse.up();
  await p.click('.pdf-cutter-bar button:has-text("Done")'); await p.waitForSelector('.snap-preview', { timeout: 20000 }); await p.waitForTimeout(300);
  if (process.env.OUT) await p.screenshot({ path: path.join(process.env.OUT, 'pdftextpic-rect.png') });
  i = await info(p); const rc = i.cuts ? pts(i.cuts[0]) : null; const kr = i.cuts ? await count(p, i.cuts[0], W, H) : {};
  console.log('cut by hand:', JSON.stringify(rc), JSON.stringify(kr), 'kinds', i.kinds);
  ok('the rectangle tool: the part dragged (corner moved) of the page with no text, its picture', i.cuts?.[0].n === 3 && rc && Math.abs(rc.l - 80) < 1.5 && Math.abs(rc.t - 160) < 1.5 && Math.abs(rc.r - 240) < 1.5 && Math.abs(rc.b - 280) < 1.5 && kr.blue > kr.n * 0.45 && kr.orange === 0, { rc, kr });
  ok('… the page\'s pixels there', (await likePage(p, i.cuts[0])) < 6);
  await closeSnap(p);
  await ctx.close();

  /* ----- Arabic ----- */
  ({ ctx, p } = await open(b, port, arF));
  i = await snap(p, [1, 'باب', 1, 'طبيعية']);
  if (process.env.OUT) await p.screenshot({ path: path.join(process.env.OUT, 'pdftextpic-ar.png') });
  ok('Arabic: «As on the page» first, the lines cut', i.kind === 'page' && i.cuts?.length === 1);
  const ka = await count(p, i.cuts[0], W, H);
  ok('… with the page\'s ink', ka.dark > 1000, ka);
  i = await pick(p, '.snap-kind button[data-kind="card"]');
  const want = `${AR_HEAD}\n${AR_PARA.slice(0, -1)}`;
  console.log('card text:', JSON.stringify(i.text));
  ok('Arabic «As a card»: reading order, harakat with their letters, the heading its own line, the paragraph run on; right to left', i.text === want && i.dir === 'rtl', { got: i.text, want });
  await closeSnap(p);
  i = await snap(p, [1, 'اللَّفْظُ', 1, 'المناطقة']);
  ok('the choice is remembered (the card again)', i.kind === 'card' && (await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') ?? '{}').pdfSnapKind)) === 'card');
  await closeSnap(p);
  await ctx.close();
  ok('no page errors', !errors.length, errors);
  await b.close(); server.close();

  /* ----- other books: unchanged ----- */
  let other = '';
  try { other = execFileSync(process.execPath, [path.join(__dirname, 'textpic.cjs')], { env: process.env, encoding: 'utf8', timeout: 240000 }); } catch (e) { other = String(e.stdout ?? '') + String(e.message); }
  process.stdout.write(other.split('\n').map((l) => (l ? '  textpic: ' + l : l)).join('\n'));
  ok('a book that is not a PDF: «Text as image» as before (tests/textpic.cjs)', /all passed/.test(other));
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
