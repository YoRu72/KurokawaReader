// Reads a converted .docx (word/document.xml, styles, numbering, footnotes, headers/footers, rels) and scores it against
// corpus2/source.json, one number 0-1 per measure (null = not applicable to this PDF). Pure: no browser, no external programs.
// Used by tests/pdf2docxcorpus.cjs. Measures are documented next to their code below.
const JSZip = require('jszip');

// ---------- a small XML tree reader (no dependencies) ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e]);
function parseXml(xml) {
  const root = { tag: '#root', attrs: {}, kids: [] }; const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g; let m;
  while ((m = re.exec(xml))) {
    if (m[6] !== undefined) { const top = stack[stack.length - 1]; top.kids.push({ tag: '#text', text: unesc(m[6]) }); continue; }
    if (m[1] !== undefined) { stack[stack.length - 1].kids.push({ tag: '#text', text: m[1] }); continue; }
    if (m[2] === '/') { stack.pop(); continue; }
    if (m[3] === undefined) continue;
    const attrs = {}; for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unesc(a[2] ?? a[3]);
    const node = { tag: m[3], attrs, kids: [] }; stack[stack.length - 1].kids.push(node); if (m[5] !== '/') stack.push(node);
  }
  return root;
}
const kid = (n, tag) => n && n.kids.find((k) => k.tag === tag);
const kidsOf = (n, tag) => (n ? n.kids.filter((k) => k.tag === tag) : []);
const attr = (n, a) => (n && n.attrs ? n.attrs[a] : undefined);
const on = (n) => !!n && !['0', 'false', 'off', 'none'].includes((n.attrs['w:val'] ?? 'true').toLowerCase());
const textOf = (n) => (n.tag === '#text' ? n.text : n.kids.map(textOf).join(''));
function* descend(n) { for (const k of n.kids || []) { yield k; yield* descend(k); } }

