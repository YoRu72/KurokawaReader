// node tests/pdf2docxpagenum.cjs: PDF → Word page numbers and running heads. A made-up Arabic book of six pages
// (pdf-lib, a font of boxes built here), its pages numbered from 12, the text set close below the head and close
// above the foot (a little more than a line apart: no wide gap to go by):
// 1–3. A running head at the top, the page number at its outer edge — on the left on odd pages, on the right on
//      even ones — in Arabic-Indic digits (١٢, ١٣, ١٤); the odd pages' head and the even pages' head each repeat.
// 4.   No number and no running head: a heading at the top of the page, set apart from the text.
// 5–6. The number at the foot, centred, in Western digits between dashes ("- 16 -", "- 17 -").
// Word must have one section per page; the numbers in the header or footer, each a PAGE field in its place, its
// section starting at that number in the page's digits (so Word shows what the page shows); the running heads
// in the header; the heading of page 4 in the text, which holds no page number; a package whose parts are
// well-formed and whose relationships and content types agree. (Page numbers were static text, those set close
// to the text left in the body, and any line at the top set apart taken for a running head.)
// (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const JSZip = require('jszip'); const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const PORT = 5197;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-pagenum-'));

// ---- The font: a box per letter, digits (Arabic-Indic and Western), a dash, a space. ----
const G = []; // { name, adv, box?: [x0,y0,x1,y1], uni?: number, tu?: string }
const add = (g) => (G.push(g), G.length - 1);
add({ name: '.notdef', adv: 500 });
add({ name: 'space', adv: 250, uni: 0x20, tu: ' ' });
const L = {};
'ابتجدرسعلمنهوي'.split('').forEach((ch, i) => { L[ch] = add({ name: 'l' + i, adv: 500, box: [30, 0, 470, 500 + i * 10], uni: ch.codePointAt(0), tu: ch }); });
'٠١٢٣٤٥٦٧٨٩'.split('').forEach((ch, i) => { L[ch] = add({ name: 'd' + i, adv: 500, box: [60, 0, 440, 600], uni: ch.codePointAt(0), tu: ch }); });
'0123456789'.split('').forEach((ch, i) => { L[ch] = add({ name: 'w' + i, adv: 500, box: [60, 0, 440, 650], uni: ch.codePointAt(0), tu: ch }); });
L['-'] = add({ name: 'hyphen', adv: 300, box: [40, 200, 260, 260], uni: 0x2d, tu: '-' });

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
  const names = [[1, 'KrTest Folio'], [2, 'Regular'], [4, 'KrTest Folio'], [6, 'KrTestFolio']].map(([id, s]) => [id, nm(s)]);
  const name = be().u16(0).u16(names.length).u16(6 + names.length * 12); let off = 0;
  for (const [id, b] of names) { name.u16(3).u16(1).u16(0x409).u16(id).u16(b.length).u16(off); off += b.length; }
  for (const [, b] of names) name.bytes(b); tables.name = name.b;
  const os2 = be().u16(4).i16(500).u16(400).u16(5).u16(0).i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(250).i16(0);
  for (let i = 0; i < 10; i++) os2.u8(0);
  os2.u32(0x2003).u32(0).u32(0).u32(0).tag('KRTL').u16(0x40).u16(0x20).u16(0x6ff).i16(900).i16(-300).i16(0).u16(900).u16(300).u32(0x40).u32(0).i16(500).i16(700).u16(0).u16(0x20).u16(0);
  tables['OS/2'] = os2.b;
  const tags = Object.keys(tables).sort(); const out = be().u32(0x10000).u16(tags.length).u16(128).u16(3).u16(tags.length * 16 - 128);
  let at = 12 + tags.length * 16; const body = [];
  for (const t of tags) { const d = tables[t]; let sum = 0; for (let i = 0; i < d.length; i += 4) sum = (sum + ((d[i] << 24) | ((d[i + 1] || 0) << 16) | ((d[i + 2] || 0) << 8) | (d[i + 3] || 0))) >>> 0; out.tag(t).u32(sum).u32(at).u32(d.length); body.push(d); at += d.length; while (at % 4) { body.push([0]); at++; } }
  for (const d of body) out.bytes(d);
  return Uint8Array.from(out.b);
}

