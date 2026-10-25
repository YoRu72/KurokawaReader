// The PDF viewer's text layer — the invisible text laid over the page picture that selection, copy and
// search work on. pdf.js lays out one box per piece of text in drawing order; a PDF that draws Arabic
// letter by letter (with its harakat drawn apart, often afterwards) then gives a layer where a mark is a box
// of its own, words are scattered boxes in the order they were painted, and dragging across a line runs
// left to right. This builds the layer from the same text, but as a reader sees it:
//  - harakat put back inside the letter they sit on,
//  - each line cut into words, every word one box exactly over its letters on the page,
//  - the boxes in reading order (right to left on Arabic lines), so a selection follows the text.
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { findVertical, plainVerticalForms, type VPiece } from './pdfvertical';
import { ltrRunsForward, joinLine, attachMarks, balanceBrackets, cleanPdfText, COMBINING, dropBuriedSpaces, fixLoneBrackets, isRtlText, logicalNeutral, logicalRtlPiece, findColumns } from './pdftext';

type Item = { str: string; transform: number[]; width: number; height: number; dir?: string; fontName?: string; krLead?: boolean };
type Piece = { text: string; l: number; r: number; y: number; h: number; space?: boolean; keep?: boolean; hint?: boolean; glued?: boolean };
type Word = { text: string; l: number; r: number; y: number; h: number; rtl: boolean; brk?: boolean; glued?: boolean };

const mul = (m: number[], n: number[]) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, size: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * size * 0.5;
  measureCtx.font = `${size}px sans-serif`;
  return measureCtx.measureText(text).width;
}


/** The words of one line, in reading order. */
function wordsOf(line: Piece[]): Word[] {
  const rtl = isRtlText(line.map((p) => p.text).join(''));
  const sorted = dropBuriedSpaces(line, (p) => !!p.space || !!p.hint).sort((a, b) => (rtl ? b.r - a.r || b.l - a.l : a.l - b.l || a.r - b.r));
  const fixed = fixLoneBrackets(sorted, rtl);
  sorted.forEach((p, i) => { if (fixed[i] !== p.text) sorted[i] = { ...p, text: fixed[i] }; });
  const marked = sorted.some((p) => p.space);
  const words: Word[] = [];
  let cur: Word | null = null; let edge = 0; let breakNext = false; let hintNext = false; let zeroLast = 0;
  const dirOf = (t: string) => (RTL_CHAR.test(t) ? 'r' : LTR_CHAR.test(t) ? 'l' : '');
  let curDir = '';
  for (const p of sorted) {
    if (p.space) { breakNext = true; continue; }
    // (A space pdf.js found in a gap: a word break when the gap is really there — Word sets its Arabic
    // words apart by little more than a tenth of the type size.)
    if (p.hint) { hintNext = true; continue; }
    const text = rtl ? balanceBrackets(logicalNeutral(logicalRtlPiece(p.text, p.keep), true)) : p.text;
    const d = dirOf(text);
    // (After a piece of no width — a half-form of an Indic conjunct, whose advance the PDF left out — the
    // distances of the next two pieces say nothing: the conjunct's own glyph is wider than their advances.)
    const gap: number = cur && !zeroLast ? (rtl ? edge - p.r : p.l - edge) : 0;
    // (Never before closing punctuation, or after an opening bracket: those spaces are pdf.js's guess at a
    // change of type size, as for a raised note number.)
    const hinted: boolean = !marked && hintNext && gap > p.h * 0.1 && !/^[.,،؛:!?؟)\]»”’}]/.test(text) && !(cur && /[(\[«“‘{]$/.test(cur.text));
    // (Pieces cut from one run, placed by estimate: only a drawn space parts them from their neighbours.)
    const brk: boolean = breakNext || (!(p.glued || (cur as Word | null)?.glued) && (hinted || (gap > p.h * (marked ? 0.3 : 0.18) && !COMBINING.test(text[0]))));
    const split = !cur || brk || (d && curDir && d !== curDir);
    if (split) {
      cur = { text, l: p.l, r: p.r, y: p.y, h: p.h, rtl: d ? d === 'r' : rtl, brk: !!cur && !!brk, glued: p.glued };
      words.push(cur); curDir = d;
    } else {
      cur!.text += text; cur!.l = Math.min(cur!.l, p.l); cur!.r = Math.max(cur!.r, p.r); cur!.h = Math.max(cur!.h, p.h);
      if (d && !curDir) { curDir = d; cur!.rtl = d === 'r'; }
    }
    edge = rtl ? (split ? p.l : Math.min(edge, p.l)) : (split ? p.r : Math.max(edge, p.r));
    breakNext = false; hintNext = false; zeroLast = p.r - p.l <= 0.02 && !!text.trim() ? 2 : Math.max(0, zeroLast - 1);
  }
  const clean = words.map((w) => ({ ...w, text: w.text.replace(/\s+/g, ' ').trim() })).filter((w) => w.text);
  // (On a right-to-left line, Latin words and the numbers among them keep their own left-to-right order.)
  return rtl ? ltrRunsForward(clean, (w) => w.text).seq : clean;
}

/** Pieces that repeat an earlier piece's text at (nearly) its place are taken out, in drawing order. */
function dropDoubleDrawn(pieces: Piece[]): void {
  const seen = new Map<string, Piece[]>();
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.space || p.hint || !p.text.trim()) continue;
    const key = p.text;
    const list = seen.get(key);
    if (list) {
      const tol = Math.max(0.5, p.h * 0.25);
      const twin = list.find((q) => Math.abs(q.y - p.y) < tol && Math.abs(q.l - p.l) < tol * 1.2 && Math.abs((q.r - q.l) - (p.r - p.l)) < Math.max(tol, (p.r - p.l) * 0.2));
      if (twin) { pieces.splice(i, 1); i--; continue; }
      list.push(p);
    } else seen.set(key, [p]);
  }
}

