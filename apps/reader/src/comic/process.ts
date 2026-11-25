// The step between a page of the book and what the comic reader shows of it (src/views/comic.ts): one source page
// becomes one display piece or two (a wide page split in two halves), each a part of the picture (a crop rectangle, in
// fractions of the page) turned or not. As the reference reader (viewer/PageImageProcessing.kt) has it: a wide page
// (wider than tall) is turned a quarter to fill the height when «Rotate wide pages» is on (and that wins over the
// split); else, with «Split wide pages», it is shown as its two halves — one page per screen: the half read first
// first (the left one in a book read left to right, the right one in a book read right to left; «Reverse the halves»
// flips that); in the strip: stacked, the right half on top unless reversed. The borders trimmed (src/comic/crop.ts)
// narrow each piece to the page's own picture.
export type Box = [number, number, number, number];
export interface ViewerState {
  /** Pages run right to left. */
  rtl: boolean;
  /** A long strip (or continuous vertical) rather than one page per screen. */
  strip: boolean;
  /** The screen's size (CSS px). */
  width: number; height: number;
  split?: boolean; splitInvert?: boolean; rotate?: boolean; rotateInvert?: boolean;
  /** The page's picture inside its borders (fractions of the page), when they are trimmed and found. */
  trim?: Box | null;
  /** The page stands in a pair (two pages side by side): not split or turned. */
  paired?: boolean;
}
export interface Piece {
  /** The part of the page shown: x, y, width, height as fractions of the page (0–1). */
  crop: Box;
  /** Quarter turns clockwise (0 = as it is). */
  rotate: 0 | 1 | 2 | 3;
}
export const WHOLE: Piece = { crop: [0, 0, 1, 1], rotate: 0 };

/** Whether a page is wide: wider than tall. */
export const isWide = (size: { w: number; h: number }): boolean => size.w > 0 && size.h > 0 && size.w > size.h;

/** The part of the box `b` that lies in the range [a0, a1] along x (fractions of the page). */
const clipX = (b: Box, a0: number, a1: number): Box => { const x0 = Math.max(b[0], a0), x1 = Math.min(b[0] + b[2], a1); return [x0, b[1], Math.max(0, x1 - x0), b[3]]; };

/** The display pieces of one page, given its pixel size and the viewer's state. */
export function prepare(size: { w: number; h: number }, s: ViewerState): Piece[] {
  const whole: Box = s.trim ?? [0, 0, 1, 1];
  if (!s.paired && isWide(size)) {
    if (s.rotate) return [{ crop: whole, rotate: s.rotateInvert ? 3 : 1 }];
    if (s.split) {
      const left = clipX(whole, 0, 0.5), right = clipX(whole, 0.5, 1);
      // (The strip: the right half on top, the reversal puts the left; one page per screen: the half read first.)
      const rightFirst = s.strip ? !s.splitInvert : s.rtl !== !!s.splitInvert;
      return (rightFirst ? [right, left] : [left, right]).map((crop) => ({ crop, rotate: 0 as const }));
    }
  }
  return [{ crop: whole, rotate: 0 }];
}

/** A piece's own size in pixels (its crop of the page, turned). */
export function pieceSize(p: Piece, size: { w: number; h: number }): { w: number; h: number } {
  const w = size.w * p.crop[2], h = size.h * p.crop[3];
  return p.rotate % 2 ? { w: h, h: w } : { w, h };
}

/** Which pages stand in pairs (two pages side by side): the page numbers of each group, in reading order. The cover (the
 *  first page) stands alone unless `shift`; a wide page stands alone and the pairing starts again after it. */
export function pairUp(wide: boolean[], shift: boolean): number[][] {
  const out: number[][] = []; const n = wide.length; let i = 0;
  while (i < n) {
    if ((i === 0 && !shift) || wide[i] || i + 1 >= n || wide[i + 1]) { out.push([i]); i += 1; }
    else { out.push([i, i + 1]); i += 2; }
  }
  return out;
}
