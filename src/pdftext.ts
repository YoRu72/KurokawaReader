// Turning the pieces of text a PDF exposes into readable lines — shared by copying from the
// PDF viewer and by PDF → DOCX/EPUB conversion.
//
// A piece is a run of text with its horizontal extent; pieces on one line are put in reading
// order by where they start (their origin), not where the browser's fallback font says they end.
// Word breaks come from the PDF's own drawn spaces when it marks them (U+2009, see
// scripts/patch-pdfjs.mjs), otherwise from the gaps between pieces.

export type LinePiece = { text: string; l: number; r: number; h: number };

const RTL_CHAR_G = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
// Arabic harakat, shadda, sukun, superscript alef, Quranic marks; Hebrew points.
export const COMBINING = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0591-\u05C7]/;

/** Control characters (glyphs with no Unicode) are not text. */
export function cleanPdfText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g, '').replace(/\u00A0/g, ' ');
}

export function isRtlText(s: string): boolean {
  return (s.match(RTL_CHAR_G) ?? []).length > (s.match(/[A-Za-z\u00C0-\u024F]/g) ?? []).length;
}

/** A right-to-left piece stored in drawing order (a mark before its letter, "ُه") is turned round to "هُ". */
function logicalRtlPiece(s: string): string {
  const core = s.trim();
  if (!core || !COMBINING.test(core[0]) || !/[\u0600-\u06FF]/.test(core)) return s;
  const lead = s.match(/^\s*/)![0], trail = s.match(/\s*$/)![0];
  return trail + [...core].reverse().join('') + lead;
}

/** One line of pieces (any order) → its text in reading order. */
export function joinLine<T extends LinePiece>(line: T[]): { text: string; rtl: boolean } {
  const rtl = isRtlText(line.map((p) => p.text).join(''));
  const sorted = [...line].sort((a, b) => (rtl ? b.l - a.l || b.r - a.r : a.l - b.l || a.r - b.r));
  const marked = sorted.some((p) => p.text === '\u2009');
  let s = '';
  let prev: LinePiece | null = null;
  for (const p of sorted) {
    if (p.text === '\u2009') { if (s && !/\s$/.test(s)) s += ' '; continue; }
    if (!p.text.trim()) continue;
    const text = rtl ? logicalRtlPiece(p.text) : p.text;
    if (prev && !marked) {
      const gap = rtl ? prev.l - p.r : p.l - prev.r;
      if (gap > Math.min(prev.h, p.h) * 0.18 && !/\s$/.test(s) && !/^\s/.test(text) && !COMBINING.test(text[0])) s += ' ';
    }
    s += text;
    // A piece inside the previous one (a mark over its letter) must not move the edge back.
    prev = prev && (rtl ? p.l > prev.l : p.r < prev.r) ? { ...p, l: Math.min(prev.l, p.l), r: Math.max(prev.r, p.r) } : p;
  }
  return { text: s.replace(/\s+/g, ' ').trim(), rtl };
}
