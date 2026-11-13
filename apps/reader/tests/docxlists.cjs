// node tests/docxlists.cjs: a Word document's lists as Word shows them (src/formats/docx.ts, numbering.xml): a numbered
// list comes out numbered (it came out as bullets), in the list's own format — decimal from its start value, letters,
// roman, Arabic abjad (أ ب ج) and alphabetical (أ ب ت) order, Arabic-Indic ("Hindi") digits, the level's text ("(%1)",
// "%1.%2.") —, its levels nested (they came out flat), its numbering carried on across a paragraph between items and
// started again under a new item above; a numbered list inside a table cell keeps its numbers (they were lost); a
// bullet list stays bullets; a format the reader does not draw comes out in plain digits, and no item's words are lost.
// (The documents are made here: no fixtures.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-docxlists-'));

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** A paragraph: plain, or a list item of list `num` at level `lvl`; `rtl` for an Arabic paragraph. */
const para = (text, num, lvl = 0, rtl = false) => `<w:p><w:pPr>${num !== undefined ? `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${num}"/></w:numPr>` : ''}${rtl ? '<w:bidi/>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const lvl = (i, fmt, text, start = 1) => `<w:lvl w:ilvl="${i}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;
const abstract = (id, levels) => `<w:abstractNum w:abstractNumId="${id}">${levels.join('')}</w:abstractNum>`;
const num = (id, abs, override = '') => `<w:num w:numId="${id}"><w:abstractNumId w:val="${abs}"/>${override}</w:num>`;

