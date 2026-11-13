// node tests/pdfpassword.cjs: a password-protected PDF asks for its password in the app's own dialog
// (src/ui/dom.ts askPassword, src/formats/pdf.ts openDoc, src/pdfkeys.ts openPdfjs), not with window.prompt — which
// the desktop app (Electron) does not have: there it throws, as it is made to here. A wrong password asks again
// (saying it was wrong); the right one opens the file; Cancel or Escape closes the dialog cleanly (the file chosen is
// still added under its name, as it was before, and asks again when opened; no error is left on the page). The password is not written to the page's storage, the book's record or the console.
// The PDFs are made here with pdf-lib and encrypted (AES-256) with the app's own src/pdfcrypt.ts: no fixtures.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const SRC = path.resolve(__dirname, '../src');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-pdfpassword-'));
const SECRET = 'sesame-' + Math.random().toString(36).slice(2, 8);

async function makeProtected(file, title, text) {
  const esbuild = require('esbuild');
  const out = path.join(TMP, 'pdfcrypt.cjs');
  if (!fs.existsSync(out)) esbuild.buildSync({ entryPoints: [path.join(SRC, 'pdfcrypt.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error', nodePaths: [path.resolve(__dirname, '../node_modules')] });
  const { protectPdf, openPdf } = require(out);
  const { PDFDocument, StandardFonts } = require(path.resolve(__dirname, '../node_modules/pdf-lib'));
  const doc = await PDFDocument.create(); doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 500]); page.drawText(text, { x: 40, y: 440, size: 18, font });
  // (Saved and read back first, as the app's protect tool always works on a file it opened.)
  fs.writeFileSync(file, await protectPdf(await openPdf(await doc.save()), SECRET, SECRET + '-owner'));
}

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const dialog = (p) => p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].find((x) => x.querySelector('input[type=password]') && x.isConnected && x.getClientRects().length > 0); return s ? { hint: s.querySelector('.hint')?.textContent ?? '', wrong: !!s.querySelector('.hint.error'), title: s.querySelector('.sheet-head h3')?.textContent ?? '' } : null; });
/** The password dialog, once it is up (any other sheet the import shows first — where to put the book — passed). */
async function waitDialog(p, ms = 15000) {
  for (let i = 0; i < ms / 200; i++) {
    const d = await dialog(p); if (d) return d;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); if (s && !s.querySelector('input[type=password]')) s.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(200);
  }
  return null;
}

