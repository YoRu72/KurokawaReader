// Pages of a PDF as pictures, for the PDF tools (thumbnails of the pages to organise, pages saved as pictures):
// drawn by the platform on Android and iOS (PdfRenderer / CoreGraphics — several times faster than pdf.js on a
// phone, with the system's fonts for the ones a PDF does not embed, and the JPEG written by the platform, so a
// page saved as a picture is never decoded and encoded again on the page), by pdf.js elsewhere or when the
// platform cannot open the file (an encrypted PDF). The reader's own drawing is in formats/pdf.ts; the two never
// share a document: the tools open theirs with `keep`, under ids of their own.
import { loadPdfjs, offscreen } from './formats/pdf';

export type Raster = {
  /** How many pages. */
  pages: number;
  /** Each page's size in points, when known cheaply (the platform tells; pdf.js is asked page by page). */
  size(n: number): Promise<{ w: number; h: number }>;
  /** Page `n` (1-based) drawn `width` pixels wide, as a picture file's bytes. */
  render(n: number, o: { width: number; format?: 'jpeg' | 'png'; quality?: number }): Promise<Blob>;
  close(): void;
  native: boolean;
};

interface NativePdf {
  pdfOpen(o: { path: string; keep?: boolean; sizes?: boolean }): Promise<{ id: number; pageCount: number; pages?: [number, number][] }>;
  pdfRender(o: { id: number; page: number; width: number; quality?: number; format?: string; toFile?: boolean }): Promise<{ data?: string; path?: string; width: number; height: number }>;
  pdfClose(o: { id: number }): Promise<void>;
}
interface NativeFs { writeFile(o: { path: string; data: string; directory: string; recursive?: boolean }): Promise<{ uri: string }>; appendFile?(o: { path: string; data: string; directory: string }): Promise<void>; deleteFile?(o: { path: string; directory: string }): Promise<void> }
type Cap = { getPlatform?(): string; convertFileSrc?(p: string): string; Plugins?: { Kurokawa?: NativePdf; Filesystem?: NativeFs } };
const cap = () => (window as unknown as { Capacitor?: Cap }).Capacitor;
let fileSeq = 0;

/** A PDF opened for drawing. The platform's renderer when there is one and the file is not encrypted (a
 *  password means pdf.js, which can open it), else pdf.js. */
export async function openRaster(bytes: Uint8Array, opts: { password?: string } = {}): Promise<Raster> {
  const c = cap();
  const nat = c?.Plugins?.Kurokawa; const fs = c?.Plugins?.Filesystem;
  if (!opts.password && nat && fs && (c?.getPlatform?.() === 'android' || c?.getPlatform?.() === 'ios')) {
    try { return await openNative(nat, fs, c!, bytes); } catch (e) { console.warn('[kurokawa] platform PDF renderer: pdf.js instead', e); }
  }
  return openPdfjs(bytes, opts.password);
}

async function openNative(nat: NativePdf, fs: NativeFs, c: Cap, bytes: Uint8Array): Promise<Raster> {
  const { writeChunked } = await import('./ui/share');
  const path = `kr-pdf/tool-${Date.now().toString(36)}-${++fileSeq}.pdf`;
  const uri = await writeChunked(fs as never, path, new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }), 'CACHE');
  const info = await nat.pdfOpen({ path: uri, keep: true, sizes: true });
  if (!info.pageCount) throw new Error('empty');
  const sizes = info.pages ?? [];
  let seq = 0; let closed = false;
  return {
    pages: info.pageCount, native: true,
    size: async (n) => { const s = sizes[n - 1]; return s ? { w: s[0], h: s[1] } : { w: 595, h: 842 }; },
    render: async (n, o) => {
      const res = await nat.pdfRender({ id: info.id, page: n, width: Math.round(o.width), quality: Math.round((o.quality ?? 0.9) * 100), format: o.format ?? 'jpeg', toFile: !!c.convertFileSrc });
      // (A file written by the platform, read here as bytes: nothing goes through the bridge as text.)
      if (res.path && c.convertFileSrc) return (await fetch(`${c.convertFileSrc(`file://${res.path}`)}?v=${++seq}`, { cache: 'no-store' })).blob();
      const bin = atob(res.data ?? ''); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      return new Blob([a], { type: o.format === 'png' ? 'image/png' : 'image/jpeg' });
    },
    close: () => { if (closed) return; closed = true; void nat.pdfClose({ id: info.id }).catch(() => undefined); void fs.deleteFile?.({ path, directory: 'CACHE' }).catch(() => undefined); },
  };
}

async function openPdfjs(bytes: Uint8Array, password?: string): Promise<Raster> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes.slice(), password } as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise;
  // (One drawing at a time per page is pdf.js's way; two pages at once keep a phone's cores busy without
  // the memory of many canvases.)
  let closed = false;
  return {
    pages: doc.numPages, native: false,
    size: async (n) => { const p = await doc.getPage(n); const v = p.getViewport({ scale: 1 }); return { w: v.width, h: v.height }; },
    render: async (n, o) => {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: o.width / base.width });
      const canvas = offscreen(document.createElement('canvas')); canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise;
      page.cleanup();
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, o.format === 'png' ? 'image/png' : 'image/jpeg', o.quality ?? 0.9));
      canvas.width = 0; canvas.height = 0;
      if (!blob) throw new Error('image');
      return blob;
    },
    close: () => { if (closed) return; closed = true; void task.destroy(); },
  };
}

/** A small queue: the last asked first (what is on screen), `width` at a time. */
export function rasterQueue(width = 2): { add<T>(job: () => Promise<T>): Promise<T>; drop(): void } {
  const waiting: { run: () => Promise<unknown>; ok: (v: unknown) => void; fail: (e: unknown) => void }[] = [];
  let busy = 0;
  const pump = () => {
    while (busy < width && waiting.length) {
      const j = waiting.pop()!; busy++;
      j.run().then(j.ok, j.fail).finally(() => { busy--; pump(); });
    }
  };
  return {
    add: <T,>(job: () => Promise<T>) => new Promise<T>((ok, fail) => { waiting.push({ run: job, ok: ok as (v: unknown) => void, fail }); pump(); }),
    drop: () => { for (const j of waiting.splice(0)) j.fail(new Error('dropped')); },
  };
}
