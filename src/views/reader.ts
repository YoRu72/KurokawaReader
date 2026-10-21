// The reading surface. Flow documents (EPUB, DOCX, TXT, …) are rendered one
// after another into a single scroll — that is what "read together" means —
// while PDFs get the page-based viewer.
import { h, icon, iconButton, toast, clear, throttle } from '../ui/dom';
import { t, isRtlText, isTouchDevice, getLang, localDigits } from '../i18n';
import { db, uid, type Book, type Locator, type Bookmark, type Highlight } from '../db';
import { flowHandlerFor } from '../formats';
import type { FlowRender, ImageRef, TocItem } from '../formats/types';
import { normalizeForSearch } from '../formats/types';
import { BLOCK_SELECTOR } from '../formats/shared';
import { PdfViewer, type PdfSearchHit } from '../formats/pdf';
import { applySettings, getSettings, onSettingsChange, updateSettings } from '../settings';
import { SidePanel } from '../ui/panel';
import { renderOptions } from '../ui/options';
import { attachSelectionToolbar, wrapRange, findTextRange, HIGHLIGHT_COLORS } from '../ui/selection';
import { openGallery } from './gallery';
import { touchBook, coverUrl } from '../library';
import { navigate } from '../router';
import { ReadingTracker, countWords } from '../stats';
import { showBookInfo } from '../ui/bookinfo';
import { renderTextCanvas, showSnapshot } from '../ui/textcard';
import { exportNotes } from '../ui/exportnotes';
import { attachEdgeBrightness } from '../ui/brightness';
import { shareFile, canvasToBlob, saveImage, copyImage } from '../ui/share';
import { applyOrientation } from '../settings';
import { setImmersive, keepAwake } from '../native';
import type { HighlightColor } from '../ui/selection';
import { openSheet } from '../ui/dom';

interface OpenDoc {
  book: Book;
  wrapper: HTMLElement;      // .kr-doc
  render?: FlowRender;
  blocks: HTMLElement[];     // blocks currently visible (chapter mode shows one chapter)
  allBlocks: HTMLElement[];
  chapters: HTMLElement[];   // chapter sections (one entry = whole content when the format has none)
  chapter: number;
}

interface SearchHit { bookId: string; label: string; before: string; match: string; after: string; range: Range }

export function readerView(ids: string[]): HTMLElement {
  const root = h('div', { class: 'view reader-view' });
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const onDispose = (fn: () => void) => cleanups.push(fn);

  void (async () => {
    const books = (await Promise.all(ids.map((id) => db.getBook(id)))).filter((b): b is Book => !!b);
    if (disposed) return;
    if (!books.length) { navigate('/', true); return; }
    const pdfs = books.filter((b) => b.format === 'pdf');
    const flows = books.filter((b) => b.format !== 'pdf');
    if (pdfs.length && (flows.length || pdfs.length > 1)) toast(t('fmtPdf') + ' · ' + t('open'), 'info', 3000);
    if (pdfs.length && !flows.length) await mountPdf(root, pdfs[0], onDispose);
    else await mountFlow(root, flows.length ? flows : pdfs, onDispose);
  })().catch((err) => { console.error(err); toast(t('openError', { error: String((err as Error)?.message ?? err) }), 'error', 6000); });

  (root as HTMLElement & { dispose?: () => void }).dispose = () => { disposed = true; cleanups.forEach((fn) => fn()); };
  return root;
}

/* ------------------------------------------------------------------ */
/* Flow reader                                                         */
/* ------------------------------------------------------------------ */

