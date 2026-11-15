// node tests/textpicfmt.cjs: «Text as image» with «Use book formatting» (src/ui/textcard.ts styledBlocks / drawSet,
// src/views/reader.ts textImage) on an imitated phone (412×915):
//  1. offered for words picked in a book (the app's switch row: a name, a line under it, the switch), off at first: the picture is the plain text in the reader's face (one face,
//     no bold, the book's centred line not centred);
//  2. turned on: the picture is drawn as the book sets the words — its paragraphs apart, its centred line centred, its bold
//     and italic words bold and italic, the first-line indent kept, a justified line spread within a word space and 0.8 em;
//  3. the choice remembered (settings snapBookFormat): the sheet opened again starts with it on and draws so;
// Screenshot (deviceScaleFactor 2) of the sheet with the choice in KR_SHOTS when given.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const SHOTS = process.env.KR_SHOTS ? path.resolve(process.env.KR_SHOTS) : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-textpicfmt-'));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

async function makeEpub(file) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const filler = Array.from({ length: 8 }, (_, i) => `<p>[F${i}] The keeper climbed the stairs of the old tower at dusk and lit the lamp as his father had done.</p>`).join('');
  z.file('OEBPS/c1.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>t</title><link rel="stylesheet" type="text/css" href="s.css"/></head><body><h2>One</h2>${filler}<p class="pov">Mira</p><p id="pa">The lamps were lit before the <b>copper</b> boats came home, and the <i>harbour</i> bells rang twice over the grey water while the town slept on.</p><p id="pb">Nobody could say why they had rung at all, though everyone in the lantern room had an opinion of their own about it.</p>${filler}</body></html>`);
  z.file('OEBPS/s.css', 'p.pov { text-align: center; font-weight: bold; } p { text-align: justify; }');
  z.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav></body></html>');
  z.file('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-tpf</dc:identifier><dc:title>Copper Boats</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="s" href="s.css" media-type="text/css"/></manifest><spine><itemref idref="c1"/></spine></package>');
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const file = path.join(TMP, 'boats.epub'); await makeEpub(file);
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  // (Every word drawn on a canvas, with its face and place: what the picture holds.)
  await p.addInitScript(() => { window.__drawn = []; const f = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function (t, x, y, ...r) { if (this.canvas.width === 1080) window.__drawn.push({ t, x: Math.round(x), y: Math.round(y), font: this.font, align: this.textAlign }); return f.call(this, t, x, y, ...r); }; });
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', bookPage: 'never' })); });
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('.library-view input[type=file]', [file]);
  let id = null;
  for (let i = 0; i < 200 && !id; i++) { id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0]?.id ?? null); }; })); if (!id) { await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); await p.waitForTimeout(250); } }
  await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForSelector('.reader-flow .kr-content >> visible=true'); await p.waitForTimeout(1500);

  const open = async () => {
    await p.evaluate(() => {
      const c = document.querySelector('.reader-flow .kr-content'); const pov = [...c.querySelectorAll('p')].find((x) => x.textContent.trim() === 'Mira'); const pb = [...c.querySelectorAll('p')].find((x) => x.textContent.startsWith('Nobody'));
      pov.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.setStart(pov.firstChild, 0); r.setEnd(pb.lastChild, pb.lastChild.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r); window.__drawn = [];
    });
    await p.waitForTimeout(400); await p.evaluate(() => document.dispatchEvent(new Event('selectionchange'))); await p.waitForTimeout(500);
    await p.click('.sel-toolbar button:has-text("Text as image")'); await p.waitForSelector('.snap-preview'); await p.waitForTimeout(600);
  };
  const drawn = () => p.evaluate(() => window.__drawn.splice(0));
  const close = async () => { await p.click('.sheet .sheet-head button[aria-label="Close"]').catch(() => p.keyboard.press('Escape')); await p.waitForTimeout(400); await p.evaluate(() => getSelection().removeAllRanges()); await p.waitForTimeout(300); };

  await open();
  const box = await p.$('.snap-fmt-row input');
  const sw = await p.evaluate(() => { const r = document.querySelector('.snap-fmt-row'); return !!r && r.classList.contains('row') && !!r.querySelector('.switch i') && !!r.closest('.options-grid')?.querySelector(':scope > p.hint'); });
  ok('the choice is the app\'s switch row (name, hint, switch), not a bare checkbox', sw);
  const d0 = await drawn();
  const fonts0 = new Set(d0.map((x) => x.font));
  ok('offered, off at first; off: plain text — one face, no bold, nothing centred', !!box && !(await box.isChecked()) && fonts0.size === 1 && !d0.some((x) => /700|bold/.test(x.font)) && !d0.some((x) => x.align === 'center'), { box: !!box, fonts: [...fonts0], n: d0.length });
  await p.click('.snap-fmt-row .switch'); await p.waitForTimeout(700);
  const d1 = await drawn();
  const mira = d1.find((x) => x.t === 'Mira'), copper = d1.find((x) => x.t.startsWith('copper')), harbour = d1.find((x) => x.t.startsWith('harbour'));
  const firstOf = (w) => d1.find((x) => x.t === w);
  const lamps = firstOf('The'), nobody = firstOf('Nobody');
  // (The left edge of the text: the smallest x of the words drawn not in the first lines of a paragraph.)
  const leftEdge = Math.min(...d1.map((x) => x.x));
  ok('on: the centred line centred (its middle at the canvas\'s), bold; «copper» bold; «harbour» italic', !!mira && Math.abs(mira.x + 0 - 540) < 200 && mira.x > leftEdge + 100 && /700|bold/.test(mira.font) && copper && /700|bold/.test(copper.font) && harbour && /italic/.test(harbour.font), { mira, copper, harbour, leftEdge });
  ok('on: paragraphs apart, each first line indented', !!lamps && !!nobody && nobody.y > lamps.y && lamps.x > leftEdge + 10 && nobody.x > leftEdge + 10, { lamps, nobody, leftEdge });
  // A justified line: its words spread to the right edge (the widest right end among lines reaches the column's end).
  const lines = new Map(); for (const x of d1) { const a = lines.get(x.y) ?? []; a.push(x); lines.set(x.y, a); }
  const rows = [...lines.values()].filter((a) => a.length > 3);
  const gapsOk = await p.evaluate((rows) => { const c = document.createElement('canvas').getContext('2d'); let worst = 0; for (const r of rows) { r.sort((a, b) => a.x - b.x); for (let i = 1; i < r.length; i++) { c.font = r[i - 1].font; const w = c.measureText(r[i - 1].t).width; const size = parseFloat(/(\d+)px/.exec(r[i - 1].font)[1]); worst = Math.max(worst, (r[i].x - r[i - 1].x - w) / size); } } return worst; }, rows);
  ok('on: no gap between words wider than a word space and 0.8 em', gapsOk > 0 && gapsOk <= 0.8 + 0.35, gapsOk);
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'text-to-picture-choice.png') });
  await close();
  const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual')).snapBookFormat);
  await open();
  const box2 = await p.$('.snap-fmt-row input'); const d2 = await drawn();
  ok('remembered: stored, and the sheet opened again starts with it on and draws so', stored === true && !!box2 && await box2.isChecked() && d2.some((x) => x.t === 'Mira' && /700|bold/.test(x.font)), { stored });
  await p.click('.snap-fmt-row .switch'); await p.waitForTimeout(500);
  ok('turned off again: stored off', (await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual')).snapBookFormat)) === false);
  await close();
  ok('no page errors', errors.length === 0, errors);
  await br.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