export interface PdfTextLayer { cancel(): void }

type Turned = { text: string; tx: number[]; w: number; h: number; angle: number };
type Laid = { blocks: Piece[][][]; lines: Piece[][]; vert: ReturnType<typeof findVertical>; turned: Turned[]; vTurned: Set<number> };

/** The page's text as a reader sees it: lines (pieces by baseline, harakat back in their letters), vertical
 *  columns in reading order, and text set at an angle. Positions are the viewport's. */
function layText(items: Item[], viewport: { scale: number; transform: number[] }): Laid {
  const pieces: Piece[] = [];
  const turned: Turned[] = [];
  for (const raw of items) {
    if (typeof raw.str !== 'string') continue;
    let text = cleanPdfText(raw.str);
    const tx = mul(viewport.transform, raw.transform);
    const h = Math.hypot(tx[2], tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    const w = raw.width * viewport.scale;
    // (U+2009 marks a space the page draws, see scripts/patch-pdfjs.mjs; pdf.js's own " " items only fill gaps.)
    if (/^\u2009+$/.test(text)) { pieces.push({ text: ' ', l: tx[4], r: tx[4] + w, y: tx[5], h, space: true }); continue; }
    if (!h) continue;
    if (!text.trim()) { if (w > 0 && Math.abs(angle) <= 0.02) pieces.push({ text: ' ', l: tx[4], r: tx[4] + w, y: tx[5], h, hint: true }); continue; }
    if (Math.abs(angle) > 0.02) { turned.push({ text, tx, w, h, angle }); continue; }
    pieces.push({ text, l: tx[4], r: tx[4] + Math.max(w, 0.01), y: tx[5], h, keep: !!raw.krLead });
  }
  // Text drawn twice in the same place — a heading's shadow or outline under it, a fake bold made of two
  // passes a hair apart — is one text to the reader: the second drawing goes.
  dropDoubleDrawn(pieces);
  // A run with a space inside it over which another run is drawn (a letter the run's font lacks, set from
  // another font into the gap the run left for it — "بہت" as "ب ت" with "ہ" drawn between): the run is cut at
  // its spaces so the pieces take their own places in the line.
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.space || p.hint || !/\S\s+\S/.test(p.text) || p.r - p.l < 0.1) continue;
    const inside = pieces.some((q, j) => j !== i && !q.space && !q.hint && q.text.trim() && Math.abs(q.y - p.y) < p.h * 0.5 && q.l > p.l + 0.3 && q.r < p.r - 0.3);
    if (!inside) continue;
    const rtl = isRtlText(p.text); const cw = (p.r - p.l) / p.text.length; const parts: Piece[] = [];
    for (const m of p.text.matchAll(/\S+/g)) {
      const a = m.index!, b = a + m[0].length;
      parts.push({ ...p, text: m[0], l: rtl ? p.r - b * cw : p.l + a * cw, r: rtl ? p.r - a * cw : p.l + b * cw, glued: true });
    }
    pieces.splice(i, 1, ...parts); i += parts.length - 1;
  }
  // Vertical writing (Japanese, Chinese, Korean set in columns; Mongolian): its columns are found first and
  // laid as columns; the rest is read in lines. A word turned on its side within a column joins it.
  const vp: VPiece[] = pieces.map((p) => ({ text: p.hint ? '' : p.text, l: p.l, r: p.r, y: p.y, h: p.h }));
  const turnedV: number[] = [];
  turned.forEach((t, k) => { if (Math.abs(t.angle - Math.PI / 2) < 0.05) { vp.push({ text: t.text, l: t.tx[4] - t.h * 0.12, r: t.tx[4] + t.h * 0.88, y: t.tx[5] + t.w, h: t.h, t: t.tx[5], b: t.tx[5] + t.w }); turnedV.push(k); } });
  const vert = findVertical(vp);
  const vTurned = new Set(turnedV.filter((_, j) => vert.vertical.has(pieces.length + j)));
  const flat = vert.vertical.size ? pieces.filter((_, i) => !vert.vertical.has(i)) : pieces;
  // Harakat drawn on their own go back into their letters; then the page is cut into its blocks of text —
  // boxes, columns, a label beside a paragraph — and each block into lines by baseline, top to bottom.
  const letters = attachMarks(flat.filter((p) => !p.space && !p.hint));
  const blanks = flat.filter((p) => p.space || p.hint);
  // Blocks that stand one under the other in the same column — the lines of a paragraph cut apart by their
  // leading, a heading and its paragraph — are one block again: their lines are joined as lines of a column.
  const regions: Piece[][] = [];
  const bounds = (blk: Piece[]) => ({ l: Math.min(...blk.map((p) => p.l)), r: Math.max(...blk.map((p) => p.r)), t: Math.min(...blk.map((p) => p.y - p.h * 0.8)), b: Math.max(...blk.map((p) => p.y + p.h * 0.22)), m: [...blk].sort((x, y) => x.h - y.h)[blk.length >> 1].h });
  for (const blk of segment(letters)) {
    const prev = regions[regions.length - 1];
    if (prev) {
      const a = bounds(prev), b = bounds(blk);
      const overlap = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      if (overlap >= Math.min(a.r - a.l, b.r - b.l) * 0.6 && b.t >= a.b - a.m * 0.3 && b.t - a.b <= a.m * 2.5) { prev.push(...blk); continue; }
    }
    regions.push([...blk]);
  }
  const blocks = regions.map((region) => {
    const kept = region.concat(blanks.filter((p) => region.some((q) => Math.abs(q.y - p.y) < Math.max(q.h, p.h) * 0.5 && p.l < q.r + q.h && p.r > q.l - q.h)));
    kept.sort((a, b) => a.y - b.y);
    const lines: Piece[][] = [];
    for (const p of kept) {
      // (A space item may carry no real height: the line's letters decide.)
      const ln = lines.find((l) => { const lh = l.find((q) => !q.space && !q.hint)?.h ?? l[0].h; return Math.abs(l[0].y - p.y) < (p.space || p.hint ? lh : Math.min(lh, p.h)) * 0.5; });
      if (ln) ln.push(p); else lines.push([p]);
    }
    lines.sort((a, b) => a[0].y - b[0].y);
    return lines;
  }).filter((b) => b.length);
  return { blocks, lines: blocks.flat(), vert, turned, vTurned };
}