async function makeDocx(file, title, bodyXml, numberingXml) {
  const JSZip = require('jszip'); const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
  z.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`);
  z.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`);
  z.file('word/numbering.xml', `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}>${numberingXml}</w:numbering>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 120; i++) {
    const b = (await allBooks(p)).find((x) => new RegExp(re, 'i').test(x.title)); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file);
}
async function openReader(p, id) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForSelector('.reader-flow .kr-content >> visible=true', { timeout: 30000 }); await p.waitForTimeout(700);
}
/** Every list item as the reader shows it: the marker drawn before it, its own words, how deep it is, in a table or not. */
const items = (p) => p.evaluate(() => {
  const root = [...document.querySelectorAll('.reader-flow .kr-content')].find((e) => e.offsetParent);
  return [...root.querySelectorAll('li')].filter((li) => !li.closest('.kr-footnotes')).map((li) => {
    const before = getComputedStyle(li, '::before').content;
    const list = li.parentElement;
    let marker;
    if (before && before !== 'none' && before !== 'normal') marker = before.replace(/^"|"$/g, '');
    else if (list.tagName === 'OL' && getComputedStyle(li).listStyleType !== 'none') marker = `${li.value}.`;
    else marker = list.tagName === 'UL' ? '•' : '';
    let depth = 0; for (let e = li.parentElement; e && e !== root; e = e.parentElement) if (e.tagName === 'OL' || e.tagName === 'UL') depth++;
    const own = [...li.childNodes].filter((n) => !(n.nodeType === 1 && /^(OL|UL)$/.test(n.tagName))).map((n) => n.textContent).join('').trim();
    return [marker, own, depth, !!li.closest('td')];
  });
});
const find = (all, text) => all.find((x) => x[1] === text) ?? null;

(async () => {
  const absts = [
    abstract(1, [lvl(0, 'decimal', '%1.'), lvl(1, 'lowerLetter', '%2)'), lvl(2, 'lowerRoman', '%3.')]),
    abstract(2, [lvl(0, 'decimal', '%1.', 5)]),
    abstract(3, [lvl(0, 'arabicAbjad', '%1.')]),
    abstract(4, [lvl(0, 'hindiNumbers', '%1-')]),
    abstract(5, [lvl(0, 'arabicAlpha', '(%1)')]),
    abstract(6, [lvl(0, 'upperRoman', '%1.'), lvl(1, 'decimal', '%1.%2.')]),
    abstract(7, [lvl(0, 'bullet', '•')]),
    abstract(8, [lvl(0, 'someFormatNotKnown', '%1.')]),
    abstract(9, [lvl(0, 'decimal', '%1.')]),
  ].join('');
  const nums = [num(1, 1), num(2, 2), num(3, 3), num(4, 4), num(5, 5), num(6, 6), num(7, 7), num(8, 8), num(9, 9), num(10, 1, '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride>')].join('');
  const body = [
    para('Lists in Word'),
    para('First step', 1), para('Sub a', 1, 1), para('Sub b', 1, 1), para('Deeper i', 1, 2), para('Second step', 1), para('Sub again', 1, 1),
    para('A paragraph between the items.'),
    para('Third step', 1),
    para('Fifth item', 2), para('Sixth item', 2),
    para('البند الأول', 3, 0, true), para('البند الثاني', 3, 0, true), para('البند الثالث', 3, 0, true),
    para('الخطوة الأولى', 4, 0, true), para('الخطوة الثانية', 4, 0, true),
    para('الحرف الأول', 5, 0, true), para('الحرف الثاني', 5, 0, true), para('الحرف الثالث', 5, 0, true),
    para('Part one', 6), para('Section one one', 6, 1), para('Part two', 6),
    para('A bullet', 7), para('Another bullet', 7),
    para('Unknown format one', 8), para('Unknown format two', 8),
    para('Restarted at three', 10),
    `<w:tbl><w:tr><w:tc>${para('Cell item one', 9)}${para('Cell item two', 9)}</w:tc><w:tc>${para('خلية أولى', 3, 0, true)}${para('خلية ثانية', 3, 0, true)}</w:tc></w:tr></w:tbl>`,
  ].join('');
  const file = path.join(TMP, 'lists.docx');
  await makeDocx(file, 'Word Lists', body, absts + nums);

  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 1000, height: 800 }, locale: 'en' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous' })); });
  await p.reload(); await p.waitForSelector('.library-view');
  const bk = await importFile(p, file, 'Word Lists'); await openReader(p, bk.id);
  const all = await items(p);
  const m = (t) => find(all, t)?.[0];
  const d = (t) => find(all, t)?.[2];

  ok('a numbered list is numbered 1. 2. 3. (not bullets), on across a paragraph between', m('First step') === '1.' && m('Second step') === '2.' && m('Third step') === '3.', all);
  ok('levels nested: a) b) under 1., i. under b), a) again under 2.', m('Sub a') === 'a)' && m('Sub b') === 'b)' && m('Deeper i') === 'i.' && m('Sub again') === 'a)' && d('Sub a') === d('First step') + 1 && d('Deeper i') === d('First step') + 2, all);
  ok('a list starting at 5: 5. 6.', m('Fifth item') === '5.' && m('Sixth item') === '6.', all);
  ok('Arabic abjad order: أ. ب. ج.', m('البند الأول') === 'أ.' && m('البند الثاني') === 'ب.' && m('البند الثالث') === 'ج.', all);
  ok('Arabic-Indic digits: ١- ٢-', m('الخطوة الأولى') === '١-' && m('الخطوة الثانية') === '٢-', all);
  ok('Arabic alphabetical order, with the level\'s text: (أ) (ب) (ت)', m('الحرف الأول') === '(أ)' && m('الحرف الثاني') === '(ب)' && m('الحرف الثالث') === '(ت)', all);
  ok('roman, and a multi-level "%1.%2.": I. I.1. II.', m('Part one') === 'I.' && m('Section one one') === 'I.1.' && m('Part two') === 'II.', all);
  ok('a bullet list stays bullets', m('A bullet') === '•' && m('Another bullet') === '•', all);
  ok('an unknown format: plain digits, words kept', m('Unknown format one') === '1.' && m('Unknown format two') === '2.', all);
  ok('a start override: 3.', m('Restarted at three') === '3.', all);
  ok('a numbered list in a table cell keeps its numbers', find(all, 'Cell item one')?.[3] && m('Cell item one') === '1.' && m('Cell item two') === '2.', all);
  ok('an Arabic numbered list in a table cell, carrying on its list: د. ه.', m('خلية أولى') === 'د.' && m('خلية ثانية') === 'ه.', all);
  const text = await p.evaluate(() => [...document.querySelectorAll('.reader-flow .kr-content')].find((e) => e.offsetParent).textContent);
  // (Book formatting — on by default since 0.61.2 — keeps a one-letter word with the next by a no-break space; the words are the same.)
  const textN = text.replace(/\u00a0/g, ' ');
  ok('no words lost', ['First step', 'Sub a', 'Deeper i', 'A paragraph between the items.', 'Unknown format two', 'البند الثالث', 'خلية ثانية', 'Cell item two'].filter((w) => !textN.includes(w)).length === 0, { missing: ['First step', 'Sub a', 'Deeper i', 'A paragraph between the items.', 'Unknown format two', 'البند الثالث', 'خلية ثانية', 'Cell item two'].filter((w) => !textN.includes(w)), sample: textN.slice(0, 300) });
  ok('no page errors', errors.length === 0, errors);
  await br.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
