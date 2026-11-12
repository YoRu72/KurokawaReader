// node tests/pdf2docxlines.cjs: PDF → Word keeps apart what the page sets apart — paragraphs, list items, the
// two halves of a verse and verse after verse — and keeps together what is one. A made-up Arabic book (pdf-lib),
// set in a small font built here (each letter a box; a tatweel; Arabic digits):
// 1. A page in one column whose long lines happen to leave a gap at one place, the short lines of single-line list
//    items stopping short of it: no gutter. (The ends of the long lines were taken for a column of their own,
//    the long lines cut in two, the items above them run into one paragraph.)
// 2. Paragraphs set a little further apart than their lines (1.3 times), each first line set in: a new paragraph
//    after a last line that stops just short of the measure; after a paragraph of one full line set in; before
//    a numbered item at the margin. A line set lower in its paragraph (taller glyphs), not set in: the same
//    paragraph. (All ran on as one paragraph: the step was measured against the page's median, the space
//    between paragraphs on a page of short ones, or against 1.45 times the paragraph's own.)
// 3. Verses numbered at their start ("٥٢ ــــ"), the gap between the halves in the middle of the verse's text, not
//    of the line with its number: a verse table, each half in its cell, the number with the first half. (The
//    number moved the line's middle off the gap: the verses ran on as the lines of one justified paragraph.)
// 4. A lone verse numbered at its start ("-٦٥") among prose, one half stretched with tatweel: a verse too.
// (KR_DIST=<dir> runs it against another build.)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const JSZip = require('jszip'); const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const PORT = 5196;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-lines-'));

// ---- The font: a box per letter, a tatweel, digits, a space; its Unicode map (cmap) and /ToUnicode names. ----
const G = []; // { name, adv, box?: [x0,y0,x1,y1], uni?: number, tu?: string }
const add = (g) => (G.push(g), G.length - 1);
add({ name: '.notdef', adv: 500 });
const SPACE = add({ name: 'space', adv: 250, uni: 0x20, tu: ' ' });
const L = {};
'ابتجدرسعلمنهوي'.split('').forEach((ch, i) => { L[ch] = add({ name: 'l' + i, adv: 500, box: [30, 0, 470, 500 + i * 10], uni: ch.codePointAt(0), tu: ch }); });
'٠١٢٣٤٥٦٧٨٩'.split('').forEach((ch, i) => { L[ch] = add({ name: 'd' + i, adv: 500, box: [60, 0, 440, 600], uni: ch.codePointAt(0), tu: ch }); });
L['ـ'] = add({ name: 'tatweel', adv: 250, box: [0, 0, 250, 60], uni: 0x640, tu: 'ـ' });
L['-'] = add({ name: 'hyphen', adv: 300, box: [40, 200, 260, 260], uni: 0x2d, tu: '-' });
L[')'] = add({ name: 'parenright', adv: 300, box: [60, -100, 240, 650], uni: 0x29, tu: ')' });

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
  const names = [[1, 'KrTest Lines'], [2, 'Regular'], [4, 'KrTest Lines'], [6, 'KrTestLines']].map(([id, s]) => [id, nm(s)]);
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

