// node tests/pdf2docxrunstate.cjs: PDF → Word gives each page the same text however long the run before it, and
// whichever way the pages are read. A made-up book (pdf-lib, nothing from tests/fixtures):
// - a cover drawn over the whole page with no text, then a blank page: a section each, no text (a picture or nothing);
// - 28 text pages in three standard fonts used over and over (one font met on page 3 is used again on page 30),
//   every fifth one on a coloured background with a frame (graphics over most of the page — the route that turns
//   a page's drawing into one page-sized picture): every page's text stays text, in its own section, never only a
//   picture;
// - pages 15 and 30 converted alone give exactly the text they get at the end of the whole book;
// - the whole book read on one pdf.js document, on two (krTwoWorkers) and in lanes (krLanes=2) gives the same text
//   in every section (the paths a computer with more cores takes).
// (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const JSZip = require('jszip'); const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const PORT = 5196;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-run-'));
const N = 30;
const WORDS = 'the light cause is a moving letter followed by a still one while the heavy cause is two moving letters and the joined peg is two moving letters and a still one'.split(' ');

async function book() {
  const doc = await PDFDocument.create();
  const fonts = [await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.TimesRoman), await doc.embedFont(StandardFonts.Courier)];
  // 1: a cover, all drawing.
  const cover = doc.addPage([420, 595]);
  cover.drawRectangle({ x: 0, y: 0, width: 420, height: 595, color: rgb(0.1, 0.25, 0.55) });
  for (let k = 0; k < 6; k++) cover.drawRectangle({ x: 20 + k * 8, y: 20 + k * 8, width: 380 - k * 16, height: 555 - k * 16, borderColor: rgb(0.9, 0.8, 0.3), borderWidth: 2 });
  cover.drawEllipse({ x: 210, y: 300, xScale: 120, yScale: 160, color: rgb(0.95, 0.9, 0.7) });
  // 2: blank.
  doc.addPage([420, 595]);
  const marks = {};
  for (let n = 3; n <= N; n++) {
    const pg = doc.addPage([420, 595]);
    if (n % 5 === 0) {
      pg.drawRectangle({ x: 0, y: 0, width: 420, height: 595, color: rgb(0.96, 0.92, 0.82) });
      pg.drawRectangle({ x: 24, y: 24, width: 372, height: 547, borderColor: rgb(0.5, 0.2, 0.1), borderWidth: 3 });
    }
    const font = fonts[n % 3];
    const mark = `Marker ${n} ${['alpha', 'beta', 'gamma', 'delta'][n % 4]}`; marks[n] = mark;
    pg.drawText(`Chapter ${n}`, { x: 48, y: 500, size: 15, font });
    // (The marker mid-page, in the body: a short line at the top of a page reads as a running head.)
    for (let i = 0; i < 18; i++) {
      const line = (i === 8 ? `${mark} ` : '') + Array.from({ length: i === 8 ? 6 : 9 }, (_, j) => WORDS[(n * 7 + i * 9 + j) % WORDS.length]).join(' ');
      pg.drawText(line, { x: 48, y: 470 - i * 22, size: 11, font });
    }
  }
  const whole = path.join(tmp, 'runstate-book.pdf'); fs.writeFileSync(whole, await doc.save());
  const alone = async (n) => { const one = await PDFDocument.create(); const [p] = await one.copyPages(doc, [n - 1]); one.addPage(p); const f = path.join(tmp, `runstate-p${n}.pdf`); fs.writeFileSync(f, await one.save()); return f; };
  return { whole, p15: await alone(15), p30: await alone(30), marks };
}

async function convert(browser, file, flags = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
  await page.addInitScript((f) => { if (f.lanes !== undefined) globalThis.krLanes = f.lanes; if (f.two) globalThis.krTwoWorkers = true; }, flags);
  await page.goto(`http://127.0.0.1:${PORT}/`); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [file]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(300);
  const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
  if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
  await page.waitForSelector('.convert-target'); await page.click('.convert-target:has-text("Word")');
  await page.waitForSelector('.convert-result:not([hidden]) button', { timeout: 180000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.convert-result button:has-text("Save")')]);
  const out = path.join(tmp, `${path.basename(file, '.pdf')}-${Object.keys(flags).join('') || 'plain'}.docx`); await dl.saveAs(out); await ctx.close();
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const xml = await zip.file('word/document.xml').async('string');
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  const parts = {}; for (const f of Object.keys(zip.files)) if (/^word\/(header|footer)\d*\.xml$/.test(f)) parts[f.slice(5)] = await zip.file(f).async('string');
  // Each section: its body text (spaces dropped: compared as letters) and whether a header or footer holds a picture.
  const secs = xml.split(/<w:sectPr[ >]/).slice(0, -1);
  const tails = xml.split(/<w:sectPr[ >]/).slice(1);
  return secs.map((s, i) => {
    const body = s.replace(/^[\s\S]*?<\/w:sectPr>/, '');
    const text = [...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').replace(/\s+/g, '');
    const ids = [...tails[i].split('</w:sectPr>')[0].matchAll(/<w:(?:header|footer)Reference [^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
    const pic = ids.some((id) => { const t = new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]+)"[^>]*Id="${id}"`).exec(rels)?.[1]; return !!t && (parts[t] ?? '').includes('<a:blip'); });
    return { text, pic };
  });
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    const b = await book();
    const plain = await convert(browser, b.whole, { lanes: 0 });
    ok(`a section per page (${plain.length} for ${N})`, plain.length === N);
    ok('the cover and the blank page carry no text', plain[0]?.text === '' && plain[1]?.text === '');
    ok('the cover keeps its drawing (a picture)', !!plain[0]?.pic);
    const want = (n) => b.marks[n].replace(/\s+/g, '');
    const lost = []; for (let n = 3; n <= N; n++) { const s = plain[n - 1]; if (!s || !s.text.includes(want(n)) || s.text.length < 400) lost.push(n); }
    ok(`every text page keeps its text in its own section${lost.length ? ` (lost: ${lost.join(', ')})` : ''}`, !lost.length);
    const bg = []; for (let n = 5; n <= N; n += 5) if (!(plain[n - 1]?.pic && plain[n - 1].text.length >= 400)) bg.push(n);
    ok(`pages on a full-page background keep both the background picture and their text${bg.length ? ` (not: ${bg.join(', ')})` : ''}`, !bg.length);
    for (const [n, f] of [[15, b.p15], [30, b.p30]]) {
      const one = await convert(browser, f, { lanes: 0 });
      ok(`page ${n} alone gives the text it gets at the end of the book (${one[0]?.text.length} / ${plain[n - 1]?.text.length} letters)`, one.length === 1 && !!one[0].text && one[0].text === plain[n - 1]?.text);
    }
    for (const flags of [{ lanes: 0, two: true }, { lanes: 2 }]) {
      const other = await convert(browser, b.whole, flags);
      const diff = other.map((s, i) => (s.text === plain[i]?.text ? 0 : i + 1)).filter(Boolean);
      ok(`read ${flags.two ? 'on two pdf.js documents' : 'in two lanes'}: the same text in every section${diff.length ? ` (differs: ${diff.join(', ')})` : ''}`, other.length === plain.length && !diff.length);
    }
  } catch (e) { console.log('FAIL', e); fails++; }
  await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