// ---------- reading the package ----------
async function readDocx(buf) {
  const zip = await JSZip.loadAsync(buf); const get = async (p) => (zip.file(p) ? parseXml(await zip.file(p).async('string')) : null);
  const D = { zip };
  D.rels = {}; const rels = await get('word/_rels/document.xml.rels');
  if (rels) for (const r of descend(rels)) if (r.tag === 'Relationship') D.rels[r.attrs.Id] = { type: r.attrs.Type, target: r.attrs.Target, external: r.attrs.TargetMode === 'External' };
  // styles
  D.styles = {}; const st = await get('word/styles.xml');
  if (st) for (const s of descend(st)) if (s.tag === 'w:style') {
    const ppr = kid(s, 'w:pPr'), rpr = kid(s, 'w:rPr');
    D.styles[s.attrs['w:styleId']] = { name: (attr(kid(s, 'w:name'), 'w:val') || '').toLowerCase(), basedOn: attr(kid(s, 'w:basedOn'), 'w:val'),
      outline: ppr && kid(ppr, 'w:outlineLvl') ? +attr(kid(ppr, 'w:outlineLvl'), 'w:val') : undefined, bidi: ppr && kid(ppr, 'w:bidi') ? on(kid(ppr, 'w:bidi')) : undefined,
      jc: ppr && kid(ppr, 'w:jc') ? attr(kid(ppr, 'w:jc'), 'w:val') : undefined, num: ppr && kid(ppr, 'w:numPr') ? numPrOf(kid(ppr, 'w:numPr')) : undefined, bold: rpr && kid(rpr, 'w:b') ? on(kid(rpr, 'w:b')) : undefined };
  }
  // numbering: numId -> abstract -> level formats
  D.numFmt = {}; D.numLv = {}; D.counters = {}; const nb = await get('word/numbering.xml');
  if (nb) {
    const abs = {}, absLv = {}; for (const a of descend(nb)) if (a.tag === 'w:abstractNum') { const id = a.attrs['w:abstractNumId']; abs[id] = {}; absLv[id] = {}; for (const l of kidsOf(a, 'w:lvl')) { abs[id][l.attrs['w:ilvl']] = attr(kid(l, 'w:numFmt'), 'w:val'); absLv[id][l.attrs['w:ilvl']] = { fmt: attr(kid(l, 'w:numFmt'), 'w:val'), start: +(attr(kid(l, 'w:start'), 'w:val') || 1), text: attr(kid(l, 'w:lvlText'), 'w:val') || '', ind: indOf(kid(kid(l, 'w:pPr'), 'w:ind')) }; } }
    for (const n of descend(nb)) if (n.tag === 'w:num') { D.numFmt[n.attrs['w:numId']] = abs[attr(kid(n, 'w:abstractNumId'), 'w:val')] || {}; D.numLv[n.attrs['w:numId']] = absLv[attr(kid(n, 'w:abstractNumId'), 'w:val')] || {}; }
  }
  D.kindOf = (num) => { if (!num) return null; const f = (D.numFmt[num.id] || {})[String(num.lvl)]; return f === undefined ? 'number' : f === 'bullet' ? 'bullet' : f === 'none' ? 'none' : 'number'; };
  // body
  const doc = await get('word/document.xml'); D.body = kid(kid(doc, 'w:document'), 'w:body') || { kids: [] };
  D.paras = []; D.tables = []; D.links = []; D.footRefs = 0; D.drawings = 0; D.smallDrawings = 0; D.hfPics = 0; D.sectCols = []; D.fieldsPage = 0;
  walkBody(D, D.body, { table: null, box: false });
  { const last = kid(D.body, 'w:sectPr'); if (last) { const sec = sectOf(last); for (const q of D.unsect || []) q.sect = sec; } D.unsect = []; }
  for (const s of descend(D.body)) if (s.tag === 'w:sectPr') { const c = kid(s, 'w:cols'); D.sectCols.push(c ? +(c.attrs['w:num'] || (kidsOf(c, 'w:col').length || 1)) : 1); }
  // footnotes
  D.footnotes = []; const fn = await get('word/footnotes.xml');
  if (fn) for (const f of descend(fn)) if (f.tag === 'w:footnote' && !['separator', 'continuationSeparator', 'continuationNotice'].includes(f.attrs['w:type'] || '')) D.footnotes.push([...descend(f)].filter((x) => x.tag === 'w:p').map((p) => paraText(p)).join(' ').trim());
  // headers / footers
  D.hf = [];
  for (const r of Object.values(D.rels)) if (/\/(header|footer)$/.test(r.type)) {
    const x = await get('word/' + r.target.replace(/^\.?\//, '')); if (!x) continue;
    const ps = [...descend(x)].filter((n) => n.tag === 'w:p').map(paraText).join(' ').trim();
    const page = [...descend(x)].some((n) => (n.tag === 'w:instrText' && /\bPAGE\b/.test(textOf(n))) || (n.tag === 'w:fldSimple' && /\bPAGE\b/.test(n.attrs['w:instr'] || '')) || n.tag === 'w:pgNum');
    D.hfPics += bigPics(x).big; D.hfStrips = (D.hfStrips || 0) + thinStrips(x); D.hf.push({ kind: /\/header$/.test(r.type) ? 'header' : 'footer', text: ps, page });
  }
  return D;
}
// A "picture" here is a drawing of at least 4 x 2 cm (the figure is 8 x 4.2 cm); smaller ones are the converter's bullets, rules and marks.
function bigPics(n) { let c = 0, small = 0; for (const d of descend(n)) if (d.tag === 'w:drawing' || d.tag === 'w:pict') { const ex = [...descend(d)].find((x) => x.tag === 'wp:extent'); const hasImg = [...descend(d)].some((x) => x.tag === 'a:blip' || x.tag === 'v:imagedata'); if (!hasImg) continue; if (ex && +ex.attrs.cx >= 1440000 && +ex.attrs.cy >= 720000) c++; else small++; } return { big: c, small }; }
// A picture pinned to the page in a header/footer part that is only a thin horizontal strip (at most 10 pt high, at least twice as
// wide): a stroke of the page's drawing (an underline, a rule) left pinned while the text flows - a stray decoration.
function thinStrips(n) { let c = 0; for (const d of descend(n)) if (d.tag === 'wp:anchor') { const ex = [...descend(d)].find((x) => x.tag === 'wp:extent'); if (!ex || ![...descend(d)].some((x) => x.tag === 'a:blip')) continue; const cx = +ex.attrs.cx, cy = +ex.attrs.cy; if (cy <= 127000 && cx >= 38100 && cx >= 2 * cy) c++; } return c; }
// A w:ind as numbers (twips): start (or left), end (or right), hanging (positive) or firstLine (negative hanging); undefined when absent.
function indOf(n) { if (!n) return undefined; const g = (a) => (n.attrs[a] !== undefined ? +n.attrs[a] : undefined); return { start: g('w:start') ?? g('w:left'), end: g('w:end') ?? g('w:right'), hanging: g('w:hanging') !== undefined ? g('w:hanging') : g('w:firstLine') !== undefined ? -g('w:firstLine') : undefined }; }
function sectOf(sp) { const sz = kid(sp, 'w:pgSz'), mg = kid(sp, 'w:pgMar'), c = kid(sp, 'w:cols'); return { w: +(attr(sz, 'w:w') || 11906), left: +(attr(mg, 'w:left') || 1440), right: +(attr(mg, 'w:right') || 1440), cols: c ? +(c.attrs['w:num'] || 1) : 1 }; }
function paraText(p) { let t = ''; for (const n of descend(p)) { if (n.tag === 'w:t') t += textOf(n); else if (n.tag === 'w:tab') t += ' '; else if (n.tag === 'w:br') t += ' '; } return t; }
function numPrOf(np) { const id = attr(kid(np, 'w:numId'), 'w:val'); if (id === undefined || id === '0') return undefined; return { id, lvl: +(attr(kid(np, 'w:ilvl'), 'w:val') || 0) }; }

function walkBody(D, node, ctx) {
  for (const k of node.kids || []) {
    if (k.tag === 'w:p') readPara(D, k, ctx);
    else if (k.tag === 'w:tbl') readTable(D, k, ctx);
    else if (k.tag === 'w:sdt') { const c = kid(k, 'w:sdtContent'); if (c) walkBody(D, c, ctx); }
    else if (k.tag === 'mc:AlternateContent') { const c = kid(k, 'mc:Choice'); if (c) walkBody(D, c, ctx); }
    else if (k.tag === 'w:customXml' || k.tag === 'w:ins' || k.tag === 'w:smartTag') walkBody(D, k, ctx);
  }
}
function readTable(D, tbl, ctx) {
  const T = { rows: [], gridCols: kidsOf(kid(tbl, 'w:tblGrid'), 'w:gridCol').length, bidiVisual: !!kid(kid(tbl, 'w:tblPr'), 'w:bidiVisual'), nested: !!ctx.table }; const idx = D.tables.length; D.tables.push(T);
  for (const tr of kidsOf(tbl, 'w:tr')) {
    const row = { header: !!kid(kid(tr, 'w:trPr'), 'w:tblHeader'), cells: [] }; T.rows.push(row);
    for (const tc of kidsOf(tr, 'w:tc')) {
      const pr = kid(tc, 'w:tcPr'); const cell = { span: +(attr(kid(pr, 'w:gridSpan'), 'w:val') || 1), vm: kid(pr, 'w:vMerge') ? (attr(kid(pr, 'w:vMerge'), 'w:val') === 'restart' ? 'restart' : 'continue') : '', paras: [] };
      const before = D.paras.length; walkBody(D, tc, { table: ctx.table || { idx, row: T.rows.length - 1 }, box: ctx.box }); cell.paras = D.paras.slice(before); cell.text = cell.paras.map((p) => p.text).join('\n').trim(); row.cells.push(cell);
    }
  }
}
function styleChain(D, id) { const out = []; let s = id, n = 0; while (s && D.styles[s] && n++ < 12) { out.push(D.styles[s]); s = D.styles[s].basedOn; } return out; }
function readPara(D, p, ctx) {
  const pr = kid(p, 'w:pPr'); const sid = attr(kid(pr, 'w:pStyle'), 'w:val'); const chain = styleChain(D, sid);
  const res = (get) => { if (pr) { const v = get(pr, true); if (v !== undefined) return v; } for (const s of chain) { const v = get(s, false); if (v !== undefined) return v; } return undefined; };
  const outline = res((o, direct) => direct ? (kid(o, 'w:outlineLvl') ? +attr(kid(o, 'w:outlineLvl'), 'w:val') : undefined) : o.outline);
  const bidi = res((o, direct) => direct ? (kid(o, 'w:bidi') ? on(kid(o, 'w:bidi')) : undefined) : o.bidi);
  const jc = res((o, direct) => direct ? (kid(o, 'w:jc') ? attr(kid(o, 'w:jc'), 'w:val') : undefined) : o.jc);
  const num = res((o, direct) => direct ? (kid(o, 'w:numPr') ? numPrOf(kid(o, 'w:numPr')) : undefined) : o.num);
  let heading = null; // {level}  (Title -> level 0)
  if (outline !== undefined && outline < 9) heading = { level: outline + 1 };
  for (const s of chain) { const m = /^heading (\d)/.exec(s.name); if (m && !heading) heading = { level: +m[1] }; if (s.name === 'title' && !heading) heading = { level: 0, title: true }; }
  const P = { text: '', runs: [], style: sid, styleName: chain[0]?.name || '', heading, num, numKind: D.kindOf(num), bidi: !!bidi, jc, table: ctx.table, box: ctx.box, pics: 0, rtlRuns: 0, frame: !!kid(pr, 'w:framePr'), ind: indOf(kid(pr, 'w:ind')) };
  // (Its section: the next w:sectPr in the body — this paragraph's own, or a later one.)
  (D.unsect ??= []).push(P); const sp = kid(pr, 'w:sectPr'); if (sp) { const sec = sectOf(sp); for (const q of D.unsect) q.sect = sec; D.unsect = []; }
  D.paras.push(P); const boxes = [];
  // (A list item's number as Word shows it — what the reader sees of the list: counted per list and level.)
  if (num && P.numKind === 'number') { const lv = (D.numLv[num.id] || {})[String(num.lvl)]; if (lv) { const c = D.counters[num.id] ??= {}; for (const k of Object.keys(c)) if (+k > num.lvl) delete c[k]; c[num.lvl] = c[num.lvl] === undefined ? lv.start : c[num.lvl] + 1; const n = c[num.lvl]; const v = lv.fmt === 'lowerLetter' ? String.fromCharCode(96 + n) : lv.fmt === 'upperLetter' ? String.fromCharCode(64 + n) : lv.fmt === 'lowerRoman' ? ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][n - 1] || String(n) : lv.fmt === 'upperRoman' ? ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n - 1] || String(n) : lv.fmt === 'hindiNumbers' ? String(n).replace(/\d/g, (d) => String.fromCharCode(0x660 + +d)) : String(n); P.label = lv.text.replace(/%\d/, v); } }
  const fieldStack = []; // complex fields: {instr, link}
  const run = (r, link) => {
    const rp = kid(r, 'w:rPr'); const rf = kid(rp, 'w:rFonts');
    const R = { text: '', b: rp && kid(rp, 'w:b') ? on(kid(rp, 'w:b')) : false, i: rp && kid(rp, 'w:i') ? on(kid(rp, 'w:i')) : false, font: (rf && (rf.attrs['w:ascii'] || rf.attrs['w:hAnsi'] || rf.attrs['w:cs'] || rf.attrs['w:eastAsia'])) || '', link };
    if (rp && kid(rp, 'w:rtl') && on(kid(rp, 'w:rtl'))) P.rtlRuns++;
    // (For runs_plain: the run's look as written, its size, and whether it holds only text.)
    R.sig = rp ? JSON.stringify(rp) : ''; R.sz = rp && kid(rp, 'w:sz') ? +attr(kid(rp, 'w:sz'), 'w:val') : null; R.plain = r.kids.every((c) => c.tag === 'w:rPr' || c.tag === 'w:t'); R.field = fieldStack.length > 0;
    for (const c of r.kids) {
      if (c.tag === 'w:t') R.text += textOf(c);
      else if (c.tag === 'w:tab' || c.tag === 'w:br' || c.tag === 'w:noBreakHyphen') R.text += c.tag === 'w:noBreakHyphen' ? '-' : ' ';
      else if (c.tag === 'w:footnoteReference' || c.tag === 'w:endnoteReference') { D.footRefs++; R.text += String(D.footRefs); R.foot = true; }
      else if (c.tag === 'w:instrText') { const f = fieldStack[fieldStack.length - 1]; if (f) f.instr += textOf(c); }
      else if (c.tag === 'w:fldChar') {
        const t = c.attrs['w:fldCharType'];
        if (t === 'begin') fieldStack.push({ instr: '', link: null }); else if (t === 'end') fieldStack.pop();
        else if (t === 'separate') { const f = fieldStack[fieldStack.length - 1]; if (f) { const m = /HYPERLINK\s+"([^"]+)"/.exec(f.instr); if (m) { f.link = { target: m[1] }; D.links.push(f.link); } if (/\bPAGE\b/.test(f.instr)) D.fieldsPage++; } }
      } else if (c.tag === 'w:drawing' || c.tag === 'w:pict' || c.tag === 'w:object') {
        let hasText = false; for (const d of descend(c)) if (d.tag === 'w:txbxContent') { hasText = true; boxes.push(d); }
        if (!hasText) { const bp = bigPics({ kids: [c] }); P.pics += bp.big; D.drawings += bp.big; D.smallDrawings += bp.small; }
      } else if (c.tag === 'mc:AlternateContent') { const ch = kid(c, 'mc:Choice'); if (ch) for (const x of ch.kids) if (x.tag === 'w:drawing' || x.tag === 'w:pict') { let hasText = false; for (const d of descend(x)) if (d.tag === 'w:txbxContent') { hasText = true; boxes.push(d); } if (!hasText) { const bp = bigPics({ kids: [x] }); P.pics += bp.big; D.drawings += bp.big; D.smallDrawings += bp.small; } } }
    }
    const f = fieldStack.find((x) => x.link); if (f && !R.link) R.link = f.link;
    P.runs.push(R); P.text += R.text;
  };
  const inline = (n, link) => {
    for (const c of n.kids) {
      if (c.tag === 'w:r') run(c, link);
      else if (c.tag === 'w:hyperlink') { let l = link; const rid = c.attrs['r:id']; if (rid && D.rels[rid]) { l = { target: D.rels[rid].target }; D.links.push(l); } else if (c.attrs['w:anchor']) { l = { target: '#' + c.attrs['w:anchor'] }; D.links.push(l); } inline(c, l); }
      else if (c.tag === 'w:fldSimple') { const m = /HYPERLINK\s+"([^"]+)"/.exec(c.attrs['w:instr'] || ''); let l = link; if (m) { l = { target: m[1] }; D.links.push(l); } if (/\bPAGE\b/.test(c.attrs['w:instr'] || '')) D.fieldsPage++; inline(c, l); }
      else if (['w:ins', 'w:smartTag', 'w:sdt', 'w:sdtContent', 'w:customXml'].includes(c.tag)) inline(c, link);
      else if (c.tag === 'mc:AlternateContent') { const ch = kid(c, 'mc:Choice'); if (ch) inline(ch, link); }
    }
  };
  inline(p, null);
  for (const b of boxes) walkBody(D, b, { table: ctx.table, box: true });
}

