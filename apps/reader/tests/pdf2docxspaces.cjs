// node tests/pdf2docxspaces.cjs: PDF → Word keeps the spaces between words — where the page draws them and only
// there. A made-up Arabic book (pdf-lib), set in a small font built here (each letter a box, three space glyphs: a
// common one, a narrow one and one of no width, all named " " by the PDF's /ToUnicode, as Word's are):
// 1. A designed page (four boxes of text scattered over it, each a frame in Word) whose words are parted by a
//    narrow drawn space (0.15 em, narrower than a gap alone counts as a space): the boxes keep their words apart.
//    (The drawn spaces were left out of the boxes' lines, and every word of every box ran together.)
// 2. A line whose spaces are of no width, each drawn a hair inside the word before it, the next word set apart by
//    a gap of its own (a writer that moves each word along itself): «سلام علي من» — the space was taken for one
//    buried in the word. The word «علي» drawn in two pieces, «عل» and «ي», a space of no width where they touch
//    and another at the outer edge of «ي»: still one word, and the space after it, not inside it.
// 3. A word and the comma after it, touching, with a sliver of a drawn space between them (0.2 pt), as Word draws
//    them: «سلام،» — no space before the comma; a closing quote likewise: «علي»».
// (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const JSZip = require('jszip'); const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const PORT = 5195;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-spaces-'));

// ---- The font: a box per letter, three spaces, its Unicode map (cmap) and what /ToUnicode calls each glyph. ----
const G = []; // { name, adv, box?: [x0,y0,x1,y1], uni?: number, tu?: string }
const add = (g) => (G.push(g), G.length - 1);
add({ name: '.notdef', adv: 500 });
const SPACE = add({ name: 'space', adv: 250, uni: 0x20, tu: ' ' });
const NARROW = add({ name: 'space.narrow', adv: 150, tu: ' ' });
const NOWIDTH = add({ name: 'space.zero', adv: 0, tu: ' ' });
const SLIVER = add({ name: 'space.sliver', adv: 10, tu: ' ' });
const L = {};
'ابتجدرسعلمنهوي'.split('').forEach((ch, i) => { L[ch] = add({ name: 'l' + i, adv: 500, box: [30, 0, 470, 500 + i * 10], uni: ch.codePointAt(0), tu: ch }); });
L['،'] = add({ name: 'comma', adv: 250, box: [40, -50, 210, 200], uni: 0x60c, tu: '،' });
L['»'] = add({ name: 'quote', adv: 400, box: [40, 100, 360, 450], uni: 0xbb, tu: '»' });

