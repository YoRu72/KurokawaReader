// node tests/pdf2docxedit.cjs: PDF → Word's two results, on small made-up PDFs (pdf-lib, its standard fonts) that each
// show one thing the corpus (pdf2docxcorpus.cjs) has only one example of, or none:
// 1. An open table (booktabs: three rules across, none down), three numeric columns: a Word table of 5 rows x 4
//    columns in both results, every cell's text in its cell (its words were once in no part of the document).
// 2. Paragraphs (easy to edit): a ragged-right paragraph of five lines is one paragraph without line breaks, its
//    lines at an automatic spacing; a paragraph cut by a page break (no sentence's end, the next page going on in
//    small letters) is one paragraph, the next page no page break before it; a word hyphenated at a line's end is
//    whole again ("measure-/ments"), a compound keeps its hyphen ("Jean-/Paul"; "well-/known", written so on a
//    line elsewhere); an address of three short lines stays three paragraphs. (Exact look: every line kept.)
// 3. Structure (easy to edit): a title, two headings of two sizes, a list whose bullets are small pictures with a
//    nested item, a list numbered "(a)" from (c), a table whose first row is bold: Title / Heading 1 / Heading 2 styles
//    (styles.xml, outline levels), w:numPr lists (numbering.xml: bullet / lowerLetter starting at 3, levels 0 and 1)
//    with the typed marks out of the text, the table's first row a header row.
// 4. Links (easy to edit): words under a link annotation to a URL — inside a line drawn as one piece — are a w:hyperlink
//    to it (an external relationship), the words round them unchanged; a link to the second page is a hyperlink to a
//    bookmark at that page's start.
// 5. Pictures (easy to edit): a figure (a picture of 6 x 3 cm in the text) with its caption under it is an inline
//    picture in the body, in the paragraph right before its caption, and no longer in the header part; the page's
//    drawing keeps no copy of it. (Exact look: it stays pinned with the page's drawing.)
// 6. Footnotes: a raised number in the text and its note under a short rule at the page's foot, a running foot
//    under that: (easy to edit) a Word footnote (footnotes.xml) with the note's text, a footnote reference where the
//    number stood, the note no longer in the text; (both) the note never in the footer part.
// The guard, in both results: every word of each PDF's own text layer is in the .docx (body, tables, text boxes,
// headers, footers, footnotes) — for these PDFs and for the older fixtures (tests/pdf2docx/fixtures, corpus/design.pdf).
// With soffice on the PATH every .docx is also opened by LibreOffice (--convert-to pdf must succeed: no repair).
// (KR_DIST=<dir> runs it against another build; KR_EDIT_SAVE=<dir> keeps the PDFs and .docx files.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { execSync } = require('child_process');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = require('pdf-lib');
const { readDocx, pdfTextWords, wordRecall } = require('./pdf2docx/corpus2/score.cjs');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const PORT = 5214;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-edit-')); const keep = process.env.KR_EDIT_SAVE ? path.resolve(process.env.KR_EDIT_SAVE) : null; if (keep) fs.mkdirSync(keep, { recursive: true });
const haveSoffice = (() => { try { execSync('soffice --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

// ---- the PDFs ----
async function newDoc() { const doc = await PDFDocument.create(); return { doc, f: await doc.embedFont(StandardFonts.Helvetica), fb: await doc.embedFont(StandardFonts.HelveticaBold), fi: await doc.embedFont(StandardFonts.HelveticaOblique) }; }
const save = async (doc, name) => { const f = path.join(tmp, name + '.pdf'); fs.writeFileSync(f, await doc.save()); if (keep) fs.copyFileSync(f, path.join(keep, name + '.pdf')); return f; };

async function booktabs() {
  const { doc, f, fb } = await newDoc(); const p = doc.addPage([595, 842]);
  const text = (s, x, y, size = 11, font = f) => p.drawText(s, { x, y, size, font });
  text('Results of the trial', 72, 760, 16, fb);
  text('The table below gives the three measured values for each sample taken in the spring.', 72, 730);
  const rule = (y, w) => p.drawLine({ start: { x: 150, y }, end: { x: 445, y }, thickness: w, color: rgb(0, 0, 0) });
  rule(705, 0.8); rule(686, 0.5); rule(610, 0.8);
  const right = (s, x, y, font = f) => text(s, x - font.widthOfTextAtSize(s, 11), y, 11, font);
  text('Sample', 154, 692, 11, fb); right('Mass', 320, 692, fb); right('Volume', 390, 692, fb); right('Ratio', 442, 692, fb);
  const rows = [['North bed', '12.5', '3.10', '4.03'], ['South bed', '9.75', '2.45', '3.98'], ['Old quarry', '14.0', '3.62', '3.87'], ['River mouth', '7.25', '1.90', '3.82']];
  rows.forEach((r, i) => { const y = 672 - i * 16; text(r[0], 154, y); right(r[1], 320, y); right(r[2], 390, y); right(r[3], 442, y); });
  text('All values were measured twice and the mean is given; the ratio has no unit.', 72, 585);
  return { file: await save(doc, 'booktabs'), rows: [['Sample', 'Mass', 'Volume', 'Ratio'], ...rows] };
}

// Words set as a ragged-right paragraph: each line as many words as fit in `w` points.
function wrap(words, font, size, w) { const lines = []; let cur = []; for (const x of words) { const t = [...cur, x].join(' '); if (cur.length && font.widthOfTextAtSize(t, size) > w) { lines.push(cur.join(' ')); cur = [x]; } else cur.push(x); } if (cur.length) lines.push(cur.join(' ')); return lines; }
const PROSE = 'the harbour crew walked along the quay every morning and wrote the depth of the water at each post in a small book that was kept dry in a tin box under the bench of the boat';
async function paragraphs() {
  const { doc, f, fb } = await newDoc();
  const p1 = doc.addPage([595, 842]); const p2 = doc.addPage([595, 842]);
  const put = (pg, lines, x, y, step = 14, size = 11) => { lines.forEach((t, i) => pg.drawText(t, { x, y: y - i * step, size, font: f })); return y - lines.length * step; };
  p1.drawText('A day on the water', { x: 72, y: 770, size: 16, font: fb });
  const ragged = wrap(('First ' + PROSE + ', and the book was read again at night.').split(' '), f, 11, 300);
  let y = put(p1, ragged, 72, 740) - 12;
  // hyphenated line ends
  p1.drawText('The engineers took careful measure-', { x: 72, y, size: 11, font: f }); p1.drawText('ments of the old wall, and the report of Jean-', { x: 72, y: y - 14, size: 11, font: f });
  p1.drawText('Paul was read aloud; it was a well-', { x: 72, y: y - 28, size: 11, font: f }); p1.drawText('known story, and a well-known one.', { x: 72, y: y - 42, size: 11, font: f });
  y -= 42 + 26;
  // an address: three short lines
  y = put(p1, ['Harbour Office', '12 Quay Street', 'Lanternfield'], 72, y) - 12;
  // the paragraph cut by the page break: it fills the page's last lines and goes on overleaf
  const long = wrap(('Second ' + PROSE + ' ' + PROSE + ' ' + PROSE + ' until the end of the season came.').split(' '), f, 11, 450);
  const room = 3; put(p1, long.slice(0, room), 72, 72 + (room - 1) * 14); put(p2, long.slice(room), 72, 770);
  return { file: await save(doc, 'paragraphs'), ragged, long };
}

async function structurePdf() {
  const { doc, f, fb } = await newDoc(); const p = doc.addPage([595, 842]);
  // a 6 x 6 px dark dot as a PNG (built here: one IDAT, no filter)
  const zlib = require('zlib'); const crc = (b) => { let c, k, t = []; for (let n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const b = Buffer.alloc(8 + data.length + 4); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); data.copy(b, 8); b.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length); return b; };
  const raw = Buffer.alloc(6 * (1 + 6 * 3)); for (let y = 0; y < 6; y++) { raw[y * 19] = 0; for (let x = 0; x < 6; x++) raw.fill(30, y * 19 + 1 + x * 3, y * 19 + 4 + x * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(6, 0); ihdr.writeUInt32BE(6, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const dot = await doc.embedPng(png);
  const t = (s, x, y, size = 11, font = f) => p.drawText(s, { x, y, size, font });
  t('Notes on the Spring Survey', 72, 770, 24, fb);
  t('Background', 72, 730, 17, fb);
  t('The survey was planned in the winter and carried out over four weeks in the spring of the year.', 72, 708);
  t('Equipment', 72, 680, 14, fb);
  const item = (s, x, y) => { p.drawImage(dot, { x, y: y + 2, width: 4, height: 4 }); t(s, x + 12, y); };
  item('A sounding pole', 84, 658); item('A short pole', 102, 642); item('A depth sounder', 84, 626);
  t('The steps were these, as the harbour master set them out.', 72, 600);
  t('(c) Read the gauge at the slack of the tide', 84, 580); t('(d) Write the reading in the book at once', 84, 564);
  t('Equipment', 72, 530, 14, fb);
  const rows = [['Item', 'Weight', 'Count'], ['Pole', '2.5', '4'], ['Sounder', '1.2', '2']];
  const xs = [150, 270, 360, 450], ys = [500, 482, 464, 446];
  for (const x of xs) p.drawLine({ start: { x, y: ys[0] }, end: { x, y: ys[3] }, thickness: 0.6, color: rgb(0, 0, 0) });
  for (const y of ys) p.drawLine({ start: { x: xs[0], y }, end: { x: xs[3], y }, thickness: 0.6, color: rgb(0, 0, 0) });
  rows.forEach((r, i) => r.forEach((c, k) => t(c, xs[k] + 4, ys[i] - 13, 11, i === 0 ? fb : f)));
  // a figure: 170 x 85 pt, a coloured picture with a frame, its caption under it
  const FW = 40, FH = 20; const fraw = Buffer.alloc(FH * (1 + FW * 3)); for (let y = 0; y < FH; y++) { fraw[y * (1 + FW * 3)] = 0; for (let x = 0; x < FW; x++) { const o = y * (1 + FW * 3) + 1 + x * 3; const edge = x === 0 || y === 0 || x === FW - 1 || y === FH - 1; fraw[o] = edge ? 20 : 40 + x * 4; fraw[o + 1] = edge ? 20 : 120; fraw[o + 2] = edge ? 20 : 200 - y * 5; } }
  const fih = Buffer.alloc(13); fih.writeUInt32BE(FW, 0); fih.writeUInt32BE(FH, 4); fih[8] = 8; fih[9] = 2;
  const fig = await doc.embedPng(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', fih), chunk('IDAT', zlib.deflateSync(fraw)), chunk('IEND', Buffer.alloc(0))]));
  p.drawImage(fig, { x: 212, y: 300, width: 170, height: 85 });
  t('Figure 1. The quay at low water.', 212, 285, 10);
  t('The figure shows the quay as it was seen from the boat at the start of the work.', 72, 260);
  return { file: await save(doc, 'structure') };
}

async function linksPdf() {
  const { doc, f } = await newDoc(); const p1 = doc.addPage([595, 842]); const p2 = doc.addPage([595, 842]);
  const line = 'The full tables are on the harbour web page for anyone who wants them.';
  p1.drawText(line, { x: 72, y: 760, size: 11, font: f });
  const x0 = 72 + f.widthOfTextAtSize('The full tables are on the ', 11), x1 = x0 + f.widthOfTextAtSize('harbour web page', 11);
  p1.drawText('See the second page for the list of stations.', { x: 72, y: 740, size: 11, font: f });
  const y0 = 72 + f.widthOfTextAtSize('See the ', 11), y1 = y0 + f.widthOfTextAtSize('second page', 11);
  p2.drawText('Stations: north pier, outer basin, slipway.', { x: 72, y: 760, size: 11, font: f });
  const uri = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x0, 757, x1, 770], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.org/harbour/tables') } }));
  const go = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [y0, 737, y1, 750], Border: [0, 0, 0], Dest: [p2.ref, PDFName.of('XYZ'), null, null, null] }));
  p1.node.set(PDFName.of('Annots'), doc.context.obj([uri, go]));
  return { file: await save(doc, 'links'), line };
}

async function notesPdf() {
  const { doc, f } = await newDoc(); const p = doc.addPage([595, 842]);
  const para = wrap(('The keeper read the tide gauge every hour through the night ' + PROSE + '.').split(' '), f, 11, 450);
  para.forEach((t, i) => p.drawText(t, { x: 72, y: 760 - i * 14, size: 11, font: f }));
  const y = 760 - para.length * 14 - 10; const s1 = 'The readings were copied into the log at dawn';
  p.drawText(s1, { x: 72, y, size: 11, font: f }); p.drawText('1', { x: 72 + f.widthOfTextAtSize(s1, 11) + 0.5, y: y + 4, size: 7, font: f });
  p.drawText(' and sent to the board.', { x: 72 + f.widthOfTextAtSize(s1, 11) + 4.5, y, size: 11, font: f });
  p.drawLine({ start: { x: 72, y: 96 }, end: { x: 222, y: 96 }, thickness: 0.5, color: rgb(0, 0, 0) });
  p.drawText('1', { x: 72, y: 87, size: 6, font: f }); p.drawText('The log was kept in the harbour office.', { x: 77, y: 84, size: 9, font: f });
  p.drawText('Harbour Board - Page 1', { x: 250, y: 40, size: 9, font: f });
  return { file: await save(doc, 'notes'), note: 'The log was kept in the harbour office.' };
}

// ---- converting ----
async function convert(browser, file, mode) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`); await page.evaluate((m) => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.convert', JSON.stringify({ docxResult: m })); }, mode); await page.reload(); await page.waitForSelector('.library-view');
    await page.setInputFiles('input[type=file]', [file]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(300);
    const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
    if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
    await page.waitForSelector('.convert-target'); await page.click('.convert-target:has-text("Word")');
    await page.waitForSelector('.convert-result:not([hidden]) button', { timeout: 120000 });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.convert-result button:has-text("Save")')]);
    const out = path.join(tmp, `${path.basename(file, '.pdf')}.${mode}.docx`); await dl.saveAs(out); if (keep) fs.copyFileSync(out, path.join(keep, path.basename(out)));
    return out;
  } finally { await ctx.close(); }
}
const opensInLO = (docx) => { try { execSync(`cd "${tmp}" && soffice -env:UserInstallation=file://${tmp}/lo --headless --convert-to pdf --outdir "${tmp}/lo-out" "${docx}" >/dev/null 2>&1`, { timeout: 120000 }); const pdf = path.join(tmp, 'lo-out', path.basename(docx).replace(/\.docx$/, '.pdf')); return fs.existsSync(pdf) && +(/Pages:\s+(\d+)/.exec(execSync(`pdfinfo "${pdf}"`).toString()) || [0, 0])[1] > 0; } catch { return false; } };
const cellsOf = (t) => t.rows.map((r) => r.cells.map((c) => c.text.replace(/\s+/g, ' ').trim()));

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    const bt = await booktabs(); const pa = await paragraphs(); const st = await structurePdf(); const ln = await linksPdf(); const nt = await notesPdf();
    const fixtures = [path.join(__dirname, 'pdf2docx/fixtures/fullpage.pdf'), path.join(__dirname, 'pdf2docx/fixtures/merged.pdf'), path.join(__dirname, 'pdf2docx/corpus/design.pdf')].filter((f) => fs.existsSync(f));
    for (const mode of ['edit', 'exact']) {
      const M = mode === 'edit' ? 'easy to edit' : 'exact look';
      const docs = new Map();
      for (const f of [bt.file, pa.file, st.file, ln.file, nt.file, ...fixtures]) docs.set(f, await convert(browser, f, mode));
      // 1. the open table
      {
        const D = await readDocx(fs.readFileSync(docs.get(bt.file)));
        const t = D.tables.find((x) => x.rows.length === 5);
        ok(`${M} 1. the open table is a Word table of 5 rows (${D.tables.map((x) => x.rows.length).join(',') || 'none'})`, !!t);
        if (t) { const got = cellsOf(t); ok(`${M} 1. its cells hold their text, 4 columns a row (${JSON.stringify(got[1])})`, JSON.stringify(got) === JSON.stringify(bt.rows)); }
      }
      // 2. paragraphs
      {
        const D = await readDocx(fs.readFileSync(docs.get(pa.file))); const xml = await D.zip.file('word/document.xml').async('string');
        const flat = (t) => t.replace(/\s+/g, ' ').trim(); const body = D.paras.filter((p) => !p.table && flat(p.text));
        const rag = flat(pa.ragged.join(' ')); const one = body.find((p) => flat(p.text) === rag);
        const pXml = (start) => (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).find((x) => x.includes(start));
        if (mode === 'edit') {
          ok(`${M} 2. the ragged paragraph of ${pa.ragged.length} lines is one paragraph (${body.filter((p) => rag.includes(flat(p.text))).length} found)`, !!one);
          const px = pXml('First the harbour'); ok(`${M} 2. without line breaks, at an automatic line spacing`, !!px && !/<w:br\/>/.test(px) && /w:lineRule="auto"/.test(px));
          const lg = flat(pa.long.join(' ')); ok(`${M} 2. the paragraph cut by the page break is one paragraph, in the text's flow (no frame)`, body.some((p) => flat(p.text) === lg && !p.frame));
          ok(`${M} 2. the page it runs onto has no page break before it (sections: ${(xml.match(/<w:type w:val="(\w+)"/g) || []).join(' ')})`, /<w:type w:val="continuous"\/>[\s\S]*<\/w:body>/.test(xml) && (xml.match(/<w:type w:val="nextPage"\/>/g) || []).length === 1);
          const all = body.map((p) => p.text).join('\n');
          ok(`${M} 2. "measure-/ments" is whole again`, /careful measurements of/.test(all));
          ok(`${M} 2. "Jean-/Paul" and "well-/known" keep their hyphen, no space after it`, /Jean-Paul was/.test(all) && /a well-known story/.test(all));
          for (const t of ['Harbour Office', '12 Quay Street', 'Lanternfield']) ok(`${M} 2. the address line "${t}" is a paragraph of its own`, body.some((p) => flat(p.text) === t));
        } else {
          const vis = xml.split(/<w:br\/>|<\/w:p>/).map((x) => flat(x.replace(/<[^>]+>/g, '')));
          ok(`${M} 2. every line of the ragged paragraph kept as the page breaks it`, pa.ragged.every((l) => vis.includes(flat(l))));
        }
      }
      // 3. structure
      if (mode === 'edit') {
        const D = await readDocx(fs.readFileSync(docs.get(st.file))); const flat = (t) => t.replace(/\s+/g, ' ').trim();
        const P = (t) => D.paras.find((p) => flat(p.text) === t);
        const lvl = (t) => P(t)?.heading?.level;
        ok(`${M} 3. the title is a Title, the headings Heading 1 and 2 (${lvl('Notes on the Spring Survey')}, ${lvl('Background')}, ${lvl('Equipment')})`, lvl('Notes on the Spring Survey') === 0 && lvl('Background') === 1 && lvl('Equipment') === 2);
        ok(`${M} 3. styles.xml defines them (${Object.keys(D.styles).join(' ')})`, ['Title', 'Heading1', 'Heading2'].every((k) => D.styles[k]) && D.styles.Heading1.outline === 0);
        const it = ['A sounding pole', 'A short pole', 'A depth sounder'].map(P);
        ok(`${M} 3. the picture-bullet items are a bulleted list, levels 0 1 0, no typed mark (${it.map((p) => p && p.num ? p.numKind + p.num.lvl : 'none').join(' ')})`, it.every((p) => p && p.numKind === 'bullet') && it.map((p) => p.num.lvl).join() === '0,1,0');
        const nb = ['Read the gauge at the slack of the tide', 'Write the reading in the book at once'].map(P);
        const nx = await D.zip.file('word/numbering.xml')?.async('string') || '';
        const abs = nb[0] && nb[0].num ? new RegExp(`<w:num w:numId="${nb[0].num.id}"><w:abstractNumId w:val="(\\d+)"`).exec(nx)?.[1] : null;
        const def = abs ? (new RegExp(`<w:abstractNum w:abstractNumId="${abs}">[\\s\\S]*?</w:abstractNum>`).exec(nx) || [''])[0] : '';
        ok(`${M} 3. "(c)"/"(d)" are a list numbered by letters from 3, the marks out of the text (${def.slice(0, 160)})`, nb.every((p) => p && p.num && p.numKind === 'number') && /<w:start w:val="3"\/><w:numFmt w:val="lowerLetter"\/><w:lvlText w:val="\(%1\)"\/>/.test(def));
        const tb = D.tables.find((x) => x.rows.length === 3);
        ok(`${M} 3. the table's bold first row is its header row`, !!tb && tb.rows[0].header && !tb.rows[1].header);
        ok(`${M} 3. the bullets' pictures leave the page (${D.smallDrawings} small drawings, ${D.hfPics} big in headers)`, D.smallDrawings === 0);
        const ci = D.paras.findIndex((p) => flat(p.text) === 'Figure 1. The quay at low water.');
        ok(`${M} 5. the figure is one picture in the body, in the paragraph before its caption (${D.drawings} in the body, caption at ${ci}, picture before it: ${ci > 0 && D.paras[ci - 1].pics})`, D.drawings === 1 && ci > 0 && D.paras[ci - 1].pics === 1);
        ok(`${M} 5. no big picture left in the header part (${D.hfPics})`, D.hfPics === 0);
      } else {
        const D = await readDocx(fs.readFileSync(docs.get(st.file)));
        ok(`${M} 5. the figure stays with the page's drawing in the header part (${D.hfPics} there, ${D.drawings} in the body)`, D.hfPics >= 1 && D.drawings === 0);
      }
      // 4. links
      if (mode === 'edit') {
        const D = await readDocx(fs.readFileSync(docs.get(ln.file))); const xml = await D.zip.file('word/document.xml').async('string');
        const strip = (x) => x.replace(/<[^>]+>/g, '');
        const ext = /<w:hyperlink r:id="([^"]+)"[^>]*>([\s\S]*?)<\/w:hyperlink>/.exec(xml);
        ok(`${M} 4. "harbour web page" is a hyperlink to its URL, external (${ext ? strip(ext[2]) + ' -> ' + JSON.stringify(D.rels[ext[1]]) : 'none'})`, !!ext && strip(ext[2]).trim() === 'harbour web page' && D.rels[ext[1]]?.target === 'https://example.org/harbour/tables' && D.rels[ext[1]].external);
        ok(`${M} 4. the line round it reads as before`, D.paras.some((p) => p.text.replace(/\s+/g, ' ').trim().startsWith(ln.line)));
        const int = /<w:hyperlink w:anchor="([^"]+)"[^>]*>([\s\S]*?)<\/w:hyperlink>/.exec(xml);
        const bm = int && new RegExp(`<w:bookmarkStart w:id="\\d+" w:name="${int[1]}"/>`).test(xml);
        const after = int ? strip(xml.slice(xml.indexOf('>', xml.indexOf(`w:name="${int[1]}"`)) + 1)).slice(0, 40) : '';
        ok(`${M} 4. "second page" links to a bookmark at the second page's start (${int ? strip(int[2]) + ' -> ' + int[1] + ': ' + after : 'none'})`, !!int && strip(int[2]).trim() === 'second page' && bm && /^\s*Stations:/.test(after));
      }
      // 6. footnotes
      {
        const D = await readDocx(fs.readFileSync(docs.get(nt.file))); const flat = (t) => t.replace(/\s+/g, ' ').trim();
        ok(`${M} 6. the note is in no footer (${JSON.stringify(D.hf.filter((h) => h.kind === 'footer').map((h) => h.text))})`, !D.hf.some((h) => h.kind === 'footer' && h.text.includes('harbour office')));
        if (mode === 'edit') {
          ok(`${M} 6. the note is a Word footnote (${JSON.stringify(D.footnotes)}), referenced from the text (${D.footRefs})`, D.footnotes.some((x) => flat(x) === nt.note) && D.footRefs === 1);
          ok(`${M} 6. the note is no longer in the text`, !D.paras.some((p) => flat(p.text).includes('harbour office')));
        } else ok(`${M} 6. the note stays in the page's text`, D.paras.some((p) => flat(p.text).includes(nt.note)));
      }
      // the guard: no word lost, and LibreOffice opens each result
      for (const [f, docx] of docs) {
        const w = await pdfTextWords(f); const D = await readDocx(fs.readFileSync(docx)); const r = wordRecall(w, D);
        ok(`${M}: ${path.basename(f)} keeps its text layer word for word (${r.recall === null ? '-' : r.recall.toFixed(3)} of ${w.length} words${r.miss.length ? '; missing ' + r.miss.slice(0, 10).join(' ') : ''})`, r.recall === null || r.recall >= 0.99);
        if (haveSoffice) ok(`${M}: LibreOffice opens ${path.basename(docx)}`, opensInLO(docx));
      }
    }
  } catch (e) { console.log('ERROR', e); fails++; }
  await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})();