// ---------- text folding ----------
const BIDI = /[​-‏‪-‮⁦-⁩﻿­]/g;
const AR_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g, KANA_RE = /[぀-ヿ]/g, HAN_RE = /[㐀-鿿豈-﫿]/g, LAT_RE = /[A-Za-z]/g;
function fold(s) {
  return s.normalize('NFKC').replace(BIDI, '').replace(/[ً-ٰٟـ]/g, '').replace(/[‐-―−]/g, '-').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').toLowerCase().replace(/\s+/g, '');
}
const stripMarker = (s) => s.replace(/^\s*(?:[•◦▪■●○‣∙·\-–—*]|\(?\d{1,2}[.)])\s*/, '');
function dist(a, b) { // Levenshtein, two rows
  const n = a.length, m = b.length; if (!n) return m; if (!m) return n; let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1); for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) { cur[0] = i; const ai = a.charCodeAt(i - 1); for (let j = 1; j <= m; j++) { const c = prev[j - 1] + (ai === b.charCodeAt(j - 1) ? 0 : 1); const d = prev[j] + 1, e = cur[j - 1] + 1; cur[j] = c < d ? (c < e ? c : e) : (d < e ? d : e); } const t = prev; prev = cur; cur = t; }
  return prev[m];
}
const sim = (a, b) => { const L = Math.max(a.length, b.length); return L ? 1 - dist(a, b) / L : 1; };
const clamp = (x) => Math.max(0, Math.min(1, x));
function multiset(arr) { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; }
function recall(exp, got) { const e = multiset(exp), g = multiset(got); let hit = 0, tot = 0; for (const [k, v] of e) { tot += v; hit += Math.min(v, g.get(k) || 0); } return tot ? hit / tot : null; }
const words = (s) => (s.normalize('NFKC').replace(BIDI, '').replace(/[ً-ٰٟـ]/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const hanChars = (s) => [...s.normalize('NFKC')].filter((c) => /[぀-ヿ㐀-鿿豈-﫿]/.test(c));

// ---------- the source as expectations ----------
function expectations(src, feat) {
  const ok = (k) => feat[k] !== 'absent'; const notes = src.footnotes; const E = { blocks: [], heads: [], items: [], tableEn: null, tableAr: null, bold: [], italic: [], links: [], foot: [], code: [], caption: null, cols: [], arParas: [], jaTxt: '', zhTxt: '', laTxt: [], arTxt: [] };
  const runsText = (rs) => rs.map((r) => ('fn' in r ? (ok('footnotes') ? String(r.fn) : '') : r.t)).join('');
  for (const b of src.blocks) {
    const l = b.lang || 'en'; const t = b.type;
    if (l === 'ar' && !ok('arabic')) continue; if (l === 'ja' && !ok('japanese')) continue; if (l === 'zh' && !ok('chinese')) continue;
    const push = (text, kind, extra = {}) => { const o = { text, lang: l, kind, ...extra }; E.blocks.push(o); return o; };
    if (t === 'title') { if (ok('title')) push(b.text, 'title'); }
    else if (t === 'h') { if (ok('headings') || true) { const o = push(b.text, 'h'); E.heads.push({ text: b.text, level: b.level, lang: l }); } }
    else if (t === 'p') {
      if (b.id === 'p-long' && !ok('longPara')) continue;
      push(runsText(b.runs), 'p', { id: b.id }); for (const r of b.runs) { if (r.b && ok('emphasis')) E.bold.push(...words(r.t)); if (r.i && ok('emphasis')) E.italic.push(...words(r.t)); if (r.link && ok('links')) E.links.push({ text: r.t, href: r.link }); }
    } else if (t === 'ul' || t === 'ol') { if ((t === 'ul' && !ok('bullets')) || (t === 'ol' && !ok('numbered'))) { if (l === 'en') continue; } for (const it of b.items) { push(it.text, 'li', { level: it.level }); E.items.push({ text: it.text, kind: t === 'ul' ? 'bullet' : 'number', level: it.level, lang: l }); } }
    else if (t === 'table') { if (!ok('table')) continue; if (l === 'ar') E.tableAr = b; else E.tableEn = b; }
    else if (t === 'figure') { if (ok('caption')) { push(b.caption, 'caption'); E.caption = b.caption; } }
    else if (t === 'columns') { if (!ok('columns')) continue; for (const p of b.blocks) { push(runsText(p.runs), 'p', { id: p.id }); E.cols.push(p.id); } }
    else if (t === 'code') { if (!ok('mono')) continue; for (const ln of b.lines) { push(ln, 'code'); E.code.push(ln); } }
  }
  if (ok('footnotes')) for (const [k, v] of Object.entries(notes)) E.foot.push(v);
  return E;
}

// ---------- scoring ----------
function classify(D, E) {
  // each non-table body paragraph -> language bucket by its letters; CJK by overlap with the expected sets
  const jaSet = new Set(hanChars(E.blocks.filter((b) => b.lang === 'ja').map((b) => b.text).join(''))), zhSet = new Set(hanChars(E.blocks.filter((b) => b.lang === 'zh').map((b) => b.text).join('')));
  return (p) => {
    const t = p.text.normalize('NFKC'); const ar = (t.match(AR_RE) || []).length, lat = (t.match(LAT_RE) || []).length, kana = (t.match(KANA_RE) || []).length, han = (t.match(HAN_RE) || []).length;
    if (ar + lat + kana + han === 0) return 'neutral';
    if (kana + han > ar + lat) { if (kana) return 'ja'; let j = 0, z = 0; for (const c of hanChars(t)) { if (jaSet.has(c)) j++; if (zhSet.has(c)) z++; } return j > z ? 'ja' : 'zh'; }
    return ar > lat ? 'ar' : 'lat';
  };
}
const headerLike = (f, hdr, ftr) => { const s = f; return s && (sim(s, hdr) > 0.8 || (s.includes(ftr) && s.length < ftr.length + 12) || /^page\d+$/.test(s) || /^(\d+|[ivx]+)$/.test(s) && false); };

function scoreDocx(D, src, feat, meta) {
  const S = {}; const E = expectations(src, feat); const ok = (k) => feat[k] !== 'absent'; const classOf = classify(D, E);
  const hdr = fold(src.meta.header), ftr = fold(src.meta.footer); const footF = Object.values(src.footnotes).map(fold);
  // body paragraphs outside tables; page furniture, footnote lines and the "Notes" heading set aside (judged by their own measures)
  const isFurniture = (f) => f && (sim(f, hdr) > 0.8 || (f.includes(ftr) && f.length < ftr.length + 14) || /^page\d{1,2}$/.test(f));
  const isFootLine = (f) => { const g = f.replace(/^\d+/, ''); return g.length >= 12 && footF.some((x) => x.includes(g) || (g.includes(x) && g.length < x.length + 8)); };
  const body = D.paras.filter((p) => !p.table && fold(p.text));
  const furn = body.filter((p) => isFurniture(fold(p.text)));
  const footLike = body.filter((p) => !furn.includes(p) && (isFootLine(fold(p.text)) || (feat.footnotes !== 'absent' && fold(p.text) === 'notes' && !p.heading && false)));
  const main = body.filter((p) => !furn.includes(p) && !footLike.includes(p) && !(fold(p.text) === 'notes' && feat.footnotes === 'approx'));
  const lang = new Map(main.map((p) => [p, classOf(p)]));
  const streamOf = (code) => { // paragraphs of this language joined by newline, hyphen line-breaks rejoined, list markers stripped
    const txt = main.filter((p) => lang.get(p) === code).map((p) => stripMarker(p.text.normalize('NFKC'))).join('\n');
    return txt.replace(/[\u2010\u2011\u00AD]/g, '-').replace(/([A-Za-z])-\s+([a-z])/g, '$1$2');
  };
  const expStream = (code) => E.blocks.filter((b) => (code === 'lat' ? b.lang === 'en' : b.lang === code)).map((b) => b.text).join('\n');
  const latScore = (code, key, featKey) => {
    if (!ok(featKey)) return; const e = expStream(code); if (!fold(e)) return; const g = streamOf(code);
    if (code === 'ja' || code === 'zh') { const eh = hanChars(e), gh = hanChars(g); S['text_' + key + '_rec'] = recall(eh, gh); const fe = eh.join(''), fg = gh.join(''); S['text_' + key + '_acc'] = clamp(1 - dist(fg, fe) / Math.max(fg.length, fe.length, 1)); return; }
    const fe = fold(e), fg = fold(g); S['text_' + key + '_acc'] = clamp(1 - dist(fg, fe) / Math.max(fg.length, fe.length, 1)); S['text_' + key + '_rec'] = recall(words(e), words(g));
  };
  latScore('lat', 'lat', 'longPara'); latScore('ar', 'ar', 'arabic'); latScore('ja', 'ja', 'japanese'); latScore('zh', 'zh', 'chinese');
  if (ok('arabic')) { // digits 0-9 inside Arabic text: the numbers of the mixed sentence (12, 7, 2024, 3, 35) as whole tokens
    const exp = (E.blocks.filter((b) => b.lang === 'ar').map((b) => b.text).join(' ').match(/\d+/g) || []); const got = D.paras.filter((p) => !p.table && classOf(p) === 'ar').map((p) => p.text.normalize('NFKC')).join(' ').match(/\d+/g) || [];
    S.ar_digits = exp.length ? recall(exp, got) : null;
  }
  // ---- paragraphs
  if (ok('longPara')) {
    const units = E.blocks.filter((b) => b.kind !== 'caption'); const cand = main.map((p) => ({ p, f: fold(stripMarker(p.text)) }));
    const matchedO = new Set(); let matchedE = 0; let longWhole = 0;
    for (const u of units) {
      const fe = fold(u.text); if (!fe) continue; let best = 0, bo = null;
      for (const c of cand) { if (matchedO.has(c)) continue; if (c.f.length < 3) continue; const pre = fe.slice(0, 6); if (!(c.f.startsWith(pre) || fe.startsWith(c.f.slice(0, 6)))) continue; const sc = sim(c.f, fe); if (sc > best) { best = sc; bo = c; } }
      if (best >= 0.85) { matchedE++; matchedO.add(bo); }
      if (u.id === 'p-long') { // the page-crossing paragraph: the most of it found in one paragraph
        const ew = words(u.text); const m = multiset(ew); let top = 0; for (const c of cand) { const cw = words(c.p.text); if (cw.length < 8) continue; const g = multiset(cw); let hit = 0; for (const [k, v] of m) hit += Math.min(v, g.get(k) || 0); top = Math.max(top, hit); } longWhole = top / ew.length;
      }
    }
    const nU = units.filter((u) => fold(u.text)).length; const rec = nU ? matchedE / nU : 0, prec = cand.length ? matchedO.size / cand.length : 0;
    S.para_f1 = rec + prec ? 2 * rec * prec / (rec + prec) : 0; S.para_long_whole = longWhole;
    if (meta.longWordHyphenated > 0 && ok('hyphen')) { // the long word broken at line ends in the PDF comes back whole
      const lw = src.meta.longWord; const all = fold(main.filter((p) => lang.get(p) === 'lat').map((p) => p.text).join('\n')); /* raw: no hyphen folding, the converter must rejoin */ let intact = 0, i = -1; while ((i = all.indexOf(lw, i + 1)) >= 0) { intact++; } const k = meta.longWordHyphenated, total = 3; S.hyphen_join = clamp((intact - (total - k)) / k);
    }
  }
  // ---- headings
  if (ok('headings')) {
    const hs = E.heads.filter((h) => h.lang === 'en' || ok('arabic') && h.lang === 'ar'); let found = 0, styled = 0, levelOk = 0;
    for (const h of hs) { const fe = fold(h.text); let bp = null, bs = 0; for (const p of main) { const f = fold(p.text); if (!f) continue; const s = sim(f, fe); if (s > bs) { bs = s; bp = p; } } if (bs >= 0.85) { found++; if (bp.heading && bp.heading.level >= 1) { styled++; if (bp.heading.level === h.level) levelOk++; } } }
    S.headings_rec = hs.length ? styled / hs.length : null; S.headings_level = hs.length ? levelOk / hs.length : null; S.headings_text = hs.length ? found / hs.length : null;
  }
  // ---- lists
  if (E.items.length) {
    let real = 0, marker = 0; const used = new Set();
    for (const it of E.items) {
      const fe = fold(it.text); let bp = null, bs = 0; for (const p of main) { if (used.has(p)) continue; const f = fold(stripMarker(p.text)); if (!f) continue; const s = f.length < fe.length * 0.6 ? 0 : sim(f, fe); if (s > bs) { bs = s; bp = p; } }
      if (bs < 0.85) continue; used.add(bp);
      const hasMarker = !!bp.num || /^\s*(?:[•◦▪■●○‣∙·\-–—*]|\(?\d{1,2}[.)])\s*\S/.test(bp.text) || /^\s*\S\s*$/.test(bp.runs[0]?.text || '') && false;
      if (hasMarker) marker++; if (bp.num && bp.numKind === it.kind && bp.num.lvl === it.level) real++;
    }
    S.lists_real = real / E.items.length; S.lists_marker = marker / E.items.length;
  }
  // ---- tables
  const tbls = D.tables.filter((t) => !t.nested);
  const tableScore = (tb, kind) => {
    const exp = tb.rows.flat().map((c) => ({ f: fold(c.text), span: c.span || 1, header: !!c.header })); let best = null, bm = -1;
    for (const t of tbls) { const cells = t.rows.flatMap((r) => r.cells).map((c) => fold(c.text)); let m = 0; for (const e of exp) if (cells.some((c) => sim(c, e.f) >= 0.85)) m++; if (m > bm) { bm = m; best = t; } }
    return { best, matched: Math.max(bm, 0), total: exp.length, exp };
  };
  if (E.tableEn) {
    const r = tableScore(E.tableEn, 'en'); const t = r.best; const nr = E.tableEn.rows.length, nc = 3;
    if (t && r.matched > 0) {
      let cells = r.matched; let ar = null; S.table_cells = cells / r.total;
      const gotRows = t.rows.length, gotCols = t.gridCols || Math.max(...t.rows.map((x) => x.cells.reduce((a, c) => a + c.span, 0)));
      S.table_shape = ((gotRows === nr ? 1 : 0) + (gotCols === nc ? 1 : 0)) / 2;
      const mc = t.rows.flatMap((r) => r.cells).find((c) => sim(fold(c.text), fold('North pier, both gauges')) >= 0.85); S.table_merged = mc && (mc.span === 2) ? 1 : 0;
      S.table_header = t.rows[0] && t.rows[0].header ? 1 : 0;
    } else { S.table_cells = 0; S.table_shape = 0; S.table_merged = 0; S.table_header = 0; }
  }
  if (E.tableEn) { // text kept anywhere (body, tables, headers, footers) - tells "lost" from "not a table"
    const all = fold(D.paras.map((p) => p.text).join(' ') + ' ' + D.hf.map((h) => h.text).join(' ')); const cells = E.tableEn.rows.flat().map((c) => fold(c.text)).filter((c) => c.length >= 3);
    S.table_text_any = cells.length ? cells.filter((c) => all.includes(c)).length / cells.length : null;
  }
  if (E.tableAr) { const r = tableScore(E.tableAr, 'ar'); S.table_ar_cells = r.best && r.matched ? r.matched / r.total : 0; }
  // ---- picture and caption
  if (ok('picture')) {
    const n = D.drawings; S.picture = n >= 1 ? 1 / n : D.hfPics >= 1 ? 0.5 : 0;
    if (ok('caption') && E.caption) {
      const fc = fold(E.caption); const idx = D.paras.findIndex((p) => fold(p.text) && sim(fold(p.text), fc) >= 0.85);
      if (idx < 0) S.caption = 0; else { let near = false; for (let d = -2; d <= 2; d++) if (D.paras[idx + d] && D.paras[idx + d].pics) near = true; S.caption = near ? 1 : 0.5; }
    }
  }
  // ---- footnotes
  if (ok('footnotes')) {
    let sc = 0; for (const f of E.foot) { const ff = fold(f); if (D.footnotes.some((x) => sim(fold(x).replace(/^\d+/, ''), ff) >= 0.85) && D.footRefs > 0) sc += 1; else if (D.paras.some((p) => fold(p.text).includes(ff.slice(0, Math.max(20, ff.length - 6))))) sc += 0.5; }
    S.footnotes = sc / E.foot.length;
  }
  // ---- hyperlinks
  if (ok('links') && E.links.length) {
    let sc = 0; for (const l of E.links) { if (D.links.some((x) => x.target === l.href)) sc += 1; else if (fold(D.paras.map((p) => p.text).join(' ')).includes(fold(l.text))) sc += 0.5; } S.links = sc / E.links.length;
  }
  // ---- header / footer / page numbers
  if (ok('headerFooter')) {
    const pages = meta.pages || 1; const poll = furn.length + D.paras.filter((p) => p.table && isFurniture(fold(p.text))).length;
    S.hf_pollution = clamp(1 - poll / (2 * pages));
    const hasH = D.hf.some((x) => x.kind === 'header' && sim(fold(x.text), hdr) >= 0.7), hasF = D.hf.some((x) => x.kind === 'footer' && fold(x.text).includes(ftr.slice(0, 12))), hasP = D.fieldsPage > 0 || D.hf.some((x) => x.page) || false;
    S.hf_present = ((hasH ? 1 : 0) + (hasF ? 1 : 0) + (hasP ? 1 : 0)) / 3;
  }
  // ---- columns
  if (ok('columns') && E.cols.length === 4) {
    const stream = fold(main.map((p) => p.text).join('\n')); const marks = ['alphaentry', 'bravoentry', 'charlieentry', 'deltaentry']; const at = marks.map((m) => stream.indexOf(m));
    let pairs = 0, right = 0; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { pairs++; if (at[i] >= 0 && at[j] >= 0 && at[i] < at[j]) right++; }
    let contig = 0; E.cols.forEach((id, k) => { const u = E.blocks.find((b) => b.id === id); const fe = fold(u.text); if (at[k] < 0) return; contig += sim(stream.slice(at[k], at[k] + fe.length), fe); });
    S.columns_order = 0.5 * (right / pairs) + 0.5 * (contig / 4); S.columns_set = D.sectCols.some((n) => n >= 2) ? 1 : 0;
  }
  // ---- emphasis and monospace
  if (ok('emphasis')) {
    // (A table's cells are no body emphasis, whether in a table or set as a line of the row's cells.)
    const skip = [...E.blocks.filter((b) => ['title', 'h', 'caption'].includes(b.kind)).map((b) => fold(b.text)), ...(E.tableEn ? E.tableEn.rows.flat().map((c) => fold(c.text)) : []), ...(E.tableEn ? E.tableEn.rows.map((r) => r.map((c) => fold(c.text)).join('')) : []), 'notes'].filter(Boolean);
    const gotB = [], gotI = []; for (const p of D.paras) { if (p.table || furn.includes(p) || footLike.includes(p)) continue; const f = fold(p.text); if (!f || p.heading) continue; if (skip.some((s) => s.includes(f) && f.length >= 4)) continue; if (lang.get(p) !== 'lat' && lang.get(p) !== undefined) continue; for (const r of p.runs) { if (r.b) gotB.push(...words(r.text)); if (r.i) gotI.push(...words(r.text)); } }
    const f1 = (exp, got) => { const r = recall(exp, got), pr = recall(got, exp); if (r === null) return null; if (!got.length) return 0; return r + pr ? 2 * r * pr / (r + pr) : 0; };
    const b1 = f1(E.bold, gotB), i1 = f1(E.italic, gotI); S.emphasis_bold = b1; S.emphasis_italic = i1;
  }
  if (ok('mono') && E.code.length) {
    let hit = 0; for (const ln of E.code) { const fe = fold(ln); const p = D.paras.find((q) => !q.table && sim(fold(q.text), fe) >= 0.85); if (p && p.runs.some((r) => /mono|courier|consol|typewriter|menlo|cmtt|lmtt|code/i.test(r.font))) hit++; } S.mono = hit / E.code.length;
  }
  // ---- direction of Arabic paragraphs
  if (ok('arabic')) {
    const ar = D.paras.filter((p) => (p.text.normalize('NFKC').match(AR_RE) || []).length >= 3); let sc = 0;
    // (A table's cell keeps the alignment of its column — a centred figure — so there only its direction counts.)
    for (const p of ar) { const right = p.table ? p.bidi : p.bidi ? (!p.jc || ['start', 'left'].includes(p.jc)) : ['right', 'end'].includes(p.jc); sc += 0.5 * (p.bidi ? 1 : 0) + 0.5 * (right ? 1 : 0); }
    S.direction = ar.length ? sc / ar.length : 0;
  }
  // ---- scans and OCR layers: any text recovered at all
  if (meta.scanned) { const e = words(src.blocks.filter((b) => b.lang === 'en' && ['p'].includes(b.type) && b.id !== 'p-long').map((b) => b.runs.map((r) => r.t || '').join('')).join(' ')); S.ocr_recovered = recall(e, words(D.paras.map((p) => p.text).join(' '))); }
  return S;
}

// ---------- the guard against lost text: the PDF's own text layer, word by word, found anywhere in the .docx ----------
// (pdf.js in Node reads the layer; the .docx side is every part a reader of the document sees: body, tables, text
// boxes, headers, footers, footnotes. Words broken by a hyphen at a line's end count whole on both sides; a word
// found only reversed counts too (a PDF that stores right-to-left text in visual order).)
const joinHyph = (s) => s.replace(/[‐‑­]/g, '-').replace(/([\p{Ll}])-\s+([\p{Ll}])/gu, '$1$2');
async function pdfTextWords(file) {
  const fs = require('fs'); const path = require('path'); const url = require('url');
  const base = path.join(__dirname, '../../../node_modules/pdfjs-dist/');
  const pdfjs = await import(url.pathToFileURL(path.join(base, 'legacy/build/pdf.mjs')).href);
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), password: '', cMapUrl: url.pathToFileURL(path.join(base, 'cmaps/')).href, cMapPacked: true, standardFontDataUrl: url.pathToFileURL(path.join(base, 'standard_fonts/')).href, verbosity: 0, isEvalSupported: false }); const doc = await task.promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) { const tc = await (await doc.getPage(i)).getTextContent(); for (const it of tc.items) text += (it.str || '') + (it.hasEOL ? '\n' : ' '); text += '\n'; }
  await task.destroy();
  return words(joinHyph(text));
}
function docxAllText(D) { return joinHyph([...D.paras.map((p) => (p.label ? p.label + ' ' : '') + p.text), ...D.hf.map((h) => h.text), ...D.footnotes].join('\n')); }
function wordRecall(pdfWords, D) {
  const dw = words(docxAllText(D)); const got = multiset(dw); const all = dw.join(' ');
  // (Arabic ligatures — lam-alef and the like — come out of some PDFs' text layers with their letters swapped: the
  // same letters in another order count.)
  const key = (w) => [...w].sort().join(''); const anag = multiset(dw.filter((w) => /[\u0600-\u06ff]/.test(w)).map(key));
  let hit = 0; const miss = [];
  const want = multiset(pdfWords);
  for (const [w, n] of want) { const g = got.get(w) || 0; const rev = [...w].reverse().join(''); const gr = got.get(rev) || 0; let h = Math.min(n, g + gr); if (h < n && (all.includes(w) || all.includes(rev))) h = n; if (h < n && /[\u0600-\u06ff]/.test(w)) h = Math.min(n, h + (anag.get(key(w)) || 0)); hit += h; if (h < n) miss.push(w + (n - h > 1 ? '×' + (n - h) : '')); }
  return { recall: pdfWords.length ? hit / pdfWords.length : null, miss };
}

