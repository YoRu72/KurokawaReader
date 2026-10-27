// A stand-in for shamela.ws and archive.org for the tests: the saved pages of shamela.ws (tests/sources/shamela-
// samples, as the scraper community keeps them) served at the site's paths, pages 1–92 of book 6388 made from
// the two saved ones, and a small archive.org with its search and metadata APIs and a few files.
// node server.cjs <port> <dir with books for archive files>
const http = require('http'); const fs = require('fs'); const path = require('path');
const [port, dir] = [Number(process.argv[2] || 5400), process.argv[3] || '.'];
const S = path.join(__dirname, 'shamela-samples');
const read = (n) => fs.readFileSync(path.join(S, n), 'utf8').replace(/^[\s\S]*?(?=<body)/, '');
const wrap = (body) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>الشاملة</title></head>${body}</html>`;
// The two saved pages' text, and a nav block that names the next and last pages.
const pagesDoc = read('pages.html');
const nass = [...pagesDoc.matchAll(/<div class="nass[^"]*" data-page-id="(\d+)" data-page-num="(\d+)">([\s\S]*?)<\/div>\s*(?=<div id=|<div class="nass|<\/div>)/g)].map((m) => ({ id: +m[1], num: +m[2], html: m[3] }));
const pageHtml = (book, n) => {
  const src = nass[(n - 1) % nass.length] || nass[0];
  const num = 4 + n;
  return wrap(`<body><div id="wrapper"><div class="s-nav"><div class="s-nav-head"><h4>فهرس الكتاب</h4></div><ul><li>-<a href="/book/${book}/1">بيان أصول الإيمان</a></li></ul></div>
