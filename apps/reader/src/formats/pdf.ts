// PDF viewing on top of pdf.js: lazily rendered pages with a selectable text
// layer, a page slider, go-to, outline and full-text search.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cmapsUrl } from '../slim';
import { buildTextLayer } from '../pdflayer';
import type { BookMeta, TocItem } from './types';
import { titleFromFileName, normalizeForSearch } from './types';
import { h, askPassword } from '../ui/dom';
import { t } from '../i18n';

import { loadPdfjs, offscreen } from '../pdfjsload';
export { loadPdfjs, offscreen };

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
    cMapUrl: cmapsUrl(RES), cMapPacked: true,
    standardFontDataUrl: `${RES}standard_fonts/`,
    wasmUrl: `${RES}wasm/`,
    iccUrl: `${RES}iccs/`,
  }, { ask: (wrong) => askPassword({ title: t('pdfProtected'), hint: wrong ? t('pdfPasswordWrong') : t('pdfPasswordPrompt'), wrong, label: t('password'), open: t('open'), cancel: t('cancel') }) }).catch((e) => {
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
    const canvas = offscreen(document.createElement('canvas'));
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
  /** Crop the margins: the pages show their printed area (found from small pictures of them), all at one width.
   *  What was found is kept with the book (`get`/`set`: a {@link CropStore}, or anything older, which is ignored). */
  crop?: { enabled(): boolean; get(): Promise<unknown>; set(store: CropStore): Promise<void> };
}
/** A page's ink, as fractions of the page: left, top, width, height. `[0, 0, 0, 0]`: a blank page; `[0, 0, 1, 1]`:
 *  the page is shown whole (its paper could not be told from its ink, or it could not be read). */
export type CropBox = [number, number, number, number];
/** The printed column shared by the ordinary pages, fixed from a sample of them: left and width for odd and for even
 *  pages (facing pages have their margins the other way round), the top and bottom edges (fractions of the page),
 *  and its width in points (the width every ordinary page has on the screen). */
export interface CropShared { odd: [number, number]; even: [number, number]; top: number; bottom: number; ref: number }
/** What is kept with the book. (`v` changes whenever the way ink is found does: boxes found the old way are found again.) */
export interface CropStore { v: number; n: number; boxes: (CropBox | null)[]; shared: CropShared | null }
const CROP_V = 2;
/** Room left around the ink: a fraction of the page's width (the same in points across and down). */
const CROP_PAD = 0.015;

/** Android and iOS: render page bitmaps with the platform renderer (system fonts, JBIG2/JPX, fast). */
interface NativePdf { pdfOpen(o: { path: string }): Promise<{ pageCount: number }>; pdfRender(o: { page: number; width: number; quality?: number; tileX?: number; tileY?: number; tileW?: number; tileH?: number; toFile?: boolean }): Promise<{ data?: string; path?: string; width: number; height: number }>; pdfClose(): Promise<void> }
interface NativeFs { writeFile(o: { path: string; data: string; directory: string; recursive?: boolean }): Promise<{ uri: string }>; stat(o: { path: string; directory: string }): Promise<{ uri: string }> }
function nativePdf(): { pdf: NativePdf; fs: NativeFs } | null {
  const cap = (window as unknown as { Capacitor?: { getPlatform?(): string; Plugins?: { Kurokawa?: NativePdf; Filesystem?: NativeFs } } }).Capacitor;
  const platform = cap?.getPlatform?.();
  if ((platform !== 'android' && platform !== 'ios') || !cap?.Plugins?.Kurokawa || !cap.Plugins.Filesystem) return null;
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

/** The box holding the ink on a picture of the page (fractions of the page), with no room added. Ink is whatever
 *  differs from the page's own paper — the colour of most of its outer ring (white, tinted, a scan's grey, a dark
 *  page) — by more than a faint tint, so light grey text and hairlines count. A blank page gives `[0, 0, 0, 0]`; a
 *  page with no paper to tell (a picture to the edges) gives the whole page. */
export function inkBox(img: ImageData): CropBox {
  const { width: W, height: H, data } = img;
  if (W < 8 || H < 8) return [0, 0, 1, 1];
  // The paper: the middle value of each channel over the outer ring (2% of the page), if most of the ring is near it.
  const bw = Math.max(2, Math.round(W * 0.02)), bh = Math.max(2, Math.round(H * 0.02));
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]; let ring = 0;
  const inRing = (x: number, y: number) => x < bw || x >= W - bw || y < bh || y >= H - bh;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!inRing(x, y)) { x = W - bw - 1; continue; } const i = (y * W + x) * 4; hist[0][data[i]]++; hist[1][data[i + 1]]++; hist[2][data[i + 2]]++; ring++; }
  const mid = (hst: Uint32Array) => { let c = 0; for (let v = 0; v < 256; v++) { c += hst[v]; if (c * 2 >= ring) return v; } return 255; };
  const pr = mid(hist[0]), pg = mid(hist[1]), pb = mid(hist[2]);
  const TOL = 20;
  const ink = (i: number) => Math.abs(data[i] - pr) > TOL || Math.abs(data[i + 1] - pg) > TOL || Math.abs(data[i + 2] - pb) > TOL;
  let paper = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!inRing(x, y)) { x = W - bw - 1; continue; } if (!ink((y * W + x) * 4)) paper++; }
  if (paper < ring * 0.5) return [0, 0, 1, 1];
  // (An ink pixel counts when another touches it: a lone speck of dust does not pull the box out; a hairline either
  // way, a page number or a dot of two pixels does. Counting rows with two ink pixels instead lost the ends of a
  // vertical hairline — one pixel per row.)
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (ink(i * 4)) m[i] = 1;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    let touched = false;
    for (let dy = -1; dy <= 1 && !touched; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if ((dx || dy) && yy >= 0 && yy < H && xx >= 0 && xx < W && m[yy * W + xx]) { touched = true; break; } }
    if (!touched) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0 || y1 < 0) return [0, 0, 0, 0];
  // (One pixel more each side: the faint edge of anti-aliased ink, under the threshold.)
  const l = Math.max(0, x0 - 1) / W, t = Math.max(0, y0 - 1) / H, r = Math.min(W, x1 + 2) / W, b = Math.min(H, y1 + 2) / H;
  const f = (v: number) => Math.round(v * 10000) / 10000;
  return [f(l), f(t), f(r - l), f(b - t)];
}
const isBox = (c: unknown): c is CropBox => Array.isArray(c) && c.length === 4 && c.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);

/** The device's memory in GB as the browser tells it (rounded down; none told: taken as plenty). With 4 or less, less
 *  is kept of pages gone by; with 2 or less, the pages' text is not read ahead. */
