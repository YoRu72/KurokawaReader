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
    const big = m.bytes.byteLength > 1536 * 1024;
    const bmp = big ? await createImageBitmap(blob, { resizeHeight: m.height, resizeQuality: 'high' }) : await createImageBitmap(blob);
    const scale = Math.min(1, m.height / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
    const out = await c.convertToBlob({ type: 'image/jpeg', quality: m.quality });
    (self as unknown as Worker).postMessage({ id: m.id, blob: out });
  } catch (err) { (self as unknown as Worker).postMessage({ id: m.id, error: String((err as Error)?.message ?? err) }); }
};