/**
 * The page cut into blocks of text, in reading order (the XY cut): a region is split where a band of white
 * runs right across it, or a gutter runs down it, and each part is cut again until nothing divides it.
 * Lines of a page set in columns are kept in their columns (a gutter with dense text down both sides is cut
 * before anything else); otherwise rows come first, so a label beside a box of text is read with it, and a
 * gutter between a label and its text is cut last, within the row.
 */
function segment(pieces: Piece[]): Piece[][] {
  const all = pieces.map((p) => ({ p, l: p.l, r: p.r, t: p.y - p.h * 0.8, b: p.y + p.h * 0.22 }));
  if (all.length < 2) return all.length ? [pieces] : [];
  const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a[a.length >> 1]; };
  type Box = (typeof all)[number];
  // A word set huge behind the page's text — a watermark, a faint title as decoration — would bridge every gap:
  // it is set aside and read on its own where it stands.
  const m0 = median(all.map((b) => b.p.h));
  const over = (a: Box, b: Box) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  const behind = all.filter((b) => b.p.h > m0 * 2.5 && all.filter((o) => o !== b && o.p.h < b.p.h * 0.6 && over(b, o)).length >= 2);
  const boxes = behind.length ? all.filter((b) => !behind.includes(b)) : all;
  if (boxes.length < 2) return [pieces];
  const gaps = (bs: Box[], axis: 'x' | 'y', min: number): [number, number][] => {
    const iv = bs.map((b) => (axis === 'x' ? [b.l, b.r] : [b.t, b.b])).sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = []; let end = iv[0][1];
    for (let i = 1; i < iv.length; i++) { if (iv[i][0] - end >= min) out.push([end, iv[i][0]]); end = Math.max(end, iv[i][1]); }
    return out;
  };
  // Text set in a column: lines that fill the height, and wide enough to be lines of text — a column of labels
  // (numbers, letters, a name or two beside each box) is neither.
  const dense = (bs: Box[], m: number): boolean => {
    if (bs.length < 3) return false;
    const rows: Box[][] = [];
    for (const b of [...bs].sort((a, b2) => a.p.y - b2.p.y)) { const cur = rows[rows.length - 1]; if (cur && Math.abs(cur[0].p.y - b.p.y) <= m * 0.5) cur.push(b); else rows.push([b]); }
    if (rows.length < 3) return false;
    const t = Math.min(...bs.map((b) => b.t)), bt = Math.max(...bs.map((b) => b.b));
    const L = Math.min(...bs.map((b) => b.l)), R = Math.max(...bs.map((b) => b.r)), w = R - L;
    // (Lines of text run most of the column's width; labels of a few letters, set here and there, do not.)
    const fill = rows.reduce((sum, row) => sum + (Math.max(...row.map((b) => b.r)) - Math.min(...row.map((b) => b.l))), 0) / rows.length / Math.max(1, w);
    // (Or a paragraph: three lines or more set one under the other at a line's pitch.)
    let run = 1, paragraph = false;
    for (let i = 1; i < rows.length && !paragraph; i++) { run = rows[i][0].p.y - rows[i - 1][0].p.y <= m * 1.8 ? run + 1 : 1; if (run >= 3) paragraph = true; }
    return w >= m * 6 && (fill >= 0.7 || paragraph) && (rows.length * m * 1.15) / Math.max(1, bt - t) >= 0.35;
  };
  // A side of labels: blocks of one line each, set apart from one another (a card of a few lines is not a
  // label, nor are the lines of a paragraph the cut parted at their leading).
  const labelsOnly = (blocks: Piece[][], m: number): boolean => blocks.every((blk, i) => blk.every((p) => Math.abs(p.y - blk[0].y) < Math.max(p.h, blk[0].h) * 0.5) && (i === 0 || Math.abs(blk[0].y - blocks[i - 1][0].y) > m * 1.8));
  const out: Piece[][] = [];
  const cut = (bs: Box[], depth: number): void => {
    if (bs.length < 2 || depth > 80) { out.push(bs.map((b) => b.p)); return; }
    const m = median(bs.map((b) => b.p.h));
    const rtl = isRtlText(bs.map((b) => b.p.text).join(''));
    const vgaps = gaps(bs, 'x', m * 0.9), hgaps = gaps(bs, 'y', m * 0.45);
    const dbgCut = (globalThis as { krDebugCut?: boolean }).krDebugCut;
    if (dbgCut) console.warn('KR cut', depth, bs.length, +m.toFixed(1), JSON.stringify({ v: vgaps.map((g) => g.map((x) => +x.toFixed(0))), h: hgaps.map((g) => g.map((x) => +x.toFixed(0))), first: bs[0].p.text, t: +Math.min(...bs.map((b) => b.t)).toFixed(0), b: +Math.max(...bs.map((b) => b.b)).toFixed(0) }));
    const sides = (g: [number, number]) => { const left = bs.filter((b) => (b.l + b.r) / 2 < g[0]), right = bs.filter((b) => (b.l + b.r) / 2 > g[1]); return rtl ? [right, left] : [left, right]; };
    // Columns of text: the widest gutter with dense text down both sides.
    const column = vgaps.map((g) => ({ g, parts: sides(g) })).filter(({ parts }) => parts.every((side) => dense(side, m))).sort((a, b) => (b.g[1] - b.g[0]) - (a.g[1] - a.g[0]))[0];
    if (column) { for (const part of column.parts) if (part.length) cut(part, depth + 1); return; }
    // A band of white across the region — the widest — cuts it in two, top first (one at a time: below a title
    // that runs across two columns, the columns are still whole to be found). Where a gutter runs down the
    // region too, the band must part text on both sides of it: a short column ending above the other's
    // last lines leaves white across the page that is no row's end.
    const widest = [...vgaps].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
    const bands = widest ? hgaps.filter((hg) => sides(widest).every((side) => side.some((b) => b.b <= hg[0]) && side.some((b) => b.t >= hg[1]))) : hgaps;
    if (bands.length) {
      const g = [...bands].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0]; const e = (g[0] + g[1]) / 2;
      const above = bs.filter((b) => (b.t + b.b) / 2 < e), below = bs.filter((b) => (b.t + b.b) / 2 >= e);
      if (above.length && below.length) { cut(above, depth + 1); cut(below, depth + 1); return; }
    }
    // Then any gutter: the widest. Labels down one side of a column of text (a number, a name beside each
    // box) are read each with the text they stand beside; otherwise the side the reading starts from first.
    const g = [...vgaps].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
    if (g) {
      const [first, second] = sides(g);
      const width = (bs2: Box[]) => Math.max(...bs2.map((b) => b.r)) - Math.min(...bs2.map((b) => b.l));
      // (Labels: the narrow side, or the side without a column of text.)
      const narrow = (bs2: Box[]) => width(bs2) <= m * 4.5;
      const which = !first.length || !second.length ? null : narrow(first) !== narrow(second) ? (narrow(first) ? first : second) : dense(first, m) !== dense(second, m) ? (dense(first, m) ? second : first) : null;
      if (which) {
        const labels = which, text = which === first ? second : first;
        const sub = (part: Box[]) => { const before = out.length; cut(part, depth + 1); return out.splice(before); };
        const textBlocks = sub(text), labelBlocks = sub(labels);
        const top = (blk: Piece[]) => Math.min(...blk.map((p) => p.y - p.h * 0.8)), bottom = (blk: Piece[]) => Math.max(...blk.map((p) => p.y + p.h * 0.22));
        const merged: Piece[][] = [...textBlocks];
        for (const lb of labelBlocks) {
          // Labels set at the size of the text, each on the baseline of one of its lines and close to it — a
          // question's number, a list's letters — are part of those lines. (A label in a box of its own, a
          // gutter away, stays a line of its own.)
          const rows: Piece[][] = [];
          for (const p of [...lb].sort((a, b) => a.y - b.y)) { const cur = rows[rows.length - 1]; if (cur && Math.abs(cur[0].y - p.y) < Math.max(cur[0].h, p.h) * 0.5) cur.push(p); else rows.push([p]); }
          const hosts = rows.map((row) => {
            const hl = Math.max(...row.map((p) => p.h)), rl = Math.min(...row.map((q) => q.l)), rr = Math.max(...row.map((q) => q.r));
            const near = (p: Piece) => Math.min(Math.abs(p.l - rr), Math.abs(rl - p.r)) <= hl * 4;
            return textBlocks.find((blk) => blk.some((p) => Math.abs(p.y - row[0].y) < Math.min(p.h, hl) * 0.5 && hl <= p.h * 1.3 && near(p)));
          });
          if (hosts.every((h) => h)) { rows.forEach((row, i) => hosts[i]!.push(...row)); continue; }
          const t = (top(lb) + bottom(lb)) / 2;
          let i = merged.findIndex((blk) => !labelBlocks.includes(blk) && bottom(blk) >= t);
          if (i < 0) i = merged.length; else if (labels === second) i++;
          merged.splice(i, 0, lb);
        }
        out.push(...merged);
      } else if (first.length && second.length && !dense(first, m) && !dense(second, m)) {
        // Labels down one side (a line each) and boxes of text down the other, neither a column of text: read
        // across, each block as it comes down the page, the first side's block before the second's when they
        // stand level. (Two sides of cards, each a few lines, are read side after side instead.)
        const sub = (part: Box[]) => { const before = out.length; cut(part, depth + 1); return out.splice(before); };
        const a = sub(first), b = sub(second);
        if (!labelsOnly(a, m) || !labelsOnly(b, m)) { out.push(...a, ...b); return; }
        const top = (blk: Piece[]) => Math.min(...blk.map((p) => p.y - p.h * 0.8)), bottom = (blk: Piece[]) => Math.max(...blk.map((p) => p.y + p.h * 0.22));
        if ((globalThis as { krDebugItems?: string }).krDebugItems) console.warn('KR merge', JSON.stringify([a.map((blk) => [blk.map((p) => p.text).join(' ').slice(0, 14), +top(blk).toFixed(0), +bottom(blk).toFixed(0)]), b.map((blk) => [blk.map((p) => p.text).join(' ').slice(0, 14), +top(blk).toFixed(0), +bottom(blk).toFixed(0)])]));
        let i = 0, j = 0;
        while (i < a.length || j < b.length) {
          if (i >= a.length) out.push(b[j++]);
          else if (j >= b.length) out.push(a[i++]);
          else { const A = a[i], B = b[j]; const level = top(A) < bottom(B) && top(B) < bottom(A); out.push(level || top(A) <= top(B) ? a[i++] : b[j++]); }
        }
      } else for (const part of [first, second]) if (part.length) cut(part, depth + 1);
      return;
    }
    out.push(bs.map((b) => b.p));
  };
  cut(boxes, 0);
  for (const b of behind) { const top = (blk: Piece[]) => Math.min(...blk.map((p) => p.y)); const i = out.findIndex((blk) => top(blk) > b.p.y); out.splice(i < 0 ? out.length : i, 0, [b.p]); }
  return out;
}

