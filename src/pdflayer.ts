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
import { ltrRunsForward, joinLine, attachMarks, balanceBrackets, cleanPdfText, COMBINING, dropBuriedSpaces, fixLoneBrackets, isRtlText, logicalNeutral, logicalRtlPiece } from './pdftext';

type Item = { str: string; transform: number[]; width: number; height: number; dir?: string; fontName?: string; krLead?: boolean };
type Piece = { text: string; l: number; r: number; y: number; h: number; space?: boolean; keep?: boolean; hint?: boolean };
type Word = { text: string; l: number; r: number; y: number; h: number; rtl: boolean; brk?: boolean };

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
  let cur: Word | null = null; let edge = 0; let breakNext = false; let hintNext = false;
  const dirOf = (t: string) => (RTL_CHAR.test(t) ? 'r' : LTR_CHAR.test(t) ? 'l' : '');
  let curDir = '';
  for (const p of sorted) {
    if (p.space) { breakNext = true; continue; }
    // (A space pdf.js found in a gap: a word break when the gap is really there — Word sets its Arabic
    // words apart by little more than a tenth of the type size.)
    if (p.hint) { hintNext = true; continue; }
    const text = rtl ? balanceBrackets(logicalNeutral(logicalRtlPiece(p.text, p.keep), true)) : p.text;
    const d = dirOf(text);
    const gap: number = cur ? (rtl ? edge - p.r : p.l - edge) : 0;
    // (Never before closing punctuation, or after an opening bracket: those spaces are pdf.js's guess at a
    // change of type size, as for a raised note number.)
    const hinted: boolean = !marked && hintNext && gap > p.h * 0.1 && !/^[.,،؛:!?؟)\]»”’}]/.test(text) && !(cur && /[(\[«“‘{]$/.test(cur.text));
    const brk: boolean = breakNext || hinted || (gap > p.h * (marked ? 0.3 : 0.18) && !COMBINING.test(text[0]));
    const split = !cur || brk || (d && curDir && d !== curDir);
    if (split) {
      cur = { text, l: p.l, r: p.r, y: p.y, h: p.h, rtl: d ? d === 'r' : rtl, brk: !!cur && !!brk };
      words.push(cur); curDir = d;
    } else {
      cur!.text += text; cur!.l = Math.min(cur!.l, p.l); cur!.r = Math.max(cur!.r, p.r); cur!.h = Math.max(cur!.h, p.h);
      if (d && !curDir) { curDir = d; cur!.rtl = d === 'r'; }
    }
    edge = rtl ? (split ? p.l : Math.min(edge, p.l)) : (split ? p.r : Math.max(edge, p.r));
    breakNext = false; hintNext = false;
  }
  const clean = words.map((w) => ({ ...w, text: w.text.replace(/\s+/g, ' ').trim() })).filter((w) => w.text);
  // (On a right-to-left line, Latin words and the numbers among them keep their own left-to-right order.)
  return rtl ? ltrRunsForward(clean, (w) => w.text).seq : clean;
}

export interface PdfTextLayer { cancel(): void }

type Turned = { text: string; tx: number[]; w: number; h: number; angle: number };
type Laid = { lines: Piece[][]; vert: ReturnType<typeof findVertical>; turned: Turned[]; vTurned: Set<number> };

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
  // Vertical writing (Japanese, Chinese, Korean set in columns; Mongolian): its columns are found first and
  // laid as columns; the rest is read in lines. A word turned on its side within a column joins it.
  const vp: VPiece[] = pieces.map((p) => ({ text: p.hint ? '' : p.text, l: p.l, r: p.r, y: p.y, h: p.h }));
  const turnedV: number[] = [];
  turned.forEach((t, k) => { if (Math.abs(t.angle - Math.PI / 2) < 0.05) { vp.push({ text: t.text, l: t.tx[4] - t.h * 0.12, r: t.tx[4] + t.h * 0.88, y: t.tx[5] + t.w, h: t.h, t: t.tx[5], b: t.tx[5] + t.w }); turnedV.push(k); } });
  const vert = findVertical(vp);
  const vTurned = new Set(turnedV.filter((_, j) => vert.vertical.has(pieces.length + j)));
  const flat = vert.vertical.size ? pieces.filter((_, i) => !vert.vertical.has(i)) : pieces;
  // Harakat drawn on their own go back into their letters; then lines by baseline, top to bottom.
  const kept = attachMarks(flat.filter((p) => !p.space && !p.hint)).concat(flat.filter((p) => p.space || p.hint));
  kept.sort((a, b) => a.y - b.y);
  const lines: Piece[][] = [];
  for (const p of kept) {
    // (A space item may carry no real height: the line's letters decide.)
    const ln = lines.find((l) => { const lh = l.find((q) => !q.space && !q.hint)?.h ?? l[0].h; return Math.abs(l[0].y - p.y) < (p.space || p.hint ? lh : Math.min(lh, p.h)) * 0.5; });
    if (ln) ln.push(p); else lines.push([p]);
  }
  lines.sort((a, b) => a[0].y - b[0].y);
  return { lines, vert, turned, vTurned };
}

