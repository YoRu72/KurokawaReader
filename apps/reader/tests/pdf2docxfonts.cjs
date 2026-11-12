// node tests/pdf2docxfonts.cjs: PDF → Word carries each font once, under one name, drawing what the page draws.
// A made-up book (pdf-lib) of two pages set in fonts built here, each glyph a box of its own size (so a glyph is
// known by its box):
// 1. "KrMerge": two subsets of one font (A B C, and B C D, numbered differently) — one embedded font, A–D each
//    drawn with its own box.
// 2. "KrTwin": two different fonts of one name (E F G drawn with other boxes in each) — kept apart: two names,
//    each line's letters drawn with its own font's boxes.
// 3. "KrSigns": two subsets of a sign font (a symbol map only, codes U+F041…), its codes kept as the page draws
//    them — merged, the signs still drawn (dropped, they showed as boxes Word could not fill).
// 4. "QCF_P001", "QCF_P002": Quran word fonts, the same codes for other words on each page — one font for both,
//    each word still drawn with its own glyph.
// And: every font a run, a paragraph mark or the defaults name is in the font table (with a character set and
// signature); no font is carried that no run uses; each carried font, unscrambled with its key, is a TrueType
// font whose name table names it as the table does.
// (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const JSZip = require('jszip'); const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const PORT = 5198;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-fonts-'));

// ---- A TrueType font: glyphs { adv, box?, uni? } (glyph 0 .notdef, 1 space), its name, its map (Unicode or
// symbol). ----
const be = () => { const b = []; const w = { u8: (v) => (b.push(v & 255), w), u16: (v) => (b.push((v >> 8) & 255, v & 255), w), i16: (v) => w.u16(v & 0xffff), u32: (v) => (w.u16((v >>> 16) & 0xffff), w.u16(v & 0xffff)), tag: (s) => { for (const c of s) b.push(c.charCodeAt(0)); return w; }, bytes: (a) => { for (const x of a) b.push(x); return w; }, b }; return w; };
function ttf(family, G, symbol = false) {
  const tables = {};
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
  const cm = G.map((g, i) => [g.uni, i]).filter(([u]) => u !== undefined).sort((a, b) => a[0] - b[0]);
  const segs = [...cm.map(([u, g]) => [u, u, (g - u) & 0xffff]), [0xffff, 0xffff, 1]]; const n = segs.length;
  const sub = be().u16(4).u16(16 + n * 8).u16(0).u16(n * 2).u16(2 * 2 ** Math.floor(Math.log2(n))).u16(Math.floor(Math.log2(n))).u16(n * 2 - 2 * 2 ** Math.floor(Math.log2(n)));
  for (const s of segs) sub.u16(s[1]); sub.u16(0); for (const s of segs) sub.u16(s[0]); for (const s of segs) sub.u16(s[2]); for (const s of segs) sub.u16(0);
  tables.cmap = be().u16(0).u16(1).u16(3).u16(symbol ? 0 : 1).u32(12).bytes(sub.b).b;
  tables.post = be().u32(0x30000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0).b;
  const nm = (s) => { const w = be(); for (const c of s) w.u16(c.charCodeAt(0)); return w.b; };
  const names = [[1, family], [2, 'Regular'], [4, family], [6, family.replace(/\s/g, '')]].map(([id, s]) => [id, nm(s)]);
  const name = be().u16(0).u16(names.length).u16(6 + names.length * 12); let off = 0;
  for (const [id, b] of names) { name.u16(3).u16(symbol ? 0 : 1).u16(0x409).u16(id).u16(b.length).u16(off); off += b.length; }
  for (const [, b] of names) name.bytes(b); tables.name = name.b;
  const os2 = be().u16(4).i16(500).u16(400).u16(5).u16(0).i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(250).i16(0);
  for (let i = 0; i < 10; i++) os2.u8(0);
  os2.u32(symbol ? 0 : 0x2003).u32(0).u32(0).u32(0).tag('KRTL').u16(0x40).u16(cm.length ? cm[0][0] : 0x20).u16(cm.length ? cm[cm.length - 1][0] : 0x20).i16(900).i16(-300).i16(0).u16(900).u16(300).u32(symbol ? 0x80000000 : 0x41).u32(0).i16(500).i16(700).u16(0).u16(0x20).u16(0);
  tables['OS/2'] = os2.b;
  const tags = Object.keys(tables).sort(); const out = be().u32(0x10000).u16(tags.length).u16(128).u16(3).u16(tags.length * 16 - 128);
  let at = 12 + tags.length * 16; const body = [];
  for (const t of tags) { const d = tables[t]; let sum = 0; for (let i = 0; i < d.length; i += 4) sum = (sum + ((d[i] << 24) | ((d[i + 1] || 0) << 16) | ((d[i + 2] || 0) << 8) | (d[i + 3] || 0))) >>> 0; out.tag(t).u32(sum).u32(at).u32(d.length); body.push(d); at += d.length; while (at % 4) { body.push([0]); at++; } }
  for (const d of body) out.bytes(d);
  return Uint8Array.from(out.b);
}

