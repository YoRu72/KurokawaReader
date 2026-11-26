// node tests/pdf2docxfontsout.cjs: PDF → Word, «Fonts: in a folder» (Reader 0.68.0).
// Fixtures that exist already: tests/pdf2docx/corpus2/pdf — lo-docx-untagged.pdf (Carlito Regular / Bold / Italic: a family of
// several faces) and pdflatex.pdf (Type 1 fonts rebuilt as TrueType)
// plus scan-image.pdf (a scan: no font to write) and a made-up one with a font going by «Times New Roman» (a name every computer has).
// With «In a folder»:
//   - the .docx has no word/fonts entry, no embedTrueTypeFonts, no relationship to a font file;
//   - every family its runs name is a font written as a file, or one the converter did not build (told by what «Inside the
//     file» embeds in the same PDF);
//   - each file parses: its tables there, its checksums right, the name records (1, 2, 3, 4, 5, 6) as they should be, the style
//     links (OS/2 weight + fsSelection, head macStyle) that make Word's Bold and Italic buttons find the faces, `post`, the Windows
//     cmap, and a cmap that covers every character the document shows in that font;
//   - the family a file installs under is the name the runs ask for, and never a name a computer has («Times New Roman (PDF)»);
//   - each file's bytes are the font «Inside the file» embeds (after undoing Word's obfuscation) or differ in the tables added;
//   - no file twice; a PDF with no font to write gives the plain .docx.
// «Inside the file» is what it was: its parts hashed (the random keys, dates and the obfuscation undone) equal the HEAD build's.
// The sheet: the «Fonts» row shows for Word only, holds after the sheet is reopened, its line shows only for «In a folder» (en, ar);
// the web's result is one .zip holding the .docx and its fonts folder, stored; the finished card names what was made.
// (KR_DIST=<dir> runs it against another build; KR_P2D_HASHES=1 prints the «Inside the file» hashes.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os'); const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const JSZip = require('jszip'); const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist')); const PORT = 5203;
const CORPUS = path.join(__dirname, 'pdf2docx/corpus2/pdf');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-fontsout-'));

// «Inside the file», hashed over its parts as HEAD (0.67.x) built it: each part's bytes, the file's dates and keys and the fonts'
// obfuscation undone. (Two corpus PDFs; filled in from the HEAD build with KR_P2D_HASHES=1 KR_DIST=<head dist>.)
const EMBED_HASHES = {
  'lo-docx-untagged': '65c379c1221aefc3d6b010b3c98235858dc605b4',
  'pdflatex': '8d4f532c5d78bfc23984fa18ea3bd541d610ae3f',
};

// ---- A made-up PDF with a TrueType font named «Times New Roman» (a box for each glyph). ----
const be = () => { const b = []; const w = { u8: (v) => (b.push(v & 255), w), u16: (v) => (b.push((v >> 8) & 255, v & 255), w), i16: (v) => w.u16(v & 0xffff), u32: (v) => (w.u16((v >>> 16) & 0xffff), w.u16(v & 0xffff)), tag: (s) => { for (const c of s) b.push(c.charCodeAt(0)); return w; }, bytes: (a) => { for (const x of a) b.push(x); return w; }, b }; return w; };
function ttf(family, G) {
  const tables = {}; const glyf = be(); const loca = [];
  for (const g of G) {
    loca.push(glyf.b.length);
    if (g.box) { const [x0, y0, x1, y1] = g.box; glyf.i16(1).i16(x0).i16(y0).i16(x1).i16(y1).u16(3).u16(0).u8(1).u8(1).u8(1).u8(1); const pts = [[x0, y0], [x0, y1], [x1, y1], [x1, y0]]; let px = 0, py = 0; for (const [x] of pts) { glyf.i16(x - px); px = x; } for (const [, y] of pts) { glyf.i16(y - py); py = y; } }
    while (glyf.b.length % 4) glyf.u8(0);
  }
  loca.push(glyf.b.length); tables.glyf = glyf.b; tables.loca = be(); for (const o of loca) tables.loca.u32(o); tables.loca = tables.loca.b;
  const all = G.filter((g) => g.box).map((g) => g.box); const bb = [Math.min(...all.map((b) => b[0])), Math.min(...all.map((b) => b[1])), Math.max(...all.map((b) => b[2])), Math.max(...all.map((b) => b[3]))];
  tables.head = be().u32(0x10000).u32(0x10000).u32(0).u32(0x5f0f3cf5).u16(0x000b).u16(1000).u32(0).u32(0).u32(0).u32(0).i16(bb[0]).i16(bb[1]).i16(bb[2]).i16(bb[3]).u16(0).u16(8).i16(2).i16(1).i16(0).b;
  tables.hhea = be().u32(0x10000).i16(900).i16(-300).i16(0).u16(1000).i16(bb[0]).i16(-300).i16(bb[2]).i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(G.length).b;
  tables.maxp = be().u32(0x10000).u16(G.length).u16(4).u16(1).u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).b;
  const hm = be(); for (const g of G) hm.u16(g.adv).i16(g.box ? g.box[0] : 0); tables.hmtx = hm.b;
  const cm = G.map((g, i) => [g.uni, i]).filter(([u]) => u !== undefined).sort((a, b) => a[0] - b[0]);
  const segs = [...cm.map(([u, g]) => [u, u, (g - u) & 0xffff]), [0xffff, 0xffff, 1]]; const n = segs.length;
  const sub = be().u16(4).u16(16 + n * 8).u16(0).u16(n * 2).u16(2 * 2 ** Math.floor(Math.log2(n))).u16(Math.floor(Math.log2(n))).u16(n * 2 - 2 * 2 ** Math.floor(Math.log2(n)));
  for (const s of segs) sub.u16(s[1]); sub.u16(0); for (const s of segs) sub.u16(s[0]); for (const s of segs) sub.u16(s[2]); for (const s of segs) sub.u16(0);
  tables.cmap = be().u16(0).u16(1).u16(3).u16(1).u32(12).bytes(sub.b).b;
  tables.post = be().u32(0x30000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0).b;
  const nm = (s) => { const w = be(); for (const c of s) w.u16(c.charCodeAt(0)); return w.b; };
  const names = [[1, family], [2, 'Regular'], [4, family], [6, family.replace(/\s/g, '')]].map(([id, s]) => [id, nm(s)]);
  const name = be().u16(0).u16(names.length).u16(6 + names.length * 12); let off = 0;
  for (const [id, b] of names) { name.u16(3).u16(1).u16(0x409).u16(id).u16(b.length).u16(off); off += b.length; }
  for (const [, b] of names) name.bytes(b); tables.name = name.b;
  const os2 = be().u16(4).i16(500).u16(400).u16(5).u16(0).i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(250).i16(0);
  for (let i = 0; i < 10; i++) os2.u8(0);
  os2.u32(0x2003).u32(0).u32(0).u32(0).tag('KRTL').u16(0x40).u16(cm[0][0]).u16(cm[cm.length - 1][0]).i16(900).i16(-300).i16(0).u16(900).u16(300).u32(0x41).u32(0).i16(500).i16(700).u16(0).u16(0x20).u16(0);
  tables['OS/2'] = os2.b;
  const tags = Object.keys(tables).sort(); const out = be().u32(0x10000).u16(tags.length).u16(128).u16(3).u16(tags.length * 16 - 128);
  let at = 12 + tags.length * 16; const body = [];
  for (const t of tags) { const d = tables[t]; let sum = 0; for (let i = 0; i < d.length; i += 4) sum = (sum + ((d[i] << 24) | ((d[i + 1] || 0) << 16) | ((d[i + 2] || 0) << 8) | (d[i + 3] || 0))) >>> 0; out.tag(t).u32(sum).u32(at).u32(d.length); body.push(d); at += d.length; while (at % 4) { body.push([0]); at++; } }
  for (const d of body) out.bytes(d);
  return Uint8Array.from(out.b);
}
async function timesPdf() {
  const BOX = { A: [50, 0, 450, 700], B: [60, 0, 440, 650], C: [70, 0, 430, 600] };
  const G = [{ adv: 500 }, { adv: 250, uni: 0x20 }, ...['A', 'B', 'C'].map((c) => ({ adv: BOX[c][2] + 50, box: BOX[c], uni: c.codePointAt(0) }))];
  const doc = await PDFDocument.create(); const ctx = doc.context; const base = 'AAAAAA+TimesNewRomanPSMT';
  const data = ttf('Times New Roman', G); const file = ctx.register(ctx.flateStream(data, { Length1: data.length }));
  const desc = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: base, Flags: 32, FontBBox: [-100, -300, 2000, 900], ItalicAngle: 0, Ascent: 900, Descent: -300, CapHeight: 700, StemV: 80, FontFile2: file }));
  const cid = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: base, CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, FontDescriptor: desc, DW: 500, W: [0, G.map((g) => g.adv)], CIDToGIDMap: 'Identity' }));
  const hex4 = (v) => v.toString(16).padStart(4, '0');
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n4 beginbfchar\n<${hex4(1)}> <0020>\n<${hex4(2)}> <0041>\n<${hex4(3)}> <0042>\n<${hex4(4)}> <0043>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
  const tu = ctx.register(ctx.flateStream(cmap));
  const f1 = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: base, Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: tu }));
  const pg = doc.addPage([595, 842]); pg.node.set(PDFName.of('Resources'), ctx.obj({ Font: ctx.obj({ F1: f1 }) }));
  let ops = ''; let y = 780; for (const w of ['ABC CBA', 'BAC ABC CAB', 'CCC AAA BBB']) { ops += `BT /F1 14 Tf 1 0 0 1 60 ${y} Tm <${[...w].map((c) => hex4(c === ' ' ? 1 : c.charCodeAt(0) - 63)).join('')}> Tj ET\n`; y -= 24; }
  pg.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(ops)));
  const f = path.join(tmp, 'times-made-up.pdf'); fs.writeFileSync(f, await doc.save()); return f;
}

