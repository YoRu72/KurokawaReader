// The comic reader's pages on the screen (src/views/comic.ts holds the reader's shell around it). Two ways:
//  - one page per screen (left to right, right to left, vertical): a track of the pages near the current one (two on
//    each side, their pictures decoded ahead, the rest let go), the finger followed as it swipes, a slide when a tap,
//    key or button turns; the page fitted as set (fit screen, stretch, fit width, fit height, original size, smart
//    fit), started at the edge reading starts from; pinched up to 5×, moved about, a double tap in to 2× at that
//    spot and back out; zoomed in, a tap on a side moves a screen's width that way and turns only at the edge; a wide
//    page shown whole eases in to fill the height (landscape zoom);
//  - a strip (long strip, no gaps; continuous vertical, a gap): every page a placeholder as tall as its learned size
//    makes it, only those near the screen holding their pictures; double tap to zoom (3× at most), pinched too.
// Items: the pages' display pieces (src/comic/process.ts — one per page today) between the pages before and after
// the volume (when given). Taps go to the tap zones (src/comic/zones.ts); what no zone claims goes to `onMenu`.
import type { PageSource } from './pages';
import { prepare, pieceSize, pairUp, isWide, WHOLE, type Piece, type Box } from './process';
import { measure, isAnimatedGif, type Border, type Edge } from './crop';
import { zonesOf, hitZone, stepOf, type ZoneLayout, type ZoneInvert } from './zones';

export type Mode = 1 | 2 | 3 | 4 | 5;
export type Scale = 'fit' | 'stretch' | 'width' | 'height' | 'original' | 'smart';
export type ZoomStart = 'auto' | 'left' | 'right' | 'center';
export interface ViewerOptions {
  transitions: boolean; scale: Scale; zoomStart: ZoomStart; navPan: boolean; landscapeZoom: boolean; stripZoom: boolean;
  zones: ZoneLayout; invert: ZoneInvert;
  /** Wide pages: split in halves / turned (the reversals), as set for this way of reading. */
  split?: boolean; splitInvert?: boolean; rotate?: boolean; rotateInvert?: boolean;
  /** Two pages side by side (one page per screen), and the pairing shifted by one page. */
  dual?: 'never' | 'always' | 'wide'; shift?: boolean;
  /** Borders trimmed; the background chosen from the page's border («auto»). */
  crop?: boolean; auto?: boolean;
  /** The strip: room left and right (percent of the width), and no zooming out below the width. */
  padding?: number; noZoomOut?: boolean;
  /** A long press (a right click) on a page is told. */
  longPress?: boolean;
}
/** One shown part of a page: the page, the part of its picture, which of the page's parts it is. */
export interface Part { page: number; piece: Piece; k: number }
type PageItem = { kind: 'page'; page: number; parts: Part[] };
type Item = PageItem | { kind: 'before' } | { kind: 'after' };
/** What a long press found: the page, how it is shown (its crop and turn), and the picture's own size. */
export interface Pressed { page: number; piece: Piece; x: number; y: number }

export const isStrip = (m: Mode) => m === 4 || m === 5;
export const isHorizontal = (m: Mode) => m === 1 || m === 2;
/** Taller than this at the strip's width (CSS px): drawn as slices. */
const SLICE_AT = 4096;
const PAGED_MAX = 5, STRIP_MAX = 3, DOUBLE_TAP_MS = 300, ZOOM_MS = 500, TURN_MS = 260, NEAR = 2;
/** The gap between pages in the continuous vertical mode (CSS px). */
const GAP = 16;

export interface ComicViewerHost {
  container: HTMLElement;
  source: PageSource;
  /** The pages before and after the volume (null: none). */
  before: () => HTMLElement | null;
  after: () => HTMLElement | null;
  /** The item shown changed (a page, or the page before / after the volume). */
  onChange: (state: { item: number; page: number; kind: Item['kind']; total: number; offset: number; shown: number; shownEnd: number; shownTotal: number }) => void;
  /** The border colour of the page shown (white, black or neither), for the background «Automatic». */
  onBackground?: (edge: Edge) => void;
  /** A tap no zone claims (the bars shown or hidden). */
  onMenu: () => void;
  /** A long press on a page (a right click on a computer): the event `kr:comic-longpress` on the container too. */
  onLongPress?: (hit: Pressed) => void;
}

export class ComicViewer {
  readonly el: HTMLElement;
  private mode: Mode;
  private o: ViewerOptions;
  private items: Item[] = [];
  private cur = 0;
  private disposed = false;
  private cleanups: (() => void)[] = [];
  // one page per screen
  private track: HTMLElement | null = null;
  private slots = new Map<number, HTMLElement>();
  private z = 1; private x = 0; private y = 0; private bw = 0; private bh = 0;
  private landscapeTimer = 0;
  // strip
  private scroller: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private blocks: HTMLElement[] = [];
  private heights: number[] = [];
  private stripZ = 1;
  private raf = 0;
  private lastStripItem = -1;
  // borders, sizes, slices
  private borders = new Map<number, Border>();
  private analysing = new Set<number>();
  private animated = new Map<number, boolean>();
  private builtPairing = false;
  private sizing = 0;
  private rebuildTimer = 0;
  private sliceBlobs = new Map<number, Promise<Blob>>();
  private sliceQ: Promise<unknown> = Promise.resolve();
  private slicePx = 0; private slicePeakPx = 0; private sliceDrawn = 0;

  constructor(private host: ComicViewerHost, mode: Mode, o: ViewerOptions) {
    this.mode = mode; this.o = o;
    this.el = document.createElement('div');
    this.el.className = 'cm-view';
    host.container.append(this.el);
    const ro = new ResizeObserver(() => this.relayout()); ro.observe(this.el); this.cleanups.push(() => ro.disconnect());
    this.build(0);
  }

  get rtl(): boolean { return this.mode === 2; }
  get strip(): boolean { return isStrip(this.mode); }
  get total(): number { return this.host.source.pages.length; }
  /** The page shown (0-based), the one before the volume counting as the first, the one after as the last. */
  get page(): number { const it = this.items[this.cur]; return it?.kind === 'page' ? it.page : it?.kind === 'before' ? 0 : this.total - 1; }
  /** The pieces on show (a page split in two counts two, two pages side by side count two): the total, and the number
   *  of the first (1-based) and last of the current item. The slider and the page count are in these. */
  get displayTotal(): number { return this.starts.total; }
  get displayPos(): number { const i = this.items[this.cur]; return i?.kind === 'page' ? this.starts.at[this.cur] + 1 : i?.kind === 'before' ? 1 : this.starts.total; }
  private starts: { at: number[]; total: number } = { at: [], total: 0 };
  get item(): number { return this.cur; }
  get itemKind(): Item['kind'] { return this.items[this.cur]?.kind ?? 'page'; }
  get zoom(): number { return this.strip ? this.stripZ : this.z; }

  /** The mode or the options changed: laid out again at the same page. */
  set(mode: Mode, o: ViewerOptions): void {
    const page = this.page, offset = this.offset();
    this.mode = mode; this.o = o;
    this.build(page, offset);
  }