/**
 * A page's text in reading order — lines top to bottom, each line's words as they are read (right to left on
 * Arabic lines, harakat in their letters), vertical columns as their paragraphs — for search and its excerpts.
 */
export async function pageReadingText(page: PDFPageProxy): Promise<string> {
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1, rotation: 0 }); // (as written, whatever way the page is shown)
  const { blocks: laidBlocks, vert, turned, vTurned } = layText(tc.items as Item[], vp);
  const blocks: { y: number; text: string }[] = [];
  const dbgRow = (globalThis as { krDebugRows?: string }).krDebugRows;
  // The top of each block as laid, so a vertical column or turned text finds its place among them.
  const tops = laidBlocks.map((b) => Math.min(...b.map((line) => line[0].y)));
  const keyAt = (y: number) => { const i = tops.findIndex((t) => t >= y); return (i < 0 ? tops.length : i) - 0.5; };
  let order = 0;
  for (const lines of laidBlocks) {
  // Words regrouped into lines by their middles, as copying does: a verse number or a footnote mark set smaller
  // (on its own baseline) stays in its line.
  // (Where a line was cut into words at a space, a blank marker keeps the break when the words are joined
  // again: zero-wide, at the word's edge on the side the previous word lies.)
  const words = lines.flatMap((line) => wordsOf(line).flatMap((w) => {
    const word = { text: w.text, l: w.l, r: w.r, h: w.h, y: w.y, mid: w.y - w.h * 0.35 };
    if (!w.brk || /^[.,،؛:!?؟)\]»”’}]/.test(w.text)) return [word];
    const x = isRtlText(line.map((p) => p.text).join('')) ? w.r : w.l;
    return [{ ...word, text: ' ', l: x, r: x }, word];
  }));
  words.sort((a, b) => a.mid - b.mid);
  const rows: (typeof words)[] = [];
  for (const w of words) { const cur = rows[rows.length - 1]; if (cur && Math.abs(cur[0].mid - w.mid) < Math.max(cur[0].h, w.h) * 0.6) cur.push(w); else rows.push([w]); }
  // Columns the cut did not find (a gutter no row's word crosses, with text on both sides of it in most rows)
  // cut the rows into columns read one after the other (the right one first on a right-to-left page).
  const columns = findColumns(rows);
  const rtlPage = isRtlText(words.map((w) => w.text).join(''));
  const groups: (typeof rows)[] = columns ? columns.map(([a, b]) => rows.map((row) => row.filter((w) => (w.l + w.r) / 2 >= a && (w.l + w.r) / 2 < b)).filter((r) => r.length)) : [rows];
  if (columns && rtlPage) groups.reverse();
  for (const group of groups) {
    let text = '';
    // (A line joined to the next without a break must be one that ran to the column's edge — a wrapped line,
    // not a heading or a paragraph's last line.)
    const edgeR = Math.max(...group.map((row) => Math.max(...row.map((w) => w.r)))), edgeL = Math.min(...group.map((row) => Math.min(...row.map((w) => w.l))));
    let fullPrev = false;
    for (const row of group) {
      const t = joinLine(row).text; if (!t) continue;
      if (dbgRow && t.includes(dbgRow)) console.warn('KR row', JSON.stringify(row.map((w) => [w.text, +w.l.toFixed(1), +w.r.toFixed(1), +w.h.toFixed(1)])));
      text += (fullPrev ? joinBreak(text, t) : text ? '\n' : '') + t;
      const h = Math.max(...row.map((w) => w.h)), r = Math.max(...row.map((w) => w.r)), l = Math.min(...row.map((w) => w.l));
      fullPrev = isRtlText(t) ? l <= edgeL + h * 1.2 : r >= edgeR - h * 1.2;
    }
    if (text) blocks.push({ y: order++, text });
  }
  }
  let para = '', top = Infinity;
  for (const g of vert.segments) { para += plainVerticalForms(g.text); top = Math.min(top, g.t); if (g.breakAfter) { blocks.push({ y: keyAt(top), text: para }); para = ''; top = Infinity; } }
  if (para) blocks.push({ y: keyAt(top), text: para });
  turned.forEach((t, k) => { if (!vTurned.has(k)) blocks.push({ y: keyAt(t.tx[5]), text: t.text }); });
  blocks.sort((a, b) => a.y - b.y);
  return blocks.map((b) => b.text).join('\n');
}

