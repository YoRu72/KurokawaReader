// node tests/pdf2docxrules.cjs: PDF → Word on small made-up documents, judged on the .docx itself (word/document.xml).
// - tests/pdf2docx/fixtures/merged.pdf (LibreOffice from tests/pdf2docx/corpus/mkdocx.py, "merged.docx"): two ruled tables
//   with merged cells, left to right and right to left — a header over two columns becomes w:gridSpan, a first
//   column down two rows w:vMerge restart/continue, every word in its own cell; red and blue words keep their
//   colour; harakat coloured apart from their black letters become runs of their own colour (Word colours a mark
//   so), the letters staying black.
// - tests/pdf2docx/fixtures/fullpage.pdf (same source, "fullpage.docx"): five pages filled to their last line — one Word
//   section per PDF page, every page's text in its own section.
// - made here with pdf-lib: a page with a title, a paragraph and a ruled table of five narrow columns of short words
//   drawn as Word draws its borders (thin filled boxes), then text under it — a table, never a "designed page" of
//   loose frames (the table's cells once read as boxes scattered over the page).
// With LibreOffice installed (KR_SOFFICE=1, or soffice on the PATH and not KR_NOSOFFICE), the converted documents are
// also rendered and must keep the PDF's page count. (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { execSync } = require('child_process');
const JSZip = require('jszip'); const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-'));
const haveSoffice = (() => { if (process.env.KR_NOSOFFICE) return false; try { execSync('soffice --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

async function tablePdf() {
  const doc = await PDFDocument.create(); const page = doc.addPage([595, 842]); const font = await doc.embedFont(StandardFonts.Helvetica); const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Feet and their parts', { x: 57, y: 780, size: 16, font: bold });
  const prose = ['A foot is made of smaller units built on the signs above: the causes, the pegs and the separators. They', 'are judged by motion and rest, not by the letters themselves; their signs are the following.'];
  prose.forEach((t, i) => page.drawText(t, { x: 57, y: 750 - i * 18, size: 11, font }));
  const xs = [57, 167, 332, 417, 477, 537], ys = [715, 690, 665, 640, 615, 590, 565, 540];
  const words = [['Examples', 'Definition', 'Sign', 'Name', 'Kind'], ['hal, lam', 'moving then still', '/0', 'light', 'cause'], ['laka, bika', 'two moving', '//', 'heavy', 'cause'], ['ala, laqad', 'two moving, still', '//0', 'joined', 'peg'], ['qala, jaa', 'moving still moving', '/0/', 'split', 'peg'], ['dhahabat', 'three moving, still', '///0', 'small', 'sep.'], ['samakatun', 'four moving, still', '////0', 'large', 'sep.']];
  // Borders as Word draws them: a thin filled box per cell side.
  for (const y of ys) for (let k = 0; k + 1 < xs.length; k++) page.drawRectangle({ x: xs[k], y: y - 0.25, width: xs[k + 1] - xs[k], height: 0.5, color: rgb(0, 0, 0) });
  for (const x of xs) for (let j = 0; j + 1 < ys.length; j++) page.drawRectangle({ x: x - 0.25, y: ys[j + 1], width: 0.5, height: ys[j] - ys[j + 1], color: rgb(0, 0, 0) });
  words.forEach((row, j) => row.forEach((w, k) => { const f = j ? font : bold; const tw = f.widthOfTextAtSize(w, 10); page.drawText(w, { x: (xs[k] + xs[k + 1] - tw) / 2, y: (ys[j] + ys[j + 1]) / 2 - 3.5, size: 10, font: f }); }));
  ['The light cause is a moving letter followed by a still one; the heavy cause is two moving letters, and the', 'joined peg two moving letters and a still one.'].forEach((t, i) => page.drawText(t, { x: 57, y: 515 - i * 18, size: 11, font }));
  const f = path.join(tmp, 'p2d-table.pdf'); fs.writeFileSync(f, await doc.save()); return { file: f, words };
}

async function convert(browser, file) {
  // (A context of its own each time: a fresh library with this one book in it.)
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
  await page.goto('http://127.0.0.1:5199/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [file]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(300);
  const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
  if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
  await page.waitForSelector('.convert-target'); await page.click('.convert-target:has-text("Word")');
  await page.waitForSelector('.convert-result:not([hidden]) button', { timeout: 120000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.convert-result button:has-text("Save")')]);
  const out = path.join(tmp, path.basename(file, '.pdf') + '.docx'); await dl.saveAs(out); await ctx.close();
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  return { out, xml: await zip.file('word/document.xml').async('string') };
}

// The tables of a document: rows of cells, each with its text, span, vertical merge and its runs' colours.
const tables = (xml) => [...xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map((t) => ({ rtl: t[1].includes('<w:bidiVisual/>'), rows: [...t[1].matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)].map((r) => [...r[1].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((c) => ({
  text: [...c[1].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').trim(),
  span: +(/<w:gridSpan w:val="(\d+)"/.exec(c[1])?.[1] ?? 1),
  vm: /<w:vMerge w:val="restart"\/>/.test(c[1]) ? 'restart' : /<w:vMerge\/>|<w:vMerge w:val="continue"\/>/.test(c[1]) ? 'continue' : '',
}))) }));
const runs = (xml) => [...xml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((r) => ({ text: [...r[1].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''), color: (/<w:color w:val="([0-9A-Fa-f]{6})"/.exec(r[1])?.[1] ?? '000000').toLowerCase() }));
const reddish = (c) => { const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)); return r > 150 && g < 60 && b < 60; };
const bluish = (c) => { const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)); return b > 150 && r < 60 && g < 60; };
const sections = (xml) => (xml.match(/<w:sectPr[ >]/g) ?? []).length;
const rendered = (docx) => { execSync(`cd "${tmp}" && soffice --headless --convert-to pdf "${docx}" >/dev/null 2>&1`); return +/Pages:\s+(\d+)/.exec(execSync(`pdfinfo "${docx.replace(/\.docx$/, '.pdf')}"`).toString())[1]; };
const pdfPages = async (f) => (await PDFDocument.load(fs.readFileSync(f))).getPageCount();

(async () => {
  await new Promise((r) => server.listen(5199, r));
  const browser = await chromium.launch();
  try {
    // 1) Merged cells, left to right and right to left; coloured words and marks.
    const merged = path.join(__dirname, 'pdf2docx/fixtures/merged.pdf');
    const m = await convert(browser, merged); const ts = tables(m.xml);
    ok(`two tables (got ${ts.length})`, ts.length === 2);
    const want = [{ rtl: false, w: [['Name', 'Scores', 'Note'], ['Group A', 'alpha', 'beta', 'first'], ['', 'gamma', 'delta', 'second'], ['Group B', 'epsilon', 'zeta', 'third']] },
      { rtl: true, w: [['الاسم', 'الدرجات', 'ملاحظة'], ['الفريق الأول', 'سبب', 'وتد', 'أولى'], ['', 'فاصلة', 'خفيف', 'ثانية'], ['الفريق الثاني', 'ثقيل', 'مجموع', 'ثالثة']] }];
    ts.slice(0, 2).forEach((t, i) => {
      const w = want[i]; const tag = w.rtl ? 'right-to-left' : 'left-to-right';
      // (A right-to-left table lists its cells from the right — its first column first, as Word reads bidiVisual.)
      ok(`${tag} table: ${w.rtl ? '' : 'not '}bidiVisual`, t.rtl === w.rtl);
      ok(`${tag} table: 4 rows`, t.rows.length === 4);
      ok(`${tag} table: each word in its own cell — ${JSON.stringify(t.rows.map((r) => r.map((c) => c.text)))}`, JSON.stringify(t.rows.map((r) => r.map((c) => c.text))) === JSON.stringify(w.w));
      ok(`${tag} table: header over two columns is gridSpan 2`, t.rows[0]?.[1]?.span === 2 && t.rows[0].every((c, k) => k === 1 || c.span === 1));
      ok(`${tag} table: first column down two rows is vMerge restart/continue`, t.rows[1]?.[0]?.vm === 'restart' && t.rows[2]?.[0]?.vm === 'continue' && t.rows[0][0].vm === '' && t.rows[3][0].vm === '');
      ok(`${tag} table: other cells not merged`, t.rows.every((r, j) => r.every((c, k) => k === 0 && (j === 1 || j === 2) ? true : c.vm === '')));
    });
    const rs = runs(m.xml);
    ok('red words keep their colour', rs.some((r) => r.text.includes('red words') && reddish(r.color)));
    ok('blue words keep their colour', rs.some((r) => r.text.includes('blue words') && bluish(r.color)));
    ok('the plain text around them stays black', rs.some((r) => r.text.includes('Plain text') && r.color === '000000'));
    const markRuns = rs.filter((r) => /^[ً-ْ]+\s?$/.test(r.text));
    ok(`coloured harakat are runs of their own colour (${markRuns.length}: ${markRuns.map((r) => r.color).join(' ')})`, markRuns.length >= 6 && markRuns.every((r) => reddish(r.color)));
    ok('their letters stay black', rs.some((r) => /[كتبدرسن]/.test(r.text) && r.color === '000000') && !rs.some((r) => /[كتبدرسن]/.test(r.text) && reddish(r.color) && /^[ء-ي\s]+$/.test(r.text)));
    ok('one section for the one page', sections(m.xml) === 1);

    // 2) Pages filled to their last line.
    const full = path.join(__dirname, 'pdf2docx/fixtures/fullpage.pdf'); const n = await pdfPages(full);
    const fp = await convert(browser, full);
    ok(`a section per PDF page (${sections(fp.xml)} for ${n})`, sections(fp.xml) === n);
    const tail = fp.xml.split(/<w:sectPr[ >]/).slice(0, -1).map((s) => [...s.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((x) => x[1]).join(''));
    ok('every page has its text', tail.length === n && tail.every((s) => s.length > 200));

    // 3) A ruled table of narrow columns on a page of text: a table, not loose frames.
    const tp = await tablePdf(); const t = await convert(browser, tp.file); const tt = tables(t.xml);
    ok(`the narrow-column table is a table (${tt.length}), with no frames`, tt.length === 1 && !t.xml.includes('<w:framePr'));
    ok(`its 7 rows and 5 columns, each word in its cell — ${JSON.stringify(tt[0]?.rows.map((r) => r.map((c) => c.text)))}`, JSON.stringify(tt[0]?.rows.map((r) => r.map((c) => c.text))) === JSON.stringify(tp.words));
    const plain = (x) => [...x.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((q) => q[1]).join('');
    const above = plain(t.xml.split('<w:tbl>')[0]), below = plain(t.xml.split('</w:tbl>').pop());
    ok(`the text above and below the table stays text (${JSON.stringify(above.slice(0, 40))} … ${JSON.stringify(below.slice(-40))})`, /smaller units built/.test(above) && /signs are the following/.test(above) && /joined peg/.test(below));

    if (haveSoffice) {
      ok(`rendered: merged — 1 page (${rendered(m.out)})`, rendered(m.out) === 1);
      const fr = rendered(fp.out); ok(`rendered: full pages — ${n} pages (${fr})`, fr === n);
      const tr = rendered(t.out); ok(`rendered: table page — 1 page (${tr})`, tr === 1);
    } else console.log('(LibreOffice not found: rendered page counts not checked)');
  } catch (e) { console.log('FAIL', e); fails++; }
  await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
