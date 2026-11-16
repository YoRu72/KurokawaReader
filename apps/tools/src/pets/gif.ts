// A small GIF reader for pet frames, bounded before anything is allocated: the logical screen (each side and its
// pixels), the number of frames, and each frame's own rectangle (refused when larger than the screen allows; drawn
// clipped to the screen) are checked while the blocks are walked — no pixel decoded yet. Frames are then decoded on
// request, in order, onto ONE screen-sized buffer (plus one more only while a «restore to previous» frame needs it):
// no copy per frame is ever kept here; the caller cuts what it needs from the buffer before asking for the next.

export interface GifInfo { w: number; h: number; frames: number }
export class GifError extends Error {}
export const GIF_MAX_FRAMES = 300;
export const GIF_MAX_SIDE = 1024;

interface Img { x: number; y: number; w: number; h: number; lct: Uint8Array | null; interlace: boolean; minCode: number; data: Uint8Array; disposal: number; delay: number; transp: number }
interface Walked { w: number; h: number; gct: Uint8Array | null; imgs: Img[] }
function walk(b: Uint8Array, maxSide: number, maxFrames: number): Walked {
  if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) throw new GifError('notGif');
  const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8);
  if (!w || !h || w > maxSide || h > maxSide) throw new GifError('tooBig');
  let p = 13; const flags = b[10]; let gct: Uint8Array | null = null;
  const need = (n: number) => { if (p + n > b.length) throw new GifError('truncated'); };
  if (flags & 0x80) { const n = 3 * (1 << ((flags & 7) + 1)); need(n); gct = b.subarray(p, p + n); p += n; }
  const imgs: Img[] = []; let disposal = 0, delay = 10, transp = -1;
  // (A frame's data stays a view into the file while it is one block; joined only when it spans several.)
  const blocks = (): Uint8Array => { const parts: Uint8Array[] = []; let len = 0; for (;;) { need(1); const n = b[p++]; if (!n) break; need(n); parts.push(b.subarray(p, p + n)); len += n; p += n; } if (parts.length === 1) return parts[0]; const out = new Uint8Array(len); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return out; };
  for (;;) {
    need(1); const c = b[p++];
    if (c === 0x3b) break;
    if (c === 0x21) { need(1); const lab = b[p++]; if (lab === 0xf9) { const d = blocks(); if (d.length >= 4) { disposal = (d[0] >> 2) & 7; delay = d[1] | (d[2] << 8); transp = d[0] & 1 ? d[3] : -1; } } else blocks(); continue; }
    if (c !== 0x2c) throw new GifError('badBlock');
    need(9); const x = b[p] | (b[p + 1] << 8), y = b[p + 2] | (b[p + 3] << 8), iw = b[p + 4] | (b[p + 5] << 8), ih = b[p + 6] | (b[p + 7] << 8), f = b[p + 8]; p += 9;
    // (A frame's own rectangle may not be larger than the screen: its pixels are decoded before they are clipped.)
    if (!iw || !ih || iw > w || ih > h) throw new GifError('badFrame');
    let lct: Uint8Array | null = null; if (f & 0x80) { const n = 3 * (1 << ((f & 7) + 1)); need(n); lct = b.subarray(p, p + n); p += n; }
    need(1); const minCode = b[p++]; if (minCode < 2 || minCode > 11) throw new GifError('badCode');
    if (imgs.length >= maxFrames) throw new GifError('tooManyFrames');
    imgs.push({ x, y, w: iw, h: ih, lct, interlace: !!(f & 0x40), minCode, data: blocks(), disposal, delay, transp });
    disposal = 0; delay = 10; transp = -1;
  }
  return { w, h, gct, imgs };
}
/** Size and frame count (no pixels decoded). */
export function gifInfo(b: Uint8Array, maxSide = GIF_MAX_SIDE, maxFrames = GIF_MAX_FRAMES): GifInfo { const g = walk(b, maxSide, maxFrames); return { w: g.w, h: g.h, frames: g.imgs.length }; }

function lzw(data: Uint8Array, minCode: number, out: Uint8Array): void {
  const count = out.length; let op = 0; out.fill(0);
  const clear = 1 << minCode, eoi = clear + 1;
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), firstOf = new Uint8Array(4096); const stack = new Uint8Array(4097);
  let size = minCode + 1, next = eoi + 1, old = -1; let bits = 0, acc = 0, ip = 0;
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; firstOf[i] = i; }
  while (op < count) {
    while (bits < size) { if (ip >= data.length) return; acc |= data[ip++] << bits; bits += 8; }
    const code = acc & ((1 << size) - 1); acc >>>= size; bits -= size;
    if (code === clear) { size = minCode + 1; next = eoi + 1; old = -1; continue; }
    if (code === eoi) return;
    if (old < 0) { if (code >= clear) throw new GifError('badData'); out[op++] = code; old = code; continue; }
    let c = code, sp = 0;
    if (code >= next) { if (code > next) throw new GifError('badData'); stack[sp++] = firstOf[old]; c = old; }
    while (c >= clear) { if (sp >= 4096) throw new GifError('badData'); stack[sp++] = suffix[c]; c = prefix[c]; }
    stack[sp++] = c; const first = c;
    while (sp && op < count) out[op++] = stack[--sp];
    if (next < 4096) { prefix[next] = old; suffix[next] = first; firstOf[next] = firstOf[old]; next++; if (next === 1 << size && size < 12) size++; }
    old = code;
  }
}

