// node tests/pdf2docxmem.cjs: PDF → Word holds a long book's text in pieces, never whole. A made-up book of 160
// pages (pdf-lib: a standard font, thirty-odd lines of text a page and the same small picture on every page) is
// converted in the app the way a user does it, while the page notes every string turned to UTF-8 (TextEncoder).
// word/document.xml is written section by section as the pages are put together: the longest string encoded must
// be a small part of it (a page's worth), not the whole document — the whole of a thousand-page book's text was
// one string of 130 MB, and each pass over it (the finishing pass, the encoder) another as big: the peak that
// a phone's WebView could not hold. Also: every page is there (a section each, in order), the package is whole,
// and the picture every page repeats is stored once. (Counted, not timed.)
// (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os'); const zlib = require('zlib');
const JSZip = require('jszip'); const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const PORT = 5199;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-mem-'));
const PAGES = 160;

// A small picture: 48×48, a coloured ring on white (opaque, so it is not taken for text).
function png() {
  const W = 48, H = 48; const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; for (let x = 0; x < W; x++) { const d = Math.hypot(x - 24, y - 24); const on = d > 12 && d < 20; const i = y * (W * 3 + 1) + 1 + x * 3; raw[i] = on ? 200 : 255; raw[i + 1] = on ? 60 : 255; raw[i + 2] = on ? 40 : 255; } }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = ~0 >>> 0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const WORDS = 'the of and to in that was his he it with is for as had you not be her on at by which have or from this him but all she they were my are me one their so an said them we who would been will no when there if more out up into do any your what has man could other than our some very time upon about may its only now like little then can should made did us such a great before must two these see know over much down after first mister good men own never most old shall day where those came come himself way work life without go make well through being long say might how am too even def under years think'.split(' ');
async function book() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica); const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pic = await doc.embedPng(png());
  let k = 0;
  for (let p = 0; p < PAGES; p++) {
    const pg = doc.addPage([595, 842]);
    pg.drawText(`Chapter ${p + 1}`, { x: 60, y: 780, size: 18, font: bold });
    pg.drawImage(pic, { x: 500, y: 760, width: 36, height: 36 });
    for (let y = 740; y > 90; y -= 19) {
      let line = y === 721 ? `Marker ${p + 1} of the book` : ''; while (line.length < 78) line += (line ? ' ' : '') + WORDS[(k++ * 7) % WORDS.length];
      pg.drawText(line, { x: 60, y, size: 11, font, color: rgb(0, 0, 0) });
    }
    pg.drawText(String(p + 1), { x: 292, y: 50, size: 10, font });
  }
  const f = path.join(tmp, 'p2d-mem.pdf'); fs.writeFileSync(f, await doc.save()); return f;
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    const file = await book();
    const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage(); page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
    // Every string the page turns to UTF-8, by its length: the longest, and how many characters in all.
    await page.addInitScript(() => {
      const enc = TextEncoder.prototype.encode; const note = { max: 0, total: 0 }; globalThis.krEncoded = note;
      TextEncoder.prototype.encode = function (s) { const n = s === undefined ? 0 : String(s).length; note.total += n; if (n > note.max) note.max = n; return enc.call(this, s); };
    });
    await page.goto(`http://127.0.0.1:${PORT}/`); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
    await page.setInputFiles('input[type=file]', [file]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(300);
    const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
    if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
    await page.waitForSelector('.convert-target');
    await page.evaluate(() => { globalThis.krEncoded.max = 0; globalThis.krEncoded.total = 0; });
    await page.click('.convert-target:has-text("Word")');
    await page.waitForSelector('.convert-result:not([hidden]) button, .sheet .src:has-text("failed")', { timeout: 300000 });
    const enc = await page.evaluate(() => ({ ...globalThis.krEncoded }));
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.convert-result button:has-text("Save")')]);
    const out = path.join(tmp, 'p2d-mem.docx'); await dl.saveAs(out);
    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    const xml = await zip.file('word/document.xml').async('string');
    const sections = (xml.match(/<w:sectPr>/g) || []).length;
    ok(`every page there, a section each (${sections} of ${PAGES})`, sections === PAGES);
    const heads = [...xml.replace(/<w:tab\/>/g, ' ').replace(/<[^>]+>/g, '').matchAll(/Marker\s*(\d+)/g)].map((m) => +m[1]);
    ok(`the pages in order (${heads.length}: ${heads.slice(0, 6).join(' ')} …)`, heads.length === PAGES && heads.every((n, i) => n === i + 1));
    ok(`the document as UTF-8 (${enc.total} characters encoded, ${xml.length} in document.xml)`, enc.total >= xml.length);
    ok(`its text never one string: the longest encoded ${enc.max} characters, ${(100 * enc.max / xml.length).toFixed(1)}% of document.xml (at most 5%)`, enc.max > 0 && enc.max <= xml.length * 0.05);
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'));
    ok(`the picture every page repeats stored once (${media.length})`, media.length === 1);
    // The package: every part well-formed XML, every relationship's target there.
    let bad = 0;
    for (const n of Object.keys(zip.files).filter((n) => /\.(xml|rels)$/.test(n))) { const x = await zip.file(n).async('string'); if (!/^<\?xml[^>]*\?>\s*<[\w:]+[\s>]/.test(x) || (x.match(/</g) || []).length !== (x.match(/>/g) || []).length) bad++; }
    const rels = await zip.file('word/_rels/document.xml.rels').async('string');
    for (const m of rels.matchAll(/Target="([^"]+)"/g)) if (!zip.file('word/' + m[1])) bad++;
    ok(`the package whole (${bad} problems)`, bad === 0);
    await ctx.close();
  } catch (e) { console.log('FAIL', e); fails++; }
  await browser.close(); server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