// Geometry of the source PDF that the text layer alone does not give (read once per PDF with pdf.js):
//  decor: the strokes attached to text - thin horizontal strokes (< 3 pt high; duplicates drawn twice counted once) with a line of
//  text within 1.6 of its size above or below, over the same stretch, leaving out a table's rules (3 or more strokes at one height,
//  or 3 or more of one extent).
async function pdfGeometry(file) {
  const fs = require('fs'); const path = require('path'); const url = require('url');
  const base = path.join(__dirname, '../../../node_modules/pdfjs-dist/');
  const pdfjs = await import(url.pathToFileURL(path.join(base, 'legacy/build/pdf.mjs')).href); const { OPS } = pdfjs;
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), password: '', cMapUrl: url.pathToFileURL(path.join(base, 'cmaps/')).href, cMapPacked: true, standardFontDataUrl: url.pathToFileURL(path.join(base, 'standard_fonts/')).href, verbosity: 0, isEvalSupported: false }); const doc = await task.promise;
  const G = { pages: doc.numPages, decor: 0, lines: [], gaps: {} };
  // (The list items' places, from listgeo.json — see make/gen_listgeo.py — with each item's text from source.json.)
  { const id = path.basename(file, '.pdf'); const lg = path.join(__dirname, 'listgeo.json'); const src = JSON.parse(fs.readFileSync(path.join(__dirname, 'source.json'), 'utf8'));
    const texts = {}; const walk = (bs) => { for (const b of bs) { if (b.type === 'ul' || b.type === 'ol') texts[b.id] = b.items.map((x) => x.text); if (b.type === 'columns') walk(b.blocks); } }; walk(src.blocks);
    if (fs.existsSync(lg)) { const all = JSON.parse(fs.readFileSync(lg, 'utf8')); if (all[id]) G.lists = all[id].map((x) => ({ ...x, want: (texts[x.list] || [])[x.i] })); } }
  const mul = (m, k) => [m[0] * k[0] + m[2] * k[1], m[1] * k[0] + m[3] * k[1], m[0] * k[2] + m[2] * k[3], m[1] * k[2] + m[3] * k[3], m[0] * k[4] + m[2] * k[5] + m[4], m[1] * k[4] + m[3] * k[5] + m[5]];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n); const ol = await page.getOperatorList(); const tc = await page.getTextContent();
    const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ str: it.str, x0: it.transform[4], x1: it.transform[4] + it.width, y: it.transform[5], h: it.height || Math.hypot(it.transform[2], it.transform[3]) || 10 }));
    G.lines.push(items);
    // (Word gaps per font, in em, inside each shown string: a space the page draws with its word spacing, or a kern
    // of 0.15-1.2 em between two glyphs — TeX draws no spaces. A gap of a drawn space counts from 0.05 em.)
    { let font = null, size = 10, ws = 0, cs = 0;
      for (let i = 0; i < ol.fnArray.length; i++) {
        const fn = ol.fnArray[i], a = ol.argsArray[i];
        if (fn === OPS.setFont) { size = Math.abs(a[1]) || 10; let fo = null; try { fo = page.commonObjs.get(a[0]); } catch { fo = null; } font = fo && fo.name ? { name: fo.name, fm: (fo.fontMatrix && fo.fontMatrix[0]) || 0.001 } : null; }
        else if (fn === OPS.setWordSpacing) ws = +a[0] || 0; else if (fn === OPS.setCharSpacing) cs = +a[0] || 0;
        else if (fn === OPS.showText && font && Array.isArray(a[0])) {
          let gap = 0, drawn = false, any = false; const key = spaceKeyPdf(font.name);
          for (const g of a[0]) {
            if (typeof g === 'number') { gap += -g / 1000; continue; }
            if (!g) continue;
            if (g.isSpace || g.unicode === ' ') { gap += (g.width || 0) * font.fm + (ws + cs) / size; drawn = true; continue; }
            if (any && ((drawn && gap > 0.05) || (!drawn && gap >= 0.15)) && gap <= 1.2) (G.gaps[key] = G.gaps[key] || []).push(gap);
            gap = 0; drawn = false; any = true;
          }
        }
      }
    }
    let ctm = [1, 0, 0, 1, 0, 0], lw = 1; const st = []; const ss = []; const seen = new Set();
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], a = ol.argsArray[i];
      if (fn === OPS.save) st.push([ctm, lw]); else if (fn === OPS.restore) { const t = st.pop(); if (t) [ctm, lw] = t; }
      else if (fn === OPS.transform) ctm = mul(ctm, a); else if (fn === OPS.setLineWidth) lw = +a[0] || 0;
      else if (fn === OPS.paintFormXObjectBegin) { st.push([ctm, lw]); if (Array.isArray(a[0])) ctm = mul(ctm, a[0]); } else if (fn === OPS.paintFormXObjectEnd) { const t = st.pop(); if (t) [ctm, lw] = t; }
      else if (fn === OPS.constructPath) {
        const mm = a[2]; if (!mm) continue;
        const pts = [[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
        const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
        const th = [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke].includes(a[0]) ? lw * Math.hypot(ctm[2], ctm[3]) : 0;
        if (x1 - x0 < 3 || y1 - y0 + th >= 3) continue;
        const key = [x0, x1, y0, y1].map((v) => v.toFixed(1)).join('|'); if (seen.has(key)) continue; seen.add(key); ss.push({ x0, x1, y: (y0 + y1) / 2 });
      }
    }
    for (const s of ss) {
      if (ss.filter((t) => Math.abs(t.y - s.y) < 0.5).length >= 3 || ss.filter((t) => Math.abs(t.x0 - s.x0) < 0.5 && Math.abs(t.x1 - s.x1) < 0.5).length >= 3) continue;
      if (items.some((it) => it.x1 > s.x0 && it.x0 < s.x1 && Math.abs(it.y - s.y) < it.h * 1.6)) G.decor++;
    }
  }
  await task.destroy();
  return G;
}
// Measures of the «Easy to edit» result that need the source's geometry (G from pdfGeometry).
function scoreGeometry(D, G) {
  const S = {};
  // decor_stray: share of the source's text-attached strokes not left pinned in the page drawing (1 = none left).
  S.decor_stray = G.decor ? clamp(1 - (D.hfStrips || 0) / G.decor) : (D.hfStrips ? 0 : null);
  // runs_plain: 1 - (runs of only spaces at another size than a neighbour + needless run boundaries: two neighbouring runs of plain
  // text with the same look, in the same link, outside fields) / runs, over the body's paragraphs.
  { let runs = 0, bad = 0;
    for (const p of D.paras) { if (p.table || p.box) continue; const rs = p.runs; runs += rs.length;
      rs.forEach((r, i) => { const a = rs[i - 1], b = rs[i + 1];
        if (r.plain && r.text.length && !r.text.trim() && r.sz !== null && [a, b].some((n) => n && n.plain && n.text.trim() && n.sz !== null && n.sz !== r.sz)) bad++;
        else if (a && a.plain && r.plain && !a.field && !r.field && a.sig === r.sig && a.link === r.link && !a.foot && !r.foot) bad++; }); }
    S.runs_plain = runs ? clamp(1 - bad / runs) : null; }
  // list_geometry: share of the list items (source.json's, placed on the page by listgeo.json) whose text and mark — where the
  // .docx puts them: the section's margin, then the paragraph's indent or its list level's, less the hanging — stand within
  // 2 pt of the page's (from the right edge for a right-to-left item; the mark only where the text layer has it).
  if (G.lists && G.lists.length) {
    let n = 0, good = 0;
    for (const it of G.lists) {
      if (it.text === null || !it.want) continue; n++;
      const p = D.paras.find((q) => q.num && !q.table && sim(fold(q.text), fold(it.want)) >= 0.85); if (!p || !p.sect || p.sect.cols > 1) continue;
      const lv = ((D.numLv[p.num.id] || {})[String(p.num.lvl)] || {}).ind || {}; const own = p.ind || {};
      const start = own.start ?? lv.start ?? 0, hang = own.hanging ?? lv.hanging ?? 0;
      const text = ((it.rtl ? p.sect.right : p.sect.left) + start) / 20, mark = text - hang / 20;
      if (Math.abs(text - it.text) <= 2 && (it.mark === null || Math.abs(mark - it.mark) <= 2)) good++;
    }
    S.list_geometry = n ? good / n : null;
  }
  return S;
}
// A font's key, to match the PDF's fonts to the ones the .docx carries: its family in lower-case letters and digits, then
// b/i for bold/italic ("NCHPWW+LMRoman10-Bold" -> "lmroman10|b"; the .docx's "LM Roman10" embedBold -> the same).
function spaceKeyPdf(name) {
  const n = String(name).replace(/^[A-Z]{6}\+/, ''); const m = /^([^-,]+)[-,](.*)$/.exec(n); const fam = m ? m[1] : n, st = m ? m[2] : n;
  const b = /bold|black|heavy|demi|semibold/i.test(st), it = /italic|oblique/i.test(st);
  return fam.toLowerCase().replace(/[^a-z0-9]/g, '') + '|' + (b ? 'b' : '') + (it ? 'i' : '');
}
// The space advance (em) of each font the .docx carries (word/fonts/*.odttf, de-obfuscated with the table's key), by key.
async function docxSpaces(D) {
  const out = {}; const zip = D.zip; const ft = zip.file('word/fontTable.xml'); const rl = zip.file('word/_rels/fontTable.xml.rels'); if (!ft || !rl) return out;
  const rels = {}; for (const r of descend(parseXml(await rl.async('string')))) if (r.tag === 'Relationship') rels[r.attrs.Id] = r.attrs.Target;
  for (const f of descend(parseXml(await ft.async('string')))) {
    if (f.tag !== 'w:font') continue; const fam = (f.attrs['w:name'] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const e of f.kids) {
      const m = /^w:embed(Regular|Bold|Italic|BoldItalic)$/.exec(e.tag); if (!m) continue; const t = rels[e.attrs['r:id']]; const file = t && zip.file('word/' + t.replace(/^\.?\//, '')); if (!file) continue;
      const buf = Buffer.from(await file.async('uint8array')); const hex = (e.attrs['w:fontKey'] || '').replace(/[{}-]/g, ''); const kb = (hex.match(/../g) || []).map((h) => parseInt(h, 16)).reverse();
      if (kb.length === 16) for (let k = 0; k < 32 && k < buf.length; k++) buf[k] ^= kb[k % 16];
      const adv = sfntSpace(buf); if (adv !== null) out[fam + '|' + (m[1] === 'Bold' ? 'b' : m[1] === 'Italic' ? 'i' : m[1] === 'BoldItalic' ? 'bi' : '')] = adv;
    }
  }
  return out;
}
function sfntSpace(b) {
  try {
    const n = b.readUInt16BE(4); const T = {}; for (let i = 0; i < n; i++) { const o = 12 + i * 16; T[b.toString('latin1', o, o + 4)] = b.readUInt32BE(o + 8); }
    const upem = b.readUInt16BE(T.head + 18); const nhm = b.readUInt16BE(T.hhea + 34); const cm = T.cmap; let gid = null;
    for (let i = 0; i < b.readUInt16BE(cm + 2) && gid === null; i++) {
      const st = cm + b.readUInt32BE(cm + 4 + i * 8 + 4); const fmt = b.readUInt16BE(st);
      if (fmt === 4) { const sc = b.readUInt16BE(st + 6) / 2; const ends = st + 14, starts = ends + sc * 2 + 2, dl = starts + sc * 2, ro = dl + sc * 2;
        for (let s = 0; s < sc; s++) { const e = b.readUInt16BE(ends + s * 2), a = b.readUInt16BE(starts + s * 2); if (32 > e || 32 < a) continue; const d = b.readInt16BE(dl + s * 2), r = b.readUInt16BE(ro + s * 2);
          if (!r) gid = (32 + d) & 0xffff; else { const g = b.readUInt16BE(ro + s * 2 + r + (32 - a) * 2); gid = g ? (g + d) & 0xffff : 0; } break; } }
      else if (fmt === 12) { const ng = b.readUInt32BE(st + 12); for (let s = 0; s < ng; s++) { const o = st + 16 + s * 12; if (32 >= b.readUInt32BE(o) && 32 <= b.readUInt32BE(o + 4)) { gid = b.readUInt32BE(o + 8) + 32 - b.readUInt32BE(o); break; } } }
    }
    if (!gid) return null; const adv = b.readUInt16BE(T.hmtx + Math.min(gid, nhm - 1) * 4); return adv / upem;
  } catch { return null; }
}
// space_adv: for each font the .docx carries that the PDF shows at least 5 word gaps in, 1 when its space advance is within 12 %
// of the font's natural gap, falling to 0 at 40 %; the mean over those fonts (both results; G from pdfGeometry). The natural gap:
// the median of the gaps up to 1.2 x their lower quartile (the plain median took a wrapped TeX title's stretched first line,
// 0.47 em, for its bold face's space, 0.375).
async function scoreSpaces(D, G) {
  const adv = await docxSpaces(D); const keys = Object.keys(adv); const sc = [];
  for (const [k, gs] of Object.entries(G.gaps || {})) {
    if (gs.length < 5) continue; const [fam, st] = k.split('|');
    const dk = adv[k] !== undefined ? k : keys.find((x) => { const [f2, s2] = x.split('|'); return s2 === st && f2.length >= 4 && fam.startsWith(f2); }); if (!dk) continue;
    const s0 = [...gs].sort((a, b) => a - b); const q = s0[Math.floor(s0.length / 4)]; const s = s0.filter((g) => g <= q * 1.2); const med = s[Math.floor(s.length / 2)]; const r = Math.abs(adv[dk] - med) / med;
    sc.push({ k, adv: adv[dk], med, s: r <= 0.12 ? 1 : r >= 0.4 ? 0 : (0.4 - r) / 0.28 });
  }
  return { space_adv: sc.length ? sc.reduce((a, x) => a + x.s, 0) / sc.length : null, detail: sc };
}
// The long paragraph's line pitch (median step between its consecutive lines on one page) and the page count of a PDF —
// the source, or the .docx as LibreOffice lays it out (soffice --convert-to pdf).
async function pdfFlow(file, src) {
  const fs = require('fs'); const path = require('path'); const url = require('url');
  const base = path.join(__dirname, '../../../node_modules/pdfjs-dist/');
  const pdfjs = await import(url.pathToFileURL(path.join(base, 'legacy/build/pdf.mjs')).href);
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), password: '', cMapUrl: url.pathToFileURL(path.join(base, 'cmaps/')).href, cMapPacked: true, standardFontDataUrl: url.pathToFileURL(path.join(base, 'standard_fonts/')).href, verbosity: 0, isEvalSupported: false }); const doc = await task.promise;
  const long = src.blocks.find((b) => b.id === 'p-long'); const lw = new Set(words(long ? long.runs.map((r) => r.t || '').join(' ') : '').filter((w) => w.length >= 4));
  const steps = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent(); const rows = new Map();
    for (const it of tc.items) { if (!it.str || !it.str.trim()) continue; const y = Math.round(it.transform[5] * 2) / 2; let k = [...rows.keys()].find((v) => Math.abs(v - y) < 1.5); if (k === undefined) rows.set(k = y, []); rows.get(k).push(it.str); }
    const ys = [...rows.keys()].sort((a, b) => b - a).filter((y) => { const ws = words(rows.get(y).join(' ')).filter((w) => w.length >= 4); return ws.length >= 5 && ws.filter((w) => lw.has(w)).length >= ws.length * 0.9; });
    for (let i = 1; i < ys.length; i++) { const d = ys[i - 1] - ys[i]; if (d > 5 && d < 30) steps.push(d); }
  }
  const pages = doc.numPages; await task.destroy();
  steps.sort((a, b) => a - b); return { pages, pitch: steps.length >= 3 ? steps[Math.floor(steps.length / 2)] : null };
}
// pitch: the long paragraph's line pitch as LibreOffice sets the .docx ÷ the source's: 1 within 0.97-1.04, falling to 0 at ±20 %.
// pages: 1 when LibreOffice's page count is the source's, 0.5 one off, else 0.
function scoreFlow(srcFlow, docFlow) {
  const S = {};
  if (srcFlow.pitch && docFlow.pitch) { const r = docFlow.pitch / srcFlow.pitch; S.pitch = r >= 0.97 && r <= 1.04 ? 1 : r < 0.97 ? clamp((r - 0.8) / 0.17) : clamp((1.2 - r) / 0.16); }
  const d = Math.abs(docFlow.pages - srcFlow.pages); S.pages = d === 0 ? 1 : d === 1 ? 0.5 : 0;
  return S;
}
module.exports = { scoreSpaces, docxSpaces, pdfFlow, scoreFlow, pdfGeometry, scoreGeometry, readDocx, scoreDocx, fold, sim, dist, expectations, parseXml, pdfTextWords, wordRecall };
