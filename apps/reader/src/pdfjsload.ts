// pdf.js, loaded on first use (≈450 KB, not at start-up), and the mark for canvases drawn off the screen. Kept
// apart from the viewer (formats/pdf.ts) so that a worker can load it too: the PDF converter's page readers.
export type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;

/** A canvas a page is drawn on off the screen (a cover, a thumbnail, the converter's): pdf.js draws it slice
 *  after slice without waiting for screen frames (see scripts/patch-pdfjs.mjs) — faster, and it goes on in an
 *  app out of sight. `sharedOps`: drawn from the operator list `getOperatorList()` read for the page, not a
 *  second one read again by the worker. */
export function offscreen<T extends HTMLCanvasElement>(c: T, sharedOps = false): T {
  const k = c as T & { krFast?: boolean; krSharedOps?: boolean };
  k.krFast = true; if (sharedOps) k.krSharedOps = true;
  return c;
}

export function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href; return m; });
  return pdfjsPromise;
}