// ---- Made-up PDFs with SEVERAL SUBSETS of one face (AAAAAA+Foo, BBBBBB+Foo): the same characters drawn with the same outlines, or not. ----
// spec: { fonts: [{ base, chars, boxOf(ch) }], lines: [[fontIndex, text]], family }
async function subsetsPdf(name, spec) {
  const doc = await PDFDocument.create(); const ctx = doc.context; const hex4 = (v) => v.toString(16).padStart(4, '0'); const res = {};
  spec.fonts.forEach((f, fi) => {
    const G = [{ adv: 500 }, { adv: 250, uni: 0x20 }, ...[...f.chars].map((c) => { const b = f.boxOf(c); return { adv: b[2] + 50, box: b, uni: c.codePointAt(0) }; })];
    const data = ttf(spec.family, G); const file = ctx.register(ctx.flateStream(data, { Length1: data.length }));
    const desc = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: f.base, Flags: 32, FontBBox: [-100, -300, 2000, 900], ItalicAngle: 0, Ascent: 900, Descent: -300, CapHeight: 700, StemV: 80, FontFile2: file }));
    const cid = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: f.base, CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, FontDescriptor: desc, DW: 500, W: [0, G.map((g) => g.adv)], CIDToGIDMap: 'Identity' }));
    const pairs = G.map((g, i) => (g.uni === undefined ? '' : `<${hex4(i)}> <${hex4(g.uni)}>\n`)).join('');
    const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${G.filter((g) => g.uni !== undefined).length} beginbfchar\n${pairs}endbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
    const tu = ctx.register(ctx.flateStream(cmap));
    res[`F${fi + 1}`] = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: f.base, Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: tu }));
    f.G = G;
  });
  const pg = doc.addPage([595, 842]); pg.node.set(PDFName.of('Resources'), ctx.obj({ Font: ctx.obj(res) }));
  let ops = ''; let y = 780;
  for (const [fi, text] of spec.lines) { const f = spec.fonts[fi]; ops += `BT /F${fi + 1} 14 Tf 1 0 0 1 60 ${y} Tm <${[...text].map((c) => hex4(c === ' ' ? 1 : f.G.findIndex((g) => g.uni === c.codePointAt(0)))).join('')}> Tj ET\n`; y -= 24; }
  pg.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(ops)));
  const out = path.join(tmp, `${name}.pdf`); fs.writeFileSync(out, await doc.save()); return out;
}
// Each letter its own box; `shift` draws it another way.
const boxLetter = (shift) => (ch) => { const c = ch.codePointAt(0) - 65; return [40 + c * 5 + shift, 0, 400 + c * 20, 600 + c * 10 - shift * 2]; };
const SUBSETS_SAME = { family: 'Foo', fonts: [{ base: 'AAAAAA+Foo', chars: 'ABCD', boxOf: boxLetter(0) }, { base: 'BBBBBB+Foo', chars: 'BCDE', boxOf: boxLetter(0) }], lines: [[0, 'ABCD DCBA ABBA'], [1, 'BCDE EDCB CEDB'], [0, 'DAB CAD'], [1, 'EBE DCE']] };
// One letter drawn the same and the others another way (a half-agreeing pair), and three subsets where the third meets only the first
// (no letter in common) yet clashes with the second.
const SUBSETS_PARTIAL = { family: 'Foo', fonts: [{ base: 'AAAAAA+Foo', chars: 'ABCD', boxOf: boxLetter(0) }, { base: 'BBBBBB+Foo', chars: 'BCDE', boxOf: (ch) => boxLetter(ch === 'B' ? 0 : 30)(ch) }], lines: [[0, 'ABCD DCBA ABBA'], [1, 'BCDE EDCB CEDB']] };
const SUBSETS_CHAIN = { family: 'Foo', fonts: [{ base: 'AAAAAA+Foo', chars: 'ABC', boxOf: boxLetter(0) }, { base: 'BBBBBB+Foo', chars: 'CDE', boxOf: boxLetter(0) }, { base: 'CCCCCC+Foo', chars: 'FDE', boxOf: (ch) => boxLetter(ch === 'F' ? 0 : 30)(ch) }], lines: [[0, 'ABC CBA'], [1, 'CDE EDC'], [2, 'FDE EDF']] };
const SUBSETS_DIFFER = { family: 'Foo', fonts: [{ base: 'AAAAAA+Foo', chars: 'ABCD', boxOf: boxLetter(0) }, { base: 'BBBBBB+Foo', chars: 'BCDE', boxOf: boxLetter(30) }], lines: [[0, 'ABCD DCBA ABBA'], [1, 'BCDE EDCB CEDB']] };
// The box of a character's glyph in a parsed font: [xMin, yMin, xMax, yMax] per 1000 em.
function glyphBox(f, ch) {
  const g = f.gids.get(ch.codePointAt(0)); if (g === undefined) return null;
  const head = new DataView(f.tables.get('head').buffer, f.tables.get('head').byteOffset, 54); const long = head.getInt16(50) === 1;
  const lo = f.tables.get('loca'); const ld = new DataView(lo.buffer, lo.byteOffset, lo.byteLength); const off = long ? ld.getUint32(g * 4) : ld.getUint16(g * 2) * 2; const end = long ? ld.getUint32(g * 4 + 4) : ld.getUint16(g * 2 + 2) * 2;
  if (end <= off) return null;
  const gl = f.tables.get('glyf'); const d = new DataView(gl.buffer, gl.byteOffset, gl.byteLength);
  return [2, 4, 6, 8].map((k) => Math.round(d.getInt16(off + k) * 1000 / f.upem));
}

// Waits on a condition, never on the clock: the page's animations have ended (and a frame has been drawn after them).
const pressed = (page, text) => page.waitForFunction((x) => [...document.querySelectorAll('.conv-fonts button')].some((b) => b.getAttribute('aria-pressed') === 'true' && b.textContent === x), text, { timeout: 15000 });
const settle = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity) && new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))), null, { timeout: 15000 });

// ---- The app: convert a PDF with the options given; the result as saved. ----
async function openConvert(page, file) {
  await page.setInputFiles('input[type=file]', [file]); await page.waitForSelector('.book-card:not(.folder-card)', { timeout: 60000 });
  await openMenu(page);
}
async function openMenu(page) {
  // (A computer's right-click gives the book's menu at the pointer; a phone's hold, the selection bar.)
  const card = await page.$('.book-card:not(.folder-card)'); await card.dispatchEvent('contextmenu', { clientX: 420, clientY: 300 }); await page.waitForSelector('.sel-actions, .dest-row');
  // (The menu on a computer is long; its row is clicked where it stands, scrolled or not.)
  if (await page.$('.dest-row')) await page.waitForFunction(() => { const b = [...document.querySelectorAll('.dest-row')].find((x) => /^(Convert|تحويل)$/.test(x.textContent.trim())); if (!b) return false; b.click(); return true; }, null, { timeout: 15000 });
  else {
    const conv = '.sel-actions button:has-text("Convert"), .sel-actions button:has-text("تحويل")';
    if (!(await page.$(conv))) { await page.click('.sel-actions button:has-text("More"), .sel-actions button:has-text("المزيد")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert"), .sheet button:has-text("تحويل")'); } else await page.click(conv);
  }
  await page.waitForSelector('.convert-target');
}
async function newPage(browser, lang, convertOpts, viewport = { width: 900, height: 900 }, more = {}) {
  const { init, exposes, initArg, ...ctxOpts } = more;
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, ...ctxOpts }); const page = await ctx.newPage();
  for (const [k, f] of Object.entries(exposes || {})) await page.exposeFunction(k, f);
  if (init) await page.addInitScript(init, initArg);
  page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(([l, o]) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); if (o) localStorage.setItem('kr.convert', JSON.stringify(o)); }, [lang, convertOpts]);
  await page.reload(); await page.waitForSelector('.library-view');
  return { ctx, page };
}
async function convert(browser, file, fonts) {
  const { ctx, page } = await newPage(browser, 'en', { docxResult: 'edit', ...(fonts ? { docxFonts: fonts } : {}) });
  try {
    await openConvert(page, file);
    await page.click('.convert-target:has-text("Word")');
    await page.waitForSelector('.convert-result:not([hidden]) button, .sheet .src:has-text("failed")', { timeout: 150000 });
    const status = (await page.textContent('.sheet .src')).replace(/\s+/g, ' ');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.convert-result button:has-text("Save")')]);
    const out = path.join(tmp, `${path.basename(file, '.pdf')}.${fonts || 'embed'}.${dl.suggestedFilename().split('.').pop()}`); await dl.saveAs(out);
    return { out, name: dl.suggestedFilename(), status };
  } finally { await ctx.close(); }
}