function ttf() {
  const tables = {};
  const be = () => { const b = []; const w = { u8: (v) => (b.push(v & 255), w), u16: (v) => (b.push((v >> 8) & 255, v & 255), w), i16: (v) => w.u16(v & 0xffff), u32: (v) => (w.u16((v >>> 16) & 0xffff), w.u16(v & 0xffff)), tag: (s) => { for (const c of s) b.push(c.charCodeAt(0)); return w; }, bytes: (a) => { for (const x of a) b.push(x); return w; }, b }; return w; };
  const glyf = be(); const loca = [];
  for (const g of G) {
    loca.push(glyf.b.length);
    if (g.box) {
      const [x0, y0, x1, y1] = g.box;
      glyf.i16(1).i16(x0).i16(y0).i16(x1).i16(y1).u16(3).u16(0).u8(1).u8(1).u8(1).u8(1);
      const pts = [[x0, y0], [x0, y1], [x1, y1], [x1, y0]]; let px = 0, py = 0;
      for (const [x] of pts) { glyf.i16(x - px); px = x; } for (const [, y] of pts) { glyf.i16(y - py); py = y; }
    }
    while (glyf.b.length % 4) glyf.u8(0);
  }
  loca.push(glyf.b.length);
  tables.glyf = glyf.b; tables.loca = be(); for (const o of loca) tables.loca.u32(o); tables.loca = tables.loca.b;
  const all = G.filter((g) => g.box).map((g) => g.box);
  const bb = [Math.min(...all.map((b) => b[0])), Math.min(...all.map((b) => b[1])), Math.max(...all.map((b) => b[2])), Math.max(...all.map((b) => b[3]))];
  tables.head = be().u32(0x10000).u32(0x10000).u32(0).u32(0x5f0f3cf5).u16(0x000b).u16(1000).u32(0).u32(0).u32(0).u32(0).i16(bb[0]).i16(bb[1]).i16(bb[2]).i16(bb[3]).u16(0).u16(8).i16(2).i16(1).i16(0).b;
  tables.hhea = be().u32(0x10000).i16(900).i16(-300).i16(0).u16(1000).i16(bb[0]).i16(-300).i16(bb[2]).i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(G.length).b;
  tables.maxp = be().u32(0x10000).u16(G.length).u16(4).u16(1).u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).b;
  const hm = be(); for (const g of G) hm.u16(g.adv).i16(g.box ? g.box[0] : 0); tables.hmtx = hm.b;
  // cmap: format 4, one segment per character
  const cm = G.map((g, i) => [g.uni, i]).filter(([u]) => u !== undefined).sort((a, b) => a[0] - b[0]);
  const segs = [...cm.map(([u, g]) => [u, u, (g - u) & 0xffff]), [0xffff, 0xffff, 1]]; const n = segs.length;
  const sub = be().u16(4).u16(16 + n * 8).u16(0).u16(n * 2).u16(2 * 2 ** Math.floor(Math.log2(n))).u16(Math.floor(Math.log2(n))).u16(n * 2 - 2 * 2 ** Math.floor(Math.log2(n)));
  for (const s of segs) sub.u16(s[1]); sub.u16(0); for (const s of segs) sub.u16(s[0]); for (const s of segs) sub.u16(s[2]); for (const s of segs) sub.u16(0);
  tables.cmap = be().u16(0).u16(1).u16(3).u16(1).u32(12).bytes(sub.b).b;
  tables.post = be().u32(0x30000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0).b;
  const nm = (s) => { const w = be(); for (const c of s) w.u16(c.charCodeAt(0)); return w.b; };
  const names = [[1, 'KrTest Spaces'], [2, 'Regular'], [4, 'KrTest Spaces'], [6, 'KrTestSpaces']].map(([id, s]) => [id, nm(s)]);
  const name = be().u16(0).u16(names.length).u16(6 + names.length * 12); let off = 0;
  for (const [id, b] of names) { name.u16(3).u16(1).u16(0x409).u16(id).u16(b.length).u16(off); off += b.length; }
  for (const [, b] of names) name.bytes(b); tables.name = name.b;
  const os2 = be().u16(4).i16(500).u16(400).u16(5).u16(0).i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(250).i16(0);
  for (let i = 0; i < 10; i++) os2.u8(0);
  os2.u32(0x2003).u32(0).u32(0).u32(0).tag('KRTS').u16(0x40).u16(0x20).u16(0x6ff).i16(900).i16(-300).i16(0).u16(900).u16(300).u32(0x40).u32(0).i16(500).i16(700).u16(0).u16(0x20).u16(0);
  tables['OS/2'] = os2.b;
  const tags = Object.keys(tables).sort(); const out = be().u32(0x10000).u16(tags.length).u16(128).u16(3).u16(tags.length * 16 - 128);
  let at = 12 + tags.length * 16; const body = [];
  for (const t of tags) { const d = tables[t]; let sum = 0; for (let i = 0; i < d.length; i += 4) sum = (sum + ((d[i] << 24) | ((d[i + 1] || 0) << 16) | ((d[i + 2] || 0) << 8) | (d[i + 3] || 0))) >>> 0; out.tag(t).u32(sum).u32(at).u32(d.length); body.push(d); at += d.length; while (at % 4) { body.push([0]); at++; } }
  for (const d of body) out.bytes(d);
  return Uint8Array.from(out.b);
}

