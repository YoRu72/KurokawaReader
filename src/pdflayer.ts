// The PDF viewer's text layer — the invisible text laid over the page picture that selection, copy and
// search work on. pdf.js lays out one box per piece of text in drawing order; a PDF that draws Arabic
// letter by letter (with its harakat drawn apart, often afterwards) then gives a layer where a mark is a box
// of its own, words are scattered boxes in the order they were painted, and dragging across a line runs
// left to right. This builds the layer from the same text, but as a reader sees it:
//  - harakat put back inside the letter they sit on,
//  - each line cut into words, every word one box exactly over its letters on the page,
//  - the boxes in reading order (right to left on Arabic lines), so a selection follows the text.
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { attachMarks, balanceBrackets, cleanPdfText, COMBINING, dropBuriedSpaces, fixLoneBrackets, isRtlText, logicalNeutral, logicalRtlPiece } from './pdftext';

type Item = { str: string; transform: number[]; width: number; height: number; dir?: string; fontName?: string; krLead?: boolean };
type Piece = { text: string; l: number; r: number; y: number; h: number; space?: boolean; keep?: boolean };
type Word = { text: string; l: number; r: number; y: number; h: number; rtl: boolean };

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
  const sorted = dropBuriedSpaces(line, (p) => !!p.space).sort((a, b) => (rtl ? b.r - a.r || b.l - a.l : a.l - b.l || a.r - b.r));
  const fixed = fixLoneBrackets(sorted, rtl);
  sorted.forEach((p, i) => { if (fixed[i] !== p.text) sorted[i] = { ...p, text: fixed[i] }; });
  const marked = sorted.some((p) => p.space);
  const words: Word[] = [];
  let cur: Word | null = null; let edge = 0; let breakNext = false;
  const dirOf = (t: string) => (RTL_CHAR.test(t) ? 'r' : LTR_CHAR.test(t) ? 'l' : '');
  let curDir = '';
  for (const p of sorted) {
    if (p.space) { breakNext = true; continue; }
    const text = rtl ? balanceBrackets(logicalNeutral(logicalRtlPiece(p.text, p.keep), true)) : p.text;
    const d = dirOf(text);
    const gap = cur ? (rtl ? edge - p.r : p.l - edge) : 0;
    const split = !cur || breakNext || (gap > p.h * (marked ? 0.3 : 0.18) && !COMBINING.test(text[0])) || (d && curDir && d !== curDir);
    if (split) {
      cur = { text, l: p.l, r: p.r, y: p.y, h: p.h, rtl: d ? d === 'r' : rtl };
      words.push(cur); curDir = d;
    } else {
      cur!.text += text; cur!.l = Math.min(cur!.l, p.l); cur!.r = Math.max(cur!.r, p.r); cur!.h = Math.max(cur!.h, p.h);
      if (d && !curDir) { curDir = d; cur!.rtl = d === 'r'; }
    }
    edge = rtl ? (split ? p.l : Math.min(edge, p.l)) : (split ? p.r : Math.max(edge, p.r));
    breakNext = false;
  }
  return words.map((w) => ({ ...w, text: w.text.replace(/\s+/g, ' ').trim() })).filter((w) => w.text);
}

export interface PdfTextLayer { cancel(): void }

/** Fill `container` (a .textLayer the size of the page) with the page's words. */
export async function buildTextLayer(page: PDFPageProxy, viewport: { width: number; height: number; scale: number; transform: number[] }, container: HTMLElement): Promise<PdfTextLayer> {
  let cancelled = false;
  const handle = { cancel: () => { cancelled = true; } };
  const tc = await page.getTextContent();
  if (cancelled) return handle;
  const dbg = (globalThis as { krDebugItems?: string }).krDebugItems;
  if (dbg) for (const it of tc.items as Item[]) if (typeof it.str === 'string' && (dbg.startsWith('@') ? it.transform[4] > +dbg.slice(1) : it.str.includes(dbg))) console.warn('KR item', JSON.stringify([it.str, +it.transform[4].toFixed(1), +it.transform[5].toFixed(1), +it.width.toFixed(1), it.dir, it.fontName]));
  const pieces: Piece[] = [];
  const turned: { text: string; tx: number[]; w: number; h: number; angle: number }[] = [];
  for (const raw of tc.items as Item[]) {
    if (typeof raw.str !== 'string') continue;
    let text = cleanPdfText(raw.str);
    const tx = mul(viewport.transform, raw.transform);
    const h = Math.hypot(tx[2], tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    const w = raw.width * viewport.scale;
    // (U+2009 marks a space the page draws, see scripts/patch-pdfjs.mjs; pdf.js's own " " items only fill gaps.)
    if (/^\u2009+$/.test(text)) { pieces.push({ text: ' ', l: tx[4], r: tx[4] + w, y: tx[5], h, space: true }); continue; }
    if (!text.trim() || !h) continue;
    if (Math.abs(angle) > 0.02) { turned.push({ text, tx, w, h, angle }); continue; }
    pieces.push({ text, l: tx[4], r: tx[4] + Math.max(w, 0.01), y: tx[5], h, keep: !!raw.krLead });
  }
  // Harakat drawn on their own go back into their letters; then lines by baseline, top to bottom.
  const kept = attachMarks(pieces.filter((p) => !p.space)).concat(pieces.filter((p) => p.space));
  kept.sort((a, b) => a.y - b.y);
  const lines: Piece[][] = [];
  for (const p of kept) {
    // (A space item may carry no real height: the line's letters decide.)
    const ln = lines.find((l) => { const lh = l.find((q) => !q.space)?.h ?? l[0].h; return Math.abs(l[0].y - p.y) < (p.space ? lh : Math.min(lh, p.h)) * 0.5; });
    if (ln) ln.push(p); else lines.push([p]);
  }
  lines.sort((a, b) => a[0].y - b[0].y);
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
  for (const t of turned) {
    const natural = Math.max(1, measure(t.text, t.h));
    span(t.text, t.tx[4] + t.h * 0.82 * Math.sin(t.angle), t.tx[5] - t.h * 0.82 * Math.cos(t.angle), t.h, Math.max(0.05, t.w / natural), isRtlText(t.text), t.angle);
  }
  if (cancelled) return handle;
  container.appendChild(frag);
  return handle;
}
