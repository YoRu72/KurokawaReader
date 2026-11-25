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
  D.numFmt = {}; const nb = await get('word/numbering.xml');
  if (nb) {
    const abs = {}; for (const a of descend(nb)) if (a.tag === 'w:abstractNum') { abs[a.attrs['w:abstractNumId']] = {}; for (const l of kidsOf(a, 'w:lvl')) abs[a.attrs['w:abstractNumId']][l.attrs['w:ilvl']] = attr(kid(l, 'w:numFmt'), 'w:val'); }
    for (const n of descend(nb)) if (n.tag === 'w:num') D.numFmt[n.attrs['w:numId']] = abs[attr(kid(n, 'w:abstractNumId'), 'w:val')] || {};
  }
  D.kindOf = (num) => { if (!num) return null; const f = (D.numFmt[num.id] || {})[String(num.lvl)]; return f === undefined ? 'number' : f === 'bullet' ? 'bullet' : f === 'none' ? 'none' : 'number'; };
  // body
  const doc = await get('word/document.xml'); D.body = kid(kid(doc, 'w:document'), 'w:body') || { kids: [] };
  D.paras = []; D.tables = []; D.links = []; D.footRefs = 0; D.drawings = 0; D.smallDrawings = 0; D.hfPics = 0; D.sectCols = []; D.fieldsPage = 0;
  walkBody(D, D.body, { table: null, box: false });
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
    D.hfPics += bigPics(x).big; D.hf.push({ kind: /\/header$/.test(r.type) ? 'header' : 'footer', text: ps, page });
  }
  return D;
}
// A "picture" here is a drawing of at least 4 x 2 cm (the figure is 8 x 4.2 cm); smaller ones are the converter's bullets, rules and marks.
function bigPics(n) { let c = 0, small = 0; for (const d of descend(n)) if (d.tag === 'w:drawing' || d.tag === 'w:pict') { const ex = [...descend(d)].find((x) => x.tag === 'wp:extent'); const hasImg = [...descend(d)].some((x) => x.tag === 'a:blip' || x.tag === 'v:imagedata'); if (!hasImg) continue; if (ex && +ex.attrs.cx >= 1440000 && +ex.attrs.cy >= 720000) c++; else small++; } return { big: c, small }; }
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
  const P = { text: '', runs: [], style: sid, styleName: chain[0]?.name || '', heading, num, numKind: D.kindOf(num), bidi: !!bidi, jc, table: ctx.table, box: ctx.box, pics: 0, rtlRuns: 0, frame: !!kid(pr, 'w:framePr') };
  D.paras.push(P); const boxes = [];
  const fieldStack = []; // complex fields: {instr, link}
  const run = (r, link) => {
    const rp = kid(r, 'w:rPr'); const rf = kid(rp, 'w:rFonts');
    const R = { text: '', b: rp && kid(rp, 'w:b') ? on(kid(rp, 'w:b')) : false, i: rp && kid(rp, 'w:i') ? on(kid(rp, 'w:i')) : false, font: (rf && (rf.attrs['w:ascii'] || rf.attrs['w:hAnsi'] || rf.attrs['w:cs'] || rf.attrs['w:eastAsia'])) || '', link };
    if (rp && kid(rp, 'w:rtl') && on(kid(rp, 'w:rtl'))) P.rtlRuns++;
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
    const skip = [...E.blocks.filter((b) => ['title', 'h', 'caption'].includes(b.kind)).map((b) => fold(b.text)), ...(E.tableEn ? E.tableEn.rows.flat().map((c) => fold(c.text)) : []), 'notes'].filter(Boolean);
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
    for (const p of ar) { const right = p.bidi ? (!p.jc || ['start', 'left'].includes(p.jc)) : ['right', 'end'].includes(p.jc); sc += 0.5 * (p.bidi ? 1 : 0) + 0.5 * (right ? 1 : 0); }
    S.direction = ar.length ? sc / ar.length : 0;
  }
  // ---- scans and OCR layers: any text recovered at all
  if (meta.scanned) { const e = words(src.blocks.filter((b) => b.lang === 'en' && ['p'].includes(b.type) && b.id !== 'p-long').map((b) => b.runs.map((r) => r.t || '').join('')).join(' ')); S.ocr_recovered = recall(e, words(D.paras.map((p) => p.text).join(' '))); }
  return S;
}

module.exports = { readDocx, scoreDocx, fold, sim, dist, expectations, parseXml };
