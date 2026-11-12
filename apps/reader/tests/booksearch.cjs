// node tests/booksearch.cjs: searching a book finds words that run across its markup (src/views/reader.ts chapterIndex /
// searchFlow) — a bold word, a link, ruby (its base, not its reading), a highlight's edge and a note's bubble; Arabic
// (right to left) across a bold word, with harakat and tatweel in the text and none in the search (the rule as it
// stands: normalizeForSearch). The hit opened is brought into view and marked over those very words. And a search does
// not join the end of one paragraph to the start of the next. (The books are made here: no fixtures.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-booksearch-'));

async function makeEpub(file, id, title, lang, chapters) {
  const JSZip = require('jszip'); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  chapters.forEach(([t, body], i) => z.file(`OEBPS/c${i + 1}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"${lang === 'ar' ? ' dir="rtl"' : ''}><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`));
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>${chapters.map(([t], i) => `<li><a href="c${i + 1}.xhtml">${t}</a></li>`).join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${lang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
const filler = (n) => Array.from({ length: n }, (_, i) => `<p>Filler paragraph ${i + 1}, words and nothing more to find in it.</p>`).join('');

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
  await p.waitForSelector('.reader-flow .kr-content', { timeout: 30000 }); await p.waitForTimeout(900);
}
/** Search the open book; the hits as listed (the words matched, and the line). */
async function search(p, q) {
  if (await p.$('.panel.open')) { await p.click('.panel.open .panel-head button'); await p.waitForTimeout(200); }
  await p.evaluate(() => { document.dispatchEvent(new CustomEvent('kr:command', { detail: 'search' })); });
  await p.waitForSelector('.panel.open input[type=search]');
  await p.fill('.panel.open input[type=search]', q);
  await p.waitForTimeout(1500);
  return p.evaluate(() => [...document.querySelectorAll('.panel.open .hit')].map((h) => ({ match: h.querySelector('.ctx mark')?.textContent ?? '', line: h.querySelector('.ctx')?.textContent ?? '' })));
}
/** Open the n-th hit: what the current mark covers (its words, without readings), and whether it is in view. */
async function openHit(p, n = 0) {
  await p.evaluate(() => { const s = document.querySelector('.reader-flow').closest('.reader-scroll') ?? document.scrollingElement; s.scrollTop = 0; document.querySelectorAll('.reader-flow, .reader-scroll, .kr-scroll').forEach((e) => { e.scrollTop = 0; }); });
  await p.evaluate((n) => document.querySelectorAll('.panel.open .hit button')[n].click(), n);
  await p.waitForTimeout(600);
  return p.evaluate(() => {
    const hl = CSS.highlights.get('kr-search-current'); const r = hl && [...hl][0]; if (!r) return null;
    const frag = r.cloneContents(); frag.querySelectorAll('rt, rp, .kr-note-badge').forEach((e) => e.remove());
    const rect = r.getBoundingClientRect();
    return { text: frag.textContent, inView: rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight, all: CSS.highlights.get('kr-search')?.size ?? 0 };
  });
}
const select = (p, inPara, words) => p.evaluate(([inPara, words]) => {
  const blk = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.includes(inPara)); if (!blk) return false;
  const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf(words); if (i >= 0) { n.parentElement.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + words.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
  return false;
}, [inPara, words]);

(async () => {
  const en = path.join(TMP, 'markup.epub');
  await makeEpub(en, 'kr-booksearch-en', 'Marked Up', 'en', [
    ['One', filler(30) + '<p>The <b>quick</b> brown <i>fox</i> jumps over the <a href="c2.xhtml">lazy</a> dog today.</p><p>A list of kanji: <ruby>漢<rt>かん</rt></ruby><ruby>字<rt>じ</rt></ruby>を読む。</p><p>The last words of one paragraph</p><p>start of the next one here.</p>'],
    ['Two', '<p>At noon the old bell rang over the square. Nobody came.</p><p>At night the big drum beat over the hill, and all came.</p>' + filler(10)],
  ]);
  const ar = path.join(TMP, 'qawl.epub');
  await makeEpub(ar, 'kr-booksearch-ar', 'القول الطيب', 'ar', [
    ['الباب الأول', filler(20).replace(/Filler paragraph (\d+), words and nothing more to find in it\./g, 'فقرة للحشو رقم $1 لا شيء فيها يبحث عنه.') + '<p>وفي المساء قَالَ <b>الشَّيْخُ</b> كَلِمَةً طيبـــة للناس، فحضر الجميع.</p>'],
  ]);

  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const br = await chromium.launch(); const errors = [];
  const newPage = async (lang) => {
    const ctx = await br.newContext({ viewport: { width: 1000, height: 800 }, locale: lang });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`http://127.0.0.1:${port}/`);
    await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous' })); localStorage.setItem('kr.searchKeep', '0'); }, lang);
    await p.reload(); await p.waitForSelector('.library-view'); return p;
  };

  // ---- English: bold, italic, a link, ruby; not across paragraphs
  {
    const p = await newPage('en'); const bk = await importFile(p, en, 'Marked'); await openReader(p, bk.id);
    let hits = await search(p, 'quick brown fox jumps over the lazy dog');
    ok('across bold, italic and a link: found once', hits.length === 1 && hits[0].match === 'quick brown fox jumps over the lazy dog', hits);
    if (hits.length) { const m = await openHit(p); ok('… opened: brought into view, the mark over those words', m && m.inView && m.text === 'quick brown fox jumps over the lazy dog', m); }
    hits = await search(p, '漢字を読む');
    ok('across ruby (the readings left out): found', hits.length === 1 && hits[0].match.replace(/[かんじ]/g, '') === '漢字を読む', hits);
    if (hits.length) { const m = await openHit(p); ok('… opened: the mark over the base letters', m && m.text === '漢字を読む', m); }
    hits = await search(p, 'paragraph start');
    ok('the end of one paragraph and the start of the next are not one phrase', hits.length === 0, hits);
    hits = await search(p, 'nothing more to find');
    ok('words within one text node: found as before (all 40)', hits.length === 40, hits.length);

    // ---- a highlight's edge, and a note's bubble
    ok('selected "old bell"', await select(p, 'At noon', 'old bell'));
    await p.waitForSelector('.sel-toolbar .sel-colors .dot', { timeout: 5000 }); await p.click('.sel-toolbar .sel-colors .dot'); await p.waitForTimeout(700);
    ok('selected "big drum"', await select(p, 'At night', 'big drum'));
    await p.waitForSelector('.sel-toolbar'); await p.click('.sel-toolbar .sel-row button:has-text("Note")'); await p.waitForSelector('.sheet textarea');
    await p.fill('.sheet textarea', 'a note'); await p.click('.sheet .btn.primary'); await p.waitForTimeout(700);
    const marks = await p.evaluate(() => ({ hl: document.querySelectorAll('.reader-flow mark.kr-hl').length, badge: document.querySelectorAll('.reader-flow .kr-note-badge').length }));
    ok('the highlight and the note are on the page', marks.hl >= 2 && marks.badge === 1, marks);
    hits = await search(p, 'the old bell rang');
    ok('across a highlight\'s edges: found', hits.length === 1 && hits[0].match === 'the old bell rang', hits);
    if (hits.length) { const m = await openHit(p); ok('… opened: the mark over those words, in view', m && m.inView && m.text === 'the old bell rang', m); }
    hits = await search(p, 'the big drum beat');
    ok('across a noted highlight (its bubble left out): found', hits.length === 1 && hits[0].match.replace(/[0-9]/g, '') === 'the big drum beat', hits);
    const stored = (await allBooks(p)).find((b) => b.id === bk.id).highlights;
    ok('the highlights kept as they were made', stored.length === 2 && stored.some((h) => h.text === 'old bell') && stored.some((h) => h.text === 'big drum' && h.note === 'a note'), stored);
    await p.context().close();
  }

  // ---- Arabic, right to left
  {
    const p = await newPage('ar'); const bk = await importFile(p, ar, 'القول'); await openReader(p, bk.id);
    ok('[ar] the book reads right to left', await p.evaluate(() => getComputedStyle([...document.querySelectorAll('.reader-flow p')].pop()).direction === 'rtl'));
    let hits = await search(p, 'قال الشيخ كلمة طيبة');
    ok('[ar] across a bold word, harakat and tatweel in the text: found', hits.length === 1 && hits[0].match === 'قَالَ الشَّيْخُ كَلِمَةً طيبـــة', hits);
    if (hits.length) { const m = await openHit(p); ok('[ar] … opened: in view, the mark over those words', m && m.inView && m.text === 'قَالَ الشَّيْخُ كَلِمَةً طيبـــة', m); }
    hits = await search(p, 'الشيخ');
    ok('[ar] one word in one node: found as before', hits.length === 1 && hits[0].match === 'الشَّيْخُ', hits);
    await p.context().close();
  }
  ok('no page errors', !errors.length, errors);
  await br.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