// ---- The fonts: each glyph's box is what tells it in the Word file. ----
// A font: { name (its subset tag + family), family, glyphs: [{ ch, box, uni? }], symbol? }; glyph i + 2 (0 .notdef,
// 1 space). `ch` is what the PDF's ToUnicode calls it.
const BOX = {
  A: [50, 0, 450, 700], B: [60, 0, 440, 650], C: [70, 0, 430, 600], D: [80, 0, 420, 550],
  E: [100, 0, 400, 710], F: [110, 0, 390, 690], G: [120, 0, 380, 670], // KrTwin, the first
  e: [20, -100, 480, 300], f: [30, -120, 470, 280], g: [40, -140, 460, 260], // KrTwin, the second: E F G
  s1: [50, 100, 950, 500], s2: [60, 120, 940, 520], s3: [70, 140, 930, 540], // KrSigns: U+F041 F042 F043
  w1: [10, 0, 1890, 800], w2: [20, 0, 1380, 820], w3: [30, 0, 1170, 840], // QCF_P001: \ufb51 \ufb52 \ufb53
  v1: [40, -50, 1560, 760], v2: [50, -60, 1250, 780], v3: [60, -70, 1940, 900], // QCF_P002: \ufb51 \ufb52 \ufb53
};
const adv = (box) => box[2] + 50;
const FONTS = [
  { key: 'M1', base: 'AAAAAA+KrMerge', family: 'KrMerge', glyphs: [['A', 'A'], ['B', 'B'], ['C', 'C']] },
  { key: 'M2', base: 'BBBBBB+KrMerge', family: 'KrMerge', glyphs: [['D', 'D'], ['C', 'C'], ['B', 'B']] },
  { key: 'T1', base: 'CCCCCC+KrTwin', family: 'KrTwin', glyphs: [['E', 'E'], ['F', 'F'], ['G', 'G']] },
  { key: 'T2', base: 'DDDDDD+KrTwin', family: 'KrTwin', glyphs: [['E', 'e'], ['F', 'f'], ['G', 'g']] },
  { key: 'S1', base: 'EEEEEE+KrSigns', family: 'KrSigns', symbol: true, glyphs: [['\uf041', 's1'], ['\uf042', 's2']] },
  { key: 'S2', base: 'FFFFFF+KrSigns', family: 'KrSigns', symbol: true, glyphs: [['\uf043', 's3'], ['\uf042', 's2']] },
  { key: 'Q1', base: 'GGGGGG+QCF_P001', family: 'QCF_P001', glyphs: [['\ufb51', 'w1'], ['\ufb52', 'w2'], ['\ufb53', 'w3']] },
  { key: 'Q2', base: 'HHHHHH+QCF_P002', family: 'QCF_P002', glyphs: [['\ufb51', 'v1'], ['\ufb52', 'v2'], ['\ufb53', 'v3']] },
];
for (const f of FONTS) {
  f.G = [{ adv: 500 }, { adv: 250, uni: 0x20 }, ...f.glyphs.map(([ch, b]) => ({ adv: adv(BOX[b]), box: BOX[b], uni: ch.codePointAt(0) }))];
  f.gid = Object.fromEntries(f.glyphs.map(([ch], i) => [ch, i + 2]));
}
const hex = (gids) => `<${gids.map((g) => g.toString(16).padStart(4, '0')).join('')}>`;
const u16hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
const S = 14;
const width = (f, w) => [...w].reduce((t, c) => t + f.G[f.gid[c]].adv, 0) * S / 1000;
const at = (f, x, y, w) => `BT /${f.key} ${S} Tf 1 0 0 1 ${x.toFixed(2)} ${y} Tm ${hex([...w].map((c) => f.gid[c]))} Tj ET\n`;
// Words left to right from x (or, rtl, right to left from x), 5 points apart.
const line = (f, x, y, words, rtl = false) => { let ops = ''; for (const w of words) { const wd = width(f, w); if (rtl) { x -= wd; ops += at(f, x, y, w); x -= 5; } else { ops += at(f, x, y, w); x += wd + 5; } } return ops; };
const BYF = Object.fromEntries(FONTS.map((f) => [f.key, f]));
// What each line sets: [font, words, rtl].
const PAGE1 = [['M1', ['ABC', 'CAB', 'BCA', 'ABC']], ['M2', ['BCD', 'DCB', 'CBD']], ['T1', ['EFG', 'GFE', 'EFG']], ['T2', ['GEF', 'FEG', 'GEF']], ['S1', ['\uf041\uf042', '\uf042\uf041']], ['S2', ['\uf043\uf042', '\uf042\uf043']]];
const PAGE2 = [['Q1', ['\ufb51', '\ufb52', '\ufb53'], true], ['Q2', ['\ufb51', '\ufb52', '\ufb53'], true], ['Q1', ['\ufb53', '\ufb51'], true], ['Q2', ['\ufb52', '\ufb53'], true]];
async function book() {
  const doc = await PDFDocument.create(); const ctx = doc.context;
  const objs = {};
  for (const f of FONTS) {
    const data = ttf(f.family, f.G, f.symbol);
    const file = ctx.register(ctx.flateStream(data, { Length1: data.length }));
    const desc = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: f.base, Flags: f.symbol ? 4 : 32, FontBBox: [-100, -300, 2000, 900], ItalicAngle: 0, Ascent: 900, Descent: -300, CapHeight: 700, StemV: 80, FontFile2: file }));
    const cid = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: f.base, CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, FontDescriptor: desc, DW: 500, W: [0, f.G.map((g) => g.adv)], CIDToGIDMap: 'Identity' }));
    const bf = [[1, ' '], ...f.glyphs.map(([ch], i) => [i + 2, ch])];
    const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${bf.length} beginbfchar\n${bf.map(([g, t]) => `<${g.toString(16).padStart(4, '0')}> <${u16hex(t)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
    const tu = ctx.register(ctx.flateStream(cmap));
    objs[f.key] = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: f.base, Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: tu }));
  }
  for (const [lines, rtl] of [[PAGE1, false], [PAGE2, true]]) {
    let ops = ''; let y = 780;
    for (const [k, words] of lines) { ops += line(BYF[k], rtl ? 540 : 60, y, words, rtl); y -= 24; }
    const pg = doc.addPage([595, 842]);
    const res = ctx.obj({}); for (const k of new Set(lines.map((l) => l[0]))) res.set(PDFName.of(k), objs[k]);
    pg.node.set(PDFName.of('Resources'), ctx.obj({ Font: res })); pg.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(ops)));
  }
  const f = path.join(tmp, 'p2d-fonts.pdf'); fs.writeFileSync(f, await doc.save()); return f;
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
  const out = path.join(tmp, path.basename(file, '.pdf') + '.docx'); await dl.saveAs(out);
  return { zip: await JSZip.loadAsync(fs.readFileSync(out)), page, ctx };
}

// ---- Reading a carried font: unscrambled with its key; its tables, its Windows map, its glyphs' boxes. ----
function unscramble(data, key) {
  const g = key.replace(/[{}-]/g, ''); const kb = []; for (let i = 0; i < 32; i += 2) kb.push(parseInt(g.slice(i, i + 2), 16)); kb.reverse();
  const b = Uint8Array.from(data); for (let i = 0; i < 32 && i < b.length; i++) b[i] ^= kb[i % 16]; return b;
}
function readFont(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); const t = {};
  for (let i = 0, n = dv.getUint16(4); i < n; i++) { const r = 12 + i * 16; t[String.fromCharCode(...b.subarray(r, r + 4))] = [dv.getUint32(r + 8), dv.getUint32(r + 12)]; }
  const cmap = new Map();
  if (t.cmap) {
    const c0 = t.cmap[0];
    for (let i = 0, n = dv.getUint16(c0 + 2); i < n; i++) {
      const p = dv.getUint16(c0 + 4 + i * 8); if (p !== 3) continue; const s = c0 + dv.getUint32(c0 + 8 + i * 8); if (dv.getUint16(s) !== 4) continue;
      const seg = dv.getUint16(s + 6) / 2, ends = s + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2;
      for (let k = 0; k < seg; k++) { const a = dv.getUint16(starts + k * 2), z = dv.getUint16(ends + k * 2), d = dv.getInt16(deltas + k * 2), ro = dv.getUint16(ranges + k * 2); if (a === 0xffff) continue; for (let c = a; c <= z; c++) { let gg; if (!ro) gg = (c + d) & 0xffff; else { gg = dv.getUint16(ranges + k * 2 + ro + (c - a) * 2); if (gg) gg = (gg + d) & 0xffff; } if (gg && !cmap.has(c)) cmap.set(c, gg); } }
    }
  }
  const long = t.head ? dv.getInt16(t.head[0] + 50) === 1 : false;
  const box = (g) => { if (!t.loca || !t.glyf) return null; const o = long ? dv.getUint32(t.loca[0] + g * 4) : dv.getUint16(t.loca[0] + g * 2) * 2; const o2 = long ? dv.getUint32(t.loca[0] + g * 4 + 4) : dv.getUint16(t.loca[0] + g * 2 + 2) * 2; if (o2 === o) return null; const at = t.glyf[0] + o; return [dv.getInt16(at + 2), dv.getInt16(at + 4), dv.getInt16(at + 6), dv.getInt16(at + 8)]; };
  let fam = null;
  if (t.name) { const n0 = t.name[0], cnt = dv.getUint16(n0 + 2), str = n0 + dv.getUint16(n0 + 4); for (let i = 0; i < cnt; i++) { const r = n0 + 6 + i * 12; if (dv.getUint16(r) === 3 && dv.getUint16(r + 6) === 1) { const len = dv.getUint16(r + 8), off = dv.getUint16(r + 10); let s = ''; for (let k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(str + off + k)); fam = s; } } }
  return { tag: dv.getUint32(0), tables: Object.keys(t), cmap, box, fam };
}
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const same = (a, b) => !!a && !!b && a.every((v, i) => v === b[i]);

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    const { zip, ctx } = await convert(browser, await book());
    const table = await zip.file('word/fontTable.xml').async('string');
    const trels = (await zip.file('word/_rels/fontTable.xml.rels')?.async('string')) ?? '';
    // The font table: each entry, its embedded faces read.
    const entries = new Map();
    for (const m of table.matchAll(/<w:font w:name="([^"]*)">([\s\S]*?)<\/w:font>/g)) {
      const e = { body: m[2], faces: {} };
      for (const em of m[2].matchAll(/<w:embed(\w+) r:id="([^"]+)" w:fontKey="([^"]+)"\/>/g)) {
        const target = (new RegExp(`Id="${em[2]}"[^>]*Target="([^"]+)"`).exec(trels) || [])[1];
        const data = target && zip.file('word/' + target) ? await zip.file('word/' + target).async('uint8array') : null;
        e.faces[em[1]] = data ? readFont(unscramble(data, em[3])) : null;
      }
      entries.set(unesc(m[1]), e);
    }
    // The runs: their font (the complex-script slot; all four name the same) and text, line by line.
    const parts = Object.keys(zip.files).filter((n) => /^word\/(document|header\d+|footer\d+|footnotes|styles)\.xml$/.test(n));
    const named = new Set(); const runs = [];
    for (const n of parts) {
      const x = await zip.file(n).async('string');
      for (const m of x.matchAll(/w:(?:ascii|hAnsi|cs|eastAsia)="([^"]*)"/g)) named.add(unesc(m[1]));
      if (n === 'word/document.xml') for (const p of x.split('</w:p>')) {
        const rs = [...p.matchAll(/<w:r>(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?([\s\S]*?)<\/w:r>/g)].map((m) => ({ font: unesc((/w:cs="([^"]*)"/.exec(m[1] || '') || [])[1] || ''), text: unesc([...m[2].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('')) })).filter((r) => r.text);
        if (rs.length) runs.push(rs);
      }
    }
    const glyphBox = (font, ch) => { const e = entries.get(font); const f = e && (e.faces.Regular || Object.values(e.faces)[0]); if (!f) return null; const g = f.cmap.get(ch.codePointAt(0)); return g ? f.box(g) : null; };
    // Every name used is declared; no carried font unused; each carried font sound.
    const undeclared = [...named].filter((n) => !entries.has(n));
    ok(`every font named in the document is in the font table ${JSON.stringify(undeclared)}`, !undeclared.length);
    ok('each entry has a character set and a signature', [...entries.values()].every((e) => /<w:charset w:val="[0-9A-F]{2}"\/>/.test(e.body) && /<w:sig /.test(e.body)));
    const carried = [...entries].filter(([, e]) => Object.keys(e.faces).length).map(([n]) => n);
    const unused = carried.filter((n) => !named.has(n));
    ok(`no font is carried that no run uses ${JSON.stringify(unused)}`, !unused.length);
    const unsound = [...entries].flatMap(([n, e]) => Object.entries(e.faces).filter(([, f]) => !f || f.tag !== 0x00010000 || !['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'OS/2', 'post'].every((t) => f.tables.includes(t)) || f.fam !== n).map(([face]) => `${n} ${face}`));
    ok(`each carried font unscrambles to a TrueType font with its tables, named as the table names it ${JSON.stringify(unsound)}`, !unsound.length);
    // 1. KrMerge: one font, A–D each its own box.
    const merge = [...entries.keys()].filter((n) => /^KrMerge/.test(n));
    ok(`KrMerge: one font (${JSON.stringify(merge)})`, merge.length === 1 && Object.keys(entries.get(merge[0]).faces).length === 1);
    ok('KrMerge: A B C D each drawn with its own glyph', ['A', 'B', 'C', 'D'].every((c) => same(glyphBox('KrMerge', c), BOX[c])));
    // Text lines and the glyphs their runs draw.
    // (Each font's line is a run of its own; lines one under another may share a paragraph.)
    const lineOf = (want) => { const r = runs.flat().find((x) => x.text.replace(/\s+/g, ' ').trim() === want); return r ? [r] : null; };
    const drawsAs = (rs, boxOf) => rs.every((r) => [...r.text].every((c) => c === ' ' || same(glyphBox(r.font, c), boxOf(c))));
    const l1 = lineOf('ABC CAB BCA ABC'), l2 = lineOf('BCD DCB CBD');
    ok('KrMerge: both subsets\' lines there, in one font, each letter its own glyph', !!l1 && !!l2 && [...l1, ...l2].every((r) => r.font === 'KrMerge') && drawsAs([...l1, ...l2], (c) => BOX[c]));
    // 2. KrTwin: two names, each line its own glyphs.
    const t1 = lineOf('EFG GFE EFG'), t2 = lineOf('GEF FEG GEF');
    const twins = [...entries.keys()].filter((n) => /^KrTwin/.test(n));
    ok(`KrTwin: two fonts of one name stay two (${JSON.stringify(twins)}; lines in ${JSON.stringify([t1?.map((r) => r.font), t2?.map((r) => r.font)])})`, twins.length === 2 && !!t1 && !!t2 && t1[0].font !== t2[0].font);
    ok('KrTwin: each line drawn with its own font\'s glyphs', !!t1 && !!t2 && drawsAs(t1, (c) => BOX[c]) && drawsAs(t2, (c) => BOX[c.toLowerCase()]));
    // 3. KrSigns: the codes kept, each drawn.
    const signRuns = runs.flat().filter((r) => /[\uf041-\uf043]/.test(r.text));
    const signBox = { '\uf041': BOX.s1, '\uf042': BOX.s2, '\uf043': BOX.s3 };
    ok(`KrSigns: the signs kept as their codes (${signRuns.length} runs, in ${JSON.stringify([...new Set(signRuns.map((r) => r.font))])})`, signRuns.length > 0 && signRuns.map((r) => r.text).join('').replace(/\s/g, '').length === 8);
    ok('KrSigns: every sign drawn by the font carried (merged subsets keep their codes)', signRuns.length > 0 && drawsAs(signRuns, (c) => signBox[c]));
    // 4. Quran word fonts: one font, each word its own glyph, in the page's order.
    const qcf = [...entries.keys()].filter((n) => /^QCF/.test(n));
    ok(`QCF: the two page fonts are one (${JSON.stringify(qcf)})`, qcf.length === 1);
    const qRuns = runs.flat().filter((r) => /^QCF/.test(r.font));
    const qBoxes = qRuns.flatMap((r) => [...r.text].filter((c) => c !== ' ').map((c) => glyphBox(r.font, c)));
    const want = PAGE2.flatMap(([k, ws]) => ws.map((w) => BOX[BYF[k].glyphs.find(([ch]) => ch === w)[1]]));
    ok(`QCF: each word drawn with its own page's glyph, in the page's order (${qBoxes.length} words)`, qBoxes.length === want.length && want.every((b, k) => same(qBoxes[k], b)));
    ok('QCF: the words keep codes that read right to left (Arabic presentation forms)', qRuns.length > 0 && qRuns.every((r) => [...r.text].every((c) => c === ' ' || /[\ufb50-\ufdff\ufe70-\ufeff]/.test(c))));
    await ctx.close();
  } catch (e) { console.log('FAIL error', e); fails++; }
  await browser.close(); server.close();
  console.log(fails ? `${fails} failed` : 'all ok');
  process.exit(fails ? 1 : 0);
})();
