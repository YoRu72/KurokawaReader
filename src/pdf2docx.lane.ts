// A lane of the PDF → Word converter: a worker that reads some of the pages — its own copy of the document,
// parsed by its own pdf.js worker, each page laid out and its graphics drawn here (on an OffscreenCanvas) —
// while other lanes read others and the app's thread only puts the pages together (src/pdf2docx.ts,
// readInLanes). A long book on a phone with eight cores reads about three times as fast.
//
// Every page comes out as it would on the app's thread. The fonts are named by what they are in the file (the
// font id pdf.js is patched to give, see scripts/patch-pdfjs.mjs), not by the order this copy met them; the
// glyph runs are all sent (the cap on them is applied where the pages come together, in page order); and what
// depends on earlier pages read elsewhere — a font of whole-word glyphs met on an earlier page — is told back
// so that the page can be read again when it mattered.
import type { FontInfo, PageModel, UseStore } from './pdf2docx';
import type { GlyphUse } from './fontfix';

// What pdf.js and the converter ask of a document here: canvases (off the screen) and the fonts' face set.
const g = globalThis as unknown as { document?: unknown };
if (!g.document) {
  const proto = OffscreenCanvas.prototype as unknown as { toBlob?: (cb: (b: Blob | null) => void, type?: string, quality?: number) => void; convertToBlob(o?: { type?: string; quality?: number }): Promise<Blob> };
  proto.toBlob ??= function (this: typeof proto, cb, type, quality) { this.convertToBlob({ type, quality }).then(cb, () => cb(null)); };
  g.document = { createElement: (tag: string) => { if (tag !== 'canvas') throw new Error(`no <${tag}> in a worker`); return new OffscreenCanvas(1, 1); }, fonts: (self as unknown as { fonts?: unknown }).fonts };
}

type Job = { n: number; force?: string[] };
export type LaneIn = { t: 'open'; bytes: ArrayBuffer; lane: number } | { t: 'page'; n: number; force?: string[] } | { t: 'word'; ids: string[] } | { t: 'close' };
export type LanePage = {
  t: 'page'; n: number; model: PageModel;
  /** Fonts this lane met first on this page: their ids and what is known of them. */
  fonts: [string, FontInfo][];
  /** The page's fonts in the order its text meets them. */
  pageFonts: string[];
  seqs: { rtl?: boolean; uses: [string, GlyphUse][] }[];
  gaps: [string, number[]][];
  wordFound: string[]; stickyMiss: string[];
};
export type LaneOut = { t: 'ready'; pages: number } | LanePage | { t: 'error'; n?: number; message: string };

