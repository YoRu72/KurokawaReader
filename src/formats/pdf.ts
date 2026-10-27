// PDF viewing on top of pdf.js: lazily rendered pages with a selectable text
// layer, a page slider, go-to, outline and full-text search.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildTextLayer } from '../pdflayer';
import type { BookMeta, TocItem } from './types';
import { titleFromFileName, normalizeForSearch } from './types';
import { h } from '../ui/dom';
import { t } from '../i18n';

// pdf.js (≈450 KB) is loaded on first use, not at start-up.
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;
export function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href; return m; });
  return pdfjsPromise;
}

const RES = new URL('./pdfjs/', import.meta.url).href;
/** A PDF's Author unless it is a placeholder its writer left ("Un-named", "user", "Administrator"…). */
function realAuthor(a?: string): string | undefined {
  const s = a?.trim();
  return s && !/^(un-?named|unknown|anonymous|user|admin(istrator)?|owner|author|none|n\/?a|-+|\?+)$/i.test(s) ? s : undefined;
}

async function openDoc(file: Blob): Promise<{ doc: PDFDocumentProxy; close: () => void }> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const { openPdfjs } = await import('../pdfkeys');
  // Protected files: the password remembered for the file, else asked for (again when it was wrong) and
  // remembered; a file pdf.js cannot open is read from a copy decrypted here.
  const o = await openPdfjs(pdfjs, data, {
    // Android draws pages with its own renderer; elsewhere the bundled standard fonts keep
    // metrics consistent (system-font substitution misplaces glyphs for many PDFs).
    useSystemFonts: (window as unknown as { Capacitor?: { getPlatform?(): string } }).Capacitor?.getPlatform?.() === 'android',
    cMapUrl: `${RES}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${RES}standard_fonts/`,
    wasmUrl: `${RES}wasm/`,
    iccUrl: `${RES}iccs/`,
  }, { ask: (wrong) => window.prompt(wrong ? t('pdfPasswordWrong') : t('pdfPasswordPrompt')) }).catch((e) => {
    if ((e as Error).message === 'cancelled' || (e as Error).message === 'password') throw new Error(t('cancelled'));
    throw e;
  });
  return { doc: o.doc, close: o.destroy };
}

export async function pdfMeta(file: Blob, fileName: string): Promise<BookMeta> {
  const { doc, close } = await openDoc(file);
  try {
    const info = (await doc.getMetadata().catch(() => null))?.info as Record<string, string> | undefined;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const scale = 360 / vp.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    // toBlob can wait for the next frame (a WebView brought up by another app may not draw one until touched);
    // fall back to the synchronous encoder so importing never stalls on it.
    const cover = await new Promise<Blob | undefined>((res) => {
      let done = false;
      const fin = (b?: Blob | null) => { if (!done) { done = true; res(b ?? undefined); } };
      setTimeout(() => { try { const u = canvas.toDataURL('image/jpeg', 0.82); const bin = atob(u.split(',')[1]); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); fin(new Blob([a], { type: 'image/jpeg' })); } catch { fin(); } }, 700);
      canvas.toBlob((b) => fin(b), 'image/jpeg', 0.82);
    });
    const title = info?.Title?.trim();
    return { title: title && title.toLowerCase() !== 'untitled' ? title : titleFromFileName(fileName), author: realAuthor(info?.Author), pageCount: doc.numPages, cover };
  } finally {
    close();
  }
}

export interface PdfSearchHit { page: number; excerpt: string; term: string; before: string; after: string }

export interface PdfViewerOptions {
  container: HTMLElement;
  onPageChange(page: number, total: number): void;
  onPageRender?(page: number): void;
  invert: boolean;
  /** Crop the margins: each page shows only its printed area (found from its picture), at a common width. */
  crop?: { enabled(): boolean; get(): Promise<CropBox[] | null>; set(boxes: CropBox[]): Promise<void> };
}
/** A page's printed area, as fractions of the page: left, top, width, height. */
export type CropBox = [number, number, number, number];

/** Android: render page bitmaps with the platform renderer (system fonts, JBIG2/JPX, fast). */
interface NativePdf { pdfOpen(o: { path: string }): Promise<{ pageCount: number }>; pdfRender(o: { page: number; width: number; quality?: number; tileX?: number; tileY?: number; tileW?: number; tileH?: number; toFile?: boolean }): Promise<{ data?: string; path?: string; width: number; height: number }>; pdfClose(): Promise<void> }
interface NativeFs { writeFile(o: { path: string; data: string; directory: string; recursive?: boolean }): Promise<{ uri: string }>; stat(o: { path: string; directory: string }): Promise<{ uri: string }> }
function nativePdf(): { pdf: NativePdf; fs: NativeFs } | null {
  const cap = (window as unknown as { Capacitor?: { getPlatform?(): string; Plugins?: { Kurokawa?: NativePdf; Filesystem?: NativeFs } } }).Capacitor;
  if (cap?.getPlatform?.() !== 'android' || !cap.Plugins?.Kurokawa || !cap.Plugins.Filesystem) return null;
  return { pdf: cap.Plugins.Kurokawa, fs: cap.Plugins.Filesystem };
}

/** A page's drawing: its picture (a canvas, scaled to fill the page) and how sharp it is. */
type Shown = {
  pic?: HTMLCanvasElement;
  /** 1: a quick, half-resolution picture (shown while scrolling); 2: full resolution at the current zoom. */
  level: 0 | 1 | 2;
  /** The zoom the picture was drawn at (a picture from before a zoom is kept, stretched, until it is redrawn). */
  at: number;
  tiles?: Map<string, HTMLCanvasElement>;
  tileLayer?: HTMLElement;
  text?: 'building' | 'done';
  textCancel?: () => void;
  seen?: boolean;
};

/** Pieces of a zoomed page, in device pixels (as Google Drive's viewer draws them). */
const TILE = 800;

/** The box holding the ink on a small picture of the page (fractions of the page), with a little room around.
 *  A blank page gives `[0, 0, 1, 0]`; a page that cannot be read gives the whole page, `[0, 0, 1, 1]`. */
function inkBox(img: ImageData): CropBox {
  const { width: W, height: H, data } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  // (Rows and columns are scanned; a pixel counts as ink when it is clearly darker than paper. A few stray
  // specks do not pull the box out: a row or column needs two such pixels.)
  const dark = (i: number) => data[i] + data[i + 1] + data[i + 2] < 3 * 200;
  for (let y = 0; y < H; y++) { let c = 0; for (let x = 0; x < W; x++) if (dark((y * W + x) * 4) && ++c >= 2) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); break; } }
  for (let x = 0; x < W; x++) { let c = 0; for (let y = 0; y < H; y++) if (dark((y * W + x) * 4) && ++c >= 2) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); break; } }
  if (x1 < 0 || y1 < 0) return [0, 0, 1, 0];
  if (x1 - x0 < W * 0.1 || y1 - y0 < H * 0.05) return [0, 0, 1, 1];
  const pad = 3;
  const l = Math.max(0, x0 - pad) / W, t = Math.max(0, y0 - pad) / H, r = Math.min(W, x1 + 1 + pad) / W, b = Math.min(H, y1 + 1 + pad) / H;
  return [+l.toFixed(4), +t.toFixed(4), +(r - l).toFixed(4), +(b - t).toFixed(4)];
}