const deviceMemory = (): number => (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;

/** What is taken off pages, taken off with them drawn for the moment (content-visibility visible), then laid out once:
 *  elements taken out of a page the browser is skipping — off the screen — were kept by it until the page next came
 *  into view, which a page far back never does: a long book's every word element (its text layers) was kept, about
 *  20 MB of the page's memory for each stretch scrolled through, never given back. */
function takeOff(pages: HTMLElement[], fn: () => void): void {
  for (const el of pages) el.style.contentVisibility = 'visible';
  try { fn(); } finally { if (pages.length) void pages[0].offsetHeight; for (const el of pages) el.style.contentVisibility = ''; }
}

export class PdfViewer {
  private doc!: PDFDocumentProxy;
  private pages: HTMLElement[] = [];      // the windows: sized to what is shown of each page
  private sheets: HTMLElement[] = [];     // the sheets inside them: the whole page, with everything drawn on it
  /* Margin cropping (see "the printed area" below). */
  private crops: (CropBox | null)[] = [];   // each page's ink, once measured
  private cropShownAs: (CropBox | null)[] = [];   // the ink each page's layout was made from (a page near the screen waits)
  private cropShared: CropShared | null = null;
  private cropWanted = false;              // the setting
  private cropOn = false;                  // the layout is cropped (once the shared column is known)
  private shown = new Map<number, Shown>();
  private scale = 1;
  private baseWidths: number[] = [];
  private baseHeights: number[] = [];
  /** Which pages' sizes are their own (read from the file), not page 1's taken for them. */
  private sized = new Uint8Array(0);
  /** The first page's picture is on the screen (the sizes of the others are read after it, not before). */
  private firstPic!: Promise<void>; private firstPicDone: () => void = () => undefined;
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
  /** The scroll's speed (px/ms, signed) and where it was last measured: a fling too fast to draw for is left
   *  alone, and the pages ahead of a slower one are drawn before it reaches them. */
  private speed = 0; private lastTop = 0; private lastAt = 0;
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
    this.sized = new Uint8Array(this.total); if (first) this.sized[0] = 1;
    this.firstPic = new Promise<void>((r) => { this.firstPicDone = r; });
    this.crops = new Array<CropBox | null>(this.total).fill(null); this.cropShownAs = this.crops.slice();
    // (Margins cropped: what was found before is read first, so the pages are laid out cropped from the start.)
    this.cropWanted = !!this.opts.crop?.enabled();
    if (this.cropWanted) { await this.readCrops(); this.cropOn = !!this.cropShared; this.cropShownAs = this.crops.slice(); }
    this.scale = this.computeFitScale(); this.lastFit = this.scale;
    this.pages = []; this.sheets = [];
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= this.total; i++) {
      const sheet = h('div', { class: 'pdf-sheet' });
      const el = h('div', { class: 'pdf-page', dataset: { page: String(i) } }, sheet, h('span', { class: 'pnum' }, String(i)));
      this.pages.push(el); this.sheets.push(sheet);
      this.sizePage(el, i);
      frag.appendChild(el);
    }
    this.inner.appendChild(frag);
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

  /** Page sizes read from the file, correcting page 1's taken for them. Not every page at open — a thousand-page
   *  book asked pdf.js for a thousand pages, ahead of the page being drawn: the first pages and a sample spread
   *  through the book, after the first picture is up; when they all have page 1's size (most books), the rest are
   *  read as they are met (drawn, measured for cropping, made into thumbnails); else all of them, as before. */
  private async measurePages(): Promise<void> {
    await Promise.race([this.firstPic, new Promise((r) => setTimeout(r, 1500))]);
    const N = this.total; if (N <= 1 || this.destroyed) return;
    const sample = new Set<number>();
    for (let i = 2; i <= Math.min(N, 8); i++) sample.add(i);
    if (N > 8) for (let k = 0; k < 24; k++) sample.add(Math.min(N, 9 + Math.round(((k + 0.5) * (N - 9)) / 24)));
    let uniform = true;
    for (const i of sample) {
      const page = await this.doc.getPage(i).catch(() => null);
      if (this.destroyed) return;
      if (page && this.noteSize(i, page, true)) uniform = false;
    }
    this.applySizes();
    if (uniform) return;
    for (let i = 2; i <= N; i++) {
      if (this.destroyed) return;
      if (this.sized[i - 1]) continue;
      const page = await this.doc.getPage(i).catch(() => null);
      if (this.destroyed || !page) continue;
      this.noteSize(i, page, true);
      if (i % 40 === 0 || i === N) { this.applySizes(); await new Promise((r) => setTimeout(r, 0)); }
    }
    this.applySizes();
  }
  /** Page `n`'s own size, from pdf.js's page: true when it differs from what it was laid out with. Applied at once,
   *  or with the others waiting (`later`) by applySizes. */
  private sizesWaiting: number[] = [];
  private noteSize(n: number, page: PDFPageProxy, later = false): boolean {
    if (this.sized[n - 1]) return false;
    this.sized[n - 1] = 1;
    const vp = page.getViewport({ scale: 1 });
    if (Math.abs(vp.width - this.baseWidths[n - 1]) < 0.5 && Math.abs(vp.height - this.baseHeights[n - 1]) < 0.5) return false;
    this.baseWidths[n - 1] = vp.width; this.baseHeights[n - 1] = vp.height; this.sizesWaiting.push(n);
    if (!later) this.applySizes();
    return true;
  }
  /** Page `n`'s own size known (read from the file when it is not yet). */
  private async ensureSize(n: number): Promise<void> {
    if (this.sized[n - 1]) return;
    const page = await this.doc.getPage(n).catch(() => null);
    if (page && !this.destroyed) this.noteSize(n, page);
  }
  private applySizes(): void {
    const changed = this.sizesWaiting; if (!changed.length || this.destroyed) return;
    this.sizesWaiting = [];
    // Keep what the reader is looking at where it is when earlier pages change size (worked out from the sizes,
    // not by asking the page for its height — that would lay the whole book out again each time).
    let shift = 0;
    for (const i of changed) {
      const el = this.pages[i - 1]; const before = parseFloat(el.style.height) || 0;
      this.sizePage(el, i);
      if (i < this.current) shift += (parseFloat(el.style.height) || 0) - before;
      const s = this.shown.get(i); if (s) { s.level = Math.min(s.level, 1) as 0 | 1; this.dropTiles(s); }
    }
    this.tops = null;
    if (shift) this.scroll.scrollTop += shift;
    this.pump();
  }

  /** The part of page `n` that is shown, in page points, and `k`: how much the page is shrunk so that it is no wider
   *  on the screen than the ordinary pages (a picture to the edges, a wide table) — 1 for every ordinary page. */
  private shownBox(n: number, ink: CropBox | null | undefined = this.cropShownAs[n - 1]): { x: number; y: number; w: number; h: number; k: number } {
    const W = this.baseWidths[n - 1], H = this.baseHeights[n - 1];
    const sh = this.cropOn ? this.cropShared : null;
    if (!sh) return { x: 0, y: 0, w: W, h: H, k: 1 };
    // Every page takes the shared column; one whose ink reaches out of it is widened to take its ink in, never cut. A
    // page not measured yet takes the shared column (what most pages turn out to have: measuring them moves nothing).
    const col = n % 2 ? sh.odd : sh.even, py = (CROP_PAD * W) / H;
    let l = col[0], r = col[0] + col[1], t = sh.top, b = sh.bottom;
    if (ink && ink[2] > 0 && ink[3] > 0) { l = Math.min(l, ink[0] - CROP_PAD); r = Math.max(r, ink[0] + ink[2] + CROP_PAD); t = Math.min(t, ink[1] - py); b = Math.max(b, ink[1] + ink[3] + py); }
    l = Math.max(0, l); t = Math.max(0, t); r = Math.min(1, r); b = Math.min(1, b);
    const w = (r - l) * W;
    return { x: l * W, y: t * H, w, h: (b - t) * H, k: Math.min(1, sh.ref / w) };
  }
  private computeFitScale(): number {
    const avail = Math.max(280, this.scroll.clientWidth - 24);
    // (Margins cropped: the ordinary page's width. The odd wide page is shrunk to it, not all the others.)
    if (this.cropOn && this.cropShared) return Math.min(avail / this.cropShared.ref, 3);
    const widths = this.baseWidths.slice(0, 5);
    return Math.min(avail / Math.max(...widths), 3);
  }

  private sizePage(el: HTMLElement, n: number): void {
    const box = this.shownBox(n), k = box.k;
    const w = box.w * this.scale * k, hgt = box.h * this.scale * k;
    el.style.width = `${Math.floor(w)}px`;
    el.style.height = `${Math.floor(hgt)}px`;
    el.style.setProperty('--total-scale-factor', String(this.scale));
    el.style.setProperty('--scale-factor', String(this.scale));
    const sheet = this.sheets[n - 1];
    if (sheet) {
      sheet.style.width = `${Math.floor(this.baseWidths[n - 1] * this.scale)}px`; sheet.style.height = `${Math.floor(this.baseHeights[n - 1] * this.scale)}px`;
      sheet.style.left = `${-Math.round(box.x * this.scale * k)}px`; sheet.style.top = `${-Math.round(box.y * this.scale * k)}px`;
      // (A page shrunk to the ordinary width: its sheet — picture, tiles, text, notes — is scaled as one.)
      sheet.style.transform = k < 0.999 ? `scale(${k.toFixed(4)})` : ''; sheet.style.transformOrigin = k < 0.999 ? '0 0' : '';
    }
  }

  /* ---------- the printed area of each page (margins cropped) ----------
   * Bounded and quiet, so that a book of a thousand pages costs no more than the pages being read:
   *  - The shared column comes from a sample — about thirty pages spread through the book and the few around the
   *    reader — measured one at a time; then the layout changes once. It never moves again while the book is open.
   *  - Each other page is measured only when near the screen (ahead in the scroll's direction first), one at a time,
   *    only while nothing else is to be drawn and the page is still (not scrolling, pinching or zooming).
   *  - Measuring a page changes nothing for an ordinary page (it already has the shared column). A page whose ink
   *    reaches out of the column grows to take it in, when it is away from the screen — the pages above it shift the
   *    scroll by as much, so nothing seen moves — or at once if it is on the screen with ink cut off.
   *  - The vertical crop is shared too (one top and bottom for all ordinary pages): cropping each page to its own
   *    height made every page measured late change height, and everything below it move.
   *  - What is found is saved with the book as it goes (every few seconds), and read back the next time. */

  /** Read what was found before (kept with the book), if it was found the current way and is for this book. */
  private async readCrops(): Promise<void> {
    const st = (await this.opts.crop?.get().catch(() => null)) as Partial<CropStore> | null;
    if (!st || typeof st !== 'object' || st.v !== CROP_V || st.n !== this.total || !Array.isArray(st.boxes)) return;
    st.boxes.slice(0, this.total).forEach((c, i) => { if (isBox(c)) this.crops[i] = c; });
    const sh = st.shared;
    if (sh && [sh.top, sh.bottom, sh.ref, ...(sh.odd ?? []), ...(sh.even ?? [])].every((v) => typeof v === 'number' && Number.isFinite(v)) && sh.odd?.length === 2 && sh.even?.length === 2 && sh.bottom > sh.top && sh.ref > 0) this.cropShared = sh;
  }
  private cropDirty = false; private cropSaveTimer = 0;
  private saveCrops(soon = true): void {
    if (!this.cropDirty || !this.opts.crop) return;
    window.clearTimeout(this.cropSaveTimer);
    const go = () => { this.cropSaveTimer = 0; if (!this.cropDirty) return; this.cropDirty = false; void this.opts.crop!.set({ v: CROP_V, n: this.total, boxes: this.crops.slice(), shared: this.cropShared }).catch(() => { this.cropDirty = true; }); };
    if (soon) this.cropSaveTimer = window.setTimeout(go, 4000); else go();
  }

  /** Turn margin cropping on or off: one new layout, the line being read staying where it is on the screen. (On for the
   *  first time, the layout changes once the sample has been measured.) */
  setCrop(on: boolean): void {
    if (on === this.cropWanted) return;
    this.cropWanted = on;
    if (!on) this.saveCrops(false);
    if (on && !this.cropShared) { this.pumpCrops(); return; }
    this.cropLayout(on);
  }
  /** Every page laid out again, cropped or not (the line at 40% of the screen kept there). */
  private cropLayout(on: boolean): void {
    const a = this.anchor();
    this.cropOn = on; if (on) this.cropShownAs = this.crops.slice();
    const fit = this.computeFitScale();
    if (this.fitWidth && Math.abs(fit - this.scale) >= 0.001) { this.scale = fit; this.dropForScale(); }
    this.lastFit = fit;
    this.pages.forEach((p, i) => this.sizePage(p, i + 1)); this.tops = null;
    this.restore(a); this.frame();
  }

  /** The pages to measure for the shared column: a spread through the book, the ones around the reader first. */
  private cropSample: number[] | null = null;
  private sample(): number[] {
    const N = this.total, out = new Set<number>();
    for (let d = -2; d <= 5; d++) { const n = this.current + d; if (n >= 1 && n <= N) out.add(n); }
    if (N <= 40) { for (let n = 1; n <= N; n++) out.add(n); return [...out]; }
    const k = 28; for (let i = 0; i < k; i++) out.add(1 + Math.round(((i + 0.5) * (N - 1)) / k));
    return [...out];
  }
  /** The next page to measure, or null (nothing near the screen is left: the finder rests until the reader moves). */
  private cropNext(): number | null {
    if (!this.cropShared) { this.cropSample ??= this.sample(); return this.cropSample.find((n) => !this.crops[n - 1]) ?? null; }
    const first = this.first, last = this.last, down = this.speed >= 0;
    const want: number[] = [];
    for (let n = first; n <= last; n++) want.push(n);
    const ahead = (from: number, step: number, count: number) => { for (let i = 0; i < count; i++) want.push(from + i * step); };
    if (down) { ahead(last + 1, 1, 10); ahead(first - 1, -1, 4); } else { ahead(first - 1, -1, 10); ahead(last + 1, 1, 4); }
    return want.find((n) => n >= 1 && n <= this.total && !this.crops[n - 1]) ?? null;
  }
  private cropBusy = false;
  private cropCanvas: HTMLCanvasElement | null = null;
  /** Measure the next page, when nothing else is to be done. */
  private pumpCrops(): void {
    if (this.cropBusy || this.destroyed || !this.cropWanted || !this.doc || !this.pages.length) return;
    if (this.busy || this.scrolling || this.pinching || this.zoomAnim || this.thumbBusy || this.thumbQueue.length) return;
    const n = this.cropNext();
    if (n === null) { this.saveCrops(); return; }
    this.cropBusy = true;
    void (async () => {
      let box: CropBox;
      try { box = await this.measure(n); } catch { box = [0, 0, 1, 1]; }
      this.cropBusy = false;
      if (this.destroyed) return;
      this.crops[n - 1] = box; this.cropDirty = true;
      this.measured(n);
      // (Given back to the browser in between: the next page waits for an idle moment.)
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric(() => this.pumpCrops(), { timeout: 300 }); else window.setTimeout(() => this.pumpCrops(), 30);
    })();
  }
  /** A small picture of page `n` (about 320 px across: a small page number still shows), its ink found. One canvas is
   *  used over and over; pdf.js lets go of the page after (unless it is on the screen). */
  private async measure(n: number): Promise<CropBox> {
    const c = (this.cropCanvas ??= offscreen(document.createElement('canvas')));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const fitIn = (w: number, hh: number) => { const k = Math.min(320 / w, 480 / hh); c.width = Math.max(16, Math.round(w * k)); c.height = Math.max(16, Math.round(hh * k)); };
    let ok = false;
    if (this.native) { await this.ensureSize(n); fitIn(this.baseWidths[n - 1], this.baseHeights[n - 1]); ok = await this.nativeDraw(n, c, { width: c.width }).catch(() => false); }
    if (!ok) {
      const page = await this.doc.getPage(n);
      this.noteSize(n, page);
      try {
        const vp1 = page.getViewport({ scale: 1 }); fitIn(vp1.width, vp1.height);
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvas: c, canvasContext: ctx, viewport: page.getViewport({ scale: c.width / vp1.width }) }).promise;
      } finally { if (!this.shown.has(n)) page.cleanup(); }
    }
    const box = inkBox(ctx.getImageData(0, 0, c.width, c.height));
    // (Implausible — a box that is not inside the page — and the page is shown whole.)
    return box[0] + box[2] <= 1.0001 && box[1] + box[3] <= 1.0001 ? box : [0, 0, 1, 1];
  }
  /** Page `n` was measured: the shared column once the sample is in; else the page's own layout, if it changes. */
  private measured(n: number): void {
    if (!this.cropShared) {
      if (this.cropSample?.some((m) => !this.crops[m - 1])) return;
      this.cropShared = this.sharedColumn(); this.cropSample = null; this.saveCrops(false);
      if (this.cropWanted) this.cropLayout(true);
      return;
    }
    if (!this.cropOn) return;
    const was = this.shownBox(n), now = this.shownBox(n, this.crops[n - 1]);
    if (Math.abs(was.x - now.x) + Math.abs(was.y - now.y) + Math.abs(was.w - now.w) + Math.abs(was.h - now.h) < 0.5) { this.cropShownAs[n - 1] = this.crops[n - 1]; return; }
    this.cropWaiting.add(n); this.applyWaiting();
  }
  /** Page `n` as laid out now cuts off some of its measured ink. */
  private cuts(n: number): boolean {
    const ink = this.crops[n - 1], b = this.shownBox(n), W = this.baseWidths[n - 1], H = this.baseHeights[n - 1];
    return !!ink && ink[2] > 0 && (ink[0] * W < b.x - 0.5 || ink[1] * H < b.y - 0.5 || (ink[0] + ink[2]) * W > b.x + b.w + 0.5 || (ink[1] + ink[3]) * H > b.y + b.h + 0.5);
  }
  /** Pages whose new layout waits until they are away from the screen (and, above it, until the scroll is still). */
  private cropWaiting = new Set<number>();
  private applyWaiting(): void {
    if (!this.cropWaiting.size || !this.cropOn) return;
    let shift = 0;
    for (const n of [...this.cropWaiting]) {
      // Near the screen it waits — unless ink is cut off (a page gone to before it was measured): nothing may be cut,
      // so it is laid out as soon as the page is still, the line being read kept where it is.
      if (n >= this.first - 2 && n <= this.last + 2) { if (!this.scrolling && this.cuts(n)) { this.cropWaiting.delete(n); const a = this.anchor(); this.reshape(n); this.restore(a); shift = 0; } continue; }
      if (n < this.first && this.scrolling) continue;   // (moving the scroll would stop a fling)
      this.cropWaiting.delete(n);
      const before = this.pageHeight(n); this.reshape(n);
      if (n < this.first) shift += this.pageHeight(n) - before;
    }
    if (shift) this.scroll.scrollTop += shift;
  }
  /** Page `n` laid out from its measured ink (its tiles and text stay: they are drawn on the sheet, which keeps its size). */
  private reshape(n: number): void { this.cropShownAs[n - 1] = this.crops[n - 1]; this.sizePage(this.pages[n - 1], n); this.tops = null; }
  /**
   * The shared column from the pages measured: the typical edges (the median), pushed out to take in every page
   * whose edges sit near them, with room around. Odd and even pages get columns of their own when their margins
   * differ (facing pages), of one width. Pages reaching much further out (a decorated title page, a picture to
   * the edge) are not counted: each of them grows to take its own ink in. With too few ordinary pages to tell, the
   * whole page.
   */
  private sharedColumn(): CropShared {
    const known: [number, CropBox][] = [];
    this.crops.forEach((c, i) => { if (c && c[2] >= 0.2 && c[3] >= 0.1 && !(c[2] >= 0.999 && c[3] >= 0.999)) known.push([i + 1, c]); });
    const ws = this.baseWidths.slice().sort((a, b) => a - b), Wm = ws[ws.length >> 1] || 612;
    if (known.length < 3) return { odd: [0, 1], even: [0, 1], top: 0, bottom: 1, ref: Wm };
    const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const TOL = 0.06;
    const edges = (list: CropBox[], lo: (c: CropBox) => number, hi: (c: CropBox) => number): [number, number] => {
      const m0 = median(list.map(lo)), m1 = median(list.map(hi)); let a = m0, b = m1;
      for (const c of list) { if (lo(c) >= m0 - TOL) a = Math.min(a, lo(c)); if (hi(c) <= m1 + TOL) b = Math.max(b, hi(c)); }
      return [a, b];
    };
    const across = (list: CropBox[]) => edges(list, (c) => c[0], (c) => c[0] + c[2]);
    const all = known.map(([, c]) => c), odd = known.filter(([n]) => n % 2).map(([, c]) => c), even = known.filter(([n]) => !(n % 2)).map(([, c]) => c);
    let co = across(all), ce = co;
    if (odd.length >= 3 && even.length >= 3) { const a = across(odd), b = across(even); if (Math.abs(a[0] - b[0]) > 0.015 || Math.abs(a[1] - b[1]) > 0.015) { co = a; ce = b; } }
    const [top, bottom] = edges(all, (c) => c[1], (c) => c[1] + c[3]);
    // One width for both, with room around; widened about its middle, kept on the page.
    const width = Math.min(1, Math.max(co[1] - co[0], ce[1] - ce[0]) + 2 * CROP_PAD);
    const place = (c: [number, number]): [number, number] => { const l = Math.min(1 - width, Math.max(0, (c[0] + c[1]) / 2 - width / 2)); return [+l.toFixed(4), +width.toFixed(4)]; };
    const hm = this.baseHeights.slice().sort((a, b) => a - b)[this.baseHeights.length >> 1] || 792, py = (CROP_PAD * Wm) / hm;
    return { odd: place(co), even: place(ce), top: +Math.max(0, top - py).toFixed(4), bottom: +Math.min(1, bottom + py).toFixed(4), ref: width * Wm };
  }

  /** Where the reader is: the page at 40% of the screen and the point of its sheet there (whole-page fractions, the
   *  same whether cropped or not). */
  private anchor(): { n: number; f: number; vy: number } {
    const vy = this.scroll.clientHeight * 0.4, y = this.scroll.scrollTop + vy;
    const n = this.pageAt(y), b = this.shownBox(n), top = this.layoutTops()[n - 1];
    return { n, vy, f: ((y - top) / (this.scale * b.k) + b.y) / this.baseHeights[n - 1] };
  }
  private restore(a: { n: number; f: number; vy: number }): void {
    const b = this.shownBox(a.n);
    this.scroll.scrollTop = this.layoutTops()[a.n - 1] + (a.f * this.baseHeights[a.n - 1] - b.y) * this.scale * b.k - a.vy;
    this.updateCurrent();
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
  private pageHeight(n: number): number { const b = this.shownBox(n); return Math.floor(b.h * this.scale * b.k); }

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
    const now = performance.now();
    if (now - this.lastAt < 400 && now > this.lastAt) this.speed = (top - this.lastTop) / (now - this.lastAt); else if (now - this.lastAt >= 400) this.speed = 0;
    this.lastTop = top; this.lastAt = now;
    this.first = this.pageAt(top);
    this.last = Math.max(this.first, this.pageAt(top + hgt));
    this.updateCurrent();
    // A drawing for a page that has gone well out of view is dropped.
    if (this.running && (this.running.n < this.first - 3 || this.running.n > this.last + 3)) { this.running.cancel(); }
    for (let n = Math.max(1, this.first - 1); n <= Math.min(this.total, this.last + 1); n++) this.pages[n - 1].classList.toggle('loading', !this.shown.get(n)?.pic);
    this.pump();
  }

  /** Scrolling has stopped: pages far from view let go of their pictures, and the ones in view are made sharp. */
  private settle(): void {
    this.scrolling = false; this.speed = 0;
    if (this.destroyed) return;
    this.frame();
    for (const n of [...this.shown.keys()]) if (n < this.first - 3 || n > this.last + 3) this.releasePage(n);
    this.applyWaiting();
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
    // The pages either side — the two ahead first when the scroll has a direction, then the one behind.
    const down = this.speed >= 0;
    const near = (down ? [last + 1, last + 2, first - 1] : [first - 1, first - 2, last + 1]).filter((n) => n >= 1 && n <= this.total);
    const st = (n: number) => this.shown.get(n);
    const stale = (n: number) => { const s = st(n); return !s?.pic || s.at !== this.scale; };
    // A fling faster than a screen every 150 ms outruns any drawing: what is drawn now is gone before it shows.
    // Nothing is drawn until it slows (the frame after each scroll event asks again).
    if (this.scrolling && Math.abs(this.speed) > this.scroll.clientHeight / 150) return null;
    // 1. A page in view with nothing on it: quickly while scrolling, sharp when still.
    for (const n of vis) if (!st(n)?.pic) return () => this.draw(n, this.scrolling ? 1 : 2);
    // 2. While scrolling, the pages ahead get their quick picture too; nothing more until it stops.
    if (this.scrolling) { for (const n of near) if (!st(n)?.pic) return () => this.draw(n, 1); return null; }
    // 3. Pages in view made sharp (or redrawn at a new zoom), then their tiles when zoomed in.
    for (const n of vis) { const s = st(n)!; if (s.level < 2 || s.at !== this.scale) return () => this.draw(n, 2); }
    for (const n of vis) { const t = this.missingTile(n); if (t) return () => this.drawTile(n, t); }
    // 4. The pages either side, sharp; the two beyond them with a quick picture, so a scroll finds them drawn.
    for (const n of near.slice(0, 2)) if (stale(n) || st(n)!.level < 2) return () => this.draw(n, 2);
    for (const n of near.slice(2)) if (stale(n)) return () => this.draw(n, 1);
    for (const n of [last + 3, first - 2]) if (n >= 1 && n <= this.total && !st(n)?.pic) return () => this.draw(n, 1);
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
      } finally { this.busy = false; this.pumpThumbs(); this.pumpCrops(); this.cleanDoc(); }
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
    if (this.pool.length < (deviceMemory() <= 4 ? 3 : 6)) this.pool.push(c); else { c.width = c.height = 0; }
  }

  /** A whole page's picture at `level`; the old one stays until the new one is ready. */
  private async draw(n: number, level: 1 | 2): Promise<void> {
    const el = this.pages[n - 1];
    let s = this.shown.get(n);
    if (!s) { s = { level: 0, at: 0 }; this.shown.set(n, s); }
    const scale = this.scale;
    let page: PDFPageProxy;
    try { page = await this.doc.getPage(n); } catch { s.level = level; s.at = scale; return; }
    if (this.destroyed || this.shown.get(n) !== s) return;
    this.noteSize(n, page);
    const { px } = this.sizeFor(n, level);
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
    this.firstPicDone();
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
    // (Screen positions to the sheet's device pixels: the window's offset into the sheet, and the shrink of a page
    // narrowed to the ordinary width.)
    const box = this.shownBox(n), k = box.k; const ox = box.x * this.scale * d, oy = box.y * this.scale * d;
    const x0 = ((this.scroll.scrollLeft - left) / k) * d - TILE / 2 + ox, x1 = ((this.scroll.scrollLeft + this.scroll.clientWidth - left) / k) * d + TILE / 2 + ox;
    const y0 = ((this.scroll.scrollTop - top) / k) * d - TILE / 2 + oy, y1 = ((this.scroll.scrollTop + this.scroll.clientHeight - top) / k) * d + TILE / 2 + oy;
    const c0 = Math.max(0, Math.floor(x0 / TILE)), c1 = Math.min(g.cols - 1, Math.floor(x1 / TILE));
    const r0 = Math.max(0, Math.floor(y0 / TILE)), r1 = Math.min(g.rows - 1, Math.floor(y1 / TILE));
    // (Middle of the screen first.)
    const cy = (((this.scroll.scrollTop + this.scroll.clientHeight / 2 - top) / k) * d + oy) / TILE, cx = (((this.scroll.scrollLeft + this.scroll.clientWidth / 2 - left) / k) * d + ox) / TILE;
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
    // (A page far off the screen is skipped by the browser: what is taken off it is taken off as takeOff says.)
    const off = () => { this.give(s.pic); this.dropTiles(s); s.tileLayer?.remove(); el.querySelectorAll('.textLayer').forEach((c) => c.remove()); };
    if (this.destroyed) off(); else takeOff([el], off);
    el.classList.remove('loading'); delete el.dataset.res;
    this.shown.delete(n); this.released++;
    // (pdf.js lets go of what it kept to draw the page.)
    void this.doc.getPage(n).then((p) => p.cleanup()).catch(() => undefined);
  }

  /** Pages let go of since pdf.js was last asked to clean up. */
  private released = 0;
  /** After a good many pages let go of (a long scroll, far jumps), pdf.js lets go of what it keeps for the whole book —
   *  its worker's fonts, shared pictures and page dictionaries — when nothing is being drawn or read: a long reading
   *  keeps a ceiling, lower on a device with little memory. The pictures on the screen stay as they are. */
  private cleanDoc(): void {
    if (this.released < (deviceMemory() <= 4 ? 24 : 64)) return;
    if (this.destroyed || this.busy || this.running || this.thumbBusy || this.cropBusy || this.textPending.size || !this.doc) return;
    this.released = 0;
    void this.doc.cleanup().catch(() => undefined);
  }

  private rescale(scale: number): void {
    if (Math.abs(scale - this.scale) < 0.001) return;
    const anchorPage = this.current;
    const rel = this.relativeOffset(anchorPage);
    this.scale = scale;
    this.pages.forEach((p, i) => this.sizePage(p, i + 1));
    this.tops = null;
    this.dropForScale();
    this.goTo(anchorPage, rel);
    this.frame();
  }

  /** The zoom changed: pictures stay (stretched) until redrawn; tiles and text layers belong to the old size. */
  private dropForScale(): void {
    takeOff([...this.shown.keys()].map((n) => this.pages[n - 1]), () => {
      for (const [n, s] of this.shown) { this.dropTiles(s); s.tileLayer?.remove(); s.tileLayer = undefined; s.textCancel?.(); s.text = undefined; this.pages[n - 1].dataset.res = 'low'; }
      this.inner.querySelectorAll('.textLayer').forEach((c) => c.remove());
    });
    // (Spare canvases are the old size: of no use again.)
    this.pool.forEach((c) => { c.width = c.height = 0; }); this.pool = [];
    this.running?.cancel();
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
    // (The viewport's place and the fit width are read once when the pinch starts: reading them on every move made
    // the browser recompute styles and layout each time, with the transform just written.)
    let rect = { left: 0, top: 0 }, lo = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t: TouchList) => [(t[0].clientX + t[1].clientX) / 2 - rect.left, (t[0].clientY + t[1].clientY) / 2 - rect.top];
    const minScale = () => this.computeFitScale();
    // (Shrunk below its size, the picture shrinks the scrolled area too, and the browser pulls the scroll back inside
    // it — the picture slid 40 px off the fingers. The scroll's own moves are added back, so the picture holds.)
    let sl0 = 0, st0 = 0;
    const render = () => { this.inner.style.transform = `translate(${(dx + el.scrollLeft - sl0).toFixed(1)}px, ${(dy + el.scrollTop - st0).toFixed(1)}px) scale(${f.toFixed(4)})`; };
    const onScrollWhile = () => { if (active) render(); };
    // A touch's events go to the element it began on, and bubble from there: when that element leaves the page
    // mid-pinch — a text layer dropped by the zoom animation the pinch ended, or rebuilt — they no longer reach the
    // scroll, and the pinch hung there, stretched, its zoom lost. So while two fingers are down the fingers' own
    // elements are listened to as well (each event handled once).
    let targets: EventTarget[] = []; const seen = new WeakSet<Event>();
    const once = (e: Event) => { if (seen.has(e)) return false; seen.add(e); return true; };
    const onEnd = (e: TouchEvent) => { if (once(e) && active && e.touches.length < 2) finish(); };
    const onCancel = (e: Event) => { if (once(e)) finish(); };
    const listen = (on: boolean) => { for (const t of targets) { const f = on ? t.addEventListener.bind(t) : t.removeEventListener.bind(t); f('touchmove', move as EventListener, { passive: false } as AddEventListenerOptions); f('touchend', onEnd as EventListener); f('touchcancel', onCancel); } };
    const move = (e: TouchEvent) => {
      if (!once(e) || !active || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const [mx, my] = mid(e.touches);
      let want = (dist(e.touches) / startDist) * startScale;
      // Past the limits the zoom gives way, like a spring: a third of the way, so it is felt but not followed.
      const hi = 4;
      if (want < lo) want = lo - (lo - want) * 0.35; if (want > hi) want = hi + (want - hi) * 0.35;
      f = want / startScale; dx = mx - mx0; dy = my - my0;
      render();
    };
    const begin = (e: TouchEvent) => {
      this.settleZoom(); active = true; this.pinching = true; startDist = dist(e.touches); startScale = this.scale; f = 1; dx = dy = 0;
      rect = el.getBoundingClientRect(); lo = minScale();
      // (A page still gliding from a fling is stopped where it is: the point under the fingers is taken from here.)
      el.scrollTo({ left: el.scrollLeft, top: el.scrollTop, behavior: 'instant' as ScrollBehavior });
      [mx0, my0] = mid(e.touches);
      fx = el.scrollLeft + mx0; fy = el.scrollTop + my0; sl0 = el.scrollLeft; st0 = el.scrollTop;
      el.addEventListener('scroll', onScrollWhile, { passive: true });
      // (The origin is in the inner box's own coordinates: it starts below the scroll's top padding. Taken as the
      // scrolled coordinates, the picture slid off the fingers by the padding times the zoom — 18 px at 2.5 times —
      // and jumped back when laid out.)
      this.inner.style.transformOrigin = `${fx - this.inner.offsetLeft}px ${fy - this.inner.offsetTop}px`;
      this.inner.style.willChange = 'transform';
      targets = [el, ...new Set(Array.from(e.touches, (t) => t.target).filter((t) => t !== el))]; listen(true);
    };
    const finish = () => {
      if (!active) return;
      active = false; this.pinching = false;
      listen(false); targets = []; el.removeEventListener('scroll', onScrollWhile);
      const shown = startScale * f, target = Math.min(4, Math.max(lo, shown));
      this.inner.style.transform = ''; this.inner.style.transformOrigin = ''; this.inner.style.willChange = '';
      this.fitWidth = Math.abs(target - lo) < 0.002;
      const vx = mx0 + dx, vy = my0 + dy;
      const at = this.zoomAbout(target, fx, fy, vx, vy);
      // Where the layout could not put the point under the fingers — the zoom sprang back to the width or to the most,
      // a page narrower than the screen is centred, the scroll stops at an end — the picture glides there from where
      // the fingers left it, instead of jumping (40 px across and a size snap, letting go below the width).
      this.glideFrom(at, vx, vy, shown / target);
    };
    el.addEventListener('touchstart', (e) => {
      if (!this.pinchZoom) return;
      if (e.touches.length === 2) begin(e); else if (active) finish();
    }, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onCancel, { passive: true });
    // Double tap: zoom in on the spot (two and a half times the width), or back to the width when zoomed.
    // (Only taps count: a finger that barely moved, briefly, on a page that was not moving — two quick flicks of a fast
    // scroll end at much the same spot, and were taken for a double tap: the page zoomed in mid-scroll.)
    let lastTap = 0, lastX = 0, lastY = 0; let downX = 0, downY = 0, downAt = 0, downTop = 0, downLeft = 0; let scrolledAt = 0;
    // (The zoom's own move of the scroll is not the page moving: a double tap just after a pinch lost its first tap.)
    let seenTop = 0, seenLeft = 0; el.addEventListener('scroll', () => { if ((Math.abs(el.scrollTop - seenTop) > 2 || Math.abs(el.scrollLeft - seenLeft) > 2) && performance.now() - this.laidOutAt > 100) scrolledAt = performance.now(); seenTop = el.scrollTop; seenLeft = el.scrollLeft; }, { passive: true });
    el.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) { downAt = 0; return; } const t = e.touches[0]; downX = t.clientX; downY = t.clientY; downAt = performance.now(); downTop = el.scrollTop; downLeft = el.scrollLeft; if (downAt - lastTap > 320 && downAt - scrolledAt < 120) downAt = 0; /* (a touch that stops a moving page is not a tap; the second of a pair is judged by itself — the first tap may show the bars and nudge the page) */ }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (!this.pinchZoom || e.touches.length || e.changedTouches.length !== 1 || active) return;
      const t = e.changedTouches[0]; const now = performance.now();
      const tap = downAt > 0 && now - downAt < 300 && Math.hypot(t.clientX - downX, t.clientY - downY) < 12 && Math.abs(el.scrollTop - downTop) < 4 && Math.abs(el.scrollLeft - downLeft) < 4;
      if (!tap) { lastTap = 0; return; }
      const quick = now - lastTap < 320 && Math.hypot(t.clientX - lastX, t.clientY - lastY) < 28;
      lastTap = now; lastX = t.clientX; lastY = t.clientY;
      if (!quick) return;
      lastTap = 0;
      if ((e.target as HTMLElement).closest('a, button, .textLayer span, .pdf-pin')) return;
      const r = el.getBoundingClientRect(); const vx = t.clientX - r.left, vy = t.clientY - r.top;
      this.settleZoom(); const fit = minScale();
      const to = this.scale > fit * 1.3 ? fit : Math.min(4, fit * 2.5);
      this.fitWidth = to === fit;
      this.animateZoom(to, vx, vy);
    }, { passive: true });
  }

  /** Lay the pages out at `scale` so that the content point (cx, cy) — in the current layout's scrolled
   *  coordinates — ends up at (vx, vy) in the viewport. */
  private zoomAbout(scale: number, cx: number, cy: number, vx: number, vy: number): [number, number] {
    const ratio = scale / this.scale;
    // (The same size — two fingers that only panned: the page is moved there all the same. It sprang back by the
    // whole pan before: 94 px for a 50 × 80 px pan.)
    if (Math.abs(ratio - 1) < 0.001) { this.laidOutAt = performance.now(); this.scroll.scrollTop = cy - vy; this.scroll.scrollLeft = cx - vx; this.updateCurrent(); this.frame(); return [cx, cy]; }
    // (Pages scale with the zoom but the gaps between them do not: the point is carried through its page.)
    const n = this.pageAt(cy); const top = this.layoutTops()[n - 1];
    const pageEl = this.pages[n - 1];
    const leftOf = () => pageEl.offsetLeft + (pageEl.offsetParent === this.inner ? this.inner.offsetLeft : 0);
    // (Measured from the page's sheet, which scales exactly with the zoom; the window's offset into it — margins cropped
    // — is rounded to a pixel at each size, and carrying the point by the window put it 2 px off.)
    const sheet = this.sheets[n - 1]; const sx = () => parseFloat(sheet.style.left) || 0, sy = () => parseFloat(sheet.style.top) || 0;
    const within = cy - top - sy(), withinX = cx - leftOf() - sx();
    this.scale = scale;
    this.pages.forEach((p, i) => this.sizePage(p, i + 1));
    this.tops = null;
    this.dropForScale();
    const newTop = this.layoutTops()[n - 1] + sy() + within * ratio, newLeft = leftOf() + sx() + withinX * ratio; this.laidOutAt = performance.now();
    this.scroll.scrollTop = newTop - vy;
    this.scroll.scrollLeft = newLeft - vx;
    this.updateCurrent();
    this.frame();
    return [newLeft, newTop];
  }

  /** The point (x, y) of the new layout (scrolled coordinates) was shown at (vx, vy) in the viewport, `k` times its
   *  new size: the inner box is drawn that way and eases to its place, so nothing jumps where the layout differs
   *  from the picture. A new touch or zoom ends it at once (settleZoom). */
  private glideFrom(at: [number, number], vx: number, vy: number, k: number): void {
    const sx = vx - (at[0] - this.scroll.scrollLeft), sy = vy - (at[1] - this.scroll.scrollTop);
    if (Math.abs(sx) < 0.5 && Math.abs(sy) < 0.5 && Math.abs(k - 1) < 0.002) return;
    const inner = this.inner;
    inner.style.transition = 'none'; inner.style.transformOrigin = `${at[0] - inner.offsetLeft}px ${at[1] - inner.offsetTop}px`;
    inner.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) scale(${k.toFixed(4)})`; inner.style.willChange = 'transform';
    let raf = 0, timer = 0;
    const anim = { finish: () => done() };
    const onEnd = (e: TransitionEvent) => { if (e.target === inner && e.propertyName === 'transform') done(); };
    const done = () => {
      if (this.zoomAnim !== anim) return; this.zoomAnim = null; cancelAnimationFrame(raf); window.clearTimeout(timer); inner.removeEventListener('transitionend', onEnd);
      inner.style.transition = ''; inner.style.transform = ''; inner.style.transformOrigin = ''; inner.style.willChange = '';
      this.pump();
    };
    this.zoomAnim = anim; inner.addEventListener('transitionend', onEnd);
    // (Two frames: the starting picture must be drawn once before the transition to none begins.)
    raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => { inner.style.transition = 'transform 200ms cubic-bezier(.2,.8,.2,1)'; inner.style.transform = ''; }); });
    timer = window.setTimeout(done, 320);
  }

  /** The animated zoom under way, if any (finish() lays it out at once). */
  private zoomAnim: { finish(): void } | null = null;
  /** A zoom still animating is laid out now, so the next one starts from its size and its layout. (Tapped again
   *  within the animation, a zoom was worked out from the old size and placed by the old layout's coordinates:
   *  taps were lost, the page jumped elsewhere, or the picture stayed stretched — the old timer ending the new
   *  animation.) */
  private settleZoom(): void { this.zoomAnim?.finish(); }
  /** Two fingers are on the page (the crop finder waits). */
  private pinching = false;
  /** When a zoom last moved the scroll itself. */
  private laidOutAt = 0;
  /** A short animated zoom (double tap, the zoom buttons): the picture scales with a transition, then the
   *  pages are laid out at the new size with the point at (vx, vy) in the viewport in the same place. */
  private animateZoom(scale: number, vx: number, vy: number): void {
    this.settleZoom();
    const cx = this.scroll.scrollLeft + vx, cy = this.scroll.scrollTop + vy;
    const target = Math.min(4, Math.max(0.4, scale));
    const f = target / this.scale;
    if (Math.abs(f - 1) < 0.001) return;
    const inner = this.inner;
    inner.style.transformOrigin = `${cx - inner.offsetLeft}px ${cy - inner.offsetTop}px`;
    inner.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1)';
    inner.style.willChange = 'transform';
    let raf = 0, timer = 0;
    const anim = { finish: () => done() };
    // (Only the inner's own transition ends it: a page's transition inside bubbles up here too.)
    const onEnd = (e: TransitionEvent) => { if (e.target === inner && e.propertyName === 'transform') done(); };
    const done = () => {
      if (this.zoomAnim !== anim) return; this.zoomAnim = null; cancelAnimationFrame(raf); window.clearTimeout(timer); inner.removeEventListener('transitionend', onEnd);
      inner.style.transition = ''; inner.style.transform = ''; inner.style.transformOrigin = ''; inner.style.willChange = '';
      this.zoomAbout(target, cx, cy, vx, vy);
    };
    this.zoomAnim = anim; inner.addEventListener('transitionend', onEnd);
    raf = requestAnimationFrame(() => { inner.style.transform = `scale(${f.toFixed(4)})`; });
    timer = window.setTimeout(done, 320);
  }

  /** The page's sheet: the whole page, to draw on (highlights, notes, ink) with fractions of the page. */
  pageElement(n: number): HTMLElement | undefined { return this.sheets[n - 1]; }
  /** The page's sheet for an element inside a page (its window, say), for fractions of the whole page. */
  static sheetOf(el: Element | null): HTMLElement | null { const w = el?.closest<HTMLElement>('.pdf-page'); return w ? (w.querySelector<HTMLElement>(':scope > .pdf-sheet') ?? w) : null; }

  zoom(delta: number): void {
    this.settleZoom(); this.fitWidth = false;
    this.animateZoom(this.scale * (1 + delta), this.scroll.clientWidth / 2, this.scroll.clientHeight / 2);
  }
  fitToWidth(): void {
    this.settleZoom(); this.fitWidth = true;
    this.animateZoom(this.computeFitScale(), this.scroll.clientWidth / 2, this.scroll.clientHeight / 2);
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
   *  it at hand; `done` gets the texts once all are read. Stops when the book is closed. `keep`: the pages read on an
   *  earlier opening (`from`, page n at n − 1) — gone on from, not read again — and where what is read is kept as it
   *  goes (`save`, every few pages, when the app is hidden and when the book is closed). It waits while the pages are
   *  scrolled, drawn or zoomed and while the app is hidden; each page read is let go of by pdf.js unless it is shown;
   *  on a device with little memory (2 GB or less) nothing is read ahead — a search reads the pages then. */
  async readAllWhenIdle(done: (texts: string[]) => void, keep?: { from?: (string | null)[] | null; save(texts: (string | null)[]): void }): Promise<void> {
    if (deviceMemory() <= 2) return;
    keep?.from?.forEach((x, i) => { if (typeof x === 'string' && i < this.total && !this.textCache.has(i + 1)) this.textCache.set(i + 1, x); });
    const idle = () => new Promise<void>((r) => { const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback; if (ric) ric(() => r(), { timeout: 1500 }); else setTimeout(r, 60); });
    let fresh = 0;
    const save = () => { if (!fresh || !keep) return; fresh = 0; keep.save(Array.from({ length: this.total }, (_, i) => this.textCache.get(i + 1) ?? null)); };
    const calm = async () => {
      while (!this.destroyed && (document.hidden || this.scrolling || this.busy || this.pinching || this.zoomAnim)) {
        if (document.hidden) save();
        await new Promise((r) => setTimeout(r, document.hidden ? 1000 : 250));
      }
    };
    for (let n = 1; n <= this.total; n++) {
      if (this.destroyed) break;
      if (this.textCache.has(n)) continue;
      await idle(); await calm(); if (this.destroyed) break;
      if (this.textCache.has(n)) continue;
      await this.pageText(n);
      if (this.textCache.has(n)) fresh++;
      if (!this.shown.has(n)) void this.doc.getPage(n).then((p) => p.cleanup()).catch(() => undefined);
      if (fresh >= 20) save();
    }
    if (this.destroyed) { save(); return; }
    const all = this.allTexts(); if (all) done(all); else save();
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
      // (A far page of a long book takes a while to draw its text: waited for up to ten seconds, and given up
      // at once if the reader has gone to another page meanwhile.)
      if (!layer || !layer.childElementCount) { if (attempt < 50 && !this.destroyed && Math.abs(this.current - n) <= 1) setTimeout(() => tryMark(attempt + 1), 200); return; }
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
    const canvas = offscreen(document.createElement('canvas'));
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), type, 0.92));
  }

  /** Page n's size in points (as the viewer lays it: the page's own turn included). */
  pageSize(n: number): { width: number; height: number } { return { width: this.baseWidths[n - 1] ?? 0, height: this.baseHeights[n - 1] ?? 0 }; }

  /** A part of page n — `box` as fractions of the whole page (x, y, w, h) — drawn afresh `width` pixels across, from
   *  the file (not the screen's picture, which may be small or in tiles). The caller lets the canvas go when done. */
  async renderRegion(n: number, box: [number, number, number, number], width: number): Promise<HTMLCanvasElement> {
    const page = await this.doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const k = width / Math.max(1e-6, box[2] * base.width);
    const W = Math.max(1, Math.round(width)), H = Math.max(1, Math.round(box[3] * base.height * k));
    const x = Math.round(box[0] * base.width * k), y = Math.round(box[1] * base.height * k);
    const canvas = offscreen(document.createElement('canvas')); canvas.width = W; canvas.height = H;
    // (The device's renderer draws the part as it draws a tile: the whole page's width, and where the part lies in it.)
    if (this.native && await this.nativeDraw(n, canvas, { width: Math.round(base.width * k), tileX: x, tileY: y, tileW: W, tileH: H }).catch(() => false)) return canvas;
    const ctx = canvas.getContext('2d', { alpha: false })!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    await page.render({ canvas, canvasContext: ctx, viewport: page.getViewport({ scale: k, offsetX: -x, offsetY: -y }) }).promise;
    return canvas;
  }

  /** Small thumbnails for the pages grid and the strip: drawn two at a time, the ones asked for last (those on
   *  the screen now) first, by the device's own renderer where there is one, each kept once drawn. */
  private thumbs = new Map<string, Promise<string>>();
  private thumbQueue: { key: string; n: number; width: number; ok: (u: string) => void; fail: (e: unknown) => void }[] = [];
  private thumbBusy = 0;
  thumbnail(n: number, width = 180): Promise<string> {
    const key = `${n}:${width}`;
    const had = this.thumbs.get(key); if (had) { this.thumbs.delete(key); this.thumbs.set(key, had); return had; }
    const p = new Promise<string>((ok, fail) => { this.thumbQueue.push({ key, n, width, ok, fail }); this.pumpThumbs(); });
    this.thumbs.set(key, p);
    // (The ones seen longest ago let go of: a grid scrolled through a long book kept every page's picture.)
    for (const k of this.thumbs.keys()) { if (this.thumbs.size <= (deviceMemory() <= 4 ? 150 : 400)) break; this.thumbs.delete(k); }
    p.catch(() => this.thumbs.delete(key));
    return p;
  }
  /** Thumbnails still waiting are let go (the pages grid closed): the pages being read come first. */
  dropThumbs(): void { for (const j of this.thumbQueue.splice(0)) { this.thumbs.delete(j.key); j.fail(new Error('dropped')); } }
  private pumpThumbs(): void {
    // (The pages on screen are drawn first: thumbnails wait while a page is being drawn — on a phone both go
    // through the one native renderer, and a grid's thumbnails used to keep the page itself blank for seconds.)
    if (this.busy) return;
    while (this.thumbBusy < 2 && this.thumbQueue.length) {
      const job = this.thumbQueue.pop()!;   // the last asked for: what the reader is looking at now
      this.thumbBusy++;
      void this.drawThumb(job.n, job.width).then(job.ok, job.fail).finally(() => { this.thumbBusy--; this.pumpThumbs(); });
    }
    if (!this.thumbBusy && !this.thumbQueue.length) this.pumpCrops();
  }
  private async drawThumb(n: number, width: number): Promise<string> {
    if (this.destroyed) throw new Error('closed');
    const px = Math.round(width * Math.min(2, this.device()));
    const canvas = offscreen(document.createElement('canvas'));
    if (this.native) {
      await this.ensureSize(n);
      canvas.width = px; canvas.height = Math.round(px * (this.baseHeights[n - 1] / this.baseWidths[n - 1] || 1.4));
      if (await this.nativeDraw(n, canvas, { width: px }).catch(() => false)) return canvas.toDataURL('image/jpeg', 0.7);
    }
    const page = await this.doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: px / base.width });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    try { await page.render({ canvas, canvasContext: ctx, viewport }).promise; }
    finally { if (!this.shown.has(n)) page.cleanup(); }
    const url = canvas.toDataURL('image/jpeg', 0.7); canvas.width = canvas.height = 0;
    return url;
  }

  destroy(): void {
    this.saveCrops(false);
    this.destroyed = true;
    window.clearTimeout(this.settleTimer);
    if (this.cropCanvas) { this.cropCanvas.width = this.cropCanvas.height = 0; this.cropCanvas = null; }
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
    // (The book open and the one before it: a cache of PDFs the size of two books, not of a shelf.)
    const old = files.filter((x) => x.name !== keep).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).slice(1);
    for (const x of old) await f.deleteFile({ path: `kr-pdf/${x.name}`, directory: 'CACHE' }).catch(() => {});
  } catch { /* nothing cached */ }
}