// ---- The PDF: the font as Word embeds it (Identity-H, its own /ToUnicode), one page per case. ----
const hex = (gids) => `<${gids.map((g) => g.toString(16).padStart(4, '0')).join('')}>`;
const u16hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
// A word's glyphs in drawing order (left to right: a right-to-left word turned round) and its width at size s.
const glyphs = (w) => [...w].reverse().map((c) => L[c]);
const width = (w, s) => [...w].reduce((t, c) => t + G[L[c]].adv, 0) * s / 1000;
async function book() {
  const doc = await PDFDocument.create(); const ctx = doc.context;
  const data = ttf();
  const file = ctx.register(ctx.flateStream(data, { Length1: data.length }));
  const desc = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+KrTestSpaces', Flags: 4, FontBBox: [-100, -300, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -300, CapHeight: 700, StemV: 80, FontFile2: file }));
  const cid = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'ABCDEF+KrTestSpaces', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, FontDescriptor: desc, DW: 500, W: [0, G.map((g) => g.adv)], CIDToGIDMap: 'Identity' }));
  const bf = G.map((g, i) => [i, g.tu]).filter(([, t]) => t !== undefined);
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${bf.length} beginbfchar\n${bf.map(([g, t]) => `<${g.toString(16).padStart(4, '0')}> <${u16hex(t)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
  const tu = ctx.register(ctx.flateStream(cmap));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+KrTestSpaces', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: tu }));
  const page = (ops) => { const p = doc.addPage([595, 842]); p.node.setFontDictionary(PDFName.of('F1'), font); p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(ops))); };
  const at = (s, x, y, gids) => `BT /F1 ${s} Tf 1 0 0 1 ${x.toFixed(2)} ${y} Tm ${hex(gids)} Tj ET\n`;
  // A line of words from its right edge, each word and the space after it drawn as one run (a narrow space).
  const narrowLine = (s, right, y, words) => {
    let x = right; let ops = '';
    words.forEach((w, i) => { x -= width(w, s); ops += at(s, x, y, glyphs(w)); if (i + 1 < words.length) { x -= G[NARROW].adv * s / 1000; ops += at(s, x, y, [NARROW]); } });
    return ops;
  };
  // 1. Four boxes, two lines of three words each, scattered over the page.
  const S1 = 14;
  page([[560, 700, ['سلام', 'علي', 'من']], [560, 680, ['رب', 'دار', 'نور']], [260, 690, ['جد', 'تين', 'هو']], [260, 670, ['يد', 'سر', 'عين']],
    [520, 400, ['باب', 'لين', 'مر']], [520, 380, ['تم', 'دم', 'ود']], [230, 410, ['نهر', 'بر', 'سد']], [230, 390, ['مع', 'ري', 'عود']]]
    .map(([r, y, ws]) => narrowLine(S1, r, y, ws)).join(''));
  // 2. "سلام علي من" (and a second line like it, a paragraph's): spaces of no width, each 0.2 pt inside the word
  //    before it (its left edge); the next word 4 pt (0.2 em) further on. «علي» in two touching pieces, «عل» and
  //    «ي», a space of no width where they meet.
  const S2 = 20; const gap = 4;
  const line2 = (y, w1, w2a, w2b, w3) => {
    let x = 500; let ops = '';
    x -= width(w1, S2); ops += at(S2, x, y, glyphs(w1)); ops += at(S2, x + 0.2, y, [NOWIDTH]);
    x -= gap + width(w2a, S2); ops += at(S2, x, y, glyphs(w2a));
    const xa = x; x -= width(w2b, S2); ops += at(S2, x, y, glyphs(w2b)); ops += at(S2, xa - 0.2, y, [NOWIDTH]); ops += at(S2, x + 0.2, y, [NOWIDTH]);
    x -= gap + width(w3, S2); ops += at(S2, x, y, glyphs(w3));
    return ops;
  };
  page(line2(700, 'سلام', 'عل', 'ي', 'من') + line2(670, 'نور', 'دا', 'ر', 'باب'));
  // 3. "سلام، علي» من": the comma and the quote touch the word before them, a 0.2 pt space drawn between; common
  //    spaces after them.
  {
    const y = 700; let x = 500; let ops = '';
    x -= width('سلام', S2); ops += at(S2, x, y, glyphs('سلام'));
    x -= G[SLIVER].adv * S2 / 1000; ops += at(S2, x, y, [SLIVER]); x -= width('،', S2); ops += at(S2, x, y, [L['،']]);
    x -= G[SPACE].adv * S2 / 1000; ops += at(S2, x, y, [SPACE]);
    x -= width('علي', S2); ops += at(S2, x, y, glyphs('علي'));
    x -= G[SLIVER].adv * S2 / 1000; ops += at(S2, x, y, [SLIVER]); x -= width('»', S2); ops += at(S2, x, y, [L['»']]);
    x -= G[SPACE].adv * S2 / 1000; ops += at(S2, x, y, [SPACE]);
    x -= width('من', S2); ops += at(S2, x, y, glyphs('من'));
    page(ops);
  }
  const f = path.join(tmp, 'p2d-spaces.pdf'); fs.writeFileSync(f, await doc.save()); return f;
}

async function convert(browser, file) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
  await page.goto(`http://127.0.0.1:${PORT}/`); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [file]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(300);
  const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
  if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
  await page.waitForSelector('.convert-target'); await page.click('.convert-target:has-text("Word")');
  await page.waitForSelector('.convert-result:not([hidden]) button', { timeout: 120000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.convert-result button:has-text("Save")')]);
  const out = path.join(tmp, path.basename(file, '.pdf') + '.docx'); await dl.saveAs(out); await ctx.close();
  return JSZip.loadAsync(fs.readFileSync(out));
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    const zip = await convert(browser, await book());
    const xml = await zip.file('word/document.xml').async('string');
    // Each page's paragraphs, a line break inside one read as a line of its own.
    const paras = (s) => [...s.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => [...p[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:br\/>/g)].map((x) => (x[1] === undefined ? '\n' : x[1])).join(''));
    const pages = xml.split(/<w:sectPr[ >]/).slice(0, -1).map((s) => paras(s).join('\n'));
    const framed = xml.split(/<w:sectPr[ >]/)[0].match(/<w:framePr /g)?.length ?? 0;
    const show = (s) => JSON.stringify(s);
    ok(`three pages, three sections (${pages.length})`, pages.length === 3);
    const p1 = pages[0] ?? '';
    ok(`1. the designed page's boxes are frames (${framed} framed paragraphs)`, framed >= 4);
    for (const t of ['سلام علي من', 'رب دار نور', 'جد تين هو', 'يد سر عين', 'باب لين مر', 'تم دم ود', 'نهر بر سد', 'مع ري عود'])
      ok(`1. a box keeps its words apart where the page draws a narrow space: "${t}" — ${show(p1)}`, p1.split('\n').some((l) => l.trim() === t));
    const p2 = pages[1] ?? '';
    ok(`2. a space of no width at a word's edge, the next word set apart, parts them: "سلام علي من" — ${show(p2)}`, p2.split('\n').some((l) => l.trim() === 'سلام علي من'));
    ok(`2. likewise on the next line: "نور دار باب" — ${show(p2)}`, p2.split('\n').some((l) => l.trim() === 'نور دار باب'));
    ok(`2. a word drawn in two touching pieces stays one word, its space after it: no "عل ي", no "ي من" glued — ${show(p2)}`, !/عل ي|دا ر|يمن|رباب/.test(p2));
    const p3 = pages[2] ?? '';
    ok(`3. a sliver of a space where a word and its comma or quote touch is no space: "سلام، علي» من" — ${show(p3)}`, p3.trim() === 'سلام، علي» من');
  } catch (e) { console.log('FAIL', e); fails++; }
  await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
