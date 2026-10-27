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
  const src = book === '23635' && n === 3
    ? { html: '<p>بقية الكلام على الاستعاذة وما فيها من الفوائد.</p><p>تفسير البسملة: اعلم أن البسملة آية من كل سورة عند بعضهم.</p><p>وفيها مباحث كثيرة.</p><p>نعم الله تعالى التي لا تحصى على العبد في كل لحظة.</p><p>فيجب الشكر عليها.</p>' }
    : nass[(n - 1) % nass.length] || nass[0];
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
// A work in three volumes, as three PDFs (and the archive's own derivatives beside them).
const { PDFDocument, StandardFonts } = require(path.join(__dirname, '../../node_modules/pdf-lib'));
const volumes = {};
const makeVolumes = async () => {
  for (const n of [1, 2, 3]) {
    const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 2; i++) { const pg = doc.addPage([300, 400]); pg.drawText(`Volume ${n} page ${i}`, { x: 40, y: 340, size: 18, font }); }
    volumes[`history-vol${n}.pdf`] = Buffer.from(await doc.save());
  }
};
books.push({ identifier: 'history-parts-test', title: 'History of Everything', creator: 'H. Writer', year: '1901', language: 'English', subject: ['History', 'Classics'], downloads: 777, mediatype: 'texts', collection: ['americana', 'texts'], description: 'In three volumes.', file: null, formats: [['history-vol1.pdf', 'Text PDF', 'original'], ['history-vol2.pdf', 'Text PDF', 'original'], ['history-vol3.pdf', 'Text PDF', 'original'], ['history-vol1_text.pdf', 'Additional Text PDF', 'derivative'], ['history_sample.pdf', 'Text PDF', 'derivative']] });
// A web folder of books, in the listing styles servers make: Apache's table at the root, nginx's <pre> in
// one subfolder, Python's <ul> in another, nginx's JSON deeper down. The files are the fixtures.
const folderPages = {
  '/library/': `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN"><html><head><title>Index of /library</title></head><body><h1>Index of /library</h1>
<table><tr><th><a href="?C=N;O=D">Name</a></th><th><a href="?C=M;O=A">Last modified</a></th><th><a href="?C=S;O=A">Size</a></th><th><a href="?C=D;O=A">Description</a></th></tr><tr><th colspan="4"><hr></th></tr>
<tr><td><a href="/">Parent Directory</a></td><td>&nbsp;</td><td align="right">  - </td><td>&nbsp;</td></tr>
<tr><td><a href="Alpha%20Series/">Alpha Series/</a></td><td align="right">2024-03-01 10:00  </td><td align="right">  - </td><td>&nbsp;</td></tr>
<tr><td><a href="Beta/">Beta/</a></td><td align="right">2024-03-02 11:30  </td><td align="right">  - </td><td>&nbsp;</td></tr>
<tr><td><a href="cover.jpg">cover.jpg</a></td><td align="right">2024-03-02 11:31  </td><td align="right"> 80K</td><td>&nbsp;</td></tr>
<tr><td><a href="readme.txt">readme.txt</a></td><td align="right">2024-03-02 11:32  </td><td align="right">1.5K</td><td>&nbsp;</td></tr>
<tr><td><a href="sample.pdf">sample.pdf</a></td><td align="right">2024-03-03 09:00  </td><td align="right">1.2M</td><td>&nbsp;</td></tr>
<tr><th colspan="4"><hr></th></tr></table><address>Apache/2.4 Server</address></body></html>`,
  '/library/Alpha%20Series/': `<html><head><title>Index of /library/Alpha Series/</title></head><body bgcolor="white"><h1>Index of /library/Alpha Series/</h1><hr><pre><a href="../">../</a>
<a href="Alpha%201.epub">Alpha 1.epub</a>                                       01-Mar-2024 10:00              204800
<a href="Alpha%202.epub">Alpha 2.epub</a>                                       01-Mar-2024 10:05              318000
<a href="Alpha%20extras.zip">Alpha extras.zip</a>                               01-Mar-2024 10:06             4194304
</pre><hr></body></html>`,
  '/library/Beta/': `<!DOCTYPE HTML><html><head><meta charset="utf-8"><title>Directory listing for /library/Beta/</title></head><body><h1>Directory listing for /library/Beta/</h1><hr><ul>
<li><a href="Deep/">Deep/</a></li>
<li><a href="notes.txt">notes.txt</a></li>
</ul><hr></body></html>`,
};
const folderJson = { '/library/Beta/Deep/': [{ name: 'deep.pdf', type: 'file', mtime: 'Sun, 03 Mar 2024 09:00:00 GMT', size: 6000 }, { name: 'more', type: 'directory', mtime: 'Sun, 03 Mar 2024 09:00:00 GMT' }] };
// A file answered whole or in the range asked for (bytes=a-b, a-, -n), as a web server does.
const sendFile = (req, res, file, mime) => {
  const size = fs.statSync(file).size; res.setHeader('Content-Type', mime); res.setHeader('Accept-Ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m || (!m[1] && !m[2])) { res.setHeader('Content-Length', String(size)); return fs.createReadStream(file).pipe(res); }
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])); let end = m[1] ? (m[2] ? Math.min(size - 1, Number(m[2])) : size - 1) : size - 1;
  if (start >= size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); return res.end(); }
  res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); res.setHeader('Content-Length', String(end - start + 1));
  ranges.push(`${path.basename(file)} ${start}-${end}`);
  return fs.createReadStream(file, { start, end }).pipe(res);
};
const ranges = [];
// An h5ai folder (as server.elscione.com runs): pages with the fallback table h5ai prints for browsers without
// scripts (absolute links, sizes in thousands of bytes), one folder whose page has no table — its list comes
// from h5ai's API, a POST of JSON to the folder — and the volumes served by range.
const OTL = '/Officially%20Translated%20Light%20Novels/';
const h5aiPage = (rows) => `<!DOCTYPE html><html class="no-js" lang="en"><head><meta charset="utf-8"><title>index - powered by h5ai v0.30.0 (https://larsjung.de/h5ai/)</title><link rel="stylesheet" href="/_h5ai/public/css/styles.css"><script src="/_h5ai/public/js/scripts.js" data-module="index"></script></head><body class="index" id="root"><div id="fallback-hints"><span class="noJsMsg">⚡ JavaScript is disabled! ⚡</span><span class="backlink"><a href="https://larsjung.de/h5ai/" title="h5ai v0.30.0 - Modern HTTP web server index.">powered by h5ai</a></span></div>`
  + (rows ? `<div id="fallback"><table><tr><th class="fb-i"></th><th class="fb-n"><span>Name</span></th><th class="fb-d"><span>Last modified</span></th><th class="fb-s"><span>Size</span></th></tr><tr><td class="fb-i"><img src="/_h5ai/public/images/fallback/folder-parent.png" alt="folder-parent"/></td><td class="fb-n"><a href="..">Parent Directory</a></td><td class="fb-d"></td><td class="fb-s"></td></tr>`
  + rows.map(([href, name, size]) => `<tr><td class="fb-i"><img src="/_h5ai/public/images/fallback/${size === null ? 'folder' : 'file'}.png" alt="${size === null ? 'folder' : 'file'}"/></td><td class="fb-n"><a href="${href}">${name}</a></td><td class="fb-d">2024-05-01 12:00</td><td class="fb-s">${size === null ? '' : Math.floor(size / 1000) + ' KB'}</td></tr>`).join('') + '</table></div>' : '') + '</body></html>';