// A PDF with two subsets of one face, converted «In a folder» (and «Inside the file»): what files and which families come out.
async function subsetProbe(browser, pdf, key) {
  const fol = await convert(browser, pdf, 'folder'); const emb = await convert(browser, pdf, 'embed');
  if (/\.docx$/.test(fol.name)) { const E0 = await readDocx(emb.out); return { fol, emb, F: E0, E: E0, fonts: [], files: [] }; } // (a build without the folder mode: only what «Inside the file» embeds)
  const Z = await JSZip.loadAsync(fs.readFileSync(fol.out)); const names = Object.keys(Z.files).filter((n) => !Z.files[n].dir);
  const docxName = names.find((n) => /\.docx$/.test(n)); const files = names.filter((n) => /\.(ttf|otf)$/.test(n));
  fs.writeFileSync(path.join(tmp, `${key}.folder.docx`), await Z.file(docxName).async('nodebuffer'));
  const F = await readDocx(path.join(tmp, `${key}.folder.docx`)); const E = await readDocx(emb.out);
  const fonts = []; for (const n of files) fonts.push({ n, f: parseFont(await Z.file(n).async('uint8array')) });
  return { fol, emb, F, E, fonts, files };
}

// ---- Reading fonts. ----
function unscramble(data, key) { const g = key.replace(/[{}-]/g, ''); const kb = []; for (let i = 0; i < 32; i += 2) kb.push(parseInt(g.slice(i, i + 2), 16)); kb.reverse(); const b = Uint8Array.from(data); for (let i = 0; i < 32 && i < b.length; i++) b[i] ^= kb[i % 16]; return b; }
const sumOf = (a) => { let s = 0; for (let i = 0; i < a.length; i += 4) s = (s + ((a[i] << 24) | ((a[i + 1] || 0) << 16) | ((a[i + 2] || 0) << 8) | (a[i + 3] || 0))) >>> 0; return s; };
function parseFont(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); const tag = dv.getUint32(0); const tables = new Map(); const bad = [];
  for (let i = 0, n = dv.getUint16(4); i < n; i++) {
    const r = 12 + i * 16; const name = String.fromCharCode(...b.subarray(r, r + 4)); const off = dv.getUint32(r + 8), len = dv.getUint32(r + 12);
    const data = b.subarray(off, off + len); tables.set(name, data);
    const padded = new Uint8Array(Math.ceil(len / 4) * 4); padded.set(data); if (name === 'head') { padded[8] = padded[9] = padded[10] = padded[11] = 0; }
    if (sumOf(padded) !== dv.getUint32(r + 4)) bad.push(name);
  }
  const whole = sumOf(b); const adjOk = ((0xb1b0afba - whole + dv.getUint32(tables.get('head').byteOffset - b.byteOffset + 8)) >>> 0) === dv.getUint32(tables.get('head').byteOffset - b.byteOffset + 8) || whole === 0xb1b0afba;
  const names = new Map(); // `${pid}/${id}` → string
  const nm = tables.get('name');
  if (nm) { const d = new DataView(nm.buffer, nm.byteOffset, nm.byteLength); const cnt = d.getUint16(2), so = d.getUint16(4); for (let i = 0; i < cnt; i++) { const r = 6 + i * 12; const pid = d.getUint16(r), id = d.getUint16(r + 6), len = d.getUint16(r + 8), off = d.getUint16(r + 10); let s = ''; if (pid === 3) for (let k = 0; k < len; k += 2) s += String.fromCharCode(d.getUint16(so + off + k)); else for (let k = 0; k < len; k++) s += String.fromCharCode(nm[so + off + k]); names.set(`${pid}/${id}`, s); } }
  // The Windows character map.
  const cmap = new Set(); const gids = new Map(); let platforms = [];
  const cm = tables.get('cmap');
  if (cm) {
    const c = new DataView(cm.buffer, cm.byteOffset, cm.byteLength);
    for (let i = 0, n = c.getUint16(2); i < n; i++) {
      const p = c.getUint16(4 + i * 8), e = c.getUint16(6 + i * 8), s = c.getUint32(8 + i * 8); platforms.push(`${p}.${e}`); if (p !== 3 && !(p === 0)) continue;
      const fmt = c.getUint16(s);
      if (fmt === 4) { const seg = c.getUint16(s + 6) / 2, ends = s + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2; for (let k = 0; k < seg; k++) { const a = c.getUint16(starts + k * 2), z = c.getUint16(ends + k * 2), d = c.getInt16(deltas + k * 2), ro = c.getUint16(ranges + k * 2); if (a === 0xffff) continue; for (let ch = a; ch <= z; ch++) { let g; if (!ro) g = (ch + d) & 0xffff; else { g = c.getUint16(ranges + k * 2 + ro + (ch - a) * 2); if (g) g = (g + d) & 0xffff; } if (g) { cmap.add(ch); gids.set(ch, g); } } } }
      else if (fmt === 12) { for (let k = 0, n2 = c.getUint32(s + 12); k < n2; k++) { const a = c.getUint32(s + 16 + k * 12), z = c.getUint32(s + 20 + k * 12), g0 = c.getUint32(s + 24 + k * 12); for (let ch = a; ch <= z && ch - a < 0x10000; ch++) { cmap.add(ch); gids.set(ch, g0 + ch - a); } } }
    }
  }
  const os2 = tables.get('OS/2'); const o = os2 && new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
  const head = tables.get('head'); const h = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return { tag, tables, bad, adjOk, names, cmap, gids, platforms, weight: o && o.getUint16(4), fsSel: o && o.length !== 0 && os2.length >= 64 ? o.getUint16(62) : null, macStyle: h.getUint16(44), upem: h.getUint16(18) };
}
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// A .docx's parts, its embedded fonts unscrambled: { parts: Map name → bytes, embedded: [{ family, face, bytes }] }.
async function readDocx(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file)); const parts = new Map();
  for (const n of Object.keys(zip.files)) if (!zip.files[n].dir) parts.set(n, await zip.file(n).async('uint8array'));
  const str = (n) => (parts.has(n) ? Buffer.from(parts.get(n)).toString('utf8') : '');
  const table = str('word/fontTable.xml'); const rels = str('word/_rels/fontTable.xml.rels'); const embedded = [];
  for (const m of table.matchAll(/<w:font w:name="([^"]*)">([\s\S]*?)<\/w:font>/g)) for (const em of m[2].matchAll(/<w:embed(\w+) r:id="([^"]+)" w:fontKey="([^"]+)"\/>/g)) {
    const target = (new RegExp(`Id="${em[2]}"[^>]*Target="([^"]+)"`).exec(rels) || [])[1]; const data = target && parts.get('word/' + target);
    if (data) embedded.push({ family: unesc(m[1]), face: em[1], bytes: unscramble(data, em[3]) });
  }
  return { zip, parts, str, table, rels, embedded };
}
// The parts' hash: each part's bytes, the dates and keys and the fonts' obfuscation taken out.
function partsHash(d) {
  const h = crypto.createHash('sha1'); const keyOf = new Map();
  for (const em of d.embedded) keyOf.set(em.family + '/' + em.face, em);
  for (const n of [...d.parts.keys()].sort()) {
    let b = d.parts.get(n);
    if (n === 'docProps/core.xml') b = Buffer.from(Buffer.from(b).toString('utf8').replace(/<dcterms:(created|modified)[^>]*>[^<]*<\/dcterms:\1>/g, ''));
    else if (n === 'word/fontTable.xml') b = Buffer.from(Buffer.from(b).toString('utf8').replace(/w:fontKey="[^"]*"/g, 'w:fontKey=""'));
    else if (/^word\/fonts\//.test(n)) b = Buffer.from('FONT');
    h.update(n + '\0'); h.update(b); h.update('\0');
  }
  for (const em of [...d.embedded].sort((a, b) => (a.family + a.face).localeCompare(b.family + b.face))) { h.update(`${em.family}/${em.face}\0`); h.update(em.bytes); }
  return h.digest('hex');
}
// The families the runs name, and what each font's runs show (family|face → characters).
function runsOf(d) {
  const named = new Set(); const shown = new Map();
  for (const n of d.parts.keys()) {
    if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n)) continue;
    const x = d.str(n);
    for (const m of x.matchAll(/w:(?:ascii|hAnsi|cs|eastAsia)="([^"]*)"/g)) named.add(unesc(m[1]));
    for (const r of x.matchAll(/<w:r>(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?([\s\S]*?)<\/w:r>/g)) {
      const pr = r[1] || ''; const fam = unesc((/w:cs="([^"]*)"/.exec(pr) || /w:ascii="([^"]*)"/.exec(pr) || [])[1] || ''); if (!fam) continue;
      const text = unesc([...r[2].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('')); if (!text) continue;
      const bold = /<w:b(Cs)?\/>|<w:b(Cs)? w:val="(1|true)"\/>/.test(pr), italic = /<w:i(Cs)?\/>|<w:i(Cs)? w:val="(1|true)"\/>/.test(pr);
      const k = `${fam}|${bold ? 'Bold' : ''}${italic ? 'Italic' : ''}` || fam; const set = shown.get(k) ?? shown.set(k, new Set()).get(k); for (const ch of text) set.add(ch.codePointAt(0));
    }
  }
  return { named, shown };
}
// Each run of the body in order: [family, text].
function runPairs(d) {
  const out = []; const x = d.str('word/document.xml');
  for (const r of x.matchAll(/<w:r>(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?([\s\S]*?)<\/w:r>/g)) { const fam = unesc((/w:cs="([^"]*)"/.exec(r[1] || '') || /w:ascii="([^"]*)"/.exec(r[1] || '') || [])[1] || ''); const text = unesc([...r[2].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('')); if (text.trim()) out.push([fam, text]); }
  return out;
}
const STYLE = { Regular: 'Regular', Bold: 'Bold', Italic: 'Italic', BoldItalic: 'Bold Italic' };
const SYSTEM = /^(Arial|Times New Roman|Courier New|Courier|Calibri|Cambria|Georgia|Verdana|Tahoma|Helvetica|Times|Symbol|Liberation (Serif|Sans|Mono)|DejaVu (Serif|Sans|Sans Mono)|Noto (Sans|Serif)( CJK [A-Z]{2})?( Mono)?)$/i;

async function folderChecks(label, browser, pdf, key) {
  const emb = await convert(browser, pdf, 'embed'); const fol = await convert(browser, pdf, 'folder');
  ok(`${label}: «Inside the file» saves the .docx (${emb.name})`, /\.docx$/.test(emb.name));
  ok(`${label}: «In a folder» saves one .zip (${fol.name}) — «${fol.status}»`, /\.zip$/.test(fol.name) && /Word document \+ fonts, count: \d+/.test(fol.status));
  const E = await readDocx(emb.out);
  const Z = await JSZip.loadAsync(fs.readFileSync(fol.out)); const names = Object.keys(Z.files).filter((n) => !Z.files[n].dir);
  const base = fol.name.replace(/\.zip$/, '');
  const docxName = names.find((n) => n === `${base}.docx`);
  const files = names.filter((n) => n.startsWith(`${base} fonts/`));
  ok(`${label}: the zip lists the .docx and the «${base} fonts» folder only (${names.length} entries)`, !!docxName && names.length === 1 + files.length && files.length > 0 && files.every((n) => /^[^/]+ fonts\/[^/]+\.(ttf|otf)$/.test(n)));
  ok(`${label}: the zip's entries are stored, not squeezed`, names.every((n) => Z.files[n]._data.compressedSize === Z.files[n]._data.uncompressedSize));
  fs.writeFileSync(path.join(tmp, `${key}.folder.docx`), await Z.file(docxName).async('nodebuffer'));
  const F = await readDocx(path.join(tmp, `${key}.folder.docx`));
  // 1. no font in the .docx.
  const allXml = [...F.parts.keys()].filter((n) => /\.(xml|rels)$/.test(n)).map((n) => F.str(n)).join('\n');
  ok(`${label}: the .docx has no word/fonts entry, no odttf`, ![...F.parts.keys()].some((n) => /^word\/fonts\/|\.odttf$/i.test(n)) && !/odttf|obfuscatedFont/.test(allXml));
  ok(`${label}: no embedTrueTypeFonts, no embed element, no font relationship`, !/embedTrueTypeFonts/.test(F.str('word/settings.xml')) && !/<w:embed(Regular|Bold|Italic|BoldItalic) /.test(F.table) && !/relationships\/font"/.test(allXml) && !F.parts.has('word/_rels/fontTable.xml.rels'));
  // 2. the files.
  const fonts = []; for (const n of files) fonts.push({ n, f: parseFont(await Z.file(n).async('uint8array')) });
  const wanted = new Map(); // what «Inside the file» embeds: family → name asked in the folder's .docx
  const ask = (fam) => (SYSTEM.test(fam) ? `${fam} (PDF)` : fam);
  for (const em of E.embedded) wanted.set(em.family, ask(em.family));
  const written = new Set(fonts.map((x) => x.f.names.get('3/1')));
  const runsE = runsOf(E), runsF = runsOf(F);
  const expected = new Set([...runsE.named].map((n) => (wanted.has(n) ? wanted.get(n) : n)));
  const miss = [...runsF.named].filter((n) => !expected.has(n)), gone = [...expected].filter((n) => !runsF.named.has(n));
  ok(`${label}: the runs name the same families (a built one under the folder's name) ${JSON.stringify({ miss, gone })}`, !miss.length && !gone.length);
  const unwritten = [...runsF.named].filter((n) => ![...wanted.values()].includes(n) ? false : !written.has(n));
  ok(`${label}: every built family the runs name is written as a file (${[...wanted.values()].join(', ')}) ${JSON.stringify(unwritten)}`, wanted.size > 0 && !unwritten.length && [...wanted.values()].every((w) => written.has(w)));
  ok(`${label}: the table names each family the runs name, none with a font file`, [...runsF.named].every((n) => F.table.includes(`<w:font w:name="${n.replace(/&/g, '&amp;')}"`)));
  // 3. each file sound.
  const core = (f) => (f.tag === 0x4f54544f ? ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'name', 'OS/2', 'post', 'CFF '] : ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'name', 'OS/2', 'post', 'glyf', 'loca']);
  ok(`${label}: each file has its tables ${fonts.filter((x) => !core(x.f).every((t) => x.f.tables.has(t))).map((x) => x.n)}`, fonts.every((x) => core(x.f).every((t) => x.f.tables.has(t))));
  ok(`${label}: each file's checksums are right ${JSON.stringify(fonts.filter((x) => x.f.bad.length).map((x) => [x.n, x.f.bad]))}`, fonts.every((x) => !x.f.bad.length && x.f.adjOk));
  const byFam = new Map(); for (const x of fonts) (byFam.get(x.f.names.get('3/1')) ?? byFam.set(x.f.names.get('3/1'), []).get(x.f.names.get('3/1'))).push(x);
  const badNames = fonts.filter(({ n, f }) => { const fam = f.names.get('3/1'), sub = f.names.get('3/2'), full = f.names.get('3/4'), ps = f.names.get('3/6'); return !(fam && ['Regular', 'Bold', 'Italic', 'Bold Italic'].includes(sub) && full === (sub === 'Regular' ? fam : `${fam} ${sub}`) && /^[A-Za-z0-9-]{1,63}$/.test(ps) && f.names.get('3/3') && f.names.get('3/5') && n.endsWith(`${(STYLE[sub] ? sub : '').replace(/\s/g, '')}.${n.split('.').pop()}`)); });
  ok(`${label}: name records: family 1, style 2, unique 3, full 4, version 5, PostScript 6 ${JSON.stringify(badNames.map((x) => x.n))}`, !badNames.length);
  const mac = fonts.filter(({ f }) => /^[\x20-\x7e]+$/.test(f.names.get('3/1'))).every(({ f }) => f.names.get('1/1') === f.names.get('3/1') && f.names.get('1/2') === f.names.get('3/2') && f.names.get('1/6') === f.names.get('3/6'));
  ok(`${label}: the Mac's name records say the same`, mac);
  const ps = fonts.map((x) => x.f.names.get('3/6')); ok(`${label}: PostScript names are each their own`, new Set(ps).size === ps.length);
  const links = fonts.filter(({ f }) => { const sub = f.names.get('3/2'); const b = sub.includes('Bold'), i = sub.includes('Italic'); return !(((f.macStyle & 1) === (b ? 1 : 0)) && (((f.macStyle >> 1) & 1) === (i ? 1 : 0)) && f.weight === (b ? 700 : 400) && f.fsSel !== null && !!(f.fsSel & 0x20) === b && !!(f.fsSel & 1) === i && !!(f.fsSel & 0x40) === (!b && !i)); });
  ok(`${label}: Bold and Italic links — macStyle, OS/2 weight and fsSelection say the style the name says ${JSON.stringify(links.map((x) => x.n))}`, !links.length);
  ok(`${label}: a Windows cmap in each (${[...new Set(fonts.flatMap((x) => x.f.platforms))].join(' ')})`, fonts.every(({ f }) => f.platforms.some((p) => /^3\.(0|1|10)$/.test(p))));
  const same = [...byFam.entries()].filter(([, l]) => l.length > 1).map(([fam, l]) => `${fam}: ${l.map((x) => x.f.names.get('3/2')).join('+')}`);
  console.log('     families with several faces:', same.join('; ') || 'none');
  ok(`${label}: no family or style written twice, no file twice`, new Set(fonts.map((x) => x.f.names.get('3/4'))).size === fonts.length && new Set(files.map((n) => n.toLowerCase())).size === files.length && new Set(fonts.map((x) => Buffer.from(x.f.tables.get('glyf') || x.f.tables.get('CFF ')).toString('hex') + x.f.names.get('3/4'))).size === fonts.length);
  ok(`${label}: no file is named as a font a computer has`, fonts.every(({ f }) => !SYSTEM.test(f.names.get('3/1'))));
  // 4. each character the document shows in a font is in its file.
  const lack = [];
  for (const [k, set] of runsF.shown) {
    const [fam, face] = k.split('|'); const l = byFam.get(fam); if (!l) continue;
    const want = STYLE[face || 'Regular'] ?? 'Regular'; const hit = l.find((x) => x.f.names.get('3/2') === (face === 'BoldItalic' ? 'Bold Italic' : face || 'Regular')) ?? l[0];
    for (const c of set) { if (c <= 0x20 || (c >= 0x200b && c <= 0x200f) || c === 0x2060 || c === 0xfeff || (c >= 0x300 && c <= 0x36f) || (c >= 0x64b && c <= 0x65f) || c === 0xa0) continue; if (!hit.f.cmap.has(c)) lack.push(`${fam}/${face || 'Regular'} U+${c.toString(16)}`); }
    void want;
  }
  ok(`${label}: each file's cmap covers what the document shows in it ${JSON.stringify(lack.slice(0, 8))}${lack.length} missing`, !lack.length);
  // 5. the bytes of each file against the font «Inside the file» embeds.
  const diffs = [];
  for (const em of E.embedded) {
    const f = parseFont(em.bytes); const style = STYLE[em.face]; const mine = fonts.find((x) => x.f.names.get('3/1') === ask(em.family) && x.f.names.get('3/2') === style);
    if (!mine) { diffs.push(`${em.family} ${em.face}: no file`); continue; }
    for (const t of f.tables.keys()) {
      if (t === 'name' || t === 'DSIG') continue;
      const a = f.tables.get(t), b = mine.f.tables.get(t); if (!b) { diffs.push(`${em.family} ${em.face}: ${t} missing`); continue; }
      if (t === 'head') { const x = Buffer.from(a), y = Buffer.from(b); for (const at of [8, 9, 10, 11, 44, 45]) { x[at] = 0; y[at] = 0; } if (!x.equals(y)) diffs.push(`${em.family} ${em.face}: head`); continue; }
      if (t === 'OS/2') { const x = Buffer.from(a), y = Buffer.from(b); if (x.length !== y.length) { diffs.push(`${em.family} ${em.face}: OS/2 length`); continue; } for (const at of [4, 5, 62, 63]) { x[at] = 0; y[at] = 0; } if (!x.equals(y)) diffs.push(`${em.family} ${em.face}: OS/2`); continue; }
      if (t === 'post') { const x = Buffer.from(a), y = Buffer.from(b); for (const at of [4, 5, 6, 7]) { x[at] = 0; y[at] = 0; } if (!x.equals(y)) diffs.push(`${em.family} ${em.face}: post`); continue; }
      if (t === 'cmap') { const same = f.cmap.size === mine.f.cmap.size && [...f.cmap].every((c) => mine.f.cmap.has(c)); if (!same) diffs.push(`${em.family} ${em.face}: cmap`); continue; }
      if (!Buffer.from(a).equals(Buffer.from(b))) diffs.push(`${em.family} ${em.face}: ${t}`);
    }
    for (const t of mine.f.tables.keys()) if (!f.tables.has(t) && !['name', 'OS/2', 'post'].includes(t)) diffs.push(`${em.family} ${em.face}: extra table ${t}`);
    const added = [...mine.f.tables.keys()].filter((t) => !f.tables.has(t)); if (added.length) console.log(`     ${em.family} ${em.face}: tables added: ${added.join(' ')}`);
  }
  ok(`${label}: each file is the font «Inside the file» embeds — its outlines, metrics and layout tables the same; name, OS/2 style bits, macStyle, post angle aside ${JSON.stringify(diffs)}`, E.embedded.length > 0 && !diffs.length);
  console.log(`     ${label}: ${fonts.length} files: ${fonts.map((x) => x.n.split('/')[1]).join(', ')}`);
  return { E, F, fonts, emb };
}

// ---- «Save to»: the document and its fonts written into folders the reader chose (the computer's Rust shell, the phone). ----
// The computer's shell is imitated by the real folder-writing rules of src-tauri/src/savelogic.rs, compiled alone (tests/savehost)
// and run for each step the page sends; the phone's plugin by a recorder. (The shell and the phone themselves are not run here.)
function buildHost() {
  if (process.env.KR_SAVEHOST) return process.env.KR_SAVEHOST;
  const out = path.join(tmp, 'savehost');
  try { execFileSync('rustc', ['--edition', '2021', path.join(__dirname, 'savehost/main.rs'), '-o', out], { stdio: 'pipe' }); return out; } catch (e) { console.log('     (no rustc here: the folder cases are skipped)'); return null; }
}
const DESK = () => {
  window.__log = []; window.__opened = [];
  const host = async (args, input, enc) => { const r = await window.__host(args, input || '', enc || 'utf8'); if (r.code) throw new Error(r.err.trim() || 'failed'); return r.out; };
  const api = {
    platform: 'win32', onOpenFile() {},
    pickFolder: async () => { const p = await window.__pick(); window.__log.push('pick:' + p); return p; },
    saveFiles: async (o) => {
      window.__log.push(o.op + (o.rel ? ':' + o.rel : ''));
      if (o.op === 'plan') { const out = await host(['plan', o.dir, ...o.items.map((i) => `${i.rel}\t${i.size}\t${i.sha}`)]); const items = [], newDirs = []; for (const l of out.split('\n').filter(Boolean)) { const [k, v] = l.split('\t'); if (k === 'newdir') newDirs.push(v); else items.push({ rel: v, action: k }); } return { items, newDirs }; }
      if (o.op === 'part') { await host(['part', o.dir, o.rel, o.first ? '1' : '0', o.last ? '1' : '0'], o.b64, 'b64'); return true; }
      if (o.op === 'undo') return Number(await host(['undo', o.dir], [...o.rels.map((r) => 'f\t' + r), ...o.dirs.map((d) => 'd\t' + d)].join('\n')));
      if (o.op === 'open') { window.__opened.push(o.p); return true; }
      throw new Error('unknown');
    },
  };
  window.kurokawaDesktop = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : () => undefined) });
};
const ANDROID = () => {
  window.__calls = [];
  const Kurokawa = {
    pickTree: async () => { const t = await window.__tree(); if (!t) throw new Error('cancelled'); window.__calls.push('pickTree'); return t; },
    treePlan: async (o) => { window.__calls.push('plan:' + o.items.map((i) => i.rel).join('|')); return { items: o.items.map((i) => ({ rel: i.rel, action: (window.__same || []).includes(i.rel) ? 'same' : 'write', parent: 'content://tree/' + (i.rel.includes('/') ? i.rel.split('/')[0] : 'top'), name: i.rel.split('/').pop() })), newDirs: o.items.some((i) => i.rel.includes('/')) ? ['content://tree/dir'] : [] }; },
    writeDocument: async (o) => { if (window.__failTtf && /\.ttf$/.test(o.name || '')) throw new Error('EIO'); const uri = o.uri || 'content://doc/' + o.name; window.__calls.push((o.uri ? 'append:' : `create:${o.parent}:`) + (o.name || o.uri)); return { uri }; },
    treeUndo: async (o) => { window.__calls.push(`undo:${o.uris.length}:${o.dirs.length}`); return { gone: o.uris.length }; },
  };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { App: { addListener: () => Promise.resolve({ remove() {} }), getLaunchUrl: async () => null, minimizeApp: async () => {} }, Kurokawa } };
};
const tree = (d) => { const out = []; const walk = (x, rel) => { for (const e of fs.readdirSync(x, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const q = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) { out.push(q + '/'); walk(path.join(x, e.name), q); } else out.push(q); } }; if (fs.existsSync(d)) walk(d, ''); return out; };
const stamp = (d) => tree(d).map((f) => (f.endsWith('/') ? f : `${f}:${fs.statSync(path.join(d, f)).size}:${fs.statSync(path.join(d, f)).mtimeMs}`));
const srcText = (page) => page.evaluate(() => document.querySelector('.sheet .src').textContent.replace(/[\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim());
const waitSrc = (page, re) => page.waitForFunction((r) => new RegExp(r).test(document.querySelector('.sheet .src').textContent.replace(/[\u2066-\u2069]/g, '')), re, { timeout: 30000 });

async function placeChecks(browser, pdf) {
  const HOST = buildHost(); if (!HOST) return;
  const host = (args, input, enc) => { const r = spawnSync(HOST, args, { input: enc === 'b64' ? Buffer.from(input, 'base64') : Buffer.from(input || '', 'utf8') }); return { code: r.status, out: r.stdout.toString(), err: r.stderr.toString() }; };
  const mk = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
  const desk = async (lang, viewport, picks, opts) => newPage(browser, lang, { docxResult: 'edit', docxFonts: 'folder', ...(opts || {}) }, viewport, { init: DESK, exposes: { __host: host, __pick: () => picks.shift() ?? null } });
  const rowsOf = (page) => page.evaluate(() => ({ doc: !!document.querySelector('.conv-place-doc'), fonts: !!document.querySelector('.conv-place-fonts'), docVal: document.querySelector('.conv-place-doc .conv-place-val')?.textContent, docNone: !!document.querySelector('.conv-place-doc .conv-place-val.none'), fontsVal: document.querySelector('.conv-place-fonts .conv-place-val')?.textContent, fontsOff: document.querySelector('.conv-place-fonts .btn')?.disabled, buttons: [...document.querySelectorAll('.conv-place .btn')].map((b) => Math.round(b.getBoundingClientRect().width)), heights: [...document.querySelectorAll('.conv-place .btn, .conv-place .icon-btn')].map((b) => Math.round(parseFloat(getComputedStyle(b).height))) }));
  const chooseDoc = async (page, want) => { await page.click('.conv-place-doc .btn'); await page.waitForFunction((w) => document.querySelector('.conv-place-doc .conv-place-val')?.textContent === w, want, { timeout: 10000 }); };
  const toWord = async (page) => { await page.click('.convert-target:has-text("Word")'); await page.waitForSelector('.convert-result:not([hidden]) button', { timeout: 150000 }); };

  // 1. the computer, English: choose, convert, save → a real document and a real folder.
  const docDir = mk('place-doc'), fontsDir = mk('place-fonts');
  {
    const picks = [docDir, fontsDir]; const { ctx, page } = await desk('en', { width: 1280, height: 900 }, picks);
    try {
      await openConvert(page, pdf);
      let r = await rowsOf(page);
      ok(`PC: «Save to» and «Fonts folder» rows show for «In a folder», nothing chosen yet ${JSON.stringify(r)}`, r.doc && r.fonts && r.docNone && r.fontsOff === true && r.heights.every((x) => x >= 40));
      await chooseDoc(page, 'place-doc'); r = await rowsOf(page);
      ok('PC: the chosen folder is shown, the fonts row can be chosen now (its default: beside the document)', r.docVal === 'place-doc' && r.fontsOff === false && /Beside the document/.test(r.fontsVal));
      await toWord(page);
      const ready = await srcText(page);
      ok(`PC: the card names the .docx (it is saved as a document, not a ZIP) — «${ready}»`, /Ready: times-made-up\.docx · .*Word document \+ fonts, count: 1/.test(ready) && !/\.zip/.test(ready));
      const before = tree(docDir); ok('PC: nothing is written before Save', before.length === 0);
      await page.click('.convert-result button:has-text("Save")'); await waitSrc(page, 'Saved in');
      const said = await srcText(page); const files = tree(docDir);
      ok(`PC: the document is a real file and its fonts a real folder beside it ${JSON.stringify(files)}`, JSON.stringify(files) === JSON.stringify(['times-made-up fonts/', 'times-made-up fonts/Times New Roman (PDF)-Regular.ttf', 'times-made-up.docx']));
      ok(`PC: the card says what was made and where — «${said}»`, /^Saved in place-doc: times-made-up\.docx · .*\s+Fonts, count: 1, in place-doc\/times-made-up fonts$/.test(said));
      const Zd = await JSZip.loadAsync(fs.readFileSync(path.join(docDir, 'times-made-up.docx')));
      ok('PC: the saved document is a .docx with no font inside', !!Zd.file('word/document.xml') && !Object.keys(Zd.files).some((n) => /^word\/fonts\//.test(n)));
      const ttf = fs.readFileSync(path.join(docDir, 'times-made-up fonts', 'Times New Roman (PDF)-Regular.ttf')); ok('PC: the font file is a TrueType font', ttf.readUInt32BE(0) === 0x10000);
      ok('PC: no part file is left', !tree(docDir).some((f) => /\.krpart$/.test(f)));
      ok('PC: «Open folder» shows after saving and opens the folder', await page.evaluate(() => !![...document.querySelectorAll('.convert-result button')].find((b) => b.textContent.includes('Open folder'))));
      await page.click('.convert-result button:has-text("Open folder")'); ok('PC: Open folder asks the shell to show the document\'s folder', JSON.stringify(await page.evaluate(() => window.__opened)) === JSON.stringify([docDir]));
      // The same result saved again: nothing new.
      const st = stamp(docDir);
      await page.click('.convert-result button:has-text("Save")'); await waitSrc(page, 'nothing new was written');
      ok('PC: saving the same result again writes nothing', JSON.stringify(stamp(docDir)) === JSON.stringify(st));
      // Fonts to a folder of their own: written straight into it.
      await page.click('.conv-place-fonts .btn'); await page.waitForFunction(() => document.querySelector('.conv-place-fonts .conv-place-val')?.textContent === 'place-fonts');
      await page.click('.convert-result button:has-text("Save")'); await waitSrc(page, 'in place-fonts');
      ok(`PC: the fonts go straight into the fonts folder chosen ${JSON.stringify(tree(fontsDir))}`, JSON.stringify(tree(fontsDir)) === JSON.stringify(['Times New Roman (PDF)-Regular.ttf']) && JSON.stringify(stamp(docDir)) === JSON.stringify(st));
      // Chosen places are remembered.
      await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 5000 }).catch(() => undefined);
      await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((x) => x.remove()));
      await openMenu(page);
      r = await rowsOf(page); ok(`PC: the places are remembered when the sheet is opened again ${JSON.stringify([r.docVal, r.fontsVal])}`, r.docVal === 'place-doc' && r.fontsVal === 'place-fonts');
      await page.click('.conv-place-fonts .icon-btn'); await page.waitForFunction(() => /Beside the document/.test(document.querySelector('.conv-place-fonts .conv-place-val')?.textContent || ''));
      ok('PC: Clear puts the fonts folder back beside the document', true);
    } finally { await ctx.close(); }
  }
  // 2. the same PDF converted again, into the same folders: the fonts already there are not written; the document, other bytes, gets « (2)».
  {
    const picks = [docDir]; const { ctx, page } = await desk('en', { width: 1280, height: 900 }, picks);
    try {
      await openConvert(page, pdf); await chooseDoc(page, 'place-doc'); await toWord(page);
      const before = stamp(docDir);
      await page.click('.convert-result button:has-text("Save")'); await waitSrc(page, 'Saved in');
      const after = stamp(docDir); const added = after.filter((x) => !before.includes(x));
      ok(`PC: a second export into the same folder writes only the new document (the font is not written again): ${JSON.stringify(added.map((x) => x.split(':')[0]))}`, added.length === 1 && added[0].startsWith('times-made-up (2).docx:') && before.every((x) => after.includes(x)));
      ok('PC: the status tells the fonts were already there', /already there, count: 1/.test(await srcText(page)));
    } finally { await ctx.close(); }
  }
  // 3. a failure leaves nothing behind: the fonts folder is gone after the document was planned.
  {
    const d3 = mk('place-fail-doc'), f3 = mk('place-fail-fonts'); const picks = [d3, f3]; const { ctx, page } = await desk('en', { width: 1280, height: 900 }, picks);
    try {
      await openConvert(page, pdf); await chooseDoc(page, 'place-fail-doc'); await page.click('.conv-place-fonts .btn'); await page.waitForFunction(() => document.querySelector('.conv-place-fonts .conv-place-val')?.textContent === 'place-fail-fonts');
      await toWord(page); fs.rmSync(f3, { recursive: true });
      await page.click('.convert-result button:has-text("Save")'); await waitSrc(page, 'cannot be written to');
      ok(`PC: a failed save says so and leaves nothing behind ${JSON.stringify(tree(d3))}`, tree(d3).length === 0);
      ok('PC: after a failure the ZIP route is still there (Share)', await page.evaluate(() => !![...document.querySelectorAll('.convert-result button')].find((b) => /Share/.test(b.textContent))));
      // The document's folder gone: nothing is written anywhere.
      fs.rmSync(d3, { recursive: true }); await page.click('.convert-result button:has-text("Save")'); await waitSrc(page, 'cannot be written to'); ok('PC: no folder to write to — nothing is made', !fs.existsSync(d3));
    } finally { await ctx.close(); }
  }
  // 4. «Inside the file» on the computer: the «Save to» row for the document alone.
  {
    const d4 = mk('place-inside'); const { ctx, page } = await desk('en', { width: 1280, height: 900 }, [d4], { docxFonts: 'embed' });
    try {
      await openConvert(page, pdf); const r = await rowsOf(page);
      ok('PC: «Inside the file» has the «Save to» row alone (no fonts row)', r.doc && !r.fonts);
      await chooseDoc(page, 'place-inside'); await toWord(page);
      ok('PC: «Inside the file» → the card names the .docx', /Ready: times-made-up\.docx/.test(await srcText(page)) && !/fonts, count/.test(await srcText(page)));
      await page.click('.convert-result button:has-text("Save")'); await waitSrc(page, 'Saved in');
      ok(`PC: one real .docx in the folder ${JSON.stringify(tree(d4))}`, JSON.stringify(tree(d4)) === JSON.stringify(['times-made-up.docx']));
    } finally { await ctx.close(); }
  }
  // 5. the computer, Arabic: the rows, the heading's quotation marks (shots).
  {
    const picks = [mk('مجلد-المستند')]; const { ctx, page } = await desk('ar', { width: 1280, height: 900 }, picks);
    try {
      await openConvert(page, pdf);
      const head = await page.evaluate(() => document.querySelector('.sheet .src').textContent);
      ok(`PC ar: the heading isolates the name, so the «» stay around it — ${JSON.stringify(head)}`, /«⁨times-made-up⁩»/.test(head) && (head.match(/«/g) || []).length === 1 && (head.match(/»/g) || []).length === 1);
      await page.click('.conv-place-doc .btn'); await page.waitForFunction(() => document.querySelector('.conv-place-doc .conv-place-val') && !document.querySelector('.conv-place-doc .conv-place-val.none'));
      const r = await page.evaluate(() => ({ labels: [...document.querySelectorAll('.conv-place .label')].map((x) => x.textContent), btn: [...document.querySelectorAll('.conv-place .btn')].map((x) => x.textContent) }));
      ok(`PC ar: the rows speak Arabic ${JSON.stringify(r)}`, r.labels[0] === 'الحفظ في' && r.labels[1] === 'مجلد الخطوط' && r.btn.every((x) => x === 'اختيار'));
      await page.evaluate(() => { for (const e of document.querySelectorAll('.sheet, .sheet-body')) e.scrollTop = 0; }); await settle(page);
      await page.screenshot({ path: path.join(process.env.KR_SHOTS || tmp, 'P1b-paths-pc-ar.png') });
    } finally { await ctx.close(); }
  }
  // 6. the web (no shell, no plugin): no rows, the ZIP as before — phone and computer.
  for (const [label, vp] of [['phone', { width: 412, height: 915 }], ['PC', { width: 1280, height: 900 }]]) {
    const { ctx, page } = await newPage(browser, 'en', { docxResult: 'edit', docxFonts: 'folder' }, vp);
    try { await openConvert(page, pdf); ok(`web ${label}: no «Save to» rows (the ZIP stays)`, await page.evaluate(() => document.querySelectorAll('.conv-place').length === 0 && !document.querySelector('.conv-places:not([hidden])'))); } finally { await ctx.close(); }
  }
  // 7. the phone's plugin (a recorder): the rows, the calls, a failure undone, the same file skipped.
  for (const lang of ['en', 'ar']) {
    const t = { uri: 'content://tree/top', name: lang === 'en' ? 'Documents' : 'المستندات' };
    const { ctx, page } = await newPage(browser, lang, { docxResult: 'edit', docxFonts: 'folder' }, { width: 412, height: 915 }, { colorScheme: 'dark', deviceScaleFactor: 2, init: ANDROID, exposes: { __tree: () => t } });
    try {
      await openConvert(page, pdf); let r = await rowsOf(page);
      ok(`phone ${lang}: the «Save to» and fonts rows show (the phone's folder picker), none chosen ${JSON.stringify([r.doc, r.fonts, r.docNone])}`, r.doc && r.fonts && r.docNone && r.fontsOff === true && r.heights.every((x) => x >= 40));
      await chooseDoc(page, t.name);
      if (lang === 'ar') { await settle(page); await page.screenshot({ path: path.join(process.env.KR_SHOTS || tmp, 'P1b-paths-ar.png') }); }
      await toWord(page);
      await page.evaluate(() => { window.__failTtf = true; }); await page.click('.convert-result button:has-text("Save"), .convert-result button:has-text("حفظ")');
      await page.waitForFunction(() => /cannot be written to|تعذّرت الكتابة/.test(document.querySelector('.sheet .src').textContent), null, { timeout: 30000 });
      let calls = await page.evaluate(() => window.__calls);
      ok(`phone ${lang}: the file made before the failure and the folder are undone ${JSON.stringify(calls.slice(1))}`, calls.some((c) => /^create:content:\/\/tree\/top:times-made-up\.docx$/.test(c)) && calls[calls.length - 1] === 'undo:1:1');
      await page.evaluate(() => { window.__failTtf = false; window.__calls = []; window.__same = ['times-made-up fonts/Times New Roman (PDF)-Regular.ttf']; });
      await page.click('.convert-result button:has-text("Save"), .convert-result button:has-text("حفظ")'); await page.waitForFunction(() => /Saved in|حُفظ في/.test(document.querySelector('.sheet .src').textContent), null, { timeout: 30000 });
      calls = await page.evaluate(() => window.__calls);
      ok(`phone ${lang}: a file already there is not written (only the document is) ${JSON.stringify(calls)}`, calls.length === 2 && /^plan:times-made-up\.docx\|times-made-up fonts\//.test(calls[0]) && /^create:content:\/\/tree\/top:times-made-up\.docx$/.test(calls[1]));
      if (lang === 'ar') { await page.evaluate(() => { for (const e of document.querySelectorAll('.sheet, .sheet-body')) e.scrollTop = 0; }); await settle(page); await page.screenshot({ path: path.join(process.env.KR_SHOTS || tmp, 'P1b-done-ar.png') }); }
      ok(`phone ${lang}: no «Open folder» on the phone`, await page.evaluate(() => !document.querySelector('.conv-open')));
    } finally { await ctx.close(); }
  }
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    const lo = path.join(CORPUS, 'lo-docx-untagged.pdf'), tex = path.join(CORPUS, 'pdflatex.pdf'), plain = path.join(CORPUS, 'scan-image.pdf'), times = await timesPdf();

    // «Inside the file» as it was.
    if (process.env.KR_P2D_HASHES) {
      for (const [k, f] of [['lo-docx-untagged', lo], ['pdflatex', tex]]) { const r = await convert(browser, f, 'embed'); const r2 = await convert(browser, f, 'embed'); console.log(`HASH ${k} ${partsHash(await readDocx(r.out))} ${partsHash(await readDocx(r2.out))}`); }
      await browser.close(); server.close(); return;
    } else {
      for (const [k, f] of [['lo-docx-untagged', lo], ['pdflatex', tex]]) { const r = await convert(browser, f, ''); ok(`«Inside the file» (the default) for ${k} is what the HEAD build made (${partsHash(await readDocx(r.out)).slice(0, 12)})`, partsHash(await readDocx(r.out)) === EMBED_HASHES[k]); }
    }
    const A = await folderChecks('Carlito (several faces)', browser, lo, 'lo');
    ok(`Carlito: a family of several faces is written as several files, as many as «Inside the file» embeds (${A.E.embedded.length})`, ['Regular', 'Bold'].every((s) => A.fonts.some((x) => x.f.names.get('3/1') === 'Carlito' && x.f.names.get('3/2') === s)) && A.fonts.length === A.E.embedded.length);
    await folderChecks('TeX (rebuilt Type 1)', browser, tex, 'tex');
    const T = await folderChecks('Times New Roman (made up)', browser, times, 'times');
    ok('Times New Roman: the file installs as «Times New Roman (PDF)» and the runs ask for that name; «Inside the file» kept the name', T.fonts.some((x) => x.f.names.get('3/1') === 'Times New Roman (PDF)') && runsOf(T.F).named.has('Times New Roman (PDF)') && T.E.embedded.some((e) => e.family === 'Times New Roman'));
    // Several subsets of one face (ABCDEF+Foo, GHIJKL+Foo): one font each face, and never a wrong glyph.
    for (const [k, spec, families] of [['same', SUBSETS_SAME, ['Foo']], ['differ', SUBSETS_DIFFER, ['Foo', 'Foo (2)']], ['partial', SUBSETS_PARTIAL, ['Foo', 'Foo (2)']], ['chain', SUBSETS_CHAIN, ['Foo', 'Foo (2)']]]) {
      const r = await subsetProbe(browser, await subsetsPdf(`subsets-${k}`, spec), k); const runs = runsOf(r.F); const pairs = runPairs(r.F);
      ok(`subsets ${k}: the runs name ${families.join(' + ')} (${[...runs.named].join(' | ')})`, [...runs.named].sort().join('|') === [...families].sort().join('|'));
      ok(`subsets ${k}: one file for each face: ${r.files.join(', ')}`, r.fonts.length === families.length && families.every((f) => r.fonts.some((x) => x.f.names.get('3/1') === f && x.f.names.get('3/2') === 'Regular')) && new Set(r.fonts.map((x) => x.f.names.get('3/1'))).size === families.length);
      ok(`subsets ${k}: «Inside the file» embeds the same families (${r.E.embedded.map((e) => e.family).join(', ')})`, [...r.E.embedded.map((e) => e.family)].sort().join('|') === [...families].sort().join('|'));
      // every character the document shows is in its font, drawn with the outline of the subset that drew it.
      const lack = [], wrong = [];
      for (const [fam, text] of pairs) {
        const file = r.fonts.find((x) => x.f.names.get('3/1') === fam); if (!file) { lack.push(`${fam}: no file`); continue; }
        for (const word of text.split(' ').filter(Boolean)) {
          const from = spec.fonts.filter((f, i) => spec.lines.some(([fi, t]) => fi === i && t.split(' ').includes(word)));
          for (const c of word) {
            if (!file.f.cmap.has(c.codePointAt(0))) { lack.push(`${fam} ${c}`); continue; }
            const got = glyphBox(file.f, c); const okBox = from.some((f) => { const w = f.boxOf(c); return got && got.every((v, i) => Math.abs(v - w[i]) <= 2); });
            if (!okBox) wrong.push(`${fam} ${word}: ${c} ${JSON.stringify(got)}`);
          }
        }
      }
      ok(`subsets ${k}: every shown character is in its font ${JSON.stringify(lack)}`, !lack.length && pairs.length > 0);
      ok(`subsets ${k}: every glyph is the one its subset drew ${JSON.stringify(wrong)}`, !wrong.length);
    }
    // A PDF with no font of its own to write: the plain .docx; nothing said of fonts.
    const P = await convert(browser, plain, 'folder');
    ok(`no font to write (a scan): the result is the plain .docx (${P.name}), the sheet says nothing of fonts — «${P.status}»`, /\.docx$/.test(P.name) && !/fonts/i.test(P.status) && !(await readDocx(P.out)).parts.has('word/fonts/font1.odttf'));

    // The sheet.
    for (const lang of ['en', 'ar']) {
      const L = lang === 'en' ? { fonts: 'Fonts', inside: 'Inside the file', folder: 'In a folder', hint: /cut down to the letters/, made: /Word document \+ fonts, count: \d+/, word: 'Word' } : { fonts: 'الخطوط', inside: 'داخل الملف', folder: 'في مجلد', hint: /مقصورةً على ما استُعمل من حروفها/, made: /مستند Word وخطوطه، العدد: \d+/, word: 'Word' };
      const { ctx, page } = await newPage(browser, lang, null, { width: 412, height: 915 }, { colorScheme: 'dark', deviceScaleFactor: 2 });
      try {
        await openConvert(page, lo);
        const row = async () => page.evaluate(() => { const o = document.querySelector('.conv-docx-opts'); const bs = [...o.querySelectorAll('.conv-fonts button')]; const hint = o.querySelector('.conv-fonts-hint'); return { shown: !o.hidden, label: [...o.querySelectorAll('.label')].map((x) => x.textContent), buttons: bs.map((b) => [b.textContent, b.getAttribute('aria-pressed')]), hint: hint && !hint.hidden ? hint.textContent : null, widths: bs.map((b) => Math.round(b.getBoundingClientRect().width)), heights: bs.map((b) => Math.round(b.getBoundingClientRect().height)) }; });
        let r = await row();
        ok(`${lang}: the «Fonts» row shows for a PDF → Word with «${L.inside}» chosen, no line under it ${JSON.stringify(r.buttons)}`, r.shown && r.label.includes(L.fonts) && r.buttons[0][0] === L.inside && r.buttons[0][1] === 'true' && r.buttons[1][0] === L.folder && r.buttons[1][1] === 'false' && r.hint === null);
        ok(`${lang}: the two buttons are one width and ≥ 40 px high (${r.widths}, ${r.heights})`, Math.abs(r.widths[0] - r.widths[1]) <= 1 && r.heights.every((x) => x >= 40));
        await page.click(`.conv-fonts button:has-text("${L.folder}")`); await pressed(page, L.folder); r = await row();
        ok(`${lang}: «${L.folder}» shows its line`, r.buttons[1][1] === 'true' && L.hint.test(r.hint || ''));
        await settle(page);
        if (lang === 'en') await page.screenshot({ path: path.join(process.env.KR_SHOTS || tmp, 'P1-fonts-en.png') });
        else await page.screenshot({ path: path.join(process.env.KR_SHOTS || tmp, 'P1-fonts-ar.png') });
        // Held after the sheet is closed and opened again; and after a reload (kept with the other convert options).
        await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 5000 }).catch(() => undefined);
        await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((x) => x.remove()));
        const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
        const conv = '.sel-actions button:has-text("Convert"), .sel-actions button:has-text("تحويل")';
        if (!(await page.$(conv))) { await page.click('.sel-actions button:has-text("More"), .sel-actions button:has-text("المزيد")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert"), .sheet button:has-text("تحويل")'); } else await page.click(conv);
        await page.waitForSelector('.convert-target'); r = await row();
        ok(`${lang}: the choice holds after the sheet is opened again`, r.buttons[1][1] === 'true' && !!r.hint);
        await page.click(`.conv-fonts button:has-text("${L.inside}")`); await pressed(page, L.inside); r = await row();
        ok(`${lang}: «${L.inside}» takes the line away`, r.buttons[0][1] === 'true' && r.hint === null);
        await page.click(`.conv-fonts button:has-text("${L.folder}")`);
        // The finished card.
        await page.click('.convert-target:has-text("Word")'); await page.waitForSelector('.convert-result:not([hidden]) button', { timeout: 150000 }); await settle(page);
        const status = (await page.textContent('.sheet .src')).replace(/\s+/g, ' ');
        ok(`${lang}: the finished card names what was made — «${status}»`, L.made.test(status));
        await page.evaluate(() => { for (const e of document.querySelectorAll('.sheet, .sheet-body')) e.scrollTop = 0; }); await settle(page);
        await page.screenshot({ path: path.join(process.env.KR_SHOTS || tmp, `P1-done-${lang}.png`) });
        await page.evaluate(() => document.querySelector('.convert-result').scrollIntoView({ block: 'center' })); await settle(page);
        await page.screenshot({ path: path.join(process.env.KR_SHOTS || tmp, `P1-done-${lang}-buttons.png`) });
        // The jobs sheet names it too and its buttons act on the whole result.
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.convert-result button:has-text("Save"), .convert-result button:has-text("حفظ")')]);
        ok(`${lang}: Save gives the .zip (${dl.suggestedFilename()})`, /\.zip$/.test(dl.suggestedFilename()));
      } finally { await ctx.close(); }
    }
    await placeChecks(browser, times);

    // The option is for Word only: a book that is not a PDF has no row.
    {
      const { ctx, page } = await newPage(browser, 'en', { docxFonts: 'folder' });
      try {
        const epub = path.join(__dirname, 'fixtures/alice-in-wonderland.epub'); await openConvert(page, epub);
        const shown = await page.evaluate(() => { const o = document.querySelector('.conv-docx-opts'); return !!o && !o.hidden; });
        ok('the «Fonts» row is not shown for a book that is not a PDF (Word only for a PDF)', !shown);
      } finally { await ctx.close(); }
    }
  } catch (e) { console.log('FAIL error', e); fails++; }
  await browser.close(); server.close();
  console.log(fails ? `${fails} failed` : 'all ok');
  process.exit(fails ? 1 : 0);
})();
