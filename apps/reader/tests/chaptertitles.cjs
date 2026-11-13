// node tests/chaptertitles.cjs: chapter titles, the book's own layout of its lines, and hyphenation
// (src/formats/titles.ts, src/formats/epub.ts, src/styles/reader.css, src/settings.ts, src/views/reader.ts):
//  1. a title made of styled paragraphs (a «Chapter 1:» paragraph and a title paragraph, as light novels make them), a
//     heading holding <span>label</span><br/>title, one block «Chapter 3: Title», a title alone, a label alone, Arabic
//     «الفصل الأول» + title (right to left) and Japanese «第一話　…» are centred on the column, without the first-line
//     indent, never hyphenated — while the body keeps its indent and is hyphenated (hyphenation on by default, with a
//     language on the text);
//  2. a long first paragraph that merely begins with «Chapter» is body text (not centred, not marked);
//  3. the shape of a real light novel: one <p class> holding a bold 1.17em «Chapter 7:<br/>Title», empty spacer
//     paragraphs, a bold point-of-view line centred by the book's class, a 3em bold first letter, a «* * *» scene break
//     centred by class: the book's centring honoured, the point-of-view line bold and centred, its sizes at the book's
//     own scale (the title at 1.17×, the first letter bold at the text's size by default), spacers one modest gap;
//  4. a book that centres every paragraph: its long paragraphs left to the reader's alignment, a short line centred;
//  5. «Chapter titles: At the start» / «As the book says»; with hyphenation off the titles are still centred;
//  6. «Hide the word Chapter»: the label hidden and the title kept, a title that is a label alone kept; the top bar and
//     the contents show the name without its label; search still finds text of that chapter; a highlight made in the
//     chapter comes back on its words; the chapter's text and blocks are those of the build before (KR_OLD_DIST).
// Screenshots (412×915 @2) in KR_SHOTS when given. (The books are made here: no fixtures. Visible elements waited for.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const OLD = process.env.KR_OLD_DIST ? path.resolve(process.env.KR_OLD_DIST) : null;
const SHOTS = process.env.KR_SHOTS ? path.resolve(process.env.KR_SHOTS) : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const serve = (dir) => http.createServer((req, res) => { let f = path.join(dir, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dir, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-chaptertitles-'));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const EN = 'The lamplighters of the harbour town considered themselves indispensable, and their extraordinarily methodical apprentices memorised every crooked street. ';
const AR = 'وكان الليل طويلا على المدينة القديمة، والناس يقرؤون الكتب في البيوت المضاءة بالقناديل حتى يطلع الفجر. ';
const JA = '港町の灯台守たちは、毎晩同じ時刻に灯をともし、古い通りを一つ一つ見回っていた。';
const body = (n, text, cls = '') => Array.from({ length: n }, (_, i) => `<p${cls ? ` class="${cls}"` : ''}>[P${i}] ${text.repeat(3)}</p>`).join('');

/** chapters: { file, xhtml (body inner), css? (file name linked), lang? }; toc: [label, file]. */
async function makeEpub(file, { id, title, lang, chapters, toc, files = {} }) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items = [], spine = [];
  chapters.forEach((c, i) => {
    z.file(`OEBPS/${c.file}`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${c.lang ?? lang}"${(c.lang ?? lang) === 'ar' ? ' dir="rtl"' : ''}><head><title>t</title>${c.css ? `<link rel="stylesheet" type="text/css" href="${c.css}"/>` : ''}</head><body>${c.xhtml}</body></html>`);
    items.push(`<item id="c${i}" href="${c.file}" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${i}"/>`);
  });
  for (const [name, text] of Object.entries(files)) { z.file(`OEBPS/${name}`, text); items.push(`<item id="f${name.replace(/\W/g, '')}" href="${name}" media-type="text/css"/>`); }
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${toc.map(([l, h]) => `<li><a href="${h}">${l}</a></li>`).join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${lang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

const STYLE = 'p.P_star_break { text-align: center; text-indent: 0em; margin-top: .4em; } p.P_prose { text-indent: 1em; margin: .4em 0; }';
const EVERYTHING = 'p { text-align: center; }';
const ENGLISH = {
  id: 'kr-titles-en', title: 'Lantern Harbour', lang: 'en', files: { 'style.css': STYLE, 'all.css': EVERYTHING },
  chapters: [
    { file: 'c1.xhtml', xhtml: '<p class="chapter-number">Chapter 1:</p><p class="chapter-title">The Lantern Road</p>' + body(12, EN) },
    { file: 'c2.xhtml', xhtml: '<h2><span>Chapter 2:</span><br/>The Second Gate</h2>' + body(12, EN) },
    { file: 'c3.xhtml', xhtml: '<p>Chapter 3: The Quiet Mill</p>' + body(12, EN) },
    { file: 'c4.xhtml', xhtml: '<p class="ttl">Northern Lights</p>' + body(12, EN) },
    { file: 'c5.xhtml', xhtml: '<p>Chapter 5</p>' + body(12, EN) },
    { file: 'c6.xhtml', xhtml: '<p>Chapter five of my life began on a grey morning, when the harbour bells rang twice and nobody in the old town could say why they had rung at all.</p>' + body(12, EN) },
    { file: 'c7.xhtml', css: 'style.css', xhtml: '<p id="top7" class="P_star_break"><span><span style=" font-weight: bold; font-size: 1.17em;">Chapter 7:<br/>The Copper Bell</span></span></p><p class="P_star_break"><span>&#160;</span></p><p class="P_star_break"><span><span style=" font-weight: bold; font-size: 1.17em;">Mira</span></span></p><p class="P_prose">&#160;</p><p class="P_prose"><span style=" font-weight: bold; font-size: 3.00em;">T</span><span style=" font-size: 1.00em;">he lamps were lit before the boats came home.</span></p>' + body(6, EN, 'P_prose') + '<p class="P_prose">&#160;</p><p class="P_star_break"><span>* * *</span></p><p class="P_prose">&#160;</p>' + body(6, EN, 'P_prose') },
    { file: 'c8.xhtml', css: 'all.css', xhtml: '<h2>Chapter 8: Everything Centred</h2><p>A short centred note</p>' + body(8, EN) },
  ],
  toc: [['Chapter 1: The Lantern Road', 'c1.xhtml'], ['Chapter 2: The Second Gate', 'c2.xhtml'], ['Chapter 3: The Quiet Mill', 'c3.xhtml'], ['Northern Lights', 'c4.xhtml'], ['Chapter 5', 'c5.xhtml'], ['Part Six', 'c6.xhtml'], ['Chapter 7: The Copper Bell', 'c7.xhtml'], ['Chapter 8: Everything Centred', 'c8.xhtml']],
};
const ARABIC = {
  id: 'kr-titles-ar', title: 'كتاب القناديل', lang: 'ar',
  chapters: [
    { file: 'a1.xhtml', xhtml: '<p class="chapter">الفصل الأول</p><p>عودة الغريب</p>' + body(10, AR) },
    { file: 'a2.xhtml', xhtml: '<p>الفصل الثاني: ليل المدينة</p>' + body(10, AR) },
  ],
  toc: [['الفصل الأول: عودة الغريب', 'a1.xhtml'], ['الفصل الثاني: ليل المدينة', 'a2.xhtml']],
};
const JAPANESE = {
  id: 'kr-titles-ja', title: '灯台の町', lang: 'ja',
  chapters: [{ file: 'j1.xhtml', xhtml: '<p>第一話　帰り道</p>' + body(10, JA) }, { file: 'j2.xhtml', xhtml: '<p>第二話　灯の番</p>' + body(10, JA) }],
  toc: [['第一話　帰り道', 'j1.xhtml'], ['第二話　灯の番', 'j2.xhtml']],
};

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 200; i++) {
    const b = (await allBooks(p)).find((x) => new RegExp(re, 'i').test(x.title)); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  return null;
}
async function openReader(p, id) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForSelector('.reader-flow .kr-content >> visible=true', { timeout: 60000 }); await p.waitForTimeout(1500);
}
async function setVisual(p, v) {
  await p.evaluate((v) => { const cur = JSON.parse(localStorage.getItem('kr.visual') || '{}'); localStorage.setItem('kr.visual', JSON.stringify({ ...cur, ...v })); }, v);
  await p.evaluate(() => { location.hash = '#/'; }); await p.reload(); await p.waitForSelector('.library-view');
}
/** A block (the first whose text includes `needle`): where its text sits on the column, and how it is set. */
const block = (p, needle, sel = 'p, h1, h2, h3') => p.evaluate(([needle, sel]) => {
  const b = [...document.querySelectorAll(`.reader-flow .kr-content :is(${sel})`)].find((x) => x.textContent.includes(needle)); if (!b) return null;
  b.scrollIntoView({ block: 'center' });
  const r = document.createRange(); r.selectNodeContents(b); const rs = [...r.getClientRects()].filter((x) => x.width > 0.5);
  const box = b.getBoundingClientRect(); const cs = getComputedStyle(b);
  const cl = box.left + parseFloat(cs.paddingLeft), cr = box.right - parseFloat(cs.paddingRight);
  const L = rs.length ? Math.min(...rs.map((x) => x.left)) : 0, R = rs.length ? Math.max(...rs.map((x) => x.right)) : 0;
  const shown = (s) => { const n = [...b.querySelectorAll('*')].filter((e) => e.textContent.includes(s)); return n.length ? n.every((e) => e.getClientRects().length > 0) : rs.length > 0; };
  return { off: Math.round(Math.abs((L + R) / 2 - (cl + cr) / 2)), startGap: Math.round(cs.direction === 'rtl' ? cr - R : L - cl), endGap: Math.round(cs.direction === 'rtl' ? L - cl : cr - R), indent: cs.textIndent, hyphens: cs.hyphens, align: cs.textAlign, weight: Number(cs.fontWeight), size: parseFloat(cs.fontSize), height: Math.round(box.height), lines: rs.map((x) => x.top + x.height / 2).sort((a, b) => a - b).filter((c, i, a) => i === 0 || c - a[i - 1] > 10).length, mark: b.getAttribute('data-kr-title'), lang: b.closest('[lang]')?.getAttribute('lang') ?? '', dir: cs.direction, text: b.textContent, visibleText: rs.length > 0 && box.height > 1, shownLabel: shown('Chapter') };
}, [needle, sel]);
/** The size and weight of the element holding exactly `text` (an inline span). */
const inline = (p, text) => p.evaluate((text) => { const e = [...document.querySelectorAll('.reader-flow .kr-content span, .reader-flow .kr-content b')].reverse().find((x) => x.textContent.trim() === text); if (!e) return null; const cs = getComputedStyle(e); const pcs = getComputedStyle(e.closest('p')); return { ratio: parseFloat(cs.fontSize) / parseFloat(pcs.fontSize), weight: Number(cs.fontWeight) }; }, text);
const isCentred = (b) => !!b && b.off <= 6 && b.startGap > 8 && b.indent === '0px';
const shot = async (p, name, needle) => { if (!SHOTS) return; await p.evaluate((n) => { const b = [...document.querySelectorAll('.reader-flow .kr-content :is(p, h1, h2, h3)')].find((x) => x.textContent.includes(n)); b?.scrollIntoView({ block: 'start' }); const s = document.querySelector('.reader-flow').closest('.reader-scroll'); if (s) s.scrollTop -= 80; }, needle); await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, name) }); };

/** Each chapter's text and its number of blocks (as the reader counts them), to compare with the build before. */
const model = (p) => p.evaluate(() => [...document.querySelectorAll('.reader-flow section.kr-chapter')].map((s) => ({ n: s.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, figcaption, td, th, pre, div.kr-txt, img').length, text: s.textContent.replace(/\s+/g, ' ').trim() })));

async function session(dist, fn) {
  const server = serve(dist); await new Promise((r) => server.listen(0, r));
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, locale: 'en' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', bookPage: 'never' })); });
  await p.reload(); await p.waitForSelector('.library-view');
  try { return await fn(p, errors); } finally { await br.close(); server.close(); }
}

(async () => {
  const en = path.join(TMP, 'en.epub'), ar = path.join(TMP, 'ar.epub'), ja = path.join(TMP, 'ja.epub');
  await makeEpub(en, ENGLISH); await makeEpub(ar, ARABIC); await makeEpub(ja, JAPANESE);

  let oldModel = null;
  if (OLD) oldModel = await session(OLD, async (p) => { const b = await importFile(p, en, 'Lantern'); await openReader(p, b.id); await p.waitForTimeout(1500); return model(p); });

  await session(DIST, async (p, errors) => {
    // ---- 1. defaults: hyphenation on, a language on the text
    const visual = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') || '{}'));
    const bk = await importFile(p, en, 'Lantern'); ok('the English book imported', !!bk); if (!bk) return;
    await openReader(p, bk.id); await p.waitForTimeout(1500);
    const bodyP = await block(p, '[P3]');
    ok('fresh profile: hyphenation is on and the body is hyphenated (hyphens: auto, with a language)', bodyP && bodyP.hyphens === 'auto' && bodyP.lang === 'en', { bodyP, visual });

    // ---- 1. the title shapes
    const c1l = await block(p, 'Chapter 1:'), c1t = await block(p, 'The Lantern Road');
    ok('styled paragraphs «Chapter 1:» + title: both centred, no indent', isCentred(c1l) && isCentred(c1t), { c1l, c1t });
    ok('… not hyphenated (body is)', c1l?.hyphens === 'manual' && c1t?.hyphens === 'manual', { l: c1l?.hyphens, t: c1t?.hyphens });
    await shot(p, 'made-en-c1.png', 'Chapter 1:');
    const c2 = await block(p, 'The Second Gate', 'h2');
    ok('<h2><span>Chapter 2:</span><br/>title</h2>: centred', isCentred(c2) && c2.lines >= 2, c2);
    const c3 = await block(p, 'Chapter 3: The Quiet Mill');
    ok('one block «Chapter 3: Title»: centred, no indent', isCentred(c3), c3);
    const c4 = await block(p, 'Northern Lights');
    ok('a title alone (as the contents say): centred', isCentred(c4), c4);
    const c5 = await block(p, 'Chapter 5');
    ok('a label alone «Chapter 5»: centred', isCentred(c5), c5);
    const c6 = await block(p, 'Chapter five of my life');
    ok('a long first paragraph beginning with «Chapter»: body text (not centred, not marked)', c6 && !c6.mark && c6.startGap <= 2 && c6.align !== 'center', c6);

    // ---- 3. the light-novel shape
    const c7 = await block(p, 'The Copper Bell'); const mira = await block(p, 'Mira'); const brk = await block(p, '* * *');
    ok('one <p class> «Chapter 7:<br/>Title» in bold 1.17em spans: centred', isCentred(c7) && c7.lines >= 2, c7);
    const bell = await inline(p, 'Chapter 7:The Copper Bell');
    ok('… bold, at the book\'s own 1.17× (not the heading scale)', bell && bell.weight >= 600 && Math.abs(bell.ratio - 1.17) < 0.03 && Math.abs(c7.size - bodyP.size) < 0.5, { bell, size: c7?.size, body: bodyP?.size });
    ok('the point-of-view line «Mira» (centred by the book\'s class): centred and bold', isCentred(mira) && (await inline(p, 'Mira'))?.weight >= 600, mira);
    ok('a «* * *» scene break centred by the book\'s class', isCentred(brk), brk);
    const first = await inline(p, 'T');
    ok('the 3em first letter: bold at the text\'s size by default', first && first.weight >= 600 && Math.abs(first.ratio - 1) < 0.05, first);
    const spacers = await p.evaluate(() => { const s = [...document.querySelectorAll('.reader-flow section.kr-chapter')][6]; return [...s.querySelectorAll('p')].filter((x) => !x.textContent.trim()).map((x) => Math.round(x.getBoundingClientRect().height + parseFloat(getComputedStyle(x).marginTop) + parseFloat(getComputedStyle(x).marginBottom))); });
    const fs19 = bodyP.size;
    ok('empty spacer paragraphs: each at most a small gap (not a line each)', spacers.length >= 3 && spacers.every((h) => h <= fs19 * 0.6), { spacers, fs19 });
    await shot(p, 'made-en-c7.png', 'Chapter 7:');

    // ---- 4. a book centring everything
    const c8long = await block(p, '[P2]', 'p:not([data-x])'); // first [P2] is chapter 1's; take chapter 8's
    const c8 = await p.evaluate(() => { const s = [...document.querySelectorAll('.reader-flow section.kr-chapter')][7]; const longP = [...s.querySelectorAll('p')].find((x) => x.textContent.includes('[P2]')); const note = [...s.querySelectorAll('p')].find((x) => x.textContent.includes('A short centred note')); return { long: getComputedStyle(longP).textAlign, note: getComputedStyle(note).textAlign }; });
    ok('a book centring every paragraph: its long paragraphs follow the reader\'s alignment, a short line stays centred', c8.long !== 'center' && c8.note === 'center', { c8, c8long: !!c8long });

    // ---- 6. the model of the text as before
    const now = await model(p);
    if (oldModel) ok('every chapter\'s text and number of blocks are those of the build before', JSON.stringify(now) === JSON.stringify(oldModel), { now: now.map((x) => x.n), old: oldModel.map((x) => x.n) });
    else console.log('note  KR_OLD_DIST not given: the comparison with the build before is skipped');

    // A highlight in chapter 3 (made now; checked after the label is hidden).
    const sel = await p.evaluate(() => { const b = [...document.querySelectorAll('.reader-flow p')].filter((x) => x.closest('section') === [...document.querySelectorAll('.reader-flow section.kr-chapter')][2]).find((x) => x.textContent.includes('[P1]')); const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('extraordinarily methodical'); if (i >= 0) { b.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 'extraordinarily methodical'.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } } return false; });
    let hlMade = false;
    if (sel) { try { await p.waitForSelector('.sel-toolbar .sel-colors .dot', { timeout: 5000 }); await p.click('.sel-toolbar .sel-colors .dot'); await p.waitForTimeout(800); hlMade = true; } catch { /* below */ } }
    ok('a highlight made in chapter 3', hlMade);

    // ---- 5. hyphenation off: titles still centred
    await setVisual(p, { hyphenate: false }); await openReader(p, bk.id);
    const offT = await block(p, 'The Lantern Road'), offB = await block(p, '[P3]');
    ok('hyphenation off: body not hyphenated, titles still centred', offB?.hyphens === 'manual' && isCentred(offT), { offB: offB?.hyphens, offT });
    // Book formatting (justified, indented, hyphenated body — the owner's own setup): titles still centred, unindented.
    await setVisual(p, { hyphenate: true, bookFormat: true }); await openReader(p, bk.id);
    const bfT = await block(p, 'The Lantern Road'), bfL = await block(p, 'Chapter 1:'), bfB = await block(p, '[P3]');
    ok('book formatting on: body indented and justified, the title block centred with no indent', bfB && bfB.indent !== '0px' && bfB.align === 'justify' && isCentred(bfT) && isCentred(bfL), { bfB: bfB && [bfB.indent, bfB.align], bfT, bfL });
    await shot(p, 'made-en-c1-bookformat.png', 'Chapter 1:');
    // «At the start», «As the book says»
    await setVisual(p, { bookFormat: false, chapterTitles: 'start' }); await openReader(p, bk.id);
    const st = await block(p, 'The Lantern Road'), st7 = await block(p, 'The Copper Bell');
    ok('«Chapter titles: At the start»: titles at the start margin, no indent', st && st.startGap <= 2 && st.indent === '0px' && st7 && st7.startGap <= 2, { st, st7 });
    await setVisual(p, { chapterTitles: 'book', firstLetter: 'book' }); await openReader(p, bk.id);
    const big = await inline(p, 'T'); const bigLine = await p.evaluate(() => { const e = [...document.querySelectorAll('.reader-flow span')].reverse().find((x) => x.textContent === 'T'); const b = e.closest('p'); const r = document.createRange(); r.selectNodeContents(b); const rs = [...r.getClientRects()]; const er = e.getBoundingClientRect(), br = b.getBoundingClientRect(); return { inside: er.top >= br.top - 1 && er.bottom <= br.bottom + 1, overlap: rs.some((x) => x !== rs[0] && x.top < er.bottom - 2 && x.left > er.right) }; });
    ok('«First letter: As the book sets it»: the 3em letter at 3×, inside its paragraph, no line over it', big && Math.abs(big.ratio - 3) < 0.05 && bigLine.inside && !bigLine.overlap, { big, bigLine });
    const bk1 = await block(p, 'The Lantern Road'), bk7 = await block(p, 'The Copper Bell');
    ok('«As the book says»: a title the book does not centre at the start, one it centres centred', bk1 && bk1.startGap <= 2 && isCentred(bk7), { bk1, bk7 });

    // ---- 6. hide the word «Chapter»
    await setVisual(p, { chapterTitles: 'center', firstLetter: 'bold', hideChapterWord: true }); await openReader(p, bk.id);
    const h1l = await block(p, 'Chapter 1:'), h1t = await block(p, 'The Lantern Road');
    ok('hide «Chapter»: the label paragraph hidden, the title shown and centred', h1l && !h1l.visibleText && isCentred(h1t), { h1l, h1t });
    const h3 = await block(p, 'The Quiet Mill');
    ok('… in one block: «Chapter 3:» hidden, «The Quiet Mill» shown and centred', h3 && !h3.shownLabel && h3.visibleText && isCentred(h3) && h3.text.includes('Chapter 3:'), h3);
    const h7 = await block(p, 'The Copper Bell');
    ok('… «Chapter 7:<br/>»: label and line break hidden (one line left)', h7 && !h7.shownLabel && h7.lines === 1 && isCentred(h7), h7);
    const h5 = await block(p, 'Chapter 5');
    ok('… a title that is a label alone («Chapter 5») stays', h5 && h5.visibleText && isCentred(h5), h5);
    const hidden = await model(p);
    ok('… the text and the blocks of every chapter unchanged by hiding', JSON.stringify(hidden) === JSON.stringify(now), { hidden: hidden.map((x) => x.n), now: now.map((x) => x.n) });
    await shot(p, 'made-en-hidelabel.png', 'The Lantern Road');
    // The top bar and the contents.
    await p.evaluate(() => { const b = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.includes('The Quiet Mill')); b.scrollIntoView({ block: 'start' }); const s = document.querySelector('.reader-flow').closest('.reader-scroll'); s.scrollTop += 200; s.dispatchEvent(new Event('scroll')); });
    await p.waitForTimeout(900);
    const bar = await p.evaluate(() => ({ title: document.querySelector('.reader-view .title small, .topbar small, header small')?.textContent ?? '', all: [...document.querySelectorAll('small')].map((s) => s.textContent).join(' | ') }));
    ok('… the top bar names the chapter «The Quiet Mill» (without «Chapter 3:»)', /The Quiet Mill/.test(bar.all) && !/Chapter 3/.test(bar.all), bar);
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'toc' })));
    await p.waitForSelector('.panel.open .toc-list button >> visible=true'); await p.waitForTimeout(300);
    const tocLabels = await p.evaluate(() => [...document.querySelectorAll('.panel.open .toc-label')].map((x) => x.textContent));
    ok('… the contents list «The Lantern Road», «The Quiet Mill», and «Chapter 5» as it is', tocLabels.includes('The Lantern Road') && tocLabels.includes('The Quiet Mill') && tocLabels.includes('Chapter 5') && !tocLabels.some((l) => /^Chapter [137]:/.test(l)), tocLabels);
    await p.click('.panel.open .panel-head button').catch(() => {}); await p.waitForTimeout(200);
    // Search finds the chapter's text — its hidden label too.
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'search' })));
    await p.waitForSelector('.panel.open input[type=search]'); await p.fill('.panel.open input[type=search]', 'Chapter 3: The Quiet'); await p.waitForTimeout(1800);
    const hits = await p.evaluate(() => [...document.querySelectorAll('.panel.open .hit')].length);
    ok('… search still finds «Chapter 3: The Quiet» in the chapter', hits >= 1, hits);
    await p.click('.panel.open .panel-head button').catch(() => {}); await p.waitForTimeout(200);
    const mk = await p.evaluate(() => { const ms = [...document.querySelectorAll('.reader-flow mark.kr-hl')]; return { text: ms.map((m) => m.textContent).join(''), para: ms[0]?.closest('p')?.textContent.slice(0, 5) ?? '', chapter: [...document.querySelectorAll('.reader-flow section.kr-chapter')].indexOf(ms[0]?.closest('section')) }; });
    ok('… the highlight made in chapter 3 comes back on its words, in its paragraph', mk.text === 'extraordinarily methodical' && mk.para.trim() === '[P1]' && mk.chapter === 2, mk);

    // ---- Arabic and Japanese
    await setVisual(p, { hideChapterWord: false });
    const ba = await importFile(p, ar, 'القناديل'); ok('the Arabic book imported', !!ba);
    if (ba) {
      await openReader(p, ba.id);
      const al = await block(p, 'الفصل الأول'), at = await block(p, 'عودة الغريب'), a2 = await block(p, 'ليل المدينة');
      ok('Arabic «الفصل الأول» + title, right to left: centred, no indent', isCentred(al) && isCentred(at) && at.dir === 'rtl', { al, at });
      ok('Arabic «الفصل الثاني: …» in one block: centred', isCentred(a2), a2);
      await shot(p, 'made-ar.png', 'الفصل الأول');
      await setVisual(p, { hideChapterWord: true }); await openReader(p, ba.id);
      const hal = await block(p, 'الفصل الأول'), ha2 = await block(p, 'ليل المدينة');
      ok('Arabic, hide the label: «الفصل الأول» hidden, «عودة الغريب» shown; «الفصل الثاني:» hidden in its block', hal && !hal.visibleText && ha2 && ha2.visibleText && ha2.lines === 1, { hal, ha2 });
      await shot(p, 'made-ar-hidelabel.png', 'عودة الغريب');
      await setVisual(p, { hideChapterWord: false });
    }
    const bj = await importFile(p, ja, '灯台'); ok('the Japanese book imported', !!bj);
    if (bj) {
      await openReader(p, bj.id);
      const j1 = await block(p, '第一話');
      ok('Japanese «第一話　帰り道»: centred', isCentred(j1), j1);
    }
    ok('no page errors', errors.length === 0, errors);
  });
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
