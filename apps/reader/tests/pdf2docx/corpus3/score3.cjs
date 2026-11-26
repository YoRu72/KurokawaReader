// Scores a converted .docx (read by corpus2/score.cjs's readDocx) against corpus3/truth/<kind>.json, one number 0-1 per measure
// (null / absent = not applicable to this kind). Pure: no browser, no external programs but pdfinfo. Used by tests/pdf2docxcorpus3.cjs.
// The measures reuse corpus2's text folding and matching (fold, sim, dist) and add what the new kinds need: merged cells, money
// columns, a right-to-left table's column order, equation numbers kept with their equation, a verse's two halves, slide boxes'
// reading order and visibility, leaders, field lines, check boxes, a box grid, drop caps, running heads (odd/even) out of the body.
const { fold, sim, dist } = require('../corpus2/score.cjs');
const ORDER = ['text_layer_recall', 'text_acc', 'text_rec', 'para_f1', 'headings_rec', 'headings_level', 'headings_prec', 'lists_real', 'table_cells', 'table_merged', 'table_money', 'table_rtl', 'emphasis', 'supsub', 'footnotes', 'notes_false', 'eq_num', 'refs_whole', 'verse', 'hf_present', 'hf_pollution', 'odd_even', 'toc_leaders', 'leaders', 'fields', 'checkboxes', 'grid', 'dropcap', 'hyphen_page', 'slide_order', 'slide_visible', 'pages', 'lo_opens'];
const clamp = (x) => Math.max(0, Math.min(1, x));
const words = (s) => (s.normalize('NFKC').replace(/[​-‏‪-‮⁦-⁩﻿­]/g, '').replace(/[ً-ٰٟـ]/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
function recall(exp, got) { const g = new Map(); for (const x of got) g.set(x, (g.get(x) || 0) + 1); let hit = 0; for (const x of exp) { const n = g.get(x) || 0; if (n) { hit++; g.set(x, n - 1); } } return exp.length ? hit / exp.length : null; }
const runsText = (rs) => rs.map((r) => ('fn' in r ? String(r.fn) : r.t)).join('');
async function pdfInfo3(file) { const { execSync } = require('child_process'); return { pages: +(/Pages:\s+(\d+)/.exec(execSync(`pdfinfo "${file}"`).toString()) || [0, 1])[1] }; }

// The truth as reading units (paragraph-sized texts in reading order) and as one stream.
function units(T) {
  const U = [];
  for (const b of T.blocks) {
    const t = b.type;
    if (t === 'title' || t === 'h') U.push({ text: b.text, kind: 'h', b });
    else if (t === 'p') U.push({ text: runsText(b.runs), kind: 'p', b });
    else if (t === 'ul' || t === 'ol') for (const it of b.items) U.push({ text: it.text, kind: 'li', b, it });
    else if (t === 'eq') U.push({ text: b.text + ' ' + b.num, kind: 'eq', b });
    else if (t === 'ref' || t === 'quote' || t === 'ornament') U.push({ text: b.text, kind: t, b });
    else if (t === 'verse') U.push({ text: b.a + ' ' + b.b, kind: 'verse', b });
    else if (t === 'toc') for (const e of b.entries) U.push({ text: e.text + ' ' + e.page, kind: 'toc', b });
    else if (t === 'field') U.push({ text: b.label, kind: 'field', b });
    else if (t === 'check') U.push({ text: b.label + ' ' + b.options.join(' '), kind: 'check', b });
    else if (t === 'grid') U.push({ text: b.label, kind: 'grid', b });
    else if (t === 'leader') U.push({ text: b.text + ' ' + b.value, kind: 'leader', b });
    else if (t === 'figure') U.push({ text: b.caption, kind: 'caption', b });
    else if (t === 'slide') for (const x of b.boxes) { if (x.items) for (const i of x.items) U.push({ text: i, kind: 'li', b, slide: b.n }); else U.push({ text: x.text, kind: x.role === 'title' ? 'h' : 'p', b, slide: b.n }); }
    else if (t === 'table' && b.caption) U.push({ text: b.caption, kind: 'caption', b });
  }
  return U;
}

async function score3(D, T, meta) {
  const S = {}; const U = units(T); const raw = await D.zip.file('word/document.xml').async('string'); const settings = D.zip.file('word/settings.xml') ? await D.zip.file('word/settings.xml').async('string') : '';
  const body = D.paras.filter((p) => !p.table && fold(p.text)); const all = D.paras.filter((p) => fold(p.text));
  const tableTexts = T.blocks.filter((b) => b.type === 'table').flatMap((b) => b.rows.flat().map((c) => c.text));
  const layoutTexts = T.blocks.filter((b) => b.type === 'layout').flatMap((b) => b.cols.flat());
  // ---- text: the body (not tables, not headers/footers/notes) against the truth's units in reading order (order-sensitive),
  // and every truth word (tables and layout cells too) found anywhere in the body or its tables.
  { const exp = fold(U.map((u) => u.text).join('')); const lay = new Set(layoutTexts.map(fold));
    const got = fold(body.filter((p) => !lay.has(fold(p.text))).map((p) => p.text).join('').replace(/([a-z])-\s*([a-z])/g, '$1$2'));
    const gotJoined = got; S.text_acc = clamp(1 - dist(gotJoined, exp) / Math.max(exp.length, gotJoined.length, 1));
    const ew = words(U.map((u) => u.text).concat(tableTexts, layoutTexts).join(' ')); const gw = words(all.map((p) => p.text).join(' ').replace(/([A-Za-z])[‐‑­-]\s+([a-z])/g, '$1$2')); S.text_rec = recall(ew, gw); }
  // ---- paragraphs: truth units matched one to one by text (sim >= 0.85), F1 over units and body paragraphs
  const match = (u, pool, used) => { const fe = fold(u.text); let best = 0, bp = null; for (const p of pool) { if (used.has(p)) continue; const f = fold(p.text.replace(/^\s*[•◦▪●·\-–]\s*/, '').replace(/(?:[.·…_]\s?){3,}/g, ' ')); if (!f) continue; const sc = sim(f, fe); if (sc > best) { best = sc; bp = p; } } return best >= 0.85 ? bp : null; };
  { const used = new Set(); let m = 0; for (const u of U) { const p = match(u, body, used); if (p) { used.add(p); m++; u.p = p; } } const rec = m / U.length, prec = body.length ? used.size / body.length : 0; S.para_f1 = rec + prec ? 2 * rec * prec / (rec + prec) : 0; }
  // ---- headings: truth headings as headings (level as given); headings_prec: share of the .docx headings that are truth headings
  { const hs = U.filter((u) => u.kind === 'h' && !u.slide); if (hs.length) { let st = 0, lv = 0; for (const u of hs) { const p = u.p; if (p && p.heading) { st++; const want = u.b.type === 'title' ? 0 : u.b.level; if (p.heading.level === want || (want === 0 && p.heading.title)) lv++; } } S.headings_rec = st / hs.length; S.headings_level = lv / hs.length; }
    const dh = body.filter((p) => p.heading); const th = U.filter((u) => u.kind === 'h').map((u) => fold(u.text)); if (dh.length || th.length) S.headings_prec = dh.length ? dh.filter((p) => th.some((t) => sim(fold(p.text), t) >= 0.85)).length / dh.length : 1; }
  // ---- lists
  { const its = U.filter((u) => u.kind === 'li' && u.it); if (its.length) S.lists_real = its.filter((u) => u.p && u.p.num && u.p.numKind === (u.b.type === 'ul' ? 'bullet' : 'number')).length / its.length; }
  // ---- tables: cells found; merged cells as merged (gridSpan / vMerge); money columns right-aligned; a right-to-left table's order
  for (const tb of T.blocks.filter((b) => b.type === 'table')) {
    const exp = tb.rows.flat(); let best = null, bm = -1;
    for (const t of D.tables) { const cells = t.rows.flatMap((r) => r.cells).map((c) => fold(c.text)); const m = exp.filter((e) => cells.some((c) => sim(c, fold(e.text)) >= 0.85)).length; if (m > bm) { bm = m; best = t; } }
    S.table_cells = (S.table_cells ?? 0) + (best ? bm / exp.length : 0) / T.blocks.filter((b) => b.type === 'table').length;
    const cellOf = (txt) => { if (!best) return null; for (let ri = 0; ri < best.rows.length; ri++) { const r = best.rows[ri]; for (let ci = 0; ci < r.cells.length; ci++) if (sim(fold(r.cells[ci].text), fold(txt)) >= 0.85 && fold(txt)) return { ri, ci, c: r.cells[ci], row: r }; } return null; };
    const merged = exp.filter((c) => (c.span || 1) > 1 || (c.rowspan || 1) > 1);
    if (merged.length) { let ok = 0; for (const m of merged) { const x = cellOf(m.text); if (!x) continue; const spanOk = (m.span || 1) === x.c.span; let vOk = true; if ((m.rowspan || 1) > 1) { vOk = x.c.vm === 'restart'; const nx = best.rows[x.ri + 1]; if (vOk && nx) { let col = 0; for (const c of x.row.cells.slice(0, x.ci)) col += c.span; let k = 0, cc = null; for (const c of nx.cells) { if (k === col) { cc = c; break; } k += c.span; } vOk = !!cc && cc.vm === 'continue'; } } if (spanOk && vOk) ok++; } S.table_merged = ok / merged.length; }
    if (tb.money) { const nums = exp.filter((c) => /^\d+\.\d\d$/.test(c.text)); let ok = 0; for (const n of nums) { const x = cellOf(n.text); if (x && x.c.paras.some((p) => ['right', 'end'].includes(p.jc))) ok++; } S.table_money = nums.length ? ok / nums.length : null; }
    if (tb.dir === 'rtl' && best) { let ok = 0, n = 0; for (const r of tb.rows) { const x = cellOf(r[0].text); if (!x) continue; n++; const first = best.bidiVisual ? x.ci === 0 : x.ci === x.row.cells.length - 1; if (first) ok++; } S.table_rtl = n ? ok / n : 0; }
  }
  // ---- emphasis (bold/italic words, body), raised/lowered runs (not note references), notes
  { const eb = [], gb = []; for (const b of T.blocks) if (b.type === 'p') for (const r of b.runs) { if (r.b) eb.push(...words(r.t)); } for (const p of body) { if (p.heading) continue; for (const r of p.runs) if (r.b) gb.push(...words(r.text)); }
    const th = new Set(U.filter((u) => u.kind === 'h').map((u) => fold(u.text))); const gb2 = gb.filter((w) => !th.has(w));
    if (eb.length) { const r = recall(eb, gb2), pr = gb2.length ? recall(gb2, eb) : 0; S.emphasis = r + pr ? 2 * r * pr / (r + pr) : 0; } }
  { const want = []; for (const b of T.blocks) if (b.runs) for (const r of b.runs) if (r.sup || r.sub) want.push({ t: r.t, va: r.sup ? 'superscript' : 'subscript' }); for (const b of T.blocks) if (b.type === 'eq') { /* displayed: not counted */ }
    if (want.length) { const pool = D.paras.flatMap((p) => p.runs).filter((r) => r.va && !r.foot); const used = new Set(); let ok = 0; for (const w of want) { const r = pool.find((x) => !used.has(x) && x.va === w.va && fold(x.text) === fold(w.t)); if (r) { used.add(r); ok++; } } S.supsub = ok / want.length; } }
  { const notes = Object.values(T.footnotes || {}); const refs = T.blocks.flatMap((b) => (b.runs || []).filter((r) => 'fn' in r)).length;
    if (notes.length) { let sc = 0; for (const f of notes) { const ff = fold(f); if (D.footnotes.some((x) => sim(fold(x).replace(/^\d+/, ''), ff) >= 0.85)) sc += 1; else if (D.paras.some((p) => fold(p.text).includes(ff.slice(0, 20)))) sc += 0.5; } S.footnotes = sc / notes.length; }
    // notes_false: note references the .docx makes beyond the truth's (a raised affiliation mark or exponent made a note)
    if (notes.length || D.footRefs) S.notes_false = D.footRefs <= refs ? 1 : clamp(1 - (D.footRefs - refs) / Math.max(1, refs + 2)); }
  // ---- equations: the number in the paragraph (or table row) that holds the equation's letters
  { const eqs = T.blocks.filter((b) => b.type === 'eq'); if (eqs.length) { let ok = 0; for (const e of eqs) { const letters = fold(e.text).replace(/[^a-z]/g, ''); const host = [...D.paras, ...D.tables.flatMap((t) => t.rows.map((r) => ({ text: r.cells.map((c) => c.text).join(' ') })))].find((p) => p.text.includes(e.num) && (() => { const l = fold(p.text).replace(/[^a-z]/g, ''); const ex = [...letters]; let hit = 0; const pool = [...l]; for (const c of ex) { const i = pool.indexOf(c); if (i >= 0) { hit++; pool.splice(i, 1); } } return hit / ex.length >= 0.7 && l.length <= letters.length * 2.5; })()); if (host) ok++; } S.eq_num = ok / eqs.length; } }
  // ---- references kept whole (one paragraph each)
  { const refs = U.filter((u) => u.kind === 'ref'); if (refs.length) S.refs_whole = refs.filter((u) => u.p).length / refs.length; }
  // ---- verse: both halves in one paragraph (or one table row), first half first, apart (a tab, a run of spaces, or two cells)
  { const vs = T.blocks.filter((b) => b.type === 'verse'); if (vs.length) { let sc = 0; for (const v of vs) { const a = fold(v.a), b = fold(v.b);
      const row = D.tables.flatMap((t) => t.rows).find((r) => r.cells.some((c) => sim(fold(c.text), a) >= 0.85) && r.cells.some((c) => sim(fold(c.text), b) >= 0.85)); if (row) { sc += 1; continue; }
      const p = D.paras.find((q) => { const f = fold(q.text); return f.includes(a.slice(0, 8)) && f.includes(b.slice(0, 8)); }); if (!p) continue; const t = p.text.normalize('NFKC'); const ia = fold(t).indexOf(a.slice(0, 8)), ib = fold(t).indexOf(b.slice(0, 8));
      const apart = p.runs.some((r) => r.tab) || /\S(\s{3,}|\t)\S/.test(t); sc += ia >= 0 && ib > ia ? (apart || p.runs.some((r) => r.text === ' ' && false) ? 1 : 0.5) : 0.25; }
    S.verse = sc / vs.length; } }
  // ---- running heads and feet: in the header/footer parts, not in the body
  { const m = T.meta; const heads = [m.header, ...T.blocks.filter((b) => b.chapter).map((b) => b.chapter), m.footer].filter(Boolean).map(fold);
    // (A one-page PDF shows nothing repeating: its foot is body text as much as a footer, so none of this is judged there.)
    if ((heads.length || m.pageNumbers) && meta.pages > 1) {
      const inHf = (t) => D.hf.some((h) => sim(fold(h.text).replace(/\d+$/, ''), t) >= 0.8 || fold(h.text).includes(t));
      const want = [m.header && fold(m.header), m.footer && fold(m.footer)].filter(Boolean); let got = want.filter(inHf).length, n = want.length;
      if (m.pageNumbers) { n++; if (D.hf.some((h) => h.page) || D.fieldsPage > 0) got++; } S.hf_present = n ? got / n : null;
      // a body paragraph that is only a running head / foot / chapter head / page number (the chapter's own heading aside)
      const isHead = (p) => { const f = fold(p.text); if (!f) return false; if (/^(\d{1,3}|[ivx]{1,5}|page\d{1,3})$/.test(f)) return true; if (p.heading) return false; return heads.some((h) => sim(f, h) >= 0.85) || (fold(m.header || '') && sim(f, fold(m.header)) >= 0.85); };
      const poll = body.filter(isHead).length; const truthSame = U.filter((u) => u.kind !== 'h' && heads.some((h) => sim(fold(u.text), h) >= 0.85)).length;
      S.hf_pollution = clamp(1 - Math.max(0, poll - truthSame) / Math.max(1, meta.pages)); }
    if (m.headerOdd) { const evenOdd = /<w:evenAndOddHeaders(?!\s+w:val="(0|false)")/.test(settings); const chap = T.blocks.filter((b) => b.chapter).map((b) => fold(b.chapter)); const hasEven = D.hf.some((h) => sim(fold(h.text), fold(m.header)) >= 0.85); const hasOdd = chap.some((c) => D.hf.some((h) => sim(fold(h.text), c) >= 0.85)); S.odd_even = ((evenOdd ? 1 : 0) + (hasEven ? 1 : 0) + (hasOdd ? 1 : 0)) / 3; } }
  // ---- leaders: contents entries and form leaders — text and number in one paragraph of their own, with a leader (a tab stop's or dots)
  const leaderScore = (txt, val) => { const p = D.paras.find((q) => { const f = fold(q.text); return f.includes(fold(txt)) && f.includes(fold(val)); }); if (!p) { const q = D.paras.find((x) => words(x.text).join(' ').includes(words(txt).join(' '))); return q ? 0.1 : 0; } const alone = fold(p.text.replace(/[.\s…·_]+/g, '')).length <= fold(txt + val).length + 2; const lead = p.leaderTabs > 0 && p.runs.some((r) => r.tab) || /\.{4,}|(\. ){4,}|…{2,}/.test(p.text); const spaced = !/\s/.test(txt) || words(p.text).join(' ').includes(words(txt).join(' ')); return (alone ? 0.4 : 0) + (lead ? 0.3 : 0) + (spaced ? 0.3 : 0); };
  { const toc = T.blocks.filter((b) => b.type === 'toc').flatMap((b) => b.entries); if (toc.length) S.toc_leaders = toc.reduce((a, e) => a + leaderScore(e.text, e.page), 0) / toc.length;
    const ld = T.blocks.filter((b) => b.type === 'leader'); if (ld.length) S.leaders = ld.reduce((a, e) => a + leaderScore(e.text, e.value), 0) / ld.length; }
  // ---- form fields: the label's paragraph (or cell) holds a line to write on beside it: an underlined tab/space run, underscores,
  // a rule under the paragraph, or a bordered cell beside it
  { const fs = T.blocks.filter((b) => b.type === 'field'); if (fs.length) { let ok = 0; for (const f of fs) { const p = D.paras.find((q) => fold(q.text).startsWith(fold(f.label)) && fold(q.text).length <= fold(f.label).length + 4); if (!p) continue; if (p.runs.some((r) => r.u && /^[\s\t ]+$/.test(r.text) && r.text.length) || /_{4,}/.test(p.text) || p.ruleBelow) ok++; } S.fields = ok / fs.length; }
    const cs = T.blocks.filter((b) => b.type === 'check'); if (cs.length) { let sc = 0, n = 0; for (const c of cs) for (const o of c.options) { n++; const p = D.paras.find((q) => words(q.text).includes(o.toLowerCase())); if (!p) continue; const glyphs = (p.text.match(/[☐□■▢❑❒]/g) || []).length; if (glyphs + p.shapes >= c.options.length || p.shapes + glyphs >= 1 && c.options.length === 1) sc++; } S.checkboxes = n ? sc / n : null; }
    const gs = T.blocks.filter((b) => b.type === 'grid'); if (gs.length) S.grid = gs.filter((g) => D.tables.some((t) => t.rows.some((r) => r.cells.length >= g.n && r.cells.every((c) => !fold(c.text))))).length / gs.length; }
  // ---- drop caps: the chapter's first paragraph whole (its first word whole, its first line's words in order), or a drop-cap frame
  // with the letter followed by the paragraph's rest
  { const dc = T.blocks.filter((b) => b.dropcap); if (dc.length) { let sc = 0; for (const b of dc) { const t = b.runs[0].t; const head = words(t).slice(0, 14).join(' '); const i = D.paras.findIndex((p) => words(p.text).join(' ').startsWith(head)); if (i >= 0) { sc++; continue; } const j = D.paras.findIndex((p) => p.dropCap && fold(p.text) === fold(t[0])); if (j >= 0 && D.paras[j + 1] && words(D.paras[j + 1].text).join(' ').startsWith(words(t.slice(1)).slice(0, 13).join(' '))) sc++; } S.dropcap = sc / dc.length; } }
  // ---- a word hyphenated at a page's end comes back whole (book-xelatex: «instruments»)
  if (meta.id === 'book-xelatex') S.hyphen_page = /instruments/.test(fold(body.map((p) => p.text).join(' '))) ? 1 : 0;
  // ---- slides: each slide's boxes in order and before the next slide's; each slide's text readable (not white on no background)
  { const sl = U.filter((u) => u.slide); if (sl.length) { const stream = fold(body.map((p) => p.text).join('')); const at = sl.map((u) => stream.indexOf(fold(u.text))); let ok = 0; for (let i = 1; i < at.length; i++) if (at[i] >= 0 && at[i - 1] >= 0 && at[i] > at[i - 1]) ok++; S.slide_order = ok / (at.length - 1);
      const bg = /<w:background\b/.test(raw) || /behindDoc="1"/.test(raw) || /<w:shd [^>]*w:fill="(?!auto|FFFFFF|ffffff)/.test(raw); const light = (c) => /^[EF][0-9A-F][EF][0-9A-F][EF][0-9A-F]$/.test(c); let vis = 0, n = 0;
      for (const u of sl) { n++; const p = u.p || body.find((q) => fold(q.text).includes(fold(u.text))); if (!p) continue; const lightTxt = p.runs.filter((r) => fold(r.text)).every((r) => light(r.color)); if (!lightTxt || bg) vis++; } S.slide_visible = vis / n; } }
  return S;
}
module.exports = { score3, pdfInfo3, ORDER, units };
