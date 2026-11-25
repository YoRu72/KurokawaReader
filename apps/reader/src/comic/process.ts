// The step between a page of the book and what the comic reader shows of it (src/views/comic.ts): one source page
// may become one display piece or more (a wide page split in two halves), each a part of the picture (a crop
// rectangle, in fractions of the page) turned or not. Today every page is shown whole: one piece, the whole picture,
// unturned. (Splitting and turning wide pages and cropping borders come here: the viewer already lays out any number
// of pieces per page and draws each piece's rectangle.)
export interface ViewerState {
  /** Pages run right to left. */
  rtl: boolean;
  /** A long strip (or continuous vertical) rather than one page per screen. */
  strip: boolean;
  /** The screen's size (CSS px). */
  width: number; height: number;
}
export interface Piece {
  /** The part of the page shown: x, y, width, height as fractions of the page (0–1). */
  crop: [number, number, number, number];
  /** Quarter turns clockwise (0 = as it is). */
  rotate: 0 | 1 | 2 | 3;
}
export const WHOLE: Piece = { crop: [0, 0, 1, 1], rotate: 0 };

/** The display pieces of one page, given its pixel size and the viewer's state. */
export function prepare(_size: { w: number; h: number }, _state: ViewerState): Piece[] {
  return [WHOLE];
}

/** A piece's own size in pixels (its crop of the page, turned). */
export function pieceSize(p: Piece, size: { w: number; h: number }): { w: number; h: number } {
  const w = size.w * p.crop[2], h = size.h * p.crop[3];
  return p.rotate % 2 ? { w: h, h: w } : { w, h };
}