// ---- The PDF: the font as Word embeds it (Identity-H, its own /ToUnicode), one page per case. ----
const hex = (gids) => `<${gids.map((g) => g.toString(16).padStart(4, '0')).join('')}>`;
const u16hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
// A word's glyphs in drawing order (left to right: a right-to-left word turned round, its digits kept in their
// order) and its width at size s.
const glyphs = (w) => (/^[٠-٩)]+$/.test(w) ? [...w] : [...w].reverse()).map((c) => L[c]);
const width = (w, s) => [...w].reduce((t, c) => t + G[L[c]].adv, 0) * s / 1000;
const S = 14;
const at = (x, y, gids) => `BT /F1 ${S} Tf 1 0 0 1 ${x.toFixed(2)} ${y} Tm ${hex(gids)} Tj ET\n`;
// Words from x = right leftwards, `sp` points apart (a gap, no space drawn); returns [ops, left edge].
const run = (right, y, words, sp = 3.5) => { let x = right; let ops = ''; words.forEach((w, i) => { x -= width(w, S); ops += at(x, y, glyphs(w)); if (i + 1 < words.length) x -= sp; }); return [ops, x]; };
// Words spread over [left, right] exactly, the gaps between them equal.
const spread = (left, right, y, words) => { const sp = (right - left - words.reduce((t, w) => t + width(w, S), 0)) / (words.length - 1); return run(right, y, words, sp)[0]; };
const W = ['سلام', 'علي', 'من', 'رب', 'دار', 'نور', 'جد', 'تين', 'هو', 'يد', 'سر', 'عين', 'باب', 'لين', 'مر', 'تم', 'دم', 'ود', 'نهر', 'بر', 'سد', 'مع', 'ري', 'عود'];
const words = (n, k = 0) => Array.from({ length: n }, (_, i) => W[(i * 7 + k * 5) % W.length]);
// As many words as fill a span set close (3.5 pt apart, as prose is).
const fill = (k, span) => { const ws = []; let w = 0; for (let i = 0; ; i++) { const x = W[(i * 7 + k * 5) % W.length]; const nw = w + width(x, S) + (ws.length ? 3.5 : 0); if (nw > span - 2) break; ws.push(x); w = nw; } return ws; };
const RIGHT = 540, LEFT = 60;
async function book() {
  const doc = await PDFDocument.create(); const ctx = doc.context;
  const data = ttf();
  const file = ctx.register(ctx.flateStream(data, { Length1: data.length }));
  const desc = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+KrTestLines', Flags: 4, FontBBox: [-100, -300, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -300, CapHeight: 700, StemV: 80, FontFile2: file }));
  const cid = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'ABCDEF+KrTestLines', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, FontDescriptor: desc, DW: 500, W: [0, G.map((g) => g.adv)], CIDToGIDMap: 'Identity' }));
  const bf = G.map((g, i) => [i, g.tu]).filter(([, t]) => t !== undefined);
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${bf.length} beginbfchar\n${bf.map(([g, t]) => `<${g.toString(16).padStart(4, '0')}> <${u16hex(t)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
  const tu = ctx.register(ctx.flateStream(cmap));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+KrTestLines', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: tu }));
  const page = (ops) => { const p = doc.addPage([595, 842]); p.node.setFontDictionary(PDFName.of('F1'), font); p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(ops))); };
  const full = (y, k) => spread(LEFT, RIGHT, y, fill(k, RIGHT - LEFT));
  // 1. Two full lines; then three times: a one-line item stopping at x 250; an item of a long line whose words
  //    leave a gap from x 165 to 195 (the rest spread over the measure) and a last line of one word.
  {
    let ops = full(760, 1) + full(736, 2); let y = 700;
    for (let i = 0; i < 3; i++) {
      ops += spread(250, RIGHT, y, ['١', ...fill(i, RIGHT - 250 - 10)]); y -= 24;
      const head = ['٢', ...fill(i + 3, RIGHT - 195 - 10)]; const tail = fill(i + 6, 165 - LEFT);
      ops += spread(195, RIGHT, y, head) + spread(LEFT, 165, y, tail); y -= 18;
      ops += run(RIGHT, y, ['باب'])[0]; y -= 24;
    }
    page(ops);
  }
  // 2. Line pitch 20, paragraphs 26 apart, a paragraph's first line set in 20.
  {
    let ops = ''; let y = 760;
    // (Paragraph k's line i: words fill(k * 10 + i), spread over the line's span.)
    const lineAt = (k, i, left, right) => { ops += spread(left, right, y, fill(k * 10 + i, right - left)); };
    const para = (n, k, lastShort = 30) => { for (let i = 0; i < n; i++) { const last = i === n - 1; lineAt(k, i, last ? LEFT + lastShort : LEFT, i === 0 ? RIGHT - 20 : RIGHT); if (!last) y -= 20; } };
    para(3, 0, 14); y -= 26;          // A: its last line stops 14 short (no "short line")
    para(2, 1); y -= 26;              // B: after A, set in
    para(1, 2, 0); y -= 26;           // C: one full line set in
    para(2, 3); y -= 26;              // D: after C, set in as far
    // E: a list: an item of two full lines at the margin, then item "٢ -" at the margin.
    ops += spread(LEFT, RIGHT, y, ['١', '-', ...fill(40, RIGHT - LEFT - 30)]); y -= 20;
    lineAt(4, 1, LEFT, RIGHT); y -= 26;
    ops += spread(LEFT, RIGHT, y, ['٢', '-', ...fill(50, RIGHT - LEFT - 30)]); y -= 20;
    lineAt(5, 1, LEFT + 200, RIGHT); y -= 26;
    // F: four lines, the third set 25 below the second (taller glyphs), not set in: one paragraph.
    lineAt(6, 0, LEFT, RIGHT - 20); y -= 20;
    lineAt(6, 1, LEFT, RIGHT); y -= 25;
    lineAt(6, 2, LEFT, RIGHT); y -= 20;
    lineAt(6, 3, LEFT + 150, RIGHT);
    page(ops);
  }
  // 3. Four verses: "٥٢" and a stretch at the right edge, then the two halves, 20 apart, the gap in the middle of
  //    the verse's text (x 60 to 508): halves 294–508 and 60–274.
  {
    let ops = ''; let y = 700;
    for (let i = 0; i < 4; i++) {
      const num = ['٥٢', '٥٣', '٥٤', '٥٥'][i];
      ops += at(RIGHT - width(num, S), y, glyphs(num)) + at(512, y, [L['ـ'], L['ـ'], L['ـ'], L['ـ']]);
      ops += spread(294, 508, y, fill(i, 214)) + spread(LEFT, 274, y, fill(i + 4, 214));
      y -= 26;
    }
    page(ops);
  }
  // 4. Prose, a lone verse "-٦٥" (its right half stretched with tatweel), its text from x 60 to 516, the halves
  //    16 apart; prose.
  {
    let ops = full(760, 1) + full(740, 2) + full(720, 3); const y = 694;
    ops += at(RIGHT - width('٦٥', S), y, glyphs('٦٥')) + at(RIGHT - width('٦٥', S) - 4.2, y, [L['-']]);
    ops += spread(296, 516, y, ['سلـــام', ...fill(7, 220 - 50)]) + spread(LEFT, 280, y, fill(8, 220));
    ops += full(668, 4) + full(648, 5) + full(628, 6);
    page(ops);
  }
  const f = path.join(tmp, 'p2d-lines.pdf'); fs.writeFileSync(f, await doc.save()); return f;
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
    // A paragraph's text, a line break as "\n", a tab as a space; tables apart.
    const text = (p) => [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:br\/>|<w:tab\/>/g)].map((x) => (x[1] !== undefined ? x[1] : x[0] === '<w:br/>' ? '\n' : ' ')).join('');
    const paras = (s) => [...s.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, '').matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => text(p[0])).filter((t) => t.trim());
    const tables = (s) => [...s.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((t) => [...t[0].matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => text(c[0]).replace(/\s+/g, ' ').trim())));
    const secs = xml.split(/<w:sectPr[ >]/).slice(0, -1);
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const show = (s) => JSON.stringify(s);
    // (A page wrongly set in columns is two sections: the first page is all but the last three.)
    ok(`four pages, four sections (${secs.length})`, secs.length === 4);
    // 1.
    const p1 = paras(secs.slice(0, -3).join(''));
    for (let i = 0; i < 3; i++) {
      const long = norm(['٢', ...fill(i + 3, RIGHT - 195 - 10), ...fill(i + 6, 165 - LEFT)].join(' '));
      ok(`1. a long line keeps its last words: "${long}" — ${show(p1)}`, p1.some((p) => p.split('\n').some((l) => norm(l) === long)));
      const one = norm(['١', ...fill(i, RIGHT - 250 - 10)].join(' '));
      ok(`1. a one-line item is a paragraph of its own: "${one}"`, p1.some((p) => norm(p) === one));
    }
    // 2.
    const p2 = paras(secs[secs.length - 3] ?? '');
    const lineText = (k, i, left, right) => norm(fill(k * 10 + i, right - left).join(' '));
    const first = (p) => norm(p.split('\n')[0]);
    ok(`2. B (after a last line just short of the measure) starts a paragraph — ${show(p2.map(first))}`, p2.some((p) => first(p) === lineText(1, 0, LEFT, RIGHT - 20)));
    ok(`2. D (after a paragraph of one full line set in) starts a paragraph`, p2.some((p) => first(p) === lineText(3, 0, LEFT, RIGHT - 20)));
    ok(`2. C (one full line set in) is a paragraph of its own`, p2.some((p) => norm(p) === lineText(2, 0, LEFT, RIGHT - 20)));
    ok(`2. the numbered item "٢ -" starts a paragraph`, p2.some((p) => first(p) === norm(['٢', '-', ...fill(50, RIGHT - LEFT - 30)].join(' '))));
    const f = p2.find((p) => first(p) === lineText(6, 0, LEFT, RIGHT - 20));
    ok(`2. a line set lower in its paragraph, not set in, stays in it — ${show(f)}`, !!f && f.split('\n').length === 4);
    // 3.
    const t3 = tables(secs[secs.length - 2] ?? '');
    ok(`3. the verses are a table of four rows, two cells each — ${show(t3)}`, t3.length === 1 && t3[0].length === 4 && t3[0].every((r) => r.length === 2));
    if (t3.length === 1 && t3[0].length === 4) t3[0].forEach((r, i) => {
      ok(`3. verse ${i + 1}: its number with the first half, the second half apart — ${show(r)}`, r[0].startsWith(['٥٢', '٥٣', '٥٤', '٥٥'][i]) && r[0].endsWith(norm(fill(i, 214).join(' '))) && r[1] === norm(fill(i + 4, 214).join(' ')));
    });
    // 4.
    const t4 = tables(secs[secs.length - 1] ?? '');
    ok(`4. a lone numbered verse is a verse — ${show(t4)}`, t4.length === 1 && t4[0].length === 1 && t4[0][0].length === 2 && t4[0][0][1] === norm(fill(8, 220).join(' ')) && /٦٥/.test(t4[0][0][0]));
  } catch (e) { console.log('FAIL', e); fails++; }
  await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
