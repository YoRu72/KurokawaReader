// node tests/pdf2docxchars.cjs: PDF → Word keeps the page's characters — letters, harakat, digits — and the
// embedded font draws them. A made-up book (pdf-lib), set in a small Arabic font built here (composite ligatures
// of a letter-shape and a dot, as KFGQPC's are; a medial yeh glyph shared by ي and Persian ی, as Arial's is):
// 1. Word's map of a ligature with a haraka between its letters names the mark in the second letter's place
//    ("جُ" for the "جم" ligature drawn with a damma of its own): the letter comes back from the ligature built of
//    the same parts ("خم"), the damma is there once — "جُمله". A ligature no other one settles ("مّ" for "مي")
//    keeps the PDF's name, its shadda once, and the font carried in the document still draws a plain م for م.
// 2. Two harakat drawn one after the other in a colour of their own (Word's red marks, after a space): each goes
//    on the letter under it — "عَلَى", not both on one letter.
// 3. A fatha drawn from an origin below the baseline with its ink high above (a Kufi font's) stays a fatha; one
//    whose ink stands below the baseline is a kasra.
// 4. The PDF says ي for the medial glyph the font also reaches from ی: the text keeps ي.
// 5. A year drawn in two pieces ("144" and "3", touching) on a right-to-left line is stored thousands first.
// (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const JSZip = require('jszip'); const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const PORT = 5194;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-chars-'));

// ---- The font: glyphs, their Unicode map (cmap), and what the PDF's /ToUnicode will call them. ----
const G = []; // { name, adv, box?: [x0,y0,x1,y1], comps?: [[gid, dx, dy]], uni?: number, tu?: string }
const add = (g) => (G.push(g), G.length - 1);
add({ name: '.notdef', adv: 500 });
const SPACE = add({ name: 'space', adv: 250, uni: 0x20, tu: ' ' });
const L = {};
// (ه is left out of the font's own map, as a subset may leave a letter out: the font is then rebuilt from the
// page's glyphs for the document — the path where what the page's text says of each glyph is learnt.)
'ابتجحخدرسعلمنهوىي'.split('').forEach((ch, i) => { L[ch] = add({ name: ch, adv: 500, box: [40 + i * 3, 0, 440 - i * 4, 500 + i * 10], uni: ch === 'ه' ? undefined : ch.codePointAt(0), tu: ch }); });
// ی comes before ي in the font's rules (so the font's own first reading of the shared medial glyph is ی).
L['ی'] = add({ name: 'farsiyeh', adv: 500, box: [60, -200, 420, 300], uni: 0x6cc, tu: 'ی' });
const FATHA = add({ name: 'fatha', adv: 0, box: [-260, 700, -60, 780], uni: 0x64e, tu: ' ' }); // (Word maps its marks to a space)
const DAMMA = add({ name: 'damma', adv: 0, box: [-240, 690, -80, 840], uni: 0x64f, tu: ' ' });
const SHADDA = add({ name: 'shadda', adv: 0, box: [-280, 700, -40, 820], uni: 0x651, tu: ' ' });
const YEH_MEDI = add({ name: 'yeh.medi', adv: 300, box: [0, -220, 300, 260], tu: 'ي' });
const DOT = add({ name: 'dot', adv: 0, box: [0, 0, 110, 110] });
const SKEL = add({ name: 'skel', adv: 900, box: [20, -100, 880, 450] });
const LIG_JM = add({ name: 'jm', adv: 900, comps: [[SKEL, 0, 0], [DOT, 620, -260]], tu: 'جُ' }); // really "جم": Word's map
add({ name: 'khm', adv: 900, comps: [[SKEL, 0, 0], [DOT, 620, 560]], tu: 'خم' });
const SKEL2 = add({ name: 'skel2', adv: 800, box: [30, -150, 770, 420] });
const LIG_MY = add({ name: 'my', adv: 800, comps: [[SKEL2, 0, 0], [DOT, 120, -300]], tu: 'مّ' }); // really "مي"; nothing settles it
const ALA = add({ name: 'ala', adv: 1000, box: [10, -250, 990, 700], tu: 'على' });
const D = {}; '0123456789'.split('').forEach((d, i) => { D[d] = add({ name: 'd' + d, adv: 500, box: [50 + i * 5, 0, 450 - i * 5, 700], uni: d.charCodeAt(0), tu: d }); });