async function mountFlow(root: HTMLElement, books: Book[], onDispose: (fn: () => void) => void): Promise<void> {
  const reader = h('div', { class: 'reader' });
  applySettings(reader);
  const syncComfort = () => { const st = getComputedStyle(reader); root.style.setProperty('--r-warmth', st.getPropertyValue('--r-warmth')); root.style.setProperty('--r-dim-overlay', st.getPropertyValue('--r-dim-overlay')); };
  queueMicrotask(syncComfort);
  const flow = h('div', { class: 'reader-flow' });
  const scroll = h('div', { class: 'reader-scroll', tabindex: '0' }, flow);
  const footerBar = h('i');
  const footerWhere = h('span', { class: 'where' });
  const footerPct = h('span', { class: 'pct' });
  const footer = h('div', { class: 'read-footer' }, footerWhere, h('div', { class: 'bar' }, footerBar), footerPct);
  const statusWhere = h('span', { class: 'where' });
  const statusPage = h('span', { class: 'pg' });
  const statusClock = h('span', { class: 'clock' });
  const statusBatt = h('span', { class: 'batt' });
  const statusPct = h('span', { class: 'pct' });
  const statusBar = h('div', { class: 'read-status' }, statusWhere, statusPage, h('span', { class: 'sp' }), statusClock, statusBatt, statusPct);
  const tickClock = () => {
    const d = new Date();
    if (getLang() === 'ar') { const h = d.getHours(); statusClock.textContent = localDigits(`${((h + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')}`) + (h >= 12 ? ' مساءً' : ' صباحًا'); }
    else statusClock.textContent = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d);
  };
  statusBar.hidden = !getSettings().showStatusLine;
  tickClock(); const clockTimer = window.setInterval(tickClock, 15000); onDispose(() => window.clearInterval(clockTimer));
  (navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener(t: string, f: () => void): void }> }).getBattery?.().then((b) => { const paint = () => { statusBatt.textContent = `${localDigits(Math.round(b.level * 100))}%`; }; paint(); b.addEventListener('levelchange', paint); }).catch(() => undefined);
  const title = h('div', { class: 'title' });
  const panel = new SidePanel(root);

  const topbar = h('header', { class: 'topbar' },
    iconButton('back', t('back'), () => navigate('/')),
    title,
    iconButton('fullscreen', t('fullscreen'), () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); }),
  );
  // M3 Expressive floating toolbar carries the reading actions.
  const toolbar = h('nav', { class: 'float-toolbar', 'aria-label': t('more') },
    iconButton('toc', t('contents'), () => openContents('toc')),
    iconButton('search', t('searchInBook'), () => openSearch()),
    iconButton('images', t('images'), () => showGallery()),
    iconButton('bookmarkAdd', t('addBookmark'), () => addBookmark()),
    h('span', { class: 'sep' }),
    iconButton('type', t('visualOptions'), () => openOptions()),
    iconButton('more', t('more'), () => openMore()),
  );
  reader.append(scroll);
  const chapterNav = h('nav', { class: 'chapter-nav', hidden: true });
  root.append(topbar, reader, footer, statusBar, toolbar, h('div', { class: 'reader-comfort', 'aria-hidden': 'true' }));
  const chapterMode = () => getSettings().readingMode === 'chapters';
  root.append(h('div', { class: 'center', id: 'kr-loading' }, h('div', { class: 'spinner' }), t('loading')));

  const docs: OpenDoc[] = [];
  let lastTracked: { doc: OpenDoc; block: number } | null = null;
  // Late-bound hooks so chapter navigation can run before the chrome helpers are defined.
  const hooks = { update: () => undefined as void, save: () => undefined as void };
  const settings = getSettings();
  let allImages: ImageRef[] = [];
  let saveTimer: number | undefined;
  let userScrolled = false;

  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    const wrapper = h('section', { class: 'kr-doc', dataset: { book: book.id }, id: `doc-${book.id}` });
    const cover = coverUrl(book);
    if (books.length > 1) {
      wrapper.append(h('header', { class: 'kr-doc-head' }, h('span', { class: 'n' }, String(i + 1)), cover ? h('img', { src: cover, alt: '' }) : null,
        h('div', null, h('div', { class: 't', dir: 'auto' }, book.title), book.author ? h('span', { class: 'a', dir: 'auto' }, book.author) : null)));
    }
    flow.append(wrapper);
    docs.push({ book, wrapper, blocks: [], allBlocks: [], chapters: [], chapter: 0 });
  }
  flow.append(chapterNav);

  async function renderDoc(doc: OpenDoc): Promise<void> {
    const handler = flowHandlerFor(doc.book.format);
    const file = await db.getFile(doc.book.id);
    if (!handler || !file) { doc.wrapper.append(h('p', { class: 'kr-content' }, t('unsupportedFormat'))); return; }
    const ctx = { bookId: doc.book.id, bookTitle: doc.book.title, publisherStyles: getSettings().publisherStyles, id: (s: string) => `${doc.book.id}-${s}` };
    try {
      doc.render?.dispose();
      doc.wrapper.querySelector('.kr-content')?.remove();
      doc.render = await handler.render(file, ctx);
      doc.wrapper.append(doc.render.element);
      doc.allBlocks = [...doc.render.element.querySelectorAll<HTMLElement>(`${BLOCK_SELECTOR}, img`)].filter((b) => !b.closest('table') || b.tagName === 'TD' || b.tagName === 'TH');
      const sections = [...doc.render.element.querySelectorAll<HTMLElement>(':scope > .kr-chapter')].filter((c) => (c.textContent ?? '').trim().length > 0 || c.querySelector('img'));
      doc.chapters = sections.length > 1 ? sections : [doc.render.element];
      doc.chapter = 0;
      doc.blocks = doc.allBlocks;
      applyHighlights(doc);
    } catch (err) {
      console.error(err);
      doc.wrapper.append(h('p', { class: 'kr-content' }, t('openError', { error: String((err as Error)?.message ?? err) })));
    }
  }

  // Render books in order so the first one appears quickly.
  for (const doc of docs) { await renderDoc(doc); if (doc === docs[0]) { root.querySelector('#kr-loading')?.remove(); restore(); } }
  root.querySelector('#kr-loading')?.remove();
  allImages = docs.flatMap((d) => d.render?.images ?? []);
  books.forEach((b) => void touchBook(b.id));
  void applyOrientation();
  if (getSettings().hideSystemBars) void setImmersive(true);
  keepAwake(getSettings().keepAwake);
  onDispose(() => { void setImmersive(false); keepAwake(false); });
  // Reading statistics: words per block, tracked as the reader scrolls past them.
  const wordsOf = new WeakMap<HTMLElement, number>();
  const wordCount = (b: HTMLElement): number => { let w = wordsOf.get(b); if (w === undefined) { w = b.tagName === 'IMG' ? 0 : countWords(b.textContent ?? ''); wordsOf.set(b, w); } return w; };
  const trackers = new Map<OpenDoc, ReadingTracker>();
  for (const doc of docs) {
    const total = doc.allBlocks.reduce((a, b) => a + wordCount(b), 0);
    const chars = (doc.render?.element.textContent ?? '').replace(/\s+/g, '').length;
    const tr = new ReadingTracker(doc.book, () => currentLocator()?.doc === doc, total, chars);
    tr.start();
    trackers.set(doc, tr);
  }
  const trackProgress = () => {
    const cur = currentLocator();
    if (!cur) return;
    const tr = trackers.get(cur.doc); const blocks = cur.doc.blocks;
    const block = cur.loc.block ?? 0;
    let passed = 0;
    if (lastTracked && lastTracked.doc === cur.doc && block > lastTracked.block && block - lastTracked.block < 60) for (let i = lastTracked.block; i < block; i++) passed += wordCount(blocks[i]);
    tr?.advance(passed, cur.loc.pct);
    lastTracked = { doc: cur.doc, block };
  };
  onDispose(() => { trackers.forEach((tr) => void tr.stop()); });
  if (books.length > 1) toast(t('openedTogether', { n: books.length }));
  restore();
  // Images loading above the saved position shift the layout; settle a few times.
  [400, 1200, 2500].forEach((ms) => setTimeout(() => { if (!userScrolled) restore(); }, ms));

  /* ---------- chapter mode ---------- */
  interface Unit { doc: OpenDoc; el: HTMLElement; index: number }
  const units = (): Unit[] => docs.flatMap((doc) => doc.chapters.map((el, index) => ({ doc, el, index })));
  const chapterTitle = (u: Unit): string => {
    const toc = u.doc.render?.toc ?? [];
    const hit = toc.find((item) => { const el = document.getElementById(item.anchor); return !!el && (el === u.el || u.el.contains(el)); });
    return hit?.label ?? u.el.querySelector('h1, h2, h3')?.textContent?.trim() ?? `${t('chapter')} ${u.index + 1}`;
  };
  function currentUnitIndex(): number {
    const cur = currentLocator();
    const list = units();
    const doc = cur?.doc ?? docs[0];
    return Math.max(0, list.findIndex((u) => u.doc === doc && u.index === doc.chapter));
  }
  function applyLayoutMode(): void {
    const on = chapterMode();
    for (const doc of docs) {
      const multi = doc.chapters.length > 1;
      doc.chapters.forEach((c, i) => { c.hidden = on && multi && i !== doc.chapter; });
      doc.blocks = on && multi ? doc.allBlocks.filter((b) => doc.chapters[doc.chapter].contains(b)) : doc.allBlocks;
      doc.wrapper.hidden = false;
    }
    if (on && docs.length > 1) {
      // One book at a time: the others are hidden until the chain reaches them.
      const k = currentUnitIndex(); const u = units()[k];
      for (const doc of docs) doc.wrapper.hidden = doc !== u?.doc;
    }
    renderChapterNav();
  }
  function renderChapterNav(): void {
    clear(chapterNav);
    const list = units();
    chapterNav.hidden = !chapterMode() || list.length <= 1;
    if (chapterNav.hidden) return;
    const k = currentUnitIndex();
    const prev = list[k - 1], next = list[k + 1];
    chapterNav.append(
      prev ? h('button', { type: 'button', class: 'cn-btn', onclick: () => showUnit(k - 1) }, icon('chevronLeft'), h('span', { dir: 'auto' }, h('small', null, t('prevChapter')), chapterTitle(prev))) : h('span'),
      next ? h('button', { type: 'button', class: 'cn-btn primary', onclick: () => showUnit(k + 1) }, h('span', { dir: 'auto' }, h('small', null, t('nextChapter')), chapterTitle(next)), icon('chevronRight')) : h('span', { class: 'end' }, t('endOfBook')),
    );
  }
  function showUnit(k: number, atEnd = false): void {
    const list = units();
    const u = list[Math.max(0, Math.min(list.length - 1, k))];
    if (!u) return;
    u.doc.chapter = u.index;
    for (const doc of docs) { doc.wrapper.hidden = docs.length > 1 && doc !== u.doc; doc.chapters.forEach((c, i) => { c.hidden = doc.chapters.length > 1 && i !== doc.chapter; }); doc.blocks = doc.chapters.length > 1 ? doc.allBlocks.filter((b) => doc.chapters[doc.chapter].contains(b)) : doc.allBlocks; }
    renderChapterNav();
    scroll.scrollTop = atEnd ? scroll.scrollHeight : 0;
    lastTracked = null;
    hooks.update(); hooks.save();
  }
  /** Make sure the element's chapter is on screen (chapter mode) before scrolling to it. */
  function revealElement(el: Element): void {
    if (!chapterMode()) return;
    const list = units();
    const k = list.findIndex((u) => u.el === el || u.el.contains(el));
    if (k >= 0 && (list[k].doc.chapter !== list[k].index || list[k].doc.wrapper.hidden)) showUnit(k);
  }
  // Swipe between chapters on touch screens.
  let swipe: { x: number; y: number; t: number } | null = null;
  scroll.addEventListener('touchstart', (e) => { const tch = e.touches[0]; swipe = { x: tch.clientX, y: tch.clientY, t: Date.now() }; }, { passive: true });
  scroll.addEventListener('touchend', (e) => {
    if (!swipe || !chapterMode()) return;
    const tch = e.changedTouches[0]; const dx = tch.clientX - swipe.x, dy = tch.clientY - swipe.y; swipe = null;
    if (Math.abs(dx) < 90 || Math.abs(dy) > 60 || document.getSelection()?.isCollapsed === false) return;
    const rtl = (docs.find((d) => !d.wrapper.hidden)?.render?.rtl ?? false);
    const forward = rtl ? dx > 0 : dx < 0;
    const k = currentUnitIndex();
    showUnit(forward ? k + 1 : k - 1, !forward);
  }, { passive: true });

  /* ---------- position & progress ---------- */

  function docAt(y: number): OpenDoc | undefined {
    const sr = scroll.getBoundingClientRect();
    for (const d of docs) {
      const r = d.wrapper.getBoundingClientRect();
      if (r.bottom - sr.top > y) return d;
    }
    return docs[docs.length - 1];
  }

  function currentLocator(): { doc: OpenDoc; loc: Locator } | null {
    const probeY = 8;
    const doc = docAt(probeY);
    if (!doc) return null;
    const sr = scroll.getBoundingClientRect();
    const blocks = doc.blocks;
    // Binary search for the first block whose bottom is below the probe line.
    let lo = 0, hi = blocks.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      const r = blocks[m].getBoundingClientRect();
      if (r.bottom - sr.top <= probeY) lo = m + 1; else hi = m;
    }
    const block = blocks[lo];
    const rect = block?.getBoundingClientRect();
    const offset = rect ? Math.min(1, Math.max(0, (sr.top + probeY - rect.top) / Math.max(1, rect.height))) : 0;
    const wr = doc.wrapper.getBoundingClientRect();
    let pct = Math.min(1, Math.max(0, (sr.top - wr.top + probeY) / Math.max(1, wr.height - sr.height * 0.5)));
    if (chapterMode() && doc.chapters.length > 1) {
      const cr = doc.chapters[doc.chapter].getBoundingClientRect();
      const within = Math.min(1, Math.max(0, (sr.top - cr.top + probeY) / Math.max(1, cr.height - sr.height * 0.5)));
      pct = (doc.chapter + within) / doc.chapters.length;
    }
    return { doc, loc: { bookId: doc.book.id, block: lo, offset, pct, chapter: doc.chapter } };
  }

  function scrollToLocator(loc: Locator): void {
    const doc = docs.find((d) => d.book.id === loc.bookId) ?? docs[0];
    if (!doc) return;
    if (loc.anchor) { scrollToAnchor(loc.anchor); return; }
    if (chapterMode() && doc.chapters.length > 1) {
      const ch = Math.min(doc.chapters.length - 1, loc.chapter ?? 0);
      if (ch !== doc.chapter || doc.wrapper.hidden) { const k = units().findIndex((u) => u.doc === doc && u.index === ch); if (k >= 0) showUnit(k); }
    }
    const sr = scroll.getBoundingClientRect();
    const block = doc.blocks[loc.block ?? 0];
    if (block) {
      const r = block.getBoundingClientRect();
      scroll.scrollTop += r.top - sr.top - 8 + (loc.offset ?? 0) * r.height;
    } else {
      const wr = doc.wrapper.getBoundingClientRect();
      scroll.scrollTop += wr.top - sr.top + (loc.pct ?? 0) * wr.height;
    }
  }

  function scrollToAnchor(anchor: string, flash = true): void {
    const el = document.getElementById(anchor);
    if (!el) return;
    revealElement(el);
    el.dispatchEvent(new CustomEvent('kr-reveal', { bubbles: true, detail: anchor }));
    const sr = scroll.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    scroll.scrollTop += r.top - sr.top - 12;
    if (flash) { el.classList.add('kr-flash'); setTimeout(() => el.classList.remove('kr-flash'), 1600); }
    scheduleSave();
  }

  function restore(): void {
    const first = docs[0];
    if (!first) return;
    const p = first.book.progress;
    if (p && p.bookId === first.book.id) scrollToLocator(p);
  }

  function labelFor(doc: OpenDoc, blockIdx: number): string {
    const toc = doc.render?.toc ?? [];
    if (!toc.length) return doc.book.title;
    const block = doc.blocks[blockIdx];
    if (!block) return doc.book.title;
    let best = '';
    for (const item of toc) {
      const el = document.getElementById(item.anchor);
      if (!el) continue;
      if (el.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING || el === block || el.contains(block)) best = item.label; else break;
    }
    return best || doc.book.title;
  }

  const updateChrome = throttle(() => {
    const cur = currentLocator();
    if (!cur) return;
    const label = labelFor(cur.doc, cur.loc.block ?? 0);
    clear(title);
    title.append(document.createTextNode(cur.doc.book.title), h('small', { dir: 'auto' }, label !== cur.doc.book.title ? label : (cur.doc.book.author ?? '')));
    title.setAttribute('dir', 'auto');
    footerWhere.textContent = docs.length > 1 ? `${docs.indexOf(cur.doc) + 1}/${docs.length} · ${label}` : label;
    footerWhere.setAttribute('dir', 'auto');
    const pct = Math.round(cur.loc.pct * 100);
    footerPct.textContent = `${localDigits(pct)}%`;
    footerBar.style.width = `${pct}%`;
    // Moon+-style status line: chapter · screen x/y · clock · battery · %
    statusWhere.textContent = label; statusWhere.setAttribute('dir', 'auto');
    const unitEl = cur.doc.chapters[cur.doc.chapter] ?? cur.doc.wrapper;
    const sr = scroll.getBoundingClientRect(); const ur = unitEl.getBoundingClientRect();
    const total = Math.max(1, Math.ceil(ur.height / Math.max(1, sr.height)));
    const page = Math.min(total, Math.max(1, Math.floor((sr.top - ur.top) / Math.max(1, sr.height)) + 1));
    statusPage.textContent = `(${localDigits(page)}/${localDigits(total)})`;
    statusPct.textContent = `${localDigits(pct)}%`;
  }, 150);

  function scheduleSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveProgress, 600);
  }
  async function saveProgress(): Promise<void> {
    const cur = currentLocator();
    if (!cur) return;
    await db.updateBook(cur.doc.book.id, (b) => { b.progress = cur.loc; });
    cur.doc.book.progress = cur.loc;
    // Books fully scrolled past count as finished.
    for (const d of docs) if (d !== cur.doc && docs.indexOf(d) < docs.indexOf(cur.doc) && (d.book.progress?.pct ?? 0) < 1) { d.book.progress = { bookId: d.book.id, pct: 1 }; await db.updateBook(d.book.id, (b) => { b.progress = d.book.progress; }); }
  }

  hooks.update = () => updateChrome();
  hooks.save = () => scheduleSave();
  const trackThrottled = throttle(trackProgress, 400);
  scroll.addEventListener('scroll', () => { userScrolled = true; updateChrome(); scheduleSave(); trackThrottled(); }, { passive: true });
  updateChrome();
  onDispose(() => { window.clearTimeout(saveTimer); void saveProgress(); docs.forEach((d) => d.render?.dispose()); });

  /* ---------- settings ---------- */
  onDispose(onSettingsChange((s) => { applySettings(reader, s); syncComfort(); statusBar.hidden = !s.showStatusLine; updateChrome(); }));
  root.addEventListener('kr-rerender', async () => {
    const cur = currentLocator();
    for (const doc of docs) await renderDoc(doc);
    allImages = docs.flatMap((d) => d.render?.images ?? []);
    applyLayoutMode();
    if (cur) scrollToLocator(cur.loc);
  });
  applyLayoutMode();

  /* ---------- links & taps ---------- */
  flow.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a[data-kr-anchor]') as HTMLElement | null;
    if (a) { e.preventDefault(); scrollToAnchor(a.dataset.krAnchor!); return; }
    const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
    if (img && allImages.length) { const idx = allImages.findIndex((im) => im.anchor === img.id); if (idx >= 0) { showGallery(idx); return; } }
    if ((e.target as HTMLElement).closest('a, button, input, select, mark, .kr-sheet-tabs')) return;
    if (document.getSelection()?.isCollapsed === false) return;
    // Moon+-style tap zones on touch screens: lower part = next screen, upper part = previous, middle = chrome.
    if (getSettings().tapToTurn && isTouchDevice()) {
      const sr = scroll.getBoundingClientRect(); const y = (e.clientY - sr.top) / sr.height;
      const page = sr.height * 0.88;
      if (y > 0.62) { scroll.scrollBy({ top: page, behavior: 'smooth' }); return; }
      if (y < 0.22) { scroll.scrollBy({ top: -page, behavior: 'smooth' }); return; }
    }
    root.classList.toggle('immersive');
  });

  onDispose(attachEdgeBrightness(scroll));
  const onCommand = (e: Event) => { const c = (e as CustomEvent<string>).detail; if (c === 'search') openSearch(); else if (c === 'options') openOptions(); };
  document.addEventListener('kr:command', onCommand);
  onDispose(() => document.removeEventListener('kr:command', onCommand));
  // Volume keys (Android) turn screens when enabled.
  const onVolume = (e: Event) => { const dir = (e as CustomEvent<string>).detail === 'up' ? -1 : 1; scroll.scrollBy({ top: dir * scroll.clientHeight * 0.88, behavior: 'smooth' }); };
  document.addEventListener('kr:volume', onVolume);
  onDispose(() => document.removeEventListener('kr:volume', onVolume));

  /* ---------- selection tools ---------- */
  onDispose(attachSelectionToolbar(scroll, {
    search: (text) => openSearch(text),
    highlight: (range, text, color) => addHighlight(range, text, color),
    note: (range, text) => addNote(range, text),
    speak: (text) => speak([text]),
    textImage: (text) => void textImage(text),
  }));

  async function textImage(text: string): Promise<void> {
    const cur = currentLocator();
    const book = cur?.doc.book ?? docs[0].book;
    try {
      const opts = { text, title: book.title, author: book.author, appName: t('appName') };
      showSnapshot(await renderTextCanvas(opts), snapName(book.title), book.title, (style) => renderTextCanvas({ ...opts, style }));
    } catch (err) { toast(String((err as Error).message ?? err), 'error'); }
  }

  function addNote(range: Range, text: string): void {
    const sheet = openSheet(t('addNote'), t('close'));
    sheet.body.style.fontFamily = 'var(--font-ui)';
    const ta = h('textarea', { placeholder: t('notePlaceholder'), rows: '4', style: { width: '100%' }, dir: 'auto' }) as HTMLTextAreaElement;
    sheet.body.append(h('p', { class: 'src', dir: 'auto' }, text.length > 160 ? text.slice(0, 160) + '…' : text), ta);
    sheet.actions.append(h('button', { class: 'btn primary small', onclick: async () => { await addHighlight(range, text, getSettings().highlightColor, ta.value.trim() || undefined); sheet.close(); toast(t('noteSaved')); } }, icon('check'), t('done')));
    setTimeout(() => ta.focus(), 100);
  }

  function docForNode(node: Node): OpenDoc | undefined {
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const wrapper = el?.closest('.kr-doc') as HTMLElement | null;
    return docs.find((d) => d.wrapper === wrapper);
  }

  async function addHighlight(range: Range, text: string, color: HighlightColor, note?: string): Promise<void> {
    const doc = docForNode(range.commonAncestorContainer);
    if (!doc) return;
    const chapter = (range.startContainer.parentElement?.closest('.kr-chapter, .kr-slide, section, .kr-content') as HTMLElement | null);
    const hl: Highlight = { id: uid(), text, anchor: chapter?.id || undefined, color, note, createdAt: Date.now() };
    const marks = wrapRange(range, 'kr-hl', hl.color, hl.id);
    if (note) marks.forEach((m) => { m.title = note; m.classList.add('has-note'); });
    doc.book.highlights = [...(doc.book.highlights ?? []), hl];
    await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; });
    updateSettings({ highlightColor: color });
    if (!note) toast(t('highlight'));
  }

  // Tapping a highlight: change colour, edit note, or remove.
  flow.addEventListener('click', (e) => {
    const mark = (e.target as HTMLElement).closest('mark.kr-hl') as HTMLElement | null;
    if (!mark || document.getSelection()?.isCollapsed === false) return;
    const doc = docForNode(mark); const id = mark.dataset.hl;
    const hl = doc?.book.highlights.find((x) => x.id === id);
    if (!doc || !hl) return;
    e.stopPropagation();
    const sheet = openSheet(t('highlight'), t('close'));
    sheet.body.style.fontFamily = 'var(--font-ui)';
    const ta = h('textarea', { placeholder: t('notePlaceholder'), rows: '3', style: { width: '100%' }, dir: 'auto' }) as HTMLTextAreaElement;
    ta.value = hl.note ?? '';
    sheet.body.append(h('p', { class: 'src', dir: 'auto' }, hl.text.length > 200 ? hl.text.slice(0, 200) + '…' : hl.text),
      h('div', { class: 'sel-colors', style: { justifyContent: 'flex-start', border: '0', padding: '0 0 10px' } }, ...HIGHLIGHT_COLORS.map(([cid, hex]) => h('button', { type: 'button', class: 'dot', style: { background: hex, width: '44px', height: '22px', borderRadius: '999px', outline: hl.color === cid ? '3px solid var(--md-primary)' : 'none' }, onclick: async () => { hl.color = cid; doc.wrapper.querySelectorAll(`mark[data-hl="${id}"]`).forEach((m) => ((m as HTMLElement).dataset.color = cid)); await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; }); sheet.close(); } }))),
      ta);
    sheet.actions.append(
      h('button', { class: 'btn danger small', onclick: async () => { await removeHighlight(doc, hl.id); sheet.close(); } }, icon('trash'), t('removeHighlight')),
      h('button', { class: 'btn primary small', onclick: async () => { hl.note = ta.value.trim() || undefined; doc.wrapper.querySelectorAll(`mark[data-hl="${id}"]`).forEach((m) => { (m as HTMLElement).title = hl.note ?? ''; m.classList.toggle('has-note', !!hl.note); }); await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; }); sheet.close(); toast(t('noteSaved')); } }, icon('check'), t('done')));
  }, true);

  function applyHighlights(doc: OpenDoc): void {
    for (const hl of doc.book.highlights ?? []) {
      const scope = (hl.anchor && document.getElementById(hl.anchor)) || doc.render?.element;
      if (!scope) continue;
      const range = findTextRange(scope, hl.text);
      if (range) { const marks = wrapRange(range, 'kr-hl', hl.color, hl.id); if (hl.note) marks.forEach((m) => { m.title = hl.note!; m.classList.add('has-note'); }); }
    }
  }

  async function removeHighlight(doc: OpenDoc, id: string): Promise<void> {
    doc.wrapper.querySelectorAll(`mark[data-hl="${id}"]`).forEach((m) => m.replaceWith(...m.childNodes));
    doc.book.highlights = (doc.book.highlights ?? []).filter((x) => x.id !== id);
    await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; });
  }

  /* ---------- bookmarks ---------- */
  async function addBookmark(): Promise<void> {
    const cur = currentLocator();
    if (!cur) return;
    const block = cur.doc.blocks[cur.loc.block ?? 0];
    const excerpt = (block?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const bm: Bookmark = { id: uid(), label: labelFor(cur.doc, cur.loc.block ?? 0), excerpt, locator: cur.loc, createdAt: Date.now() };
    cur.doc.book.bookmarks = [...(cur.doc.book.bookmarks ?? []), bm];
    await db.updateBook(cur.doc.book.id, (b) => { b.bookmarks = cur.doc.book.bookmarks; });
    toast(t('bookmarkAdded'));
    panel.refresh();
  }

  /* ---------- panel: contents / bookmarks / highlights ---------- */
  function openContents(tab: 'toc' | 'bookmarks' | 'highlights'): void {
    panel.open(t('contents'), [
      { id: 'toc', label: t('contents'), render: (body) => {
        const cur = currentLocator();
        const curLabel = cur ? labelFor(cur.doc, cur.loc.block ?? 0) : '';
        for (const doc of docs) {
          const ul = h('ul', { class: 'toc-list' });
          if (docs.length > 1) body.append(h('div', { class: 'toc-book', dir: 'auto' }, doc.book.title));
          body.append(h('ul', { class: 'toc-list' }, h('li', null, h('button', { type: 'button', onclick: () => { scrollToAnchor(doc.wrapper.id, false); panel.close(); } }, icon('books'), doc.book.title))));
          const toc = doc.render?.toc ?? [];
          if (!toc.length) body.append(h('p', { style: { color: 'var(--text-dim)', padding: '0 10px', fontSize: '13px' } }, t('noContents')));
          for (const item of toc) ul.append(h('li', { class: `depth-${Math.min(3, item.depth)}` }, h('button', { type: 'button', class: cur?.doc === doc && item.label === curLabel ? 'current' : '', dir: 'auto', onclick: () => { scrollToAnchor(item.anchor, false); panel.close(); } }, item.label)));
          body.append(ul);
        }
        body.querySelector('.current')?.scrollIntoView({ block: 'center' });
      } },
      { id: 'bookmarks', label: t('bookmarks'), render: (body) => {
        const all = docs.flatMap((d) => (d.book.bookmarks ?? []).map((bm) => ({ doc: d, bm }))).sort((a, b) => b.bm.createdAt - a.bm.createdAt);
        if (!all.length) { body.append(h('p', { class: 'center' }, t('noBookmarks'))); return; }
        body.append(h('ul', { class: 'plain-list' }, ...all.map(({ doc, bm }) => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { scrollToLocator(bm.locator); panel.close(); } },
            h('span', { dir: 'auto' }, bm.label), h('span', { class: 'meta', dir: 'auto' }, (docs.length > 1 ? doc.book.title + ' · ' : '') + (bm.excerpt ?? ''))),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { doc.book.bookmarks = doc.book.bookmarks.filter((x) => x.id !== bm.id); await db.updateBook(doc.book.id, (b) => { b.bookmarks = doc.book.bookmarks; }); panel.refresh(); } }, icon('trash'))))));
      } },
      { id: 'highlights', label: t('highlights'), render: (body) => {
        const all = docs.flatMap((d) => (d.book.highlights ?? []).map((hl) => ({ doc: d, hl }))).sort((a, b) => b.hl.createdAt - a.hl.createdAt);
        if (!all.length) { body.append(h('p', { class: 'center' }, t('noHighlights')));  return; }
        body.append(h('ul', { class: 'plain-list' }, ...all.map(({ doc, hl }) => h('li', null,
          h('button', { type: 'button', style: { flex: '1' }, onclick: () => { const m = doc.wrapper.querySelector(`mark[data-hl="${hl.id}"]`) as HTMLElement | null; if (m) { if (!m.id) m.id = `hl-${hl.id}`; scrollToAnchor(m.id); } panel.close(); } },
            h('mark', { class: 'kr-hl', 'data-color': hl.color, dir: 'auto', style: { fontFamily: 'var(--font-read)' } }, hl.text.length > 160 ? hl.text.slice(0, 160) + '…' : hl.text)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { await removeHighlight(doc, hl.id); panel.refresh(); } }, icon('trash'))))));
      } },
    ], tab);
  }

  /* ---------- search ---------- */
  let searchHighlight: Highlight | undefined;
  function clearSearchMarks(): void {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    reg?.delete('kr-search');
    reg?.delete('kr-search-current');
  }
  onDispose(clearSearchMarks);

  function searchFlow(query: string): SearchHit[] {
    const q = normalizeForSearch(query.trim());
    const hits: SearchHit[] = [];
    if (!q.text) return hits;
    const ranges: Range[] = [];
    for (const doc of docs) {
      const content = doc.render?.element;
      if (!content) continue;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('style, script') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      let node: Node | null;
      while ((node = walker.nextNode()) && hits.length < 500) {
        const text = node.textContent ?? '';
        if (text.length < q.text.length) continue;
        const norm = normalizeForSearch(text);
        let idx = norm.text.indexOf(q.text);
        while (idx >= 0 && hits.length < 500) {
          const s = norm.map[idx], e = norm.map[Math.min(norm.map.length - 1, idx + q.text.length)];
          const range = document.createRange();
          range.setStart(node, s); range.setEnd(node, e);
          ranges.push(range);
          const block = (node.parentElement?.closest(BLOCK_SELECTOR) as HTMLElement | null);
          hits.push({ bookId: doc.book.id, label: labelFor(doc, block ? Math.max(0, doc.blocks.indexOf(block)) : 0), before: text.slice(Math.max(0, s - 60), s), match: text.slice(s, e), after: text.slice(e, e + 60), range });
          idx = norm.text.indexOf(q.text, idx + q.text.length);
        }
      }
    }
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HL = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (reg && HL) { reg.set('kr-search', new HL(...ranges)); }
    return hits;
  }

  function openSearch(initial = ''): void {
    panel.open(t('searchInBook'), [{ id: 'search', label: t('search'), render: (body) => {
      const input = h('input', { type: 'search', placeholder: t('searchPlaceholder'), value: initial, 'aria-label': t('searchInBook'), style: { width: '100%' } }) as HTMLInputElement;
      const count = h('div', { style: { color: 'var(--text-dim)', fontSize: '13px', margin: '10px 0' } });
      const list = h('ul', { class: 'plain-list' });
      body.append(input, count, list);
      let timer: number | undefined;
      const run = () => {
        clear(list); clearSearchMarks();
        const q = input.value.trim();
        if (q.length < 2) { count.textContent = ''; return; }
        const hits = searchFlow(q);
        count.textContent = hits.length ? t('resultsCount', { n: hits.length }) : t('noResults');
        let lastBook = '';
        for (const hit of hits) {
          if (docs.length > 1 && hit.bookId !== lastBook) { lastBook = hit.bookId; list.append(h('div', { class: 'toc-book', dir: 'auto' }, docs.find((d) => d.book.id === hit.bookId)?.book.title)); }
          list.append(h('li', { class: 'hit' }, h('button', { type: 'button', style: { flexDirection: 'column', alignItems: 'stretch' }, onclick: () => {
            const el = hit.range.startContainer.parentElement!;
            const sr = scroll.getBoundingClientRect();
            const r = hit.range.getBoundingClientRect();
            scroll.scrollTop += r.top - sr.top - sr.height * 0.3;
            const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
            const HL = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
            if (reg && HL) reg.set('kr-search-current', new HL(hit.range));
            el.classList.add('kr-flash'); setTimeout(() => el.classList.remove('kr-flash'), 1600);
            if (window.innerWidth < 900) panel.close();
          } }, h('span', { class: 'meta', dir: 'auto' }, hit.label), h('span', { class: 'ctx', dir: 'auto' }, '…' + hit.before, h('mark', null, hit.match), hit.after + '…'))));
        }
      };
      input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(run, 250); });
      if (initial) run();
      setTimeout(() => input.focus(), 50);
    } }]);
    void searchHighlight;
  }

  function showInfo(): void {
    const cur = currentLocator();
    const doc = cur?.doc ?? docs[0];
    const tr = trackers.get(doc);
    const words = doc.blocks.map(wordCount);
    const block = cur?.loc.block ?? 0;
    const toc = doc.render?.toc ?? [];
    const label = labelFor(doc, block);
    const idx = toc.findIndex((x) => x.label === label);
    // words left in the current chapter: until the next TOC anchor
    let wordsLeftInChapter: number | undefined;
    if (toc.length && idx >= 0 && toc[idx + 1]) {
      const nextEl = document.getElementById(toc[idx + 1].anchor);
      const nextBlock = nextEl ? doc.blocks.findIndex((b) => b === nextEl || (nextEl.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) : -1;
      if (nextBlock > block) wordsLeftInChapter = words.slice(block, nextBlock).reduce((a, b) => a + b, 0);
    }
    const wordsLeftInBook = words.slice(block).reduce((a, b) => a + b, 0);
    showBookInfo({ book: doc.book, stats: tr?.current ?? { ms: 0, words: 0, days: {} }, speed: tr?.speed() ?? null, chapters: toc.length || undefined, currentChapter: label !== doc.book.title ? label : undefined, currentChapterIndex: idx >= 0 ? idx : undefined, pct: cur?.loc.pct ?? 0, wordsLeftInChapter, wordsLeftInBook });
  }

  /* ---------- gallery ---------- */
  function showGallery(startAt?: number): void {
    const close = openGallery(allImages, (anchor) => scrollToAnchor(anchor));
    if (startAt !== undefined) (document.querySelectorAll('.gallery-grid button')[startAt] as HTMLElement | undefined)?.click();
    onDispose(close);
  }

  /* ---------- options & more ---------- */
  function openOptions(): void {
    panel.open(t('visualOptions'), [{ id: 'options', label: t('visualOptions'), render: (body) => renderOptions(body) }]);
  }

  let autoScrollRaf = 0;
  let autoHud: HTMLElement | null = null;
  function toggleAutoScroll(): void {
    if (autoScrollRaf) { stopAutoScroll(); return; }
    let speed = getSettings().autoScrollSpeed;
    let last = performance.now();
    const step = (now: number) => {
      scroll.scrollTop += (speed * (now - last)) / 1000;
      last = now;
      if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) { stopAutoScroll(); return; }
      autoScrollRaf = requestAnimationFrame(step);
    };
    autoScrollRaf = requestAnimationFrame(step);
    const range = h('input', { type: 'range', min: '10', max: '200', value: String(speed), 'aria-label': t('autoScrollSpeed'), oninput: () => { speed = Number(range.value); import('../settings').then((m) => m.updateSettings({ autoScrollSpeed: speed })); } }) as HTMLInputElement;
    autoHud = h('div', { class: 'autoscroll-hud' }, icon('scroll'), h('span', null, t('autoScroll')), range, iconButton('stop', t('close'), stopAutoScroll));
    root.append(autoHud);
  }
  function stopAutoScroll(): void { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = 0; autoHud?.remove(); autoHud = null; }
  onDispose(stopAutoScroll);

  // Read aloud with the Web Speech API (voices are the device's own, so this works offline where the OS provides them).
  let speaking = false;
  function speak(chunks: string[], startBlock?: { doc: OpenDoc; index: number }): void {
    if (!('speechSynthesis' in window)) return;
    stopSpeaking();
    speaking = true;
    let i = 0;
    const next = () => {
      if (!speaking) return;
      let text = chunks[i];
      if (text === undefined && startBlock) {
        const block = startBlock.doc.blocks[startBlock.index + i];
        if (!block) { stopSpeaking(); return; }
        text = (block.textContent ?? '').trim();
        const sr = scroll.getBoundingClientRect();
        const r = block.getBoundingClientRect();
        if (r.bottom > sr.bottom || r.top < sr.top) scroll.scrollTop += r.top - sr.top - 40;
        block.classList.add('kr-flash'); setTimeout(() => block.classList.remove('kr-flash'), 1200);
      }
      if (text === undefined) { stopSpeaking(); return; }
      i++;
      if (!text) { next(); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = isRtlText(text) ? 'ar-SA' : 'en-US';
      u.rate = 1;
      u.onend = next;
      u.onerror = () => stopSpeaking();
      speechSynthesis.speak(u);
    };
    next();
  }
  function stopSpeaking(): void { speaking = false; if ('speechSynthesis' in window) speechSynthesis.cancel(); }
  onDispose(stopSpeaking);

  function openMore(): void {
    panel.open(t('more'), [{ id: 'more', label: t('more'), render: (body) => {
      const item = (name: string, label: string, fn: () => void) => h('li', null, h('button', { type: 'button', onclick: () => { panel.close(); fn(); } }, icon(name), label));
      body.append(h('ul', { class: 'plain-list' },
        item('info', t('bookInfo'), () => showInfo()),
        item('bookmarkAdd', t('addBookmark'), () => void addBookmark()),
        item('images', t('images'), () => showGallery()),
        item('type', t('visualOptions'), openOptions),
        item(speaking ? 'stop' : 'speak', speaking ? t('stopReading') : t('readAloud'), () => { if (speaking) stopSpeaking(); else { const cur = currentLocator(); if (cur) speak([], { doc: cur.doc, index: cur.loc.block ?? 0 }); } }),
        item('scroll', t('autoScroll'), toggleAutoScroll),
        item('fullscreen', t('fullscreen'), () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); }),
        item('bookmark', t('bookmarks'), () => openContents('bookmarks')),
        item('download', t('exportNotes'), () => { const cur = currentLocator(); void exportNotes(cur?.doc.book ?? docs[0].book); }),
        item('highlight', t('highlights'), () => openContents('highlights')),
        docs.length > 1 ? item('books', t('jumpToBook'), () => openContents('toc')) : null,
      ));
      if (!isTouchDevice()) body.append(h('p', { class: 'shortcuts-hint' }, icon('keyboard'), ' ', t('shortcutsBody')));
    } }]);
  }

  /* ---------- keyboard ---------- */
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { if (panel.isOpen) panel.close(); else if (autoScrollRaf) stopAutoScroll(); else if (speaking) stopSpeaking(); return; }
    if ((e.target as HTMLElement).matches('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const page = scroll.clientHeight * 0.9;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowLeft': { if (!chapterMode()) return; const rtl = docs.find((d) => !d.wrapper.hidden)?.render?.rtl ?? false; const fwd = (e.key === 'ArrowRight') !== rtl; const k = currentUnitIndex(); showUnit(fwd ? k + 1 : k - 1, !fwd); break; }
      case 'j': case 'ArrowDown': scroll.scrollBy({ top: 80 }); break;
      case 'k': case 'ArrowUp': scroll.scrollBy({ top: -80 }); break;
      case ' ': case 'PageDown': e.preventDefault(); scroll.scrollBy({ top: e.shiftKey ? -page : page, behavior: 'smooth' }); break;
      case 'PageUp': e.preventDefault(); scroll.scrollBy({ top: -page, behavior: 'smooth' }); break;
      case 'Home': scroll.scrollTop = 0; break;
      case 'End': scroll.scrollTop = scroll.scrollHeight; break;
      case '/': e.preventDefault(); openSearch(); break;
      case 'b': void addBookmark(); break;
      case 'g': showGallery(); break;
      case 'v': openOptions(); break;
      case 'c': openContents('toc'); break;
      case 'f': if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); break;
      case 'a': toggleAutoScroll(); break;
      case '[': case ']': {
        const cur = currentLocator();
        if (!cur) break;
        const i = docs.indexOf(cur.doc) + (e.key === ']' ? 1 : -1);
        if (docs[i]) scrollToAnchor(docs[i].wrapper.id, false);
        break;
      }
      default: return;
    }
  };
  window.addEventListener('keydown', onKey);
  onDispose(() => window.removeEventListener('keydown', onKey));
  scroll.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ */
