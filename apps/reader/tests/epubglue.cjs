// node tests/epubglue.cjs: words that the book separates are not glued together in the reader (src/formats/epub.ts
// renderChapter's clean-up of empty wrappers). Books made with InDesign put the space between two differently styled
// runs in a span of its own — `<span style="font-size:0.8em"> </span>` —, and the clean-up took a span whose text was
// only a space for an empty wrapper and removed it: «My name’sRudeus Greyrat.» at a chapter's start.
//  1. each markup that separates two words (a space alone in a span; a no-break, thin space in a span; nested; blank
//     text between inline elements) shows the gap the browser alone shows with the book's own CSS, as one space in the
//     text, in the chapter opened first and in one made later (lazy chapters);
//  2. what must stay glued stays glued: a drop cap ("M" + "y name’s"; "T" + "he"), un<em>believ</em>able, co-<b>op</b>,
//     an Arabic word with a styled letter, Japanese; an empty span and a blank div are still taken out;
//  3. a highlight saved before (its words glued) still comes back, over the spaced words; one saved now too;
//  4. a search finds the spaced words; a selection across them copies them spaced.
// A gap made only by the publisher's CSS (a margin on a lead-in span) is reported, not tested: the reader does not show
// it unless "Use publisher styles" is on (no text space is invented).
// (The books are made here: no fixtures. Elements waited for are visible ones.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.xhtml': 'application/xhtml+xml' };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epubglue-'));
const RAW = path.join(TMP, 'raw'); fs.mkdirSync(RAW);
// (The book's own files are served under /raw/ as well: the browser alone, with the book's CSS, is the truth.)
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let f = u.startsWith('/raw/') ? path.join(RAW, u.slice(5)) : path.join(DIST, u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res);
});
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };

const CSS = 'p { margin: 0 0 1em; font-size: 20px; } .smallcaps { font-variant: small-caps; margin-right: .3em; } .after::after { content: " "; } .dropcap { font-size: 3em; font-weight: bold; }';
// [class, left word, right word, markup, the text the reader must show (null: only reported)]
const SEP = [
  ['own', 'name’s', 'Sylvan', '<span style=" font-weight: bold; font-size: 3.00em;">M</span><span style=" font-size: 1.00em;">y name’s</span><span style=" font-size: 0.80em;"> </span><span style=" font-size: 1.00em;">Sylvan Brightwood.</span>', 'My name’s Sylvan Brightwood.'],
  ['ital', 'quiet', 'evening', '<span style=" font-size: 1.00em;">A quiet</span><span style=" font-style: italic; font-size: 1.00em;"> </span><span style=" font-style: italic; font-size: 1.00em;">evening fell.</span>', 'A quiet evening fell.'],
  ['nbsp', 'Lead', 'words', '<span>Lead</span><span>&#160;</span><span>words follow.</span>', 'Lead words follow.'],
  ['thin', 'Thin', 'gap', '<span>Thin</span><span> </span><span>gap here.</span>', 'Thin gap here.'],
  ['nest', 'Nested', 'space', '<span>Nested</span><span><span style="font-style: italic"> </span></span><span>space too.</span>', 'Nested space too.'],
  ['nl', 'words', 'came', '<span class="lead-in">Opening words</span>\n    <span>came next.</span>', 'Opening words\n    came next.'],
  ['bi', 'Bold', 'italic', '<b>Bold</b> <i>italic</i> pair.', 'Bold italic pair.'],
  ['cssm', 'First', 'Second', '<span class="smallcaps">First</span>Second words.', null],
  ['cssa', 'After', 'Content', '<span class="after">After</span>Content words.', null],
];
// [class, markup, the text it must keep]
const GLUED = [
  ['dc', '<span class="dropcap">T</span>he dragon slept.', 'The dragon slept.'],
  ['em', 'It was un<em>believ</em>able.', 'It was unbelievable.'],
  ['coop', 'A co-<b>op</b> game.', 'A co-op game.'],
  ['ar', '<span lang="ar"><span style="color: red">ك</span>تاب جميل</span>', 'كتاب جميل'],
  ['ja', '<span lang="ja"><span style="font-weight: bold">日本</span>語の本</span>', '日本語の本'],
  ['empty', 'Before<span></span>after and <span style="font-size: 1em"></span>end.', 'Beforeafter and end.'],
];
const filler = (c, n) => Array.from({ length: n }, (_, i) => `<p>Filler ${c}.${i}: the wind moved over the grass and the hills were quiet for a while.</p>`).join('');
function chapterBody(c) {
  if (c === 1) return SEP.map(([k, , , m]) => `<p class="P_Prose ${k}">${m}</p>`).join('\n') + '\n<div> </div><div>&#160;</div>\n' + GLUED.map(([k, m]) => `<p class="${k}">${m}</p>`).join('\n') + filler(c, 20);
  if (c === 7) return filler(c, 10) + `<p class="P_Prose late">${SEP[0][3].replace('Sylvan Brightwood', 'Sylvan Brightwood again')}</p>` + filler(c, 10);
  return filler(c, 40);
}
async function makeEpub(file) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/style.css', CSS); fs.writeFileSync(path.join(RAW, 'style.css'), CSS);
  const items = [], spine = [], nav = [];
  for (let c = 1; c <= 8; c++) {
    const x = `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>C${c}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>\n<h1>Chapter ${c}</h1>\n${chapterBody(c)}\n</body></html>`;
    z.file(`OEBPS/c${c}.xhtml`, x); fs.writeFileSync(path.join(RAW, `c${c}.xhtml`), x);
    items.push(`<item id="c${c}" href="c${c}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${c}"/>`); nav.push(`<li><a href="c${c}.xhtml">Chapter ${c}</a></li>`);
  }
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${nav.join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-epubglue-1</dc:identifier><dc:title>Glued Words</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

/** In the page: for the paragraph of class `cls` under `root`, the text between `left` and `right` and the visible gap
 *  between the last letter of one and the first of the other (in em of the paragraph's font). */
const GAP = ([root, cls, left, right]) => {
  const p = document.querySelector(`${root} p.${cls}`); if (!p) return null;
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); const nodes = []; let t = ''; let n;
  while ((n = w.nextNode())) { nodes.push([n, t.length]); t += n.data; }
  const i = t.indexOf(left), j = t.indexOf(right, i + left.length); if (i < 0 || j < 0) return { text: t, between: null };
  const at = (k) => { for (let m = nodes.length - 1; m >= 0; m--) if (k >= nodes[m][1]) { const r = document.createRange(); r.setStart(nodes[m][0], k - nodes[m][1]); r.setEnd(nodes[m][0], k - nodes[m][1] + 1); return r.getBoundingClientRect(); } return null; };
  const a = at(i + left.length - 1), b = at(j);
  const em = parseFloat(getComputedStyle(p).fontSize) || 16;
  return { text: t, between: t.slice(i + left.length, j), gap: a && b ? +((b.left - a.right) / em).toFixed(2) : null };
};

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const patchBook = (p, id, fnSrc) => p.evaluate(([id, fnSrc]) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.get(id); q.onsuccess = () => { const b = q.result; (0, eval)(fnSrc)(b); st.put(b); tx.oncomplete = () => res(); }; }; }), [id, fnSrc]);
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view >> visible=true'); await p.waitForTimeout(600);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 200; i++) {
    const b = (await allBooks(p)).find((x) => new RegExp(re, 'i').test(x.title)); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  return null;
}
async function openReader(p, id) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view >> visible=true');
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForSelector('.reader-flow .kr-content >> visible=true', { timeout: 30000 });
  // (The whole book made: no chapter left empty for later.)
  await p.waitForFunction(() => !document.querySelector('.reader-flow .kr-shell'), null, { timeout: 30000 }); await p.waitForTimeout(900);
}
async function search(p, q) {
  if (await p.$('.panel.open')) { await p.click('.panel.open .panel-head button'); await p.waitForTimeout(200); }
  await p.evaluate(() => { document.dispatchEvent(new CustomEvent('kr:command', { detail: 'search' })); });
  await p.waitForSelector('.panel.open input[type=search] >> visible=true');
  await p.fill('.panel.open input[type=search]', q);
  await p.waitForTimeout(1500);
  return p.evaluate(() => [...document.querySelectorAll('.panel.open .hit')].map((h) => h.querySelector('.ctx')?.textContent ?? ''));
}
/** The words a highlight covers: from its first mark to its last (a highlight is marked a text node at a time). */
const marks = (p) => p.evaluate(() => { const ms = [...document.querySelectorAll('.reader-flow mark.kr-hl')]; if (!ms.length) return ''; const r = document.createRange(); r.setStartBefore(ms[0]); r.setEndAfter(ms[ms.length - 1]); return r.toString(); });

