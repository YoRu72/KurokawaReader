// node tests/textmeta.cjs: a UTF-8 .txt / .md / .html book's title is read from the head of the file
// (src/formats/text.ts readMeta, src/formats/shared.ts decodeText). The head is cut at a byte count, which can fall
// inside a letter of two to four bytes (Arabic, Japanese, Chinese, Korean): that cut letter made the strict UTF-8
// decode fail, and the title came out as windows-1256 mojibake. Each book here is built so that the cut falls inside
// a letter; its title must come out as written, and its text (decoded whole) too. A genuinely windows-1256 file is
// still read as Arabic. (The books are made here: no fixtures.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-textmeta-'));

/** A file whose bytes `head + body…` are cut by the reader at `at` bytes inside a letter (padded with ASCII until so). */
function cutInside(head, unit, at) {
  for (let pad = 0; pad < 8; pad++) {
    let s = head + ' '.repeat(pad);
    while (Buffer.byteLength(s) < at + 400) s += unit;
    const b = Buffer.from(s, 'utf8');
    if (b[at] >= 0x80 && b[at] <= 0xbf) return b; // a continuation byte: the cut splits a letter
  }
  throw new Error('could not place the cut');
}
const BOOKS = [
  // [file, expected title, bytes]
  ['arabic.txt', 'كتاب الأدب العربي الحديث', (t) => cutInside(`${t}\n\n`, 'هذا نص عربي طويل للتجربة. ', 4000)],
  ['arabic.md', 'مقدمة في علم البلاغة', (t) => cutInside(`# ${t}\n\n`, 'هذا نص عربي في ملف ماركداون. ', 4000)],
  ['arabic.html', 'ديوان الشعر', (t) => cutInside(`<html><head><meta charset="utf-8"><title>${t}</title></head><body><p>`, 'شعر عربي فصيح. ', 20000)],
  ['japanese.txt', '吾輩は猫である', (t) => cutInside(`${t}\n\n`, '名前はまだ無い。どこで生れたかとんと見当がつかぬ。', 4000)],
  ['korean.md', '한국어 소설 제목', (t) => cutInside(`# ${t}\n\n`, '이것은 한국어 문장입니다. ', 4000)],
  ['chinese.html', '红楼梦', (t) => cutInside(`<html><head><title>${t}</title></head><body><p>`, '这是一个很长的中文句子。', 20000)],
];

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
async function importFile(p, file) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);
  const before = (await allBooks(p)).length;
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 120; i++) {
    const all = await allBooks(p); const b = all.find((x) => x.fileName === path.basename(file)); if (b && all.length > before) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file);
}

(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 1000, height: 800 }, locale: 'en' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous' })); });
  await p.reload(); await p.waitForSelector('.library-view');

  for (const [name, title, make] of BOOKS) {
    const file = path.join(TMP, name); const bytes = make(title); fs.writeFileSync(file, bytes);
    const bk = await importFile(p, file);
    ok(`${name}: the title as written, though the head is cut inside a letter`, bk.title === title, bk.title);
  }
  // The text itself is decoded whole: the Arabic .txt reads as Arabic in the reader.
  {
    const bk = (await allBooks(p)).find((b) => b.fileName === 'arabic.txt');
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id);
    await p.waitForSelector('.reader-flow .kr-content >> visible=true', { timeout: 30000 }); await p.waitForTimeout(600);
    const first = await p.evaluate(() => [...document.querySelectorAll('.reader-flow .kr-content')].find((e) => e.offsetParent)?.querySelector('p')?.textContent ?? '');
    ok('arabic.txt: the text reads as Arabic in the reader', first.trim() === 'كتاب الأدب العربي الحديث', first.slice(0, 80));
  }
  // A real windows-1256 file (not UTF-8) is still recognised as Arabic.
  {
    const file = path.join(TMP, 'legacy.txt');
    const win1256 = { 'ك': 0xdf, 'ت': 0xca, 'ا': 0xc7, 'ب': 0xc8, ' ': 0x20, 'ق': 0xde, 'د': 0xcf, 'ي': 0xed, 'م': 0xe3, 'و': 0xe6 };
    const enc = (s) => Buffer.from([...s].map((c) => win1256[c]));
    fs.writeFileSync(file, Buffer.concat([enc('كتاب قديم'), Buffer.from('\n\n'), ...Array.from({ length: 600 }, () => enc('كتاب قديم مكتوب '))]));
    const bk = await importFile(p, file);
    ok('a windows-1256 file: still read as Arabic', bk.title === 'كتاب قديم', bk.title);
  }
  ok('no page errors', errors.length === 0, errors);
  await br.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