/** What goes between a line and the next when they are read as one text: nothing after a hyphen that breaks a
 *  word (a soft hyphen goes altogether), nothing between characters of a script set without spaces (Chinese,
 *  Japanese, Korean, Thai), else a line break. */
export function joinBreak(before: string, next: string): string {
  if (!before) return '';
  const last = before[before.length - 1], first = next[0];
  if (last === '\u00ad') return '';
  if ((last === '-' || last === '\u2010') && /\p{Ll}/u.test(first)) return '';
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u0e00-\u0e7f\u3001\u3002\uff0c\uff0e]/.test(last) && /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u0e00-\u0e7f]/.test(first)) return '';
  return '\n';
}

/** Fill `container` (a .textLayer the size of the page) with the page's words. */
export async function buildTextLayer(page: PDFPageProxy, viewport: { width: number; height: number; scale: number; transform: number[] }, container: HTMLElement): Promise<PdfTextLayer> {
  let cancelled = false;
  const handle = { cancel: () => { cancelled = true; } };
  const tc = await page.getTextContent();
  if (cancelled) return handle;
  const dbg = (globalThis as { krDebugItems?: string }).krDebugItems;
  if (dbg) for (const it of tc.items as Item[]) if (typeof it.str === 'string' && (dbg.startsWith('@') ? it.transform[4] > +dbg.slice(1) : it.str.includes(dbg))) console.warn('KR item', JSON.stringify([it.str, +it.transform[4].toFixed(1), +it.transform[5].toFixed(1), +it.width.toFixed(1), it.dir, it.fontName]));
  // A page shown turned (its /Rotate): the text is laid out as the page was written, upright, and each box
  // is then turned with the page.
  const rot = (((viewport as { rotation?: number }).rotation ?? 0) % 360 + 360) % 360;
  const laid = rot ? page.getViewport({ scale: viewport.scale, rotation: 0 }) : viewport;
  const { blocks, vert, turned, vTurned } = layText(tc.items as Item[], laid);
  if (dbg) console.warn('KR blocks', JSON.stringify(blocks.map((b) => [b.length, +Math.min(...b.map((l) => l[0].y)).toFixed(0), +Math.min(...b.flat().map((p) => p.l)).toFixed(0), +Math.max(...b.flat().map((p) => p.r)).toFixed(0), b[0].map((p) => p.text).join('').slice(0, 20)])));
  const frag = document.createDocumentFragment();
  const W = viewport.width, H = viewport.height, W0 = laid.width, H0 = laid.height;
  const place = (x: number, y: number): [number, number] => (rot === 90 ? [H0 - y, x] : rot === 180 ? [W0 - x, H0 - y] : rot === 270 ? [y, W0 - x] : [x, y]);
  const rotRad = (rot * Math.PI) / 180;
  container.dataset.rot = String(rot);
  let blockNo = 0;
  const span = (text: string, left: number, top: number, size: number, scaleX: number, rtl: boolean, angle = 0) => {
    const s = document.createElement('span');
    s.textContent = text;
    s.dir = rtl ? 'rtl' : 'ltr';
    s.dataset.b = String(blockNo);
    [left, top] = place(left, top); angle += rotRad;
    s.style.left = `${(100 * left / W).toFixed(3)}%`;
    s.style.top = `${(100 * top / H).toFixed(3)}%`;
    s.style.fontSize = `${size.toFixed(2)}px`;
    s.style.fontFamily = 'sans-serif';
    s.style.transform = `${angle ? `rotate(${angle}rad) ` : ''}scaleX(${scaleX.toFixed(4)})`;
    frag.appendChild(s);
  };
  // Lines in reading order: block by block as the page was cut, and column by column where a block still has
  // columns (so a selection across the page copies as it is read), the right column first on a right-to-left page.
  const ordered: { line: Piece[]; words: Word[]; b: number }[] = [];
  blocks.forEach((lines, b) => {
    const lineWords = lines.map((line) => wordsOf(line));
    const pageCols = findColumns(lineWords);
    let part = lines.map((line, i) => ({ line, words: lineWords[i], b }));
    if (pageCols) {
      const rtlPage = isRtlText(lineWords.flat().map((w) => w.text).join(''));
      const byCol = pageCols.map(([a, b2], k) => part.map(({ line, words }) => { const inCol = (w: { l: number; r: number }) => (w.l + w.r) / 2 >= a && (w.l + w.r) / 2 < b2; return { line, words: words.filter(inCol), b: b + k / 10 }; }).filter((x) => x.words.length));
      if (rtlPage) byCol.reverse();
      part = byCol.flat();
    }
    ordered.push(...part);
  });
  for (const { line, words, b } of ordered) {
    blockNo = b;
    if (dbg && line.some((p) => p.text.includes(dbg))) console.warn('KR line', JSON.stringify(line.map((p) => [p.text, +p.l.toFixed(1), +p.r.toFixed(1), +p.y.toFixed(1), +p.h.toFixed(1), !!p.space, !!p.keep])));
    words.forEach((wd, i) => {
      const last = i === words.length - 1;
      // A word box covers exactly its letters; the space after it (for copying with the keyboard) hangs
      // outside the box, on the side the next word comes from.
      const natural = Math.max(1, measure(wd.text, wd.h));
      const k = Math.max(0.05, (wd.r - wd.l) / natural);
      const text = last ? wd.text : `${wd.text} `;
      const left = !last && wd.rtl ? wd.l - measure(' ', wd.h) * k : wd.l;
      span(text, left, wd.y - wd.h * 0.82, wd.h, k, wd.rtl);
    });
  }
  // Columns: one box each, set vertically, in reading order; a paragraph's end is marked for copying.
  for (const g of vert.segments) {
    const s = document.createElement('span');
    const text = plainVerticalForms(g.text);
    s.textContent = text; s.dataset.v = '1'; if (g.breakAfter) s.dataset.br = '1';
    s.style.writingMode = 'vertical-rl';
    const size = Math.max(1, g.r - g.l);
    const natural = Math.max(1, [...text].length * size);
    const [gl, gt] = place(g.l, g.t);
    s.style.left = `${(100 * gl / W).toFixed(3)}%`;
    s.style.top = `${(100 * gt / H).toFixed(3)}%`;
    s.style.fontSize = `${size.toFixed(2)}px`;
    s.style.lineHeight = '1';
    s.style.fontFamily = 'sans-serif';
    s.style.transform = `${rot ? `rotate(${rotRad}rad) ` : ''}scaleY(${Math.max(0.05, (g.b - g.t) / natural).toFixed(4)})`;
    s.dataset.len = String(g.b - g.t);
    frag.appendChild(s);
  }
  for (const [k, t] of turned.entries()) {
    if (vTurned.has(k)) continue;
    const natural = Math.max(1, measure(t.text, t.h));
    span(t.text, t.tx[4] + t.h * 0.82 * Math.sin(t.angle), t.tx[5] - t.h * 0.82 * Math.cos(t.angle), t.h, Math.max(0.05, t.w / natural), isRtlText(t.text), t.angle);
  }
  if (cancelled) return handle;
  container.appendChild(frag);
  // A column's length as laid out (fonts differ in how they set punctuation and digits upright): measured
  // once in place, and each column scaled to the length it has on the page.
  const cols = Array.from(container.querySelectorAll<HTMLElement>('span[data-len]'));
  if (cols.length) {
    // (offsetHeight is the layout size, before any transform, in the same units as the font size.)
    const lens = cols.map((el) => el.offsetHeight);
    cols.forEach((el, i) => { if (lens[i] > 0) el.style.transform = `scaleY(${Math.max(0.05, +el.dataset.len! / lens[i]).toFixed(4)})`; delete el.dataset.len; });
  }
  return handle;
}