(async () => {
  const book = path.join(TMP, 'glue.epub'); await makeEpub(book);
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 1000, height: 800 }, locale: 'en' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));

  // The truth: the chapter in the browser alone, with the book's CSS.
  await p.goto(`http://127.0.0.1:${port}/raw/c1.xhtml`); await p.waitForSelector('p.own >> visible=true');
  const truth = {};
  for (const [k, l, r] of SEP) truth[k] = await p.evaluate(GAP, ['body', k, l, r]);

  await p.goto(`http://127.0.0.1:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', bookPage: 'never', bookFormat: false })); localStorage.setItem('kr.searchKeep', '0'); });
  await p.reload(); await p.waitForSelector('.library-view >> visible=true');
  const bk = await importFile(p, book, 'Glued');
  ok('the book imported', !!bk);
  if (bk) {
    // 3. a highlight saved before the fix: its words as they were shown then, glued.
    await patchBook(p, bk.id, `(b) => { b.highlights = [{ id: 'old1', text: 'name’sSylvan Brightwood again', color: 'rose', createdAt: 1000 }]; }`);
    await openReader(p, bk.id);
    // 1. each separating markup: the gap the browser shows, as one space in the text.
    const rows = [];
    for (const [k, l, r, , want] of SEP) {
      const got = await p.evaluate(GAP, ['.reader-flow', k, l, r]);
      const t = truth[k];
      rows.push(`${k}: browser alone ${JSON.stringify(t.between)} gap ${t.gap}em | reader ${JSON.stringify(got?.between)} gap ${got?.gap}em`);
      if (want === null) continue;
      ok(`${k}: the browser alone shows a gap (${t.gap}em)`, t.gap > 0.1, t);
      ok(`${k}: the reader shows the words apart, the space in the text`, got && got.text.replace(/^\s+|\s+$/g, '') === want && /^\s+$/.test(got.between) && got.gap > 0.1, got);
    }
    console.log('     ' + rows.join('\n     '));
    // (lazy) the same markup in a chapter made after the book was shown
    const late = await p.evaluate(GAP, ['.reader-flow', 'late', 'name’s', 'Sylvan']);
    ok('the same in a chapter made later (lazy): «My name’s Sylvan Brightwood again.»', late && late.text === 'My name’s Sylvan Brightwood again.' && late.gap > 0.1, late);
    // 2. what must stay glued
    for (const [k, , want] of GLUED) {
      // (Without readings the reader may add over Japanese.)
      const t = await p.evaluate((k) => { const e = document.querySelector(`.reader-flow p.${k}`)?.cloneNode(true); e?.querySelectorAll('rt, rp').forEach((x) => x.remove()); return e?.textContent ?? null; }, k);
      ok(`${k}: stays as it is: ${JSON.stringify(want)}`, t === want, t);
    }
    const dcGap = await p.evaluate(GAP, ['.reader-flow', 'own', 'M', 'y']);
    ok('the drop cap «M» + «y name’s» stays one word', dcGap && dcGap.between === '', dcGap);
    const blankDivs = await p.evaluate(() => [...document.querySelectorAll('.reader-flow .kr-chapter div')].filter((d) => !d.textContent.trim() && !d.querySelector('img, [id]')).length);
    ok('blank divs are still taken out', blankDivs === 0, blankDivs);
    // 3. the highlight saved before
    ok('a highlight saved before (glued words) comes back over the spaced words', (await marks(p)) === 'name’s Sylvan Brightwood again', await marks(p));
    // 4. search and copy
    const hits = await search(p, 'name’s Sylvan');
    ok('a search for «name’s Sylvan» finds both chapters\' lines', hits.length === 2, hits);
    if (await p.$('.panel.open')) { await p.click('.panel.open .panel-head button'); await p.waitForTimeout(200); }
    const copied = await p.evaluate(() => { const el = document.querySelector('.reader-flow p.own'); el.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const t = s.toString(); s.removeAllRanges(); return t; });
    ok('copied, the line is spaced', copied === 'My name’s Sylvan Brightwood.', copied);
    // 3b. a highlight made now across the space comes back after reopening
    await patchBook(p, bk.id, `(b) => { b.highlights = [{ id: 'new1', text: 'name’s Sylvan Brightwood.', color: 'sky', createdAt: 2000 }]; }`);
    await openReader(p, bk.id);
    ok('a highlight saved now across the space comes back', (await marks(p)) === 'name’s Sylvan Brightwood.', await marks(p));
  }
  ok('no page errors', errors.length === 0, errors);
  await br.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
