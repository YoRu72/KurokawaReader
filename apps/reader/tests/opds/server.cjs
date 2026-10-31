// A small OPDS server for tests: Atom navigation + acquisition feeds (with OpenSearch and paging), an OPDS 2 JSON
// root, and the files themselves. node server.cjs <port> <dir with books>
const http = require('http'); const fs = require('fs'); const path = require('path');
const [port, dir] = [Number(process.argv[2] || 5300), process.argv[3]];
const books = [
  { id: 'b1', title: 'مقامات الحريري', author: 'الحريري', file: 'maqamat-al-hariri.epub', type: 'application/epub+zip', lang: 'ar', summary: 'خمسون مقامة في البيان والبديع.' },
  { id: 'b2', title: 'Alice in Wonderland', author: 'Lewis Carroll', file: 'alice-in-wonderland.epub', type: 'application/epub+zip', lang: 'en', summary: '<p>Down the <b>rabbit</b> hole.</p>' },
  { id: 'b3', title: 'متون طالب العلم', author: 'ابن مالك', file: 'user144.pdf', type: 'application/pdf', lang: 'ar', summary: 'ألفية ابن مالك.' },
  { id: 'b4', title: 'Arabic sample', author: 'Tester', file: 'fixtures/arabic.epub', type: 'application/epub+zip', lang: 'ar', summary: '' },
];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const base = () => `http://localhost:${port}`;
const entry = (b) => `<entry><id>urn:${b.id}</id><title>${esc(b.title)}</title><author><name>${esc(b.author)}</name></author><dcterms:language>${b.lang}</dcterms:language><summary type="html">${esc(b.summary)}</summary><category label="Classics" term="classics"/>
  <link rel="http://opds-spec.org/acquisition" type="${b.type}" href="/files/${encodeURIComponent(b.file)}" title="Download"/>
  <link rel="http://opds-spec.org/image/thumbnail" type="image/png" href="/thumb.png"/></entry>`;
const feedHead = (title, self) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog"><id>${self}</id><title>${esc(title)}</title><updated>2026-01-01T00:00:00Z</updated>
<link rel="self" href="${self}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/><link rel="start" href="/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
<link rel="search" type="application/opensearchdescription+xml" href="/opds/osd.xml"/>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, base()); const p = u.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  const xml = (s) => { res.setHeader('Content-Type', 'application/atom+xml;charset=utf-8'); res.end(s); };
  if (p === '/opds' || p === '/opds/') return xml(feedHead('Test Library', '/opds') + `
<entry><title>All books</title><id>all</id><content type="text">Every book, two to a page</content><link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="/opds/all?page=1"/></entry>
<entry><title>Arabic shelf</title><id>ar</id><link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="/opds/ar"/></entry>
<entry><title>Secret shelf</title><id>secret</id><link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="/opds/secret"/></entry></feed>`);
  if (p === '/opds/all') { const page = Number(u.searchParams.get('page') || 1); const slice = books.slice((page - 1) * 2, page * 2); return xml(feedHead(`All books · ${page}`, `/opds/all?page=${page}`) + (page * 2 < books.length ? `<link rel="next" href="/opds/all?page=${page + 1}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>` : '') + slice.map(entry).join('') + '</feed>'); }
  if (p === '/opds/ar') return xml(feedHead('Arabic shelf', '/opds/ar') + books.filter((b) => b.lang === 'ar').map(entry).join('') + '</feed>');
  if (p === '/opds/secret') { if (req.headers.authorization !== 'Basic ' + Buffer.from('reader:letmein').toString('base64')) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Basic'); res.end('auth'); return; } return xml(feedHead('Secret shelf', '/opds/secret') + entry(books[1]) + '</feed>'); }
  if (p === '/opds/osd.xml') { res.setHeader('Content-Type', 'application/opensearchdescription+xml'); res.end(`<?xml version="1.0"?><OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Test</ShortName><Url type="application/atom+xml" template="${base()}/opds/search?q={searchTerms}&amp;page={startPage?}"/></OpenSearchDescription>`); return; }
  if (p === '/opds/search') { const q = (u.searchParams.get('q') || '').toLowerCase(); return xml(feedHead(`Search: ${q}`, `/opds/search?q=${q}`) + books.filter((b) => (b.title + b.author).toLowerCase().includes(q)).map(entry).join('') + '</feed>'); }
  if (p === '/opds2.json') { res.setHeader('Content-Type', 'application/opds+json'); res.end(JSON.stringify({ metadata: { title: 'JSON Library' }, links: [{ rel: 'self', href: '/opds2.json', type: 'application/opds+json' }, { rel: 'search', href: base() + '/opds2/search{?query}', type: 'application/opds+json', templated: true }], navigation: [{ href: '/opds2/all.json', title: 'Everything (JSON)', type: 'application/opds+json' }], publications: [{ metadata: { title: books[1].title, author: { name: books[1].author }, language: 'en', description: 'From the JSON feed' }, links: [{ rel: 'http://opds-spec.org/acquisition/open-access', href: '/files/' + books[1].file, type: books[1].type }], images: [{ href: '/thumb.png', type: 'image/png' }] }] })); return; }
  if (p === '/opds2/all.json' || p === '/opds2/search') { res.setHeader('Content-Type', 'application/opds+json'); const q = (u.searchParams.get('query') || '').toLowerCase(); res.end(JSON.stringify({ metadata: { title: q ? `JSON search: ${q}` : 'Everything (JSON)' }, publications: books.filter((b) => !q || b.title.toLowerCase().includes(q)).map((b) => ({ metadata: { title: b.title, author: b.author, language: b.lang }, links: [{ rel: ['http://opds-spec.org/acquisition'], href: '/files/' + b.file, type: b.type }] })) })); return; }
  if (p === '/thumb.png') { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')); return; }
  if (p.startsWith('/files/')) { const f = path.join(dir, decodeURIComponent(p.slice(7))); if (!fs.existsSync(f)) { res.statusCode = 404; res.end(); return; } res.setHeader('Content-Type', f.endsWith('.pdf') ? 'application/pdf' : 'application/epub+zip'); res.setHeader('Content-Length', fs.statSync(f).size); fs.createReadStream(f).pipe(res); return; }
  res.statusCode = 404; res.end('nope');
});
server.listen(port, () => console.log('opds test server on', port));