  /** The items again (the pages' pieces, the pages between volumes), the given page shown. */
  rebuild(page = this.page): void { this.build(page); }

  /** Two pages side by side now: asked for, one page per screen, and (when «on wide screens») the screen wider than tall. */
  private pairing(): boolean {
    const d = this.o.dual ?? 'never';
    return !this.strip && (d === 'always' || (d === 'wide' && this.el.clientWidth > this.el.clientHeight));
  }
  private wideOf(p: number): boolean { const pg = this.host.source.pages[p]; return isWide({ w: pg.width ?? 0, h: pg.height ?? 0 }); }
  private trimOf(p: number): Box | null { return this.o.crop && !this.animated.get(p) ? this.borders.get(p)?.box ?? null : null; }
  private state(paired = false, p = -1): Parameters<typeof prepare>[1] {
    return { rtl: this.rtl, strip: this.strip, width: this.el.clientWidth, height: this.el.clientHeight, split: this.o.split, splitInvert: this.o.splitInvert, rotate: this.o.rotate, rotateInvert: this.o.rotateInvert, trim: p >= 0 ? this.trimOf(p) : null, paired };
  }
  private partsOf(p: number, paired: boolean): Part[] {
    const pg = this.host.source.pages[p];
    return prepare({ w: pg.width ?? 0, h: pg.height ?? 0 }, this.state(paired, p)).map((piece, k) => ({ page: p, piece, k }));
  }
  private buildItems(): Item[] {
    const src = this.host.source; const out: Item[] = [];
    if (this.host.before()) out.push({ kind: 'before' });
    if (this.pairing()) {
      for (const g of pairUp(src.pages.map((_, i) => this.wideOf(i)), !!this.o.shift)) out.push({ kind: 'page', page: g[0], parts: g.flatMap((i) => this.partsOf(i, true)) });
    } else {
      for (const p of src.pages) for (const part of this.partsOf(p.index, false)) out.push({ kind: 'page', page: p.index, parts: [part] });
    }
    if (this.host.after()) out.push({ kind: 'after' });
    return out;
  }
  private makeItems(): void {
    this.items = this.buildItems(); this.builtPairing = this.pairing();
    let n = 0; const at: number[] = [];
    for (const it of this.items) { at.push(n); if (it.kind === 'page') n += it.parts.length; }
    this.starts = { at, total: n };
  }
  /** The shape of the items (which page, which part, which pairs): when it changes the items are made again. */
  private shapeKey(items: Item[]): string { return items.map((i) => (i.kind === 'page' ? i.parts.map((x) => `${x.page}.${x.k}`).join('+') : i.kind)).join(','); }
  /** A page's size became known: the items again if the shape changed (a wide page found, to split or to stand alone). */
  private learned(): void {
    if (this.disposed || this.rebuildTimer) return;
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = 0; if (this.disposed) return;
      if (this.shapeKey(this.buildItems()) !== this.shapeKey(this.items)) { const off = this.offset(); this.build(this.page, off); }
    }, 60);
  }
  /** The sizes of all the pages, read one after another from the page shown outward, while the shape depends on them
   *  (split, two pages side by side). */
  private async learnSizes(): Promise<void> {
    if (!((this.o.split && !this.o.rotate) || (!this.strip && (this.o.dual ?? 'never') !== 'never'))) return;
    const token = ++this.sizing; const src = this.host.source; const n = src.pages.length; const from = this.page;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => Math.abs(a - from) - Math.abs(b - from));
    let k = 0;
    for (const i of order) {
      if (this.disposed || token !== this.sizing) return;
      const pg = src.pages[i]; if (pg.width && pg.height) continue;
      await src.size(i).catch(() => undefined);
      if (++k % 16 === 0) this.learned();
    }
    this.learned();
  }
  private itemOfPage(page: number): number { const i = this.items.findIndex((x) => x.kind === 'page' && x.parts.some((q) => q.page === page)); return i < 0 ? 0 : i; }
  /** The item holding the n-th shown piece (1-based). */
  private itemOfDisplay(n: number): number { let r = 0; this.items.forEach((it, i) => { if (it.kind === 'page' && this.starts.at[i] < n) r = i; }); return r; }
  /** Go to the n-th shown piece (the slider's number). */
  goToDisplay(n: number): void { const i = this.itemOfDisplay(Math.max(1, Math.min(this.starts.total, n))); if (this.strip) this.stripGo(i, 0, false); else this.goItem(i, false); }

  private build(page: number, offset = 0): void {
    clearTimeout(this.landscapeTimer); cancelAnimationFrame(this.raf);
    this.slicePx = 0; this.sliceBlobs.clear();
    this.el.replaceChildren(); this.slots.clear(); this.track = null; this.scroller = null; this.list = null; this.blocks = []; this.heights = [];
    this.el.dataset.mode = String(this.mode);
    this.makeItems();
    this.cur = this.itemOfPage(Math.max(0, Math.min(this.total - 1, page)));
    this.offGestures?.();
    if (this.strip) this.buildStrip(offset); else this.buildPaged();
    void this.learnSizes();
  }
  private offGestures: (() => void) | null = null;

  /* ------------------------------------------------------------ one page per screen */
  private buildPaged(): void {
    const track = document.createElement('div'); track.className = 'cm-track';
    this.el.append(track); this.track = track;
    this.z = 1; this.placeSlots(false); this.startPosition(true); this.applyZoom(false); this.landscape(true); this.emit();
    this.offGestures = this.pagedGestures();
  }
  /** Where the item `k` lies from the current one, on the screen: +1 the next page's side. */
  private axis(): { x: number; y: number } { return this.mode === 3 ? { x: 0, y: 1 } : { x: this.rtl ? -1 : 1, y: 0 }; }
  private slotFor(i: number): HTMLElement {
    let s = this.slots.get(i); if (s) return s;
    s = document.createElement('div'); s.className = 'cm-slot'; s.dataset.item = String(i);
    const it = this.items[i];
    if (it.kind === 'page') {
      s.dataset.page = String(it.page);
      const piece = this.pieceEl(it);
      s.append(piece);
      this.fitSlot(s, it);
    } else {
      s.classList.add('cm-between'); const inner = it.kind === 'before' ? this.host.before() : this.host.after(); if (inner) s.append(inner);
    }
    this.track!.append(s); this.slots.set(i, s);
    return s;
  }
  /** One item (one page's piece, or two pages): a box, a part in it for each page's piece with its picture. */
  private pieceEl(it: PageItem, strip = false): HTMLElement {
    const box = document.createElement('div'); box.className = 'cm-piece'; box.dataset.page = String(it.page);
    for (const [i, part] of it.parts.entries()) {
      const el = document.createElement('div'); el.className = 'cm-part'; el.dataset.page = String(part.page); el.dataset.k = String(part.k); el.dataset.i = String(i);
      const img = document.createElement('img'); img.className = 'cm-img'; img.alt = ''; img.decoding = 'async'; img.draggable = false;
      el.append(img); box.append(el);
      this.loadPart(box, el, img, part, strip);
    }
    this.layoutParts(box, it);
    return box;
  }
  /** The picture of a part: its object URL, decoded; its size learned if it was not known; its borders measured. */
  private loadPart(box: HTMLElement, el: HTMLElement, img: HTMLImageElement, part: Part, strip: boolean): void {
    const src = this.host.source; const p = part.page;
    // (Laid out before its size was known: laid out again once it is — from its header, or decoded.)
    const hadSize = !!(src.pages[p].width && src.pages[p].height);
    void src.url(p).then((u) => {
      if (!hadSize && src.pages[p].width && !this.disposed) { this.relayoutPage(p); this.learned(); }
      if (this.disposed || !box.isConnected) return;
      img.src = u;
      void img.decode().catch(() => undefined).then(async () => {
        if (this.disposed) return;
        const pg = src.pages[p];
        const known = !!(pg.width && pg.height);
        const wrong = !!img.naturalWidth && (!known || pg.width !== img.naturalWidth || pg.height !== img.naturalHeight);
        if (wrong) { pg.width = img.naturalWidth; pg.height = img.naturalHeight; }
        const fresh = await this.analyse(p, img);
        if (this.disposed) return;
        box.classList.add('ready');
        if (wrong || fresh) { this.relayoutPage(p, fresh); if (wrong) this.learned(); }
        void strip;
      });
    }).catch(() => undefined);
  }
  /** A page's borders measured once (when trimmed, or the background follows them): kept for the page. True when the
   *  page's pieces change by it. */
  private async analyse(p: number, img: HTMLImageElement): Promise<boolean> {
    if ((!this.o.crop && !this.o.auto) || this.borders.has(p) || this.analysing.has(p) || !img.naturalWidth) return false;
    this.analysing.add(p);
    try {
      const pg = this.host.source.pages[p];
      // (A moving picture is never trimmed; its borders are not looked at either.)
      if (/\.gif$/i.test(pg.name)) { const an = await isAnimatedGif(await pg.blob()); this.animated.set(p, an); if (an) return false; }
      const b = measure(img, img.naturalWidth, img.naturalHeight); if (!b) return false;
      this.borders.set(p, b);
      if (p === this.page) this.host.onBackground?.(b.edge);
      if (!this.o.crop) return false;
      return this.reprepare(p);
    } finally { this.analysing.delete(p); }
  }
  /** The pieces of a page again (its borders became known): true when they differ from what was drawn. */
  private reprepare(p: number): boolean {
    let changed = false;
    for (const it of this.items) {
      if (it.kind !== 'page') continue;
      const paired = it.parts.length > 1 || this.builtPairing;
      it.parts = it.parts.map((part) => {
        if (part.page !== p) return part;
        const next = this.partsOf(p, paired)[part.k] ?? part;
        if (JSON.stringify(next.piece) !== JSON.stringify(part.piece)) changed = true;
        return next;
      });
    }
    return changed;
  }
  /** The parts of an item side by side (two pages): each part's place in the box, the first read on the right in a book read
   *  right to left. The second page is drawn as tall as the first. */
  private layoutParts(box: HTMLElement, it: PageItem): void {
    const els = [...box.querySelectorAll<HTMLElement>(':scope > .cm-part')];
    const sizes = it.parts.map((part) => this.partSize(part));
    const wTot = sizes.length === 2 ? sizes[0].w + sizes[1].w * (sizes[0].h / (sizes[1].h || 1)) : 1;
    const f0 = sizes.length === 2 ? sizes[0].w / (wTot || 1) : 1;
    const spans = sizes.length === 2 ? [[0, f0], [f0, 1]] : [[0, 1]];
    it.parts.forEach((part, i) => {
      const el = els[i]; if (!el) return;
      // (Right to left: the first page at the right.)
      const [a, b] = sizes.length === 2 && this.rtl ? [1 - spans[i][1], 1 - spans[i][0]] : spans[i];
      el.style.left = `${a * 100}%`; el.style.width = `${(b - a) * 100}%`; el.style.top = '0'; el.style.height = '100%';
      this.applyPart(el, part);
    });
  }
  /** A part's picture inside it: cut to its crop rectangle, turned when it is. */
  private applyPart(el: HTMLElement, part: Part): void {
    const img = el.querySelector<HTMLImageElement>('img.cm-img')!; const [cx, cy, cw, ch] = part.piece.crop; const rot = part.piece.rotate;
    let wrap = el.querySelector<HTMLElement>(':scope > .cm-rot');
    if (rot) {
      if (!wrap) { wrap = document.createElement('div'); wrap.className = 'cm-rot'; el.append(wrap); wrap.append(img); }
      // (A quarter turn: the picture's box is the part's turned — its width the part's height — about the middle.)
      wrap.style.width = rot % 2 ? '100cqh' : '100%'; wrap.style.height = rot % 2 ? '100cqw' : '100%';
      wrap.style.transform = `translate(-50%, -50%) rotate(${rot * 90}deg)`;
    } else if (wrap) { el.append(img); wrap.remove(); }
    el.classList.toggle('cm-rotated', !!rot);
    img.style.width = `${100 / cw}%`; img.style.height = `${100 / ch}%`; img.style.left = `${(-cx * 100) / cw}%`; img.style.top = `${(-cy * 100) / ch}%`;
  }
  private partSize(part: Part): { w: number; h: number } {
    const pg = this.host.source.pages[part.page]; const W = this.el.clientWidth || 1, H = this.el.clientHeight || 1;
    const sz = pieceSize(part.piece, { w: pg.width || W, h: pg.height || H });
    return { w: sz.w || W, h: sz.h || H };
  }
  /** An item's own size in pixels: one piece's, or two side by side at the first's height. */
  private itemNat(it: PageItem): { w: number; h: number } {
    const a = this.partSize(it.parts[0]); if (it.parts.length < 2) return a;
    const b = this.partSize(it.parts[1]); return { w: a.w + b.w * (a.h / (b.h || 1)), h: a.h };
  }
  private relayoutPage(p: number, refill = false): void {
    if (this.strip) {
      this.measureStrip();
      for (const b of this.blocks) { const it = this.items[Number(b.dataset.item)]; if (it?.kind === 'page' && it.parts.some((x) => x.page === p) && b.firstElementChild && this.sliced(p) !== !!b.querySelector('.cm-sliced')) { this.dropSlices(b); b.replaceChildren(); } }
      if (refill) for (const b of this.blocks) { const it = this.items[Number(b.dataset.item)]; if (it?.kind === 'page' && it.parts.some((x) => x.page === p) && b.firstElementChild) { this.dropSlices(b); b.replaceChildren(); } }
      this.syncStrip(); return;
    }
    for (const [i, s] of this.slots) { const it = this.items[i]; if (it.kind === 'page' && it.parts.some((x) => x.page === p)) { this.fitSlot(s, it); if (i === this.cur) { this.startPosition(true); this.applyZoom(false); this.landscape(true); } } }
  }
  /** The item's base size and the picture's place in it, as the scale type has it. */
  private baseSize(it: PageItem): { w: number; h: number } {
    const W = this.el.clientWidth || 1, H = this.el.clientHeight || 1;
    const { w, h } = this.itemNat(it);
    const dpr = window.devicePixelRatio || 1;
    switch (this.o.scale) {
      case 'stretch': return { w: W, h: H };
      case 'width': return { w: W, h: (W / w) * h };
      case 'height': return { w: (H / h) * w, h: H };
      case 'original': return { w: w / dpr, h: h / dpr };
      case 'smart': {
        // (A page much taller or wider than the screen fits its shorter side — a strip is read across its width,
        // a spread across its height —; anything else fits the screen.)
        const ar = (w / h) / (W / H);
        const s = ar > 1.5 || ar < 1 / 1.5 ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
        return { w: w * s, h: h * s };
      }
      default: { const s = Math.min(W / w, H / h); return { w: w * s, h: h * s }; }
    }
  }
  private fitSlot(s: HTMLElement, it: PageItem): void {
    const box = s.querySelector<HTMLElement>('.cm-piece'); if (!box) return;
    const { w, h } = this.baseSize(it); const W = this.el.clientWidth, H = this.el.clientHeight;
    box.style.width = `${w}px`; box.style.height = `${h}px`;
    // (Not the current one: centred, or at the edge it would start from.)
    const sx = w > W ? this.startX(w, true) : (W - w) / 2, sy = h > H ? 0 : (H - h) / 2;
    box.style.transform = `translate(${sx}px, ${sy}px)`;
    this.layoutParts(box, it);
  }
  private startX(dw: number, forward: boolean): number {
    const W = this.el.clientWidth; if (dw <= W) return (W - dw) / 2;
    const zs = this.o.zoomStart;
    const side = zs === 'auto' ? (this.mode === 3 ? 'center' : this.rtl ? 'right' : 'left') : zs;
    const start = side === 'left' ? 0 : side === 'right' ? W - dw : (W - dw) / 2;
    // (Turning back, a page starts at the edge reading leaves it from.)
    if (!forward && side !== 'center') return side === 'left' ? W - dw : 0;
    return start;
  }
  private placeSlots(animate: boolean): void {
    if (!this.track) return;
    const keep = new Set<number>();
    for (let i = this.cur - NEAR; i <= this.cur + NEAR; i++) if (i >= 0 && i < this.items.length) keep.add(i);
    for (const [i, s] of this.slots) if (!keep.has(i)) { s.remove(); this.slots.delete(i); }
    const ax = this.axis();
    for (const i of keep) {
      const s = this.slotFor(i);
      s.style.transition = animate ? `transform ${TURN_MS}ms cubic-bezier(.2,.8,.2,1)` : 'none';
      s.style.transform = `translate(${(i - this.cur) * ax.x * 100}%, ${(i - this.cur) * ax.y * 100}%)`;
      s.classList.toggle('cm-current', i === this.cur);
      // (The pages beside the screen, decoded ahead, are not shown: kept out of what assistive technology reads.)
      s.setAttribute('aria-hidden', String(i !== this.cur));
    }
    const pages = [...keep].map((i) => this.items[i]).filter((x): x is PageItem => x.kind === 'page').flatMap((x) => x.parts.map((q) => q.page));
    this.host.source.keepNear(pages.length ? pages : [this.page], 0);
  }
  /** The current piece's zoom as it starts: scale 1, at the start edge. */
  private startPosition(forward: boolean): void {
    const it = this.items[this.cur]; if (it?.kind !== 'page') { this.bw = this.bh = 0; return; }
    const b = this.baseSize(it); this.bw = b.w; this.bh = b.h; this.z = 1;
    const H = this.el.clientHeight;
    this.x = this.startX(b.w, forward); this.y = b.h > H ? (forward || this.mode !== 3 ? 0 : H - b.h) : (H - b.h) / 2;
  }
  private curBox(): HTMLElement | null { return this.slots.get(this.cur)?.querySelector<HTMLElement>('.cm-piece') ?? null; }
  private clamp(): void {
    const W = this.el.clientWidth, H = this.el.clientHeight, dw = this.bw * this.z, dh = this.bh * this.z;
    this.x = dw <= W ? (W - dw) / 2 : Math.min(0, Math.max(W - dw, this.x));
    this.y = dh <= H ? (H - dh) / 2 : Math.min(0, Math.max(H - dh, this.y));
  }
  private applyZoom(animate: boolean, ms = ZOOM_MS): void {
    const box = this.curBox(); if (!box) return;
    box.style.transition = animate ? `transform ${ms}ms cubic-bezier(.45,0,.55,1)` : 'none';
    box.style.transformOrigin = '0 0';
    box.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.z})`;
    this.el.classList.toggle('cm-zoomed', this.z > 1.01);
  }
  private zoomTo(z: number, cx: number, cy: number, animate: boolean, max = PAGED_MAX): void {
    const r = this.el.getBoundingClientRect(); const px = cx - r.left, py = cy - r.top;
    z = Math.min(max, Math.max(1, z));
    this.x = px - ((px - this.x) * z) / this.z; this.y = py - ((py - this.y) * z) / this.z; this.z = z;
    this.clamp(); this.applyZoom(animate);
  }
  /** Zoomed in, by a step of the zoom (buttons, keys): about the screen's middle. */
  zoomBy(d: number): void {
    const r = this.el.getBoundingClientRect();
    if (this.strip) { this.setStripZoom(this.stripZ + d, r.left + r.width / 2, r.top + r.height / 2); return; }
    this.zoomTo(this.z + d, r.left + r.width / 2, r.top + r.height / 2, true, PAGED_MAX);
  }
  /** Whether the current page can move further `dir` (+1 toward the next page's side) along the reading axis. */
  private canPan(dir: 1 | -1): boolean {
    const W = this.el.clientWidth, H = this.el.clientHeight, dw = this.bw * this.z, dh = this.bh * this.z;
    if (this.mode === 3) return dir > 0 ? this.y > H - dh + 1 : this.y < -1;
    // (Onward is to the right in a left-to-right book: the page moves left — its right part comes in.)
    const toRight = (dir > 0) !== this.rtl;
    return toRight ? this.x > W - dw + 1 : this.x < -1;
  }
  private pan(dir: 1 | -1): void {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (this.mode === 3) this.y -= dir * H;
    else { const toRight = (dir > 0) !== this.rtl; this.x += toRight ? -W : W; }
    this.clamp(); this.applyZoom(true, 250);
  }
  /** Whether the current page shows more than the screen (zoomed in, or fitted larger than it). */
  private larger(): boolean { return this.bw * this.z > this.el.clientWidth + 1 || this.bh * this.z > this.el.clientHeight + 1; }
  /** A step through the book as a tap, key or button asks it: zoomed in, the page moved first (navigate by pan). */
  step(dir: 1 | -1, o: { pan?: boolean } = {}): void {
    if (this.strip) { this.stripStep(dir); return; }
    if ((o.pan ?? true) && this.o.navPan && this.larger() && this.canPan(dir)) { this.pan(dir); return; }
    this.goItem(this.cur + dir, this.o.transitions);
  }
  /** Go to a page (0-based). */
  goTo(page: number, offset = 0): void {
    if (this.strip) { this.stripGo(this.itemOfPage(page), offset, false); return; }
    this.goItem(this.itemOfPage(page), false);
  }
  goFirst(): void { if (this.strip) this.stripGo(0, 0, false); else this.goItem(0, false); }
  goLast(): void { if (this.strip) this.stripGo(this.items.length - 1, 1, false); else this.goItem(this.items.length - 1, false); }
  private goItem(i: number, animate: boolean): void {
    i = Math.max(0, Math.min(this.items.length - 1, i));
    if (i === this.cur) { this.placeSlots(true); return; }
    const forward = i > this.cur, adjacent = Math.abs(i - this.cur) === 1;
    // (The page left goes back to its own place and size.)
    const was = this.slots.get(this.cur); const wit = this.items[this.cur];
    this.cur = i;
    if (was && wit?.kind === 'page') this.fitSlot(was, wit);
    this.placeSlots(animate && adjacent);
    this.startPosition(forward); this.applyZoom(false);
    this.landscape(forward);
    this.emit();
  }
  /** Landscape zoom: a wide page shown whole eases in to fill the height, from the start edge. */
  private landscape(forward: boolean): void {
    clearTimeout(this.landscapeTimer);
    const it = this.items[this.cur]; if (!this.o.landscapeZoom || it?.kind !== 'page' || this.o.scale !== 'fit') return;
    const sz = this.itemNat(it);
    if (!(sz.w > sz.h) || this.z !== 1 || it.parts.length > 1) return;
    const H = this.el.clientHeight, W = this.el.clientWidth; if (this.bh >= H - 1) return;
    const cur = this.cur;
    this.landscapeTimer = window.setTimeout(() => {
      if (this.disposed || this.cur !== cur || this.z !== 1) return;
      const z = H / this.bh; const dw = this.bw * z;
      const zs = this.o.zoomStart; const side = zs === 'auto' ? (this.rtl ? 'right' : 'left') : zs;
      this.z = z; this.y = 0;
      this.x = side === 'center' ? (W - dw) / 2 : (side === 'left') === forward ? 0 : W - dw;
      this.clamp(); this.applyZoom(true);
    }, 500);
  }

  private pagedGestures(): () => void {
    const el = this.el; const pts = new Map<number, { x: number; y: number }>();
    let start = { x: 0, y: 0, at: 0 }; let moved = false; let pinch: { d: number; z: number } | null = null;
    let drag = 0; let dragging = false; let last = { x: 0, y: 0, t: 0 }; let vel = 0; let lastTap = { at: 0, x: 0, y: 0 }; let tapTimer = 0; let pressTimer = 0; let pressed = false;
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
    const ax = () => this.axis();
    const setDrag = (d: number) => {
      drag = d; const a = ax(); const size = a.x ? el.clientWidth : el.clientHeight;
      for (const [i, s] of this.slots) { s.style.transition = 'none'; s.style.transform = `translate(calc(${(i - this.cur) * a.x * 100}% + ${a.x ? d : 0}px), calc(${(i - this.cur) * a.y * 100}% + ${a.y ? d : 0}px))`; }
      void size;
    };
    const down = (e: PointerEvent) => {
      this.ptr = e.pointerType;
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { el.setPointerCapture(e.pointerId); } catch { /* gone */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        moved = false; dragging = false; drag = 0; vel = 0; start = { x: e.clientX, y: e.clientY, at: performance.now() }; last = { x: e.clientX, y: e.clientY, t: start.at };
        pressed = false; clearTimeout(pressTimer);
        this.ptr = e.pointerType;
        pressTimer = window.setTimeout(() => { if (moved || pts.size !== 1) return; pressed = true; this.press(start.x, start.y); }, 550);
      }
      if (pts.size === 2) { pinch = { d: dist(), z: this.z }; moved = true; clearTimeout(pressTimer); if (dragging) { dragging = false; setDrag(0); } }
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      if (pts.size >= 2 && pinch) { const m = mid(); this.zoomTo(pinch.z * (dist() / pinch.d), m.x, m.y, false); return; }
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) { moved = true; clearTimeout(pressTimer); }
      if (!moved) return;
      const now = performance.now(); const a = ax(); const along = a.x ? e.clientX - last.x : e.clientY - last.y;
      vel = along / Math.max(1, now - last.t) * 0.6 + vel * 0.4; last = { x: e.clientX, y: e.clientY, t: now };
      if (dragging) { setDrag(drag + (a.x ? dx : dy)); return; }
      // (Zoomed in, or a page larger than the screen: the finger moves the page; past its edge along the reading
      // axis, the pages themselves — and they turn.)
      if (this.larger() && this.items[this.cur]?.kind === 'page') {
        const bx = this.x, by = this.y; this.x += dx; this.y += dy; this.clamp(); this.applyZoom(false);
        const left = a.x ? dx - (this.x - bx) : dy - (this.y - by);
        if (Math.abs(left) > 2 && Math.abs(a.x ? dx : dy) > Math.abs(a.x ? dy : dx)) { dragging = true; setDrag(left); }
        return;
      }
      const main = a.x ? e.clientX - start.x : e.clientY - start.y, cross = a.x ? e.clientY - start.y : e.clientX - start.x;
      if (Math.abs(main) >= Math.abs(cross)) { dragging = true; setDrag(main); }
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
      if (pts.size) return;
      clearTimeout(pressTimer);
      if (e.type === 'pointercancel') { if (dragging) { dragging = false; this.placeSlots(true); } return; }
      if (dragging) {
        dragging = false; const a = ax(); const size = a.x ? el.clientWidth : el.clientHeight;
        // (A swipe toward the next page's side is a drag against the axis: −.)
        const sign = a.x ? a.x : a.y; const dirOf = (d: number) => (d * sign < 0 ? 1 : -1) as 1 | -1;
        const far = Math.abs(drag) > size * 0.22, flick = Math.abs(vel) > 0.45 && Math.abs(drag) > 24;
        const dir = far ? dirOf(drag) : flick ? dirOf(vel) : 0;
        if (dir && this.cur + dir >= 0 && this.cur + dir < this.items.length) this.goItem(this.cur + dir, true);
        else this.placeSlots(true);
        drag = 0; return;
      }
      if (moved || pressed || performance.now() - start.at > 500) return;
      // A tap: a double tap zooms (in to 2× at that spot, or back out); one alone, once it is sure no second comes,
      // goes to the zones.
      const now = performance.now();
      if (now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        clearTimeout(tapTimer); lastTap.at = 0;
        if (this.items[this.cur]?.kind !== 'page') return;
        if (this.z > 1.01) { this.startPosition(true); this.applyZoom(true); } else this.zoomTo(2, e.clientX, e.clientY, true);
        return;
      }
      lastTap = { at: now, x: e.clientX, y: e.clientY };
      const cx = e.clientX, cy = e.clientY;
      clearTimeout(tapTimer); tapTimer = window.setTimeout(() => this.tap(cx, cy), DOUBLE_TAP_MS);
    };
    // The wheel: zoomed in, it moves the page; with Ctrl, zooms; else a page for each group of notches.
    let wheelAt = 0;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) { this.zoomTo(this.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY, false); return; }
      if (this.z > 1.01) { this.x -= e.deltaX; this.y -= e.deltaY; this.clamp(); this.applyZoom(false); return; }
      const now = performance.now(); const fresh = now - wheelAt > 250; wheelAt = now;
      if (!fresh || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 1) return;
      this.step((e.deltaY || e.deltaX) > 0 ? 1 : -1, { pan: false });
    };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    // (A mouse's right click is the page's menu on a computer; a finger's long press is told by the timer above.)
    const noMenu = (e: MouseEvent) => { e.preventDefault(); if (this.ptr === 'mouse') this.press(e.clientX, e.clientY); }; el.addEventListener('contextmenu', noMenu);
    return () => { clearTimeout(tapTimer); clearTimeout(pressTimer); el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.removeEventListener('wheel', wheel); el.removeEventListener('contextmenu', noMenu); };
  }
  private ptr = 'touch';
  /** A long press (or a right click) at a point: the page's part under it, told. */
  private press(x: number, y: number): void {
    if (this.disposed || this.o.longPress === false) return;
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.cm-part');
    let part: Part | undefined;
    if (el) { const at = el.closest<HTMLElement>('[data-item]'); const it = at ? this.items[Number(at.dataset.item)] : undefined; if (it?.kind === 'page') part = it.parts[Number(el.dataset.i)]; }
    if (!part) { const it = this.items[this.cur]; if (it?.kind === 'page') part = it.parts[0]; }
    if (!part) return;
    this.el.dispatchEvent(new CustomEvent('kr:comic-longpress', { detail: { page: part.page }, bubbles: true }));
    this.host.onLongPress?.({ page: part.page, piece: part.piece, x, y });
  }

  /** A tap at a point of the screen: its zone's step, or the bars. */
  tap(cx: number, cy: number): void {
    if (this.disposed) return;
    const r = this.el.getBoundingClientRect(); const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
    const a = hitZone(this.zones(), fx, fy);
    if (!a) { this.host.onMenu(); return; }
    this.step(stepOf(a, this.rtl));
  }
  /** The zones in force (for the overlay, the tests). */
  zones(): ReturnType<typeof zonesOf> { return zonesOf(this.o.zones, isHorizontal(this.mode), this.o.invert); }

  /* ------------------------------------------------------------ strip */
  private estimate(): number {
    // (A page not measured yet: as tall as the measured ones are on average for their width — a manga page's
    // shape when none is.)
    let n = 0, sum = 0; for (const p of this.host.source.pages) if (p.width && p.height) { n++; sum += p.height / p.width; }
    return n ? sum / n : 1.42;
  }
  private itemHeight(i: number, W: number): number {
    const it = this.items[i]; const H = this.el.clientHeight || 600;
    if (it.kind !== 'page') return Math.round(H * 0.6);
    const pg = this.host.source.pages[it.page];
    const sz = pg.width && pg.height ? pieceSize(it.parts[0].piece, { w: pg.width, h: pg.height }) : null;
    return Math.max(40, Math.round(W * (sz ? sz.h / sz.w : this.estimate())));
  }
  /** The strip's pictures' width as drawn: the screen's, less the side padding, times the zoom. */
  private stripPad(): number { return Math.min(25, Math.max(0, this.o.padding ?? 0)) / 100; }
  private contentWidth(): number { return (this.el.clientWidth || 360) * this.stripZ * (1 - 2 * this.stripPad()); }
  /** Whether a page is drawn as slices: taller than 4096 px at the strip's width (at 1×), or too many pixels for one
   *  decode — drawn by parts, lazily, so nothing is blank or downscaled. */
  private sliced(page: number): boolean {
    const pg = this.host.source.pages[page]; if (!pg.width || !pg.height) return false;
    const wide1 = (this.el.clientWidth || 360) * (1 - 2 * this.stripPad());
    return (wide1 * pg.height) / pg.width > SLICE_AT || pg.width * pg.height > 24e6;
  }
  private sliceHeight(w: number): number { return Math.max(256, Math.min(4096, Math.floor(4e6 / Math.max(1, w)))); }
  private buildStrip(offset: number): void {
    const sc = document.createElement('div'); sc.className = 'cm-scroll';
    const list = document.createElement('div'); list.className = 'cm-list';
    sc.append(list); this.el.append(sc); this.scroller = sc; this.list = list;
    this.el.classList.toggle('cm-gap', this.mode === 5);
    this.blocks = this.items.map((it, i) => {
      const b = document.createElement('div'); b.className = 'cm-block'; b.dataset.item = String(i);
      if (it.kind === 'page') b.dataset.page = String(it.page);
      else { b.classList.add('cm-between'); const inner = it.kind === 'before' ? this.host.before() : this.host.after(); if (inner) b.append(inner); }
      list.append(b); return b;
    });
    this.stripZ = 1; this.lastStripItem = -1; this.measureStrip(false);
    this.stripGo(this.cur, offset, false);
    const onScroll = () => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.syncStrip()); };
    sc.addEventListener('scroll', onScroll, { passive: true });
    const off = this.stripGestures();
    this.offGestures = () => { sc.removeEventListener('scroll', onScroll); off(); };
    this.syncStrip();
  }
  /** Every block's height from what is known now; the place on the screen kept where it was. */
  private measureStrip(keep = true): void {
    const sc = this.scroller; if (!sc) return;
    const full = (this.el.clientWidth || 360) * this.stripZ; const W = this.contentWidth(); const gap = this.mode === 5 ? GAP * this.stripZ : 0;
    const anchor = keep ? this.stripPlace() : null;
    // (Narrower than the screen when zoomed out: centred.)
    this.list!.style.width = `${full}px`; this.list!.style.paddingInline = `${(full - W) / 2}px`; this.list!.style.boxSizing = 'border-box'; this.list!.style.marginInline = full < (this.el.clientWidth || 360) ? 'auto' : '0';
    this.heights = this.items.map((_, i) => this.itemHeight(i, W));
    this.blocks.forEach((b, i) => { b.style.height = `${this.heights[i]}px`; b.style.marginBottom = i < this.blocks.length - 1 ? `${gap}px` : '0'; });
    if (anchor) this.stripGo(anchor.item, anchor.offset, false, true);
  }
  private tops(): number[] { const gap = this.mode === 5 ? GAP * this.stripZ : 0; const out: number[] = []; let y = 0; for (const h of this.heights) { out.push(y); y += h + gap; } return out; }
  /** The item at the screen's top edge and how far through it the screen begins (0–1). */
  private stripPlace(): { item: number; offset: number } {
    const sc = this.scroller!; const tops = this.tops(); const y = sc.scrollTop;
    let i = 0; while (i + 1 < tops.length && tops[i + 1] <= y) i++;
    return { item: i, offset: this.heights[i] ? Math.min(1, Math.max(0, (y - tops[i]) / this.heights[i])) : 0 };
  }
  private stripGo(i: number, offset: number, smooth: boolean, quiet = false): void {
    const sc = this.scroller; if (!sc) return;
    i = Math.max(0, Math.min(this.items.length - 1, i));
    const top = this.tops()[i] + offset * (this.heights[i] ?? 0);
    const max = sc.scrollHeight - sc.clientHeight;
    const to = offset >= 1 && i === this.items.length - 1 ? max : Math.min(max, top);
    if (smooth) sc.scrollTo({ top: to, behavior: 'smooth' }); else sc.scrollTop = to;
    if (!quiet) this.syncStrip();
  }
  private stripStep(dir: 1 | -1): void {
    const sc = this.scroller; if (!sc) return;
    // (As the reference reader scrolls its strip: three quarters of the screen.)
    const by = sc.clientHeight * 0.75 * dir;
    if (this.o.transitions) sc.scrollBy({ top: by, behavior: 'smooth' }); else { sc.scrollTop += by; this.syncStrip(); }
  }
  /** The pictures near the screen put in, the others taken out; the item shown told. */
  private syncStrip(): void {
    const sc = this.scroller; if (!sc || this.disposed) return;
    const tops = this.tops(); const y0 = sc.scrollTop, y1 = y0 + sc.clientHeight; const margin = sc.clientHeight;
    let first = 0; while (first + 1 < tops.length && tops[first + 1] <= y0 - margin) first++;
    let last = first; while (last + 1 < tops.length && tops[last + 1] < y1 + margin) last++;
    const want = new Set<number>(); for (let i = first; i <= last; i++) want.add(i);
    const pages: number[] = [];
    this.blocks.forEach((b, i) => {
      const it = this.items[i]; if (it.kind !== 'page') return;
      const has = b.firstElementChild as HTMLElement | null;
      if (want.has(i)) {
        pages.push(it.page); if (!has) this.fillBlock(b, it);
        if (this.sliced(it.page)) this.syncSlices(b, it, tops[i], y0, y1, margin);
      } else if (has) { this.dropSlices(b); b.replaceChildren(); this.sliceBlobs.delete(it.page); }
    });
    this.host.source.keepNear(pages.length ? pages : [this.page], 0);
    // The item shown: the one across the screen's middle (the last at the very end).
    const mid = y0 + sc.clientHeight / 2; let cur = 0; while (cur + 1 < tops.length && tops[cur + 1] <= mid) cur++;
    if (y0 >= sc.scrollHeight - sc.clientHeight - 2) cur = this.items.length - 1;
    if (y0 <= 1) cur = 0;
    // (At the very top the volume's first page counts — not the page before the volume — unless it is all one sees.)
    if (cur === 0 && this.items[0]?.kind === 'before' && tops[1] !== undefined && tops[1] < y0 + sc.clientHeight / 2) cur = 1;
    if (cur !== this.cur || this.lastStripItem < 0) { this.cur = cur; this.lastStripItem = cur; this.emit(); }
    else this.emitOffset();
  }
  private fillBlock(b: HTMLElement, it: PageItem): void {
    const known = this.host.source.pages[it.page];
    if (!(known.width && known.height)) {
      // (Its size first — from the header — so a very tall picture is never decoded whole to find out it is one.)
      if (b.dataset.pending) return; b.dataset.pending = '1';
      void this.host.source.size(it.page).catch(() => undefined).then(() => { delete b.dataset.pending; if (this.disposed || !this.scroller) return; this.measureStrip(); this.syncStrip(); });
      return;
    }
    if (this.sliced(it.page)) {
      // (A very tall picture: a slot for each slice; the pictures come into them as they near the screen.)
      const pg = this.host.source.pages[it.page]; const sh = this.sliceHeight(pg.width!); const n = Math.ceil(pg.height! / sh);
      const box = document.createElement('div'); box.className = 'cm-piece cm-sliced'; box.dataset.page = String(it.page); box.style.width = '100%'; box.style.height = '100%';
      for (let j = 0; j < n; j++) { const slot = document.createElement('div'); slot.className = 'cm-slice'; slot.dataset.slice = String(j); const top = j * sh, hh = Math.min(sh, pg.height! - top); slot.style.top = `${(top / pg.height!) * 100}%`; slot.style.height = `${(hh / pg.height!) * 100}%`; box.append(slot); }
      const part = document.createElement('div'); part.className = 'cm-part'; part.dataset.page = String(it.page); part.dataset.k = '0'; part.dataset.i = '0'; part.style.cssText = 'left:0;top:0;width:100%;height:100%'; part.append(...box.childNodes); box.append(part);
      b.append(box);
      return;
    }
    const box = this.pieceEl(it, true); box.style.width = '100%'; box.style.height = '100%';
    b.append(box);
  }
  /** The slices near the screen drawn, the others let go. */
  private syncSlices(b: HTMLElement, it: PageItem, top: number, y0: number, y1: number, margin: number): void {
    const pg = this.host.source.pages[it.page]; const hBlock = b.clientHeight || 1; const sh = this.sliceHeight(pg.width!);
    b.querySelectorAll<HTMLElement>('.cm-slice').forEach((slot) => {
      const j = Number(slot.dataset.slice); const a = top + ((j * sh) / pg.height!) * hBlock, z = a + (Math.min(sh, pg.height! - j * sh) / pg.height!) * hBlock;
      const near = z > y0 - margin && a < y1 + margin; const has = !!slot.firstElementChild || slot.dataset.busy === '1';
      if (near && !has) void this.drawSlice(it.page, j, slot);
      else if (!near && has) this.dropSlice(slot);
    });
  }
  private dropSlices(b: HTMLElement): void { b.querySelectorAll<HTMLElement>('.cm-slice').forEach((s) => this.dropSlice(s)); }
  private dropSlice(slot: HTMLElement): void {
    const c = slot.firstElementChild as HTMLCanvasElement | null; slot.dataset.busy = '0'; slot.dataset.gone = String(Number(slot.dataset.gone ?? 0) + 1);
    if (c) { this.slicePx -= c.width * c.height; c.width = c.height = 0; c.remove(); }
  }
  /** One slice: its rectangle of the picture decoded on its own (the browser keeps no more of it than the rectangle) and
   *  drawn at its own size on a canvas — one decode at a time. */
  private drawSlice(page: number, j: number, slot: HTMLElement): Promise<void> {
    slot.dataset.busy = '1'; const stamp = slot.dataset.gone ?? '0';
    const run = async () => {
      if (this.disposed || slot.dataset.busy !== '1' || (slot.dataset.gone ?? '0') !== stamp || !slot.isConnected) return;
      const pg = this.host.source.pages[page]; const sh = this.sliceHeight(pg.width!); const y = j * sh, hh = Math.min(sh, pg.height! - y);
      let blob = this.sliceBlobs.get(page); if (!blob) { blob = pg.blob(); this.sliceBlobs.set(page, blob); }
      try {
        const bmp = await createImageBitmap(await blob, 0, y, pg.width!, hh);
        if (this.disposed || slot.dataset.busy !== '1' || (slot.dataset.gone ?? '0') !== stamp || !slot.isConnected) { bmp.close(); return; }
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.className = 'cm-slice-img'; c.getContext('2d')!.drawImage(bmp, 0, 0); bmp.close();
        slot.append(c); slot.dataset.busy = '0'; this.slicePx += c.width * c.height; this.slicePeakPx = Math.max(this.slicePeakPx, this.slicePx); this.sliceDrawn++;
      } catch { slot.dataset.busy = '0'; }
    };
    const next = this.sliceQ.then(run, run); this.sliceQ = next; return next;
  }
  private setStripZoom(z: number, cx: number, cy: number): void {
    const sc = this.scroller; if (!sc) return;
    // (Zooming out shrinks the strip to half the width, as the reference reader's does, unless that is turned off.)
    z = Math.min(STRIP_MAX, Math.max(this.o.noZoomOut ? 1 : 0.5, z)); if (Math.abs(z - this.stripZ) < 0.001) return;
    const r = sc.getBoundingClientRect(); const px = cx - r.left, py = cy - r.top;
    const k = z / this.stripZ; const left = (sc.scrollLeft + px) * k - px, top = (sc.scrollTop + py) * k - py;
    this.stripZ = z; this.measureStrip(false);
    sc.scrollLeft = left; sc.scrollTop = top;
    this.el.classList.toggle('cm-zoomed', z > 1.01);
    this.syncStrip();
  }
  private stripGestures(): () => void {
    const sc = this.scroller!; const pts = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; z: number } | null = null; let start = { x: 0, y: 0, at: 0 }; let moved = false; let lastTap = { at: 0, x: 0, y: 0 }; let tapTimer = 0; let pressTimer = 0; let pressed = false;
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    const down = (e: PointerEvent) => {
      this.ptr = e.pointerType;
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        moved = false; pressed = false; start = { x: e.clientX, y: e.clientY, at: performance.now() };
        clearTimeout(pressTimer);
        this.ptr = e.pointerType;
        pressTimer = window.setTimeout(() => { if (moved || pts.size !== 1) return; pressed = true; this.press(start.x, start.y); }, 550);
      }
      if (pts.size === 2) { pinch = { d: dist(), z: this.stripZ }; moved = true; clearTimeout(pressTimer); }
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId); if (!p) return; p.x = e.clientX; p.y = e.clientY;
      if (pts.size >= 2 && pinch && this.o.stripZoom) { const [a, b] = [...pts.values()]; this.setStripZoom(pinch.z * (dist() / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2); return; }
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) { moved = true; clearTimeout(pressTimer); }
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (pts.size || e.type === 'pointercancel') return;
      clearTimeout(pressTimer);
      if (moved || pressed || performance.now() - start.at > 500) return;
      const now = performance.now(); const cx = e.clientX, cy = e.clientY;
      if (this.o.stripZoom && now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(cx - lastTap.x, cy - lastTap.y) < 40) {
        clearTimeout(tapTimer); lastTap.at = 0;
        this.setStripZoom(this.stripZ > 1.01 ? 1 : 2, cx, cy);
        return;
      }
      lastTap = { at: now, x: cx, y: cy };
      clearTimeout(tapTimer); tapTimer = window.setTimeout(() => this.tap(cx, cy), this.o.stripZoom ? DOUBLE_TAP_MS : 0);
    };
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey) return; e.preventDefault(); this.setStripZoom(this.stripZ * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); };
    sc.addEventListener('pointerdown', down); sc.addEventListener('pointermove', move); sc.addEventListener('pointerup', up); sc.addEventListener('pointercancel', up);
    sc.addEventListener('wheel', wheel, { passive: false });
    const noMenu = (e: MouseEvent) => { e.preventDefault(); if (this.ptr === 'mouse') this.press(e.clientX, e.clientY); }; sc.addEventListener('contextmenu', noMenu);
    return () => { clearTimeout(tapTimer); clearTimeout(pressTimer); sc.removeEventListener('pointerdown', down); sc.removeEventListener('pointermove', move); sc.removeEventListener('pointerup', up); sc.removeEventListener('pointercancel', up); sc.removeEventListener('wheel', wheel); sc.removeEventListener('contextmenu', noMenu); };
  }

  /* ------------------------------------------------------------ both */
  private relayout(): void {
    if (this.disposed) return;
    if (this.strip) { this.measureStrip(); this.syncStrip(); return; }
    // (The screen turned on its side: the pairing «on wide screens» may be on, or off, now.)
    if (this.pairing() !== this.builtPairing) { this.build(this.page); return; }
    for (const [i, s] of this.slots) { const it = this.items[i]; if (it.kind === 'page') this.fitSlot(s, it); }
    this.startPosition(true); this.applyZoom(false);
  }
  /** How far through the current page the screen is (the strip; 0 one page per screen). */
  offset(): number { return this.strip && this.scroller ? this.stripPlace().offset : 0; }
  private emit(): void {
    const it = this.items[this.cur]; const at = this.starts.at[this.cur] ?? 0;
    const shown = it?.kind === 'page' ? at + 1 : it?.kind === 'before' ? 1 : this.starts.total;
    this.host.onChange({ item: this.cur, page: this.page, kind: it?.kind ?? 'page', total: this.total, offset: this.offset(), shown, shownEnd: it?.kind === 'page' ? at + it.parts.length : shown, shownTotal: this.starts.total });
    const b = this.borders.get(this.page); if (b) this.host.onBackground?.(b.edge);
  }
  /** The borders measured for a page (for the tests and the page's menu), if they were. */
  borderOf(page: number): Border | undefined { return this.borders.get(page); }
  /** The pieces shown for a page now (for the tests): its crop rectangle and turn, one per shown part. */
  piecesOf(page: number): Part[] { return this.items.flatMap((i) => (i.kind === 'page' ? i.parts.filter((x) => x.page === page) : [])); }
  /** Pictures drawn as slices now: live, most at once, pixels now and at most (for the tests). */
  sliceStats(): { live: number; px: number; peakPx: number; drawn: number } { return { live: this.el.querySelectorAll('.cm-slice > canvas').length, px: this.slicePx, peakPx: this.slicePeakPx, drawn: this.sliceDrawn }; }
  private emitOffset(): void { /* (the place within the page is read when it is saved) */ }
  /** Pictures that hold a decoded image now (for tests): the viewer's <img> elements with a picture. */
  decoded(): number { return this.el.querySelectorAll('img.cm-img[src]').length; }
  /** The drawn size and place of the current page (for tests). */
  drawn(): { w: number; h: number; x: number; y: number; z: number } {
    if (this.strip) { const b = this.blocks[this.cur]; const r = b?.getBoundingClientRect(); return { w: r?.width ?? 0, h: r?.height ?? 0, x: 0, y: 0, z: this.stripZ }; }
    return { w: this.bw * this.z, h: this.bh * this.z, x: this.x, y: this.y, z: this.z };
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    clearTimeout(this.landscapeTimer); cancelAnimationFrame(this.raf); clearTimeout(this.rebuildTimer); this.sizing++;
    this.offGestures?.(); this.cleanups.splice(0).forEach((f) => f());
    this.el.remove();
  }
}