/* PDF reader                                                          */
/* ------------------------------------------------------------------ */

function snapName(title: string): string {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
  return `${title.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40)} ${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

async function mountPdf(root: HTMLElement, book: Book, onDispose: (fn: () => void) => void): Promise<void> {
  const file = await db.getFile(book.id);
  if (!file) { navigate('/', true); return; }
  const reader = h('div', { class: 'reader' });
  applySettings(reader);
  const title = h('div', { class: 'title', dir: 'auto' }, book.title, h('small', null, book.author ?? ''));
  const panel = new SidePanel(root);
  const pageInput = h('input', { type: 'number', min: '1', 'aria-label': t('goToPage') }) as HTMLInputElement;
  const slider = h('input', { type: 'range', min: '1', value: '1', 'aria-label': t('page') }) as HTMLInputElement;
  const count = h('span', { class: 'pcount' });
  let viewer: PdfViewer;

  const bar = h('div', { class: 'pdf-bar' },
    iconButton('chevronLeft', t('previousPage'), () => viewer.goTo(viewer.current - 1)),
    slider,
    iconButton('chevronRight', t('nextPage'), () => viewer.goTo(viewer.current + 1)),
    count,
    h('form', { style: { display: 'flex', gap: '6px', alignItems: 'center' }, onsubmit: (e: Event) => { e.preventDefault(); const n = Number(pageInput.value); if (n) viewer.goTo(n); pageInput.blur(); } }, pageInput, h('button', { class: 'btn small', type: 'submit' }, t('go'))),
    iconButton('zoomOut', t('zoomOut'), () => viewer.zoom(-0.15)),
    iconButton('zoomIn', t('zoomIn'), () => viewer.zoom(0.15)),
    iconButton('fullscreen', t('fitWidth'), () => viewer.fitToWidth()),
  );
  const topbar = h('header', { class: 'topbar' },
    iconButton('back', t('back'), () => navigate('/')),
    title,
    iconButton('search', t('searchInBook'), () => openSearch()),
    iconButton('toc', t('contents'), () => openContents('toc')),
    iconButton('grid', t('pagesGrid'), () => showPagesGrid()),
    iconButton('more', t('more'), () => openMore()),
  );
  const syncComfort = () => { const st = getComputedStyle(reader); root.style.setProperty('--r-warmth', st.getPropertyValue('--r-warmth')); root.style.setProperty('--r-dim-overlay', st.getPropertyValue('--r-dim-overlay')); };
  queueMicrotask(syncComfort);
  root.append(topbar, reader, bar, h('div', { class: 'reader-comfort', 'aria-hidden': 'true' }), h('div', { class: 'center', id: 'kr-loading' }, h('div', { class: 'spinner' }), t('loading')));

  const openPdfOptions = () => panel.open(t('visualOptions'), [{ id: 'o', label: t('visualOptions'), render: (b) => renderOptions(b, { pdf: true }) }]);
  let saveTimer: number | undefined;
  viewer = new PdfViewer({
    container: reader,
    invert: getSettings().pdfInvert,
    onPageChange: (page, total) => {
      slider.max = String(total); slider.value = String(page); pageInput.max = String(total); pageInput.placeholder = String(page);
      count.textContent = t('pageOf', { n: page, total });
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { const loc: Locator = { bookId: book.id, page, offset: viewer.currentOffset(), pct: total ? page / total : 0 }; book.progress = loc; void db.updateBook(book.id, (b) => { b.progress = loc; }); }, 600);
    },
  });
  slider.addEventListener('input', () => viewer.goTo(Number(slider.value)));
  await viewer.load(file, book.id);
  root.querySelector('#kr-loading')?.remove();
  void touchBook(book.id);
  if (book.progress?.page) viewer.goTo(book.progress.page, book.progress.offset ?? 0);
  onDispose(() => viewer.destroy());
  onDispose(onSettingsChange((s) => { applySettings(reader, s); syncComfort(); viewer.setInvert(s.pdfInvert); }));
  onDispose(attachSelectionToolbar(reader, {
    search: (text) => openSearch(text),
    highlight: () => toast(t('fmtPdf')),
    note: () => toast(t('fmtPdf')),
    speak: (text) => { if ('speechSynthesis' in window) { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = isRtlText(text) ? 'ar-SA' : 'en-US'; speechSynthesis.speak(u); } },
    textImage: async (text) => { try { const opts = { text, title: book.title, author: book.author, appName: t('appName') }; showSnapshot(await renderTextCanvas(opts), snapName(book.title), book.title, (style) => renderTextCanvas({ ...opts, style })); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } },
  }));
  void applyOrientation();
  if (getSettings().hideSystemBars) void setImmersive(true);
  keepAwake(getSettings().keepAwake);
  onDispose(() => { void setImmersive(false); keepAwake(false); });
  onDispose(attachEdgeBrightness(viewer.scroll));
  const onVolumePdf = (e: Event) => { const dir = (e as CustomEvent<string>).detail === 'up' ? -1 : 1; viewer.scroll.scrollBy({ top: dir * viewer.scroll.clientHeight * 0.9, behavior: 'smooth' }); };
  document.addEventListener('kr:volume', onVolumePdf);
  onDispose(() => document.removeEventListener('kr:volume', onVolumePdf));

  // Reading statistics for PDFs: words per page counted as pages are reached.
  const tracker = new ReadingTracker(book, () => true);
  tracker.start();
  let lastPageTracked = viewer.current;
  const pageWordCache = new Map<number, number>();
  const trackPage = async () => {
    const n = viewer.current;
    if (n === lastPageTracked) return;
    let passed = 0;
    if (n > lastPageTracked && n - lastPageTracked < 6) for (let i = lastPageTracked; i < n; i++) { if (!pageWordCache.has(i)) pageWordCache.set(i, countWords(await viewer.pageText(i))); passed += pageWordCache.get(i)!; }
    lastPageTracked = n;
    tracker.advance(passed, n / viewer.total);
  };
  viewer.scroll.addEventListener('scroll', throttle(() => void trackPage(), 500), { passive: true });
  onDispose(() => void tracker.stop());

  async function savePage(mode: boolean | 'copy'): Promise<void> {
    try {
      const blob = await viewer.pageToBlob(viewer.current);
      const name = `${book.title.slice(0, 40)} - p${viewer.current}.png`;
      if (mode === 'copy') { if (await copyImage(blob)) toast(t('copied')); }
      else if (mode) await shareFile(blob, name, book.title); else await saveImage(blob, name);
    } catch (err) { toast(String((err as Error).message ?? err), 'error'); }
  }

  function showPagesGrid(): void {
    const grid = h('div', { class: 'pages-grid' });
    const close = () => { overlay.remove(); window.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const overlay = h('div', { class: 'view', style: { position: 'fixed', inset: '0', zIndex: '45', background: 'var(--md-surface)' }, role: 'dialog' },
      h('header', { class: 'topbar' }, iconButton('back', t('back'), close), h('div', { class: 'title' }, t('pagesGrid'), h('small', null, t('pageOf', { n: viewer.current, total: viewer.total })))),
      h('div', { class: 'gallery-body' }, grid));
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const cell = en.target as HTMLElement; io.unobserve(cell);
        const n = Number(cell.dataset.page);
        void viewer.thumbnail(n).then((url) => { const img = cell.querySelector('img'); if (img) img.src = url; });
      }
    }, { root: overlay.querySelector('.gallery-body'), rootMargin: '400px 0px' });
    for (let n = 1; n <= viewer.total; n++) {
      const cell = h('button', { type: 'button', class: 'page-cell' + (n === viewer.current ? ' current' : ''), dataset: { page: String(n) }, onclick: () => { viewer.goTo(n); close(); } }, h('img', { alt: String(n) }), h('span', null, String(n)));
      grid.append(cell); io.observe(cell);
    }
    window.addEventListener('keydown', onKey);
    document.body.append(overlay);
    setTimeout(() => overlay.querySelector('.page-cell.current')?.scrollIntoView({ block: 'center' }), 50);
  }

  function showInfo(): void {
    showBookInfo({ book, stats: tracker.current, speed: tracker.speed(), pages: viewer.total, currentPage: viewer.current, pct: viewer.current / viewer.total });
  }
  reader.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('.textLayer span, a, button, input')) return; if (document.getSelection()?.isCollapsed === false) return; root.classList.toggle('immersive'); });

  let outline: TocItem[] | null = null;
  function openContents(tab: 'toc' | 'bookmarks') {
    panel.open(t('contents'), [
      { id: 'toc', label: t('contents'), render: async (body) => {
        outline ??= await viewer.outline();
        if (!outline.length) { body.append(h('p', { class: 'center' }, t('noContents'))); return; }
        body.append(h('ul', { class: 'toc-list' }, ...outline.map((it) => h('li', { class: `depth-${Math.min(3, it.depth)}` }, h('button', { type: 'button', dir: 'auto', class: it.page === viewer.current ? 'current' : '', onclick: () => { if (it.page) viewer.goTo(it.page); panel.close(); } }, h('span', { style: { flex: '1' } }, it.label), it.page ? h('span', { class: 'meta' }, String(it.page)) : null)))));
      } },
      { id: 'bookmarks', label: t('bookmarks'), render: (body) => {
        const list = [...(book.bookmarks ?? [])].sort((a, b) => b.createdAt - a.createdAt);
        if (!list.length) { body.append(h('p', { class: 'center' }, t('noBookmarks'))); return; }
        body.append(h('ul', { class: 'plain-list' }, ...list.map((bm) => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { viewer.goTo(bm.locator.page ?? 1, bm.locator.offset ?? 0); panel.close(); } }, h('span', null, bm.label), bm.excerpt ? h('span', { class: 'meta', dir: 'auto' }, bm.excerpt) : null),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { book.bookmarks = book.bookmarks.filter((x) => x.id !== bm.id); await db.updateBook(book.id, (b) => { b.bookmarks = book.bookmarks; }); panel.refresh(); } }, icon('trash'))))));
      } },
    ], tab);
  }

  async function addBookmark() {
    const page = viewer.current;
    const excerpt = (await viewer.pageText(page)).trim().replace(/\s+/g, ' ').slice(0, 120);
    const bm: Bookmark = { id: uid(), label: t('pageOf', { n: page, total: viewer.total }), excerpt, locator: { bookId: book.id, page, offset: viewer.currentOffset(), pct: page / viewer.total }, createdAt: Date.now() };
    book.bookmarks = [...(book.bookmarks ?? []), bm];
    await db.updateBook(book.id, (b) => { b.bookmarks = book.bookmarks; });
    toast(t('bookmarkAdded'));
    panel.refresh();
  }

  let searchToken = { cancelled: false };
  function openSearch(initial = '') {
    panel.open(t('searchInBook'), [{ id: 'search', label: t('search'), render: (body) => {
      const input = h('input', { type: 'search', placeholder: t('searchPlaceholder'), value: initial, style: { width: '100%' }, 'aria-label': t('searchInBook') }) as HTMLInputElement;
      const status = h('div', { style: { color: 'var(--text-dim)', fontSize: '13px', margin: '10px 0' } });
      const list = h('ul', { class: 'plain-list' });
      body.append(input, status, list);
      let timer: number | undefined;
      const run = async () => {
        searchToken.cancelled = true; searchToken = { cancelled: false };
        const token = searchToken;
        clear(list);
        const q = input.value.trim();
        if (q.length < 2) { status.textContent = ''; return; }
        let hits: PdfSearchHit[] = [];
        hits = await viewer.search(q, (done, total) => { if (!token.cancelled) status.textContent = t('pdfSearching', { n: done, total }); }, token);
        if (token.cancelled) return;
        status.textContent = hits.length ? t('resultsCount', { n: hits.length }) : t('noResults');
        for (const hit of hits) {
          list.append(h('li', { class: 'hit' }, h('button', { type: 'button', style: { flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { void viewer.highlightOnPage(hit.page, q); if (window.innerWidth < 900) panel.close(); } },
            h('span', { class: 'meta' }, t('pageOf', { n: hit.page, total: viewer.total })), h('span', { class: 'ctx', dir: 'auto' }, hit.excerpt))));
        }
      };
      input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void run(), 350); });
      if (initial) void run();
      setTimeout(() => input.focus(), 50);
    } }]);
  }

  function openMore() {
    panel.open(t('more'), [{ id: 'more', label: t('more'), render: (body) => {
      const item = (name: string, label: string, fn: () => void) => h('li', null, h('button', { type: 'button', onclick: () => { panel.close(); fn(); } }, icon(name), label));
      body.append(h('ul', { class: 'plain-list' },
        item('info', t('bookInfo'), showInfo),
        item('download', t('exportNotes'), () => void exportNotes(book)),
        item('grid', t('pagesGrid'), showPagesGrid),
        item('camera', t('savePageImage'), () => void savePage(false)),
        item('external', t('sharePage'), () => void savePage(true)),
        item('copy', t('copyPageImage'), () => void savePage('copy')),
        item('bookmarkAdd', t('addBookmark'), () => void addBookmark()),
        item('type', t('visualOptions'), openPdfOptions),
        item('fullscreen', t('fullscreen'), () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); }),
        item('bookmark', t('bookmarks'), () => openContents('bookmarks')),
        item('target', t('goToPage'), () => pageInput.focus()),
      ));
    } }]);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { panel.close(); return; }
    if ((e.target as HTMLElement).matches('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowRight': case 'n': case 'PageDown': viewer.goTo(viewer.current + 1); break;
      case 'ArrowLeft': case 'p': case 'PageUp': viewer.goTo(viewer.current - 1); break;
      case 'Home': viewer.goTo(1); break;
      case 'End': viewer.goTo(viewer.total); break;
      case '/': e.preventDefault(); openSearch(); break;
      case 'b': void addBookmark(); break;
      case 'c': openContents('toc'); break;
      case 'g': pageInput.focus(); break;
      case '+': case '=': viewer.zoom(0.15); break;
      case '-': viewer.zoom(-0.15); break;
      case 'f': if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); break;
      default: return;
    }
  };
  window.addEventListener('keydown', onKey);
  onDispose(() => window.removeEventListener('keydown', onKey));
}
