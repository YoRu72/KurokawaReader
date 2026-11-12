// node tests/epubanchors.cjs: links and contents entries inside an EPUB reach their place (src/formats/epub.ts,
// src/formats/shared.ts resolveZipPath / safeDecode, src/views/book.ts):
//  1. an empty <span id> / <div id> (the usual target of a converted Arabic book's contents and footnotes) is kept, so
//     a link and a contents entry pointing at it bring it into view (it was deleted: the jump went to the chapter start);
//  2. a percent-encoded fragment (#%D8%A7…, an Arabic id as books write it) finds its id (it was not decoded);
//  3. a file with a bare "%" in its name ("50%.xhtml") does not stop the book from opening (decodeURIComponent threw);
//  4. a chapter tapped on the book's page opens that chapter when the contents have an entry the book does not have
//     (the page counted it, the reader did not: the next chapter opened).
// (The books are made here: no fixtures.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epubanchors-'));

/** chapters: [file name (as in the zip), title, body]; toc: [label, href]. */
async function makeEpub(file, id, title, chapters, toc) {
  const JSZip = require('jszip'); const z = new JSZip();
  const x = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  chapters.forEach(([name, t, body]) => z.file(`OEBPS/${name}`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ar" dir="rtl"><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`));
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>${toc.map(([l, h]) => `<li><a href="${x(h)}">${l}</a></li>`).join('')}</ol></nav></body></html>`);
  // (The manifest names the files as they are written in the zip — a bare "%" included, as careless books do.)
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>ar</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map(([name], i) => `<item id="c${i + 1}" href="${x(name)}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
const filler = (n, tag) => Array.from({ length: n }, (_, i) => `<p>فقرة ${tag} رقم ${i + 1} للحشو، كلام لا يبحث عنه أحد في هذا الموضع.</p>`).join('');

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 80; i++) {
    const b = (await allBooks(p)).find((x) => new RegExp(re, 'i').test(x.title)); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  return null;
}
async function openReader(p, id) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForSelector('.reader-flow .kr-content >> visible=true', { timeout: 30000 }); await p.waitForTimeout(900);
}
/** Where the element whose id ends with `suffix` is: found, and its top in the upper part of the screen. */
const placeOf = (p, suffix) => p.evaluate((suffix) => {
  const e = [...document.querySelectorAll('.reader-flow [id]')].find((x) => x.id.endsWith(suffix)); if (!e) return { found: false };
  const r = (e.getBoundingClientRect().height ? e : e.nextElementSibling ?? e.parentElement).getBoundingClientRect();
  return { found: true, top: Math.round(r.top), inView: r.top >= -4 && r.top < innerHeight * 0.4 };
}, suffix);
const toTop = (p) => p.evaluate(() => { document.querySelectorAll('.reader-flow, .reader-scroll, .kr-scroll').forEach((e) => { e.scrollTop = 0; }); (document.querySelector('.reader-flow')?.closest('.reader-scroll') ?? document.scrollingElement).scrollTop = 0; });

(async () => {
  const ENC = encodeURIComponent('الفصل'); // %D8%A7%D9%84%D9%81%D8%B5%D9%84
  const book = path.join(TMP, 'anchors.epub');
  await makeEpub(book, 'kr-epubanchors-1', 'كتاب المراسي', [
    ['c1.xhtml', 'الفصل الأول', filler(4, 'أولى') + `<p><a href="c2.xhtml#fn1">إلى الحاشية</a> و<a href="c3.xhtml#${ENC}">إلى الفصل الثالث</a></p>` + filler(20, 'أولى')],
    ['c2.xhtml', 'الفصل الثاني', filler(40, 'ثانية') + '<div id="part2"></div><h3>الجزء الثاني من الفصل</h3>' + filler(30, 'ثانية') + '<p><span id="fn1"></span>حاشية: هذا نص الحاشية.</p>' + filler(30, 'ثانية')],
    ['c3.xhtml', 'الفصل الثالث', filler(40, 'ثالثة') + '<h2 id="الفصل">عنوان في وسط الفصل</h2>' + filler(30, 'ثالثة')],
    ['c4.xhtml', 'الفصل الرابع', filler(30, 'رابعة')],
  ], [['مدخل مفقود', 'missing.xhtml'], ['الفصل الأول', 'c1.xhtml'], ['الجزء الثاني', 'c2.xhtml#part2'], ['الفصل الثالث', `c3.xhtml#${ENC}`], ['الفصل الرابع', 'c4.xhtml']]);
  const pct = path.join(TMP, 'percent.epub');
  await makeEpub(pct, 'kr-epubanchors-2', 'كتاب النسبة', [
    ['c1.xhtml', 'المقدمة', filler(5, 'أولى')],
    ['50%.xhtml', 'نصف الطريق', '<p>هذا فصل في ملف اسمه فيه علامة النسبة.</p>'],
  ], [['المقدمة', 'c1.xhtml'], ['نصف الطريق', '50%.xhtml']]);

  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 1000, height: 800 }, locale: 'ar' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', bookPage: 'never' })); });
  await p.reload(); await p.waitForSelector('.library-view');

  const bk = await importFile(p, book, 'المراسي');
  ok('the book imported', !!bk);
  if (bk) {
    await openReader(p, bk.id);
    // 1. a link to an empty <span id>
    const fnLink = await p.evaluate(() => { const a = [...document.querySelectorAll('.reader-flow a')].find((x) => x.textContent === 'إلى الحاشية'); return a?.getAttribute('data-kr-anchor') ?? null; });
    ok('a footnote link points at its empty <span id> (not the chapter)', !!fnLink && fnLink.endsWith('-fn1') && !!(await p.evaluate((id) => !!document.getElementById(id), fnLink)), fnLink);
    await toTop(p);
    await p.evaluate(() => [...document.querySelectorAll('.reader-flow a')].find((x) => x.textContent === 'إلى الحاشية').click()); await p.waitForTimeout(700);
    let at = await placeOf(p, '-fn1');
    ok('… tapped: the footnote is brought into view', at.found && at.inView, at);
    // 2. a percent-encoded Arabic fragment
    const encLink = await p.evaluate(() => [...document.querySelectorAll('.reader-flow a')].find((x) => x.textContent === 'إلى الفصل الثالث')?.getAttribute('data-kr-anchor') ?? null);
    ok('a percent-encoded Arabic fragment finds its id', !!encLink && encLink.endsWith('-الفصل'), encLink);
    // 1. a contents entry pointing at an empty <div id>
    await toTop(p);
    await p.evaluate(() => { document.dispatchEvent(new CustomEvent('kr:command', { detail: 'toc' })); });
    await p.waitForSelector('.panel.open .toc-list button'); await p.waitForTimeout(300);
    const labels = await p.evaluate(() => [...document.querySelectorAll('.panel.open .toc-list')].slice(1).flatMap((u) => [...u.querySelectorAll('button')].map((b) => b.textContent.replace(/\d+\s*\S*$/, '').trim())));
    await p.evaluate(() => [...document.querySelectorAll('.panel.open .toc-list button')].find((b) => b.textContent.includes('الجزء الثاني')).click()); await p.waitForTimeout(800);
    at = await placeOf(p, '-part2');
    ok('a contents entry at an empty <div id>: brought into view', at.found && at.inView, { at, labels });
    await toTop(p);
    await p.evaluate(() => { document.dispatchEvent(new CustomEvent('kr:command', { detail: 'toc' })); });
    await p.waitForSelector('.panel.open .toc-list button'); await p.waitForTimeout(300);
    await p.evaluate(() => [...document.querySelectorAll('.panel.open .toc-list button')].find((b) => b.textContent.includes('الفصل الثالث')).click()); await p.waitForTimeout(800);
    at = await placeOf(p, '-الفصل');
    ok('a contents entry with a percent-encoded fragment: its heading brought into view', at.found && at.inView, at);

    // 4. the book's page: the third chapter tapped opens the third chapter
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
    await p.evaluate((id) => { location.hash = `#/book/${id}`; }, bk.id);
    await p.waitForSelector('.book-view .chapter-list li button'); await p.waitForTimeout(500);
    const rows = await p.evaluate(() => [...document.querySelectorAll('.book-view .chapter-list li button')].map((b) => b.textContent.trim()));
    ok('the book\'s page lists the chapters the reader has (the missing entry left out)', rows.length === 4 && !rows.some((r) => r.includes('مفقود')), rows);
    await p.evaluate(() => [...document.querySelectorAll('.book-view .chapter-list li button')].find((b) => b.textContent.includes('الفصل الثالث')).click());
    await p.waitForSelector('.reader-flow .kr-content >> visible=true', { timeout: 30000 }); await p.waitForTimeout(1500);
    at = await placeOf(p, '-الفصل');
    const c4 = await p.evaluate(() => { const s = [...document.querySelectorAll('.reader-flow section.kr-chapter')][3]; const r = s?.getBoundingClientRect(); return r ? Math.round(r.top) : null; });
    ok('… «الفصل الثالث» tapped: the reader opens at it (not the next chapter)', at.found && at.inView, { at, c4 });
  }

  // 3. a bare "%" in a file's name
  const bk2 = await importFile(p, pct, 'النسبة');
  ok('a book with "50%.xhtml" in it imports', !!bk2);
  if (bk2) {
    await openReader(p, bk2.id);
    const txt = await p.evaluate(() => [...document.querySelectorAll('.reader-flow .kr-content')].map((e) => e.textContent).join(' '));
    ok('… and its "50%" chapter is there', txt.includes('علامة النسبة'));
  }
  ok('no page errors', errors.length === 0, errors);
  await br.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
