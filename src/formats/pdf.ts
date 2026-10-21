// PDF viewing on top of pdf.js: lazily rendered pages with a selectable text
// layer, a page slider, go-to, outline and full-text search.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { BookMeta, TocItem } from './types';
import { titleFromFileName, normalizeForSearch } from './types';
import { h } from '../ui/dom';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

const RES = new URL('./pdfjs/', import.meta.url).href;

async function openDoc(file: Blob): Promise<{ doc: PDFDocumentProxy; close: () => void }> {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    cMapUrl: `${RES}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${RES}standard_fonts/`,
    wasmUrl: `${RES}wasm/`,
    iccUrl: `${RES}iccs/`,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise;
  return { doc, close: () => { void task.destroy(); } };
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
    const cover = await new Promise<Blob | undefined>((res) => canvas.toBlob((b) => res(b ?? undefined), 'image/jpeg', 0.82));
    const title = info?.Title?.trim();
    return { title: title && title.toLowerCase() !== 'untitled' ? title : titleFromFileName(fileName), author: info?.Author?.trim() || undefined, pageCount: doc.numPages, cover };
  } finally {
    close();
  }
}

export interface PdfSearchHit { page: number; excerpt: string; term: string }

export interface PdfViewerOptions {
  container: HTMLElement;
  onPageChange(page: number, total: number): void;
  invert: boolean;
}

/** Android: render page bitmaps with the platform renderer (system fonts, JBIG2/JPX, fast). */
interface NativePdf { pdfOpen(o: { path: string }): Promise<{ pageCount: number }>; pdfRender(o: { page: number; width: number; quality?: number }): Promise<{ data: string; width: number; height: number }>; pdfClose(): Promise<void> }
interface NativeFs { writeFile(o: { path: string; data: string; directory: string; recursive?: boolean }): Promise<{ uri: string }>; stat(o: { path: string; directory: string }): Promise<{ uri: string }> }
function nativePdf(): { pdf: NativePdf; fs: NativeFs } | null {
  const cap = (window as unknown as { Capacitor?: { getPlatform?(): string; Plugins?: { Kurokawa?: NativePdf; Filesystem?: NativeFs } } }).Capacitor;
  if (cap?.getPlatform?.() !== 'android' || !cap.Plugins?.Kurokawa || !cap.Plugins.Filesystem) return null;
  return { pdf: cap.Plugins.Kurokawa, fs: cap.Plugins.Filesystem };
}
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}

export class PdfViewer {
  private doc!: PDFDocumentProxy;
  private pages: HTMLElement[] = [];
  private rendered = new Map<number, { task?: pdfjs.RenderTask; canvas?: HTMLCanvasElement; text?: pdfjs.TextLayer }>();
  private observer!: IntersectionObserver;
  private scale = 1;
  private baseWidths: number[] = [];
  private baseHeights: number[] = [];
  readonly scroll: HTMLElement;
  readonly root: HTMLElement;
  current = 1;
  total = 0;
  private fitWidth = true;
  private textCache = new Map<number, string>();
  private resizeObs?: ResizeObserver;
  private destroyed = false;
  private closeDoc: () => void = () => undefined;
  private native: NativePdf | null = null;

  constructor(private opts: PdfViewerOptions) {
    this.scroll = h('div', { class: 'pdf-scroll' });
    this.root = h('div', { class: 'pdf-view' }, this.scroll);
    this.root.dataset.invert = String(opts.invert);
    opts.container.appendChild(this.root);
  }