(async () => {
  const one = path.join(TMP, 'secret.pdf'); await makeProtected(one, 'Secret Paper', 'Behind a password.');
  const two = path.join(TMP, 'other.pdf'); await makeProtected(two, 'Other Paper', 'Another one, never opened.');

  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const br = await chromium.launch(); const errors = []; const logs = [];
  for (const lang of ['en', 'ar']) {
    const ctx = await br.newContext({ viewport: { width: 1000, height: 800 }, locale: lang });
    // As in the desktop app: window.prompt is not there.
    await ctx.addInitScript(() => { window.prompt = () => { throw new Error('prompt() is and will not be supported.'); }; });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => logs.push(m.text()));
    let native = 0; p.on('dialog', (d) => { native++; void d.dismiss(); });
    await p.goto(`http://127.0.0.1:${port}/`);
    await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, lang);
    await p.reload(); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);

    // Wrong, then right.
    await p.setInputFiles('.library-view input[type=file]', [one]);
    let d = await waitDialog(p);
    ok(`${lang}: the app's own password dialog opens`, !!d, d);
    if (d) {
      ok(`${lang}: … titled, and saying the file is protected (not "wrong")`, !!d.title && !d.wrong, d);
      await p.fill('.sheet input[type=password]', 'not-it'); await p.click('.sheet .sheet-actions .btn.primary');
      await p.waitForTimeout(800); d = await waitDialog(p);
      ok(`${lang}: a wrong password asks again, saying it was wrong`, !!d && d.wrong, d);
      if (d) { await p.fill('.sheet input[type=password]', SECRET); await p.keyboard.press('Enter'); }
    }
    let bk = null; for (let i = 0; i < 60 && !bk; i++) { bk = (await allBooks(p)).find((b) => b.title === 'Secret Paper') ?? null; if (!bk) await p.waitForTimeout(250); }
    ok(`${lang}: the right password opens it (imported, with its page count)`, !!bk && bk.pageCount === 1, bk && { title: bk.title, pages: bk.pageCount });
    ok(`${lang}: the dialog is gone`, !(await dialog(p)) && !(await p.$('.sheet-scrim')));
    if (bk) {
      await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id);
      await p.waitForSelector('.pdf-page', { timeout: 30000 }).catch(() => null); await p.waitForTimeout(800);
      ok(`${lang}: … and it opens in the reader`, !!(await p.$('.pdf-page')));
      await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(500);
    }

    // Cancel.
    const before = (await allBooks(p)).length;
    await p.setInputFiles('.library-view input[type=file]', [two]);
    d = await waitDialog(p);
    ok(`${lang}: another protected file asks too`, !!d, d);
    if (d) {
      await p.click('.sheet .sheet-actions .btn.text'); await p.waitForTimeout(1500);
      // (Whatever the import shows after, dismissed.)
      ok(`${lang}: Cancel closes the dialog`, !(await dialog(p)));
      // (The file chosen is still added, as it was with the old prompt — under its file name, nothing read from it —
      // so that opening it later asks again.)
      const after = await allBooks(p); const other = after.find((b) => b.fileName === 'other.pdf');
      ok(`${lang}: … the file kept under its name, nothing read from it`, after.length === before + 1 && !!other && other.title === 'other' && !other.pageCount, after.map((b) => b.title));
      if (other) {
        await p.evaluate((id) => { location.hash = `#/read/${id}`; }, other.id);
        d = await waitDialog(p);
        ok(`${lang}: opening it asks again`, !!d, d);
        if (d) {
          await p.keyboard.press('Escape'); await p.waitForTimeout(1500);
          ok(`${lang}: Escape closes the dialog, and nothing is left over it`, !(await dialog(p)) && !(await p.$('.sheet-scrim')));
          ok(`${lang}: … no page drawn from it`, !(await p.$('.pdf-page canvas')));
        }
        await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
      }
    }
    // Converting a protected file (src/ui/convert.ts) asks in the same dialog — it called window.prompt, which threw
    // in the desktop app and left the conversion stuck.
    if (lang === 'en') {
      await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view .book-card', { state: 'visible' }); await p.waitForTimeout(400);
      const card = p.locator('.book-card', { hasText: 'other' }).first(); await card.dispatchEvent('contextmenu'); await p.waitForSelector('.sel-actions', { state: 'visible' });
      const direct = await p.evaluate(() => { const b = [...document.querySelectorAll('.sel-actions button')].find((x) => /Convert/.test(x.textContent)); b?.click(); return !!b; });
      if (!direct) { await p.evaluate(() => { const bs = [...document.querySelectorAll('.sel-actions button')]; bs[bs.length - 1].click(); }); await p.waitForSelector('.sheet', { state: 'visible' }); await p.evaluate(() => { const b = [...document.querySelectorAll('.sheet button')].find((x) => /Convert/.test(x.textContent)); b?.click(); }); }
      await p.waitForSelector('.convert-target', { state: 'visible' }); await p.click('.convert-target >> nth=0');
      await p.waitForSelector('.sheet input[type=password]', { state: 'visible', timeout: 20000 }).catch(() => undefined);
      d = await dialog(p); ok(`${lang}: converting a protected file asks in the app's dialog`, !!d && !!d.title, d);
      if (d) { await p.fill('.sheet input[type=password]', SECRET); await p.keyboard.press('Enter'); await p.waitForSelector('.convert-result:not([hidden])', { state: 'visible', timeout: 60000 }).catch(() => undefined); ok(`${lang}: … and with the password it converts`, !!(await p.$('.convert-result:not([hidden])'))); }
      await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    }
    ok(`${lang}: no native prompt was used`, native === 0, native);
    const stored = await p.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))) + JSON.stringify(sessionStorage));
    const books = JSON.stringify(await allBooks(p));
    ok(`${lang}: the password is not in the page's storage nor in a book's record`, !stored.includes(SECRET) && !books.includes(SECRET));
    await ctx.close();
  }
  ok('the password is never written to the console', !logs.some((l) => l.includes(SECRET)));
  ok('no page errors', errors.length === 0, errors);
  await br.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
