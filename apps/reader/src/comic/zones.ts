// The comic reader's tap zones (src/views/comic.ts), laid out as the reference reader lays them: rectangles in
// fractions of the screen (x0, y0, x1, y1); what no rectangle claims shows or hides the bars. NEXT / PREV are the
// next and previous page; LEFT / RIGHT are the page that way on the screen (next or previous by the reading
// direction). The default layout is L-shaped for the vertical modes and right-and-left for the sideways ones.
// Inverted: horizontally the zones are mirrored left to right (x → 1 − x), vertically top to bottom, or both.
export type ZoneAction = 'next' | 'prev' | 'left' | 'right';
export type ZoneLayout = 0 | 1 | 2 | 3 | 4 | 5; // default, L-shaped, Kindle-like, edge, right and left, disabled
export type ZoneInvert = 'none' | 'h' | 'v' | 'both';
export interface Zone { a: ZoneAction; r: [number, number, number, number] }

const L_SHAPED: Zone[] = [
  { a: 'prev', r: [0, 0.33, 0.33, 0.66] }, { a: 'prev', r: [0, 0, 1, 0.33] },
  { a: 'next', r: [0.66, 0.33, 1, 0.66] }, { a: 'next', r: [0, 0.66, 1, 1] },
];
const KINDLISH: Zone[] = [{ a: 'next', r: [0.33, 0.33, 1, 1] }, { a: 'prev', r: [0, 0.33, 0.33, 1] }];
const EDGE: Zone[] = [{ a: 'next', r: [0, 0, 0.33, 1] }, { a: 'prev', r: [0.33, 0.66, 0.66, 1] }, { a: 'next', r: [0.66, 0, 1, 1] }];
const RIGHT_AND_LEFT: Zone[] = [{ a: 'left', r: [0, 0, 0.33, 1] }, { a: 'right', r: [0.66, 0, 1, 1] }];

/** The zones of a layout, for a reader whose pages run sideways (`horizontal`) or downwards, inverted as asked. */
export function zonesOf(layout: ZoneLayout, horizontal: boolean, invert: ZoneInvert = 'none'): Zone[] {
  const base = layout === 0 ? (horizontal ? RIGHT_AND_LEFT : L_SHAPED) : layout === 1 ? L_SHAPED : layout === 2 ? KINDLISH : layout === 3 ? EDGE : layout === 4 ? RIGHT_AND_LEFT : [];
  const h = invert === 'h' || invert === 'both', v = invert === 'v' || invert === 'both';
  return base.map(({ a, r: [x0, y0, x1, y1] }) => ({
    // (Mirrored sideways, a «left» zone lies on the right: it keeps what it does — turning that way — only where
    // the zones stand for prev / next. As the reference does: the action stays, the rectangle moves.)
    a,
    r: [h ? 1 - x1 : x0, v ? 1 - y1 : y0, h ? 1 - x0 : x1, v ? 1 - y0 : y1] as [number, number, number, number],
  }));
}

/** What a tap at (x, y) — fractions of the screen — does: a zone's action, or null (the bars). */
export function hitZone(zones: Zone[], x: number, y: number): ZoneAction | null {
  for (const z of zones) { const [x0, y0, x1, y1] = z.r; if (x >= x0 && x < x1 && y >= y0 && y < y1) return z.a; }
  return null;
}

/** A zone's action as a step through the book: +1 the next page, −1 the previous one. `rtl`: pages run right to left. */
export function stepOf(a: ZoneAction, rtl: boolean): 1 | -1 {
  if (a === 'next') return 1; if (a === 'prev') return -1;
  return (a === 'right') !== rtl ? 1 : -1;
}