export class PdfViewer {
  private doc!: PDFDocumentProxy;
  private pages: HTMLElement[] = [];      // the windows: sized to what is shown of each page
  private sheets: HTMLElement[] = [];     // the sheets inside them: the whole page, with everything drawn on it
  private crops: CropBox[] = [];          // the printed area of each page (when known)
  private cropOn = false;
  private cropCommon: [number, number] | null = null;   // the left and width shared by all pages once they are all known
  private shown = new Map<number, Shown>();
  private scale = 1;
  private baseWidths: number[] = [];
  private baseHeights: number[] = [];
  readonly scroll: HTMLElement;
  private inner: HTMLElement;
  pinchZoom = true;
  readonly root: HTMLElement;
  current = 1;
  total = 0;
  private fitWidth = true;
  private lastFit = 0;
  private textCache = new Map<number, string>();
  private resizeObs?: ResizeObserver;
  private destroyed = false;
  private closeDoc: () => void = () => undefined;
  private native: NativePdf | null = null;
  /** Where each page starts (its offsetTop), read in one go after the layout changes — never page by page while
   *  scrolling, which made the browser lay out a thousand pages on every scroll event. */
  private tops: number[] | null = null;
  private first = 1;
  private last = 1;
  private scrolling = false;
  private settleTimer = 0;
  private frameAsked = false;
  private busy = false;
  /** The drawing being made now (one at a time: the page in view first). */
  private running: { n: number; cancel(): void } | null = null;
  private pool: HTMLCanvasElement[] = [];
  private fetchSeq = 0;

  constructor(private opts: PdfViewerOptions) {
    this.inner = h('div', { class: 'pdf-inner' });
    this.scroll = h('div', { class: 'pdf-scroll' }, this.inner);
    this.attachPinch();
    this.root = h('div', { class: 'pdf-view' }, this.scroll);
    this.root.dataset.invert = String(opts.invert);
    opts.container.appendChild(this.root);
  }