let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let doc: import('pdfjs-dist').PDFDocumentProxy | null = null;
let task: { destroy(): Promise<void> } | null = null;
let lane = 0;
const fonts = new Map<string, FontInfo>();
const idOf = new Map<string, string>(); // this copy's font name → the font's id
const forced = new Set<string>(); // ids of fonts of whole-word glyphs, met on earlier pages
let fresh: string[] = [];
const store: UseStore = { seqs: [], seen: new Map(), keepAll: true, onFont: (name, info, fo) => {
  const id = (fo as { krId?: string } | null)?.krId ?? `x${lane}:${name}`;
  idOf.set(name, id); fresh.push(name);
  if (forced.has(id)) info.wordFont = true;
} };
const queue: Job[] = [];
const asked = new Map<number, Promise<import('pdfjs-dist').PDFPageProxy>>();
let busy = false;
const post = (m: LaneOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

const force = (ids: string[]) => {
  for (const id of ids) forced.add(id);
  for (const [name, f] of fonts) if (forced.has(idOf.get(name) ?? '')) f.wordFont = true;
};

async function open(bytes: ArrayBuffer): Promise<void> {
  // (Text kept as drawn is drawn with the PDF's own fonts, which pdf.js loads into the worker's font set.)
  if (!(self as unknown as { fonts?: unknown }).fonts || typeof (OffscreenCanvas.prototype as unknown as { convertToBlob?: unknown }).convertToBlob !== 'function') throw new Error('no fonts or canvas in workers here');
  const { loadPdfjs } = await import('./pdfjsload');
  pdfjs = await loadPdfjs();
  const RES = new URL('./pdfjs/', import.meta.url).href;
  // (pdf.js's own worker, made here: in a worker it would otherwise read the file on this thread.)
  const port = new Worker(pdfjs.GlobalWorkerOptions.workerSrc, { type: 'module' });
  const worker = new pdfjs.PDFWorker({ port } as unknown as ConstructorParameters<typeof pdfjs.PDFWorker>[0]);
  const t = pdfjs.getDocument({ worker, data: new Uint8Array(bytes), fontExtraProperties: true, useSystemFonts: false, cMapUrl: `${RES}cmaps/`, cMapPacked: true, standardFontDataUrl: `${RES}standard_fonts/`, wasmUrl: `${RES}wasm/`, iccUrl: `${RES}iccs/` } as Parameters<typeof pdfjs.getDocument>[0]);
  task = t;
  const d = await t.promise; doc = d;
  post({ t: 'ready', pages: d.numPages });
}

async function pump(): Promise<void> {
  if (busy || !doc) return;
  busy = true;
  const { analysePage, askAhead, takePendingPngs } = await import('./pdf2docx');
  try {
    while (queue.length) {
      const job = queue.shift()!;
      // The next pages asked now, read by pdf.js's worker while this one is laid out.
      for (const j of [job, ...queue.slice(0, 2)]) if (!asked.has(j.n)) asked.set(j.n, doc.getPage(j.n).then((pg) => { askAhead(pg); return pg; }));
      const page = await asked.get(job.n)!; asked.delete(job.n);
      if (job.force) force(job.force);
      const gapsBefore = new Map([...fonts].map(([k, f]) => [k, f.gaps?.length ?? 0]));
      const wordBefore = new Set([...fonts].filter(([, f]) => f.wordFont).map(([k]) => k));
      fresh = []; store.seqs = []; store.pageFonts = []; store.stickyMiss = new Set();
      let model: PageModel;
      try {
        model = await analysePage(pdfjs, page, fonts, true, store);
        await Promise.all(takePendingPngs());
      } catch (e) { post({ t: 'error', n: job.n, message: String((e as Error)?.stack ?? e) }); continue; }
      const id = (name: string) => idOf.get(name) ?? `x${lane}:${name}`;
      const res: LanePage = {
        t: 'page', n: job.n, model,
        fonts: fresh.map((name) => { const { uses: _u, gaps: _g, wordFont: _w, ...info } = fonts.get(name)!; return [id(name), info as FontInfo]; }),
        pageFonts: store.pageFonts.map(id),
        seqs: store.seqs.map((s) => ({ rtl: s.rtl, uses: s.map(([f, u]) => [id(f), u] as [string, GlyphUse]) })),
        gaps: [...fonts].flatMap(([k, f]) => { const was = gapsBefore.get(k) ?? 0; return (f.gaps?.length ?? 0) > was ? [[id(k), f.gaps!.slice(was)] as [string, number[]]] : []; }),
        wordFound: [...fonts].filter(([k, f]) => f.wordFont && !wordBefore.has(k)).map(([k]) => id(k)),
        stickyMiss: [...store.stickyMiss].map(id),
      };
      store.seqs = [];
      // The pictures' bytes go over, not copied (each its own buffer).
      const bufs = new Set<ArrayBuffer>();
      const take = (u?: Uint8Array) => { if (u && u.byteLength && u.byteOffset === 0 && u.buffer.byteLength === u.byteLength) bufs.add(u.buffer as ArrayBuffer); };
      for (const p of model.pics) take(p.png);
      post(res, [...bufs]);
      page.cleanup();
    }
  } finally { busy = false; }
}

self.onmessage = (e: MessageEvent<LaneIn>) => {
  const m = e.data;
  if (m.t === 'open') { lane = m.lane; open(m.bytes).catch((err) => post({ t: 'error', message: String((err as Error)?.stack ?? err) })); }
  else if (m.t === 'page') { queue.push({ n: m.n, force: m.force }); void pump(); }
  else if (m.t === 'word') force(m.ids);
  else if (m.t === 'close') { void task?.destroy().finally(() => self.close()); if (!task) self.close(); }
};