  async load(file: Blob, cacheKey?: string): Promise<void> {
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
    this.scale = this.computeFitScale();
    this.pages = [];
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= this.total; i++) {
      const el = h('div', { class: 'pdf-page', dataset: { page: String(i) } }, h('span', { class: 'pnum' }, String(i)));
      this.sizePage(el, i);
      this.pages.push(el);
      frag.appendChild(el);
    }
    this.scroll.appendChild(frag);
    // Prefer the platform renderer on Android; pdf.js stays in charge of text, search
    // and outline. Opening it is not awaited: pdf.js draws the first screens meanwhile.
    const nat = nativePdf();
    if (nat && cacheKey) {
      void (async () => {
        try {
          const path = `kr-pdf/${cacheKey}.pdf`;
          let uri: string;
          try { uri = (await nat.fs.stat({ path, directory: 'CACHE' })).uri; }
          catch { uri = (await nat.fs.writeFile({ path, data: await blobToBase64(file), directory: 'CACHE', recursive: true })).uri; }
          const info = await nat.pdf.pdfOpen({ path: uri });
          if (!this.destroyed && info.pageCount === this.total) this.native = nat.pdf;
        } catch (e) { console.warn('[kurokawa] native PDF renderer unavailable', e); this.native = null; }
      })();
    }
    void this.measurePages();
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = Number((e.target as HTMLElement).dataset.page);
        if (e.isIntersecting) this.renderPage(n);
        else this.releasePage(n);
      }
    }, { root: this.scroll, rootMargin: '150% 0px' });
    this.pages.forEach((p) => this.observer.observe(p));
    this.scroll.addEventListener('scroll', () => this.updateCurrent(), { passive: true });
    this.resizeObs = new ResizeObserver(() => { if (this.fitWidth) this.rescale(this.computeFitScale()); });
    this.resizeObs.observe(this.scroll);
    this.opts.onPageChange(this.current, this.total);
    this.updateCurrent();
  }

  /** Fetch real page sizes in the background and correct the placeholders. */
  private async measurePages(): Promise<void> {
    for (let i = 2; i <= this.total; i++) {
      if (this.destroyed) return;
      const page = await this.doc.getPage(i).catch(() => null);
      if (this.destroyed || !page) continue;
      const vp = page.getViewport({ scale: 1 });
      if (Math.abs(vp.width - this.baseWidths[i - 1]) < 0.5 && Math.abs(vp.height - this.baseHeights[i - 1]) < 0.5) continue;
      const before = this.pages[i - 1].offsetHeight;
      this.baseWidths[i - 1] = vp.width; this.baseHeights[i - 1] = vp.height;
      this.sizePage(this.pages[i - 1], i);
      // Keep what the reader is looking at where it is when an earlier page grows.
      if (i < this.current) this.scroll.scrollTop += this.pages[i - 1].offsetHeight - before;
      if (this.rendered.has(i)) { this.releasePage(i); void this.renderPage(i); }
      if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }

  private computeFitScale(): number {
    const avail = Math.max(280, this.scroll.clientWidth - 24);
    const w = Math.max(...this.baseWidths.slice(0, 5));
    return Math.min(avail / w, 3);
  }

  private sizePage(el: HTMLElement, n: number): void {
    const w = this.baseWidths[n - 1] * this.scale;
    const hgt = this.baseHeights[n - 1] * this.scale;
    el.style.width = `${Math.floor(w)}px`;
    el.style.height = `${Math.floor(hgt)}px`;
    el.style.setProperty('--total-scale-factor', String(this.scale));
    el.style.setProperty('--scale-factor', String(this.scale));
  }

  private async renderPage(n: number): Promise<void> {
    if (this.destroyed || this.rendered.has(n)) return;
    const entry: { task?: pdfjs.RenderTask; canvas?: HTMLCanvasElement; text?: pdfjs.TextLayer } = {};
    this.rendered.set(n, entry);
    const el = this.pages[n - 1];
    let page: PDFPageProxy;
    try { page = await this.doc.getPage(n); } catch { return; }
    if (this.destroyed || !this.rendered.has(n)) return;
    const viewport = page.getViewport({ scale: this.scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.native) {
      try {
        const res = await this.native.pdfRender({ page: n, width: Math.round(viewport.width * dpr), quality: 85 });
        if (this.destroyed || !this.rendered.has(n)) return;
        const img = document.createElement('img');
        img.className = 'native-page'; img.decoding = 'async'; img.alt = String(n);
        img.src = `data:image/jpeg;base64,${res.data}`;
        el.appendChild(img);
      } catch { this.native = null; /* fall back to pdf.js below */ }
    }
    if (!this.native) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      entry.canvas = canvas;
      el.appendChild(canvas);
      const ctx = canvas.getContext('2d', { alpha: false })!;
      entry.task = page.render({ canvas, canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      try { await entry.task.promise; } catch { return; }
      if (this.destroyed || !this.rendered.has(n)) return;
    }
    const textDiv = h('div', { class: 'textLayer' });
    el.appendChild(textDiv);
    try {
      const text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
      entry.text = text;
      await text.render();
      textDiv.appendChild(h('div', { class: 'endOfContent' }));
    } catch { /* text layer is optional */ }
  }

  private releasePage(n: number): void {
    const entry = this.rendered.get(n);
    if (!entry) return;
    entry.task?.cancel();
    entry.text?.cancel();
    const el = this.pages[n - 1];
    el.querySelectorAll('canvas, img.native-page, .textLayer').forEach((c) => c.remove());
    this.rendered.delete(n);
  }

  private rescale(scale: number): void {
    if (Math.abs(scale - this.scale) < 0.001) return;
    const anchorPage = this.current;
    const rel = this.relativeOffset(anchorPage);
    this.scale = scale;
    for (const n of [...this.rendered.keys()]) this.releasePage(n);
    this.pages.forEach((p, i) => this.sizePage(p, i + 1));
    this.goTo(anchorPage, rel);
    this.pages.forEach((p) => { this.observer.unobserve(p); this.observer.observe(p); });
  }

  private relativeOffset(n: number): number {
    const el = this.pages[n - 1];
    if (!el) return 0;
    return Math.max(0, (this.scroll.scrollTop - el.offsetTop) / Math.max(1, el.offsetHeight));
  }

  zoom(delta: number): void {
    this.fitWidth = false;
    this.rescale(Math.min(4, Math.max(0.4, this.scale * (1 + delta))));
  }
  fitToWidth(): void {
    this.fitWidth = true;
    this.rescale(this.computeFitScale());
  }
  setInvert(v: boolean): void { this.root.dataset.invert = String(v); }

  goTo(page: number, offset = 0): void {
    page = Math.min(this.total, Math.max(1, Math.round(page)));
    const el = this.pages[page - 1];
    if (!el) return;
    this.scroll.scrollTop = el.offsetTop - 6 + offset * el.offsetHeight;
    this.current = page;
    this.opts.onPageChange(page, this.total);
  }

  private updateCurrent(): void {
    const mid = this.scroll.scrollTop + this.scroll.clientHeight * 0.4;
    let lo = 0, hi = this.pages.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      const el = this.pages[m];
      if (el.offsetTop + el.offsetHeight < mid) lo = m + 1; else hi = m;
    }
    const n = lo + 1;
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

  async pageText(n: number): Promise<string> {
    if (this.textCache.has(n)) return this.textCache.get(n)!;
    try {
      const page = await this.doc.getPage(n);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('');
      this.textCache.set(n, text);
      return text;
    } catch { return ''; }
  }

  /** Search every page; reports progress; returns hits with excerpts. */
  async search(query: string, onProgress?: (done: number, total: number) => void, signal?: { cancelled: boolean }): Promise<PdfSearchHit[]> {
    const hits: PdfSearchHit[] = [];
    const q = normalizeForSearch(query.trim()).text;
    if (!q) return hits;
    for (let n = 1; n <= this.total; n++) {
      if (signal?.cancelled) break;
      const text = await this.pageText(n);
      const norm = normalizeForSearch(text);
      let idx = norm.text.indexOf(q);
      let count = 0;
      while (idx >= 0 && count < 20) {
        const start = norm.map[idx], end = norm.map[Math.min(norm.map.length - 1, idx + q.length)];
        const excerpt = text.slice(Math.max(0, start - 50), Math.min(text.length, end + 50)).replace(/\s+/g, ' ');
        hits.push({ page: n, excerpt, term: text.slice(start, end) });
        count++;
        idx = norm.text.indexOf(q, idx + q.length);
      }
      onProgress?.(n, this.total);
    }
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
      layer.querySelectorAll('span').forEach((sp) => {
        if (normalizeForSearch(sp.textContent ?? '').text.includes(q)) { sp.classList.add('highlight'); first ??= sp; }
      });
      (first as Element | null)?.scrollIntoView({ block: 'center' });
    };
    tryMark(0);
  }

  /** Render one page to a PNG blob at the given width (for saving / sharing). */
  async pageToBlob(n: number, width = 1600): Promise<Blob> {
    const page = await this.doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
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
    this.observer?.disconnect();
    this.resizeObs?.disconnect();
    for (const n of [...this.rendered.keys()]) this.releasePage(n);
    this.closeDoc();
    void this.native?.pdfClose().catch(() => undefined);
    this.root.remove();
  }
}
