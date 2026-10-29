// The reading surface. Flow documents (EPUB, DOCX, TXT, …) are rendered one
// after another into a single scroll — that is what "read together" means —
// while PDFs get the page-based viewer.
import { takeJump, setJump, type Jump } from '../jump';
export { setJump, type Jump };
import { h, icon, iconButton, toast, clear, throttle } from '../ui/dom';
import { nextQueued, getQueue } from '../ui/queue';
import { overscrollNext } from '../ui/overscroll';
import { nextVolume } from '../series';
import { attachRuler } from '../ui/ruler';
import { jumpBack } from '../ui/jumpback';
import { leaveToCaller } from '../native';
import { applyTypography, revertTypography } from '../ui/typography';
import { t, isRtlText, isTouchDevice, getLang, localDigits, countMinutes } from '../i18n';
import { db, uid, type PdfNote, type PdfHighlight, type InkStroke, type Book, type Locator, type Bookmark, type Highlight, FAV_TAG } from '../db';
import { flowHandlerFor } from '../formats';
import type { FlowRender, ImageRef, TocItem } from '../formats/types';
import { normalizeForSearch, searchFormOf } from '../formats/types';
import { BLOCK_SELECTOR } from '../formats/shared';
import { PdfViewer, type CropBox, type PdfSearchHit } from '../formats/pdf';
import { applySettings, applyChrome, getSettings, onSettingsChange, updateSettings, setActiveBook } from '../settings';
import { SidePanel } from '../ui/panel';
import { renderOptions } from '../ui/options';
import { attachSelectionToolbar, wrapRange, findTextRange, HIGHLIGHT_COLORS, plainText } from '../ui/selection';
import { openGallery } from './gallery';
import { touchBook, coverUrl, shareBooks } from '../library';
import { navigate, back as goBackView } from '../router';
import { ReadingTracker, countWords, countWordsAndChars } from '../stats';
import { showBookInfo } from '../ui/bookinfo';
import { renderTextCanvas, showSnapshot } from '../ui/textcard';
import { exportNotes, exportNotesAnki } from '../ui/exportnotes';
import { attachEdgeBrightness, attachPinchText } from '../ui/brightness';
import { attachTranslator } from '../ui/translator';
import { aiSpeak, aiTtsSupported, aiReady } from '../ai';
import { kittenReady, kittenSpeak, kittenCanRead } from '../kittentts';
import { takeJump as takeSearchJump, storedPages, storePages } from '../booksearch';
import { speakPassage, stopSpeech, speechLangOf, ttsAvailable, languageName, installVoices } from '../tts';
import { attachFurigana, isJapanese } from '../furigana';
import { attachPinyin } from '../readings';
import { scheduleSync, markDeleted } from '../sync';
import { toolbarSheet } from '../ui/toolbarconfig';
import { shareFile, canvasToBlob, saveImage, copyImage } from '../ui/share';
import { applyOrientation } from '../settings';
import { setImmersive, keepAwake, toggleFullscreen, leaveFullscreen, nativePlatform } from '../native';
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

interface SearchHit { bookId: string; label: string; pct: number; before: string; match: string; after: string; range: Range }