function ttf() {
  const tables = {};
  const be = () => { const b = []; const w = { u8: (v) => (b.push(v & 255), w), u16: (v) => (b.push((v >> 8) & 255, v & 255), w), i16: (v) => w.u16(v & 0xffff), u32: (v) => (w.u16((v >>> 16) & 0xffff), w.u16(v & 0xffff)), tag: (s) => { for (const c of s) b.push(c.charCodeAt(0)); return w; }, bytes: (a) => { for (const x of a) b.push(x); return w; }, b }; return w; };
  // glyf + loca (long offsets)
  const glyf = be(); const loca = [];
  const boxOf = (g) => g.box || (() => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [c, dx, dy] of g.comps) { const b = G[c].box; x0 = Math.min(x0, b[0] + dx); y0 = Math.min(y0, b[1] + dy); x1 = Math.max(x1, b[2] + dx); y1 = Math.max(y1, b[3] + dy); } return [x0, y0, x1, y1]; })();
  for (const g of G) {
    loca.push(glyf.b.length);
    if (g.box) {
      const [x0, y0, x1, y1] = g.box;
      glyf.i16(1).i16(x0).i16(y0).i16(x1).i16(y1).u16(3).u16(0).u8(1).u8(1).u8(1).u8(1);
      const pts = [[x0, y0], [x0, y1], [x1, y1], [x1, y0]]; let px = 0, py = 0;
      for (const [x] of pts) { glyf.i16(x - px); px = x; } for (const [, y] of pts) { glyf.i16(y - py); py = y; }
    } else if (g.comps) {
      const [x0, y0, x1, y1] = boxOf(g); glyf.i16(-1).i16(x0).i16(y0).i16(x1).i16(y1);
      g.comps.forEach(([c, dx, dy], k) => glyf.u16(0x1 | 0x2 | (k + 1 < g.comps.length ? 0x20 : 0)).u16(c).i16(dx).i16(dy));
    }
    while (glyf.b.length % 4) glyf.u8(0);
  }
  loca.push(glyf.b.length);
  tables.glyf = glyf.b; tables.loca = be(); for (const o of loca) tables.loca.u32(o); tables.loca = tables.loca.b;
  const all = G.filter((g) => g.box || g.comps).map(boxOf);
  const bb = [Math.min(...all.map((b) => b[0])), Math.min(...all.map((b) => b[1])), Math.max(...all.map((b) => b[2])), Math.max(...all.map((b) => b[3]))];
  tables.head = be().u32(0x10000).u32(0x10000).u32(0).u32(0x5f0f3cf5).u16(0x000b).u16(1000).u32(0).u32(0).u32(0).u32(0).i16(bb[0]).i16(bb[1]).i16(bb[2]).i16(bb[3]).u16(0).u16(8).i16(2).i16(1).i16(0).b;
  tables.hhea = be().u32(0x10000).i16(900).i16(-300).i16(0).u16(1000).i16(bb[0]).i16(-300).i16(bb[2]).i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(G.length).b;
  tables.maxp = be().u32(0x10000).u16(G.length).u16(8).u16(1).u16(8).u16(1).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(2).u16(1).b;
  const hm = be(); for (const g of G) { hm.u16(g.adv).i16(g.box ? g.box[0] : g.comps ? boxOf(g)[0] : 0); } tables.hmtx = hm.b;
  // cmap: format 4, one segment per character
  const cm = G.map((g, i) => [g.uni, i]).filter(([u]) => u !== undefined).sort((a, b) => a[0] - b[0]);
  const segs = [...cm.map(([u, g]) => [u, u, (g - u) & 0xffff]), [0xffff, 0xffff, 1]]; const n = segs.length;
  const sub = be().u16(4).u16(16 + n * 8).u16(0).u16(n * 2).u16(2 * 2 ** Math.floor(Math.log2(n))).u16(Math.floor(Math.log2(n))).u16(n * 2 - 2 * 2 ** Math.floor(Math.log2(n)));
  for (const s of segs) sub.u16(s[1]); sub.u16(0); for (const s of segs) sub.u16(s[0]); for (const s of segs) sub.u16(s[2]); for (const s of segs) sub.u16(0);
  tables.cmap = be().u16(0).u16(1).u16(3).u16(1).u32(12).bytes(sub.b).b;
  // GSUB: 'medi' — ی then ي (two lookups) to the one medial glyph.
  const lookup = (from) => be().u16(1).u16(0).u16(1).u16(8).u16(2).u16(8).u16(1).u16(YEH_MEDI).u16(1).u16(1).u16(from).b; // type 1, format 2
  const l1 = lookup(L['ی']), l2 = lookup(L['ي']);
  const lookupList = be().u16(2).u16(6).u16(6 + l1.length).bytes(l1).bytes(l2).b;
  const featureList = be().u16(1).tag('medi').u16(8).u16(0).u16(2).u16(0).u16(1).b;
  const scriptList = be().u16(1).tag('arab').u16(8).u16(4).u16(0).u16(0).u16(0xffff).u16(1).u16(0).b;
  tables.GSUB = be().u32(0x10000).u16(10).u16(10 + scriptList.length).u16(10 + scriptList.length + featureList.length).bytes(scriptList).bytes(featureList).bytes(lookupList).b;
  tables.post = be().u32(0x30000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0).b;
  const nm = (s) => { const w = be(); for (const c of s) w.u16(c.charCodeAt(0)); return w.b; };
  const names = [[1, 'KrTest Arabic'], [2, 'Regular'], [4, 'KrTest Arabic'], [6, 'KrTestArabic']].map(([id, s]) => [id, nm(s)]);
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
async function book() {
  const doc = await PDFDocument.create(); const ctx = doc.context;
  const data = ttf();
  const file = ctx.register(ctx.flateStream(data, { Length1: data.length }));
  const desc = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+KrTestArabic', Flags: 4, FontBBox: [-300, -400, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -300, CapHeight: 700, StemV: 80, FontFile2: file }));
  const cid = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'ABCDEF+KrTestArabic', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, FontDescriptor: desc, DW: 500, W: [0, G.map((g) => g.adv)], CIDToGIDMap: 'Identity' }));
  const bf = G.map((g, i) => [i, g.tu]).filter(([, t]) => t !== undefined);
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${bf.length} beginbfchar\n${bf.map(([g, t]) => `<${g.toString(16).padStart(4, '0')}> <${u16hex(t)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
  const tu = ctx.register(ctx.flateStream(cmap));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+KrTestArabic', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: tu }));
  const page = (ops) => { const p = doc.addPage([420, 300]); p.node.setFontDictionary(PDFName.of('F1'), font); p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(ops))); };
  const S = 20; // font size: 1000 units = 20 pt
  // A right-to-left word drawn left to right as Word draws it: its glyphs in visual order from x.
  const word = (x, y, gids) => `BT /F1 ${S} Tf 1 0 0 1 ${x} ${y} Tm ${hex(gids)} Tj ET\n`;
  // A haraka (or two) drawn apart in red, as Word draws coloured harakat: a space at the word's start, then each
  // mark moved to its place (x, y absolute).
  const redMarks = (x0, y, marks) => `BT /F1 ${S} Tf 1 0 0 rg 1 0 0 1 ${x0} ${y} Tm ${hex([SPACE])} Tj ${marks.map(([g, x, my]) => `1 0 0 1 ${x} ${my} Tm ${hex([g])} Tj`).join(' ')} ET\n`;
  // 1. "جُمله": ه ل [جم ligature], the damma over the ligature's right half (its ج); under it "مّ" (the "مي"
  //    ligature, named "مّ") with a shadda over it; then "جم" and "جه" in plain letters, so the font is seen drawing them.
  const w1 = [L['ه'], L['ل'], LIG_JM]; const x1 = 250; const jmX = x1 + 20; // ه 10pt, ل 10pt, then the ligature 18pt
  page(word(x1, 240, w1) + redMarks(x1 + 40, 240, [[DAMMA, jmX + 17, 240]])
    + word(250, 200, [LIG_MY]) + redMarks(270, 200, [[SHADDA, 250 + 12, 200]])
    + word(250, 160, [L['م'], L['ج']]) + word(250, 120, [L['ه'], L['ج']]));
  // 2. "عَلَى": one glyph for the word, two fathas in red over its ع (right third) and its ل (middle third).
  page(word(200, 200, [ALA]) + redMarks(222, 200, [[FATHA, 200 + 20, 200], [FATHA, 200 + 14, 200]]));
  // 3. "وَ": the fatha in the word's run, its origin 5 pt under the baseline (ink 9 pt over it); "بِ": the same
  //    glyph 20 pt under the baseline (its ink under the baseline) — a kasra.
  page(`BT /F1 ${S} Tf 1 0 0 1 200 200 Tm ${hex([L['و']])} Tj 1 0 0 1 208 195 Tm ${hex([FATHA])} Tj ET\n`
    + `BT /F1 ${S} Tf 1 0 0 1 120 200 Tm ${hex([L['ب']])} Tj 1 0 0 1 128 180 Tm ${hex([FATHA])} Tj ET\n`);
  // 4. "بين": ن, the shared medial glyph (named ي by the PDF), ب.
  page(word(200, 200, [L['ن'], YEH_MEDI, L['ب']]));
  // 5. "سنة 1443" on a right-to-left line: the word, then "3" (rightmost digit drawn first), then "144" just left of it.
  page(word(240, 200, [L['ه'], L['ن'], L['س']]) + word(210, 200, [D['3']]) + word(180, 200, [D['1'], D['4'], D['4']]));
  const f = path.join(tmp, 'p2d-chars.pdf'); fs.writeFileSync(f, await doc.save()); return f;
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

// The embedded fonts of a .docx (de-obfuscated), by family.
async function embedded(zip) {
  const table = await zip.file('word/fontTable.xml').async('string'); const rels = await zip.file('word/_rels/fontTable.xml.rels').async('string');
  const out = new Map();
  for (const m of table.matchAll(/<w:font w:name="([^"]+)">([\s\S]*?)<\/w:font>/g)) {
    const e = /<w:embed\w+ r:id="([^"]+)" w:fontKey="\{([0-9A-F-]+)\}"/.exec(m[2]); if (!e) continue;
    const target = new RegExp(`Id="${e[1]}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]; if (!target) continue;
    const b = new Uint8Array(await zip.file(`word/${target}`).async('uint8array'));
    const kb = e[2].replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16)).reverse();
    for (let i = 0; i < 32; i++) b[i] ^= kb[i % 16];
    out.set(m[1], b);
  }
  return out;
}
// A TrueType font's advance (font units) for the glyph its cmap gives a character (null when it has none).
function advanceOf(b, cp) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); const t = {};
  for (let i = 0, n = dv.getUint16(4); i < n; i++) { const r = 12 + i * 16; t[String.fromCharCode(...b.subarray(r, r + 4))] = dv.getUint32(r + 8); }
  let gid = 0;
  for (let i = 0, n = dv.getUint16(t.cmap + 2); i < n && !gid; i++) {
    const s = t.cmap + dv.getUint32(t.cmap + 8 + i * 8); if (dv.getUint16(s) !== 4) continue;
    const seg = dv.getUint16(s + 6) / 2, ends = s + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ros = deltas + seg * 2;
    for (let k = 0; k < seg; k++) {
      const a = dv.getUint16(starts + k * 2), z = dv.getUint16(ends + k * 2); if (cp < a || cp > z) continue;
      const ro = dv.getUint16(ros + k * 2), d = dv.getUint16(deltas + k * 2);
      gid = ro ? (dv.getUint16(ros + k * 2 + ro + (cp - a) * 2) + d) & 0xffff : (cp + d) & 0xffff; break;
    }
  }
  if (!gid) return null;
  const nh = dv.getUint16(t.hhea + 34); const unitsPerEm = dv.getUint16(t.head + 18);
  return dv.getUint16(t.hmtx + Math.min(gid, nh - 1) * 4) * 1000 / unitsPerEm;
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    const zip = await convert(browser, await book());
    const xml = await zip.file('word/document.xml').async('string');
    const pages = xml.split(/<w:sectPr[ >]/).slice(0, -1).map((s) => [...s.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => [...p[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((x) => x[1]).join('')).join('\n'));
    const show = (s) => JSON.stringify(s);
    ok(`five pages, five sections (${pages.length})`, pages.length === 5);
    const p1 = pages[0] ?? '';
    ok(`1. the "جم" ligature named "جُ" gives "جُمله", the letter back and the damma once — ${show(p1)}`, p1.includes('جُمله'));
    ok(`1. the "مي" ligature named "مّ", which nothing settles, keeps the PDF's name with its shadda once — ${show(p1)}`, p1.includes('مّ') && !p1.includes('مّّ') && !p1.includes('مي'));
    ok(`2. two red fathas drawn one after the other go each on its letter: "عَلَى" — ${show(pages[1])}`, (pages[1] ?? '').includes('عَلَى'));
    ok(`3. a fatha drawn from under the baseline with its ink above stays a fatha: "وَ" — ${show(pages[2])}`, (pages[2] ?? '').includes('وَ'));
    ok(`3. one whose ink stands under the baseline is a kasra: "بِ" — ${show(pages[2])}`, (pages[2] ?? '').includes('بِ'));
    ok(`4. the medial yeh the PDF calls ي stays ي, not Persian ی — ${show(pages[3])}`, (pages[3] ?? '').includes('بين') && !(pages[3] ?? '').includes('ی'));
    ok(`5. a year drawn as "144" and "3" is stored thousands first, "1443" — ${show(pages[4])}`, (pages[4] ?? '').includes('1443') && !(pages[4] ?? '').includes('3144'));
    // What Word will show: the font carried for these runs draws ج and م with their own glyphs, not a ligature's.
    const fonts = await embedded(zip); const kr = [...fonts].find(([k]) => /KrTest/i.test(k))?.[1];
    ok(`the test font is carried in the document (${[...fonts.keys()].join(', ')})`, !!kr);
    if (kr) {
      const aj = advanceOf(kr, 0x62c), am = advanceOf(kr, 0x645);
      ok(`its ج and م are their own glyphs (advances ${aj}, ${am}; the ligatures' are 900 and 800)`, aj !== null && am !== null && Math.abs(aj - 500) < 30 && Math.abs(am - 500) < 30);
    }
  } catch (e) { console.log('FAIL', e); fails++; }
  await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