<div><input type="hidden" id="fld_part_top" value=""> ص: <input type="number" id="fld_goto_top" value="${num}"> <a href="/book/${book}/${Math.min(92, n + 1)}#p1" class="btn">&gt;</a> <a href="/book/${book}/92#p1" class="btn">&gt;&gt;</a></div>
<div class="nass margin-top-10" data-page-id="${n}" data-page-num="${num}">${src.html}${n % 7 === 0 ? '<p class="hamesh">(١) هامشٌ تجريبيّ.</p>' : ''}</div>
<div><input type="hidden" id="fld_part_bottom" value=""> ص: <input type="number" id="fld_goto_bottom" value="${num}"> <a href="/book/${book}/${Math.min(92, n + 1)}#p1" class="btn">&gt;</a> <a href="/book/${book}/92#p1" class="btn">&gt;&gt;</a></div></div></body>`);
};
const books = [
  { identifier: 'alice-wonderland-test', title: 'Alice in Wonderland', creator: 'Lewis Carroll', year: '1865', language: 'English', subject: ['Fantasy', 'Children', 'Classics'], downloads: 120000, mediatype: 'texts', collection: ['gutenberg', 'texts'], description: '<p>Down the rabbit hole.</p>', file: 'alice-in-wonderland.epub', formats: [['alice.epub', 'EPUB'], ['alice.pdf', 'Text PDF']] },
  { identifier: 'maqamat-test', title: 'مقامات الحريري', creator: 'الحريري', year: '1100', language: 'Arabic', subject: ['Adab', 'Classics', 'Fantasy'], downloads: 3400, mediatype: 'texts', collection: ['opensource'], description: 'خمسون مقامة', file: 'maqamat-al-hariri.epub', formats: [['maqamat.epub', 'EPUB']] },
  { identifier: 'pride-test', title: 'Pride and Prejudice', creator: 'Jane Austen', year: '1813', language: 'English', subject: ['Classics', 'Romance'], downloads: 90000, mediatype: 'texts', collection: ['gutenberg'], description: 'A truth universally acknowledged.', file: null, formats: [['pride.pdf', 'Text PDF']] },
  { identifier: 'borrow-only-test', title: 'A Lending Book', creator: 'Someone', year: '1990', language: 'English', subject: ['Fantasy'], downloads: 50, mediatype: 'texts', collection: ['inlibrary'], description: 'borrow', file: null, formats: [] },
];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${port}`); const p = u.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.end(); return; }
  const html = (s) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(s); };
  const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  // shamela.ws
  if (p === '/' || p === '') return html(wrap(read('home.html')));
  if (/^\/category\/\d+$/.test(p)) return html(wrap(read('category.html')));
  if (/^\/author\/\d+$/.test(p)) return html(wrap(read('author.html')));
  if (p === '/book/23635') return html(wrap(read('book-toc.html')));
  if (/^\/book\/\d+$/.test(p)) return html(wrap(read('book.html')));
  { const m = /^\/book\/(\d+)\/(\d+)$/.exec(p); if (m) { if (+m[2] === 50 && u.searchParams.get('cf') !== 'ok') { /* a Cloudflare-looking refusal once */ } return html(pageHtml(m[1], +m[2])); } }
  if (/^\/ajax\/titlechilds\//.test(p)) return html(`<li>-<a href="/book/23635/3">فصل فرعي أ</a></li><li>-<a href="/book/23635/5">فصل فرعي ب</a></li>`);
  // The site's own text search (POST /ajax/search, as its search page does): hits with snippets, the count, a next page.
  if (p === '/ajax/search' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const form = new URLSearchParams(body); const term = form.get('term') || ''; const pageNo = Number(form.get('page') || 1); const books = form.getAll('books[]').filter((b) => b !== '-1');
      const word = term.replace(/[+"]/g, ' ').trim().split(/\s+/)[0] || '';
      const all = [{ book: 6388, page: 5, title: 'الفقه الأكبر', author: 'أبو حنيفة' }, { book: 6388, page: 9, title: 'الفقه الأكبر', author: 'أبو حنيفة' }, { book: 23635, page: 2, title: 'مفاتيح الغيب', author: 'الرازي' }, { book: 23635, page: 7, title: 'مفاتيح الغيب', author: 'الرازي' }].filter((h) => !books.length || books.includes(String(h.book)));
      const per = 3; const slice = all.slice((pageNo - 1) * per, pageNo * per);
      const items = slice.map((h) => `<div><a href="https://shamela.ws/book/${h.book}/${h.page}" class="list-group-item"><b>${h.title}</b> <span class="text-gray">[${h.author}]</span><p class="srch-snippet">ومن ذلك قوله في <b>${word}</b> وما يتصل به من الكلام</p></a></div>`).join('');
      html(`<div class="srch-head">النتائج ${(pageNo - 1) * per + 1} إلى ${Math.min(pageNo * per, all.length)} من ${all.length}</div>${items}${pageNo * per < all.length ? `<a id="bu_srch_more" data-page="${pageNo + 1}" href="#">المزيد</a>` : ''}`);
    }); return;
  }
  // archive.org
  if (p === '/advancedsearch.php') {
    const q = u.searchParams.get('q') || ''; const page = +(u.searchParams.get('page') || 1);
    const term = /title:\((\w+)\)/.exec(q)?.[1]; let docs = books.filter((b) => !term || new RegExp(term, 'i').test(b.title + b.creator + b.subject.join(' ')));
    if (/NOT collection:\(inlibrary\)/.test(q)) docs = docs.filter((b) => !b.collection.includes('inlibrary'));
    if (/language:\("Arabic"\)/.test(q)) docs = docs.filter((b) => b.language === 'Arabic');
    if (/subject:\("Fantasy"\)/.test(q)) docs = docs.filter((b) => b.subject.includes('Fantasy'));
    return json({ response: { numFound: docs.length, start: 0, docs: page === 1 ? docs.map(({ file, formats, ...d }) => d) : [] } });
  }
  { const m = /^\/metadata\/(.+)$/.exec(p); if (m) { const b = books.find((x) => x.identifier === decodeURIComponent(m[1])); if (!b) { res.statusCode = 404; return res.end(); } return json({ metadata: { title: b.title, creator: b.creator, year: b.year, language: b.language, subject: b.subject, description: b.description, collection: b.collection, 'access-restricted-item': b.collection.includes('inlibrary') ? 'true' : undefined }, files: b.formats.map(([name, format]) => ({ name, format, size: '12345' })) }); } }
  { const m = /^\/download\/([^/]+)\/(.+)$/.exec(p); if (m) { const b = books.find((x) => x.identifier === decodeURIComponent(m[1])); const f = b && b.file ? path.join(dir, b.file) : null; if (!f || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', 'application/epub+zip'); return fs.createReadStream(f).pipe(res); } }
  if (/^\/services\/img\//.test(p)) { res.setHeader('Content-Type', 'image/png'); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')); }
  res.statusCode = 404; res.end('nope');
});
server.listen(port, () => console.log('sources test server on', port));
