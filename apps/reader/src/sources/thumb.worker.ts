// A cover made small off the main thread: the picture's bytes in, a small JPEG out — decoding a megabyte of
// JPEG and drawing it would otherwise drop frames on the shelf while the reader scrolls (Mihon decodes its
// covers on worker threads for the same reason). Also a zip entry inflated, when the page's own stream is
// wanted away from the main thread.
self.onmessage = async (e: MessageEvent<{ id: number; op: 'thumb'; bytes: ArrayBuffer; type: string; height: number; quality: number } | { id: number; op: 'inflate'; bytes: ArrayBuffer }>) => {
  const m = e.data;
  try {
    if (m.op === 'inflate') {
      const ds = new DecompressionStream('deflate-raw' as CompressionFormat);
      const out = await new Response(new Blob([m.bytes]).stream().pipeThrough(ds)).arrayBuffer();
      (self as unknown as Worker).postMessage({ id: m.id, bytes: out }, [out]);
      return;
    }
    const blob = new Blob([m.bytes], { type: m.type });
    // (Decoded straight to the size shown when the picture is taller — a 2000-pixel cover decoded whole and then
    // drawn small costs ten times the work, and this worker does it for every cover on the shelf.)
    const dim = sizeOf(new Uint8Array(m.bytes));
    const big = dim ? dim.h > m.height * 1.15 : m.bytes.byteLength > 1536 * 1024;
    const bmp = big ? await createImageBitmap(blob, dim ? { resizeHeight: m.height, resizeWidth: Math.max(1, Math.round(dim.w * m.height / dim.h)), resizeQuality: 'medium' } : { resizeHeight: m.height, resizeQuality: 'medium' }) : await createImageBitmap(blob);
    const scale = Math.min(1, m.height / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
    // (WebP where the browser writes it — a third smaller for the same look — else a JPEG.)
    let out = await c.convertToBlob({ type: 'image/webp', quality: m.quality }).catch(() => null);
    if (!out || out.type !== 'image/webp') out = await c.convertToBlob({ type: 'image/jpeg', quality: m.quality });
    (self as unknown as Worker).postMessage({ id: m.id, blob: out });
  } catch (err) { (self as unknown as Worker).postMessage({ id: m.id, error: String((err as Error)?.message ?? err) }); }
};

/** A picture's size from its header (JPEG, PNG, GIF, WebP), without decoding it; null when unknown. */
function sizeOf(b: Uint8Array): { w: number; h: number } | null {
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
    if (b[0] === 0x47 && b[1] === 0x49) return { w: b[6] | b[7] << 8, h: b[8] | b[9] << 8 };
    if (b[0] === 0x52 && b[8] === 0x57 && b[12] === 0x56 && b[13] === 0x50) {
      const k = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (k === 'VP8 ') return { w: (b[26] | b[27] << 8) & 0x3fff, h: (b[28] | b[29] << 8) & 0x3fff };
      if (k === 'VP8L') return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
      if (k === 'VP8X') return { w: 1 + (b[24] | b[25] << 8 | b[26] << 16), h: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let p = 2;
      while (p + 9 < b.length) {
        if (b[p] !== 0xff) { p++; continue; }
        const mk = b[p + 1];
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { h: b[p + 5] << 8 | b[p + 6], w: b[p + 7] << 8 | b[p + 8] };
        p += 2 + (b[p + 2] << 8 | b[p + 3]);
      }
    }
  } catch { /* unknown */ }
  return null;
}
