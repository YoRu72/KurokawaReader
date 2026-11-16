// A small GIF reader for pet frames: its size and frame count from the blocks alone, and each frame decoded (LZW) and
// composed as a viewer shows it (transparency, disposal), as RGBA. Bounded: a frame larger than the limit, too many
// frames, or data that runs past the end stops it with an error instead of a guess.

export interface GifFrame { rgba: Uint8ClampedArray; delay: number }
export interface GifInfo { w: number; h: number; frames: number }
export class GifError extends Error {}
const MAX_FRAMES = 300;

interface Img { x: number; y: number; w: number; h: number; lct: Uint8Array | null; interlace: boolean; minCode: number; data: Uint8Array; disposal: number; delay: number; transp: number }
function walk(b: Uint8Array, maxPx: number): { w: number; h: number; gct: Uint8Array | null; bg: number; imgs: Img[] } {
  if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) throw new GifError('notGif');
  const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8);
  if (!w || !h || w * h > maxPx) throw new GifError('tooBig');
  let p = 13; const flags = b[10]; let gct: Uint8Array | null = null;
  const need = (n: number) => { if (p + n > b.length) throw new GifError('truncated'); };
  if (flags & 0x80) { const n = 3 * (1 << ((flags & 7) + 1)); need(n); gct = b.subarray(p, p + n); p += n; }
  const imgs: Img[] = []; let disposal = 0, delay = 10, transp = -1;
  const blocks = (): Uint8Array => { const parts: Uint8Array[] = []; let len = 0; for (;;) { need(1); const n = b[p++]; if (!n) break; need(n); parts.push(b.subarray(p, p + n)); len += n; p += n; } const out = new Uint8Array(len); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return out; };
  for (;;) {
    need(1); const c = b[p++];
    if (c === 0x3b) break;
    if (c === 0x21) { need(1); const lab = b[p++]; if (lab === 0xf9) { const d = blocks(); if (d.length >= 4) { disposal = (d[0] >> 2) & 7; delay = d[1] | (d[2] << 8); transp = d[0] & 1 ? d[3] : -1; } } else blocks(); continue; }
    if (c !== 0x2c) throw new GifError('badBlock');
    need(9); const x = b[p] | (b[p + 1] << 8), y = b[p + 2] | (b[p + 3] << 8), iw = b[p + 4] | (b[p + 5] << 8), ih = b[p + 6] | (b[p + 7] << 8), f = b[p + 8]; p += 9;
    let lct: Uint8Array | null = null; if (f & 0x80) { const n = 3 * (1 << ((f & 7) + 1)); need(n); lct = b.subarray(p, p + n); p += n; }
    need(1); const minCode = b[p++]; if (minCode < 2 || minCode > 11) throw new GifError('badCode');
    imgs.push({ x, y, w: iw, h: ih, lct, interlace: !!(f & 0x40), minCode, data: blocks(), disposal, delay, transp });
    if (imgs.length > MAX_FRAMES) throw new GifError('tooManyFrames');
    disposal = 0; delay = 10; transp = -1;
  }
  return { w, h, gct, bg: b[11], imgs };
}
/** Size and frame count (no pixels decoded). */
export function gifInfo(b: Uint8Array, maxPx = 4096 * 4096): GifInfo { const g = walk(b, maxPx); return { w: g.w, h: g.h, frames: g.imgs.length }; }

function lzw(data: Uint8Array, minCode: number, count: number): Uint8Array {
  const out = new Uint8Array(count); let op = 0;
  const clear = 1 << minCode, eoi = clear + 1;
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), firstOf = new Uint8Array(4096); const stack = new Uint8Array(4097);
  let size = minCode + 1, next = eoi + 1, old = -1; let bits = 0, acc = 0, ip = 0;
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; firstOf[i] = i; }
  while (op < count) {
    while (bits < size) { if (ip >= data.length) return out; acc |= data[ip++] << bits; bits += 8; }
    const code = acc & ((1 << size) - 1); acc >>>= size; bits -= size;
    if (code === clear) { size = minCode + 1; next = eoi + 1; old = -1; continue; }
    if (code === eoi) break;
    if (old < 0) { if (code >= clear) throw new GifError('badData'); out[op++] = code; old = code; continue; }
    let c = code, sp = 0;
    if (code >= next) { if (code > next) throw new GifError('badData'); stack[sp++] = firstOf[old]; c = old; }
    while (c >= clear) { if (sp >= 4096) throw new GifError('badData'); stack[sp++] = suffix[c]; c = prefix[c]; }
    stack[sp++] = c; const first = c;
    while (sp && op < count) out[op++] = stack[--sp];
    if (next < 4096) { prefix[next] = old; suffix[next] = first; firstOf[next] = firstOf[old]; next++; if (next === 1 << size && size < 12) size++; }
    old = code;
  }
  return out;
}
/** Every frame composed in full (RGBA, w×h), with its delay in seconds. */
export function gifFrames(b: Uint8Array, maxPx = 1024 * 1024, maxFrames = MAX_FRAMES): { w: number; h: number; frames: GifFrame[] } {
  const g = walk(b, maxPx); if (g.imgs.length > maxFrames) throw new GifError('tooManyFrames');
  const canvas = new Uint8ClampedArray(g.w * g.h * 4); const frames: GifFrame[] = [];
  for (const im of g.imgs) {
    const pal = im.lct ?? g.gct; if (!pal) throw new GifError('noPalette');
    const before = im.disposal === 3 ? canvas.slice() : null;
    const idx = lzw(im.data, im.minCode, im.w * im.h);
    const rows: number[] = [];
    if (im.interlace) { for (const [s, st] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let r = s; r < im.h; r += st) rows.push(r); } else for (let r = 0; r < im.h; r++) rows.push(r);
    for (let i = 0; i < rows.length; i++) {
      const yy = im.y + rows[i]; if (yy >= g.h) continue;
      for (let xx = 0; xx < im.w; xx++) {
        const X = im.x + xx; if (X >= g.w) continue; const c = idx[i * im.w + xx]; if (c === im.transp || c * 3 + 2 >= pal.length) continue;
        const o = (yy * g.w + X) * 4; canvas[o] = pal[c * 3]; canvas[o + 1] = pal[c * 3 + 1]; canvas[o + 2] = pal[c * 3 + 2]; canvas[o + 3] = 255;
      }
    }
    frames.push({ rgba: canvas.slice(), delay: Math.max(0.02, (im.delay || 10) / 100) });
    if (im.disposal === 2) for (let yy = im.y; yy < Math.min(g.h, im.y + im.h); yy++) canvas.fill(0, (yy * g.w + im.x) * 4, (yy * g.w + Math.min(g.w, im.x + im.w)) * 4);
    else if (before) canvas.set(before);
  }
  return { w: g.w, h: g.h, frames };
}
