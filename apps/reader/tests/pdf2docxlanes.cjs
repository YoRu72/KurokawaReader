// node tests/pdf2docxlanes.cjs: PDF → Word never waits on lanes that cannot answer (Windows' WebView2 under the
// Tauri shell, R1: two lanes started and said nothing; the conversion waited for ever). A made-up book of 10 pages
// (pdf-lib) converted in two lanes (krLanes = 2) while the lanes are made to fail in each way seen or feared:
// - lanes that never say anything (their script loads, then silence): given up after the bounded wait (20 s by
//   default), the pages read on the app's thread, the same text as without lanes, and the reason in the console;
// - lanes whose own pdf.js worker cannot start (the worker inside the worker gets a 404): the lane says so at once
//   and the pages are read on the app's thread — no 20 s wait;
// - lanes that work: no giving up, the same text.
// (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const JSZip = require('jszip'); const { PDFDocument, StandardFonts } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const PORT = 5197;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u.startsWith('/missing/')) { res.statusCode = 404; res.end('no'); return; }
  let f = path.join(DIST, u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res);
});
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-lanes-'));
const N = 10;

async function book() {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= N; n++) { const pg = doc.addPage([420, 595]); pg.drawText(`Lane marker ${n} page`, { x: 48, y: 500, size: 15, font }); for (let i = 0; i < 6; i++) pg.drawText(`line ${i} of page ${n} with a few words in it`, { x: 48, y: 460 - i * 22, size: 11, font }); }
  const f = path.join(tmp, 'lanes-book.pdf'); fs.writeFileSync(f, await doc.save()); return f;
}

// How the lanes are made to fail, set before the page's scripts: the page's Worker wrapped so a lane
// (pdf2docxlane.js) is replaced by what the case wants.
function rig(mode, port) {
  const Native = globalThis.Worker; globalThis.krLanes = 2;
  globalThis.__laneStarts = 0;
  globalThis.Worker = function Worker(url, opts) {
    const s = String(url);
    if (/pdf2docxlane/.test(s) && mode !== 'real') {
      globalThis.__laneStarts++;
      const code = mode === 'silent'
        ? `import ${JSON.stringify(s)}; self.onmessage = () => {};` // (loads the lane's code: its own handler replaced by one that never answers)
        : `import ${JSON.stringify(s)}; const W = self.Worker; self.Worker = function (u, o) { return /pdf\\.worker/.test(String(u)) ? new W('http://127.0.0.1:${port}/missing/pdf.worker.min.mjs', o) : new W(u, o); };`;
      return new Native(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), { type: 'module' });
    }
    if (/pdf2docxlane/.test(s)) globalThis.__laneStarts++;
    return new Native(url, opts);
  };
  globalThis.Worker.prototype = Native.prototype;
}

async function convert(browser, file, mode) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
  const warns = []; page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warns.push(m.text()); });
  await page.addInitScript({ content: `(${rig})(${JSON.stringify(mode)}, ${PORT});` });
  await page.goto(`http://127.0.0.1:${PORT}/`); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [file]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(300);
  const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
  if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
  await page.waitForSelector('.convert-target');
  const t0 = Date.now(); await page.click('.convert-target:has-text("Word")');
  await page.waitForSelector('.convert-result:not([hidden]) button', { timeout: 90000 });
  const ms = Date.now() - t0;
  const starts = await page.evaluate(() => globalThis.__laneStarts);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.convert-result button:has-text("Save")')]);
  const out = path.join(tmp, `lanes-${mode}.docx`); await dl.saveAs(out); await ctx.close();
  const xml = await (await JSZip.loadAsync(fs.readFileSync(out))).file('word/document.xml').async('string');
  const text = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').replace(/\s+/g, '');
  const gaveUp = warns.find((w) => /lanes: reading on this thread/.test(w)) || '';
  return { ms, text, gaveUp, starts, warns };
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    const f = await book();
    // (The reference: read on the app's thread, no lanes.)
    const plainRig = await convertWith(browser, f, 0);
    const marks = Array.from({ length: N }, (_, i) => `Lanemarker${i + 1}page`);
    ok(`without lanes: every page's text (${plainRig.text.length} letters)`, marks.every((m) => plainRig.text.includes(m)));

    const silent = await convert(browser, f, 'silent');
    ok(`silent lanes: two started (${silent.starts})`, silent.starts === 2);
    ok(`silent lanes: given up, the pages read on the app's thread (${Math.round(silent.ms / 1000)} s)`, !!silent.gaveUp && silent.ms < 45000);
    ok(`silent lanes: the reason is said: ${silent.gaveUp.slice(0, 200)}`, /lanes silent 20 s before they were ready/.test(silent.gaveUp));
    ok('silent lanes: the same text as without lanes', silent.text === plainRig.text);

    const nested = await convert(browser, f, 'nested');
    ok(`pdf.js's worker in a lane cannot start: given up at once (${Math.round(nested.ms / 1000)} s)`, !!nested.gaveUp && nested.ms < 15000);
    ok(`pdf.js's worker in a lane cannot start: the reason is said: ${nested.gaveUp.slice(0, 200)}`, /pdf\.js's worker in a lane did not start/.test(nested.gaveUp));
    ok('pdf.js\'s worker in a lane cannot start: the same text as without lanes', nested.text === plainRig.text);

    const real = await convert(browser, f, 'real');
    ok(`working lanes: two started (${real.starts}), none given up${real.gaveUp ? ': ' + real.gaveUp : ''} (${Math.round(real.ms / 1000)} s)`, real.starts === 2 && !real.gaveUp);
    ok('working lanes: the same text as without lanes', real.text === plainRig.text);
  } catch (e) { console.log('FAIL', e); fails++; }
  await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();

async function convertWith(browser, f, lanes) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
  await page.addInitScript((n) => { globalThis.krLanes = n; }, lanes);
  await page.goto(`http://127.0.0.1:${PORT}/`); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [f]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(300);
  const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
  if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
  await page.waitForSelector('.convert-target'); await page.click('.convert-target:has-text("Word")');
  await page.waitForSelector('.convert-result:not([hidden]) button', { timeout: 90000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.convert-result button:has-text("Save")')]);
  const out = path.join(tmp, 'lanes-plain.docx'); await dl.saveAs(out); await ctx.close();
  const xml = await (await JSZip.loadAsync(fs.readFileSync(out))).file('word/document.xml').async('string');
  return { text: [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').replace(/\s+/g, '') };
}
