// The scanner's picture work, as messages: run in worker threads (several pages at once, the screen left free)
// or, where workers are not available, here. Photos are decoded straight to the size the work needs — a
// 12-50-megapixel photo is never held whole — which is what kept a phone from decoding a dozen of them.
import * as S from './scan';

export type Look = { quad: S.Quad; curve: S.Curve | null; flatten: boolean; turn: number; filter: S.Filter; adj: S.Adjust };
export type Prepared = { preview: S.Img; look: Look; thumb: Blob };
export type Op =
  | { op: 'prepare'; blob: Blob; maxSide: number; autoCrop: boolean; autoTurn: boolean; flatten: boolean; filter: S.Filter; rtl: boolean }
  | { op: 'decode'; blob: Blob; maxSide: number }
  | { op: 'detect'; preview: S.Img }
  | { op: 'thumb'; preview: S.Img; look: Look }
  | { op: 'curve'; preview: S.Img; quad: S.Quad }
  | { op: 'view'; preview: S.Img; look: Look; side: number }
  | { op: 'render'; blob: Blob; look: Look; side: number; type: string; quality: number };

const FULL: S.Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const scaleQuad = (q: S.Quad, w: number, hh: number): S.Quad => q.map((p) => ({ x: p.x * w, y: p.y * hh })) as S.Quad;

/* ---------- pictures in and out ---------- */

/** Width and height of a JPEG, PNG or WebP as it is shown (a camera's EXIF turn applied), read from its header. */
export async function imageSize(blob: Blob): Promise<{ w: number; h: number } | null> {
  const b = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  const u16 = (i: number, le = false) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (i: number, le = false) => (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: u32(16), h: u32(20) }; // PNG
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) { // WebP
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === 'VP8L') { const v = u32(21, true); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
    if (kind === 'VP8 ') return { w: u16(26, true) & 0x3fff, h: u16(28, true) & 0x3fff };
    return null;
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null; // JPEG
  let orient = 1;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = u16(i + 2);
    if (m === 0xe1 && String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]) === 'Exif') {
      const t = i + 10, le = b[t] === 0x49; const ifd = t + u32(t + 4, le); const n = u16(ifd, le);
      for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (e + 10 > b.length) break; if (u16(e, le) === 0x0112) orient = u16(e + 8, le); }
    }
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      const hh = u16(i + 5), w = u16(i + 7);
      return orient >= 5 ? { w: hh, h: w } : { w, h: hh };
    }
    i += 2 + len;
  }
  return null;
}

/** The photo's pixels, at most `maxSide` on its longer side, decoded at that size (turned as the camera held it). */
export async function decodeScaled(blob: Blob, maxSide: number): Promise<S.Img> {
  const size = await imageSize(blob).catch(() => null);
  let bmp: ImageBitmap | null = null;
  if (size) {
    const k = Math.min(1, maxSide / Math.max(size.w, size.h));
    const w = Math.max(1, Math.round(size.w * k)), hh = Math.max(1, Math.round(size.h * k));
    try {
      bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: w, resizeHeight: hh, resizeQuality: 'high' } as ImageBitmapOptions);
      // (Should a browser size the picture before turning it, it comes out the other way round: asked again.)
      if ((bmp.width > bmp.height) !== (w > hh) && w !== hh) { bmp.close(); bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: hh, resizeHeight: w, resizeQuality: 'high' } as ImageBitmapOptions); }
    } catch { bmp = null; }
  }
  if (!bmp) {
    try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions); }
    catch { throw new Error('undecodable'); }
  }
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), hh = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, hh);
  const g = c.getContext('2d', { willReadFrequently: true })!; g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, hh); bmp.close();
  return { data: g.getImageData(0, 0, w, hh).data, width: w, height: hh };
}

export function encode(img: S.Img, type: string, quality?: number): Promise<Blob> {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(new ImageData(img.data as unknown as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return c.convertToBlob({ type, quality });
}

/* ---------- the work ---------- */

/** The page as it comes out of a picture of the photo: flattened, cleaned, turned upright. */
export function render(src: S.Img, p: Look, maxSide: number): S.Img {
  const q = S.orderQuad(scaleQuad(p.quad, src.width, src.height));
  let flat = S.warp(src, q, S.flatSize(q, maxSide));
  if (p.flatten && p.curve) flat = S.trimMargins(S.unwarp(flat, p.curve), p.curve.sheet ? 'lr' : 'all');
  return S.rotate(S.applyFilter(flat, p.filter, p.adj), p.turn);
}

export function curveOf(preview: S.Img, quad: S.Quad): S.Curve | null {
  const q = S.orderQuad(scaleQuad(quad, preview.width, preview.height));
  try { return S.findCurve(S.warp(preview, q, S.flatSize(q, 1100))); } catch { return null; }
}

/** Run one message's work; returns the answer and what in it can be handed over rather than copied. */
export async function handle(m: Op): Promise<{ res: unknown; transfer: Transferable[] }> {
  if (m.op === 'prepare') {
    const preview = await decodeScaled(m.blob, m.maxSide);
    const look: Look = { quad: FULL, curve: null, flatten: m.flatten, turn: 0, filter: m.filter, adj: {} };
    if (m.autoCrop) { const f = S.detectPage(preview); look.quad = f.quad.map((c) => ({ x: c.x / preview.width, y: c.y / preview.height })) as S.Quad; }
    look.curve = curveOf(preview, look.quad);
    if (m.autoTurn) look.turn = S.uprightTurn(render(preview, { ...look, turn: 0, filter: 'gray', adj: {} }, 700), m.rtl);
    const thumb = await encode(render(preview, look, 420), 'image/jpeg', 0.8);
    return { res: { preview, look, thumb } satisfies Prepared, transfer: [preview.data.buffer] };
  }
  if (m.op === 'decode') { const img = await decodeScaled(m.blob, m.maxSide); return { res: img, transfer: [img.data.buffer] }; }
  if (m.op === 'detect') { const f = S.detectPage(m.preview); return { res: { how: f.how, quad: f.quad.map((c) => ({ x: c.x / m.preview.width, y: c.y / m.preview.height })) }, transfer: [] }; }
  if (m.op === 'thumb') return { res: await encode(render(m.preview, m.look, 420), 'image/jpeg', 0.8), transfer: [] };
  if (m.op === 'curve') return { res: curveOf(m.preview, m.quad), transfer: [] };
  if (m.op === 'view') { const img = render(m.preview, m.look, m.side); return { res: img, transfer: [img.data.buffer] }; }
  // The finished page, from the photo decoded once at the size the PDF needs.
  const src = await decodeScaled(m.blob, Math.round(m.side * 1.25));
  return { res: await encode(render(src, m.look, m.side), m.type, m.quality), transfer: [] };
}