// ---- The PDF: the font as Word embeds it (Identity-H, its own /ToUnicode). ----
const hex = (gids) => `<${gids.map((g) => g.toString(16).padStart(4, '0')).join('')}>`;
const u16hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
// A word's glyphs left to right (a right-to-left word turned round, numbers kept in their order), its width.
const glyphs = (w) => (/^[٠-٩0-9-]+$/.test(w) ? [...w] : [...w].reverse()).map((c) => L[c]);
const width = (w, s) => [...w].reduce((t, c) => t + G[L[c]].adv, 0) * s / 1000;
const S = 14;
const at = (x, y, w, s = S) => `BT /F1 ${s} Tf 1 0 0 1 ${x.toFixed(2)} ${y} Tm ${hex(glyphs(w))} Tj ET\n`;
// Words from x = right leftwards, `sp` points apart.
const run = (right, y, ws, sp = 3.5, s = S) => { let x = right; let ops = ''; ws.forEach((w, i) => { x -= width(w, s); ops += at(x, y, w, s); if (i + 1 < ws.length) x -= sp; }); return [ops, x]; };
const spread = (left, right, y, ws) => { const sp = (right - left - ws.reduce((t, w) => t + width(w, S), 0)) / (ws.length - 1); return run(right, y, ws, sp)[0]; };
const W = ['سلام', 'علي', 'من', 'رب', 'دار', 'نور', 'جد', 'تين', 'هو', 'يد', 'سر', 'عين', 'باب', 'لين', 'مر', 'تم', 'دم', 'ود', 'نهر', 'بر', 'سد', 'مع', 'ري', 'عود'];
const fill = (k, span) => { const ws = []; let w = 0; for (let i = 0; ; i++) { const x = W[(i * 7 + k * 5) % W.length]; const nw = w + width(x, S) + (ws.length ? 3.5 : 0); if (nw > span - 2) break; ws.push(x); w = nw; } return ws; };
const RIGHT = 540, LEFT = 60, PITCH = 20;
const HEAD_ODD = ['باب', 'العلم'], HEAD_EVEN = ['كتاب', 'الادب'];
// (Letters the font lacks are left out of the heads: they only need to repeat.)
const clean = (ws) => ws.map((w) => [...w].filter((c) => L[c] !== undefined).join('')).filter(Boolean);
// A page's text: full lines from `top` down to `bottom`, a paragraph's last line short.
const text = (top, bottom, k) => { let ops = ''; let i = 0; for (let y = top; y >= bottom; y -= PITCH, i++) { const last = y - PITCH < bottom; ops += spread(last ? LEFT + 200 : LEFT, RIGHT, y, fill(k * 10 + i, last ? RIGHT - LEFT - 200 : RIGHT - LEFT)); } return ops; };
const NUMS = ['١٢', '١٣', '١٤', null, '- 16 -', '- 17 -'];
const HEADING = ['مدخل', 'الى', 'النحو'];
async function book() {
  const doc = await PDFDocument.create(); const ctx = doc.context;
  const data = ttf();
  const file = ctx.register(ctx.flateStream(data, { Length1: data.length }));
  const desc = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+KrTestFolio', Flags: 4, FontBBox: [-100, -300, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -300, CapHeight: 700, StemV: 80, FontFile2: file }));
  const cid = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'ABCDEF+KrTestFolio', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, FontDescriptor: desc, DW: 500, W: [0, G.map((g) => g.adv)], CIDToGIDMap: 'Identity' }));
  const bf = G.map((g, i) => [i, g.tu]).filter(([, t]) => t !== undefined);
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${bf.length} beginbfchar\n${bf.map(([g, t]) => `<${g.toString(16).padStart(4, '0')}> <${u16hex(t)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
  const tu = ctx.register(ctx.flateStream(cmap));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+KrTestFolio', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: tu }));
  for (let p = 0; p < 6; p++) {
    let ops = '';
    const num = NUMS[p];
    if (p < 3) {
      // Head at y 790: the number at the outer edge (odd pages: left; even: right), the head at the other; the
      // text from 767 (23 below: a line and a seventh).
      const head = clean(p % 2 === 0 ? HEAD_ODD : HEAD_EVEN);
      if (p % 2 === 0) ops += at(LEFT, 790, num, 12) + run(RIGHT, 790, head, 3.5, 12)[0];
      else ops += at(RIGHT - width(num, 12), 790, num, 12) + run(LEFT + 120, 790, head, 3.5, 12)[0];
      ops += text(767, 100, p);
    } else if (p === 3) {
      // A heading at 780, centred, the text from 740.
      const ws = clean(HEADING); const w = ws.reduce((t, x) => t + width(x, 18), 0) + 3.5 * (ws.length - 1);
      ops += run((LEFT + RIGHT) / 2 + w / 2, 780, ws, 3.5, 18)[0] + text(740, 100, p);
    } else {
      // The text down to 83, the number centred at 60 (23 below).
      ops += text(780, 83, p);
      const ws = num.split(' '); const w = ws.reduce((t, x) => t + width(x, 12), 0) + 3 * (ws.length - 1);
      ops += run((LEFT + RIGHT) / 2 + w / 2, 60, ws, 3, 12)[0];
    }
    const pg = doc.addPage([595, 842]); pg.node.setFontDictionary(PDFName.of('F1'), font); pg.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(ops)));
  }
  const f = path.join(tmp, 'p2d-pagenum.pdf'); fs.writeFileSync(f, await doc.save()); return f;
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

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    const { zip, page, ctx } = await convert(browser, await book());
    const xml = await zip.file('word/document.xml').async('string');
    const rels = await zip.file('word/_rels/document.xml.rels').async('string');
    const types = await zip.file('[Content_Types].xml').async('string');
    const relTarget = (id) => (new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`).exec(rels) || new RegExp(`Target="([^"]+)"[^>]*Id="${id}"`).exec(rels) || [])[1];
    const tx = (s) => [...s.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    // Sections: the body split at each section's properties; each with its header and footer parts.
    const sps = [...xml.matchAll(/<w:sectPr>[\s\S]*?<\/w:sectPr>/g)].map((m) => m[0]);
    const bodies = xml.split(/<w:sectPr>[\s\S]*?<\/w:sectPr>/).slice(0, -1);
    ok(`six pages, six sections (${sps.length})`, sps.length === 6);
    const part = async (sp, kind) => { const id = (new RegExp(`<w:${kind}Reference [^>]*r:id="([^"]+)"`).exec(sp) || [])[1]; const t = id && relTarget(id); return t && zip.file('word/' + t) ? zip.file('word/' + t).async('string') : ''; };
    const fieldRe = /<w:instrText[^>]*> PAGE <\/w:instrText>/;
    for (let p = 0; p < Math.min(6, sps.length); p++) {
      const sp = sps[p]; const hdr = await part(sp, 'header'); const ftr = await part(sp, 'footer');
      const pn = /<w:pgNumType([^>]*)\/>/.exec(sp)?.[1] ?? '';
      const start = /w:start="(\d+)"/.exec(pn)?.[1], fmt = /w:fmt="(\w+)"/.exec(pn)?.[1];
      const want = [12, 13, 14, null, 16, 17][p];
      const bodyText = norm(tx(bodies[p]));
      if (want === null) {
        ok(`page 4: no PAGE field — header ${JSON.stringify(norm(tx(hdr)))}, footer ${JSON.stringify(norm(tx(ftr)))}`, !fieldRe.test(hdr) && !fieldRe.test(ftr));
        ok(`page 4: its heading stays in the text, the header holds no text — body starts ${JSON.stringify(bodyText.slice(0, 30))}`, bodyText.startsWith(norm(clean(HEADING).join(' '))) && !norm(tx(hdr)));
        continue;
      }
      const inHead = p < 3; const where = inHead ? hdr : ftr;
      const shown = NUMS[p].replace(/[^0-9٠-٩]/g, '');
      ok(`page ${p + 1}: the number a PAGE field in the ${inHead ? 'header' : 'footer'}, showing ${shown}`, fieldRe.test(where) && new RegExp(`fldCharType="separate"/></w:r>(?:<w:r>(?:<w:rPr>[\\s\\S]*?</w:rPr>)?<w:t[^>]*>${shown}</w:t></w:r>)+<w:r>(?:<w:rPr>[\\s\\S]*?</w:rPr>)?<w:fldChar w:fldCharType="end"/>`).test(where));
      ok(`page ${p + 1}: its section starts at ${want} in ${p < 3 ? 'hindiNumbers' : 'decimal'} (pgNumType${pn})`, start === String(want) && fmt === (p < 3 ? 'hindiNumbers' : 'decimal'));
      ok(`page ${p + 1}: the text holds no page number — ${JSON.stringify(bodyText.slice(-40))}`, !/[0-9٠-٩]/.test(bodyText));
      if (inHead) {
        const head = norm(clean(p % 2 === 0 ? HEAD_ODD : HEAD_EVEN).join(' '));
        ok(`page ${p + 1}: the running head in the header`, norm(tx(hdr)).includes(head) && !bodyText.includes(head));
        // The number keeps its side: the field before the head on odd pages (left), after it on even ones.
        const f = where.search(fieldRe), h = where.indexOf('<w:t xml:space="preserve">' + head.split(' ')[0]);
        ok(`page ${p + 1}: the number on the ${p % 2 === 0 ? 'left' : 'right'}, as the page has it`, f >= 0 && h >= 0 && (p % 2 === 0 ? f < h : f > h));
      } else ok(`page ${p + 1}: the dashes round the number stay plain text by it`, /-/.test(tx(ftr)));
    }
    // The package: every XML part well-formed, every relationship's target there, a content type for each part.
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const xmls = {}; for (const n of names.filter((n) => /\.(xml|rels)$/.test(n))) xmls[n] = await zip.file(n).async('string');
    const bad = await page.evaluate((all) => Object.entries(all).filter(([, s]) => new DOMParser().parseFromString(s, 'application/xml').getElementsByTagName('parsererror').length).map(([n]) => n), xmls);
    ok(`every XML part is well-formed ${JSON.stringify(bad)}`, !bad.length);
    const missing = [];
    for (const n of names.filter((n) => n.endsWith('.rels'))) {
      const base = n.replace(/_rels\/[^/]*$/, '');
      for (const m of xmls[n].matchAll(/<Relationship [^>]*>/g)) { if (/TargetMode="External"/.test(m[0])) continue; const t = /Target="([^"]+)"/.exec(m[0])[1]; const full = path.posix.normalize(base + t); if (!zip.file(full)) missing.push(n + ' → ' + full); }
    }
    ok(`every relationship's target is in the package ${JSON.stringify(missing.slice(0, 5))}`, !missing.length);
    const untyped = names.filter((n) => !n.startsWith('[') && !types.includes(`PartName="/${n}"`) && !types.includes(`Extension="${n.split('.').pop()}"`));
    ok(`every part has a content type ${JSON.stringify(untyped.slice(0, 5))}`, !untyped.length);
    const hf = names.filter((n) => /^word\/(header|footer)\d+\.xml$/.test(n));
    ok(`each header and footer part declared as one (${hf.length})`, hf.every((n) => types.includes(`PartName="/${n}" `) || types.includes(`PartName="/${n}"`)) && hf.every((n) => types.includes(`wordprocessingml.${n.includes('header') ? 'header' : 'footer'}+xml" PartName="/${n}"`) || new RegExp(`PartName="/${n}"[^>]*wordprocessingml\\.${n.includes('header') ? 'header' : 'footer'}\\+xml`).test(types)));
    await ctx.close();
  } catch (e) { console.log('FAIL', e); fails++; }
  await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