// The tree, shaped like the real one: series folders named as the publishers' series, volumes named
// "<Series> - Volume 01 [Publisher][Edition].epub" (J-Novel Club's in two editions, Premium and Kobo), a
// "{v2}", a "Volume 01.5 - …", "!Side Stories" and scan ("!Ozymandias", [OCR]) subfolders; Alpha Saga with a
// PDF, Beta Tales with its own cover.jpg, Gamma Chronicles' page drawn by script (no table).
const otlFiles = {}; const otlDirs = {}; const otlTimes = {};
const T0 = Date.UTC(2024, 0, 1);
const otlAdd = (folder, name, fixture, mime, time) => {
  const href = OTL + (folder ? folder.split('/').map(encodeURIComponent).join('/') + '/' : '') + encodeURIComponent(name);
  otlFiles[href] = [fixture, mime];
  const size = fs.existsSync(path.join(dir, fixture)) ? fs.statSync(path.join(dir, fixture)).size : 1000;
  (otlDirs[folder] = otlDirs[folder] || []).push([href, name, size, time ?? T0]);
};
const otlDir = (parent, name, time) => { const href = OTL + (parent ? parent.split('/').map(encodeURIComponent).join('/') + '/' : '') + encodeURIComponent(name) + '/'; (otlDirs[parent] = otlDirs[parent] || []).push([href, name, null, time ?? T0]); otlDirs[parent ? `${parent}/${name}` : name] = otlDirs[parent ? `${parent}/${name}` : name] || []; };
const pad = (n) => String(n).padStart(2, '0');
const EPUBS = ['alice-in-wonderland.epub', 'maqamat-al-hariri.epub'];
otlDir('', 'Alpha Saga', T0 + 5 * 86400000); otlDir('', 'Beta Tales', T0 + 4 * 86400000); otlDir('', 'Gamma Chronicles', T0 + 3 * 86400000);
otlAdd('Alpha Saga', 'Alpha Saga - Side Story.pdf', 'sample.pdf', 'application/pdf');
otlAdd('Alpha Saga', 'Alpha Saga Vol. 1.epub', 'alice-in-wonderland.epub', 'application/epub+zip');
otlAdd('Alpha Saga', 'Alpha Saga Vol. 10.epub', 'alice-in-wonderland.epub', 'application/epub+zip');
otlAdd('Alpha Saga', 'Alpha Saga Vol. 2.epub', 'maqamat-al-hariri.epub', 'application/epub+zip');
otlAdd('Beta Tales', 'Beta Tales 1.epub', 'maqamat-al-hariri.epub', 'application/epub+zip');
otlAdd('Beta Tales', 'cover.jpg', 'beta-cover.jpg', 'image/jpeg');
otlAdd('Gamma Chronicles', 'Gamma Chronicles v01.epub', 'alice-in-wonderland.epub', 'application/epub+zip');
otlAdd('Gamma Chronicles', 'Gamma Chronicles v02.epub', 'maqamat-al-hariri.epub', 'application/epub+zip');
const NAMES = ['Spice and Wolf', "Didn't I Say to Make My Abilities Average", 'Re:Zero -Starting Life in Another World-', 'Monogatari Series', 'Goblin Slayer', 'Ascendance of a Bookworm', 'The Apothecary Diaries', 'Black Summoner', 'Mushoku Tensei', 'Solo Leveling'];
const PUBS = [['Yen Press', ['Kobo']], ['J-Novel Club', ['Premium', 'Kobo']], ['Seven Seas', ['Kobo']], ['Dark Horse', ['Google Play']], ['Vertical', ['Kobo']]];
for (let i = 0; i < 110; i++) {
  const name = NAMES[i] ?? `Series ${String(i + 1).padStart(3, '0')} Chronicle of ${['Ash', 'Dawn', 'Frost', 'Ink', 'Tides'][i % 5]}`;
  const [pub, eds] = PUBS[i % PUBS.length];
  const nv = 2 + (i * 7) % 11;
  const t = T0 + (10 + i) * 86400000;
  otlDir('', name, t + nv * 3600000);
  for (let v = 1; v <= nv; v++) {
    const ver = name === 'Spice and Wolf' && v === 2 ? '{v2}' : '';
    for (const [k, ed] of eds.entries()) {
      if (k > 0 && v % 2) continue;   // (the Kobo edition of J-Novel Club's even volumes only)
      otlAdd(name, `${name} - Volume ${pad(v)} [${pub}]${ver}[${ed}].epub`, EPUBS[(i + v + k) % 2], 'application/epub+zip', t + v * 3600000);
    }
    if (ver) otlAdd(name, `${name} - Volume ${pad(v)} [${pub}][${eds[0]}].epub`, EPUBS[(i + v) % 2], 'application/epub+zip', t + v * 3600000 - 60000);
  }
  if (name === 'Monogatari Series') otlAdd(name, `${name} - Volume 01.5 - Bakemonogatari (Part 2) [${pub}][OCR_Samachan].epub`, EPUBS[0], 'application/epub+zip', t + 2000);
  if (i % 9 === 5) {
    otlDir(name, '!Side Stories', t); otlAdd(`${name}/!Side Stories`, `${name} - Side Story Collection [${pub}][Kobo].epub`, EPUBS[1], 'application/epub+zip', t);
    otlDir(name, '!Ozymandias', t); otlAdd(`${name}/!Ozymandias`, `${name} - Volume 01 [${pub}][OCR][Ozymandias].epub`, EPUBS[0], 'application/epub+zip', t);
  }
  if (name === 'Goblin Slayer') otlAdd(name, `${name} - Volume 01 [${pub}][OCR][Anon].epub`, EPUBS[1], 'application/epub+zip', t + 1000);
}
const otlWalk = (folder, fn) => { for (const it of otlDirs[folder] ?? []) { fn(it, folder); if (it[2] === null) otlWalk(folder ? `${folder}/${it[1]}` : it[1], fn); } };
const otlItem = ([href, , size, time]) => ({ href, time, size, managed: true, fetched: false });
const posts = [];
const folderFiles = { '/library/Alpha%20Series/Alpha%201.epub': ['alice-in-wonderland.epub', 'application/epub+zip'], '/library/Alpha%20Series/Alpha%202.epub': ['maqamat-al-hariri.epub', 'application/epub+zip'], '/library/sample.pdf': ['sample.pdf', 'application/pdf'], '/library/Beta/Deep/deep.pdf': ['sample.pdf', 'application/pdf'], '/library/readme.txt': ['plain.txt', 'text/plain'], '/library/Beta/notes.txt': ['notes.md', 'text/plain'] };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${port}`); const p = u.pathname;
  // The h5ai folder.
  const isApi = req.method === 'POST' && (p === '/' || p.startsWith(OTL));
  if (p.startsWith(OTL.replace(/\/$/, '')) || isApi || p.startsWith('/__otl/') || p === '/extensions/otl.json') {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Content-Type, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.end();
    if (p === '/__otl/posts') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(posts)); }
    if (p === '/__otl/ranges') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(ranges)); }
    // (A new volume published in a series, as the site's keepers do.)
    if (p === '/__otl/add') { otlAdd(u.searchParams.get('folder'), u.searchParams.get('name'), EPUBS[0], 'application/epub+zip', Date.now()); res.setHeader('Content-Type', 'application/json'); return res.end('{"ok":true}'); }
    // (The extension's manifest, as the app's repository keeps it.)
    if (p === '/extensions/otl.json') { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end(fs.readFileSync(path.join(__dirname, '../../extensions/otl.json'))); }
    if (isApi) {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        posts.push(body);
        let j = {}; try { j = JSON.parse(body); } catch { /* */ }
        res.setHeader('Content-Type', 'application/json');
        if (j.action !== 'get') { res.statusCode = 400; return res.end('{"err":"ERR_UNSUPPORTED"}'); }
        const folderOf = (href) => { const e = String(href || '').split('/').map((x) => encodeURIComponent(decodeURIComponent(x))).join('/'); return e === OTL ? '' : e.startsWith(OTL) ? decodeURIComponent(e.slice(OTL.length).replace(/\/$/, '')) : null; };
        const out = {};
        if (j.items) {
          // (As h5ai answers: the folder's content and the content of every folder above it.)
          const f = folderOf(j.items.href);
          if (f === null || !otlDirs[f]) { res.statusCode = 404; return res.end('{"err":"ERR_NOT_FOUND"}'); }
          const items = [{ href: OTL, time: T0, size: null, managed: true, fetched: true }, ...otlDirs[''].map(otlItem)];
          if (f) { const parts = f.split('/'); for (let k = 1; k <= parts.length; k++) { const at = parts.slice(0, k).join('/'); if (k < parts.length || true) items.push(...(otlDirs[at] ?? []).map(otlItem)); } }
          out.items = items;
        }
        if (j.search) {
          const f = folderOf(j.search.href); const pat = String(j.search.pattern || '').toLowerCase();
          if (f === null || !pat) { res.statusCode = 500; return res.end('{"err":"ERR_FAILED"}'); }
          const found = []; otlWalk(f, (it) => { if (it[1].toLowerCase().includes(pat)) found.push(otlItem(it)); });
          out.search = found;
        }
        res.end(JSON.stringify(out));
      });
      return;
    }
    const enc = p.split('/').map((seg) => encodeURIComponent(decodeURIComponent(seg))).join('/');
    const folder = enc === OTL ? '' : enc.startsWith(OTL) && enc.endsWith('/') ? decodeURIComponent(enc.slice(OTL.length, -1)) : null;
    if (folder === null && !otlFiles[enc] && otlDirs[decodeURIComponent(enc.slice(OTL.length))]) { res.statusCode = 301; res.setHeader('Location', enc + '/'); return res.end('<html><head><title>301 Moved Permanently</title></head><body><center><h1>301 Moved Permanently</h1></center></body></html>'); }
    if (folder !== null && otlDirs[folder]) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // (Gamma's page is the scripted one, without the table.)
      return res.end(h5aiPage(folder === 'Gamma Chronicles' ? null : otlDirs[folder].map(([href, name, size]) => [href, name, size])));
    }
    const f = otlFiles[enc]; if (f) { const file = f[0] === 'beta-cover.jpg' ? path.join(require('os').tmpdir(), 'kr-beta-cover.jpg') : path.join(dir, f[0]); if (fs.existsSync(file)) return sendFile(req, res, file, f[1]); }
    res.statusCode = 404; return res.end('not here');
  }
  // (The web folder, answering with its listing or its files; a folder asked without its slash is sent to it.)
  if (p.startsWith('/library')) {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Content-Type, Accept-Ranges');
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); return res.end(); }
    const enc = p.split('/').map((seg) => encodeURIComponent(decodeURIComponent(seg))).join('/');
    if (folderPages[enc + '/'] || folderJson[enc + '/']) { res.statusCode = 301; res.setHeader('Location', enc + '/'); return res.end(); }
    if (folderPages[enc]) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(folderPages[enc]); }
    if (folderJson[enc]) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(folderJson[enc])); }
    const f = folderFiles[enc]; if (f) { const file = path.join(dir, f[0]); if (fs.existsSync(file)) return sendFile(req, res, file, f[1]); }
    res.statusCode = 404; return res.end('not here');
  }
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
    return json({ response: { numFound: docs.length, start: 0, docs: page === 1 ? docs.map(({ file, formats, ...d }) => ({ ...d, format: formats.map((f) => f[1]) })) : [] } });
  }
  { const m = /^\/metadata\/(.+)$/.exec(p); if (m) { const b = books.find((x) => x.identifier === decodeURIComponent(m[1])); if (!b) { res.statusCode = 404; return res.end(); } return json({ metadata: { title: b.title, creator: b.creator, year: b.year, language: b.language, subject: b.subject, description: b.description, collection: b.collection, 'access-restricted-item': b.collection.includes('inlibrary') ? 'true' : undefined }, files: b.formats.map(([name, format, source]) => ({ name, format, source: source || 'original', size: volumes[name] ? String(volumes[name].length) : name.includes('sample') ? '900' : '2345678' })) }); } }
  { const m = /^\/download\/([^/]+)\/(.+)$/.exec(p); if (m) { const vol = volumes[decodeURIComponent(m[2])]; if (vol) { res.setHeader('Content-Type', 'application/pdf'); return res.end(vol); } const b = books.find((x) => x.identifier === decodeURIComponent(m[1])); const f = b && b.file ? path.join(dir, b.file) : null; if (!f || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', 'application/epub+zip'); return fs.createReadStream(f).pipe(res); } }
  if (/^\/services\/img\//.test(p)) { res.setHeader('Content-Type', 'image/png'); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')); }
  res.statusCode = 404; res.end('nope');
});
const makeCover = async () => {
  const JSZip = require(path.join(__dirname, '../../node_modules/jszip'));
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, 'maqamat-al-hariri.epub')));
  fs.writeFileSync(path.join(require('os').tmpdir(), 'kr-beta-cover.jpg'), await zip.file('OEBPS/cover.jpg').async('nodebuffer'));
};
Promise.all([makeVolumes(), makeCover()]).then(() => server.listen(port, () => console.log('sources test server on', port)));