  async load(file: Blob, cacheKey?: string, sourceUri?: string): Promise<void> {
    const opened = await openDoc(file);
    this.doc = opened.doc;
    this.closeDoc = opened.close;
    this.total = this.doc.numPages;
    // Size every page from page 1 straight away (like Drive's viewer) so the
    // document appears at once; real page sizes are filled in behind the scenes.
    let first: PDFPageProxy | null = null;
    try { first = await this.doc.getPage(1); } catch { /* fall back to Letter */ }
    const vp1 = first?.getViewport({ scale: 1 });
    const w1 = vp1?.width ?? 612, h1 = vp1?.height ?? 792;
    this.baseWidths = new Array<number>(this.total).fill(w1);
    this.baseHeights = new Array<number>(this.total).fill(h1);
    this.scale = this.computeFitScale(); this.lastFit = this.scale;
    this.pages = []; this.sheets = [];
    this.cropOn = !!this.opts.crop?.enabled();
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= this.total; i++) {
      const sheet = h('div', { class: 'pdf-sheet' });
      const el = h('div', { class: 'pdf-page', dataset: { page: String(i) } }, sheet, h('span', { class: 'pnum' }, String(i)));
      this.pages.push(el); this.sheets.push(sheet);
      this.sizePage(el, i);
      frag.appendChild(el);
    }
    this.inner.appendChild(frag);
    if (this.cropOn) void this.findCrops();
    // Prefer the platform renderer on Android; pdf.js stays in charge of text, search
    // and outline. Opening it is not awaited: pdf.js draws the first screens meanwhile.
    const nat = nativePdf();
    if (nat && cacheKey) {
      void (async () => {
        try {
          let uri: string;
          if (sourceUri?.startsWith('content://')) uri = sourceUri;   // linked file: the renderer reads it in place
          else {
            const path = `kr-pdf/${cacheKey}.pdf`;
            try { uri = (await nat.fs.stat({ path, directory: 'CACHE' })).uri; }
            catch {
              const { writeChunked } = await import('../ui/share');
              uri = await writeChunked(nat.fs as never, path, file, 'CACHE');
              void prunePdfCache(nat.fs, `${cacheKey}.pdf`);
            }
          }
          const info = await nat.pdf.pdfOpen({ path: uri });
          if (this.destroyed || info.pageCount !== this.total) { void nat.pdf.pdfClose().catch(() => undefined); return; }
          {
            this.native = nat.pdf;
            // Redraw what pdf.js already painted so non-embedded Arabic fonts shape correctly.
            for (const s of this.shown.values()) { s.level = 0; this.dropTiles(s); }
            this.pump();
          }
        } catch (e) { console.warn('[kurokawa] native PDF renderer unavailable', e); this.native = null; }
      })();
    }
    void this.measurePages();
    this.scroll.addEventListener('scroll', () => this.onScroll(), { passive: true });
    // The screen turned or the window resized: a page fitted to the width is fitted again; a zoomed page keeps
    // its zoom relative to the new width (so it looks as it did, and the page in view stays in view).
    this.resizeObs = new ResizeObserver(() => {
      this.tops = null;
      const fit = this.computeFitScale();
      if (this.fitWidth) this.rescale(fit);
      else if (this.lastFit && Math.abs(fit - this.lastFit) > 0.001) this.rescale(this.scale * (fit / this.lastFit));
      else this.onScroll();
      this.lastFit = fit;
    });
    this.resizeObs.observe(this.scroll);
    this.opts.onPageChange(this.current, this.total);
    this.frame();
  }

  /** Fetch real page sizes in the background and correct the placeholders. */
  private async measurePages(): Promise<void> {
    let changed: number[] = [];
    const apply = () => {
      if (!changed.length) return;
      // Keep what the reader is looking at where it is when earlier pages change size (worked out from the sizes,
      // not by asking the page for its height — that would lay the whole book out again each time).
      let shift = 0;
      for (const i of changed) {
        const el = this.pages[i - 1]; const before = parseFloat(el.style.height) || 0;
        this.sizePage(el, i);
        if (i < this.current) shift += (parseFloat(el.style.height) || 0) - before;
        const s = this.shown.get(i); if (s) { s.level = Math.min(s.level, 1) as 0 | 1; this.dropTiles(s); }
      }
      changed = [];
      this.tops = null;
      if (shift) this.scroll.scrollTop += shift;
      this.pump();
    };
    for (let i = 2; i <= this.total; i++) {
      if (this.destroyed) return;
      const page = await this.doc.getPage(i).catch(() => null);
      if (this.destroyed || !page) continue;
      const vp = page.getViewport({ scale: 1 });
      if (Math.abs(vp.width - this.baseWidths[i - 1]) >= 0.5 || Math.abs(vp.height - this.baseHeights[i - 1]) >= 0.5) {
        this.baseWidths[i - 1] = vp.width; this.baseHeights[i - 1] = vp.height; changed.push(i);
      }
      if (i % 40 === 0 || i === this.total) { apply(); await new Promise((r) => setTimeout(r, 0)); }
    }
    apply();
  }

  /** The part of page `n` that is shown, in page points: the crop box when cropping, else the whole page. */
  private shownBox(n: number): { x: number; y: number; w: number; h: number } {
    const W = this.baseWidths[n - 1], H = this.baseHeights[n - 1];
    const c = this.cropOn ? this.crops[n - 1] : undefined;
    if (!c) return { x: 0, y: 0, w: W, h: H };
    let [l, , w] = c;
    // A blank page is a short blank strip, not a whole page of nothing.
    if (c[3] === 0) { const [cl, cw] = this.cropCommon ?? [0, 1]; return { x: cl * W, y: 0, w: cw * W, h: H * 0.12 }; }
    // A page whose ink sits inside the shared box takes the shared box, so the text does not shift from page to
    // page; one that reaches further out (a decorated title page, a picture to the edge) keeps its own.
    if (this.cropCommon) { const [cl, cw] = this.cropCommon; if (l >= cl - 0.01 && l + w <= cl + cw + 0.01) { l = cl; w = cw; } }
    return { x: l * W, y: c[1] * H, w: w * W, h: c[3] * H };
  }
  private computeFitScale(): number {
    const avail = Math.max(280, this.scroll.clientWidth - 24);
    const widths = this.baseWidths.slice(0, 9).map((_, i) => this.shownBox(i + 1).w);
    // Fitting the usual page: when cropping, the odd wide page (a title page) must not shrink all the others.
    const w = this.cropOn && this.cropCommon ? widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)] : Math.max(...widths.slice(0, 5));
    return Math.min(avail / w, 3);
  }

  private sizePage(el: HTMLElement, n: number): void {
    const box = this.shownBox(n);
    const w = box.w * this.scale, hgt = box.h * this.scale;
    el.style.width = `${Math.floor(w)}px`;
    el.style.height = `${Math.floor(hgt)}px`;
    el.style.setProperty('--total-scale-factor', String(this.scale));
    el.style.setProperty('--scale-factor', String(this.scale));
    const sheet = this.sheets[n - 1];
    if (sheet) {
      sheet.style.width = `${Math.floor(this.baseWidths[n - 1] * this.scale)}px`; sheet.style.height = `${Math.floor(this.baseHeights[n - 1] * this.scale)}px`;
      sheet.style.left = `${-Math.round(box.x * this.scale)}px`; sheet.style.top = `${-Math.round(box.y * this.scale)}px`;
    }
  }

  /* ---------- the printed area of each page (margins cropped) ---------- */

  /** Turn margin cropping on or off (the layout follows, the page in view staying in view). */
  setCrop(on: boolean): void {
    if (on === this.cropOn) return;
    this.cropOn = on;
    const n = this.current, rel = this.relativeOffset(n);
    if (on && !this.crops.length) void this.findCrops();
    this.fitWidth = true; this.rescale(this.computeFitScale()); this.relayout(); this.goTo(n, rel); this.frame();
  }
  /** Take a set of boxes into the layout, the page in view staying in view. */
  private applyCrops(boxes: CropBox[]): void {
    this.crops = boxes; this.cropCommon = this.commonCrop();
    if (!this.cropOn) return;
    const cur = this.current, rel = this.relativeOffset(cur);
    if (this.fitWidth) this.rescale(this.computeFitScale());
    this.relayout(); this.goTo(cur, rel); this.frame();
  }
  private relayout(): void {
    this.pages.forEach((p, i) => this.sizePage(p, i + 1)); this.tops = null;
    for (const s of this.shown.values()) { this.dropTiles(s); }
  }
  /** Find every page's printed area from a small picture of it (kept with the book afterwards). */
  private async findCrops(): Promise<void> {
    if (this.cropsPending) return; this.cropsPending = true;
    try {
      const cached = await this.opts.crop?.get().catch(() => null);
      if (cached && cached.length === this.total) { this.applyCrops(cached); return; }
      const boxes: CropBox[] = new Array(this.total);
      const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      for (let n = 1; n <= this.total; n++) {
        if (this.destroyed) return;
        try {
          const page = await this.doc.getPage(n);
          const vp1 = page.getViewport({ scale: 1 }); const k = 120 / vp1.width;
          const vp = page.getViewport({ scale: k }); canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
          boxes[n - 1] = inkBox(ctx.getImageData(0, 0, canvas.width, canvas.height));
        } catch { boxes[n - 1] = [0, 0, 1, 1]; }
        // The layout takes the boxes in batches (every page would make the pages jump about); between pages the
        // main thread is given back, so a scroll under way stays smooth.
        if (n % 24 === 0 && n < this.total) this.applyCrops(boxes.map((b, i) => b ?? this.crops[i] ?? [0, 0, 1, 1]));
        await new Promise((r) => ('requestIdleCallback' in window ? (window as Window & { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback(() => r(undefined), { timeout: 200 }) : setTimeout(r, 0)));
      }
      this.applyCrops(boxes);
      void this.opts.crop?.set(boxes);
    } finally { this.cropsPending = false; }
  }
  private cropsPending = false;
  /**
   * One left edge and width for the ordinary pages, so the text does not shift from page to page: the typical
   * edges, pushed out to take in every page whose edges sit near them. Nothing is ever cut: a page reaching
   * much further out (a decorated title page, a picture to the edge) is an exception that keeps its own box.
   */
  private commonCrop(): [number, number] | null {
    const known = this.crops.filter((c) => c && c[3] > 0 && !(c[0] === 0 && c[2] === 1));
    if (known.length < 2) return null;
    const median = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const mL = median(known.map((c) => c[0])), mR = median(known.map((c) => c[0] + c[2]));
    let l = mL, r = mR;
    for (const c of known) { if (c[0] >= mL - 0.08) l = Math.min(l, c[0]); if (c[0] + c[2] <= mR + 0.08) r = Math.max(r, c[0] + c[2]); }
    return r - l > 0.2 ? [l, r - l] : null;
  }

  /* ---------- what is in view ---------- */

  private layoutTops(): number[] {
    if (!this.tops || this.tops.length !== this.pages.length) {
      // (Measured from the top of the scrolled content: the pages' offsetParent may be the inner box.)
      const base = this.pages[0]?.offsetParent === this.inner ? this.inner.offsetTop : 0;
      this.tops = this.pages.map((p) => p.offsetTop + base);
    }
    return this.tops;
  }
  private pageHeight(n: number): number { return Math.floor(this.shownBox(n).h * this.scale); }

  /** The first page whose bottom is below `y`. */
  private pageAt(y: number): number {
    const tops = this.layoutTops();
    let lo = 0, hi = this.pages.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tops[m] + this.pageHeight(m + 1) < y) lo = m + 1; else hi = m; }
    return lo + 1;
  }

  private onScroll(): void {
    // (Several scroll events come between two frames: the work is done once per frame.)
    if (!this.frameAsked) { this.frameAsked = true; requestAnimationFrame(() => { this.frameAsked = false; this.frame(); }); }
    this.scrolling = true;
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.settle(), 220);
  }

  private frame(): void {
    if (this.destroyed || !this.pages.length) return;
    const top = this.scroll.scrollTop, hgt = this.scroll.clientHeight;
    this.first = this.pageAt(top);
    this.last = Math.max(this.first, this.pageAt(top + hgt));
    this.updateCurrent();
    // A drawing for a page that has gone well out of view is dropped.
    if (this.running && (this.running.n < this.first - 2 || this.running.n > this.last + 2)) { this.running.cancel(); }
    for (let n = Math.max(1, this.first - 1); n <= Math.min(this.total, this.last + 1); n++) this.pages[n - 1].classList.toggle('loading', !this.shown.get(n)?.pic);
    this.pump();
  }

  /** Scrolling has stopped: pages far from view let go of their pictures, and the ones in view are made sharp. */
  private settle(): void {
    this.scrolling = false;
    if (this.destroyed) return;
    this.frame();
    for (const n of [...this.shown.keys()]) if (n < this.first - 2 || n > this.last + 2) this.releasePage(n);
    this.pump();
  }

  /* ---------- drawing, one thing at a time, the most needed first ---------- */

  private device(): number { return window.devicePixelRatio || 1; }
  /** The largest picture of a whole page, in device pixels on its longer side (as Drive: the screen's longer side,
   *  at least 1024). Beyond it a zoomed page is drawn in tiles. */
  private cap(): number { const d = this.device(); return Math.max(1024, Math.round(Math.max(screen.width, screen.height) * d)); }
  /** The page's whole picture width (device pixels) at this zoom for `level`, and whether it needs tiles. */
  private sizeFor(n: number, level: 1 | 2): { px: number; tiled: boolean } {
    const w = this.baseWidths[n - 1] * this.scale, hh = this.baseHeights[n - 1] * this.scale;
    const want = w * this.device(), cap = this.cap();
    const most = Math.min(cap, (cap * w) / Math.max(1, hh));
    const tiled = want > most * 1.05;
    const full = tiled ? most / 2 : want;  // (under tiles, the whole page only as a backdrop)
    return { px: Math.max(64, Math.round(level === 2 ? full : full / 2)), tiled };
  }

  private nextTask(): (() => Promise<void>) | null {
    const first = this.first, last = this.last;
    const vis: number[] = [];
    // In view, nearest the middle first.
    const mid = (first + last) / 2;
    for (let n = first; n <= last; n++) vis.push(n);
    vis.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    const near = [last + 1, first - 1].filter((n) => n >= 1 && n <= this.total);
    const st = (n: number) => this.shown.get(n);
    const stale = (n: number) => { const s = st(n); return !s?.pic || s.at !== this.scale; };
    // 1. A page in view with nothing on it: quickly while scrolling, sharp when still.
    for (const n of vis) if (!st(n)?.pic) return () => this.draw(n, this.scrolling ? 1 : 2);
    // 2. While scrolling, the next pages get their quick picture too; nothing more until it stops.
    if (this.scrolling) { for (const n of near) if (!st(n)?.pic) return () => this.draw(n, 1); return null; }
    // 3. Pages in view made sharp (or redrawn at a new zoom), then their tiles when zoomed in.
    for (const n of vis) { const s = st(n)!; if (s.level < 2 || s.at !== this.scale) return () => this.draw(n, 2); }
    for (const n of vis) { const t = this.missingTile(n); if (t) return () => this.drawTile(n, t); }
    // 4. The pages either side, sharp.
    for (const n of near) if (stale(n) || st(n)!.level < 2) return () => this.draw(n, 2);
    // 5. The text layer of the pages in view (to select and search), last.
    for (const n of vis) { const s = st(n)!; if (!s.text) return () => this.buildText(n); }
    return null;
  }

  private pump(): void {
    if (this.busy || this.destroyed || !this.doc) return;
    this.busy = true;
    void (async () => {
      try {
        for (let task = this.nextTask(); task && !this.destroyed; task = this.nextTask()) {
          await task();
          // (A frame between two drawings, so the page keeps moving under the finger.)
          await new Promise((r) => requestAnimationFrame(() => r(null)));
        }
      } finally { this.busy = false; }
    })();
  }

  private take(w: number, h: number): HTMLCanvasElement {
    const i = this.pool.findIndex((c) => c.width === w && c.height === h);
    const c = i >= 0 ? this.pool.splice(i, 1)[0] : document.createElement('canvas');
    if (i < 0) { c.width = w; c.height = h; }
    return c;
  }
  private give(c?: HTMLCanvasElement): void {
    if (!c) return; c.remove();
    if (this.pool.length < 6) this.pool.push(c); else { c.width = c.height = 0; }
  }

  /** A whole page's picture at `level`; the old one stays until the new one is ready. */
  private async draw(n: number, level: 1 | 2): Promise<void> {
    const el = this.pages[n - 1];
    let s = this.shown.get(n);
    if (!s) { s = { level: 0, at: 0 }; this.shown.set(n, s); }
    const scale = this.scale;
    const { px } = this.sizeFor(n, level);
    let page: PDFPageProxy;
    try { page = await this.doc.getPage(n); } catch { s.level = level; s.at = scale; return; }
    if (this.destroyed || this.shown.get(n) !== s) return;
    const vp1 = page.getViewport({ scale: 1 });
    const k = px / vp1.width;
    const W = Math.max(1, Math.round(px)), H = Math.max(1, Math.round(vp1.height * k));
    const canvas = this.take(W, H);
    canvas.className = 'pdf-pic';
    let ok = false;
    if (this.native) {
      ok = await this.nativeDraw(n, canvas, { width: W }).catch(() => false);
    }
    if (!ok) {
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      const task = page.render({ canvas, canvasContext: ctx, viewport: page.getViewport({ scale: k }) });
      this.running = { n, cancel: () => task.cancel() };
      try { await task.promise; ok = true; } catch { ok = false; } finally { this.running = null; }
    }
    if (!ok || this.destroyed || this.shown.get(n) !== s || scale !== this.scale) { this.give(canvas); if (!ok && this.shown.get(n) === s && !s.pic) this.shown.delete(n); return; }
    const old = s.pic;
    this.sheets[n - 1].insertBefore(canvas, this.sheets[n - 1].firstChild);
    s.pic = canvas; s.level = level; s.at = scale;
    if (old !== canvas) this.give(old);
    el.classList.remove('loading');
    el.dataset.res = level === 2 && !this.sizeFor(n, 2).tiled ? 'full' : 'low';
    if (!s.seen) { s.seen = true; this.opts.onPageRender?.(n); }
  }

  /** Draw with Android's renderer: written to a file by it and read here as bytes (no text encoding, no bridge
   *  copy of a megabyte string), decoded off the main thread. */
  private async nativeDraw(n: number, canvas: HTMLCanvasElement, o: { width: number; tileX?: number; tileY?: number; tileW?: number; tileH?: number }): Promise<boolean> {
    const nat = this.native!;
    const cap = (window as unknown as { Capacitor?: { convertFileSrc?(p: string): string } }).Capacitor;
    let res: { data?: string; path?: string };
    try { res = await nat.pdfRender({ page: n, quality: 90, toFile: !!cap?.convertFileSrc, ...o }); }
    catch { this.native = null; return false; }
    let blob: Blob;
    if (res.path && cap?.convertFileSrc) blob = await (await fetch(`${cap.convertFileSrc(`file://${res.path}`)}?v=${++this.fetchSeq}`, { cache: 'no-store' })).blob();
    else { const bin = atob(res.data ?? ''); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); blob = new Blob([a], { type: 'image/jpeg' }); }
    const bmp = await createImageBitmap(blob);
    const g = canvas.getContext('2d', { alpha: false })!;
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height); bmp.close();
    return true;
  }

  /* ---------- tiles: a zoomed page drawn sharp in pieces, only where it is seen ---------- */

  private tileGrid(n: number): { full: number; cols: number; rows: number; W: number; H: number } {
    const d = this.device();
    const W = Math.round(this.baseWidths[n - 1] * this.scale * d), H = Math.round(this.baseHeights[n - 1] * this.scale * d);
    return { full: W, cols: Math.ceil(W / TILE), rows: Math.ceil(H / TILE), W, H };
  }

  /** The next tile the page needs where it is seen (with half a tile around it), or null. */
  private missingTile(n: number): { c: number; r: number } | null {
    if (!this.sizeFor(n, 2).tiled) return null;
    const s = this.shown.get(n); if (!s?.pic) return null;
    const el = this.pages[n - 1]; const d = this.device();
    const top = this.layoutTops()[n - 1], left = el.offsetLeft + (el.offsetParent === this.inner ? this.inner.offsetLeft : 0);
    const g = this.tileGrid(n);
    const box = this.shownBox(n); const ox = box.x * this.scale * d, oy = box.y * this.scale * d;
    const x0 = (this.scroll.scrollLeft - left) * d - TILE / 2 + ox, x1 = (this.scroll.scrollLeft + this.scroll.clientWidth - left) * d + TILE / 2 + ox;
    const y0 = (this.scroll.scrollTop - top) * d - TILE / 2 + oy, y1 = (this.scroll.scrollTop + this.scroll.clientHeight - top) * d + TILE / 2 + oy;
    const c0 = Math.max(0, Math.floor(x0 / TILE)), c1 = Math.min(g.cols - 1, Math.floor(x1 / TILE));
    const r0 = Math.max(0, Math.floor(y0 / TILE)), r1 = Math.min(g.rows - 1, Math.floor(y1 / TILE));
    // (Middle of the screen first.)
    const cy = ((this.scroll.scrollTop + this.scroll.clientHeight / 2 - top) * d + oy) / TILE, cx = ((this.scroll.scrollLeft + this.scroll.clientWidth / 2 - left) * d + ox) / TILE;
    let best: { c: number; r: number } | null = null, bd = Infinity;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (s.tiles?.has(`${this.scale}:${c}:${r}`)) continue;
      const dd = (r + 0.5 - cy) ** 2 + (c + 0.5 - cx) ** 2; if (dd < bd) { bd = dd; best = { c, r }; }
    }
    if (!best && s.at === this.scale && s.level === 2) this.pages[n - 1].dataset.res = 'full';
    // Tiles well out of view are let go of.
    if (s.tiles) for (const [key, cv] of s.tiles) { const [, c, r] = key.split(':').map(Number); if (c < c0 - 1 || c > c1 + 1 || r < r0 - 1 || r > r1 + 1) { cv.remove(); s.tiles.delete(key); } }
    return best;
  }

  private async drawTile(n: number, t: { c: number; r: number }): Promise<void> {
    const s = this.shown.get(n); if (!s) return;
    const scale = this.scale; const g = this.tileGrid(n); const d = this.device();
    const x = t.c * TILE, y = t.r * TILE, w = Math.min(TILE, g.W - x), hh = Math.min(TILE, g.H - y);
    const key = `${scale}:${t.c}:${t.r}`;
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = hh; canvas.className = 'pdf-tile';
    Object.assign(canvas.style, { left: `${x / d}px`, top: `${y / d}px`, width: `${w / d}px`, height: `${hh / d}px` });
    let ok = false;
    if (this.native) ok = await this.nativeDraw(n, canvas, { width: g.W, tileX: x, tileY: y, tileW: w, tileH: hh }).catch(() => false);
    if (!ok) {
      let page: PDFPageProxy; try { page = await this.doc.getPage(n); } catch { return; }
      const ctx = canvas.getContext('2d', { alpha: false })!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hh);
      const task = page.render({ canvas, canvasContext: ctx, viewport: page.getViewport({ scale: scale * d, offsetX: -x, offsetY: -y }) });
      this.running = { n, cancel: () => task.cancel() };
      try { await task.promise; ok = true; } catch { ok = false; } finally { this.running = null; }
    }
    if (!ok || this.destroyed || this.shown.get(n) !== s || scale !== this.scale) return;
    if (!s.tileLayer) { s.tileLayer = h('div', { class: 'pdf-tiles' }); s.pic?.after(s.tileLayer); }
    (s.tiles ??= new Map()).set(key, canvas);
    s.tileLayer.append(canvas);
    if (!this.missingTile(n)) this.pages[n - 1].dataset.res = 'full';
  }

  private dropTiles(s: Shown): void { s.tiles?.forEach((c) => c.remove()); s.tiles?.clear(); }

  private async buildText(n: number): Promise<void> {
    const s = this.shown.get(n); if (!s) return;
    s.text = 'building';
    const el = this.pages[n - 1];
    try {
      const page = await this.doc.getPage(n);
      if (this.shown.get(n) !== s) return;
      el.querySelector('.textLayer')?.remove();
      const textDiv = h('div', { class: 'textLayer' });
      this.sheets[n - 1].appendChild(textDiv);
      const at = this.scale;
      // Our own layer: words in reading order, harakat inside their letters (see src/pdflayer.ts).
      const pending = buildTextLayer(page, page.getViewport({ scale: at }), textDiv);
      s.textCancel = () => void pending.then((l) => l.cancel());
      await pending;
      // (Zoomed meanwhile: this layer is for the old size; the new one is built again.)
      if (this.shown.get(n) !== s || at !== this.scale || s.text !== 'building') { textDiv.remove(); return; }
      textDiv.appendChild(h('div', { class: 'endOfContent' }));
      s.text = 'done';
    } catch { s.text = 'done'; /* text layer is optional */ }
  }

  private releasePage(n: number): void {
    const s = this.shown.get(n);
    if (!s) return;
    if (this.running?.n === n) this.running.cancel();
    s.textCancel?.();
    const el = this.pages[n - 1];
    this.give(s.pic); this.dropTiles(s); s.tileLayer?.remove();
    el.querySelectorAll('.textLayer').forEach((c) => c.remove());
    el.classList.remove('loading'); delete el.dataset.res;
    this.shown.delete(n);
    // (pdf.js lets go of what it kept to draw the page.)
    void this.doc.getPage(n).then((p) => p.cleanup()).catch(() => undefined);
  }

  private rescale(scale: number): void {
    if (Math.abs(scale - this.scale) < 0.001) return;
    const anchorPage = this.current;
    const rel = this.relativeOffset(anchorPage);
    this.scale = scale;
    this.pages.forEach((p, i) => this.sizePage(p, i + 1));
    this.tops = null;
    // Pictures stay (stretched) until redrawn; tiles and text layers belong to the old size.
    for (const [n, s] of this.shown) { this.dropTiles(s); s.tileLayer?.remove(); s.tileLayer = undefined; s.textCancel?.(); s.text = undefined; this.pages[n - 1].dataset.res = 'low'; }
    this.inner.querySelectorAll('.textLayer').forEach((c) => c.remove());
    // (Spare canvases are the old size: of no use again.)
    this.pool.forEach((c) => { c.width = c.height = 0; }); this.pool = [];
    this.running?.cancel();
    this.goTo(anchorPage, rel);
    this.frame();
  }

  private relativeOffset(n: number): number {
    if (!this.pages[n - 1]) return 0;
    return Math.max(0, (this.scroll.scrollTop - this.layoutTops()[n - 1]) / Math.max(1, this.pageHeight(n)));
  }

  /** Pinch and double-tap zoom, as in Drive's viewer: the page scales live under the fingers (the point between
   *  them stays put, and two fingers pan as well), zooming out below the width springs back to it, and on
   *  release the pages are laid out at the new size with nothing jumping — the picture under the fingers is
   *  exactly where it was. A single finger never waits for this code: the blocking listener exists only while
   *  two fingers are down, so scrolling stays smooth. */
  private attachPinch(): void {
    const el = this.scroll;
    let active = false, startDist = 0, startScale = 1, f = 1, dx = 0, dy = 0;
    let fx = 0, fy = 0;        // the focal point, in content coordinates (what stays under the fingers)
    let mx0 = 0, my0 = 0;      // the midpoint between the fingers at the start, in the viewport
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t: TouchList) => { const r = el.getBoundingClientRect(); return [(t[0].clientX + t[1].clientX) / 2 - r.left, (t[0].clientY + t[1].clientY) / 2 - r.top]; };
    const minScale = () => this.computeFitScale();
    const render = () => { this.inner.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${f.toFixed(4)})`; };
    const move = (e: TouchEvent) => {
      if (!active || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const [mx, my] = mid(e.touches);
      let want = (dist(e.touches) / startDist) * startScale;
      // Past the limits the zoom gives way, like a spring: a third of the way, so it is felt but not followed.
      const lo = minScale(), hi = 4;
      if (want < lo) want = lo - (lo - want) * 0.35; if (want > hi) want = hi + (want - hi) * 0.35;
      f = want / startScale; dx = mx - mx0; dy = my - my0;
      render();
    };
    const begin = (e: TouchEvent) => {
      active = true; startDist = dist(e.touches); startScale = this.scale; f = 1; dx = dy = 0;
      [mx0, my0] = mid(e.touches);
      fx = el.scrollLeft + mx0; fy = el.scrollTop + my0;
      this.inner.style.transformOrigin = `${fx}px ${fy}px`;
      this.inner.style.willChange = 'transform';
      el.addEventListener('touchmove', move, { passive: false });
    };
    const finish = () => {
      if (!active) return;
      active = false;
      el.removeEventListener('touchmove', move);
      const target = Math.min(4, Math.max(minScale(), startScale * f));
      this.inner.style.transform = ''; this.inner.style.transformOrigin = ''; this.inner.style.willChange = '';
      this.fitWidth = Math.abs(target - minScale()) < 0.002;
      this.zoomAbout(target, fx, fy, mx0 + dx, my0 + dy);
    };
    el.addEventListener('touchstart', (e) => {
      if (!this.pinchZoom) return;
      if (e.touches.length === 2) begin(e); else if (active) finish();
    }, { passive: true });
    el.addEventListener('touchend', (e) => { if (active && e.touches.length < 2) finish(); }, { passive: true });
    el.addEventListener('touchcancel', () => finish(), { passive: true });
    // Double tap: zoom in on the spot (two and a half times the width), or back to the width when zoomed.
    let lastTap = 0, lastX = 0, lastY = 0;
    el.addEventListener('touchend', (e) => {
      if (!this.pinchZoom || e.touches.length || e.changedTouches.length !== 1 || active) return;
      const t = e.changedTouches[0]; const now = performance.now();
      const quick = now - lastTap < 320 && Math.hypot(t.clientX - lastX, t.clientY - lastY) < 28;
      lastTap = now; lastX = t.clientX; lastY = t.clientY;
      if (!quick) return;
      lastTap = 0;
      if ((e.target as HTMLElement).closest('a, button, .textLayer span, .pdf-pin')) return;
      const r = el.getBoundingClientRect(); const vx = t.clientX - r.left, vy = t.clientY - r.top;
      const fit = minScale();
      const to = this.scale > fit * 1.3 ? fit : Math.min(4, fit * 2.5);
      this.fitWidth = to === fit;
      this.animateZoom(to, el.scrollLeft + vx, el.scrollTop + vy, vx, vy);
    }, { passive: true });
  }

  /** Lay the pages out at `scale` so that the content point (cx, cy) — in the current layout's scrolled
   *  coordinates — ends up at (vx, vy) in the viewport. */
  private zoomAbout(scale: number, cx: number, cy: number, vx: number, vy: number): void {
    const ratio = scale / this.scale;
    if (Math.abs(ratio - 1) < 0.001) { this.frame(); return; }
    // (Pages scale with the zoom but the gaps between them do not: the point is carried through its page.)
    const n = this.pageAt(cy); const top = this.layoutTops()[n - 1];
    const pageEl = this.pages[n - 1];
    const leftOf = () => pageEl.offsetLeft + (pageEl.offsetParent === this.inner ? this.inner.offsetLeft : 0);
    const within = cy - top, withinX = cx - leftOf();
    this.scale = scale;
    this.pages.forEach((p, i) => this.sizePage(p, i + 1));
    this.tops = null;
    for (const [k, s] of this.shown) { this.dropTiles(s); s.tileLayer?.remove(); s.tileLayer = undefined; s.textCancel?.(); s.text = undefined; this.pages[k - 1].dataset.res = 'low'; }
    this.inner.querySelectorAll('.textLayer').forEach((c) => c.remove());
    this.pool.forEach((c) => { c.width = c.height = 0; }); this.pool = [];
    this.running?.cancel();
    const newTop = this.layoutTops()[n - 1] + within * ratio;
    this.scroll.scrollTop = newTop - vy;
    this.scroll.scrollLeft = leftOf() + withinX * ratio - vx;
    this.updateCurrent();
    this.frame();
  }

  /** A short animated zoom (double tap, the zoom buttons): the picture scales with a transition, then the
   *  pages are laid out at the new size with the same point in the same place. */
  private animateZoom(scale: number, cx: number, cy: number, vx: number, vy: number): void {
    const target = Math.min(4, Math.max(0.4, scale));
    const f = target / this.scale;
    if (Math.abs(f - 1) < 0.001) return;
    const inner = this.inner;
    inner.style.transformOrigin = `${cx}px ${cy}px`;
    inner.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1)';
    inner.style.willChange = 'transform';
    requestAnimationFrame(() => { inner.style.transform = `scale(${f.toFixed(4)})`; });
    const done = () => {
      inner.removeEventListener('transitionend', done);
      inner.style.transition = ''; inner.style.transform = ''; inner.style.transformOrigin = ''; inner.style.willChange = '';
      this.zoomAbout(target, cx, cy, vx, vy);
    };
    inner.addEventListener('transitionend', done);
    window.setTimeout(() => { if (inner.style.transition) done(); }, 320);
  }

  /** The page's sheet: the whole page, to draw on (highlights, notes, ink) with fractions of the page. */
  pageElement(n: number): HTMLElement | undefined { return this.sheets[n - 1]; }
  /** The page's sheet for an element inside a page (its window, say), for fractions of the whole page. */
  static sheetOf(el: Element | null): HTMLElement | null { const w = el?.closest<HTMLElement>('.pdf-page'); return w ? (w.querySelector<HTMLElement>(':scope > .pdf-sheet') ?? w) : null; }

  zoom(delta: number): void {
    this.fitWidth = false;
    const vx = this.scroll.clientWidth / 2, vy = this.scroll.clientHeight / 2;
    this.animateZoom(this.scale * (1 + delta), this.scroll.scrollLeft + vx, this.scroll.scrollTop + vy, vx, vy);
  }
  fitToWidth(): void {
    this.fitWidth = true;
    const vx = this.scroll.clientWidth / 2, vy = this.scroll.clientHeight / 2;
    this.animateZoom(this.computeFitScale(), this.scroll.scrollLeft + vx, this.scroll.scrollTop + vy, vx, vy);
  }
  setInvert(v: boolean): void { this.root.dataset.invert = String(v); }

  goTo(page: number, offset = 0): void {
    page = Math.min(this.total, Math.max(1, Math.round(page)));
    if (!this.pages[page - 1]) return;
    this.scroll.scrollTop = this.layoutTops()[page - 1] - 6 + offset * this.pageHeight(page);
    this.current = page;
    this.opts.onPageChange(page, this.total);
    this.onScroll();
  }

  private updateCurrent(): void {
    const n = this.pageAt(this.scroll.scrollTop + this.scroll.clientHeight * 0.4);
    if (n !== this.current) {
      this.current = n;
      this.opts.onPageChange(n, this.total);
    }
  }

  /** Fraction scrolled through the current page (for precise resume). */
  currentOffset(): number { return this.relativeOffset(this.current); }

  async outline(): Promise<TocItem[]> {
    const out: TocItem[] = [];
    const items = await this.doc.getOutline().catch(() => null);
    if (!items) return out;
    const walk = async (list: typeof items, depth: number) => {
      for (const it of list) {
        let page: number | undefined;
        try {
          const dest = typeof it.dest === 'string' ? await this.doc.getDestination(it.dest) : it.dest;
          if (Array.isArray(dest) && dest[0]) page = (typeof dest[0] === 'object' ? await this.doc.getPageIndex(dest[0]) : Number(dest[0])) + 1;
        } catch { /* unresolved */ }
        if (it.title?.trim()) out.push({ label: it.title.trim(), depth, anchor: '', page });
        if (it.items?.length && depth < 4) await walk(it.items, depth + 1);
      }
    };
    await walk(items, 0);
    return out;
  }

  /** Page texts read before (kept on the device by the search across books): page n is texts[n - 1]. */
  seedTexts(texts: string[]): void { if (texts.length !== this.total) return; texts.forEach((x, i) => { if (!this.textCache.has(i + 1)) this.textCache.set(i + 1, x); }); }
  /** Every page's text, once all have been read (to keep for next time); else null. */
  allTexts(): string[] | null { if (this.textCache.size < this.total) return null; return Array.from({ length: this.total }, (_, i) => this.textCache.get(i + 1) ?? ''); }
  private textPending = new Map<number, Promise<string>>();
  private normCache = new Map<number, { text: string; norm: ReturnType<typeof normalizeForSearch> }>();

  async pageText(n: number): Promise<string> {
    if (this.textCache.has(n)) return this.textCache.get(n)!;
    const pending = this.textPending.get(n); if (pending) return pending;
    const job = this.readPageText(n).finally(() => this.textPending.delete(n));
    this.textPending.set(n, job);
    return job;
  }

  private async readPageText(n: number): Promise<string> {
    try {
      const page = await this.doc.getPage(n);
      // In reading order, as the text layer has it: right-to-left lines read right to left, harakat in their
      // letters, vertical columns as paragraphs (pdf.js's own order is the order things were drawn).
      const { pageReadingText } = await import('../pdflayer');
      const text = await pageReadingText(page);
      this.textCache.set(n, text);
      return text;
    } catch { return ''; }
  }

  /** Read every page's text a little at a time while the reader is idle, so a search later starts with all of
   *  it at hand; `done` gets the texts once all are read. Stops when the book is closed. */
  async readAllWhenIdle(done: (texts: string[]) => void): Promise<void> {
    const idle = () => new Promise<void>((r) => { const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback; if (ric) ric(() => r(), { timeout: 1500 }); else setTimeout(r, 60); });
    for (let n = 1; n <= this.total; n++) {
      if (this.destroyed) return;
      if (!this.textCache.has(n)) { await idle(); if (this.destroyed) return; await this.pageText(n); }
    }
    const all = this.allTexts(); if (all && !this.destroyed) done(all);
  }

  /** Search every page; reports progress; returns hits with excerpts. */
  async search(query: string, onProgress?: (done: number, total: number) => void, signal?: { cancelled: boolean }, onHits?: (hits: PdfSearchHit[]) => void): Promise<PdfSearchHit[]> {
    const hits: PdfSearchHit[] = [];
    const q = normalizeForSearch(query.trim()).text;
    if (!q) return hits;
    let shown = 0, lastShow = performance.now();
    for (let n = 1; n <= this.total; n++) {
      if (signal?.cancelled) break;
      // (The next pages are asked of the worker now, so it reads them while this one is searched.)
      for (let k = n + 1; k <= Math.min(this.total, n + 4); k++) if (!this.textCache.has(k)) void this.pageText(k);
      // (Lines run on: a phrase may continue on the next line. Private-use codes — ornaments a font draws — are
      // no text to show.) Each page is prepared for searching once, and kept for the next search.
      let prep = this.normCache.get(n);
      if (!prep) { const text = (await this.pageText(n)).replace(/\s/g, ' ').replace(/[\uE000-\uF8FF]/g, ' '); prep = { text, norm: normalizeForSearch(text) }; this.normCache.set(n, prep); }
      const { text, norm } = prep;
      let idx = norm.text.indexOf(q);
      let count = 0;
      while (idx >= 0 && count < 20) {
        const start = norm.map[idx], end = norm.map[Math.min(norm.map.length - 1, idx + q.length)];
        // The context cut at word boundaries, about eight words each side.
        let a = Math.max(0, start - 60); if (a > 0) { const sp = text.indexOf(' ', a); a = sp >= 0 && sp < start ? sp + 1 : a; }
        let b = Math.min(text.length, end + 60); if (b < text.length) { const sp = text.lastIndexOf(' ', b); b = sp > end ? sp : b; }
        const before = (a > 0 ? '… ' : '') + text.slice(a, start).replace(/\s+/g, ' ').trimStart();
        const after = text.slice(end, b).replace(/\s+/g, ' ').trimEnd() + (b < text.length ? ' …' : '');
        // (Shown without the tatweels that stretch the page's lines.)
        const k = (x: string) => x.replace(/\u0640/g, '');
        hits.push({ page: n, excerpt: k(before + text.slice(start, end) + after), term: k(text.slice(start, end)), before: k(before), after: k(after) });
        count++;
        idx = norm.text.indexOf(q, idx + q.length);
      }
      onProgress?.(n, this.total);
      // Results shown as they are found (every few tenths of a second), not only at the end.
      if (onHits && hits.length > shown && performance.now() - lastShow > 250) { onHits(hits.slice(shown)); shown = hits.length; lastShow = performance.now(); }
      if (n % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (onHits && hits.length > shown && !signal?.cancelled) onHits(hits.slice(shown));
    return hits;
  }

  /** Highlight matches on a page's text layer (after it rendered). */
  async highlightOnPage(n: number, query: string): Promise<void> {
    this.goTo(n);
    const q = normalizeForSearch(query).text;
    const tryMark = (attempt: number) => {
      const layer = this.pages[n - 1]?.querySelector('.textLayer');
      if (!layer || !layer.childElementCount) { if (attempt < 20) setTimeout(() => tryMark(attempt + 1), 150); return; }
      layer.querySelectorAll('.highlight').forEach((e) => e.classList.remove('highlight'));
      let first: Element | null = null;
      // The words of the layer in reading order, joined: a match may run over several word boxes.
      const spans = Array.from(layer.querySelectorAll<HTMLElement>('span'));
      let joined = ''; const at: [number, number, HTMLElement][] = [];
      for (const sp of spans) { const t = normalizeForSearch(sp.textContent ?? '').text.trim(); if (!t) continue; if (joined && !joined.endsWith(' ')) joined += ' '; at.push([joined.length, joined.length + t.length, sp]); joined += t; }
      const qq = q.replace(/\s+/g, ' ').trim();
      for (let i = qq ? joined.indexOf(qq) : -1; i >= 0; i = joined.indexOf(qq, i + qq.length)) {
        for (const [a, b, sp] of at) if (b > i && a < i + qq.length) { sp.classList.add('highlight'); first ??= sp; }
      }
      (first as Element | null)?.scrollIntoView({ block: 'center' });
    };
    tryMark(0);
  }

  /** Render one page to a PNG blob at the given width (for saving / sharing). */
  async pageToBlob(n: number, width = 1600, type: 'image/png' | 'image/jpeg' = 'image/png'): Promise<Blob> {
    const page = await this.doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), type, 0.92));
  }

  /** Small thumbnail (data URL) for the pages grid. */
  async thumbnail(n: number, width = 180): Promise<string> {
    const page = await this.doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.7);
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.settleTimer);
    this.resizeObs?.disconnect();
    for (const n of [...this.shown.keys()]) this.releasePage(n);
    this.pool.forEach((c) => { c.width = c.height = 0; }); this.pool = [];
    this.closeDoc();
    void this.native?.pdfClose().catch(() => undefined);
    this.root.remove();
  }
}

/** Keep only the few most recently opened PDF copies in the cache. */
async function prunePdfCache(fs: unknown, keep: string): Promise<void> {
  const f = fs as { readdir(o: { path: string; directory: string }): Promise<{ files: { name: string; mtime?: number }[] }>; deleteFile(o: { path: string; directory: string }): Promise<void> };
  try {
    const { files } = await f.readdir({ path: 'kr-pdf', directory: 'CACHE' });
    const old = files.filter((x) => x.name !== keep).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).slice(2);
    for (const x of old) await f.deleteFile({ path: `kr-pdf/${x.name}`, directory: 'CACHE' }).catch(() => {});
  } catch { /* nothing cached */ }
}