/**
 * A page's text in reading order — lines top to bottom, each line's words as they are read (right to left on
 * Arabic lines, harakat in their letters), vertical columns as their paragraphs — for search and its excerpts.
 */
export async function pageReadingText(page: PDFPageProxy): Promise<string> {
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  const { lines, vert, turned, vTurned } = layText(tc.items as Item[], vp);
  const blocks: { y: number; text: string }[] = [];
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
  const dbgRow = (globalThis as { krDebugRows?: string }).krDebugRows;
  for (const row of rows) {
    const t = joinLine(row).text; if (t) blocks.push({ y: row[0].y, text: t });
    if (dbgRow && t.includes(dbgRow)) console.warn('KR row', JSON.stringify(row.map((w) => [w.text, +w.l.toFixed(1), +w.r.toFixed(1), +w.h.toFixed(1)])));
  }
  let para = '', top = Infinity;
  for (const g of vert.segments) { para += plainVerticalForms(g.text); top = Math.min(top, g.t); if (g.breakAfter) { blocks.push({ y: top, text: para }); para = ''; top = Infinity; } }
  if (para) blocks.push({ y: top, text: para });
  turned.forEach((t, k) => { if (!vTurned.has(k)) blocks.push({ y: t.tx[5], text: t.text }); });
  blocks.sort((a, b) => a.y - b.y);
  return blocks.map((b) => b.text).join('\n');
}

/** Fill `container` (a .textLayer the size of the page) with the page's words. */
export async function buildTextLayer(page: PDFPageProxy, viewport: { width: number; height: number; scale: number; transform: number[] }, container: HTMLElement): Promise<PdfTextLayer> {
  let cancelled = false;
  const handle = { cancel: () => { cancelled = true; } };
  const tc = await page.getTextContent();
  if (cancelled) return handle;
  const dbg = (globalThis as { krDebugItems?: string }).krDebugItems;
  if (dbg) for (const it of tc.items as Item[]) if (typeof it.str === 'string' && (dbg.startsWith('@') ? it.transform[4] > +dbg.slice(1) : it.str.includes(dbg))) console.warn('KR item', JSON.stringify([it.str, +it.transform[4].toFixed(1), +it.transform[5].toFixed(1), +it.width.toFixed(1), it.dir, it.fontName]));
  const { lines, vert, turned, vTurned } = layText(tc.items as Item[], viewport);
  const frag = document.createDocumentFragment();
  const W = viewport.width, H = viewport.height;
  const span = (text: string, left: number, top: number, size: number, scaleX: number, rtl: boolean, angle = 0) => {
    const s = document.createElement('span');
    s.textContent = text;
    s.dir = rtl ? 'rtl' : 'ltr';
    s.style.left = `${(100 * left / W).toFixed(3)}%`;
    s.style.top = `${(100 * top / H).toFixed(3)}%`;
    s.style.fontSize = `${size.toFixed(2)}px`;
    s.style.fontFamily = 'sans-serif';
    s.style.transform = `${angle ? `rotate(${angle}rad) ` : ''}scaleX(${scaleX.toFixed(4)})`;
    frag.appendChild(s);
  };
  for (const line of lines) {
    if (dbg && line.some((p) => p.text.includes(dbg))) console.warn('KR line', JSON.stringify(line.map((p) => [p.text, +p.l.toFixed(1), +p.r.toFixed(1), +p.y.toFixed(1), +p.h.toFixed(1), !!p.space, !!p.keep])));
    const words = wordsOf(line);
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
    s.style.left = `${(100 * g.l / W).toFixed(3)}%`;
    s.style.top = `${(100 * g.t / H).toFixed(3)}%`;
    s.style.fontSize = `${size.toFixed(2)}px`;
    s.style.lineHeight = '1';
    s.style.fontFamily = 'sans-serif';
    s.style.transform = `scaleY(${Math.max(0.05, (g.b - g.t) / natural).toFixed(4)})`;
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
