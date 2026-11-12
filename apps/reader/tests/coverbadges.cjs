// node tests/coverbadges.cjs: a made cover (a book without a picture of its own) keeps its title clear of the marks on
// the cover's top — the format, «New», the favourite's heart, the «read» mark wherever it is set — in English (left to
// right) and Arabic (right to left), on a computer's window and a phone's, with small and large cards. Measured: the
// rectangles of the title's lines against each mark's.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-covers-'));
const SHOTS = process.env.KR_COVER_SHOTS ? path.resolve(process.env.KR_COVER_SHOTS) : null;

async function makeEpub(file, id, title, lang) {
  const JSZip = require('jszip'); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/c1.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"><head><title>1</title></head><body><p>${title}</p></body></html>`);
  z.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">1</a></li></ol></nav></body></html>');
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${lang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const books = [[path.join(TMP, 'trial.epub'), 'kr-cov-1', 'A Book for Trial', 'en'], [path.join(TMP, 'ar.epub'), 'kr-cov-2', 'كتاب التجربة في القراءة', 'ar'], [path.join(TMP, 'fav.epub'), 'kr-cov-3', 'The Favourite Read Book of the Year', 'en']];
  for (const b of books) await makeEpub(...b);
  const br = await chromium.launch();
  for (const lang of ['en', 'ar']) for (const [w, h, mobile] of [[1366, 768, false], [412, 915, true]]) {
    const tag = `${lang} ${w}px`;
    const ctx = await br.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block', locale: lang });
    const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript((l) => { if (!sessionStorage.getItem('kr.cov')) { sessionStorage.setItem('kr.cov', '1'); localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); } }, lang);
    await p.goto(base + '#/'); await p.waitForSelector('.library-view');
    await p.setInputFiles('.library-view input[type=file]', books.map((b) => b[0]));
    for (let i = 0; i < 120 && (await p.$$('.book-card .cover .gen')).length < 3; i++) await p.waitForTimeout(250);
    // (The third: a favourite, read.)
    await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.getAll(); q.onsuccess = () => { for (const b of q.result) if (/Favourite/.test(b.title)) { b.tags = ['★']; b.done = true; st.put(b); } }; tx.oncomplete = res; }; }));
    for (const coverSize of ['small', 'large']) for (const doneMark of ['beside', 'below', 'topLeft']) {
      await p.evaluate((o) => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, o, { showDone: true, libraryView: 'cards', cardLook: 'comfortable' }); localStorage.setItem('kr.visual', JSON.stringify(v)); location.hash = '#/'; }, { coverSize, doneMark });
      await p.reload(); await p.waitForSelector('.book-card .cover .gen'); await p.waitForTimeout(400);
      const r = await p.evaluate(() => {
        const out = { covers: 0, marks: 0, hits: [] };
        for (const cover of document.querySelectorAll('.book-card .cover')) {
          const t = cover.querySelector('.gen .t'); if (!t || !t.textContent.trim()) continue; out.covers++;
          const rg = document.createRange(); rg.selectNodeContents(t);
          const lines = [...rg.getClientRects()].filter((x) => x.width > 1 && x.height > 1);
          const box = cover.getBoundingClientRect();
          const visibleLines = lines.filter((l) => l.bottom <= box.bottom && l.top >= box.top);
          const marks = [...cover.querySelectorAll('.badge')].map((b) => b.getBoundingClientRect()).filter((x) => x.width > 0);
          out.marks += marks.length;
          for (const l of visibleLines) for (const m of marks) if (l.left < m.right - 0.5 && l.right > m.left + 0.5 && l.top < m.bottom - 0.5 && l.bottom > m.top + 0.5) out.hits.push({ title: t.textContent.slice(0, 20), line: [l.left, l.top, l.right, l.bottom].map(Math.round), mark: [m.left, m.top, m.right, m.bottom].map(Math.round) });
          if (!visibleLines.length) out.hits.push({ title: t.textContent.slice(0, 20), why: 'no line of the title shows' });
        }
        return out;
      });
      ok(`${tag} ${coverSize} cards, «read» mark ${doneMark}: the title clear of the marks (${r.covers} covers, ${r.marks} marks)`, r.covers >= 3 && r.marks >= 4 && !r.hits.length, r.hits);
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `${lang}-${w}-${coverSize}-${doneMark}.png`) }); }
    }
    ok(`${tag}: no page errors`, !errors.length, errors);
    await ctx.close();
  }
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