export function readerView(ids: string[]): HTMLElement {
  const root = h('div', { class: 'view reader-view' });
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const onDispose = (fn: () => void) => cleanups.push(fn);

  void (async () => {
    const books = (await Promise.all(ids.map((id) => db.getBook(id)))).filter((b): b is Book => !!b);
    if (disposed) return;
    if (!books.length) { navigate('/', true); return; }
    // (A series kept in the library without its volumes opens on its source, where its volumes are.)
    if (books[0].format === 'series' && books[0].remote?.link) { navigate(books[0].remote.link, true); return; }
    setActiveBook(books[0].id); onDispose(() => setActiveBook(null));
    if (books[0].format === 'anki') { const { mountAnki } = await import('./anki'); await mountAnki(root, books[0], onDispose); return; }
    if (books.every((b) => b.format === 'audio')) { const { mountAudio } = await import('./audio'); await mountAudio(root, books, onDispose); return; }
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
  let programmatic = 0; // when the reader last scrolled by itself (restoring a place), so that is not taken for the person scrolling
  const syncChrome = () => { if (!reader.isConnected) { requestAnimationFrame(syncChrome); return; } const cs = getComputedStyle(reader); root.style.setProperty('--chrome-bg', cs.backgroundColor); root.style.setProperty('--chrome-fg', cs.color); document.querySelector('meta[name="theme-color"]')?.setAttribute('content', cs.backgroundColor); document.body.style.background = cs.backgroundColor; };
  onDispose(() => { document.body.style.background = ''; applyChrome(); });
  const syncComfort = () => {
    const st = getComputedStyle(reader); const warm = st.getPropertyValue('--r-warmth').trim(), dim = st.getPropertyValue('--r-dim-overlay').trim();
    root.style.setProperty('--r-warmth', warm); root.style.setProperty('--r-dim-overlay', dim);
    const el = root.querySelector<HTMLElement>('.reader-comfort'); if (el) { el.hidden = !(Number(warm) > 0 || Number(dim) > 0); el.dataset.warm = Number(warm) > 0 ? '1' : '0'; }
  };
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
  const statusLeft = h('span', { class: 'left', title: t('timeLeftChapter') });
  const statusBar = h('div', { class: 'read-status' }, statusWhere, statusPage, h('span', { class: 'sp' }), statusLeft, statusClock, statusBatt, statusPct);
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

  // (Back: to the book's own page when the book opens on one, else the library.)
  const goBack = () => { const b = docs[0]?.book; if (b && leaveToCaller(b.id)) return; if (b && docs.length === 1) void import('./book').then((m) => goBackView(m.wantsBookPage(b) ? `/book/${b.id}` : '/')); else goBackView('/'); };
  const topbar = h('header', { class: 'topbar' },
    iconButton('back', t('back'), goBack),
    title,
    iconButton('fullscreen', t('fullscreen'), () => { void toggleFullscreen(root); }),
  );
  // M3 Expressive floating toolbar carries the reading actions.
  const toolbar = h('nav', { class: 'float-toolbar', 'aria-label': t('more') });
  const TOOLBAR_ITEMS: Record<string, () => HTMLElement> = {
    toc: () => iconButton('toc', t('contents'), () => openContents('toc')),
    search: () => iconButton('search', t('searchInBook'), () => openSearch()),
    images: () => iconButton('images', t('images'), () => showGallery()),
    bookmark: () => iconButton('bookmarkAdd', t('addBookmark'), () => addBookmark()),
    bookmarks: () => iconButton('bookmark', t('bookmarks'), () => openContents('bookmarks')),
    sep: () => h('span', { class: 'sep' }),
    type: () => iconButton('type', t('visualOptions'), () => openOptions()),
    translate: () => iconButton('translate', t('aiTranslate'), () => translator.toggleUi()),
    speak: () => iconButton('speak', t('readAloud'), () => { const cur = currentLocator(); if (cur) speak([], { doc: cur.doc, index: cur.loc.block ?? 0 }); }),
    scroll: () => iconButton('scroll', t('autoScroll'), () => toggleAutoScroll()),
    info: () => iconButton('info', t('bookInfo'), () => showInfo()),
    snapshot: () => iconButton('camera', t('textAsImage'), () => toast(t('selectTextFirst'))),
    fullscreen: () => iconButton('fullscreen', t('fullscreen'), () => { void toggleFullscreen(root); }),
    more: () => iconButton('more', t('more'), () => openMore()),
  };
  const renderToolbar = () => { toolbar.replaceChildren(...getSettings().readerToolbar.filter((id) => TOOLBAR_ITEMS[id]).map((id) => TOOLBAR_ITEMS[id]())); if (!getSettings().readerToolbar.includes('more')) toolbar.appendChild(TOOLBAR_ITEMS.more()); };
  renderToolbar();
  onDispose(onSettingsChange(() => renderToolbar()));
  reader.append(scroll);
  const chapterNav = h('nav', { class: 'chapter-nav', hidden: true });
  root.append(topbar, reader, footer, statusBar, toolbar, h('div', { class: 'reader-comfort', 'aria-hidden': 'true' }));
  syncChrome();
  const chapterMode = () => getSettings().readingMode !== 'continuous';
  const flowMode = () => getSettings().readingMode === 'flow';
  root.append(h('div', { class: 'center', id: 'kr-loading' }, h('div', { class: 'spinner' }), t('loading')));

  const docs: OpenDoc[] = [];
  let lastTracked: { doc: OpenDoc; block: number } | null = null;
  // Late-bound hooks so chapter navigation can run before the chrome helpers are defined.
  const hooks = { update: () => undefined as void, save: () => undefined as void };
  const chapterListeners: (() => void)[] = [];
  const translator = attachTranslator({
    root, scroll,
    blocks: () => docs.filter((d) => !d.wrapper.hidden).flatMap((d) => d.blocks.map((el) => ({ el, bookId: d.book.id }))),
    chapters: () => units().map((u, i) => ({ label: chapterTitle(u) || `${localDigits(i + 1)}`, bookId: u.doc.book.id, blocks: u.doc.allBlocks.filter((b) => u.el === b || u.el.contains(b)) })),
    currentChapter: () => Math.max(0, currentUnitIndex()),
    onChapterChange: (fn) => chapterListeners.push(fn),
  });
  onDispose(() => translator.dispose());
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

  // Reader state lives above the (slow) render loop so toolbar actions used while
  // a long book is still rendering never hit a temporal-dead-zone error.
  let swipe: { x: number; y: number; t: number } | null = null;
  let searchHighlight: Highlight | undefined;
  let autoScrollRaf = 0;
  let autoHud: HTMLElement | null = null;
  let speaking = false;
  let aiAudio: HTMLAudioElement | null = null;
  const aiQueue = new Map<string, Blob>();
  let sleepTimer = 0;

  async function renderDoc(doc: OpenDoc): Promise<void> {
    const handler = flowHandlerFor(doc.book.format);
    const t0 = performance.now();
    const file = await db.getFile(doc.book.id);
    performance.measure('kr:getFile', { start: t0 });
    if (!handler || !file) { doc.wrapper.append(h('p', { class: 'kr-content' }, !file && doc.book.source ? t('linkedFileMissing', { title: doc.book.title }) : t('unsupportedFormat'))); return; }
    const ctx = { bookId: doc.book.id, bookTitle: doc.book.title, publisherStyles: getSettings().publisherStyles, id: (s: string) => `${doc.book.id}-${s}` };
    try {
      doc.render?.dispose();
      doc.wrapper.querySelector('.kr-content')?.remove();
      const t1 = performance.now();
      doc.render = await handler.render(file, ctx);
      performance.measure('kr:render', { start: t1 });
      const t2 = performance.now();
      doc.wrapper.append(doc.render.element);
      if (getSettings().bookFormat || getSettings().smartTypography) applyTypography(doc.render.element);
      doc.allBlocks = [...doc.render.element.querySelectorAll<HTMLElement>(`${BLOCK_SELECTOR}, img`)].filter((b) => !b.closest('table') || b.tagName === 'TD' || b.tagName === 'TH');
      const sections = [...doc.render.element.querySelectorAll<HTMLElement>(':scope > .kr-chapter')].filter((c) => (c.textContent ?? '').trim().length > 0 || c.querySelector('img'));
      doc.chapters = sections.length > 1 ? sections : [doc.render.element];
      doc.chapter = 0;
      doc.blocks = doc.allBlocks;
      if (chapterMode() && doc.chapters.length > 1) {
        // Hide the other chapters before the first layout: laying out a whole book
        // just to show one chapter was most of the time a large EPUB took to open.
        const p = doc.book.progress;
        const pb = p && p.bookId === doc.book.id && p.block !== undefined ? doc.allBlocks[p.block] : undefined;
        const idx = pb ? doc.chapters.findIndex((c) => c === pb || c.contains(pb)) : -1;
        doc.chapter = Math.max(0, idx);
        doc.chapters.forEach((c, i) => { c.hidden = i !== doc.chapter; });
        doc.blocks = doc.allBlocks.filter((b) => doc.chapters[doc.chapter].contains(b));
      }
      applyHighlights(doc);
      performance.measure('kr:dom', { start: t2 });
    } catch (err) {
      console.error(err);
      doc.wrapper.append(h('p', { class: 'kr-content' }, t('openError', { error: String((err as Error)?.message ?? err) })));
    }
  }

  // Render books in order so the first one appears quickly.
  for (const doc of docs) { await renderDoc(doc); if (doc === docs[0]) { const tr = performance.now(); root.querySelector('#kr-loading')?.remove(); restore(); performance.measure('kr:restore', { start: tr }); } }
  const tPost = performance.now();
  root.querySelector('#kr-loading')?.remove();
  // Opened from a search across books: at the found passage (its chapter, its place among the chapter's
  // matches), the matches marked. (Run once the rest of this function has set up the search — the index and
  // the block numbers are declared further down.)
  let setUp: () => void = () => undefined; const ready = new Promise<void>((r) => { setUp = r; });
  {
    const sj = takeSearchJump(docs[0].book.id);
    if (sj) void ready.then(() => searchFlow(sj.q)).then((hits) => {
      if (!reader.isConnected) return;
      const chapters = [...(docs[0].render?.element.querySelectorAll<HTMLElement>(':scope > .kr-chapter') ?? [])];
      const inUnit = hits.filter((hh) => { const el = hh.range.startContainer.parentElement; const c = el?.closest('.kr-chapter'); return c ? chapters.indexOf(c as HTMLElement) === sj.unit : sj.unit === 0; });
      const hit = inUnit[Math.min(sj.nth, inUnit.length - 1)] ?? hits[0];
      if (hit) goToHit(hit);
    });
  }
  allImages = docs.flatMap((d) => d.render?.images ?? []);
  // Furigana for Japanese books (readings generated on the device; the setting shows/hides them).
  const sample = docs.map((d) => d.wrapper.textContent?.slice(0, 4000) ?? '').join('\n');
  const isJa = docs.some((d) => isJapanese(d.wrapper.textContent?.slice(0, 4000) ?? '', d.book.language));
  const isZh = !isJa && (/[\u4e00-\u9fff]/.test(sample) || docs.some((d) => /^zh/i.test(d.book.language ?? '')));
  const isKo = !isJa && !isZh && /[\uac00-\ud7af]/.test(sample);
  scroll.classList.toggle('cjk-book', isJa || isZh || isKo);
  if (isJa || isZh || isKo) scroll.dataset.cjk = isJa ? 'ja' : isZh ? 'zh' : 'ko';
  if (isZh) {
    // Pinyin above the characters of Chinese books (same switch as furigana; readings load from the CDN once).
    let py: (() => void) & { refresh?: () => void } | null = null;
    const start = () => { if (py || !getSettings().furigana) return; py = attachPinyin(scroll, () => docs.filter((d) => !d.wrapper.hidden).flatMap((d) => d.blocks), () => toast(t('pinyinOffline'), 'error', 4000)); };
    start();
    chapterListeners.push(() => py?.refresh?.());
    onDispose(onSettingsChange((st) => { if (st.furigana) start(); }));
    onDispose(() => py?.());
  }
  if (isJa) {
    let furi: (() => void) & { refresh?: () => void } | null = null;
    const start = () => { if (furi || !getSettings().furigana) return; furi = attachFurigana(scroll, () => docs.filter((d) => !d.wrapper.hidden).flatMap((d) => d.blocks), () => toast(t('furiganaOffline'), 'error', 4000)); };
    start();
    chapterListeners.push(() => furi?.refresh?.());
    onDispose(onSettingsChange((st) => { if (st.furigana) start(); }));
    onDispose(() => furi?.());
  }
  // Fade pictures in as they decode rather than letting them pop.
  flow.querySelectorAll('img').forEach((img) => { if (img.complete && img.naturalWidth) return; img.decoding = 'async'; img.classList.add('kr-img-pending'); const done = () => img.classList.remove('kr-img-pending'); img.addEventListener('load', done, { once: true }); img.addEventListener('error', done, { once: true }); });
  books.forEach((b) => void touchBook(b.id));
  void applyOrientation();
  if (getSettings().hideSystemBars) void setImmersive(true);
  keepAwake(getSettings().keepAwake);
  onDispose(() => { void setImmersive(false); keepAwake(false); });
  // Reading statistics: words per block, tracked as the reader scrolls past them.
  const wordsOf = new WeakMap<HTMLElement, number>();
  const wordCount = (b: HTMLElement): number => { let w = wordsOf.get(b); if (w === undefined) { w = b.tagName === 'IMG' ? 0 : countWords(b.textContent ?? ''); wordsOf.set(b, w); } return w; };
  type Idle = Window & { requestIdleCallback?: (cb: (d: { timeRemaining(): number }) => void, o?: { timeout: number }) => number };
  const trackers = new Map<OpenDoc, ReadingTracker>();
  for (const doc of docs) {
    // (The words of every block are counted after the book is on screen, in idle moments: a big book has
    // tens of thousands of blocks, and the count used to hold the opening for seconds.)
    const tr = new ReadingTracker(doc.book, () => currentLocator()?.doc === doc, doc.book.stats?.bookWords, doc.book.stats?.bookChars);
    tr.start();
    trackers.set(doc, tr);
    // (A book counted once is not counted again: the totals are kept with it.)
    if (doc.book.stats?.bookWords != null && doc.book.stats?.bookChars != null) continue;
    let i = 0, total = 0, chars = 0; let gone = false; onDispose(() => { gone = true; });
    const step = (deadline?: { timeRemaining(): number }) => {
      if (gone) return;
      // Only while the browser has nothing else to do — never into a frame that is scrolling.
      const until = performance.now() + (deadline ? Math.min(12, deadline.timeRemaining() - 1) : 6);
      for (; i < doc.allBlocks.length && (i & 15 || performance.now() < until); i++) {
        const b = doc.allBlocks[i]; if (b.tagName === 'IMG') { wordsOf.set(b, 0); continue; }
        const [w, c] = countWordsAndChars(b.textContent ?? ''); wordsOf.set(b, w); total += w; chars += c;
      }
      if (i < doc.allBlocks.length) { const w = window as Idle; if (w.requestIdleCallback) w.requestIdleCallback(step, { timeout: 2000 }); else window.setTimeout(step, 32); }
      else tr.setTotals(total, chars);
    };
    window.setTimeout(step, 1200);
  }
  const trackProgress = () => {
    const cur = currentLocator();
    if (!cur) return;
    const tr = trackers.get(cur.doc); const blocks = cur.doc.allBlocks;
    const block = cur.loc.block ?? 0;
    let passed = 0;
    if (lastTracked && lastTracked.doc === cur.doc && block > lastTracked.block && block - lastTracked.block < 60) for (let i = lastTracked.block; i < block; i++) passed += wordCount(blocks[i]);
    tr?.advance(passed, cur.loc.pct);
    lastTracked = { doc: cur.doc, block };
  };
  onDispose(() => { trackers.forEach((tr) => void tr.stop()); });
  // The eye-rest reminder: every so many minutes with the book open on screen.
  { let read = 0, last = Date.now(); const tick = window.setInterval(() => { const n = getSettings().eyeRestMinutes; const now = Date.now(); if (!document.hidden) read += now - last; last = now; if (n && read >= n * 60000) { read = 0; toast(t('eyeRestNow'), 'info', 8000); } }, 15000); onDispose(() => window.clearInterval(tick)); }
  // Mobile systems may kill the app without warning: flush position and statistics when the page hides.
  const flushAll = () => { hooks.save(); trackers.forEach((tr) => void tr.save()); };
  // (Taken away with the reader: a closed book's would otherwise stay in memory and still save its place.)
  const onHide = () => { if (document.visibilityState === 'hidden') flushAll(); };
  window.addEventListener('pagehide', flushAll); document.addEventListener('visibilitychange', onHide);
  onDispose(() => { window.removeEventListener('pagehide', flushAll); document.removeEventListener('visibilitychange', onHide); });
  if (books.length > 1) toast(t('openedTogether', { n: books.length }));
  performance.measure('kr:post', { start: tPost });
  const tR2 = performance.now();
  restore();
  performance.measure('kr:restore2', { start: tR2 });
  // Images loading above the saved position shift the layout; settle a few times.
  [400, 1200, 2500].forEach((ms) => setTimeout(() => { if (!userScrolled) restore(); }, ms));
  void document.fonts.ready.then(() => { if (!userScrolled && reader.isConnected) restore(); });

  /* ---------- chapter mode ---------- */
  interface Unit { doc: OpenDoc; el: HTMLElement; index: number }
  function units(): Unit[] { return docs.flatMap((doc) => doc.chapters.map((el, index) => ({ doc, el, index }))); }
  function chapterTitle(u: Unit): string {
    const toc = u.doc.render?.toc ?? [];
    const hit = toc.find((item) => { const el = document.getElementById(item.anchor); return !!el && (el === u.el || u.el.contains(el)); });
    return (u.el.querySelector('h1, h2, h3')?.textContent?.trim() || hit?.label || '').trim();
  }
  function currentUnitIndex(): number {
    const cur = currentLocator();
    const list = units();
    const doc = cur?.doc ?? docs[0];
    return Math.max(0, list.findIndex((u) => u.doc === doc && u.index === doc.chapter));
  }
  function applyLayoutMode(): void {
    const on = chapterMode();
    scroll.classList.toggle('reader-continuous', !on);
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
    if (flowMode()) {
      // Scroll-on mode: no buttons, just a hint that pulling past the end goes on.
      chapterNav.classList.add('flow');
      chapterNav.append(h('div', { class: 'cn-pull', dir: 'auto' }, h('div', { class: 'spinner small' }), h('span', null, next ? `${t('pullForNext')} · ${chapterTitle(next)}`.replace(/ · $/, '') : t('endOfBook'))));
      return;
    }
    chapterNav.classList.remove('flow');
    chapterNav.append(
      prev ? h('button', { type: 'button', class: 'cn-btn', onclick: () => showUnit(k - 1) }, icon('chevronLeft'), h('span', { dir: 'auto' }, h('small', null, t('prevChapter')), chapterTitle(prev) || t('previousPage'))) : h('span'),
      next ? h('button', { type: 'button', class: 'cn-btn primary', onclick: () => showUnit(k + 1) }, h('span', { dir: 'auto' }, h('small', null, t('nextChapter')), chapterTitle(next) || t('nextPage')), icon('chevronRight')) : h('span', { class: 'end' }, t('endOfBook')),
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
    chapterListeners.forEach((fn) => fn());
  }
  /** Make sure the element's chapter is on screen (chapter mode) before scrolling to it. */
  function revealElement(el: Element): void {
    if (!chapterMode()) return;
    const list = units();
    const k = list.findIndex((u) => u.el === el || u.el.contains(el));
    if (k >= 0 && (list[k].doc.chapter !== list[k].index || list[k].doc.wrapper.hidden)) showUnit(k);
  }
  // Scroll-on mode: pulling past the end (or the start) of a chapter moves to the next (previous) one.
  {
    let pull = 0, pullDir = 0, armed = false, ty = 0, wheelT = 0;
    const atBottom = () => scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
    const atTop = () => scroll.scrollTop <= 1;
    const indicator = () => chapterNav.querySelector<HTMLElement>('.cn-pull');
    const paintPull = () => { const el = indicator(); if (el) el.style.setProperty('--pull', String(Math.min(1, pull / 110))); root.classList.toggle('pulling', pull > 8); };
    const fire = () => {
      const list = units(); const k = currentUnitIndex();
      if (pullDir > 0 && list[k + 1]) showUnit(k + 1); else if (pullDir < 0 && list[k - 1]) showUnit(k - 1, true);
      pull = 0; paintPull();
    };
    const reset = () => { pull = 0; pullDir = 0; armed = false; paintPull(); };
    scroll.addEventListener('touchstart', (e) => { if (!flowMode()) return; ty = e.touches[0].clientY; armed = atBottom() || atTop(); pull = 0; }, { passive: true });
    scroll.addEventListener('touchmove', (e) => {
      if (!flowMode() || !armed) return;
      const dy = e.touches[0].clientY - ty; ty = e.touches[0].clientY;
      if (dy < 0 && atBottom()) { pullDir = 1; pull += -dy; paintPull(); }
      else if (dy > 0 && atTop()) { pullDir = -1; pull += dy; paintPull(); }
      else if (pull > 0) { pull = Math.max(0, pull - Math.abs(dy)); paintPull(); }
    }, { passive: true });
    scroll.addEventListener('touchend', () => { if (!flowMode()) return; if (pull >= 110) fire(); else reset(); }, { passive: true });
    scroll.addEventListener('wheel', (e) => {
      if (!flowMode() || e.ctrlKey) return;
      if (e.deltaY > 0 && atBottom()) { pullDir = 1; pull += e.deltaY; }
      else if (e.deltaY < 0 && atTop()) { pullDir = -1; pull += -e.deltaY; }
      else { if (pull) reset(); return; }
      paintPull();
      window.clearTimeout(wheelT); wheelT = window.setTimeout(reset, 700);
      if (pull >= 240) { window.clearTimeout(wheelT); fire(); }
    }, { passive: true });
  }
  // Swipe between chapters on touch screens.
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
    const sr = scroll.getBoundingClientRect();
    if (!reader.isConnected || sr.height < 40 || sr.width < 40) return null;
    const doc = docAt(probeY);
    if (!doc) return null;
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
    // Block index is always relative to the whole book, so a position survives switching
    // between chapter and continuous mode; progress is weighted by content, not by chapter count.
    const globalIdx = block ? blockIndexOf(doc, block) : -1;
    if (chapterMode() && doc.chapters.length > 1) {
      const cr = doc.chapters[doc.chapter].getBoundingClientRect();
      const within = Math.min(1, Math.max(0, (sr.top - cr.top + probeY) / Math.max(1, cr.height - sr.height * 0.5)));
      const first = doc.allBlocks.indexOf(blocks[0]);
      pct = doc.allBlocks.length ? Math.min(1, Math.max(0, (Math.max(0, first) + within * blocks.length) / doc.allBlocks.length)) : (doc.chapter + within) / doc.chapters.length;
    }
    const tocIdx = block ? tocIndexFor(doc, block) : -1;
    return { doc, loc: { bookId: doc.book.id, block: globalIdx >= 0 ? globalIdx : lo, offset, pct, chapter: doc.chapter, ...(tocIdx >= 0 ? { toc: tocIdx } : {}) } };
  }

  function scrollToLocator(loc: Locator): void {
    const doc = docs.find((d) => d.book.id === loc.bookId) ?? docs[0];
    if (!doc) return;
    programmatic = performance.now();
    if (loc.anchor) { scrollToAnchor(loc.anchor); return; }
    // Positions are stored as whole-book block indices; older ones were chapter-local.
    let target = doc.allBlocks[loc.block ?? 0];
    if (chapterMode() && doc.chapters.length > 1) {
      const ch = Math.min(doc.chapters.length - 1, loc.chapter ?? 0);
      if (target && loc.chapter !== undefined && !doc.chapters[ch].contains(target)) {
        const local = doc.allBlocks.filter((b) => doc.chapters[ch].contains(b))[loc.block ?? 0];
        if (local) target = local;
      }
      const wantCh = target ? doc.chapters.findIndex((c) => c.contains(target)) : ch;
      const goCh = wantCh >= 0 ? wantCh : ch;
      if (goCh !== doc.chapter || doc.wrapper.hidden) { const k = units().findIndex((u) => u.doc === doc && u.index === goCh); if (k >= 0) showUnit(k); }
    }
    const sr = scroll.getBoundingClientRect();
    const block = target ?? doc.blocks[loc.block ?? 0];
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
    const jump = takeJump();
    if (jump) {
      const doc = docs.find((d) => d.book.id === jump.bookId) ?? first;
      if (jump.kind === 'bm') { const bm = doc.book.bookmarks.find((x) => x.id === jump.id); if (bm) { scrollToLocator(bm.locator); return; } }
      if (jump.kind === 'toc') { const i = Number(jump.id); const item = doc.render?.toc?.[i]; if (item) { setTimeout(() => scrollToAnchor(item.anchor, false), 30); return; } }
      if (jump.kind === 'anchor') { setTimeout(() => scrollToAnchor(jump.id, false), 30); return; }
      if (jump.kind === 'hl') { setTimeout(() => { const m = doc.wrapper.querySelector(`mark[data-hl="${jump.id}"]`) as HTMLElement | null; if (m) { if (!m.id) m.id = `hl-${jump.id}`; scrollToAnchor(m.id); } }, 50); return; }
    }
    const p = first.book.progress;
    if (p && p.bookId === first.book.id) scrollToLocator(p);
  }

  /** Which contents entry a block falls under (the last one that starts at or before it). A binary search
   *  over the contents, so a book with thousands of entries costs a dozen comparisons a scroll, not thousands. */
  const anchorsOf = new Map<OpenDoc, Element[]>();
  function tocAnchor(doc: OpenDoc, i: number): Element | null {
    let arr = anchorsOf.get(doc); if (!arr) { arr = []; anchorsOf.set(doc, arr); }
    // (A missing one is looked for again: its chapter may not be on the page yet.)
    const have = arr[i]; if (have?.isConnected) return have;
    const el = document.getElementById(doc.render?.toc?.[i]?.anchor ?? ''); if (el) arr[i] = el;
    return el;
  }
  function tocIndexFor(doc: OpenDoc, block: Element): number {
    const toc = doc.render?.toc ?? []; if (!toc.length) return -1;
    const startsBefore = (i: number): boolean | null => { const el = tocAnchor(doc, i); if (!el) return null; return !!(el.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) || el === block || el.contains(block); };
    let lo = 0, hi = toc.length - 1, best = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1; let k = m; let r = startsBefore(k);
      while (r === null && k < hi) r = startsBefore(++k);
      if (r === null) { hi = m - 1; continue; }
      if (r) { best = k; lo = k + 1; } else hi = m - 1;
    }
    return best;
  }
  function labelFor(doc: OpenDoc, blockIdx: number): string {
    const block = doc.allBlocks[blockIdx]; if (!block) return doc.book.title;
    const i = tocIndexFor(doc, block);
    return (i >= 0 ? doc.render?.toc?.[i]?.label : '') || doc.book.title;
  }
  /** A block's place in the whole book (looked up, not searched for: a hit list has hundreds). */
  const blockIdx = new WeakMap<OpenDoc, WeakMap<Element, number>>();
  function blockIndexOf(doc: OpenDoc, block: Element): number {
    let m = blockIdx.get(doc);
    if (!m || m.get(doc.allBlocks[doc.allBlocks.length - 1]) === undefined) { m = new WeakMap(); doc.allBlocks.forEach((b, i) => m!.set(b, i)); blockIdx.set(doc, m); }
    return m.get(block) ?? -1;
  }

  /* ---------- the next volume, when the book ends ---------- */
  let nextVol: Book | null = null; let nextPill: HTMLElement | null = null; let queued = false;
  const findNext = () => nextQueued(books[books.length - 1].id).then(async (q) => { if (q) { nextVol = q; queued = true; return; } queued = false; nextVol = nextVolume(books[books.length - 1], await db.allBooks()); }).catch(() => undefined);
  void findNext().then(() => updateChrome());
  const offerNext = (pct: number) => {
    if (!nextVol || nextPill || pct < 0.985) return;
    const next = nextVol;
    nextPill = h('button', { type: 'button', class: 'jump-back next-volume', onclick: () => { navigate(`/read/${next.id}`); } }, h('span', { dir: 'auto' }, `${queued ? t('nextInOrder') : t('nextVolume')}: ${next.title}`), icon('arrowRight'));
    root.appendChild(nextPill);
  };
  // Reading in order: scrolling on past the end goes to the next book.
  const lastUnitShown = () => { const d = docs[docs.length - 1]; return !chapterMode() || d.chapters.length <= 1 || (d.chapter >= d.chapters.length - 1 && !d.wrapper.hidden); };
  onDispose(overscrollNext(scroll, () => (queued && nextVol && lastUnitShown() ? nextVol.id : null)));


  // (All reads first, then all writes: a write between two reads would make the browser lay the page out
  // again in the middle of a scroll.)
  const unitWords = new WeakMap<Element, { start: number; after: number[] }>();
  const wordsLeft = (doc: OpenDoc, unit: Element, block: number): number => {
    let u = unitWords.get(unit);
    if (!u) {
      // The unit's blocks are one run of allBlocks; the words after each one, summed once.
      let start = -1, endAt = doc.allBlocks.length;
      for (let i = 0; i < doc.allBlocks.length; i++) { const inside = unit.contains(doc.allBlocks[i]); if (inside && start < 0) start = i; else if (!inside && start >= 0) { endAt = i; break; } }
      if (start < 0) { start = 0; endAt = 0; }
      const after = new Array<number>(endAt - start + 1).fill(0);
      for (let i = endAt - 1; i >= start; i--) after[i - start] = after[i - start + 1] + wordCount(doc.allBlocks[i]);
      u = { start, after }; unitWords.set(unit, u);
    }
    const i = Math.min(u.after.length - 1, Math.max(0, block - u.start));
    return u.after[i];
  };
  let lastLabel = '', lastTitleDoc: OpenDoc | null = null;
  const updateChrome = throttle(() => {
    const cur = currentLocator();
    if (!cur) return;
    const label = labelFor(cur.doc, cur.loc.block ?? 0);
    const pct = Math.round(cur.loc.pct * 100);
    const unitEl = cur.doc.chapters[cur.doc.chapter] ?? cur.doc.wrapper;
    const sr = scroll.getBoundingClientRect(); const ur = unitEl.getBoundingClientRect();
    const total = Math.max(1, Math.ceil(ur.height / Math.max(1, sr.height)));
    const page = Math.min(total, Math.max(1, Math.floor((sr.top - ur.top) / Math.max(1, sr.height)) + 1));
    // Minutes left in the chapter at the reader's own pace (once a pace is known).
    const speed = getSettings().showTimeLeft ? trackers.get(cur.doc)?.speed() : null;
    const mins = speed ? Math.ceil(wordsLeft(cur.doc, unitEl, cur.loc.block ?? 0) / speed) : 0;
    // — writes —
    if (label !== lastLabel || cur.doc !== lastTitleDoc) {
      lastLabel = label; lastTitleDoc = cur.doc;
      clear(title);
      title.append(document.createTextNode(cur.doc.book.title), h('small', { dir: 'auto' }, label !== cur.doc.book.title ? label : (cur.doc.book.author ?? '')));
      title.setAttribute('dir', 'auto');
      footerWhere.textContent = docs.length > 1 ? `${docs.indexOf(cur.doc) + 1}/${docs.length} · ${label}` : label;
      footerWhere.setAttribute('dir', 'auto');
      statusWhere.textContent = label; statusWhere.setAttribute('dir', 'auto');
    }
    const pctText = `${localDigits(pct)}%`;
    if (footerPct.textContent !== pctText) { footerPct.textContent = pctText; footerBar.style.width = `${pct}%`; statusPct.textContent = pctText; }
    const pageText = `(${localDigits(page)}/${localDigits(total)})`;
    if (statusPage.textContent !== pageText) statusPage.textContent = pageText;
    const leftText = mins > 0 ? `⏳${localDigits(mins)}${getLang() === 'ar' ? ' د' : 'm'}` : '';
    if (statusLeft.textContent !== leftText) statusLeft.textContent = leftText;
    if (cur.doc === docs[docs.length - 1] && lastUnitShown()) offerNext(scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2 ? 1 : cur.loc.pct);
  }, 150);

  function scheduleSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveProgress, 600);
  }
  async function saveProgress(): Promise<void> {
    const cur = currentLocator();
    if (!cur) return;
    await db.updateBook(cur.doc.book.id, (b) => { b.progress = cur.loc; b.progressAt = Date.now(); });
    if (cur.doc.book.track && cur.loc.toc !== undefined) void import('../ui/track').then((m) => m.pushProgress(cur.doc.book, cur.loc.toc! + 1));
    scheduleSync();
    cur.doc.book.progress = cur.loc;
    // Books fully scrolled past count as finished.
    for (const d of docs) if (d !== cur.doc && docs.indexOf(d) < docs.indexOf(cur.doc) && (d.book.progress?.pct ?? 0) < 1) { d.book.progress = { bookId: d.book.id, pct: 1 }; await db.updateBook(d.book.id, (b) => { b.progress = d.book.progress; }); }
  }

  hooks.update = () => updateChrome();
  hooks.save = () => scheduleSave();
  const trackThrottled = throttle(trackProgress, 400);
  scroll.addEventListener('scroll', () => { if (performance.now() - programmatic > 150) userScrolled = true; updateChrome(); scheduleSave(); trackThrottled(); noteStable(); focusThrottled(); }, { passive: true });
  // Focus mode: the paragraph under the reading line (a little above the middle of the screen) is the one
  // that stands out; the rest of the page is dimmed by CSS. Found by a point test, so it costs nothing.
  let focused: HTMLElement | null = null;
  const syncFocus = () => {
    if (!getSettings().focusMode) { focused?.classList.remove('kr-focus'); focused = null; return; }
    const r = scroll.getBoundingClientRect();
    const y = r.top + r.height * 0.4;
    let hit: HTMLElement | null = null;
    for (const x of [0.5, 0.3, 0.7]) { const el = document.elementFromPoint(r.left + r.width * x, y) as HTMLElement | null; hit = el?.closest<HTMLElement>(BLOCK_SELECTOR) ?? null; if (hit && flow.contains(hit)) break; hit = null; }
    if (hit === focused) return;
    focused?.classList.remove('kr-focus'); focused = hit; focused?.classList.add('kr-focus');
  };
  const focusThrottled = throttle(syncFocus, 80);
  window.setTimeout(syncFocus, 600);
  // The screen turned (or the window resized): the text reflows, so the place being read is found again and
  // put back where it was — the reader does not land somewhere else in the chapter.
  let stable: Locator | null = null; let stableTimer = 0; let lastW = scroll.clientWidth, lastH = scroll.clientHeight; let resizing = false;
  let lastScrollAt = 0;
  const noteStable = () => { lastScrollAt = performance.now(); if (resizing) return; window.clearTimeout(stableTimer); stableTimer = window.setTimeout(() => { const c = currentLocator(); if (c) stable = c.loc; layAhead(); }, 250); };
  // Continuous reading keeps chapters away from the screen unlaid (content-visibility), and laying one out when
  // it comes near takes a frame or three on a phone — a page of Arabic, shaped, is slow work — which showed as
  // a catch in every fling that reached a new chapter. So once the scrolling has settled, the chapters within
  // two screens below are laid out in idle moments, one at a time, and are ready when the reader gets there.
  let aheadTimer = 0;
  const layAhead = () => {
    window.clearTimeout(aheadTimer);
    if (!reader.isConnected || chapterMode()) return;
    const step = () => {
      // (Not into a fling that has started since: the next settling brings it back.)
      if (!reader.isConnected || chapterMode() || performance.now() - lastScrollAt < 200) return;
      const sr = scroll.getBoundingClientRect(); const until = sr.bottom + sr.height * 2;
      for (const doc of docs) for (const ch of doc.chapters) {
        const r = ch.getBoundingClientRect();
        if (r.bottom < sr.top - sr.height) continue;
        if (r.top > until) return;
        const last = ch.lastElementChild; if (!last) continue;
        const t0 = performance.now(); last.getBoundingClientRect();
        // One slow chapter per idle slot; the rest follow in the next.
        if (performance.now() - t0 > 3) { const w = window as Idle; if (w.requestIdleCallback) w.requestIdleCallback(() => step(), { timeout: 1500 }); else aheadTimer = window.setTimeout(step, 50); return; }
      }
    };
    const w = window as Idle; if (w.requestIdleCallback) w.requestIdleCallback(() => step(), { timeout: 1500 }); else aheadTimer = window.setTimeout(step, 50);
  };
  onDispose(() => window.clearTimeout(aheadTimer));
  window.setTimeout(layAhead, 900);
  const sizeObs = new ResizeObserver(() => {
    const w = scroll.clientWidth, hgt = scroll.clientHeight;
    if (Math.abs(w - lastW) < 2 && Math.abs(hgt - lastH) < 2) return;
    lastW = w; lastH = hgt;
    if (!stable) { noteStable(); return; }
    resizing = true; const at = stable;
    requestAnimationFrame(() => { scrollToLocator(at); window.setTimeout(() => { resizing = false; }, 300); });
  });
  sizeObs.observe(scroll); onDispose(() => sizeObs.disconnect());
  window.setTimeout(noteStable, 1500);
  updateChrome();
  onDispose(() => { window.clearTimeout(saveTimer); void saveProgress(); docs.forEach((d) => d.render?.dispose()); });

  /* ---------- settings ---------- */
  let typoOn = getSettings().bookFormat || getSettings().smartTypography;
  onDispose(onSettingsChange((s) => {
    applySettings(reader, s); syncChrome(); syncComfort(); statusBar.hidden = !s.showStatusLine; updateChrome();
    const want = s.bookFormat || s.smartTypography;
    if (want !== typoOn) { typoOn = want; for (const d of docs) if (d.render) (want ? applyTypography : revertTypography)(d.render.element); }
    syncFocus();
  }));
  root.addEventListener('kr-rerender', async () => {
    const cur = currentLocator();
    for (const doc of docs) await renderDoc(doc);
    allImages = docs.flatMap((d) => d.render?.images ?? []);
    applyLayoutMode();
    if (cur) scrollToLocator(cur.loc);
  });
  applyLayoutMode();

  /* ---------- speed reading ---------- */
  async function startSpeedReading(): Promise<void> {
    const cur = currentLocator(); if (!cur) return;
    const { speedReader, rsvpUnits } = await import('../ui/rsvp');
    const from = cur.loc.block ?? 0; const unit = cur.doc.chapters[cur.doc.chapter] ?? cur.doc.wrapper;
    // The words from here to the end of the chapter (or of the book in continuous mode), with where each block starts.
    const starts: number[] = []; let text = '';
    for (let i = from; i < cur.doc.allBlocks.length; i++) { const b = cur.doc.allBlocks[i]; if (chapterMode() && !unit.contains(b)) break; if (b.tagName === 'IMG') continue; starts.push(rsvpUnits(text).length); text += (b.textContent ?? '') + ' '; }
    const units = rsvpUnits(text); if (!units.length) { toast(t('noResults')); return; }
    root.classList.add('immersive');
    speedReader(root, units, { onClose: (at) => {
      // Back in the text where the reading stopped.
      let k = 0; for (let j = 0; j < starts.length; j++) if (starts[j] <= at) k = j;
      scrollToLocator({ bookId: cur.doc.book.id, block: from + k, offset: 0, pct: cur.loc.pct });
    } });
  }

  /* ---------- a way back after a jump ---------- */
  // Following a link, a contents entry, a bookmark or a search hit leaves the place being read; a pill offers
  // the way back to it (and back again, and so on), as long as the reader has not moved on by themselves.
  const back = jumpBack(root, (loc) => { scrollToLocator(loc as Locator); }, () => currentLocator()?.loc ?? null, scroll);
  onDispose(back.dispose);

  /* ---------- links & taps ---------- */
  flow.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a[data-kr-anchor]') as HTMLElement | null;
    if (a) { e.preventDefault(); back.remember(); scrollToAnchor(a.dataset.krAnchor!); return; }
    const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
    if (img && allImages.length) { const idx = allImages.findIndex((im) => im.anchor === img.id); if (idx >= 0) { showGallery(idx); return; } }
    if ((e.target as HTMLElement).closest('a, button, input, select, mark, .kr-sheet-tabs')) return;
    if (document.getSelection()?.isCollapsed === false) return;
    // Tap zones on touch screens (nine of them, each given its action in the options; by default the lower
    // third turns to the next screen, the upper to the previous, the middle shows or hides the chrome).
    if (getSettings().tapToTurn && isTouchDevice()) {
      const sr = scroll.getBoundingClientRect(); const x = (e.clientX - sr.left) / sr.width, y = (e.clientY - sr.top) / sr.height;
      const col = x < 1 / 3 ? 0 : x < 2 / 3 ? 1 : 2, row = y < 0.22 ? 0 : y < 0.62 ? 1 : 2;
      const action = (getSettings().tapZones ?? [])[row * 3 + col] ?? 'menu';
      if (action !== 'menu') { tapAction(action); return; }
    }
    const on = root.classList.toggle('immersive');
    if (nativePlatform() === 'android' || nativePlatform() === 'ios') void setImmersive(on || getSettings().hideSystemBars);
  });

  onDispose(attachEdgeBrightness(scroll));
  onDispose(attachPinchText(scroll));
  onDispose(attachRuler(root, scroll));
  // Ctrl + mouse wheel changes the text size (desktop).
  scroll.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); const d = e.deltaY < 0 ? 1 : -1; updateSettings({ fontSize: Math.min(40, Math.max(12, getSettings().fontSize + d)) }); }, { passive: false });
  /** A screen forward or back, with the turn shown as set (a slide or a fade of the text). */
  function turnScreen(dir: 1 | -1): void {
    const page = scroll.getBoundingClientRect().height * 0.88;
    const anim = getSettings().turnAnimation;
    if (anim !== 'none') { flow.classList.remove('turn-next', 'turn-prev', 'turn-fade'); void flow.offsetWidth; flow.classList.add(anim === 'fade' ? 'turn-fade' : dir > 0 ? 'turn-next' : 'turn-prev'); }
    scroll.scrollBy({ top: page * dir, behavior: anim === 'none' ? 'smooth' : 'auto' });
  }
  function tapAction(a: string): void {
    if (a === 'next') turnScreen(1); else if (a === 'prev') turnScreen(-1);
    else if (a === 'none') return;
    else document.dispatchEvent(new CustomEvent('kr:command', { detail: a === 'autoScroll' ? 'scroll' : a }));
  }
  const onCommand = (e: Event) => {
    const c = (e as CustomEvent<string>).detail;
    if (c === 'scroll') { toggleAutoScroll(); return; }
    if (c === 'search') openSearch(); else if (c === 'options') openOptions(); else if (c === 'toc') openContents('toc'); else if (c === 'bookmark') void addBookmark();
    else if (c === 'translate') translator.toggleUi(); else if (c === 'speak') { if (speaking) stopSpeaking(); else { const cur = currentLocator(); if (cur) speak([], { doc: cur.doc, index: cur.loc.block ?? 0 }); } }
    else if (c === 'fullscreen') { void toggleFullscreen(root); }
    else if (c === 'nextChapter' || c === 'prevChapter') { if (chapterMode()) { const k = currentUnitIndex(); showUnit(c === 'nextChapter' ? k + 1 : k - 1); } }
    else if (c === 'fontUp') updateSettings({ fontSize: Math.min(40, getSettings().fontSize + 1) }); else if (c === 'fontDown') updateSettings({ fontSize: Math.max(12, getSettings().fontSize - 1) });
  };
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
    lang: () => currentLocator()?.doc.book.language ?? docs[0]?.book.language,
    speak: (text) => speak([text]),
    textImage: (text) => void textImage(text),
  }));

  async function textImage(text: string): Promise<void> {
    const cur = currentLocator();
    const book = cur?.doc.book ?? docs[0].book;
    try {
      const opts = { text, title: book.title, author: book.author, appName: getSettings().snapWatermark ? t('appName') : '' };
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
    doc.book.highlights = [...(doc.book.highlights ?? []), hl]; scheduleSync();
    await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; });
    if (note) renumberNotes(doc);
    updateSettings({ highlightColor: color });
    if (!note) toast(t('highlight'));
  }

  /** Numbered bubbles after highlights that carry a note, numbered in creation order per book. */
  function renumberNotes(doc: OpenDoc): void {
    doc.wrapper.querySelectorAll('.kr-note-badge').forEach((b) => b.remove());
    const noted = (doc.book.highlights ?? []).filter((x) => x.note).sort((a, b) => a.createdAt - b.createdAt);
    noted.forEach((hl, i) => {
      const marks = doc.wrapper.querySelectorAll(`mark[data-hl="${hl.id}"]`);
      const last = marks[marks.length - 1];
      if (!last) return;
      last.after(h('sup', { class: 'kr-note-badge', dataset: { hl: hl.id }, title: hl.note!, role: 'button', tabindex: '0' }, localDigits(i + 1)));
    });
  }

  // Tapping a highlight or a note bubble: change colour, edit note, or remove.
  flow.addEventListener('click', (e) => {
    const mark = (e.target as HTMLElement).closest('mark.kr-hl, .kr-note-badge') as HTMLElement | null;
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
      h('button', { class: 'btn primary small', onclick: async () => { hl.note = ta.value.trim() || undefined; hl.noteAt = Date.now(); scheduleSync(); doc.wrapper.querySelectorAll(`mark[data-hl="${id}"]`).forEach((m) => { (m as HTMLElement).title = hl.note ?? ''; m.classList.toggle('has-note', !!hl.note); }); await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; }); renumberNotes(doc); sheet.close(); toast(t('noteSaved')); } }, icon('check'), t('done')));
  }, true);

  function applyHighlights(doc: OpenDoc): void {
    for (const hl of doc.book.highlights ?? []) {
      const scope = (hl.anchor && document.getElementById(hl.anchor)) || doc.render?.element;
      if (!scope) continue;
      const range = findTextRange(scope, hl.text);
      if (range) { const marks = wrapRange(range, 'kr-hl', hl.color, hl.id); if (hl.note) marks.forEach((m) => { m.title = hl.note!; m.classList.add('has-note'); }); }
    }
    renumberNotes(doc);
  }

  async function removeHighlight(doc: OpenDoc, id: string): Promise<void> {
    doc.wrapper.querySelectorAll(`mark[data-hl="${id}"]`).forEach((m) => m.replaceWith(...m.childNodes));
    void markDeleted(id);
    doc.book.highlights = (doc.book.highlights ?? []).filter((x) => x.id !== id);
    await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; });
    renumberNotes(doc);
  }

  /* ---------- bookmarks ---------- */
  async function addBookmark(): Promise<void> {
    const cur = currentLocator();
    if (!cur) return;
    const block = cur.doc.allBlocks[cur.loc.block ?? 0];
    const excerpt = (block?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const bm: Bookmark = { id: uid(), label: labelFor(cur.doc, cur.loc.block ?? 0), excerpt, locator: cur.loc, createdAt: Date.now() };
    cur.doc.book.bookmarks = [...(cur.doc.book.bookmarks ?? []), bm];
    await db.updateBook(cur.doc.book.id, (b) => { b.bookmarks = cur.doc.book.bookmarks; });
    toast(t('bookmarkAdded'));
    panel.refresh();
  }

  /* ---------- panel: contents / bookmarks / highlights ---------- */
  function openContents(tab: 'toc' | 'bookmarks' | 'highlights' | 'notes'): void {
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
          // Each entry's length: minutes at the reader's pace (or a usual one), from the words up to the next entry.
          const speed = trackers.get(doc)?.speed() || 200;
          const starts = toc.map((it) => { const el = document.getElementById(it.anchor); return el ? doc.allBlocks.findIndex((b) => b === el || el.contains(b) || (el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) : -1; });
          const cum: number[] = [0]; for (const b of doc.allBlocks) cum.push(cum[cum.length - 1] + wordCount(b));
          const lengthOf = (i: number) => { const a = starts[i]; if (a < 0) return 0; let j = i + 1; while (j < starts.length && (starts[j] < 0 || starts[j] <= a)) j++; const b = j < starts.length ? starts[j] : doc.allBlocks.length; return Math.round((cum[b] - cum[a]) / speed); };
          toc.forEach((item, i) => { const mins = lengthOf(i); ul.append(h('li', { class: `depth-${Math.min(3, item.depth)}` }, h('button', { type: 'button', class: cur?.doc === doc && item.label === curLabel ? 'current' : '', dir: 'auto', onclick: () => { back.remember(); scrollToAnchor(item.anchor, false); panel.close(); } }, h('span', { class: 'toc-label' }, item.label), mins > 0 ? h('span', { class: 'toc-len' }, getLang() === 'ar' ? `${localDigits(mins)} د` : `${mins} min`) : null))); });
          body.append(ul);
        }
        body.querySelector('.current')?.scrollIntoView({ block: 'center' });
      } },
      { id: 'bookmarks', label: t('bookmarks'), render: (body) => {
        const all = docs.flatMap((d) => (d.book.bookmarks ?? []).map((bm) => ({ doc: d, bm }))).sort((a, b) => b.bm.createdAt - a.bm.createdAt);
        if (!all.length) { body.append(h('p', { class: 'center' }, t('noBookmarks'))); return; }
        body.append(h('ul', { class: 'plain-list' }, ...all.map(({ doc, bm }) => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { back.remember(); scrollToLocator(bm.locator); panel.close(); } },
            h('span', { dir: 'auto' }, bm.label), h('span', { class: 'meta', dir: 'auto' }, (docs.length > 1 ? doc.book.title + ' · ' : '') + (bm.excerpt ?? ''))),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(bm.id); doc.book.bookmarks = doc.book.bookmarks.filter((x) => x.id !== bm.id); await db.updateBook(doc.book.id, (b) => { b.bookmarks = doc.book.bookmarks; }); panel.refresh(); } }, icon('trash'))))));
      } },
      { id: 'notes', label: t('notes'), render: (body) => {
        const all = docs.flatMap((d) => (d.book.highlights ?? []).filter((x) => x.note).sort((a, b) => a.createdAt - b.createdAt).map((hl, i) => ({ doc: d, hl, n: i + 1 })));
        if (!all.length) { body.append(h('p', { class: 'center' }, t('noNotes'))); return; }
        body.append(h('ul', { class: 'plain-list' }, ...all.map(({ doc, hl, n }) => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => { const m = doc.wrapper.querySelector(`mark[data-hl="${hl.id}"]`) as HTMLElement | null; if (m) { if (!m.id) m.id = `hl-${hl.id}`; scrollToAnchor(m.id); } panel.close(); } },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(n)), h('span', { dir: 'auto', class: 'meta' }, hl.text.length > 120 ? hl.text.slice(0, 120) + '…' : hl.text)),
            h('span', { dir: 'auto' }, hl.note!)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { hl.note = undefined; doc.wrapper.querySelectorAll(`mark[data-hl="${hl.id}"]`).forEach((m) => { (m as HTMLElement).title = ''; m.classList.remove('has-note'); }); await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; }); renumberNotes(doc); panel.refresh(); } }, icon('trash'))))));
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
  function clearSearchMarks(): void {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    reg?.delete('kr-search');
    reg?.delete('kr-search-current');
  }
  onDispose(clearSearchMarks);

  // Searching the book. Each chapter's text nodes are gathered once and their search forms (harakat, tatweel
  // and letter variants aside) joined into one string, kept from one search to the next and made ahead in idle
  // moments; a search is then a scan of a few long strings — a book of fifteen million letters in a fraction
  // of a second — run in slices between frames, handing over its hits as it goes, so the page stays live and
  // the first results show at once. A chapter whose text changes (a highlight added) is gathered again.
  interface ChapterIndex { nodes: Text[]; parts: string[]; starts: number[]; next: number; text: string | null; dirty: boolean }
  const chapterIndexes = new WeakMap<Element, ChapterIndex>();
  const watched = new WeakSet<Element>();
  function unitsOf(doc: OpenDoc): Element[] {
    const content = doc.render?.element; if (!content) return [];
    if (!watched.has(content)) {
      watched.add(content);
      const obs = new MutationObserver((muts) => { for (const m of muts) { const el = (m.target instanceof Element ? m.target : m.target.parentElement)?.closest('.kr-chapter') ?? content; const ix = chapterIndexes.get(el); if (ix) ix.dirty = true; } });
      obs.observe(content, { childList: true, subtree: true, characterData: true }); onDispose(() => obs.disconnect());
    }
    return doc.chapters.length ? doc.chapters : [content];
  }
  function textNodesUnder(el: Element): Text[] {
    // (Style and script elements are stepped over whole, rather than every text node asking for its ancestors.)
    // (Readings — furigana, pinyin — stepped over too: a search is for the text.)
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : /^(style|script|rt|rp)$/.test((n as Element).localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP });
    const nodes: Text[] = []; let node: Node | null;
    while ((node = walker.nextNode())) nodes.push(node as Text);
    return nodes;
  }
  /** The index of a chapter, built as far as `until` allows (null when more remains; call again). */
  function chapterIndex(el: Element, until = Infinity): ChapterIndex | null {
    let ix = chapterIndexes.get(el);
    if (!ix || ix.dirty) { ix = { nodes: textNodesUnder(el), parts: [], starts: [], next: 0, text: null, dirty: false }; chapterIndexes.set(el, ix); }
    if (ix.text !== null) return ix;
    let at = ix.starts.length ? ix.starts[ix.starts.length - 1] + ix.parts[ix.parts.length - 1].length + 1 : 0;
    for (; ix.next < ix.nodes.length; ix.next++) {
      if ((ix.next & 31) === 0 && performance.now() > until) return null;
      const form = searchFormOf(ix.nodes[ix.next].data);
      ix.starts.push(at); ix.parts.push(form); at += form.length + 1;
    }
    ix.text = ix.parts.join('\n');   // (the break keeps a match inside one node, as the page has it)
    return ix;
  }
  const yieldToPage = (): Promise<void> => new Promise((r) => { const sch = (window as Window & { scheduler?: { yield?(): Promise<void> } }).scheduler; if (sch?.yield) void sch.yield().then(r); else setTimeout(r, 0); });
  /** Run `query` through the book, calling `onHits` with each slice's hits; resolves to all of them. */
  async function searchFlow(query: string, onHits?: (hits: SearchHit[]) => void, live?: () => boolean): Promise<SearchHit[]> {
    const q = normalizeForSearch(query.trim());
    const hits: SearchHit[] = [];
    if (!q.text) return hits;
    const ranges: Range[] = [];
    const LIMIT = 500, SLICE = 600000;   // letters looked through between two breaths
    for (const doc of docs) {
      const all = doc.allBlocks.length ? doc.allBlocks : doc.blocks;
      let batch: SearchHit[] = []; let done = 0;
      for (const unit of unitsOf(doc)) {
        if (hits.length >= LIMIT) break;
        // (A chapter not indexed yet is indexed now, a slice at a time.)
        let ix = chapterIndex(unit, performance.now() + 12);
        while (!ix) { if (batch.length) { onHits?.(batch); batch = []; } await yieldToPage(); if (live && !live()) return hits; ix = chapterIndex(unit, performance.now() + 12); }
        const text = ix.text!; done += text.length;
        const maps = new Map<number, { text: string; map: Int32Array }>();
        for (let at = text.indexOf(q.text); at >= 0 && hits.length < LIMIT; at = text.indexOf(q.text, at + q.text.length)) {
          // The node the hit falls in: the last one starting at or before it.
          let lo = 0, hi = ix.starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ix.starts[m] <= at) lo = m; else hi = m - 1; }
          const node = ix.nodes[lo]; const local = at - ix.starts[lo];
          if (local + q.text.length > ix.parts[lo].length || !node.isConnected) continue;
          let norm = maps.get(lo); if (!norm) { norm = normalizeForSearch(node.data); maps.set(lo, norm); }
          const raw = node.data;
          const s = norm.map[local], e = norm.map[Math.min(norm.map.length - 1, local + q.text.length)];
          const range = document.createRange(); range.setStart(node, s); range.setEnd(node, e); ranges.push(range);
          const block = node.parentElement?.closest(BLOCK_SELECTOR) as HTMLElement | null;
          const bi = block ? Math.max(0, blockIndexOf(doc, block)) : 0;
          const hit = { bookId: doc.book.id, label: labelFor(doc, bi), pct: all.length ? (bi / all.length) * 100 : 0, before: raw.slice(Math.max(0, s - 60), s), match: raw.slice(s, e), after: raw.slice(e, e + 60), range };
          hits.push(hit); batch.push(hit);
        }
        if (done >= SLICE) {
          done = 0;
          if (batch.length) { onHits?.(batch); batch = []; }
          await yieldToPage();
          if (live && !live()) return hits;
        }
      }
      if (batch.length) onHits?.(batch);
    }
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HL = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (reg && HL && (!live || live())) reg.set('kr-search', new HL(...ranges));
    return hits;
  }
  // The indexes are made ahead, in idle moments after the book is open, so the first search is as quick as
  // the next: the whole book is gone through once, a slice at a time.
  {
    let gone = false; onDispose(() => { gone = true; });
    const prep = (deadline?: { timeRemaining(): number }) => {
      if (gone || !reader.isConnected) return;
      const until = performance.now() + (deadline ? Math.min(10, deadline.timeRemaining() - 1) : 5);
      for (const doc of docs) for (const unit of unitsOf(doc)) {
        if (chapterIndex(unit, until)) continue;
        const w = window as Idle; if (w.requestIdleCallback) w.requestIdleCallback(prep, { timeout: 4000 }); else window.setTimeout(prep, 100); return;
      }
    };
    window.setTimeout(prep, 4000);
  }

  /** Scroll to a search hit (showing its chapter first when hidden) and mark it. */
  function goToHit(hit: SearchHit): void {
    back.remember();
    const el = (hit.range.startContainer.parentElement ?? hit.range.startContainer) as HTMLElement;
    const block = (el.closest(BLOCK_SELECTOR) as HTMLElement | null) ?? el;
    revealElement(block);
    requestAnimationFrame(() => {
      const sr = scroll.getBoundingClientRect();
      const r = hit.range.getBoundingClientRect();
      const rect = r.height ? r : block.getBoundingClientRect();
      scroll.scrollTop += rect.top - sr.top - sr.height * 0.3;
      const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
      const HL = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
      if (reg && HL) reg.set('kr-search-current', new HL(hit.range));
      block.classList.add('kr-flash'); setTimeout(() => block.classList.remove('kr-flash'), 1600);
      scheduleSave();
    });
  }

  function openSearch(initial = ''): void {
    panel.open(t('searchInBook'), [{ id: 'search', label: t('search'), render: (body) => {
      const input = h('input', { type: 'search', placeholder: t('searchPlaceholder'), value: initial, 'aria-label': t('searchInBook'), style: { width: '100%' } }) as HTMLInputElement;
      const count = h('div', { style: { color: 'var(--text-dim)', fontSize: '13px', margin: '10px 0' } });
      const list = h('ul', { class: 'plain-list' });
      body.append(input, count, list);
      let timer: number | undefined; let runId = 0;
      // The hits are listed a few dozen at a time, the next batch as the list is scrolled near its end: five
      // hundred lines of shaped text at once held the page for half a second.
      const PAGE = 40; const more = h('li', { class: 'hit-more', hidden: true });
      let pending: SearchHit[] = []; let lastBook = '', n = 0;
      const row = (hit: SearchHit) => h('li', { class: 'hit' }, h('button', { type: 'button', style: { flexDirection: 'column', alignItems: 'stretch' }, onclick: () => {
        if (window.innerWidth < 900) panel.close();
        goToHit(hit);
      } },
        h('span', { class: 'meta', dir: 'auto' }, hit.label, h('b', { class: 'hit-pct' }, localDigits(hit.pct.toFixed(1)) + '%')),
        h('span', { class: 'ctx', dir: 'auto' }, (hit.before ? '…' : '') + hit.before, h('mark', null, hit.match), hit.after + (hit.after ? '…' : ''))));
      const flushRows = (max = PAGE) => {
        if (!pending.length) { more.hidden = true; return; }
        const frag = document.createDocumentFragment();
        for (const hit of pending.splice(0, max)) {
          if (docs.length > 1 && hit.bookId !== lastBook) { lastBook = hit.bookId; frag.append(h('div', { class: 'toc-book', dir: 'auto' }, docs.find((d) => d.book.id === hit.bookId)?.book.title)); }
          frag.append(row(hit));
        }
        more.before(frag); more.hidden = !pending.length;
      };
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) flushRows(); }, { root: body.closest('.panel-body, .panel') ?? body, rootMargin: '200px' });
      io.observe(more); list.append(more); onDispose(() => io.disconnect());
      const run = async () => {
        list.replaceChildren(more); clearSearchMarks(); pending = []; lastBook = ''; n = 0;
        const q = input.value.trim(); const id = ++runId;
        if (q.length < 2) { count.textContent = ''; more.hidden = true; return; }
        count.textContent = t('searching');
        const show = (hits: SearchHit[]) => {
          if (id !== runId) return;
          pending.push(...hits); n += hits.length;
          if (list.children.length - 1 < PAGE) flushRows(PAGE - (list.children.length - 1));
          else more.hidden = false;
          count.textContent = `${t('resultsCount', { n })}…`;
        };
        const hits = await searchFlow(q, show, () => id === runId);
        if (id !== runId) return;
        count.textContent = hits.length ? t('resultsCount', { n: hits.length }) : t('noResults');
      };
      input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void run(), 200); });
      if (initial) void run();
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
    // Tapping a picture in the text opens just that picture; the grid is for the toolbar button.
    const close = openGallery(allImages, (anchor) => scrollToAnchor(anchor), { startAt, lightboxOnly: startAt !== undefined });
    onDispose(close);
  }

  /* ---------- options & more ---------- */
  function openOptions(): void {
    panel.open(t('visualOptions'), [{ id: 'options', label: t('visualOptions'), render: (body) => renderOptions(body) }]);
  }

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
  /** Splits a long paragraph at sentence ends so each utterance stays short (long ones stall on Android). */
  function speechPieces(text: string): string[] {
    if (text.length <= 320) return [text];
    const parts = text.match(/[^.!?。！？؟\n]+[.!?。！？؟]*\s*/g) ?? [text];
    const out: string[] = []; let cur = '';
    for (const p of parts) { if (cur && cur.length + p.length > 320) { out.push(cur.trim()); cur = ''; } cur += p; }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  /** When the device cannot read a language: say so, and how to get a voice (or use the AI voice). */
  const noVoice = (lang: string, why: 'no-voice' | 'missing-data' | 'unavailable') => {
    stopSpeaking();
    if (why === 'missing-data') { toast(t('voiceDataMissing', { lang: languageName(lang) }), 'info', 7000); void installVoices(); return; }
    toast(why === 'unavailable' ? t('speechUnavailable') : t('noVoiceFor', { lang: languageName(lang) }), 'error', 8000);
  };
  function speak(chunks: string[], startBlock?: { doc: OpenDoc; index: number }): void {
    if (!ttsAvailable() && !(getSettings().speechEngine === 'ai' && aiTtsSupported() && aiReady()) && !(getSettings().speechEngine === 'kitten' && kittenReady())) { toast(t('speechUnavailable'), 'error', 6000); return; }
    stopSpeaking();
    speaking = true;
    keepAwake(true);
    let i = 0;
    // Where reading stops: the end of this chapter, or the end of the book.
    const scopeEnd = (() => {
      if (!startBlock || getSettings().speechScope === 'book') return Infinity;
      const u = units().find((x) => x.doc === startBlock.doc && (x.el === startBlock.doc.allBlocks[startBlock.index] || x.el.contains(startBlock.doc.allBlocks[startBlock.index])));
      if (!u) return Infinity;
      let end = startBlock.index; while (startBlock.doc.allBlocks[end + 1] && u.el.contains(startBlock.doc.allBlocks[end + 1])) end++;
      return end - startBlock.index;
    })();
    const queue: string[] = [];
    const next = () => {
      if (!speaking) return;
      if (queue.length) { say(queue.shift()!); return; }
      let text = chunks[i];
      if (text === undefined && startBlock) {
        if (i > scopeEnd) { stopSpeaking(); toast(t('chapterReadDone')); return; }
        const block = startBlock.doc.allBlocks[startBlock.index + i];
        if (!block) { stopSpeaking(); return; }
        text = plainText(block).replace(/\s+/g, ' ').trim();
        if (!/[\p{L}\p{N}]/u.test(text)) { i++; next(); return; }
        revealElement(block);
        const sr = scroll.getBoundingClientRect();
        const r = block.getBoundingClientRect();
        if (r.bottom > sr.bottom || r.top < sr.top) scroll.scrollTop += r.top - sr.top - 40;
        block.classList.add('kr-flash'); setTimeout(() => block.classList.remove('kr-flash'), 1200);
      }
      if (text === undefined) { stopSpeaking(); return; }
      i++;
      if (!text) { next(); return; }
      const pieces = speechPieces(text);
      if (pieces.length > 1) { queue.push(...pieces.slice(1)); text = pieces[0]; }
      say(text);
    };
    const say = (text: string) => {
      // A voice that makes audio of a passage (the AI's, or KittenTTS on the device for English): fetched
      // (prefetched when possible), played, the next one made meanwhile.
      const eng = getSettings().speechEngine;
      const maker = eng === 'ai' && aiTtsSupported() && aiReady() ? aiSpeak : eng === 'kitten' && kittenReady() && kittenCanRead(text) ? (tx: string) => kittenSpeak(tx) : null;
      if (maker) {
        const play = async () => {
          try {
            const blob = aiQueue.get(text) ?? await maker(text);
            aiQueue.delete(text);
            if (!speaking) return;
            const nextText = chunks[i] ?? (startBlock ? (startBlock.doc.allBlocks[startBlock.index + i]?.textContent ?? '').trim() : '');
            if (nextText && !aiQueue.has(nextText) && (eng !== 'kitten' || kittenCanRead(nextText))) maker(nextText).then((b) => aiQueue.set(nextText, b)).catch(() => undefined);
            const url = URL.createObjectURL(blob);
            aiAudio = new Audio(url);
            aiAudio.playbackRate = getSettings().speechRate;
            aiAudio.onended = () => { URL.revokeObjectURL(url); aiAudio = null; next(); };
            aiAudio.onerror = () => { URL.revokeObjectURL(url); stopSpeaking(); };
            await aiAudio.play();
          } catch (err) { toast(String((err as Error).message ?? err), 'error', 4000); stopSpeaking(); }
        };
        void play();
        return;
      }
      // The device's voice for this passage's language (each passage in its own: an Arabic book's English
      // quotation is read in English).
      const lang = speechLangOf(text, startBlock?.doc.book.language);
      void speakPassage(text, lang, getSettings().speechRate, getSettings().speechVoice || undefined, () => { if (speaking) next(); }, () => stopSpeaking())
        .then((r) => { if (r !== 'ok' && speaking) noVoice(lang, r); });
    };
    next();
  }
  function stopSpeaking(): void { speaking = false; keepAwake(getSettings().keepAwake); stopSpeech(); if (aiAudio) { aiAudio.pause(); aiAudio = null; } }
  onDispose(stopSpeaking);

  // Sleep timer: stops read-aloud and auto-scroll after N minutes.
  function sleepTimerSheet(): void {
    if (sleepTimer) { window.clearTimeout(sleepTimer); sleepTimer = 0; toast(t('sleepTimerOff')); return; }
    const sh = openSheet(t('sleepTimer'), t('close'));
    sh.body.style.fontFamily = 'var(--font-ui)';
    sh.body.append(h('div', { class: 'segmented' }, ...[15, 30, 45, 60].map((m) => h('button', { type: 'button', onclick: () => {
      sh.close();
      sleepTimer = window.setTimeout(() => { sleepTimer = 0; stopSpeaking(); if (autoScrollRaf) stopAutoScroll(); toast(t('sleepTimerDone')); }, m * 60000);
      toast(t('sleepTimerSet', { n: countMinutes(m) }));
    } }, t('minutes', { n: m })))));
  }
  onDispose(() => { if (sleepTimer) window.clearTimeout(sleepTimer); });

  function openMore(): void {
    panel.open(t('more'), [{ id: 'more', label: t('more'), render: (body) => {
      const item = (name: string, label: string, fn: () => void) => h('li', null, h('button', { type: 'button', onclick: () => { panel.close(); fn(); } }, icon(name), label));
      body.append(h('ul', { class: 'plain-list' },
        item('info', t('bookInfo'), () => showInfo()),
        item('bookmarkAdd', t('addBookmark'), () => void addBookmark()),
        item((currentLocator()?.doc.book ?? docs[0].book).tags?.includes(FAV_TAG) ? 'heartFill' : 'heart', (currentLocator()?.doc.book ?? docs[0].book).tags?.includes(FAV_TAG) ? t('unfavorite') : t('favorite'), () => void toggleFavorite(currentLocator()?.doc.book ?? docs[0].book)),
        item('images', t('images'), () => showGallery()),
        item('type', t('visualOptions'), openOptions),
        item(speaking ? 'stop' : 'speak', speaking ? t('stopReading') : t('readAloud'), () => { if (speaking) stopSpeaking(); else { const cur = currentLocator(); if (cur) speak([], { doc: cur.doc, index: cur.loc.block ?? 0 }); } }),
        item('scroll', t('autoScroll'), toggleAutoScroll),
        item('fullscreen', t('fullscreen'), () => { void toggleFullscreen(root); }),
        item('bookmark', t('bookmarks'), () => openContents('bookmarks')),
        item('download', t('exportNotes'), () => { const cur = currentLocator(); void exportNotes(cur?.doc.book ?? docs[0].book); }),
        item('download', t('exportAnki'), () => { const cur = currentLocator(); void exportNotesAnki(cur?.doc.book ?? docs[0].book); }),
        item('scroll', t('speedReading'), () => void startSpeedReading()),
        item('sort', t('readInOrder'), () => void import('../ui/queue').then((m) => m.queueSheet(getQueue().length ? getQueue() : books.map((b) => b.id), { onChange: () => void findNext() }))),
        item('external', t('shareFile'), () => { const cur = currentLocator(); void shareBooks([(cur?.doc.book ?? docs[0].book).id]); }),
        item('convert', t('convertFile'), () => { const cur = currentLocator(); void import('../ui/convert').then((m) => m.convertSheet(cur?.doc.book ?? docs[0].book)); }),
        item('clock', sleepTimer ? t('sleepTimerOff') : t('sleepTimer'), () => sleepTimerSheet()),
        item('translate', t('aiTranslate'), () => translator.toggleUi()),
        item('settings', t('toolbarButtons'), () => toolbarSheet()),
        item('highlight', t('highlights'), () => openContents('highlights')),
        docs.length > 1 ? item('books', t('jumpToBook'), () => openContents('toc')) : null,
      ));
      if (!isTouchDevice()) body.append(h('p', { class: 'shortcuts-hint' }, icon('keyboard'), ' ', t('shortcutsBody')));
    } }]);
  }

  /* ---------- keyboard ---------- */
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { if (panel.isOpen) panel.close(); else if (autoScrollRaf) stopAutoScroll(); else if (speaking) stopSpeaking(); else void leaveFullscreen(root); return; }
    if ((e.target as HTMLElement).matches('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const page = scroll.clientHeight * 0.9;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowLeft': { if (!chapterMode()) return; const rtl = docs.find((d) => !d.wrapper.hidden)?.render?.rtl ?? false; const fwd = (e.key === 'ArrowRight') !== rtl; const k = currentUnitIndex(); showUnit(fwd ? k + 1 : k - 1, !fwd); break; }
      case 'j': case 'ArrowDown': scroll.scrollBy({ top: 80 }); break;
      case 'k': case 'ArrowUp': scroll.scrollBy({ top: -80 }); break;
      case ' ': case 'PageDown': {
        e.preventDefault();
        const back = e.shiftKey;
        if (flowMode()) { const k = currentUnitIndex(); if (!back && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2 && units()[k + 1]) { showUnit(k + 1); break; } if (back && scroll.scrollTop <= 1 && units()[k - 1]) { showUnit(k - 1, true); break; } }
        scroll.scrollBy({ top: back ? -page : page, behavior: 'smooth' }); break;
      }
      case 'PageUp': { e.preventDefault(); if (flowMode() && scroll.scrollTop <= 1 && units()[currentUnitIndex() - 1]) { showUnit(currentUnitIndex() - 1, true); break; } scroll.scrollBy({ top: -page, behavior: 'smooth' }); break; }
      case 'Home': scroll.scrollTop = 0; break;
      case 'End': scroll.scrollTop = scroll.scrollHeight; break;
      case '/': e.preventDefault(); openSearch(); break;
      case '+': case '=': updateSettings({ fontSize: Math.min(40, getSettings().fontSize + 1) }); break;
      case '-': case '_': updateSettings({ fontSize: Math.max(12, getSettings().fontSize - 1) }); break;
      case '0': updateSettings({ fontSize: 19 }); break;
      case 'b': void addBookmark(); break;
      case 'g': showGallery(); break;
      case 'v': openOptions(); break;
      case 'c': openContents('toc'); break;
      case 'f': void toggleFullscreen(root); break;
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
  setUp();
}

/* ------------------------------------------------------------------ */
/* PDF reader                                                          */
/* ------------------------------------------------------------------ */

/** Toggle the favourite mark on a book (the reserved ★ tag). */
export async function toggleFavorite(book: Book): Promise<boolean> {
  const has = (book.tags ?? []).includes(FAV_TAG);
  const tags = has ? (book.tags ?? []).filter((x) => x !== FAV_TAG) : [...(book.tags ?? []), FAV_TAG];
  await db.updateBook(book.id, (b) => { if (tags.length) b.tags = tags; else delete b.tags; b.tagsAt = Date.now(); });
  if (tags.length) book.tags = tags; else delete book.tags;
  scheduleSync();
  toast(has ? t('removedFromFavorites') : t('addedToFavorites'));
  return !has;
}


function snapName(title: string): string {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
  return `${title.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40)} ${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

async function mountPdf(root: HTMLElement, book: Book, onDispose: (fn: () => void) => void): Promise<void> {
  const file = await db.getFile(book.id);
  if (!file) { toast(t(book.source ? 'linkedFileMissing' : 'openError', { title: book.title, error: '' }), 'error', 5000); navigate('/', true); return; }
  const reader = h('div', { class: 'reader' });
  applySettings(reader);
  const syncChrome = () => { if (!reader.isConnected) { requestAnimationFrame(syncChrome); return; } const cs = getComputedStyle(reader); root.style.setProperty('--chrome-bg', cs.backgroundColor); root.style.setProperty('--chrome-fg', cs.color); document.querySelector('meta[name="theme-color"]')?.setAttribute('content', cs.backgroundColor); document.body.style.background = cs.backgroundColor; };
  onDispose(() => { document.body.style.background = ''; applyChrome(); });
  const title = h('div', { class: 'title', dir: 'auto' }, book.title, h('small', null, book.author ?? ''));
  const panel = new SidePanel(root);
  const pageInput = h('input', { type: 'number', min: '1', 'aria-label': t('goToPage') }) as HTMLInputElement;
  const slider = h('input', { type: 'range', min: '1', value: '1', 'aria-label': t('page') }) as HTMLInputElement;
  const count = h('span', { class: 'pcount' });
  let viewer: PdfViewer;
  let ink: import('../ui/ink').Ink | null = null;
  let strip: import('../ui/pagestrip').PageStrip | null = null;

  // The page bar: the page's place (arrows, slider, count) and the tools (go to, zoom, fit) — two rows when
  // the screen is upright, one when it is wide, or down one side, as set.
  // "By orientation": down the side when the screen is upright, in one row when it is wide.
  const portrait = matchMedia('(orientation: portrait)');
  const barLayout = () => { const l = getSettings().pdfBar; return l === 'auto' ? (portrait.matches ? 'side' : 'row') : l; };
  const bar = h('div', { class: 'pdf-bar', dataset: { layout: barLayout() } },
    h('div', { class: 'pdf-bar-nav' },
    iconButton('chevronLeft', t('previousPage'), () => viewer.goTo(viewer.current - 1)),
    slider,
    iconButton('chevronRight', t('nextPage'), () => viewer.goTo(viewer.current + 1)),
    count),
    h('div', { class: 'pdf-bar-tools' },
    h('form', { style: { display: 'flex', gap: '6px', alignItems: 'center' }, onsubmit: (e: Event) => { e.preventDefault(); const n = Number(pageInput.value); if (n) viewer.goTo(n); pageInput.blur(); } }, pageInput, h('button', { class: 'btn small', type: 'submit' }, t('go'))),
    iconButton('zoomOut', t('zoomOut'), () => viewer.zoom(-0.15)),
    iconButton('zoomIn', t('zoomIn'), () => viewer.zoom(0.15)),
    iconButton('fullscreen', t('fitWidth'), () => viewer.fitToWidth()),
    iconButton('pen', t('inkNotes'), () => ink?.setOn(!ink.on)),
    iconButton('images', t('pageStrip'), () => strip?.toggle())),
  );
  const relayout = () => { bar.dataset.layout = barLayout(); bar.dataset.side = getSettings().pdfBarSide; bar.dataset.row = getSettings().pdfBarRow; };
  relayout();
  onDispose(onSettingsChange(relayout)); portrait.addEventListener('change', relayout); onDispose(() => portrait.removeEventListener('change', relayout));
  const topbar = h('header', { class: 'topbar' },
    iconButton('back', t('back'), () => { if (leaveToCaller(book.id)) return; void import('./book').then((m) => goBackView(m.wantsBookPage(book) ? `/book/${book.id}` : '/')); }),
    title,
    iconButton('search', t('searchInBook'), () => openSearch()),
    iconButton('toc', t('contents'), () => openContents('toc')),
    iconButton('grid', t('pagesGrid'), () => showPagesGrid()),
    iconButton('more', t('more'), () => openMore()),
  );
  const syncComfort = () => {
    const st = getComputedStyle(reader); const warm = st.getPropertyValue('--r-warmth').trim(), dim = st.getPropertyValue('--r-dim-overlay').trim();
    root.style.setProperty('--r-warmth', warm); root.style.setProperty('--r-dim-overlay', dim);
    const el = root.querySelector<HTMLElement>('.reader-comfort'); if (el) { el.hidden = !(Number(warm) > 0 || Number(dim) > 0); el.dataset.warm = Number(warm) > 0 ? '1' : '0'; }
  };
  queueMicrotask(syncComfort);
  root.append(topbar, reader, bar, h('div', { class: 'reader-comfort', 'aria-hidden': 'true' }), h('div', { class: 'center', id: 'kr-loading' }, h('div', { class: 'spinner' }), t('loading')));
  syncChrome();

  const openPdfOptions = () => panel.open(t('visualOptions'), [{ id: 'o', label: t('visualOptions'), render: (b) => renderOptions(b, { pdf: true }) }]);
  let saveTimer: number | undefined;
  viewer = new PdfViewer({
    container: reader,
    invert: getSettings().pdfInvert,
    crop: { enabled: () => getSettings().pdfAutoCrop, get: () => db.getMeta<CropBox[]>(`crop:${book.id}`).then((v) => v ?? null), set: (boxes) => db.setMeta(`crop:${book.id}`, boxes) },
    onPageRender: (n) => { renderHighlights(n); ink?.render(n); strip?.sync(); },
    onPageChange: (page, total) => {
      slider.max = String(total); slider.value = String(page); pageInput.max = String(total); pageInput.placeholder = String(page);
      count.textContent = t('pageOf', { n: page, total });
      if (page >= total && total > 1) offerNextPdf();
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { const loc: Locator = { bookId: book.id, page, offset: viewer.currentOffset(), pct: total ? page / total : 0 }; book.progress = loc; void db.updateBook(book.id, (b) => { b.progress = loc; b.progressAt = Date.now(); }); scheduleSync(); }, 600);
    },
  });
  slider.addEventListener('input', () => viewer.goTo(Number(slider.value)));
  let nextVolPdf: Book | null = null; let nextPillPdf: HTMLElement | null = null; let queuedPdf = false;
  const findNextPdf = () => nextQueued(book.id).then(async (q) => { if (q) { nextVolPdf = q; queuedPdf = true; return; } queuedPdf = false; nextVolPdf = nextVolume(book, await db.allBooks()); }).catch(() => undefined);
  void findNextPdf();
  const offerNextPdf = () => { if (!nextVolPdf || nextPillPdf) return; const next = nextVolPdf; nextPillPdf = h('button', { type: 'button', class: 'jump-back next-volume', onclick: () => navigate(`/read/${next.id}`) }, h('span', { dir: 'auto' }, `${queuedPdf ? t('nextInOrder') : t('nextVolume')}: ${next.title}`), icon('arrowRight')); root.appendChild(nextPillPdf); };
  onDispose(overscrollNext(viewer.scroll, () => (queuedPdf && nextVolPdf ? nextVolPdf.id : null)));
  const back = jumpBack(root, (loc) => { const l = loc as { page: number; offset: number }; viewer.goTo(l.page, l.offset); }, () => ({ page: viewer.current, offset: viewer.currentOffset() }), viewer.scroll);
  onDispose(back.dispose);
  viewer.pinchZoom = getSettings().pdfPinchZoom;
  (window as unknown as { __krPdfViewer?: unknown }).__krPdfViewer = viewer; // (for tests)
  viewer.root.dataset.pagenums = String(getSettings().pdfPageNumbers);
  onDispose(onSettingsChange((st) => { viewer.pinchZoom = st.pdfPinchZoom; viewer.root.dataset.pagenums = String(st.pdfPageNumbers); viewer.setCrop(st.pdfAutoCrop); }));
  await viewer.load(file, book.id, book.source?.uri);
  root.querySelector('#kr-loading')?.remove();
  void touchBook(book.id);
  const jump = takeJump();
  if (jump?.kind === 'bm') { const bm = book.bookmarks.find((x) => x.id === jump.id); if (bm) viewer.goTo(bm.locator.page ?? 1, bm.locator.offset ?? 0); }
  else if (jump?.kind === 'pin') { const pin = (book.pins ?? []).find((x) => x.id === jump.id); if (pin) viewer.goTo(pin.page, Math.max(0, pin.y - 0.1)); }
  else if (jump?.kind === 'hl') { const hl = (book.pdfHighlights ?? []).find((x) => x.id === jump.id); if (hl) viewer.goTo(hl.page, Math.max(0, (hl.rects[0]?.[1] ?? 0) - 0.1)); }
  else if (book.progress?.page) viewer.goTo(book.progress.page, book.progress.offset ?? 0);
  // Opened from a search across books: at the found page, the words marked.
  { const sj = takeSearchJump(book.id); if (sj) void viewer.highlightOnPage(sj.unit + 1, sj.q); }
  onDispose(() => viewer.destroy());
  // The pages' text, read once and kept (from an earlier reading, or now, in idle moments), for quick searching.
  setTimeout(() => void storedPages(book).then((stored) => { if (stored) viewer.seedTexts(stored); else void viewer.readAllWhenIdle((all) => void storePages(book, all)); }), 3000);
  onDispose(onSettingsChange((s) => { applySettings(reader, s); syncChrome(); syncComfort(); viewer.setInvert(s.pdfInvert); }));
  onDispose(attachSelectionToolbar(reader, {
    search: (text) => openSearch(text),
    highlight: (range, text, color) => addPdfHighlight(range, text, color),
    note: (range, text) => addPdfNote(range, text),
    speak: (text) => {
      stopSpeech();
      const lang = speechLangOf(text, book.language);
      if (getSettings().speechEngine === 'kitten' && kittenReady() && kittenCanRead(text)) { void kittenSpeak(text.replace(/\s+/g, ' ').trim()).then((b) => { const a = new Audio(URL.createObjectURL(b)); a.playbackRate = getSettings().speechRate; a.onended = () => URL.revokeObjectURL(a.src); return a.play(); }).catch((e) => toast(String((e as Error).message ?? e), 'error', 5000)); return; }
      void speakPassage(text.replace(/\s+/g, ' ').trim(), lang, getSettings().speechRate, getSettings().speechVoice || undefined, () => undefined, () => undefined).then((r) => {
        if (r === 'missing-data') { toast(t('voiceDataMissing', { lang: languageName(lang) }), 'info', 7000); void installVoices(); }
        else if (r !== 'ok') toast(r === 'unavailable' ? t('speechUnavailable') : t('noVoiceFor', { lang: languageName(lang) }), 'error', 8000);
      });
    },
    textImage: async (text) => { try { const opts = { text, title: book.title, author: book.author, appName: getSettings().snapWatermark ? t('appName') : '' }; showSnapshot(await renderTextCanvas(opts), snapName(book.title), book.title, (style) => renderTextCanvas({ ...opts, style })); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } },
  }));
  void applyOrientation();
  if (getSettings().hideSystemBars) void setImmersive(true);
  keepAwake(getSettings().keepAwake);
  onDispose(() => { void setImmersive(false); keepAwake(false); });
  onDispose(attachEdgeBrightness(viewer.scroll));
  viewer.scroll.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); viewer.zoom(e.deltaY < 0 ? 0.1 : -0.1); }, { passive: false });
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
  const flushPdf = () => { void tracker.save(); const loc: Locator = { bookId: book.id, page: viewer.current, offset: viewer.currentOffset(), pct: viewer.total ? viewer.current / viewer.total : 0 }; book.progress = loc; void db.updateBook(book.id, (b) => { b.progress = loc; b.progressAt = Date.now(); }); };
  const onHidePdf = () => { if (document.visibilityState === 'hidden') flushPdf(); };
  window.addEventListener('pagehide', flushPdf); document.addEventListener('visibilitychange', onHidePdf);
  onDispose(() => { window.removeEventListener('pagehide', flushPdf); document.removeEventListener('visibilitychange', onHidePdf); });

  /** Export several pages as PNGs (zipped when more than one), chosen by range or list. */
  function savePagesSheet(): void {
    const sheet = openSheet(t('savePagesRange'), t('close'));
    sheet.body.style.fontFamily = 'var(--font-ui)';
    const input = h('input', { type: 'text', dir: 'ltr', placeholder: `1-5, 8, 12-${viewer.total}`, value: String(viewer.current), style: { width: '100%' } }) as HTMLInputElement;
    const parse = (): number[] => { const out = new Set<number>(); for (const part of input.value.split(/[,\s]+/).filter(Boolean)) { const m = /^(\d+)(?:-(\d+))?$/.exec(part.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))); if (!m) continue; const a = Math.max(1, Math.min(viewer.total, +m[1])), b = m[2] ? Math.max(1, Math.min(viewer.total, +m[2])) : a; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i); } return [...out].sort((x, y) => x - y); };
    const count = h('p', { class: 'src' });
    const refresh = () => { const n = parse().length; count.textContent = t('pagesSelected', { n }); go.disabled = !n; };
    input.addEventListener('input', refresh);
    const quick = (label: string, v: string) => h('button', { type: 'button', class: 'chip small', onclick: () => { input.value = v; refresh(); } }, h('span', null, label));
    const c = viewer.current;
    sheet.body.append(
      h('p', { class: 'src' }, t('savePagesBody')),
      h('div', { class: 'chip-row wrap', style: { marginBottom: '10px' } },
        quick(t('thisPage'), String(c)), quick(`${c}–${Math.min(viewer.total, c + 4)}`, `${c}-${Math.min(viewer.total, c + 4)}`), quick(`${c}–${Math.min(viewer.total, c + 9)}`, `${c}-${Math.min(viewer.total, c + 9)}`), quick(t('allPages'), `1-${viewer.total}`)),
      input, count);
    const bar = h('div', { class: 'progress-bar', hidden: true }, h('span'));
    sheet.body.append(bar);
    const go = h('button', { class: 'btn small primary', type: 'button', onclick: async () => {
      const pages = parse(); if (!pages.length) return;
      go.disabled = true; bar.hidden = false;
      try {
        const base = book.title.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40);
        if (pages.length === 1) { const blob = await viewer.pageToBlob(pages[0]); await saveImage(blob, `${base} - p${pages[0]}.png`); }
        else {
          const JSZip = (await import('jszip')).default; const zip = new JSZip();
          for (let i = 0; i < pages.length; i++) { zip.file(`${base} - p${String(pages[i]).padStart(String(viewer.total).length, '0')}.png`, await viewer.pageToBlob(pages[i])); (bar.firstElementChild as HTMLElement).style.width = `${Math.round(((i + 1) / pages.length) * 100)}%`; }
          const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
          await shareFile(blob, `${base} - ${t('pagesFile', { n: pages.length })}.zip`, book.title);
        }
        sheet.close();
      } catch (err) { toast(String((err as Error).message ?? err), 'error'); go.disabled = false; }
    } }, icon('download'), t('savePagesRange')) as HTMLButtonElement;
    sheet.actions.append(go);
    refresh();
  }

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
    }, { root: overlay.querySelector('.gallery-body'), rootMargin: '200px 0px' });
    for (let n = 1; n <= viewer.total; n++) {
      // (The picture's place is a blank page until it is drawn — never a broken-picture mark.)
      const cell = h('button', { type: 'button', class: 'page-cell' + (n === viewer.current ? ' current' : ''), dataset: { page: String(n) }, onclick: () => { back.remember(); viewer.goTo(n); close(); } }, h('img', { alt: '' }), h('span', null, String(n)));
      grid.append(cell); io.observe(cell);
    }
    window.addEventListener('keydown', onKey);
    document.body.append(overlay);
    setTimeout(() => overlay.querySelector('.page-cell.current')?.scrollIntoView({ block: 'center' }), 50);
  }

  function showInfo(): void {
    showBookInfo({ book, stats: tracker.current, speed: tracker.speed(), pages: viewer.total, currentPage: viewer.current, pct: viewer.current / viewer.total });
  }
  reader.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('.textLayer span, a, button, input')) return; if (document.getSelection()?.isCollapsed === false) return; const on = root.classList.toggle('immersive'); if (nativePlatform() === 'android' || nativePlatform() === 'ios') void setImmersive(on || getSettings().hideSystemBars); });

  let outline: TocItem[] | null = null;
  function openContents(tab: 'toc' | 'bookmarks' | 'notes') {
    panel.open(t('contents'), [
      { id: 'toc', label: t('contents'), render: async (body) => {
        outline ??= await viewer.outline();
        if (!outline.length) { body.append(h('p', { class: 'center' }, t('noContents'))); return; }
        body.append(h('ul', { class: 'toc-list' }, ...outline.map((it) => h('li', { class: `depth-${Math.min(3, it.depth)}` }, h('button', { type: 'button', dir: 'auto', class: it.page === viewer.current ? 'current' : '', onclick: () => { if (it.page) { back.remember(); viewer.goTo(it.page); } panel.close(); } }, h('span', { style: { flex: '1' } }, it.label), it.page ? h('span', { class: 'meta' }, String(it.page)) : null)))));
      } },
      { id: 'bookmarks', label: t('bookmarks'), render: (body) => {
        const list = [...(book.bookmarks ?? [])].sort((a, b) => b.createdAt - a.createdAt);
        if (!list.length) { body.append(h('p', { class: 'center' }, t('noBookmarks'))); return; }
        body.append(h('ul', { class: 'plain-list' }, ...list.map((bm) => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { back.remember(); viewer.goTo(bm.locator.page ?? 1, bm.locator.offset ?? 0); panel.close(); } }, h('span', null, bm.label), bm.excerpt ? h('span', { class: 'meta', dir: 'auto' }, bm.excerpt) : null),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(bm.id); book.bookmarks = book.bookmarks.filter((x) => x.id !== bm.id); await db.updateBook(book.id, (b) => { b.bookmarks = book.bookmarks; }); panel.refresh(); } }, icon('trash'))))));
      } },
      { id: 'notes', label: t('notes'), render: (body) => {
        const pins = [...(book.pins ?? [])].sort((a, b) => a.createdAt - b.createdAt);
        const noted = [...(book.pdfHighlights ?? [])].filter((x) => x.note).sort((a, b) => a.createdAt - b.createdAt);
        if (!pins.length && !noted.length) { body.append(h('p', { class: 'center' }, t('noPdfNotes'))); return; }
        const list = h('ul', { class: 'plain-list' });
        pins.forEach((pin, i) => list.append(h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => { back.remember(); viewer.goTo(pin.page, Math.max(0, pin.y - 0.1)); panel.close(); } },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(i + 1)), h('span', { class: 'meta' }, t('pageOf', { n: pin.page, total: viewer.total }))),
            h('span', { dir: 'auto' }, pin.note)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(pin.id); book.pins = (book.pins ?? []).filter((x) => x.id !== pin.id); await db.updateBook(book.id, (b) => { b.pins = book.pins; }); renderPins(); panel.refresh(); } }, icon('trash')))));
        noted.forEach((hl, i) => list.append(h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => { back.remember(); viewer.goTo(hl.page, Math.max(0, (hl.rects[0]?.[1] ?? 0) - 0.1)); panel.close(); } },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(i + 1)), h('span', { class: 'meta' }, t('pageOf', { n: hl.page, total: viewer.total }))),
            h('span', { class: 'meta', dir: 'auto' }, hl.text.length > 120 ? hl.text.slice(0, 120) + '…' : hl.text),
            h('span', { dir: 'auto' }, hl.note!)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { await db.updateBook(book.id, (b) => { const x = (b.pdfHighlights ?? []).find((y) => y.id === hl.id); if (x) x.note = undefined; }); const local = (book.pdfHighlights ?? []).find((y) => y.id === hl.id); if (local) local.note = undefined; renderHighlights(hl.page); panel.refresh(); } }, icon('trash')))));
        body.append(list);
      } },
    ], tab);
  }

  /* ---------- PDF text highlights ---------- */
  type PageRects = { page: number; rects: [number, number, number, number][] };

  /** Client rectangles of a selection, mapped onto the page(s) they sit on, merged into one box per line. */
  function selectionRects(range: Range): PageRects[] {
    const groups = new Map<number, [number, number, number, number][]>();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    // Pages are found by geometry (works for parts of the selection scrolled out of view).
    // (Fractions are of the whole page — its sheet — even when the margins are cropped away.)
    const pages = Array.from(viewer.root.querySelectorAll<HTMLElement>('.pdf-page')).map((el) => ({ el, win: el.getBoundingClientRect(), box: (PdfViewer.sheetOf(el) ?? el).getBoundingClientRect() }));
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 2 || r.height < 2) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const pg = pages.find(({ win }) => cx >= win.left && cx <= win.right && cy >= win.top && cy <= win.bottom);
      if (!pg || !pg.box.width || !pg.box.height) continue;
      const box = pg.box;
      const x = clamp((r.left - box.left) / box.width), y = clamp((r.top - box.top) / box.height);
      if (x >= 1 || y >= 1) continue;
      const rects = groups.get(Number(pg.el.dataset.page)) ?? [];
      rects.push([x, y, Math.min(clamp(r.width / box.width), 1 - x), Math.min(clamp(r.height / box.height), 1 - y)]);
      groups.set(Number(pg.el.dataset.page), rects);
    }
    return [...groups].map(([page, rects]) => ({ page, rects: mergeLineRects(rects) }));
  }
  /** pdf.js gives one rectangle per text run; overlapping ones would darken where they meet. Join runs on the same line. */
  function mergeLineRects(rects: [number, number, number, number][]): [number, number, number, number][] {
    const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const out: [number, number, number, number][] = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last) {
        const lMid = last[1] + last[3] / 2, rMid = r[1] + r[3] / 2;
        const sameLine = Math.abs(lMid - rMid) < Math.min(last[3], r[3]) * 0.5;
        const gap = r[0] - (last[0] + last[2]);
        if (sameLine && gap < Math.max(last[3], r[3]) * 1.5) {
          const x0 = Math.min(last[0], r[0]), y0 = Math.min(last[1], r[1]);
          const x1 = Math.max(last[0] + last[2], r[0] + r[2]), y1 = Math.max(last[1] + last[3], r[1] + r[3]);
          out[out.length - 1] = [x0, y0, x1 - x0, y1 - y0];
          continue;
        }
      }
      out.push(r);
    }
    return out.map(([x, y, w, h2]) => [Number(x.toFixed(4)), Number(y.toFixed(4)), Number(w.toFixed(4)), Number(h2.toFixed(4))]);
  }

  async function persistHighlights(): Promise<void> {
    await db.updateBook(book.id, (b) => { b.pdfHighlights = book.pdfHighlights; });
  }

  function createHighlights(groups: PageRects[], text: string, color: HighlightColor, note?: string): void {
    const at = Date.now();
    const added: PdfHighlight[] = groups.map((g, i) => ({ id: uid(), page: g.page, rects: g.rects, text, color, note: i === 0 ? note : undefined, noteAt: note && i === 0 ? at : undefined, createdAt: at + i }));
    book.pdfHighlights = [...(book.pdfHighlights ?? []), ...added];
    void persistHighlights(); scheduleSync();
    updateSettings({ highlightColor: color });
    renderHighlights();
  }

  function addPdfHighlight(range: Range, text: string, color: HighlightColor): void {
    const groups = selectionRects(range);
    if (!groups.length) { toast(t('fmtPdf')); return; }
    createHighlights(groups, text, color);
    toast(t('highlight'));
  }

  function addPdfNote(range: Range, text: string): void {
    const groups = selectionRects(range);
    if (!groups.length) { toast(t('fmtPdf')); return; }
    const sheet = openSheet(t('addNote'), t('close'));
    sheet.body.style.fontFamily = 'var(--font-ui)';
    const ta = h('textarea', { placeholder: t('notePlaceholder'), rows: '4', style: { width: '100%' }, dir: 'auto' }) as HTMLTextAreaElement;
    sheet.body.append(h('p', { class: 'src', dir: 'auto' }, text.length > 160 ? text.slice(0, 160) + '…' : text), ta);
    sheet.actions.append(h('button', { class: 'btn primary small', onclick: () => { createHighlights(groups, text, getSettings().highlightColor, ta.value.trim() || undefined); sheet.close(); toast(t('noteSaved')); } }, icon('check'), t('done')));
    setTimeout(() => ta.focus(), 100);
  }

  function renderHighlights(page?: number): void {
    const pages = page ? [page] : [...new Set((book.pdfHighlights ?? []).map((x) => x.page))];
    for (const n of pages) {
      const el = viewer.pageElement(n);
      if (!el) continue;
      el.querySelector('.pdf-hl-layer')?.remove();
      const list = (book.pdfHighlights ?? []).filter((x) => x.page === n);
      if (!list.length) continue;
      el.append(h('div', { class: 'pdf-hl-layer' }, ...list.flatMap((hl) => hl.rects.map(([x, y, w, hgt]) =>
        h('div', { class: 'pdf-hl', dataset: { color: hl.color }, title: hl.note ?? '', style: { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${hgt * 100}%` } })))));
    }
  }

  function pdfHighlightSheet(hl: PdfHighlight): void {
    const sheet = openSheet(t('highlight'), t('close'));
    sheet.body.style.fontFamily = 'var(--font-ui)';
    const ta = h('textarea', { placeholder: t('notePlaceholder'), rows: '3', style: { width: '100%' }, dir: 'auto' }) as HTMLTextAreaElement;
    ta.value = hl.note ?? '';
    const colors = h('div', { class: 'sel-colors', style: { justifyContent: 'flex-start', border: '0', padding: '0 0 10px' } }, ...HIGHLIGHT_COLORS.map(([cid, hex]) => h('button', { type: 'button', class: 'dot', style: { background: hex, width: '44px', height: '22px', borderRadius: '999px', outline: hl.color === cid ? '3px solid var(--md-primary)' : 'none' }, onclick: async () => { hl.color = cid; await persistHighlights(); renderHighlights(hl.page); sheet.close(); } })));
    sheet.body.append(h('p', { class: 'src', dir: 'auto' }, hl.text.length > 200 ? hl.text.slice(0, 200) + '…' : hl.text), colors, ta);
    sheet.actions.append(
      h('button', { class: 'btn danger small', onclick: async () => { void markDeleted(hl.id); book.pdfHighlights = (book.pdfHighlights ?? []).filter((x) => x.id !== hl.id); await persistHighlights(); renderHighlights(hl.page); panel.refresh(); sheet.close(); } }, icon('trash'), t('removeHighlight')),
      h('button', { class: 'btn primary small', onclick: async () => { hl.note = ta.value.trim() || undefined; hl.noteAt = Date.now(); await persistHighlights(); renderHighlights(hl.page); panel.refresh(); sheet.close(); toast(t('noteSaved')); } }, icon('check'), t('done')));
    setTimeout(() => ta.focus(), 100);
  }

  /* ---------- PDF notes: long-press (touch) or right-click (desktop) on a page ---------- */
  function renderPins(): void {
    viewer.root.querySelectorAll('.pdf-pin').forEach((p) => p.remove());
    const list = [...(book.pins ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    viewer.root.dataset.pinStyle = getSettings().pdfNoteStyle;
    list.forEach((pin, i) => {
      const el = viewer.pageElement(pin.page); if (!el) return;
      el.appendChild(h('button', { type: 'button', class: 'pdf-pin', dataset: { color: pin.color }, title: pin.note, 'aria-label': pin.note, style: { left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }, onclick: (e: Event) => { e.stopPropagation(); pinSheet(pin); } },
        getSettings().pdfNoteStyle === 'pin' ? icon('note') : getSettings().pdfNoteStyle === 'dot' ? '' : localDigits(i + 1)));
    });
  }
  function pinSheet(pin: PdfNote | { page: number; x: number; y: number }): void {
    const existing = 'id' in pin ? pin : null;
    const sheet = openSheet(existing ? t('editNote') : t('addNote'), t('close'));
    sheet.body.style.fontFamily = 'var(--font-ui)';
    const ta = h('textarea', { placeholder: t('notePlaceholder'), rows: '4', style: { width: '100%' }, dir: 'auto' }) as HTMLTextAreaElement;
    ta.value = existing?.note ?? '';
    let color: Highlight['color'] = existing?.color ?? getSettings().highlightColor;
    const colors = h('div', { class: 'sel-colors', style: { justifyContent: 'flex-start', border: '0', padding: '0 0 10px' } }, ...HIGHLIGHT_COLORS.map(([cid, hex]) => h('button', { type: 'button', class: 'dot', style: { background: hex, width: '44px', height: '22px', borderRadius: '999px', outline: color === cid ? '3px solid var(--md-primary)' : 'none' }, onclick: (e: Event) => { color = cid; colors.querySelectorAll('button').forEach((b) => (b.style.outline = 'none')); (e.currentTarget as HTMLElement).style.outline = '3px solid var(--md-primary)'; } })));
    sheet.body.append(h('p', { class: 'src' }, t('pageOf', { n: pin.page, total: viewer.total })), colors, ta);
    if (existing) sheet.actions.append(h('button', { class: 'btn danger small', onclick: async () => { void markDeleted(existing.id); book.pins = (book.pins ?? []).filter((x) => x.id !== existing.id); await db.updateBook(book.id, (b) => { b.pins = book.pins; }); renderPins(); sheet.close(); } }, icon('trash'), t('delete')));
    sheet.actions.append(h('button', { class: 'btn primary small', onclick: async () => {
      const note = ta.value.trim(); if (!note) { ta.focus(); return; }
      if (existing) { existing.note = note; existing.color = color; }
      else book.pins = [...(book.pins ?? []), { id: uid(), page: pin.page, x: pin.x, y: pin.y, note, color, createdAt: Date.now() }];
      await db.updateBook(book.id, (b) => { b.pins = book.pins; }); scheduleSync();
      renderPins(); sheet.close(); toast(t('noteSaved'));
    } }, icon('check'), t('done')));
    setTimeout(() => ta.focus(), 80);
  }
  const pointOnPage = (clientX: number, clientY: number) => {
    const el = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest('.pdf-page') as HTMLElement | null;
    if (!el) return null;
    const r = (PdfViewer.sheetOf(el) ?? el).getBoundingClientRect();
    return { page: Number(el.dataset.page), x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  };
  // A note on a spot of the page: right-click with a mouse, or «Note on this page» in the menu, then a tap where
  // it goes. (Holding a finger on the page no longer opens one: that is how a selection starts.)
  let lastPointer = 'mouse';
  viewer.scroll.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, { passive: true });
  viewer.scroll.addEventListener('contextmenu', (e) => { if (lastPointer !== 'mouse' || document.getSelection()?.isCollapsed === false) return; const p = pointOnPage(e.clientX, e.clientY); if (p) { e.preventDefault(); pinSheet(p); } });
  let placingNote = false;
  const placeNote = () => { placingNote = true; viewer.root.classList.add('placing-note'); toast(t('tapWhereNote'), 'info', 4000); };
  viewer.scroll.addEventListener('click', (e) => {
    if (document.getSelection()?.isCollapsed === false) return;
    if ((e.target as HTMLElement).closest('.pdf-pin')) return;
    const p = pointOnPage(e.clientX, e.clientY);
    if (!p) return;
    if (placingNote) { placingNote = false; viewer.root.classList.remove('placing-note'); e.preventDefault(); e.stopPropagation(); pinSheet(p); return; }
    const hl = (book.pdfHighlights ?? []).find((x) => x.page === p.page && x.rects.some(([rx, ry, rw, rh]) => p.x >= rx && p.x <= rx + rw && p.y >= ry && p.y <= ry + rh));
    if (!hl) return;
    e.preventDefault(); e.stopPropagation(); pdfHighlightSheet(hl);
  });
  renderPins();
  onDispose(onSettingsChange(() => renderPins()));

  // Ink: strokes kept with the book, drawn over the pages, and put into the file when exported.
  const { inkLayer } = await import('../ui/ink');
  let inkTimer = 0;
  ink = inkLayer({
    viewer,
    strokes: () => book.ink ?? [],
    save: (list: InkStroke[], removed?: string[]) => {
      book.ink = list; removed?.forEach((id) => void markDeleted(id));
      window.clearTimeout(inkTimer); inkTimer = window.setTimeout(() => { void db.updateBook(book.id, (b) => { b.ink = list; }); scheduleSync(); }, 400);
    },
  });
  reader.append(ink.toolbar); ink.render();
  { const i = ink; onDispose(() => i.dispose()); }
  const { pageStrip } = await import('../ui/pagestrip');
  strip = pageStrip(viewer, reader);
  { const st = strip; onDispose(() => st.dispose()); }
  async function bytesWithInk(): Promise<Uint8Array> {
    const bytes = new Uint8Array(await file!.arrayBuffer());
    if (!(book.ink ?? []).length) return bytes;
    const { flattenInk } = await import('../pdftools');
    return flattenInk(bytes, book.ink!);
  }
  const pdfName = () => (book.fileName?.replace(/\.pdf$/i, '') || book.title).slice(0, 60);
  async function exportWithInk(): Promise<void> {
    try { const b = new Blob([await bytesWithInk() as BlobPart], { type: 'application/pdf' }); await shareFile(b, `${pdfName()} — ${t('inkNotes')}.pdf`, book.title); } catch (e) { toast(String((e as Error).message ?? e), 'error'); }
  }
  async function printBook(): Promise<void> {
    try { const { printPdf } = await import('../ui/share'); await printPdf(new Blob([await bytesWithInk() as BlobPart], { type: 'application/pdf' }), `${pdfName()}.pdf`); } catch (e) { toast(String((e as Error).message ?? e), 'error'); }
  }
  async function openWithApp(): Promise<void> {
    try { const { openWith } = await import('../ui/share'); await openWith(new Blob([await bytesWithInk() as BlobPart], { type: 'application/pdf' }), `${pdfName()}.pdf`, 'application/pdf'); } catch (e) { toast(String((e as Error).message ?? e), 'error'); }
  }

  async function addBookmark() {
    const page = viewer.current;
    const excerpt = (await viewer.pageText(page)).trim().replace(/\s+/g, ' ').slice(0, 120);
    const bm: Bookmark = { id: uid(), label: t('pageOf', { n: page, total: viewer.total }), excerpt, locator: { bookId: book.id, page, offset: viewer.currentOffset(), pct: page / viewer.total }, createdAt: Date.now() };
    book.bookmarks = [...(book.bookmarks ?? []), bm]; scheduleSync();
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
        // Pages read before (here, or by the search across books) are not read again.
        if (!viewer.allTexts()) { const stored = await storedPages(book); if (stored) viewer.seedTexts(stored); }
        if (token.cancelled) return;
        const show = (found: PdfSearchHit[]) => {
          if (token.cancelled) return;
          for (const hit of found) {
            list.append(h('li', { class: 'hit' }, h('button', { type: 'button', style: { flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { void viewer.highlightOnPage(hit.page, q); if (window.innerWidth < 900) panel.close(); } },
              h('span', { class: 'meta' }, t('pageOf', { n: hit.page, total: viewer.total })), h('span', { class: 'ctx', dir: 'auto' }, hit.before, h('mark', null, hit.term), hit.after))));
          }
        };
        const hits = await viewer.search(q, (done, total) => { if (!token.cancelled) status.textContent = t('pdfSearching', { n: done, total }); }, token, show);
        if (token.cancelled) return;
        status.textContent = hits.length ? t('resultsCount', { n: hits.length }) : t('noResults');
        const all = viewer.allTexts(); if (all) void storePages(book, all);
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
        item('download', t('exportAnki'), () => void exportNotesAnki(book)),
        item('external', t('shareFile'), () => void shareBooks([book.id])),
        item('convert', t('convertFile'), () => void import('../ui/convert').then((m) => m.convertSheet(book))),
        item('grid', t('pagesGrid'), showPagesGrid),
        item('camera', t('savePageImage'), () => void savePage(false)),
        item('external', t('sharePage'), () => void savePage(true)),
        item('copy', t('copyPageImage'), () => void savePage('copy')),
        item('images', t('savePagesRange'), () => savePagesSheet()),
        item('pen', t('inkNotes'), () => ink?.setOn(true)),
        item('images', t('pageStrip'), () => strip?.toggle()),
        ...((book.ink ?? []).length ? [item('download', t('exportWithInk'), () => void exportWithInk())] : []),
        item('file', t('print'), () => void printBook()),
        ...(nativePlatform() === 'android' ? [item('external', t('openWithApp'), () => void openWithApp())] : []),
        item('file', t('toolExtract'), () => void import('../ui/pdftools').then((m) => m.extractFromBook(book))),
        item('grid', t('pdfTools'), () => void import('../ui/pdftools').then(async (m) => m.pdfToolsSheet(await db.allBooks(), book))),
        item('bookmarkAdd', t('addBookmark'), () => void addBookmark()),
        item('note', t('noteOnPage'), placeNote),
        item('fullscreen', getSettings().pdfAutoCrop ? t('cropMarginsOff') : t('cropMargins'), () => updateSettings({ pdfAutoCrop: !getSettings().pdfAutoCrop })),
        item('sort', t('readInOrder'), () => void import('../ui/queue').then((m) => m.queueSheet(getQueue().length ? getQueue() : [book.id], { onChange: () => void findNextPdf() }))),
        item(book.tags?.includes(FAV_TAG) ? 'heartFill' : 'heart', book.tags?.includes(FAV_TAG) ? t('unfavorite') : t('favorite'), () => void toggleFavorite(book)),
        item('type', t('visualOptions'), openPdfOptions),
        item('fullscreen', t('fullscreen'), () => { void toggleFullscreen(root); }),
        item('bookmark', t('bookmarks'), () => openContents('bookmarks')),
        item('target', t('goToPage'), () => pageInput.focus()),
      ));
    } }]);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { if (panel.isOpen) panel.close(); else void leaveFullscreen(root); return; }
    if ((e.target as HTMLElement).matches('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowRight': case 'n': case 'PageDown': viewer.goTo(viewer.current + 1); break;
      case 'ArrowLeft': case 'p': case 'PageUp': viewer.goTo(viewer.current - 1); break;
      case 'Home': viewer.goTo(1); break;
      case 'End': viewer.goTo(viewer.total); break;
      case '/': e.preventDefault(); openSearch(); break;
      case '+': case '=': viewer.zoom(0.15); break;
      case '-': case '_': viewer.zoom(-0.15); break;
      case '0': viewer.fitToWidth(); break;
      case 'b': void addBookmark(); break;
      case 'c': openContents('toc'); break;
      case 'v': openPdfOptions(); break;
      case 'g': pageInput.focus(); break;
      case 'f': void toggleFullscreen(root); break;
      default: return;
    }
  };
  window.addEventListener('keydown', onKey);
  onDispose(() => window.removeEventListener('keydown', onKey));
}
