// Drawing a pet's frame and telling whether a point falls on one of its opaque pixels: shared by the in-app layer
// (./stage.ts) and the desktop window (./desktop.ts).
import type { PetView } from './runtime';

/** A frame's alpha channel (read once per frame; null where the picture cannot be read back). */
export function maskOf(im: ImageBitmap): Uint8Array | null {
  try {
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const cx = c.getContext('2d', { willReadFrequently: true })!; cx.drawImage(im, 0, 0);
    const d = cx.getImageData(0, 0, im.width, im.height).data; const m = new Uint8Array(im.width * im.height);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3];
    c.width = c.height = 0; return m;
  } catch { return null; }
}
/** Whether (x, y) — in the view's own coordinates — is on an opaque pixel of the frame drawn there. */
export function hitView(v: PetView, im: ImageBitmap | undefined, masks: (Uint8Array | null)[], x: number, y: number): boolean {
  if (!im || x < v.x || y < v.y || x >= v.x + v.w || y >= v.y + v.h) return false;
  let m = masks[v.frame]; if (m === undefined) { m = maskOf(im); masks[v.frame] = m; }
  if (!m) return true;
  let fx = Math.floor(((x - v.x) / v.w) * im.width); const fy = Math.floor(((y - v.y) / v.h) * im.height); if (v.flip) fx = im.width - 1 - fx;
  return (m[fy * im.width + fx] ?? 0) > 40;
}
/** The frame drawn into a canvas (cleared), at (dx, dy) CSS pixels, flipped when the view says, scaled to the view. */
export function drawFrame(cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D, im: ImageBitmap, v: PetView, dx: number, dy: number, smooth: boolean): void {
  const dpr = cv.width / Math.max(1, parseFloat(cv.style.width) || cv.width);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingEnabled = smooth;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (v.flip) { ctx.translate(dx * 2 + v.w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(im, dx, dy, v.w, v.h);
}
