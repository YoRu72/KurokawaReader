// node gen_pdflib.cjs: pdf-lib rendering: plain positioned text (standard Helvetica/Courier, WinAnsi) with a drawn table and
// a picture. No footnotes, no links, no Arabic/CJK (standard fonts cannot encode them): those features are "absent".
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib'); const fs = require('fs'); const path = require('path');
const SRC = JSON.parse(fs.readFileSync(path.join(__dirname, '../source.json'), 'utf8'));
(async () => {
  const doc = await PDFDocument.create(); doc.setTitle(SRC.meta.title);
  const F = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold), i: await doc.embedFont(StandardFonts.HelveticaOblique), m: await doc.embedFont(StandardFonts.Courier) };
  const img = await doc.embedPng(fs.readFileSync(path.join(__dirname, 'figure.png')));
  const PW = 595, PH = 842, M = 62; let page, y, n = 0;
  const newPage = () => { page = doc.addPage([PW, PH]); n++; y = PH - 70;
    const h = SRC.meta.header; page.drawText(h, { x: (PW - F.r.widthOfTextAtSize(h, 8)) / 2, y: PH - 36, size: 8, font: F.r });
    const f = `${SRC.meta.footer} - Page ${n}`; page.drawText(f, { x: (PW - F.r.widthOfTextAtSize(f, 8)) / 2, y: 30, size: 8, font: F.r }); };
  newPage(); const need = (h) => { if (y - h < 56) newPage(); };
  const wrap = (rs, size, width) => { // runs → lines of [word, font]
    const words = []; for (const r of rs) { if (r.fn) continue; const f = r.b ? F.b : r.i ? F.i : r.mono ? F.m : F.r; for (const w of r.t.split(/(\s+)/)) { if (w === '') continue; words.push([w, f]); } }
    const lines = [[]]; let x = 0;
    for (const [w, f] of words) { const ww = f.widthOfTextAtSize(w, size); if (/^\s+$/.test(w)) { if (x > 0) { lines[lines.length - 1].push([' ', f]); x += ww; } continue; } if (x + ww > width && x > 0) { lines.push([]); x = 0; } lines[lines.length - 1].push([w, f]); x += ww; }
    return lines; };
  const para = (rs, { size = 10.5, x0 = M, width = PW - 2 * M, gap = 6, lead = 1.32 } = {}) => { for (const ln of wrap(rs, size, width)) { need(size * lead); let x = x0; y -= size * lead; for (const [w, f] of ln) { page.drawText(w, { x, y, size, font: f }); x += f.widthOfTextAtSize(w, size); } } y -= gap; };
  const plain = (t, o = {}) => para([{ t }], o);
  for (const b of SRC.blocks) {
    if (b.lang && b.lang !== 'en') continue; const t = b.type;
    if (t === 'title') { need(60); para([{ t: b.text, b: true }], { size: 22, gap: 10 }); }
    else if (t === 'h') { const s = [0, 16, 13.5, 11.5][b.level]; need(s * 2.5); y -= s * 0.6; para([{ t: b.text, b: true }], { size: s, gap: 3 }); }
    else if (t === 'p') para(b.runs);
    else if (t === 'ul' || t === 'ol') { let k = 0; for (const it of b.items) { k = it.level ? k : k + 1; const mark = t === 'ul' ? '-' : k + '.'; need(14); y -= 14; page.drawText(mark, { x: M + 6 + it.level * 20, y, size: 10.5, font: F.r }); page.drawText(it.text, { x: M + 22 + it.level * 20, y, size: 10.5, font: F.r }); } y -= 6; }
    else if (t === 'table') { const rows = b.rows, cw = 150, rh = 22; need(rows.length * rh + 20); y -= 8; const top = y;
      rows.forEach((row, ri) => { let ci = 0; for (const c of row) { const sp = c.span || 1; const x = M + ci * cw; const lines = c.text.split('\n');
        lines.forEach((ln, li) => page.drawText(ln, { x: x + 6, y: top - ri * rh - 14 - li * 10 + (lines.length > 1 ? 4 : 0), size: 9.5, font: c.header ? F.b : F.r }));
        page.drawRectangle({ x, y: top - (ri + 1) * rh, width: cw * sp, height: rh, borderColor: rgb(0, 0, 0), borderWidth: 0.6 }); ci += sp; } });
      y = top - rows.length * rh - 12; }
    else if (t === 'figure') { need(150); const w = 226, h = w * 190 / 360; page.drawImage(img, { x: (PW - w) / 2, y: y - h, width: w, height: h }); y -= h + 12; const cw = F.r.widthOfTextAtSize(b.caption, 9); page.drawText(b.caption, { x: (PW - cw) / 2, y, size: 9, font: F.r }); y -= 14; }
    else if (t === 'columns') { const colW = (PW - 2 * M - 20) / 2; const startY = y; let maxUsed = y;
      [[0, 1], [2, 3]].forEach(([a, c], k) => { y = startY; for (const idx of [a, c]) para(b.blocks[idx].runs, { size: 10, x0: M + k * (colW + 20), width: colW, gap: 6 }); maxUsed = Math.min(maxUsed, y); }); y = maxUsed; }
    else if (t === 'code') { for (const ln of b.lines) { need(12); y -= 12; page.drawText(ln, { x: M + 12, y, size: 9.5, font: F.m }); } y -= 8; }
  }
  fs.writeFileSync(path.join(__dirname, '../pdf/pdflib.pdf'), await doc.save()); console.log('wrote pdflib.pdf');
})();
