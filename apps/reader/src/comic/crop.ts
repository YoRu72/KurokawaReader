// Border trimming for the comic reader, as the reference reader does it: uniform white or black borders (a colour
// within 0.15 of white or of black) are measured once per page, on a small copy of the picture, and the rectangle kept
// in memory. The copy is at most 256 px on its long side (a very long page keeps 48 px on its short one); from each
// edge the rows (columns) are scanned inward until one holds more than a small share of pixels that are not the border
// colour. No side loses more than 45 % of the page — and no axis more than 45 % in all —, so a page of near-nothing
// keeps its middle. The border colour sampled (white, black or neither) also tells «Automatic» background what to be.
import type { Box } from './process';

export type Edge = 'white' | 'black' | 'none';
export interface Border { box: Box; edge: Edge }
const THRESHOLD = 0.15, SHARE = 0.01, CAP = 0.45;

/** The rectangle of the picture inside its borders, and the border colour, from the pixels of a small copy. */
export function scanBorders(img: { width: number; height: number; data: ArrayLike<number> }): Border {
  const { width: W, height: H, data } = img;
  const whole: Box = [0, 0, 1, 1];
  if (W < 4 || H < 4) return { box: whole, edge: 'none' };
  const hi = 255 * (1 - THRESHOLD), lo = 255 * THRESHOLD;
  const at = (x: number, y: number) => (y * W + x) * 4;
  const white = (i: number) => data[i] >= hi && data[i + 1] >= hi && data[i + 2] >= hi;
  const dark = (i: number) => data[i] <= lo && data[i + 1] <= lo && data[i + 2] <= lo;
  // The border colour: eight samples round the edge (the corners and the middles of the sides).
  const pts: [number, number][] = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W >> 1, 0], [W >> 1, H - 1], [0, H >> 1], [W - 1, H >> 1]];
  const norm: Edge = pts.every(([x, y]) => white(at(x, y))) ? 'white' : pts.every(([x, y]) => dark(at(x, y))) ? 'black' : 'none';
  if (norm === 'none') return { box: whole, edge: 'none' };
  const border = norm === 'white' ? white : dark;
  const rowInk = (y: number) => { let n = 0; for (let x = 0; x < W; x++) if (!border(at(x, y))) n++; return n > W * SHARE; };
  const colInk = (x: number) => { let n = 0; for (let y = 0; y < H; y++) if (!border(at(x, y))) n++; return n > H * SHARE; };
  const capY = Math.floor(H * CAP), capX = Math.floor(W * CAP);
  let t = 0; while (t < capY && !rowInk(t)) t++;
  let b = 0; while (b < capY - t && !rowInk(H - 1 - b)) b++;
  let l = 0; while (l < capX && !colInk(l)) l++;
  let r = 0; while (r < capX - l && !colInk(W - 1 - r)) r++;
  const f = (v: number) => Math.round(v * 10000) / 10000;
  // (A page with no ink at all is left whole: a blank page has nothing to trim to.)
  if (t >= capY && b === 0 && l >= capX && r === 0) return { box: whole, edge: norm };
  return { box: [f(l / W), f(t / H), f(1 - (l + r) / W), f(1 - (t + b) / H)], edge: norm };
}

/** The size of the small copy for a picture: ≤ 256 px on the long side, a very long picture keeping 48 px across. */
export function smallSize(w: number, h: number): { w: number; h: number } {
  let s = Math.min(1, 256 / Math.max(w, h));
  if (Math.min(w, h) * s < 48) s = Math.min(1, 48 / Math.min(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Measure a decoded picture: drawn small on a canvas, scanned. */
export function measure(img: CanvasImageSource, w: number, h: number): Border | null {
  try {
    const sz = smallSize(w, h);
    const c = document.createElement('canvas'); c.width = sz.w; c.height = sz.h;
    const g = c.getContext('2d', { willReadFrequently: true }); if (!g) return null;
    g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, sz.w, sz.h);
    const out = scanBorders(g.getImageData(0, 0, sz.w, sz.h));
    c.width = c.height = 0;
    return out;
  } catch { return null; }
}

/** A GIF with more than one frame (animated): counted by its graphic control blocks. */
export async function isAnimatedGif(blob: Blob): Promise<boolean> {
  try {
    const u = new Uint8Array(await blob.arrayBuffer()); if (u[0] !== 0x47 || u[1] !== 0x49 || u[2] !== 0x46) return false;
    let n = 0; for (let i = 0; i + 3 < u.length; i++) if (u[i] === 0x21 && u[i + 1] === 0xf9 && u[i + 2] === 0x04) { if (++n > 1) return true; }
    return false;
  } catch { return false; }
}