/** Frames decoded on request onto one buffer. `frame(i)` returns that buffer (w×h RGBA) holding frame i, valid until
 *  the next call; asking for an earlier frame starts again from the first. One more buffer exists only while the frame
 *  last returned is to be «restored to previous» (the screen as it was before it). */
export class GifDecoder {
  readonly w: number; readonly h: number; readonly count: number;
  private g: Walked; private canvas: Uint8ClampedArray; private nextIdx = 0; private idx: Uint8Array = new Uint8Array(0);
  private pendingIm: Img | null = null; private pendingBefore: Uint8ClampedArray | null = null;
  constructor(b: Uint8Array, maxSide = GIF_MAX_SIDE, maxFrames = GIF_MAX_FRAMES) {
    this.g = walk(b, maxSide, maxFrames); this.w = this.g.w; this.h = this.g.h; this.count = this.g.imgs.length;
    this.canvas = new Uint8ClampedArray(this.w * this.h * 4);
  }
  delay(i: number): number { return Math.max(0.02, (this.g.imgs[i]?.delay || 10) / 100); }
  frame(i: number): Uint8ClampedArray {
    if (!(i >= 0 && i < this.count)) throw new GifError('noFrame');
    if (i === this.nextIdx - 1) return this.canvas;
    if (i < this.nextIdx) { this.canvas.fill(0); this.nextIdx = 0; this.pendingIm = null; this.pendingBefore = null; }
    while (this.nextIdx <= i) { this.dispose(); this.compose(this.g.imgs[this.nextIdx++]); }
    return this.canvas;
  }
  private dispose(): void {
    const im = this.pendingIm; if (!im) return; const g = this.g;
    if (im.disposal === 2) for (let yy = im.y; yy < Math.min(g.h, im.y + im.h); yy++) this.canvas.fill(0, (yy * g.w + Math.min(g.w, im.x)) * 4, (yy * g.w + Math.min(g.w, im.x + im.w)) * 4);
    else if (im.disposal === 3 && this.pendingBefore) this.canvas.set(this.pendingBefore);
    this.pendingIm = null; this.pendingBefore = null;
  }
  private compose(im: Img): void {
    const g = this.g; const pal = im.lct ?? g.gct; if (!pal) throw new GifError('noPalette');
    this.pendingBefore = im.disposal === 3 ? this.canvas.slice() : null; this.pendingIm = im;
    if (this.idx.length < im.w * im.h) this.idx = new Uint8Array(im.w * im.h);
    const idx = this.idx.subarray(0, im.w * im.h); lzw(im.data, im.minCode, idx);
    const canvas = this.canvas; const W = g.w, H = g.h;
    let row = 0; const passes = im.interlace ? [[0, 8], [4, 8], [2, 4], [1, 2]] : [[0, 1]];
    for (const [s, st] of passes) for (let r = s; r < im.h; r += st, row++) {
      const yy = im.y + r; if (yy >= H) continue;
      for (let xx = 0; xx < im.w; xx++) {
        const X = im.x + xx; if (X >= W) break; const c = idx[row * im.w + xx]; if (c === im.transp || c * 3 + 2 >= pal.length) continue;
        const o = (yy * W + X) * 4; canvas[o] = pal[c * 3]; canvas[o + 1] = pal[c * 3 + 1]; canvas[o + 2] = pal[c * 3 + 2]; canvas[o + 3] = 255;
      }
    }
  }
}
/** Every frame as its own copy — for small GIFs only (the tests): refused above `maxTotalPx` pixels in all. */
export function gifFrames(b: Uint8Array, maxTotalPx = 4 << 20): { w: number; h: number; frames: { rgba: Uint8ClampedArray; delay: number }[] } {
  const d = new GifDecoder(b); if (d.w * d.h * d.count > maxTotalPx) throw new GifError('tooBig');
  const frames = []; for (let i = 0; i < d.count; i++) frames.push({ rgba: d.frame(i).slice(), delay: d.delay(i) });
  return { w: d.w, h: d.h, frames };
}
