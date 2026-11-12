// The reading surface. Flow documents (EPUB, DOCX, TXT, …) are rendered one
// after another into a single scroll — that is what "read together" means —
// while PDFs get the page-based viewer.
import { markReading } from '../resume';
import { diagOpen, diagLeaveIntent, diagEvent, diagBackHeld } from '../diag';
import { onBack } from '../ui/backstack';
import { readingKeys, refreshReadingKeys } from '../readkeys';
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
import { t, getLang, localDigits, countMinutes, formatPercent } from '../i18n';
import { db, uid, stampAfter, type PdfNote, type PdfHighlight, type InkStroke, type Book, type Locator, type Bookmark, type Highlight, FAV_TAG } from '../db';
import { flowHandlerFor } from '../formats';
import type { FlowRender, ImageRef, TocItem } from '../formats/types';
import { normalizeForSearch, searchFormOf } from '../formats/types';
import { BLOCK_SELECTOR, setLazyRoot } from '../formats/shared';
import { PdfViewer, type PdfSearchHit } from '../formats/pdf';
import { applySettings, applyChrome, getSettings, onSettingsChange, updateSettings, setActiveBook } from '../settings';
import { SidePanel } from '../ui/panel';
import { renderOptions } from '../ui/options';
import { createReadBar } from '../ui/readbar';
import { attachSelectionToolbar, wrapRange, findTextRange, textPlace, HIGHLIGHT_COLORS, plainText } from '../ui/selection';
import { openGallery } from './gallery';
const DOCK_KEY = 'kr.reader.dock';
import { touchBook, coverUrl, shareBooks } from '../library';
import { navigate, back as goBackView } from '../router';
import { ReadingTracker, countWords, countWordsAndChars } from '../stats';
import { showBookInfo } from '../ui/bookinfo';
import { renderTextCanvas, showSnapshot, pictureNear, pictureOnByDefault } from '../ui/textcard';
import { exportNotes, exportNotesAnki } from '../ui/exportnotes';
import { attachEdgeBrightness, attachPinchText } from '../ui/brightness';
import { attachTranslator } from '../ui/translator';
import { aiSpeak, aiTtsSupported, aiReady } from '../ai';
import { kittenReady, kittenSpeak, kittenCanRead } from '../kittentts';
import { takeJump as takeSearchJump, storedPages, storePages, partialPages, storePartialPages } from '../booksearch';
import { speakPassage, stopSpeech, speechLangOf, ttsAvailable, languageName, installVoices, queueSpeech, speakQueue } from '../tts';
import { attachFurigana, isJapanese } from '../furigana';
import { textRules, applyTextRules } from '../textrules';
import { attachPinyin } from '../readings';
import { scheduleSync, markDeleted } from '../sync';
import { mountBars, moreList, type ActionRun } from '../ui/buttonbars';
import { buttonSheet } from '../ui/buttonsheet';
import { shareFile, saveImage, copyImage } from '../ui/share';
import { applyOrientation } from '../settings';
import { setImmersive, keepAwake, toggleFullscreen, leaveFullscreen, nativePlatform } from '../native';
import { onPhone, fits } from '../platform';
import type { HighlightColor } from '../ui/selection';
import { openSheet, askText } from '../ui/dom';

/** Whether the search keeps the last search (opened again, it shows it); asked by a switch in the search itself. */
const searchKeep = (): boolean => { try { return localStorage.getItem('kr.searchKeep') !== '0'; } catch { return true; } };
function keepToggle(onOff: () => void): HTMLElement {
  const box = h('input', { type: 'checkbox', checked: searchKeep(), onchange: (e: Event) => { const v = (e.target as HTMLInputElement).checked; try { localStorage.setItem('kr.searchKeep', v ? '1' : '0'); } catch { /* none */ } if (!v) onOff(); } }) as HTMLInputElement;
  return h('label', { class: 'search-keep' }, box, h('span', null, t('searchKeepLast')));
}

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
/** A hit of the search across languages: the paragraph, its original and its translation, and where the words
 *  were found in either. */
interface PairHit { bookId: string; label: string; pct: number; block: HTMLElement; orig: string; tr?: string; inOrig: [number, number] | null; inTr: [number, number] | null }

export function readerView(ids: string[]): HTMLElement {
  const root = h('div', { class: 'view reader-view' });
  let disposed = false;
  const cleanups: (() => void)[] = [];
  // (A clean-up asked for once the reader is gone — a book closed while it was still opening — is done at once: kept
  // for later, it would never be done, and the book's keys and listeners would stay on the next screen.)
  const run = (fn: () => void) => { try { fn(); } catch (err) { console.error(err); } };
  const onDispose = (fn: () => void) => { if (disposed) run(fn); else cleanups.push(fn); };
  const gone = () => disposed;
  // (Marked open until it is left: an app ended under it opens it again — see src/resume.ts.)
  onDispose(markReading(ids));
  // "Back twice to leave a book": Back (the phone's button or gesture, a computer's mouse button or Alt+←) — once what
  // is open over the book is closed (src/ui/backstack.ts does that first) and a selection let go — shows a reminder
  // the first time; a second Back within 2 s leaves. The top bar's arrow does not come here: it leaves at once.
  let backAt = 0;
  onDispose(onBack(() => {
    if (!getSettings().backTwiceLeave) return false;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && root.contains(sel.anchorNode)) { sel.removeAllRanges(); diagBackHeld('selection'); return true; }
    if (Date.now() - backAt <= 2000) { backAt = 0; return false; }
    backAt = Date.now();
    diagBackHeld('twice');
    toast(t('backAgainToLeave'), 'info', 2000);
    return true;
  }));

  void (async () => {
    const books = (await Promise.all(ids.map((id) => db.getBook(id)))).filter((b): b is Book => !!b);
    if (disposed) return;
    if (!books.length) { diagLeaveIntent('missing'); diagEvent('err', { what: 'book missing' }); navigate('/', true); return; }
    // (A series kept in the library without its volumes opens on its source, where its volumes are.)
    if (books[0].format === 'series' && books[0].remote?.link) { diagLeaveIntent('series'); navigate(books[0].remote.link, true); return; }
    // (The opening timed for the Performance page — its kind and rounded size only: src/diag.ts.)
    const op = diagOpen(books[0].format, books.length);
    setActiveBook(books[0].id); onDispose(() => setActiveBook(null));
    if (books[0].format === 'anki') { const { mountAnki } = await import('./anki'); await mountAnki(root, books[0], onDispose); op.placed(); return; }
    if (books.every((b) => b.format === 'audio')) { const { mountAudio } = await import('./audio'); await mountAudio(root, books, onDispose); op.placed(); return; }
    const pdfs = books.filter((b) => b.format === 'pdf');
    const flows = books.filter((b) => b.format !== 'pdf');
    if (pdfs.length && (flows.length || pdfs.length > 1)) toast(t('fmtPdf') + ' · ' + t('open'), 'info', 3000);
    if (pdfs.length && !flows.length) await mountPdf(root, pdfs[0], onDispose, gone, op);
    else await mountFlow(root, flows.length ? flows : pdfs, onDispose, gone, op);
  })().catch((err) => { console.error(err); diagEvent('err', { what: 'open failed', name: (err as Error)?.name ?? typeof err }); diagLeaveIntent('error'); toast(t('openError', { error: String((err as Error)?.message ?? err) }), 'error', 6000); });

  (root as HTMLElement & { dispose?: () => void }).dispose = () => { if (disposed) return; disposed = true; cleanups.splice(0).forEach(run); };
  return root;
}

/* ------------------------------------------------------------------ */
/* Flow reader                                                         */
/* ------------------------------------------------------------------ */

type DiagOpen = ReturnType<typeof diagOpen>;
async function mountFlow(root: HTMLElement, books: Book[], onDispose: (fn: () => void) => void, gone: () => boolean = () => false, op?: DiagOpen): Promise<void> {
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
  // (Pictures read ahead within this scroll, not the window — see setLazyRoot.)
  setLazyRoot(scroll); onDispose(() => setLazyRoot(null));
  const footerBar = h('i');
  const footerWhere = h('span', { class: 'where' });
  const footerPct = h('span', { class: 'pct' });
  const footer = h('div', { class: 'read-footer' }, footerWhere, h('div', { class: 'bar' }, footerBar), footerPct);
  // The reading bar (src/ui/readbar.ts), and the frame of the text as it is read with the chrome hidden — one page
  // (reader.css .read-frame): the bar's pages are counted in it, so they do not change when the chrome shows or hides.
  const bar = createReadBar(root, onDispose);
  const statusBar = bar.el;
  const frame = h('div', { class: 'read-frame', 'aria-hidden': 'true' });
  root.classList.add('flow-reader');
  const title = h('div', { class: 'title' });
  const panel = new SidePanel(root);

  // (Back: to the book's own page when the book opens on one, else the library.)
  const goBack = () => { diagLeaveIntent('top-back', true); const b = docs[0]?.book; if (b && leaveToCaller(b.id)) return; if (b && docs.length === 1) void import('./book').then((m) => goBackView(m.wantsBookPage(b) ? `/book/${b.id}` : '/')); else goBackView('/'); };
  // The top bar — the back arrow (always there), the buttons placed at its start, the title, those at its end — and
  // the M3 Expressive floating toolbar: what each holds is the reader's choice (src/readbuttons.ts), drawn below
  // once the reader's state is there (mountBars).
  const backBtn = iconButton('back', t('back'), goBack);
  const topbar = h('header', { class: 'topbar' }, backBtn, title);
  const toolbar = h('nav', { class: 'float-toolbar', 'aria-label': t('more') });
  const moreBtn = iconButton('more', t('more'), () => openMore());
  // (On a computer the tools sit in the top bar with their names — see the styles —; a phone keeps the floating icons.)
  const named = (b: HTMLElement) => { const l = b.getAttribute('aria-label'); if (l && b.classList.contains('icon-btn') && !b.querySelector('.tb-label')) b.append(h('span', { class: 'tb-label' }, l)); return b; };
  reader.append(scroll);
  const chapterNav = h('nav', { class: 'chapter-nav', hidden: true });
  // A computer's page-turn arrows at the two sides of the text: shown while the mouse moves, gone when it rests.
  const arrow = (fwd: boolean) => h('button', { type: 'button', class: `page-arrow ${fwd ? 'next' : 'prev'}`, title: fwd ? t('nextPage') : t('prevPage'), 'aria-label': fwd ? t('nextPage') : t('prevPage'), onclick: () => turnPage(!fwd) }, icon(fwd ? 'chevronRight' : 'chevronLeft'));
  const arrows = [arrow(false), arrow(true)];
  let restT = 0; const awake = () => { root.classList.add('mouse-awake'); window.clearTimeout(restT); restT = window.setTimeout(() => root.classList.remove('mouse-awake'), 1800); };
  root.addEventListener('mousemove', awake); onDispose(() => window.clearTimeout(restT));
  reader.append(...arrows);
  root.append(topbar, reader, footer, statusBar, toolbar, frame, h('div', { class: 'reader-comfort', 'aria-hidden': 'true' }));
  // (The text ends above the floating toolbar while it shows: its height, for the styles.)
  // (…and, the toolbar at a side, its width: the text keeps clear of it.)
  { const tbObs = new ResizeObserver(() => { const hgt = toolbar.offsetHeight, w = toolbar.offsetWidth; if (hgt) root.style.setProperty('--tb-h', `${hgt}px`); if (w) root.style.setProperty('--tb-w', `${w}px`); }); tbObs.observe(toolbar); onDispose(() => tbObs.disconnect()); }
  // Where the toolbar stands and how it looks (reader.css [data-tb], [data-tblook]): «auto» is at the foot on a phone
  // and in the top bar on a computer ('inline').
  const placeToolbar = () => { const s = getSettings(); const at = s.toolbarAt === 'auto' || !s.toolbarAt ? (document.documentElement.classList.contains('pc') ? 'inline' : 'bottom') : s.toolbarAt; root.dataset.tb = toolbar.hidden ? 'none' : at; root.dataset.tblook = at === 'inline' ? 'pill' : s.toolbarLook === 'docked' ? 'docked' : 'pill'; };
  placeToolbar();
  syncChrome();
  panel.onClose = () => { try { localStorage.removeItem(DOCK_KEY); } catch { /* private mode */ } };
  { let was: string | null = null; try { was = localStorage.getItem(DOCK_KEY); } catch { /* private mode */ }
    if (was && SidePanel.canDock()) { const tab = was as 'toc'; const tm = window.setTimeout(() => { void whole.then(() => { if (root.isConnected && !panel.isOpen) openContents(tab); }); }, 900); onDispose(() => window.clearTimeout(tm)); } }
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
    // (Each chapter's title and blocks worked out when asked for, not for every chapter at each call: the translator
    // asks for the list at open, and a book of hundreds of chapters cost the whole book's blocks times its chapters.)
    chapters: () => units().map((u, i) => { let label: string | undefined; return { get label() { return (label ??= chapterTitle(u) || `${localDigits(i + 1)}`); }, bookId: u.doc.book.id, get blocks() { return blocksOfUnit(u); } }; }),
    currentChapter: () => Math.max(0, currentUnitIndex()),
    onChapterChange: (fn) => chapterListeners.push(fn),
    bookTitle: (id) => docs.find((d) => d.book.id === id)?.book.title,
  });
  onDispose(() => translator.dispose());
  let allImages: ImageRef[] = [];
  // (Caches the position helpers use — declared before the first book renders: a place saved or restored while
  // the book is still opening uses them.)
  const blockIdx = new WeakMap<OpenDoc, WeakMap<Element, number>>();
  const anchorsOf = new Map<OpenDoc, Element[]>();
  let saveTimer: number | undefined; let savePending = false;
  let userScrolled = false;
  // (The place asked for when the book was opened — a chapter tapped on a novel's page, a bookmark, a note: the
  // later passes of restore — fonts and pictures settling — go back to it, not to the place read last. Declared
  // here, before the first restore, which runs while the rest of this function waits on the book.)
  let asked: (() => void) | null = null;
  // A book of many chapters opened at the chapter read last, that chapter made first and the rest after (renderDoc,
  // firstChapter): while the rest are made the book is shown but not yet whole — `early` — and what needs the whole
  // book (the reader's actions) waits for `whole`.
  interface Plan { k: number; map: ChapterMap | null; block?: number; offset?: number }
  interface Early { doc: OpenDoc; plan: Plan; size: number; scrolled: boolean; applied: Set<string>; done?: boolean }
  let early = null as Early | null;
  let wholeDone: () => void = () => undefined; const whole = new Promise<void>((r) => { wholeDone = r; });
  let saveSoon = false;

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

  // Every action of a flowing book (src/readbuttons.ts FLOW_ACTIONS), wherever the reader has put it: the top bar, the
  // toolbar, «More» — or nowhere (its key and its tap zone still do it: onKey, onCommand).
  const bookNow = () => currentLocator()?.doc.book ?? docs[0].book;
  const speakToggle = () => { if (speaking) stopSpeaking(); else { const cur = currentLocator(); if (cur) speak([], { doc: cur.doc, index: cur.loc.block ?? 0 }); } };
  const actions: Record<string, ActionRun> = {
    toc: { run: () => openContents('toc') },
    search: { run: () => openSearch() },
    images: { run: () => showGallery() },
    bookmark: { run: () => void addBookmark() },
    bookmarks: { run: () => openContents('bookmarks') },
    highlights: { run: () => openContents('highlights') },
    type: { run: () => openOptions() },
    translate: { run: () => translator.toggleUi() },
    glossary: { run: () => { const b = bookNow(); void import('../ui/glossarysheet').then((m) => m.glossarySheet({ id: b.id, title: b.title })); } },
    speak: { run: speakToggle, label: () => (speaking ? t('stopReading') : t('readAloud')), icon: () => (speaking ? 'stop' : 'speak') },
    scroll: { run: () => toggleAutoScroll() },
    speedReading: { run: () => void startSpeedReading() },
    sleepTimer: { run: () => sleepTimerSheet(), label: () => (sleepTimer ? t('sleepTimerOff') : t('sleepTimer')) },
    dayNight: { run: () => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'dayNight' })) },
    fullscreen: { run: () => { void toggleFullscreen(root); } },
    readingBar: { run: () => updateSettings({ showStatusLine: !getSettings().showStatusLine }), label: () => (getSettings().showStatusLine ? t('hideReadingBar') : t('showReadingBar')) },
    info: { run: () => showInfo() },
    favorite: { run: () => void toggleFavorite(bookNow()), label: () => (bookNow().tags?.includes(FAV_TAG) ? t('unfavorite') : t('favorite')), icon: () => (bookNow().tags?.includes(FAV_TAG) ? 'heartFill' : 'heart') },
    exportNotes: { run: () => void exportNotes(bookNow()) },
    exportAnki: { run: () => void exportNotesAnki(bookNow()) },
    shareFile: { run: () => void shareBooks([bookNow().id]) },
    convertFile: { run: () => { const b = bookNow(); void import('../ui/convert').then((m) => m.convertSheet(b)); } },
    readInOrder: { run: () => void import('../ui/queue').then((m) => m.queueSheet(getQueue().length ? getQueue() : books.map((b) => b.id), { onChange: () => void findNext() })) },
    jumpToBook: { run: () => openContents('toc'), available: () => docs.length > 1 },
  };
  // (Asked for while the book's later chapters are still being made: done once they are — on the whole book.)
  for (const a of Object.values(actions)) { const run = a.run; a.run = () => { if (early) void whole.then(run); else run(); }; }
  const bars = mountBars({ kind: 'flow', root, topbar, back: backBtn, title, toolbar, toolbarBox: toolbar, more: moreBtn, actions, dress: named, after: () => placeToolbar() });
  bars.render();
  onDispose(onSettingsChange(() => { placeToolbar(); bars.render(); }));
  onDispose(() => bars.dispose());

  /** The start of an element's text — `el.textContent.slice(0, n)` — without making the whole of it. */
  function headText(el: Element, n: number): string {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION); let out = '';
    for (let x = w.nextNode(); x && out.length < n; x = w.nextNode()) out += (x as CharacterData).data;
    return out.slice(0, n);
  }
  /** The blocks of a book's text (or of a part of it), in order: the units its places are counted in. */
  function blocksIn(el: Element): HTMLElement[] {
    return [...el.querySelectorAll<HTMLElement>(`${BLOCK_SELECTOR}, img`)].filter((b) => !b.closest('table') || b.tagName === 'TD' || b.tagName === 'TH');
  }
  /** Whether a chapter has text or a picture (`textContent.trim()` without building the chapter's whole text). */
  function hasContent(c: Element): boolean {
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (/\S/.test((n as CharacterData).data)) return true;
    return !!c.querySelector('img, svg, image, video');
  }
  /** The book's blocks, its chapters and the one shown (chapter by chapter), its text rules, typography and highlights:
   *  what the reader keeps of a book once its text is made — and again once the rest of its chapters are, for a book
   *  opened at a chapter first (`target`: the element whose chapter is shown; else the place read last). */
  function layDoc(doc: OpenDoc, target?: Element | null): void {
    const el = doc.render!.element;
    if (textRules().length) applyTextRules(el, doc.book.id);
    if (getSettings().bookFormat || getSettings().smartTypography) applyTypography(el);
    doc.allBlocks = blocksIn(el);
    const all = [...el.querySelectorAll<HTMLElement>(':scope > .kr-chapter')];
    const sections = all.filter((c) => !c.classList.contains('kr-shell') && hasContent(c));
    doc.chapters = sections.length > 1 ? sections : [el];
    doc.chapter = 0;
    doc.blocks = doc.allBlocks;
    if (chapterMode() && doc.chapters.length > 1) {
      // Hide the other chapters before the first layout: laying out a whole book
      // just to show one chapter was most of the time a large EPUB took to open.
      let pb: Element | undefined;
      if (target !== undefined) pb = target ?? undefined;
      else { const p = doc.book.progress; pb = p && p.bookId === doc.book.id && p.block !== undefined ? doc.allBlocks[p.block] : undefined; }
      const idx = pb ? doc.chapters.findIndex((c) => c === pb || c.contains(pb!)) : -1;
      doc.chapter = Math.max(0, idx);
      doc.chapters.forEach((c, i) => { c.hidden = i !== doc.chapter; });
      doc.blocks = doc.allBlocks.filter((b) => doc.chapters[doc.chapter].contains(b));
    }
    // (Chapters not made yet are kept out of sight chapter by chapter — held; once made, one that is not a chapter of
    // the reader's — empty — is shown as it always was.)
    for (const c of all) {
      if (c.classList.contains('kr-shell')) { if (chapterMode()) { c.hidden = true; c.dataset.krHeld = '1'; } }
      else if (c.dataset.krHeld) { delete c.dataset.krHeld; if (!doc.chapters.includes(c)) c.hidden = false; }
    }
    applyHighlights(doc);
  }
  /** The sizes of a book's chapters, kept on this device from its last opening (not synced, not backed up): each
   *  chapter's blocks in the order of its spine, and its direction — so it can open at its place with only the chapter
   *  there made (firstChapter). A guess only: the place is put right once the whole book is made. */
  interface ChapterMap { size: number; b: number[]; rtl: boolean }
  const MAPS = 'kr.chapterMaps';
  function readMap(id: string, size: number): ChapterMap | null {
    try { const m = (JSON.parse(localStorage.getItem(MAPS) ?? '{}') as Record<string, ChapterMap>)[id]; return m && m.size === size && Array.isArray(m.b) ? m : null; } catch { return null; }
  }
  function writeMap(doc: OpenDoc, size: number): void {
    const el = doc.render?.element; if (!el || doc.book.format !== 'epub') return;
    const all = [...el.querySelectorAll<HTMLElement>(':scope > .kr-chapter')]; if (all.length <= 6) return;
    const at = new Map<Element, number>(all.map((c, i) => [c, i])); const b = all.map(() => 0);
    for (const bl of doc.allBlocks) { let e: Element | null = bl; while (e && e.parentElement !== el) e = e.parentElement; const i = e ? at.get(e) : undefined; if (i !== undefined) b[i]++; }
    const map: ChapterMap = { size, b, rtl: !!doc.render?.rtl };
    try {
      const maps = JSON.parse(localStorage.getItem(MAPS) ?? '{}') as Record<string, ChapterMap>;
      const was = maps[doc.book.id]; if (was && JSON.stringify(was) === JSON.stringify(map)) return;
      delete maps[doc.book.id]; maps[doc.book.id] = map;
      const ids = Object.keys(maps); for (const id of ids.slice(0, Math.max(0, ids.length - 24))) delete maps[id];
      localStorage.setItem(MAPS, JSON.stringify(maps));
    } catch { /* full or private: opened whole next time */ }
  }
  /** The chapter (its place in the spine) a book of many chapters is opened at, made first with its neighbours, and the
   *  block there — or null: made whole first, as always (books read together, a jump asked for — a bookmark, a note, a
   *  search hit, the pictures —, a place this device cannot find without the whole book). */
  function firstChapter(doc: OpenDoc, size: number): Plan | null {
    if (docs.length !== 1 || doc.book.format !== 'epub') return null;
    try { if (sessionStorage.getItem('kr.jump') || sessionStorage.getItem('kr.searchJump') || sessionStorage.getItem('kr.openGallery') === doc.book.id) return null; } catch { return null; }
    const map = readMap(doc.book.id, size);
    const p = doc.book.progress;
    if (!p || p.bookId !== doc.book.id) return { k: 0, map };
    if (p.anchor) return null;
    if (p.block === undefined) return p.pct ? null : { k: 0, map };
    if (!map) return p.block === 0 ? { k: 0, map, block: 0, offset: p.offset } : null;
    let base = 0;
    for (let i = 0; i < map.b.length; i++) { if (p.block < base + map.b[i]) return { k: i, map, block: p.block - base, offset: p.offset }; base += map.b[i]; }
    return null;
  }
  /** The element a book made a chapter first opens at: the block of its place, else its chapter (null: the start). */
  function firstTarget(doc: OpenDoc, plan: Plan): HTMLElement | null {
    const el = doc.render!.element; const sec = document.getElementById(`${doc.book.id}-c${plan.k}`);
    if (plan.block !== undefined) { const b = plan.map ? (sec ? blocksIn(sec)[plan.block] : undefined) : blocksIn(el)[plan.block]; if (b) return b; }
    return plan.k > 0 && sec && el.contains(sec) ? sec : null;
  }
  /** Put the place back in a book made a chapter first (as scrollToLocator does, from the chapter's own blocks). */
  function placeFirst(doc: OpenDoc, plan: Plan): void {
    const target = firstTarget(doc, plan);
    if (!target || plan.block === undefined) return;
    programmatic = performance.now();
    const sr = scroll.getBoundingClientRect(); const r = target.getBoundingClientRect();
    scroll.scrollTop += r.top - sr.top - 8 + (plan.offset ?? 0) * r.height;
  }
  /** The place in a book still being made, from its chapters' sizes kept (only when the chapter read agrees with them):
   *  saved if the app is hidden or the book left before it is whole. */
  function earlyLocator(): Locator | null {
    const e = early; const map = e?.plan.map; if (!e || !map) return null;
    const blocks = e.doc.blocks; const sr = scroll.getBoundingClientRect(); if (!blocks.length || sr.height < 40) return null;
    let lo = 0, hi = blocks.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (blocks[m].getBoundingClientRect().bottom - sr.top <= 8) lo = m + 1; else hi = m; }
    const block = blocks[lo]; const sec = block.closest<HTMLElement>('.kr-chapter'); const i = Number(/-c(\d+)$/.exec(sec?.id ?? '')?.[1] ?? NaN);
    if (!sec || !(i >= 0) || i >= map.b.length) return null;
    const own = blocksIn(sec); if (own.length !== map.b[i]) return null;
    let base = 0; for (let j = 0; j < i; j++) base += map.b[j];
    const total = map.b.reduce((a, x) => a + x, 0); const r = block.getBoundingClientRect();
    const offset = Math.min(1, Math.max(0, (sr.top + 8 - r.top) / Math.max(1, r.height))); const at = base + own.indexOf(block);
    return { bookId: e.doc.book.id, block: at, offset, pct: total ? Math.min(1, (at + offset) / total) : 0 };
  }

  async function renderDoc(doc: OpenDoc, quick = false): Promise<void> {
    const handler = flowHandlerFor(doc.book.format);
    const t0 = performance.now();
    const file = await db.getFile(doc.book.id);
    performance.measure('kr:getFile', { start: t0 });
    if (doc === docs[0] && file) op?.size('bytes', file.size);
    if (!handler || !file) { if (doc === docs[0]) op?.failed(file ? 'unsupported' : 'file missing'); doc.wrapper.append(h('p', { class: 'kr-content' }, !file && doc.book.source ? t('linkedFileMissing', { title: doc.book.title }) : t('unsupportedFormat'))); return; }
    // (A book of many chapters opened where it was read: that chapter made first — firstChapter.)
    const plan = quick ? firstChapter(doc, file.size) : null;
    const ctx = { bookId: doc.book.id, bookTitle: doc.book.title, publisherStyles: getSettings().publisherStyles, id: (s: string) => `${doc.book.id}-${s}`, ...(plan ? { first: plan.k, rtl: plan.map?.rtl } : {}) };
    try {
      doc.render?.dispose();
      doc.wrapper.querySelector('.kr-content')?.remove();
      const t1 = performance.now();
      doc.render = await handler.render(file, ctx);
      performance.measure('kr:render', { start: t1 });
      const t2 = performance.now();
      doc.wrapper.append(doc.render.element);
      // (The reader's text rules — a watermark taken out, a name respelt — on the text, and on chapters that
      // come later.)
      { const el = doc.render.element; const id = doc.book.id; el.addEventListener('kr-content-changed', () => { if (textRules().length) applyTextRules(el, id); }); }
      // (Chapters that come after the book opened — a novel's, fetched as read — are blocks of it too: read aloud,
      // counted, found, their place kept; laid out as the rest.)
      { const d = doc; const el = doc.render.element; el.addEventListener('kr-content-changed', (ev) => {
        if (d.render?.element !== el) return;
        if (getSettings().bookFormat || getSettings().smartTypography) applyTypography(((ev as CustomEvent<{ el?: Element }>).detail?.el) ?? el);
        d.allBlocks = blocksIn(el);
        d.blocks = chapterMode() && d.chapters.length > 1 ? d.allBlocks.filter((b) => d.chapters[d.chapter]?.contains(b)) : d.allBlocks;
        allImages = docs.flatMap((x) => x.render?.images ?? []);
      }); }
      if (doc.render.rest && plan) { early = { doc, plan, size: file.size, scrolled: false, applied: new Set() }; layDoc(doc, firstTarget(doc, plan)); }
      else { layDoc(doc); if (docs.length === 1 && doc.book.format === 'epub') { const d = doc, size = file.size; window.setTimeout(() => { if (d.render?.element.isConnected) writeMap(d, size); }, 2000); } }
      performance.measure('kr:dom', { start: t2 });
    } catch (err) {
      console.error(err);
      if (doc === docs[0]) op?.failed((err as Error)?.name ?? 'error');
      const msg = String((err as Error)?.message ?? err);
      // (A file that came broken — its zip with no end, cut short — fetched again from where it came, into
      // this same book: its place and notes kept.)
      const broken = /central directory|corrupted zip|end of data|invalid (zip|signature)|is this a zip/i.test(msg);
      const { canRefetch } = await import('../sources/refetch');
      if (broken) {
        const box = h('div', { class: 'kr-content broken-file' }, h('p', null, t('fileBroken')));
        if (canRefetch(doc.book)) {
          const btn = h('button', { type: 'button', class: 'btn primary' }, icon('download'), t('downloadAgain')) as HTMLButtonElement;
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              const { refetchBook } = await import('../sources/refetch');
              await refetchBook(doc.book, (pct) => { btn.replaceChildren(icon('download'), `${t('downloadAgain')} · ${localDigits(pct)}%`); });
              toast(t('downloadedAgain', { title: doc.book.title }), 'info', 4000);
              const fresh = await db.getBook(doc.book.id); if (fresh) doc.book = fresh;
              box.remove(); await renderDoc(doc);
              if (doc === docs[0]) restore();
            } catch (e) { btn.disabled = false; btn.replaceChildren(icon('download'), t('downloadAgain')); toast(String((e as Error)?.message ?? e), 'error', 5000); }
          });
          box.append(btn);
        }
        doc.wrapper.append(box);
      } else doc.wrapper.append(h('p', { class: 'kr-content' }, t('openError', { error: msg })));
    }
  }

  // Render books in order so the first one appears quickly.
  // (Opened at the book read last: it is the one whose place is put back once it is on the page.)
  const lastRead = latestDoc();
  // (Continuous reading's styles from the start — chapters away from the screen not laid out —, not only once the book
  // is set up: the first place put back laid out every chapter before it.)
  scroll.classList.toggle('reader-continuous', !chapterMode());
  for (const doc of docs) {
    await renderDoc(doc, true);
    // (Closed while it was opening: nothing more is set up — no keys, no listeners, no place saved.)
    if (gone()) { docs.forEach((d) => d.render?.dispose()); return; }
    if (doc === docs[0]) { root.querySelector('#kr-loading')?.remove(); if (op) { if (early?.doc !== doc) op.size('paras', doc.allBlocks.length); op.shown(); } }
    if (doc === docs[0] || doc === lastRead) { const tr = performance.now(); if (early?.doc === doc) { if (chapterMode()) renderChapterNav(); placeFirst(doc, early.plan); } else restore(); performance.measure('kr:restore', { start: tr }); if (doc === lastRead) op?.placed(); }
  }
  // A book opened at a chapter made first: shown now, its other chapters made in slices between frames (the reader
  // may read and scroll meanwhile), then the whole book's blocks, chapters and highlights taken as for a book made
  // whole — the place read meanwhile kept — before the rest of the reader is set up.
  if (early) {
    const e = early;
    // (Moved by the reader — a touch, the wheel, a key, then a scroll —, not by the page settling: lines a little taller
    // once a font has loaded move the scroll too.)
    let touched = false; const onInput = () => { touched = true; };
    const onScroll = () => { if (touched && performance.now() - programmatic > 150) e.scrolled = true; };
    // (Hidden or left before it is whole: the place read meanwhile saved, from the chapters' sizes kept.)
    const keep = () => { if (!e.scrolled || e.done) return; const loc = earlyLocator(); if (!loc) return; e.doc.book.progress = loc; void db.updateBook(e.doc.book.id, (b) => { b.progress = loc; b.progressAt = stampAfter(b.progressAt); }); };
    const onHidden = () => { if (document.visibilityState === 'hidden') keep(); };
    const inputs = ['touchstart', 'wheel', 'pointerdown', 'keydown'] as const;
    // (The page settling — fonts, pictures — before the reader has moved: the place put back again, as restore's later
    // passes do for a book made whole.)
    const settle = new ResizeObserver(() => { if (!touched && !e.scrolled && early === e && !gone()) placeFirst(e.doc, e.plan); });
    settle.observe(e.doc.render!.element);
    scroll.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('pagehide', keep); document.addEventListener('visibilitychange', onHidden);
    for (const ev of inputs) root.addEventListener(ev, onInput, { passive: true, capture: true });
    const unwatch = () => { settle.disconnect(); scroll.removeEventListener('scroll', onScroll); window.removeEventListener('pagehide', keep); document.removeEventListener('visibilitychange', onHidden); for (const ev of inputs) root.removeEventListener(ev, onInput, { capture: true }); };
    onDispose(() => { keep(); unwatch(); });
    // (The fonts loaded meanwhile — the lines a little taller or shorter —: the place put back again, as restore does
    // for a book made whole, unless the reader has moved.)
    void document.fonts.ready.then(() => { if (early === e && !touched && !e.scrolled && !gone()) placeFirst(e.doc, e.plan); });
    const t3 = performance.now();
    const made = await e.doc.render!.rest!().catch((err: unknown) => { console.error(err); return false; });
    performance.measure('kr:rest', { start: t3 });
    if (gone()) { unwatch(); docs.forEach((d) => d.render?.dispose()); return; }
    if (!made) {
      // (The rest could not be made: the book made whole, as it always was, and put at its place.)
      if (e.scrolled) keep();
      e.done = true; unwatch(); early = null;
      await renderDoc(e.doc);
      if (gone()) { docs.forEach((d) => d.render?.dispose()); return; }
      restore();
    } else {
      const shown = chapterMode() ? (e.doc.chapters.length > 1 ? e.doc.chapters[e.doc.chapter] : firstTarget(e.doc, e.plan)) : undefined;
      e.done = true;
      layDoc(e.doc, shown);
      unwatch();
      early = null;
      if (e.scrolled) { userScrolled = true; const c = currentLocator(); if (c) { c.doc.book.progress = c.loc; saveSoon = true; } }
    }
    op?.size('paras', e.doc.allBlocks.length);
    { const d = e.doc, size = e.size; window.setTimeout(() => { if (d.render?.element.isConnected) writeMap(d, size); }, 2000); }
  }
  wholeDone();
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
  // (The first 4,000 letters of each book, not its whole text made into one string to cut them from — megabytes.)
  const heads = docs.map((d) => headText(d.wrapper, 4000));
  const sample = heads.join('\n');
  const isJa = docs.some((d, i) => isJapanese(heads[i], d.book.language));
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
  flow.querySelectorAll('img').forEach((img) => { if (img.complete && img.naturalWidth) return; img.decoding = 'async'; img.classList.add('kr-img-pending'); const done = () => img.classList.remove('kr-img-pending'); img.addEventListener('load', done, { once: true }); img.addEventListener('error', () => { if (img.getAttribute('src')) { img.classList.remove('kr-img-pending'); img.classList.add('kr-img-failed'); } }); });
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
  // (Saved there and then: a timer set now would not run in an app the system has stopped.)
  const flushAll = () => { if (savePending) { window.clearTimeout(saveTimer); void saveProgress(); } trackers.forEach((tr) => void tr.save()); };
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
  void document.fonts.ready.then(() => {
    if (!reader.isConnected) return;
    // (A long text's runs not laid out yet take the height measured on its first one, in the fonts now loaded — the
    // book's length, and so its pages on the reading bar, right from the start: sizeRuns.)
    for (const d of docs) if (d.render) sizeRuns(d.render.element);
    if (!userScrolled) restore();
  });

  /* ---------- chapter mode ---------- */
  interface Unit { doc: OpenDoc; el: HTMLElement; index: number }
  function units(): Unit[] { return docs.flatMap((doc) => doc.chapters.map((el, index) => ({ doc, el, index }))); }
  /** A unit's blocks: every block of the book sorted into its chapter in one pass (each one's chapter found by walking
   *  up from it), kept until the book's blocks or chapters are made again. */
  const unitBlocks = new WeakMap<OpenDoc, { all: HTMLElement[]; chapters: HTMLElement[]; by: HTMLElement[][] }>();
  function blocksOfUnit(u: Unit): HTMLElement[] {
    let c = unitBlocks.get(u.doc);
    if (!c || c.all !== u.doc.allBlocks || c.chapters !== u.doc.chapters) {
      const ix = new Map(u.doc.chapters.map((el, i) => [el as Element, i]));
      const by = u.doc.chapters.map(() => [] as HTMLElement[]);
      for (const b of u.doc.allBlocks) for (let e: Element | null = b; e; e = e.parentElement) { const i = ix.get(e); if (i !== undefined) { by[i].push(b); break; } }
      c = { all: u.doc.allBlocks, chapters: u.doc.chapters, by }; unitBlocks.set(u.doc, c);
    }
    return c.by[u.index] ?? [];
  }
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
    // (Pressed while the book's later chapters are still being made: done once they are, to the same chapter.)
    const go = (u: Unit, fallback: number) => { if (!early) { showUnit(fallback); return; } void whole.then(() => { const i = units().findIndex((x) => x.doc === u.doc && x.el === u.el); if (i >= 0) showUnit(i); }); };
    chapterNav.append(
      prev ? h('button', { type: 'button', class: 'cn-btn', onclick: () => go(prev, k - 1) }, icon('chevronLeft'), h('span', { dir: 'auto' }, h('small', null, t('prevChapter')), chapterTitle(prev) || t('previousPage'))) : h('span'),
      next ? h('button', { type: 'button', class: 'cn-btn primary', onclick: () => go(next, k + 1) }, h('span', { dir: 'auto' }, h('small', null, t('nextChapter')), chapterTitle(next) || t('nextPage')), icon('chevronRight')) : h('span', { class: 'end' }, t('endOfBook')),
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
    for (const d of docs) if (d.render) sizeRuns(d.render.element);
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

  /** A long plain text's runs not laid out yet (formats/shared.ts textToParagraphs) take the height their text will
   *  have: the sizes measured on the first run — per character, and per paragraph (its last line, its spacing) — so
   *  that the book's length, the place's percentage and the scroll bar are right before the runs are laid out. Measured
   *  again whenever a place is gone to (the text's size, spacing or width may have changed). */
  function sizeRuns(el: HTMLElement): void {
    const run = el.querySelector<HTMLElement>(':scope > .kr-run'); const first = run?.firstElementChild, last = run?.lastElementChild;
    if (!run || !first || !last || !run.isConnected) return;
    const hgt = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top; if (!(hgt > 0)) return;
    const cs = getComputedStyle(first); const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.6; const mb = parseFloat(cs.marginBlockEnd) || 0;
    const c = Number(run.style.getPropertyValue('--kr-run-c')) || 1, p = Number(run.style.getPropertyValue('--kr-run-p')) || 1;
    const ppx = lh * 0.5 + mb, cpx = Math.max(0, (hgt + mb - p * ppx) / c);
    const a = `${cpx.toFixed(4)}px`, b = `${ppx.toFixed(2)}px`;
    if (el.style.getPropertyValue('--kr-cpx') !== a) el.style.setProperty('--kr-cpx', a);
    if (el.style.getPropertyValue('--kr-ppx') !== b) el.style.setProperty('--kr-ppx', b);
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

  /** The book of those open whose place was saved last (places are stamped — db.stampAfter); for places saved before
   *  they were, the first book read and not finished (one scrolled past is marked finished), else the first. */
  function latestDoc(): OpenDoc | undefined {
    const has = (d: OpenDoc) => !!d.book.progress && d.book.progress.bookId === d.book.id;
    let best: OpenDoc | undefined;
    for (const d of docs) if (has(d) && (d.book.progressAt ?? 0) > (best?.book.progressAt ?? 0)) best = d;
    if (best) return best;
    return docs.find((d) => has(d) && (d.book.progress!.pct ?? 0) < 1 && !!(d.book.progress!.block || d.book.progress!.pct || d.book.progress!.anchor)) ?? docs[0];
  }

  function restore(): void {
    const first = docs[0];
    if (!first) return;
    if (asked) { asked(); return; }
    const jump = takeJump();
    if (jump) {
      const doc = docs.find((d) => d.book.id === jump.bookId) ?? first;
      if (jump.kind === 'bm') { const bm = doc.book.bookmarks.find((x) => x.id === jump.id); if (bm) { asked = () => scrollToLocator(bm.locator); asked(); return; } }
      if (jump.kind === 'toc') { const i = Number(jump.id); const item = doc.render?.toc?.[i]; if (item) { asked = () => scrollToAnchor(item.anchor, false); setTimeout(asked, 30); return; } }
      // (A place that is not in the book — a chapter it does not have — leaves the reading where it was.)
      if (jump.kind === 'anchor' && document.getElementById(jump.id)) { asked = () => scrollToAnchor(jump.id, false); setTimeout(asked, 30); return; }
      if (jump.kind === 'hl') { asked = () => { const m = doc.wrapper.querySelector(`mark[data-hl="${jump.id}"]`) as HTMLElement | null; if (m) { if (!m.id) m.id = `hl-${jump.id}`; scrollToAnchor(m.id, false); } }; setTimeout(asked, 50); return; }
    }
    // (Books read together — a series, a merged session — open at the one read last, not at the first.)
    const at = latestDoc() ?? first;
    const p = at.book.progress;
    if (p && p.bookId === at.book.id) scrollToLocator(p);
    // (Opened for its pictures — a novel's, from its page in the sources.)
    try { if (sessionStorage.getItem('kr.openGallery') === first.book.id) { sessionStorage.removeItem('kr.openGallery'); setTimeout(() => showGallery(), 400); } } catch { /* private mode */ }
  }

  /** Which contents entry a block falls under (the last one that starts at or before it). A binary search
   *  over the contents, so a book with thousands of entries costs a dozen comparisons a scroll, not thousands. */
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
    nextPill = h('button', { type: 'button', class: 'jump-back next-volume', onclick: () => { diagLeaveIntent('next-book'); navigate(`/read/${next.id}`); } }, h('span', { dir: 'auto' }, `${queued ? t('nextInOrder') : t('nextVolume')}: ${next.title}`), icon('arrowRight'));
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
  /* ---------- the reading bar's numbers ---------- */
  // A page of a flowing book is one screen of its text as it is read — the frame the text has with the chrome hidden
  // (.read-frame), at the font, size and margins in force. The sizes the count needs (the chapter's place and height,
  // the frame's) are measured once and kept until something is resized — the text (pictures loading, a run of a long
  // text laid out, the font changed), the screen (turned), the frame — so a scroll costs only arithmetic on scrollTop.
  interface Geo { unit: Element; uTop: number; uH: number; sTop: number; fTop: number; pageH: number; max: number }
  let geo: Geo | null = null; let geoDirty = true;
  const measure = (unit: Element): Geo => {
    if (geo && !geoDirty && geo.unit === unit) return geo;
    const sr = scroll.getBoundingClientRect(), ur = unit.getBoundingClientRect(), fr = frame.getBoundingClientRect();
    geoDirty = false;
    return (geo = { unit, uTop: ur.top - sr.top + scroll.scrollTop, uH: ur.height, sTop: sr.top, fTop: fr.top, pageH: Math.max(40, fr.height), max: scroll.scrollHeight - scroll.clientHeight });
  };
  /** The page being read in a chapter (the one at the top of the frame; the last once the chapter's end is in the
   *  frame, or the text can go no further), the chapter's pages, and how far into the chapter, 0–100. */
  const pagesIn = (unit: Element): { page: number; pages: number; pct: number; screens: number } => {
    const g = measure(unit); const st = scroll.scrollTop;
    const top = g.sTop + g.uTop - st; const pos = g.fTop - top;
    const pages = Math.max(1, Math.ceil(g.uH / g.pageH - 0.01));
    const end = top + g.uH <= g.fTop + g.pageH + 1 || st >= g.max - 1;
    const page = end ? pages : Math.min(pages, Math.max(1, Math.floor(pos / g.pageH + 0.01) + 1));
    const pct = end ? 100 : Math.round(Math.min(1, Math.max(0, pos / Math.max(1, g.uH - g.pageH))) * 100);
    return { page, pages, pct, screens: g.uH / g.pageH };
  };
  /** The chapter being read: the one shown (chapter by chapter), or the one the place is in (continuous reading). */
  const chapterSets = new WeakMap<HTMLElement[], Set<Element>>();
  const unitOf = (doc: OpenDoc, block: Element | undefined): HTMLElement => {
    if (doc.chapters.length <= 1) return doc.chapters[0] ?? doc.wrapper;
    if (chapterMode()) return doc.chapters[doc.chapter] ?? doc.chapters[0];
    let set = chapterSets.get(doc.chapters); if (!set) { set = new Set(doc.chapters); chapterSets.set(doc.chapters, set); }
    for (let e: Element | null = block ?? null; e; e = e.parentElement) if (set.has(e)) return e as HTMLElement;
    return doc.chapters[0];
  };
  // The book's length beyond the chapter: each chapter's characters and words, counted once in idle moments, and only
  // when an item that needs them is on the bar. Pages in the book are reckoned from them: the chapters not on the page
  // are not laid out (one chapter at a time, or kept unlaid until near), so their pages are the characters left over
  // the characters a page of this chapter holds — shown with «≈».
  interface Counts { chapters: HTMLElement[]; chars: number[]; words: number[] }
  const counts = new WeakMap<OpenDoc, Counts>(); const counting = new WeakSet<OpenDoc>();
  const countBook = (doc: OpenDoc): Counts | null => {
    const c = counts.get(doc); if (c && c.chapters === doc.chapters) return c;
    if (counting.has(doc)) return null;
    counting.add(doc);
    const chapters = doc.chapters; const chars: number[] = [], words: number[] = [];
    const step = (deadline?: { timeRemaining(): number }) => {
      if (!reader.isConnected || doc.chapters !== chapters) { counting.delete(doc); return; }
      const until = performance.now() + (deadline ? Math.max(2, Math.min(12, deadline.timeRemaining() - 1)) : 6);
      while (chars.length < chapters.length && performance.now() < until) {
        const k = chars.length; const u: Unit = { doc, el: chapters[k], index: k };
        chars.push(chapters[k].textContent?.length ?? 0);
        words.push(chapters.length === 1 ? doc.allBlocks.reduce((a, b) => a + wordCount(b), 0) : blocksOfUnit(u).reduce((a, b) => a + wordCount(b), 0));
      }
      if (chars.length < chapters.length) { const w = window as Idle; if (w.requestIdleCallback) w.requestIdleCallback(step, { timeout: 1500 }); else window.setTimeout(step, 30); return; }
      counts.set(doc, { chapters, chars, words }); counting.delete(doc); updateChrome();
    };
    const w = window as Idle; if (w.requestIdleCallback) w.requestIdleCallback(step, { timeout: 1500 }); else window.setTimeout(step, 30);
    return null;
  };
  const density = new WeakMap<OpenDoc, number>();
  const BOOK_ITEMS = ['bookPage', 'bookLeft', 'timeBook'] as const;
  let lastLabel = '', lastTitleDoc: OpenDoc | null = null;
  const updateChrome = throttle(() => {
    const cur = currentLocator();
    if (!cur) return;
    const label = labelFor(cur.doc, cur.loc.block ?? 0);
    const pct = Math.round(cur.loc.pct * 100);
    const block = cur.loc.block ?? 0;
    const unitEl = unitOf(cur.doc, cur.doc.allBlocks[block]);
    const v: import('../ui/readbar').BarValues = { chapter: label, title: cur.doc.book.title, bookPct: pct };
    if (statusBar.hidden === false) {
      const p = pagesIn(unitEl); v.page = p.page; v.pages = p.pages; v.chapterPct = p.pct;
      // The book's pages: this chapter's own, and the others' reckoned (a book of one chapter: counted, exact).
      const k = cur.doc.chapters.indexOf(unitEl);
      const c = BOOK_ITEMS.some((id) => bar.wants(id)) && cur.doc.chapters.length > 1 ? countBook(cur.doc) : null;
      if (cur.doc.chapters.length <= 1 || k < 0) { v.bookPage = p.page; v.bookPages = p.pages; }
      else if (c && (bar.wants('bookPage') || bar.wants('bookLeft'))) {
        if (c.chars[k] >= 400 && p.screens > 0.2) density.set(cur.doc, c.chars[k] / p.screens);
        const per = density.get(cur.doc);
        if (per) {
          let before = 0, after = 0; for (let i = 0; i < c.chars.length; i++) if (i < k) before += c.chars[i]; else if (i > k) after += c.chars[i];
          const pb = Math.round(before / per), pa = Math.round(after / per);
          v.bookPage = pb + p.page; v.bookPages = pb + p.pages + pa; v.bookApprox = true;
        }
      }
      // Minutes left at the reader's own pace (once the book's statistics know it: src/stats.ts).
      const speed = bar.wants('timeChapter') || bar.wants('timeBook') ? trackers.get(cur.doc)?.speed() : null;
      if (speed) {
        const inChapter = wordsLeft(cur.doc, unitEl, block);
        if (bar.wants('timeChapter')) v.minsChapter = Math.ceil(inChapter / speed);
        if (bar.wants('timeBook')) {
          if (cur.doc.chapters.length <= 1 || k < 0) v.minsBook = Math.ceil(inChapter / speed);
          else if (c) { let after = 0; for (let i = k + 1; i < c.words.length; i++) after += c.words[i]; v.minsBook = Math.ceil((inChapter + after) / speed); }
        }
      }
    }
    // — writes —
    if (label !== lastLabel || cur.doc !== lastTitleDoc) {
      lastLabel = label; lastTitleDoc = cur.doc;
      clear(title);
      title.append(document.createTextNode(cur.doc.book.title), h('small', { dir: 'auto' }, label !== cur.doc.book.title ? label : (cur.doc.book.author ?? '')));
      title.setAttribute('dir', 'auto');
      footerWhere.textContent = docs.length > 1 ? `${docs.indexOf(cur.doc) + 1}/${docs.length} · ${label}` : label;
      footerWhere.setAttribute('dir', 'auto');
    }
    const pctText = formatPercent(pct, 'prose');
    if (footerPct.textContent !== pctText) { footerPct.textContent = pctText; footerBar.style.width = `${pct}%`; }
    bar.set(v);
    if (cur.doc === docs[docs.length - 1] && lastUnitShown()) offerNext(scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2 ? 1 : cur.loc.pct);
  }, 150);
  // (The sizes kept for the count are measured again when the text, the frame or the scroller change size.)
  { const geoObs = new ResizeObserver(() => { geoDirty = true; updateChrome(); }); geoObs.observe(flow); geoObs.observe(frame); onDispose(() => geoObs.disconnect()); }

  function scheduleSave(): void {
    window.clearTimeout(saveTimer); savePending = true;
    saveTimer = window.setTimeout(saveProgress, 600);
  }
  async function saveProgress(): Promise<void> {
    savePending = false;
    const cur = currentLocator();
    if (!cur) return;
    await db.updateBook(cur.doc.book.id, (b) => { b.progress = cur.loc; b.progressAt = stampAfter(b.progressAt); });
    if (cur.doc.book.track && cur.loc.toc !== undefined) void import('../ui/track').then((m) => m.pushProgress(cur.doc.book, cur.loc.toc! + 1));
    scheduleSync();
    cur.doc.book.progress = cur.loc;
    // Books fully scrolled past count as finished.
    for (const d of docs) if (d !== cur.doc && docs.indexOf(d) < docs.indexOf(cur.doc) && (d.book.progress?.pct ?? 0) < 1) { d.book.progress = { bookId: d.book.id, pct: 1 }; await db.updateBook(d.book.id, (b) => { b.progress = d.book.progress; }); }
  }

  hooks.update = () => updateChrome();
  hooks.save = () => scheduleSave();
  if (saveSoon) scheduleSave();
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
    geoDirty = true; updateChrome();
    const w = scroll.clientWidth, hgt = scroll.clientHeight;
    if (Math.abs(w - lastW) < 2 && Math.abs(hgt - lastH) < 2) return;
    const narrowed = Math.abs(w - lastW) >= 2;
    lastW = w; lastH = hgt;
    // (Only the height changed — the chrome or the reading bar shown or hidden, the system's bars: the text does not
    // flow again, and is left where it is on the screen; put back at the scroller's new top, it jumped.)
    if (!narrowed) return;
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
    // (Where the reading is, read before the change is laid out.)
    const before = reader.isConnected ? currentLocator() : null;
    applySettings(reader, s); syncChrome(); syncComfort(); geoDirty = true; updateChrome();
    const want = s.bookFormat || s.smartTypography;
    // (The highlights taken off and put on again: on the text as it is now — a mark cut a changed word in pieces, and
    // turned back the text came out doubled.)
    if (want !== typoOn) { typoOn = want; for (const d of docs) if (d.render) { unmarkHighlights(d); (want ? applyTypography : revertTypography)(d.render.element); applyHighlights(d); } }
    syncFocus();
    // Text size, line spacing, margins, a font: the text flows again, and the paragraph being read is kept at the top.
    for (const d of docs) if (d.render) sizeRuns(d.render.element);
    if (before) { const after = currentLocator(); if (after && (after.doc !== before.doc || after.loc.block !== before.loc.block || Math.abs((after.loc.offset ?? 0) - (before.loc.offset ?? 0)) > 0.02)) scrollToLocator(before.loc); }
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
  /** A link that would load a page of the app itself (its address the app's, not another site's). */
  const staysInApp = (a: HTMLAnchorElement): boolean => { try { return new URL(a.href, location.href).origin === location.origin; } catch { return true; } };
  /** The id of the place in the book a `#…` link points to (by id, or by an old `name` anchor), or null. */
  let linkIds = 0;
  const placeOfLink = (a: HTMLAnchorElement): string | null => {
    const raw = (a.getAttribute('href') ?? '').split('#')[1]; if (!raw) return null;
    let frag = raw; try { frag = decodeURIComponent(raw); } catch { /* as written */ }
    const target = flow.querySelector<HTMLElement>(`[id="${CSS.escape(frag)}"]`) ?? flow.querySelector<HTMLElement>(`a[name="${CSS.escape(frag)}"]`);
    if (!target || target === a) return null;
    if (!target.id) target.id = `kr-link-${++linkIds}`;
    return target.id;
  };
  flow.addEventListener('dblclick', (e) => {
    if (!document.documentElement.classList.contains('pc')) return;
    const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null; if (!img || !allImages.length || !getSettings().pictureZoom) return;
    const idx = allImages.findIndex((im) => im.anchor === img.id); if (idx >= 0) { e.preventDefault(); document.getSelection()?.removeAllRanges(); showGallery(idx); }
  });
  flow.addEventListener('click', (e) => {
    // A picture first — even one inside a link (books often link their pictures), unless it is a small one in a
    // line of text (a footnote's mark): tapped, it opens on its own, to look closer, save, copy or share.
    const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
    const linkOf = (e.target as HTMLElement).closest('a[data-kr-anchor]') as HTMLElement | null;
    const small = !!img && (img.classList.contains('inline') || img.getBoundingClientRect().width < 64);
    // (On a computer a picture opens with a double-click — a single one is too easily made while reading.)
    if (img && allImages.length && getSettings().pictureZoom && !(linkOf && small) && !document.documentElement.classList.contains('pc')) { const idx = allImages.findIndex((im) => im.anchor === img.id); if (idx >= 0) { e.preventDefault(); showGallery(idx); return; } }
    if ((e.target as HTMLElement).closest('a')) diagLeaveIntent('link', true);
    if (linkOf) { e.preventDefault(); back.remember(); scrollToAnchor(linkOf.dataset.krAnchor!); return; }
    // A link as the book wrote it — a web novel's note (`#fn1`), an empty `#`, a Markdown or HTML book's `#part` or
    // `other.html`: followed, the address's fragment is the app's route (`#fn1` is the library's) and another page
    // of the app starts it again — the book closed under the reader's finger. It goes to its place in the book when
    // the book has one; else nothing happens. (Links to other sites open outside, as before.)
    const own = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
    if (own && staysInApp(own)) {
      e.preventDefault();
      const at = placeOfLink(own);
      if (at) { back.remember(); scrollToAnchor(at); }
      return;
    }
    if ((e.target as HTMLElement).closest('a, button, input, select, mark, .kr-sheet-tabs')) return;
    if (document.getSelection()?.isCollapsed === false) return;
    // Tap zones on touch screens (nine of them, each given its action in the options; by default the lower
    // third turns to the next screen, the upper to the previous, the middle shows or hides the chrome).
    // (On a phone only, where the options offer them: a computer's click — a zone's action synced from the phone
    // included — shows or hides the bars, as ever. src/platform.ts.)
    if (getSettings().tapToTurn && onPhone()) {
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
    // (Day and night swapped with one tap — ReadEra's top-left corner: the chosen theme and the night theme take turns.)
    else if (c === 'dayNight') { const st = getSettings(); const night = st.nightTheme && st.theme === st.nightTheme; updateSettings(night ? { theme: (st.dayTheme as typeof st.theme) || 'light', nightSchedule: false } : { dayTheme: st.theme, theme: st.nightTheme || 'dark', nightSchedule: false }); }
    else if (c === 'nextChapter' || c === 'prevChapter') { if (chapterMode()) { const k = currentUnitIndex(); showUnit(c === 'nextChapter' ? k + 1 : k - 1); } }
    else if (c === 'statusLine') updateSettings({ showStatusLine: !getSettings().showStatusLine });
    else if (c === 'fontUp') updateSettings({ fontSize: Math.min(40, getSettings().fontSize + 1) }); else if (c === 'fontDown') updateSettings({ fontSize: Math.max(12, getSettings().fontSize - 1) });
  };
  document.addEventListener('kr:command', onCommand);
  onDispose(() => document.removeEventListener('kr:command', onCommand));
  // The phone's volume keys and screen edges (Android, as set — src/readkeys.ts): a key turns the page as Space and
  // Shift+Space do (turnPage); sideways swipes turn chapters in the chapter modes, so the edges are kept for them.
  onDispose(readingKeys({ sideways: () => chapterMode(), sounding: () => speaking || (!!aiAudio && !aiAudio.paused), turn: (forward) => turnPage(!forward) }));

  /* ---------- selection tools ---------- */
  onDispose(attachSelectionToolbar(scroll, {
    search: (text) => openSearch(text),
    highlight: (range, text, color) => addHighlight(range, text, color),
    note: (range, text) => addNote(range, text),
    lang: () => currentLocator()?.doc.book.language ?? docs[0]?.book.language,
    speak: (text) => speak([text]),
    textImage: (text, range) => void textImage(text, range),
    // (A rule made from the words: applied at once to the books open — see textrules.)
    glossary: (text) => { const b = currentLocator()?.doc.book ?? docs[0].book; void import('../ui/glossarysheet').then((m) => m.termSheet({ from: text, book: { id: b.id, title: b.title } })); },
    textRule: (text) => { const b = currentLocator()?.doc.book ?? docs[0].book; void import('../ui/textrulesheet').then((m) => m.ruleSheet({ find: text, book: { id: b.id, title: b.title }, made: (r) => { for (const d of docs) if (d.render && (!r.book || r.book === d.book.id)) applyTextRules(d.render.element, d.book.id, [r]); } })); },
  }));

  async function textImage(text: string, range?: Range): Promise<void> {
    const cur = currentLocator();
    const book = cur?.doc.book ?? docs[0].book;
    try {
      const picture = pictureNear(range); const on = pictureOnByDefault(picture);
      const opts = { text, title: book.title, author: book.author, appName: getSettings().snapWatermark ? t('appName') : '', picture: picture ?? undefined, pictureOn: on };
      showSnapshot(await renderTextCanvas(opts), snapName(book.title), book.title, (style, pictureOn) => renderTextCanvas({ ...opts, style, pictureOn: pictureOn ?? on }), { has: !!picture, on });
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
    // (One that runs on into the next chapter is kept with the whole book; an earlier version looks for it there too.)
    const own = chapter?.id && chapter.contains(range.endContainer) ? chapter : null;
    const scope = own ?? doc.render?.element;
    // Which of the places its words have it is, and the text around it — so it comes back here, not at the first.
    const place = scope ? textPlace(scope, range, text) : {};
    const hl: Highlight = { id: uid(), text, anchor: own?.id || undefined, ...place, color, note, ...(note ? { noteAt: Date.now() } : {}), createdAt: Date.now() };
    const marks = wrapRange(range, 'kr-hl', hl.color, hl.id);
    if (note) marks.forEach((m) => { m.title = note; m.classList.add('has-note'); });
    doc.book.highlights = [...(doc.book.highlights ?? []), hl]; scheduleSync();
    await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; });
    if (note) renumberNotes(doc);
    updateSettings({ highlightColor: color });
    if (!note) toast(t('highlight'));
  }

  /** The highlights' marks taken off the text (the text itself as it was), to be put on again. */
  function unmarkHighlights(doc: OpenDoc): void {
    doc.wrapper.querySelectorAll('mark.kr-hl').forEach((m) => m.replaceWith(...m.childNodes));
    doc.wrapper.querySelectorAll('.kr-note-badge').forEach((b) => b.remove());
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
      h('button', { class: 'btn primary small', onclick: async () => { hl.note = ta.value.trim() || undefined; hl.noteAt = stampAfter(hl.noteAt); scheduleSync(); doc.wrapper.querySelectorAll(`mark[data-hl="${id}"]`).forEach((m) => { (m as HTMLElement).title = hl.note ?? ''; m.classList.toggle('has-note', !!hl.note); }); await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; }); renumberNotes(doc); sheet.close(); toast(t('noteSaved')); } }, icon('check'), t('done')));
  }, true);

  function applyHighlights(doc: OpenDoc): void {
    const whole = doc.render?.element;
    if (!whole) return;
    // (A book made a chapter first: the highlights of the chapters made are put on at once, in their own chapter only;
    // the others — and one across chapters — once the whole book is.)
    const part = early?.doc === doc ? early : null;
    for (const hl of doc.book.highlights ?? []) {
      if (part?.applied.has(hl.id)) continue;
      const own = hl.anchor ? document.getElementById(hl.anchor) : null;
      const inOwn = own && whole.contains(own) ? own : null;
      if (part && !part.done) {
        if (!inOwn || inOwn.closest('.kr-shell')) continue;
        const r = findTextRange(inOwn, hl.text, hl);
        if (r) { const marks = wrapRange(r, 'kr-hl', hl.color, hl.id); if (hl.note) marks.forEach((m) => { m.title = hl.note!; m.classList.add('has-note'); }); part.applied.add(hl.id); }
        continue;
      }
      // (Which place it was is counted in its own chapter: elsewhere only the text around it tells.)
      const near = { before: hl.before, after: hl.after };
      let range = findTextRange(inOwn ?? whole, hl.text, inOwn || !hl.anchor ? hl : near);
      // (One across chapters, kept by an earlier version with the chapter it starts in: looked for in the whole book.)
      if (!range && inOwn) range = findTextRange(whole, hl.text, near);
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
    // (Docked on a computer, it is opened again with the next book — until it is closed.)
    try { if (SidePanel.canDock()) localStorage.setItem(DOCK_KEY, tab); } catch { /* private mode */ }
    panel.open(t('contents'), [
      { id: 'toc', label: t('contents'), render: (body) => {
        const cur = currentLocator();
        const curLabel = cur ? labelFor(cur.doc, cur.loc.block ?? 0) : '';
        for (const doc of docs) {
          const ul = h('ul', { class: 'toc-list' });
          if (docs.length > 1) body.append(h('div', { class: 'toc-book', dir: 'auto' }, doc.book.title));
          body.append(h('ul', { class: 'toc-list' }, h('li', null, h('button', { type: 'button', onclick: () => { scrollToAnchor(doc.wrapper.id, false); panel.dismiss(); } }, icon('books'), doc.book.title))));
          const toc = doc.render?.toc ?? [];
          if (!toc.length) body.append(h('p', { style: { color: 'var(--text-dim)', padding: '0 10px', fontSize: '13px' } }, t('noContents')));
          // Each entry's length: minutes at the reader's pace (or a usual one), from the words up to the next entry.
          const speed = trackers.get(doc)?.speed() || 200;
          const starts = toc.map((it) => { const el = document.getElementById(it.anchor); return el ? doc.allBlocks.findIndex((b) => b === el || el.contains(b) || (el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) : -1; });
          const cum: number[] = [0]; for (const b of doc.allBlocks) cum.push(cum[cum.length - 1] + wordCount(b));
          const lengthOf = (i: number) => { const a = starts[i]; if (a < 0) return 0; let j = i + 1; while (j < starts.length && (starts[j] < 0 || starts[j] <= a)) j++; const b = j < starts.length ? starts[j] : doc.allBlocks.length; return Math.round((cum[b] - cum[a]) / speed); };
          toc.forEach((item, i) => { const mins = lengthOf(i); ul.append(h('li', { class: `depth-${Math.min(3, item.depth)}` }, h('button', { type: 'button', class: cur?.doc === doc && item.label === curLabel ? 'current' : '', dir: 'auto', onclick: () => { back.remember(); scrollToAnchor(item.anchor, false); panel.dismiss(); } }, h('span', { class: 'toc-label' }, item.label), mins > 0 ? h('span', { class: 'toc-len' }, getLang() === 'ar' ? `${localDigits(mins)} د` : `${mins} min`) : null))); });
          body.append(ul);
          // (The translation on: each title translated, its original beneath.)
          const labels = toc.map((x) => x.label);
          void translator.titles(doc.book.id, labels).then((tr) => { if (!Object.keys(tr).length) return; ul.querySelectorAll<HTMLElement>('.toc-label').forEach((sp, i) => { const x = tr[labels[i]]; if (!x) return; const both = (getSettings().aiTitles ?? 'both') === 'both'; sp.replaceChildren(h('span', { dir: 'auto' }, x), ...(both ? [h('span', { class: 'toc-orig', dir: 'auto' }, labels[i])] : [])); }); });
        }
        body.querySelector('.current')?.scrollIntoView({ block: 'center' });
      } },
      { id: 'bookmarks', label: t('bookmarks'), render: (body) => {
        const all = docs.flatMap((d) => (d.book.bookmarks ?? []).map((bm) => ({ doc: d, bm }))).sort((a, b) => b.bm.createdAt - a.bm.createdAt);
        if (!all.length) { body.append(h('p', { class: 'center' }, t('noBookmarks'))); return; }
        body.append(h('ul', { class: 'plain-list' }, ...all.map(({ doc, bm }) => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { back.remember(); scrollToLocator(bm.locator); panel.dismiss(); } },
            h('span', { dir: 'auto' }, bm.label), h('span', { class: 'meta', dir: 'auto' }, (docs.length > 1 ? doc.book.title + ' · ' : '') + (bm.excerpt ?? ''))),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(bm.id); doc.book.bookmarks = doc.book.bookmarks.filter((x) => x.id !== bm.id); await db.updateBook(doc.book.id, (b) => { b.bookmarks = doc.book.bookmarks; }); panel.refresh(); } }, icon('trash'))))));
      } },
      { id: 'notes', label: t('notes'), render: (body) => {
        const all = docs.flatMap((d) => (d.book.highlights ?? []).filter((x) => x.note).sort((a, b) => a.createdAt - b.createdAt).map((hl, i) => ({ doc: d, hl, n: i + 1 })));
        if (!all.length) { body.append(h('p', { class: 'center' }, t('noNotes'))); return; }
        body.append(h('ul', { class: 'plain-list' }, ...all.map(({ doc, hl, n }) => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => { const m = doc.wrapper.querySelector(`mark[data-hl="${hl.id}"]`) as HTMLElement | null; if (m) { if (!m.id) m.id = `hl-${hl.id}`; scrollToAnchor(m.id); } panel.dismiss(); } },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(n)), h('span', { dir: 'auto', class: 'meta' }, hl.text.length > 120 ? hl.text.slice(0, 120) + '…' : hl.text)),
            h('span', { dir: 'auto' }, hl.note!)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { hl.note = undefined; hl.noteAt = stampAfter(hl.noteAt); scheduleSync(); doc.wrapper.querySelectorAll(`mark[data-hl="${hl.id}"]`).forEach((m) => { (m as HTMLElement).title = ''; m.classList.remove('has-note'); }); await db.updateBook(doc.book.id, (b) => { b.highlights = doc.book.highlights; }); renumberNotes(doc); panel.refresh(); } }, icon('trash'))))));
      } },
      { id: 'highlights', label: t('highlights'), render: (body) => {
        const all = docs.flatMap((d) => (d.book.highlights ?? []).map((hl) => ({ doc: d, hl }))).sort((a, b) => b.hl.createdAt - a.hl.createdAt);
        if (!all.length) { body.append(h('p', { class: 'center' }, t('noHighlights')));  return; }
        body.append(h('ul', { class: 'plain-list' }, ...all.map(({ doc, hl }) => h('li', null,
          h('button', { type: 'button', style: { flex: '1' }, onclick: () => { const m = doc.wrapper.querySelector(`mark[data-hl="${hl.id}"]`) as HTMLElement | null; if (m) { if (!m.id) m.id = `hl-${hl.id}`; scrollToAnchor(m.id); } panel.dismiss(); } },
            h('mark', { class: 'kr-hl', 'data-color': hl.color, dir: 'auto', style: { fontFamily: 'var(--font-read)' } }, hl.text.length > 160 ? hl.text.slice(0, 160) + '…' : hl.text)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { await removeHighlight(doc, hl.id); panel.refresh(); } }, icon('trash'))))));
      } },
    ], tab, { dock: true });
  }

  /* ---------- search ---------- */
  function clearSearchMarks(): void {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    reg?.delete('kr-search');
    reg?.delete('kr-search-current');
  }
  onDispose(clearSearchMarks);

  // Searching the book. Each chapter's text nodes are gathered once and their search forms (harakat, tatweel
  // and letter variants aside — normalizeForSearch) joined into one string, kept from one search to the next and
  // made ahead in idle moments; a search is then a scan of a few long strings — a book of fifteen million letters
  // in a fraction of a second — run in slices between frames, handing over its hits as it goes, so the page stays
  // live and the first results show at once. A chapter whose text changes (a highlight added) is gathered again.
  // (The nodes of one paragraph are joined as they read — "the <b>quick</b> fox", a word across a highlight's edge,
  // ruby's base without its reading — so a phrase is found across them; a line break marks where one block ends
  // and the next begins, or a <br>, so no phrase is made of the end of one and the start of the next.)
  interface ChapterIndex { nodes: Text[]; brk: Uint8Array; parts: string[]; starts: number[]; next: number; len: number; text: string | null; dirty: boolean }
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
  const INLINE = /^(a|abbr|b|bdi|bdo|big|cite|code|data|del|dfn|em|font|i|ins|kbd|label|mark|q|rb|rtc|ruby|s|samp|small|span|strike|strong|sub|sup|time|tt|u|var)$/;
  /** A chapter's text nodes, and before which of them a block (or a line) begins. */
  function textNodesUnder(el: Element): { nodes: Text[]; brk: Uint8Array } {
    // (Style and script elements are stepped over whole, rather than every text node asking for its ancestors.)
    // (Readings — furigana, pinyin — stepped over too: a search is for the text; and the numbers of the notes'
    // bubbles, which are not the book's.)
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : /^(style|script|rt|rp)$/.test((n as Element).localName) || (n as Element).classList.contains('kr-note-badge') ? NodeFilter.FILTER_REJECT : (n as Element).localName === 'br' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const nodes: Text[] = []; const brk: number[] = []; let node: Node | null;
    let lastParent: Element | null = null, lastBlock: Element | null = null, lineBreak = false;
    while ((node = walker.nextNode())) {
      if (node.nodeType !== Node.TEXT_NODE) { lineBreak = true; continue; }
      const parent = node.parentElement;
      let block: Element | null = lastBlock;
      if (parent !== lastParent) { block = parent; while (block && block !== el && INLINE.test(block.localName)) block = block.parentElement; lastParent = parent; }
      brk.push(nodes.length && (lineBreak || block !== lastBlock) ? 1 : 0);
      nodes.push(node as Text); lastBlock = block; lineBreak = false;
    }
    return { nodes, brk: Uint8Array.from(brk) };
  }
  /** The index of a chapter, built as far as `until` allows (null when more remains; call again). */
  function chapterIndex(el: Element, until = Infinity): ChapterIndex | null {
    let ix = chapterIndexes.get(el);
    if (!ix || ix.dirty) { const { nodes, brk } = textNodesUnder(el); ix = { nodes, brk, parts: [], starts: [], next: 0, len: 0, text: null, dirty: false }; chapterIndexes.set(el, ix); }
    if (ix.text !== null) return ix;
    for (; ix.next < ix.nodes.length; ix.next++) {
      if ((ix.next & 31) === 0 && performance.now() > until) return null;
      const form = searchFormOf(ix.nodes[ix.next].data);
      if (ix.brk[ix.next]) { ix.parts.push('\n'); ix.len++; }
      ix.starts.push(ix.len); ix.parts.push(form); ix.len += form.length;
    }
    ix.text = ix.parts.join('');
    return ix;
  }
  const yieldToPage = (): Promise<void> => new Promise((r) => { const sch = (window as Window & { scheduler?: { yield?(): Promise<void> } }).scheduler; if (sch?.yield) void sch.yield().then(r); else setTimeout(r, 0); });
  /** Run `query` through the book, calling `onHits` with each slice's hits; resolves to all of them. */
  /** The search across languages (a book translated, wholly or in part): each paragraph's original and its
   *  translation looked through — one, the other or both, as chosen. */
  async function searchPairs(query: string, mode: 'both' | 'orig' | 'tr', onHits?: (hits: PairHit[]) => void, live?: () => boolean): Promise<PairHit[]> {
    const q = normalizeForSearch(query.trim()).text; const hits: PairHit[] = []; if (!q) return hits;
    await translator.load(docs.map((d) => d.book.id));
    const find = (text: string): [number, number] | null => { const n = normalizeForSearch(text); const at = n.text.indexOf(q); if (at < 0) return null; return [n.map[at], n.map[Math.min(n.map.length - 1, at + q.length)]]; };
    let since = performance.now();
    for (const doc of docs) {
      const all = doc.allBlocks.length ? doc.allBlocks : doc.blocks; let batch: PairHit[] = [];
      for (let bi = 0; bi < all.length && hits.length < 500; bi++) {
        const block = all[bi]; if (block.tagName === 'IMG') continue;
        const p = translator.pairOf(block, doc.book.id); if (!p.orig) continue;
        const inOrig = mode !== 'tr' ? find(p.orig) : null; const inTr = mode !== 'orig' && p.tr ? find(p.tr) : null;
        if (!inOrig && !inTr) continue;
        const hit: PairHit = { bookId: doc.book.id, label: labelFor(doc, bi), pct: all.length ? (bi / all.length) * 100 : 0, block, orig: p.orig, tr: p.tr, inOrig, inTr };
        hits.push(hit); batch.push(hit);
        if (performance.now() - since > 12) { if (batch.length) { onHits?.(batch); batch = []; } await yieldToPage(); since = performance.now(); if (live && !live()) return hits; }
      }
      if (batch.length) onHits?.(batch);
    }
    return hits;
  }
  function goToPair(hit: PairHit): void {
    back.remember(); revealElement(hit.block);
    requestAnimationFrame(() => { const sr = scroll.getBoundingClientRect(); const r = hit.block.getBoundingClientRect(); scroll.scrollTop += r.top - sr.top - sr.height * 0.3; hit.block.classList.add('kr-flash'); setTimeout(() => hit.block.classList.remove('kr-flash'), 1600); scheduleSave(); });
  }
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
          // The nodes the hit begins and ends in: the last ones starting at or before its first and last letters
          // (a hit may run on from one node into the next — across a bold word, a link, a highlight's edge).
          const nodeAt = (pos: number) => { let lo = 0, hi = ix!.starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ix!.starts[m] <= pos) lo = m; else hi = m - 1; } return lo; };
          const a = nodeAt(at), b = nodeAt(at + q.text.length - 1);
          const startNode = ix.nodes[a], endNode = ix.nodes[b];
          if (!startNode.isConnected || !endNode.isConnected) continue;
          const normOf = (k: number) => { let n = maps.get(k); if (!n) { n = normalizeForSearch(ix!.nodes[k].data); maps.set(k, n); } return n; };
          const sNorm = normOf(a), eNorm = normOf(b);
          const s = sNorm.map[Math.min(sNorm.map.length - 1, at - ix.starts[a])], e = eNorm.map[Math.min(eNorm.map.length - 1, at + q.text.length - ix.starts[b])];
          const range = document.createRange(); range.setStart(startNode, s); range.setEnd(endNode, e); ranges.push(range);
          // (The words around it, from the same paragraph.)
          let match = a === b ? startNode.data.slice(s, e) : startNode.data.slice(s);
          for (let k = a + 1; k <= b; k++) match += k === b ? endNode.data.slice(0, e) : ix.nodes[k].data;
          let before = startNode.data.slice(0, s); for (let k = a; k > 0 && !ix.brk[k] && before.length < 60; k--) before = ix.nodes[k - 1].data + before;
          let after = endNode.data.slice(e); for (let k = b + 1; k < ix.nodes.length && !ix.brk[k] && after.length < 60; k++) after += ix.nodes[k].data;
          const block = startNode.parentElement?.closest(BLOCK_SELECTOR) as HTMLElement | null;
          const bi = block ? Math.max(0, blockIndexOf(doc, block)) : 0;
          const hit = { bookId: doc.book.id, label: labelFor(doc, bi), pct: all.length ? (bi / all.length) * 100 : 0, before: before.slice(-60), match, after: after.slice(0, 60), range };
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

  let lastFlowQ = '';
  function openSearch(initial = ''): void {
    if (!initial && searchKeep() && lastFlowQ) initial = lastFlowQ;
    panel.open(t('searchInBook'), [{ id: 'search', label: t('search'), render: (body) => {
      const input = h('input', { type: 'search', placeholder: t('searchPlaceholder'), value: initial, 'aria-label': t('searchInBook'), style: { width: '100%' } }) as HTMLInputElement;
      const count = h('div', { style: { color: 'var(--text-dim)', fontSize: '13px', margin: '10px 0' } });
      const list = h('ul', { class: 'plain-list' });
      // (A book translated, wholly or in part: the search can look in the original, the translation, or both —
      // each hit shown with the original above and the translation under it.)
      let langMode: 'both' | 'orig' | 'tr' | null = null;
      const langs = h('div', { class: 'segmented small search-langs', role: 'radiogroup', hidden: true });
      const drawLangs = () => { const tg = (() => { try { return new Intl.DisplayNames([getLang()], { type: 'language' }).of(translator.target()) ?? translator.target(); } catch { return translator.target(); } })();
        langs.replaceChildren(...([['both', t('searchBothLangs')], ['orig', t('searchOriginal')], ['tr', tg]] as ['both' | 'orig' | 'tr', string][]).map(([k, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(langMode === k), onclick: () => { langMode = k; try { localStorage.setItem('kr.searchLang', k); } catch { /* */ } drawLangs(); void run(); } }, l))); };
      void translator.hasTranslations(docs.map((d) => d.book.id)).then((yes) => { if (!yes) return; langMode = (localStorage.getItem('kr.searchLang') as 'both' | null) ?? 'both'; langs.hidden = false; drawLangs(); if (input.value.trim().length >= 2) void run(); });
      body.append(input, keepToggle(() => { lastFlowQ = ''; }), langs, count, list);
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
        const q = input.value.trim(); const id = ++runId; lastFlowQ = q;
        if (q.length < 2) { count.textContent = ''; more.hidden = true; return; }
        count.textContent = t('searching');
        const show = (hits: SearchHit[]) => {
          if (id !== runId) return;
          pending.push(...hits); n += hits.length;
          if (list.children.length - 1 < PAGE) flushRows(PAGE - (list.children.length - 1));
          else more.hidden = false;
          count.textContent = `${t('resultsCount', { n })}…`;
        };
        if (langMode) {
          const piece = (text: string, at: [number, number] | null, cls: string) => { if (!at) return h('span', { class: cls, dir: 'auto' }, text.length > 160 ? `${text.slice(0, 160)}…` : text); const [s0, e0] = at; return h('span', { class: cls, dir: 'auto' }, (s0 > 70 ? '…' : '') + text.slice(Math.max(0, s0 - 70), s0), h('mark', null, text.slice(s0, e0)), text.slice(e0, e0 + 90) + (e0 + 90 < text.length ? '…' : '')); };
          const prow = (hit: PairHit) => h('li', { class: 'hit pair-hit' }, h('button', { type: 'button', style: { flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { if (window.innerWidth < 900) panel.dismiss(); goToPair(hit); } },
            h('span', { class: 'meta', dir: 'auto' }, hit.label, h('b', { class: 'hit-pct' }, localDigits(hit.pct.toFixed(1)) + '%')),
            piece(hit.orig, hit.inOrig, 'ctx orig'), hit.tr ? piece(hit.tr, hit.inTr, 'ctx trl') : h('span', { class: 'ctx trl none' }, t('searchNotTranslated'))));
          let m = 0; const hits2 = await searchPairs(q, langMode, (hs) => { if (id !== runId) return; m += hs.length; more.before(...hs.slice(0, Math.max(0, 300 - list.children.length)).map(prow)); count.textContent = `${t('resultsCount', { n: m })}…`; }, () => id === runId);
          if (id !== runId) return;
          count.textContent = hits2.length ? t('resultsCount', { n: hits2.length }) : t('noResults'); return;
        }
        const hits = await searchFlow(q, show, () => id === runId);
        if (id !== runId) return;
        count.textContent = hits.length ? t('resultsCount', { n: hits.length }) : t('noResults');
        noteMissing();
      };
      // (A novel from an extension searches the chapters on the device: those still on the site are said, and
      // fetched on a tap — then the search runs again over the whole book.)
      const missingNote = h('div', { class: 'search-missing', hidden: true });
      body.insertBefore(missingNote, list);
      const noteMissing = () => {
        const nv = docs.find((d) => d.book.format === 'webnovel' && d.render?.element.querySelector('.kr-chap.pending'));
        if (!nv) { missingNote.hidden = true; return; }
        const left = nv.render!.element.querySelectorAll('.kr-chap.pending').length;
        const go = h('button', { type: 'button', class: 'btn tonal small' }, icon('download'), t('searchFetchRest')) as HTMLButtonElement;
        go.addEventListener('click', async () => {
          go.disabled = true;
          try {
            const { downloadNovel } = await import('../sources/ext/source');
            await downloadNovel(nv.book, (d, tot) => { go.replaceChildren(icon('download'), `${localDigits(d)} / ${localDigits(tot)}`); }, () => reader.isConnected);
          } catch (e) { toast(String((e as Error)?.message ?? e), 'error'); }
          const fresh = await db.getBook(nv.book.id); if (fresh) nv.book = fresh;
          root.dispatchEvent(new Event('kr-rerender'));
          setTimeout(() => void run(), 600);
        });
        missingNote.replaceChildren(h('span', { class: 'src' }, t('searchChaptersLeft', { n: localDigits(left) })), go);
        missingNote.hidden = false;
      };
      input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void run(), 200); });
      if (initial) void run();
      // (Opened again with the last search in it: the caret after the words, so what is typed next follows them —
      // it stood before them, and new letters went in front.)
      setTimeout(() => { input.focus(); try { const n = input.value.length; input.setSelectionRange(n, n); } catch { /* a field that has no selection */ } }, 50);
    } }], undefined, { dock: true });
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
    // (A novel from an extension: the pictures of the chapters on the device — the rest found by fetching them.)
    const nv = startAt === undefined ? docs.find((d) => d.book.format === 'webnovel' && d.render?.element.querySelector('.kr-chap.pending')) : undefined;
    const left = nv ? nv.render!.element.querySelectorAll('.kr-chap.pending').length : 0;
    const note = nv ? { text: t('galleryChaptersLeft', { n: localDigits(left) }), action: { label: t('galleryFetchRest'), run: async (say: (text: string) => void) => {
      const { downloadNovel } = await import('../sources/ext/source');
      await downloadNovel(nv.book, (d, tot) => say(t('fetchingChapters', { n: localDigits(d), total: localDigits(tot) })), () => reader.isConnected);
      const fresh = await db.getBook(nv.book.id); if (fresh) nv.book = fresh;
      close();
      root.dispatchEvent(new Event('kr-rerender'));
      setTimeout(() => showGallery(), 900);
    } } } : undefined;
    const close = openGallery(allImages, (anchor) => scrollToAnchor(anchor), { startAt, lightboxOnly: startAt !== undefined, note });
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
    speaking = true; refreshReadingKeys();
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
    // (Android, the device's voice, reading on from a place in the book: the passages handed to the device in
    // batches, read in turn by the app itself — on with the screen off, under a media notification.)
    const eng0 = getSettings().speechEngine;
    const madeAudio = (eng0 === 'ai' && aiTtsSupported() && aiReady()) || (eng0 === 'kitten' && kittenReady());
    if (queueSpeech() && !chunks.length && startBlock && !madeAudio) { speakQueued(startBlock, scopeEnd); return; }
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
  /** Reading on from a block through the device's own queue: a batch of passages now, more as it nears their
   *  end; the passage being read shown and marked as it starts (when the page is awake to see it). */
  function speakQueued(startBlock: { doc: OpenDoc; index: number }, scopeEnd: number): void {
    const doc = startBlock.doc;
    const last = scopeEnd === Infinity ? doc.allBlocks.length - 1 : Math.min(doc.allBlocks.length - 1, startBlock.index + scopeEnd);
    let nextIdx = startBlock.index;
    const batch = () => {
      const items: { id: string; text: string; lang: string }[] = []; let n = 0;
      while (nextIdx <= last && n < 120) {
        const idx = nextIdx++; const block = doc.allBlocks[idx]; if (!block) break;
        const text = plainText(block).replace(/\s+/g, ' ').trim();
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        speechPieces(text).forEach((p, k) => items.push({ id: `${idx}.${k}`, text: p, lang: speechLangOf(p, doc.book.language) }));
        n++;
      }
      return items;
    };
    const opts = () => ({ rate: getSettings().speechRate, preferred: getSettings().speechVoice || undefined, title: doc.book.title });
    const more = () => { const items = batch(); if (items.length) void speakQueue(items, { ...opts(), append: true }); return items.length; };
    let shown = -1;
    const on = {
      start: (id: string) => {
        if (!speaking) return;
        const bi = Number(id.split('.')[0]); const block = doc.allBlocks[bi];
        if (block && bi !== shown) {
          shown = bi;
          revealElement(block);
          const sr = scroll.getBoundingClientRect(); const r = block.getBoundingClientRect();
          if (r.bottom > sr.bottom || r.top < sr.top) scroll.scrollTop += r.top - sr.top - 40;
          block.classList.add('kr-flash'); setTimeout(() => block.classList.remove('kr-flash'), 1200);
        }
        // (Topped up well before the end: a page asleep cannot hand the next batch over in time.)
        if (bi >= nextIdx - 40 && nextIdx <= last) more();
      },
      end: () => { if (!speaking) return; if (nextIdx > last || !more()) { stopSpeaking(); if (scopeEnd !== Infinity) toast(t('chapterReadDone')); } },
      stopped: () => { speaking = false; keepAwake(getSettings().keepAwake); refreshReadingKeys(); },
    };
    const first = batch();
    if (!first.length) { stopSpeaking(); return; }
    void speakQueue(first, { ...opts(), on }).then((r) => { if (r !== 'ok' && speaking) noVoice(first[0].lang, 'unavailable'); });
  }
  function stopSpeaking(): void { speaking = false; keepAwake(getSettings().keepAwake); stopSpeech(); if (aiAudio) { aiAudio.pause(); aiAudio = null; } refreshReadingKeys(); }
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
      // (What the reader placed in «More», and what the bars had no room for; «Customise buttons» always last.)
      body.append(moreList('flow', bars.moreIds(), actions, () => panel.close(), () => buttonSheet('flow')));
      if (fits('computer')) body.append(h('p', { class: 'shortcuts-hint' }, icon('keyboard'), ' ', t('shortcutsBody')));
    } }]);
  }

  /* ---------- keyboard ---------- */
  /** A screen on, or back (Space and Shift+Space, PageDown, the computer's arrows): at a chapter's end, the next one. */
  function turnPage(back: boolean): void {
    const page = scroll.clientHeight * 0.9;
    // (Both chapter modes: a page-turn key — or a volume button, src/readkeys.ts — at a chapter's very end goes on to the
    // next, as a swipe does; only scrolling past the end is the "scroll into the next chapter" mode's own.)
    if (chapterMode()) { const k = currentUnitIndex(); if (!back && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2 && units()[k + 1]) { showUnit(k + 1); return; } if (back && scroll.scrollTop <= 1 && units()[k - 1]) { showUnit(k - 1, true); return; } }
    scroll.scrollBy({ top: back ? -page : page, behavior: 'smooth' });
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { if (panel.isOpen) panel.close(); else if (autoScrollRaf) stopAutoScroll(); else if (speaking) stopSpeaking(); else void leaveFullscreen(root); return; }
    if ((e.target as HTMLElement).matches('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowLeft': { if (!chapterMode()) return; const rtl = docs.find((d) => !d.wrapper.hidden)?.render?.rtl ?? false; const fwd = (e.key === 'ArrowRight') !== rtl; const k = currentUnitIndex(); showUnit(fwd ? k + 1 : k - 1, !fwd); break; }
      case 'j': case 'ArrowDown': scroll.scrollBy({ top: 80 }); break;
      case 'k': case 'ArrowUp': scroll.scrollBy({ top: -80 }); break;
      case ' ': case 'PageDown': { e.preventDefault(); turnPage(e.shiftKey); break; }
      case 'PageUp': { e.preventDefault(); turnPage(true); break; }
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

async function mountPdf(root: HTMLElement, book: Book, onDispose: (fn: () => void) => void, gone: () => boolean = () => false, op?: DiagOpen): Promise<void> {
  const file = await db.getFile(book.id);
  if (gone()) return;
  if (!file) { op?.failed('file missing'); diagLeaveIntent('missing'); toast(t(book.source ? 'linkedFileMissing' : 'openError', { title: book.title, error: '' }), 'error', 5000); navigate('/', true); return; }
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
  const goForm = () => h('form', { style: { display: 'flex', gap: '6px', alignItems: 'center' }, onsubmit: (e: Event) => { e.preventDefault(); const n = Number(pageInput.value); if (n) viewer.goTo(n); pageInput.blur(); } }, pageInput, h('button', { class: 'btn small', type: 'submit' }, t('go')));
  const barNav = h('div', { class: 'pdf-bar-nav' },
    iconButton('chevronLeft', t('previousPage'), () => viewer.goTo(viewer.current - 1)),
    slider,
    iconButton('chevronRight', t('nextPage'), () => viewer.goTo(viewer.current + 1)),
    count);
  // (Its tools are the buttons the reader placed on it — src/readbuttons.ts, drawn by mountBars below.)
  const barTools = h('div', { class: 'pdf-bar-tools' });
  const bar = h('div', { class: 'pdf-bar', dataset: { layout: barLayout() } }, barNav, barTools);
  const relayout = () => { const s = getSettings(); bar.dataset.layout = barLayout(); bar.dataset.side = s.pdfBarSide; bar.dataset.row = s.pdfBarRow; bar.dataset.look = s.pdfBarLook === 'docked' ? 'docked' : 'pill'; };
  relayout();
  onDispose(onSettingsChange(relayout)); portrait.addEventListener('change', relayout); onDispose(() => portrait.removeEventListener('change', relayout));
  const backBtn = iconButton('back', t('back'), () => { diagLeaveIntent('top-back', true); if (leaveToCaller(book.id)) return; void import('./book').then((m) => goBackView(m.wantsBookPage(book) ? `/book/${book.id}` : '/')); });
  const moreBtn = iconButton('more', t('more'), () => openMore());
  const topbar = h('header', { class: 'topbar' }, backBtn, title, moreBtn);
  // Every action of a PDF (src/readbuttons.ts PDF_ACTIONS), wherever the reader has put it — or nowhere (its key still
  // does it: onKey).
  const goToPage = async () => {
    if (pageInput.isConnected && pageInput.getClientRects().length && !bar.hidden) { pageInput.focus(); return; }
    const v = await askText({ title: t('goToPage'), label: t('page'), ok: t('go'), cancel: t('cancel'), numeric: true, value: String(viewer.current) });
    const n = Number(String(v ?? '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))); if (n) viewer.goTo(n);
  };
  const actions: Record<string, ActionRun> = {
    pageNav: { run: () => undefined },
    search: { run: () => openSearch() },
    toc: { run: () => openContents('toc') },
    grid: { run: () => showPagesGrid() },
    goToPage: { run: () => void goToPage(), bar: goForm },
    zoomOut: { run: () => viewer.zoom(-0.15) },
    zoomIn: { run: () => viewer.zoom(0.15) },
    fitWidth: { run: () => viewer.fitToWidth() },
    ink: { run: () => ink?.setOn(!ink.on) },
    pageStrip: { run: () => strip?.toggle() },
    info: { run: () => showInfo() },
    exportNotes: { run: () => void exportNotes(book) },
    exportAnki: { run: () => void exportNotesAnki(book) },
    shareFile: { run: () => void shareBooks([book.id]) },
    convertFile: { run: () => void import('../ui/convert').then((m) => m.convertSheet(book)) },
    savePageImage: { run: () => void savePage(false) },
    sharePage: { run: () => void savePage(true) },
    copyPageImage: { run: () => void savePage('copy') },
    cutPagePart: { run: () => void import('../ui/pdfsnap').then((m) => m.cutPagePart(viewer, book, snapName(book.title))) },
    savePagesRange: { run: () => savePagesSheet() },
    exportWithInk: { run: () => void exportWithInk(), available: () => (book.ink ?? []).length > 0 },
    print: { run: () => void printBook() },
    openWithApp: { run: () => void openWithApp(), available: () => fits('android') },
    toolExtract: { run: () => void import('../ui/pdftools').then((m) => m.extractFromBook(book)) },
    pdfTools: { run: () => void import('../ui/pdftools').then(async (m) => m.pdfToolsSheet(await db.allBooks(), book)) },
    bookmark: { run: () => void addBookmark() },
    noteOnPage: { run: () => placeNote() },
    highlights: { run: () => openContents('notes') },
    crop: { run: () => updateSettings({ pdfAutoCrop: !getSettings().pdfAutoCrop }), label: () => (getSettings().pdfAutoCrop ? t('cropMarginsOff') : t('cropMargins')) },
    readInOrder: { run: () => void import('../ui/queue').then((m) => m.queueSheet(getQueue().length ? getQueue() : [book.id], { onChange: () => void findNextPdf() })) },
    favorite: { run: () => void toggleFavorite(book), label: () => (book.tags?.includes(FAV_TAG) ? t('unfavorite') : t('favorite')), icon: () => (book.tags?.includes(FAV_TAG) ? 'heartFill' : 'heart') },
    type: { run: () => openPdfOptions() },
    readingBar: { run: () => updateSettings({ showStatusLine: !getSettings().showStatusLine }), label: () => (getSettings().showStatusLine ? t('hideReadingBar') : t('showReadingBar')) },
    dayNight: { run: () => { const st = getSettings(); const night = st.nightTheme && st.theme === st.nightTheme; updateSettings(night ? { theme: (st.dayTheme as typeof st.theme) || 'light', nightSchedule: false } : { dayTheme: st.theme, theme: st.nightTheme || 'dark', nightSchedule: false }); } },
    fullscreen: { run: () => { void toggleFullscreen(root); } },
    bookmarks: { run: () => openContents('bookmarks') },
  };
  const bars = mountBars({ kind: 'pdf', root, topbar, back: backBtn, title, toolbar: barTools, toolbarBox: bar, keepRoom: () => (bar.dataset.layout === 'row' ? [barNav] : []), more: moreBtn, actions,
    onNav: (on) => { barNav.hidden = on ? false : true; },
    after: ({ toolbarEmpty }) => { barTools.hidden = toolbarEmpty; bar.hidden = toolbarEmpty && barNav.hidden; } });
  bars.render();
  { const redo = () => bars.render(); onDispose(onSettingsChange(redo)); portrait.addEventListener('change', redo); onDispose(() => portrait.removeEventListener('change', redo)); }
  onDispose(() => bars.dispose());
  const syncComfort = () => {
    const st = getComputedStyle(reader); const warm = st.getPropertyValue('--r-warmth').trim(), dim = st.getPropertyValue('--r-dim-overlay').trim();
    root.style.setProperty('--r-warmth', warm); root.style.setProperty('--r-dim-overlay', dim);
    const el = root.querySelector<HTMLElement>('.reader-comfort'); if (el) { el.hidden = !(Number(warm) > 0 || Number(dim) > 0); el.dataset.warm = Number(warm) > 0 ? '1' : '0'; }
  };
  queueMicrotask(syncComfort);
  // The reading bar (src/ui/readbar.ts): a PDF's pages are its own — the page in the book, and in its chapter where
  // the PDF has an outline (the chapters are its top entries).
  const readBar = createReadBar(root, onDispose);
  root.classList.add('pdf-reader');
  let parts: { page: number; label: string }[] = [];
  const paintBar = () => {
    const page = viewer?.current ?? 0, total = viewer?.total ?? 0; if (!total) return;
    const v: import('../ui/readbar').BarValues = { title: book.title, bookPage: page, bookPages: total, bookPct: Math.round((page / total) * 100) };
    let i = -1; for (let k = 0; k < parts.length && parts[k].page <= page; k++) i = k;
    const start = i >= 0 ? parts[i].page : 1, end = i >= 0 ? (parts[i + 1]?.page ?? total + 1) - 1 : total;
    v.chapter = i >= 0 ? parts[i].label : ''; v.page = page - start + 1; v.pages = Math.max(v.page, end - start + 1);
    v.chapterPct = v.pages > 1 ? Math.round(((v.page - 1) / (v.pages - 1)) * 100) : 100;
    readBar.set(v);
  };
  root.append(topbar, reader, bar, readBar.el, h('div', { class: 'reader-comfort', 'aria-hidden': 'true' }), h('div', { class: 'center', id: 'kr-loading' }, h('div', { class: 'spinner' }), t('loading')));
  syncChrome();
  // The pages end above the page bar lying at the foot, and begin below one at the top (its room measured: --pb-room —
  // reader.css [data-pb]); a docked bar down a side keeps them clear of it always, shown or hidden, so they are not
  // fitted again when the chrome hides. (A floating bar down a side — a phone's — stays over the pages' edge.)
  {
    const room = () => {
      const lay = bar.dataset.layout, look = bar.dataset.look === 'docked' ? 'docked' : 'pill';
      const at = bar.hidden ? 'none' : lay === 'side' ? (look === 'docked' ? 'side' : 'none') : bar.dataset.row === 'top' ? 'top' : 'bottom';
      if (root.dataset.pb !== at) root.dataset.pb = at;
      if (root.dataset.pblook !== look) root.dataset.pblook = look;
      const side = bar.dataset.side ?? 'right'; if (root.dataset.pbside !== side) root.dataset.pbside = side;
      if (at === 'none' || root.classList.contains('immersive')) return;
      // (Where the bar stands, its slide in and out aside — a fixed element's offsets do not count its transform.)
      const parent = bar.offsetParent as HTMLElement | null; const pr = parent?.getBoundingClientRect(); const rr = root.getBoundingClientRect();
      const top = bar.offsetTop + (pr ? pr.top + (parent?.clientTop ?? 0) : 0), hgt = bar.offsetHeight, wid = bar.offsetWidth;
      if (!hgt || !wid) return;
      const px = at === 'bottom' ? rr.bottom - top + (look === 'docked' ? 0 : 8) : at === 'top' ? top - rr.top + hgt + (look === 'docked' ? 4 : 8) : wid;
      const v = `${Math.max(0, Math.round(px))}px`; if (root.style.getPropertyValue('--pb-room') !== v) root.style.setProperty('--pb-room', v);
    };
    const obs = new ResizeObserver(() => room()); obs.observe(bar); obs.observe(root);
    const mo = new MutationObserver(() => room()); mo.observe(bar, { attributes: true, attributeFilter: ['hidden', 'data-layout', 'data-row', 'data-look', 'data-side'] });
    mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    onDispose(() => { obs.disconnect(); mo.disconnect(); });
    room();
  }

  const openPdfOptions = () => panel.open(t('visualOptions'), [{ id: 'o', label: t('visualOptions'), render: (b) => renderOptions(b, { pdf: true }) }]);
  let saveTimer: number | undefined;
  let placed = false; // the saved place put back (until then, the page shown is not one to save)
  /** The place saved now (left, hidden, or a moment after a page turn). */
  const savePlace = (sync = true) => {
    window.clearTimeout(saveTimer); saveTimer = undefined;
    if (!placed || !viewer.total) return;
    const loc: Locator = { bookId: book.id, page: viewer.current, offset: viewer.currentOffset(), pct: viewer.total ? viewer.current / viewer.total : 0 };
    book.progress = loc; void db.updateBook(book.id, (b) => { b.progress = loc; b.progressAt = stampAfter(b.progressAt); });
    if (sync) scheduleSync();
  };
  viewer = new PdfViewer({
    container: reader,
    invert: getSettings().pdfInvert,
    crop: { enabled: () => getSettings().pdfAutoCrop, get: () => db.getMeta<unknown>(`crop:${book.id}`).then((v) => v ?? null), set: (store) => db.setMeta(`crop:${book.id}`, store) },
    onPageRender: (n) => { op?.shown(); renderHighlights(n); ink?.render(n); strip?.sync(); },
    onPageChange: (page, total) => {
      slider.max = String(total); slider.value = String(page); pageInput.max = String(total); pageInput.placeholder = String(page);
      count.textContent = t('pageOf', { n: page, total });
      paintBar();
      if (page >= total && total > 1) offerNextPdf();
      window.clearTimeout(saveTimer);
      // (Not before the place has been put back: the first page shown while the book opens is not a place read.)
      if (placed) saveTimer = window.setTimeout(() => savePlace(), 600);
    },
  });
  slider.addEventListener('input', () => viewer.goTo(Number(slider.value)));
  let nextVolPdf: Book | null = null; let nextPillPdf: HTMLElement | null = null; let queuedPdf = false;
  const findNextPdf = () => nextQueued(book.id).then(async (q) => { if (q) { nextVolPdf = q; queuedPdf = true; return; } queuedPdf = false; nextVolPdf = nextVolume(book, await db.allBooks()); }).catch(() => undefined);
  void findNextPdf();
  const offerNextPdf = () => { if (!nextVolPdf || nextPillPdf) return; const next = nextVolPdf; nextPillPdf = h('button', { type: 'button', class: 'jump-back next-volume', onclick: () => { diagLeaveIntent('next-book'); navigate(`/read/${next.id}`); } }, h('span', { dir: 'auto' }, `${queuedPdf ? t('nextInOrder') : t('nextVolume')}: ${next.title}`), icon('arrowRight')); root.appendChild(nextPillPdf); };
  onDispose(overscrollNext(viewer.scroll, () => (queuedPdf && nextVolPdf ? nextVolPdf.id : null)));
  const back = jumpBack(root, (loc) => { const l = loc as { page: number; offset: number }; viewer.goTo(l.page, l.offset); }, () => ({ page: viewer.current, offset: viewer.currentOffset() }), viewer.scroll);
  onDispose(back.dispose);
  viewer.pinchZoom = getSettings().pdfPinchZoom;
  (window as unknown as { __krPdfViewer?: unknown }).__krPdfViewer = viewer; // (for tests)
  viewer.root.dataset.pagenums = String(getSettings().pdfPageNumbers);
  onDispose(onSettingsChange((st) => { viewer.pinchZoom = st.pdfPinchZoom; viewer.root.dataset.pagenums = String(st.pdfPageNumbers); viewer.setCrop(st.pdfAutoCrop); }));
  op?.size('bytes', file.size);
  await viewer.load(file, book.id, book.source?.uri);
  if (gone()) { viewer.destroy(); return; }
  op?.size('pages', viewer.total);
  // (The outline read once for the bar: its top entries with a page, in page order — all entries when it has one top.)
  void viewer.outline().then((o) => {
    const withPage = o.filter((x) => x.page && x.page > 0); const top = withPage.filter((x) => x.depth === 0);
    parts = (top.length > 1 ? top : withPage).map((x) => ({ page: x.page!, label: x.label })).sort((a, b) => a.page - b.page);
    paintBar();
  }).catch(() => undefined);
  root.querySelector('#kr-loading')?.remove();
  void touchBook(book.id);
  const jump = takeJump();
  if (jump?.kind === 'bm') { const bm = book.bookmarks.find((x) => x.id === jump.id); if (bm) viewer.goTo(bm.locator.page ?? 1, bm.locator.offset ?? 0); }
  else if (jump?.kind === 'pin') { const pin = (book.pins ?? []).find((x) => x.id === jump.id); if (pin) viewer.goTo(pin.page, Math.max(0, pin.y - 0.1)); }
  else if (jump?.kind === 'hl') { const hl = (book.pdfHighlights ?? []).find((x) => x.id === jump.id); if (hl) viewer.goTo(hl.page, Math.max(0, (hl.rects[0]?.[1] ?? 0) - 0.1)); }
  else if (book.progress?.page) viewer.goTo(book.progress.page, book.progress.offset ?? 0);
  placed = true; op?.placed();
  // Opened from a search across books: at the found page, the words marked.
  { const sj = takeSearchJump(book.id); if (sj) void viewer.highlightOnPage(sj.unit + 1, sj.q); }
  // (Left within a moment of a page turn or a scroll: the place saved as it is left, while the pages are still there.)
  onDispose(() => savePlace());
  onDispose(() => viewer.destroy());
  // The pages' text, read once and kept (from an earlier reading, or now, in idle moments), for quick searching.
  // (Read on from where an earlier opening got to, the pages read kept as it goes: a long PDF left before the end was
  // read from its first page again at every opening, and never finished.)
  setTimeout(() => void storedPages(book).then(async (stored) => {
    if (stored) { viewer.seedTexts(stored); return; }
    const from = await partialPages(book);
    if (gone()) return;
    void viewer.readAllWhenIdle((all) => void storePages(book, all), { from, save: (texts) => void storePartialPages(book, texts) });
  }), 3000);
  onDispose(onSettingsChange((s) => { applySettings(reader, s); syncChrome(); syncComfort(); viewer.setInvert(s.pdfInvert); }));
  // "Speak" (selected words): the device's voice, or KittenTTS's audio — held, so a new "Speak" or the book closed
  // stops it (it went on talking in the library).
  let pdfAudio: HTMLAudioElement | null = null; let speechTurn = 0;
  // (While the device's voice reads the words: the volume keys keep to the volume — src/readkeys.ts.)
  let pdfVoice = false;
  const voiceDone = (turn: number) => { if (turn === speechTurn) { pdfVoice = false; refreshReadingKeys(); } };
  function stopPdfSpeech(): void {
    speechTurn++; stopSpeech();
    if (pdfAudio) { pdfAudio.pause(); URL.revokeObjectURL(pdfAudio.src); pdfAudio = null; }
    pdfVoice = false; refreshReadingKeys();
  }
  onDispose(stopPdfSpeech);
  onDispose(attachSelectionToolbar(reader, {
    search: (text) => openSearch(text),
    highlight: (range, text, color) => addPdfHighlight(range, text, color),
    note: (range, text) => addPdfNote(range, text),
    speak: (text) => {
      stopPdfSpeech();
      const lang = speechLangOf(text, book.language);
      if (getSettings().speechEngine === 'kitten' && kittenReady() && kittenCanRead(text)) {
        const turn = speechTurn;
        void kittenSpeak(text.replace(/\s+/g, ' ').trim()).then((b) => {
          // (Stopped, spoken again or the book closed while the voice was being made: not played.)
          if (turn !== speechTurn) return;
          const url = URL.createObjectURL(b); const a = new Audio(url); pdfAudio = a;
          a.playbackRate = getSettings().speechRate;
          a.onended = () => { URL.revokeObjectURL(url); if (pdfAudio === a) pdfAudio = null; refreshReadingKeys(); };
          return a.play().then(() => refreshReadingKeys());
        }).catch((e) => { if (turn === speechTurn) toast(String((e as Error).message ?? e), 'error', 5000); });
        return;
      }
      const turn = speechTurn; pdfVoice = true; refreshReadingKeys();
      void speakPassage(text.replace(/\s+/g, ' ').trim(), lang, getSettings().speechRate, getSettings().speechVoice || undefined, () => voiceDone(turn), () => voiceDone(turn)).then((r) => {
        if (r !== 'ok') voiceDone(turn);
        if (r === 'missing-data') { toast(t('voiceDataMissing', { lang: languageName(lang) }), 'info', 7000); void installVoices(); }
        else if (r !== 'ok') toast(r === 'unavailable' ? t('speechUnavailable') : t('noVoiceFor', { lang: languageName(lang) }), 'error', 8000);
      });
    },
    // (A PDF has its own: the page itself cut out, or the card with the words read as running text — see pdfsnap.)
    textImage: (text, range) => void import('../ui/pdfsnap').then((m) => m.pdfSnapshot(viewer, range ?? document.createRange(), book, snapName(book.title), getSettings().snapWatermark ? t('appName') : '', text)).catch((err) => toast(String((err as Error).message ?? err), 'error')),
  }));
  void applyOrientation();
  if (getSettings().hideSystemBars) void setImmersive(true);
  keepAwake(getSettings().keepAwake);
  onDispose(() => { void setImmersive(false); keepAwake(false); });
  onDispose(attachEdgeBrightness(viewer.scroll));
  viewer.scroll.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); viewer.zoom(e.deltaY < 0 ? 0.1 : -0.1); }, { passive: false });
  // The phone's volume keys (Android, as set — src/readkeys.ts): the next or previous page, as PageDown and PageUp
  // turn it. (Pages run downwards: no sideways swipe here, so the screen's edges are left to the back gesture.)
  onDispose(readingKeys({ sideways: () => false, sounding: () => pdfVoice || (!!pdfAudio && !pdfAudio.paused), turn: (forward) => viewer.goTo(viewer.current + (forward ? 1 : -1)) }));

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
  const flushPdf = () => { void tracker.save(); savePlace(false); };
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
    const close = () => { overlay.remove(); window.removeEventListener('keydown', onKey); io.disconnect(); (viewer as { dropThumbs?(): void }).dropThumbs?.(); };
    // (Two fingers on the grid — a pinch — are not a tap on a page: the cell under them is not opened.)
    let multi = false; grid.addEventListener('touchstart', (e) => { if (e.touches.length > 1) multi = true; }, { passive: true }); grid.addEventListener('touchend', (e) => { if (!e.touches.length) setTimeout(() => { multi = false; }, 300); }, { passive: true });
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
      const cell = h('button', { type: 'button', class: 'page-cell' + (n === viewer.current ? ' current' : ''), dataset: { page: String(n) }, onclick: () => { if (multi) return; back.remember(); viewer.goTo(n); close(); } }, h('img', { alt: '' }), h('span', null, String(n)));
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
        body.append(h('ul', { class: 'toc-list' }, ...outline.map((it) => h('li', { class: `depth-${Math.min(3, it.depth)}` }, h('button', { type: 'button', dir: 'auto', class: it.page === viewer.current ? 'current' : '', onclick: () => { if (it.page) { back.remember(); viewer.goTo(it.page); } panel.dismiss(); } }, h('span', { style: { flex: '1' } }, it.label), it.page ? h('span', { class: 'meta' }, String(it.page)) : null)))));
      } },
      { id: 'bookmarks', label: t('bookmarks'), render: (body) => {
        const list = [...(book.bookmarks ?? [])].sort((a, b) => b.createdAt - a.createdAt);
        if (!list.length) { body.append(h('p', { class: 'center' }, t('noBookmarks'))); return; }
        body.append(h('ul', { class: 'plain-list' }, ...list.map((bm) => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { back.remember(); viewer.goTo(bm.locator.page ?? 1, bm.locator.offset ?? 0); panel.dismiss(); } }, h('span', null, bm.label), bm.excerpt ? h('span', { class: 'meta', dir: 'auto' }, bm.excerpt) : null),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(bm.id); book.bookmarks = book.bookmarks.filter((x) => x.id !== bm.id); await db.updateBook(book.id, (b) => { b.bookmarks = book.bookmarks; }); panel.refresh(); } }, icon('trash'))))));
      } },
      { id: 'notes', label: t('notes'), render: (body) => {
        const pins = [...(book.pins ?? [])].sort((a, b) => a.createdAt - b.createdAt);
        const noted = [...(book.pdfHighlights ?? [])].filter((x) => x.note).sort((a, b) => a.createdAt - b.createdAt);
        if (!pins.length && !noted.length) { body.append(h('p', { class: 'center' }, t('noPdfNotes'))); return; }
        const list = h('ul', { class: 'plain-list' });
        pins.forEach((pin, i) => list.append(h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => { back.remember(); viewer.goTo(pin.page, Math.max(0, pin.y - 0.1)); panel.dismiss(); } },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(i + 1)), h('span', { class: 'meta' }, t('pageOf', { n: pin.page, total: viewer.total }))),
            h('span', { dir: 'auto' }, pin.note)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(pin.id); book.pins = (book.pins ?? []).filter((x) => x.id !== pin.id); await db.updateBook(book.id, (b) => { b.pins = book.pins; }); renderPins(); panel.refresh(); } }, icon('trash')))));
        noted.forEach((hl, i) => list.append(h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch', gap: '4px' }, onclick: () => { back.remember(); viewer.goTo(hl.page, Math.max(0, (hl.rects[0]?.[1] ?? 0) - 0.1)); panel.dismiss(); } },
            h('span', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, h('sup', { class: 'kr-note-badge static' }, localDigits(i + 1)), h('span', { class: 'meta' }, t('pageOf', { n: hl.page, total: viewer.total }))),
            h('span', { class: 'meta', dir: 'auto' }, hl.text.length > 120 ? hl.text.slice(0, 120) + '…' : hl.text),
            h('span', { dir: 'auto' }, hl.note!)),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { const at = stampAfter(hl.noteAt); await db.updateBook(book.id, (b) => { const x = (b.pdfHighlights ?? []).find((y) => y.id === hl.id); if (x) { x.note = undefined; x.noteAt = at; } }); const local = (book.pdfHighlights ?? []).find((y) => y.id === hl.id); if (local) { local.note = undefined; local.noteAt = at; } scheduleSync(); renderHighlights(hl.page); panel.refresh(); } }, icon('trash')))));
        body.append(list);
      } },
    ], tab, { dock: true });
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
      h('button', { class: 'btn primary small', onclick: async () => { hl.note = ta.value.trim() || undefined; hl.noteAt = stampAfter(hl.noteAt); await persistHighlights(); scheduleSync(); renderHighlights(hl.page); panel.refresh(); sheet.close(); toast(t('noteSaved')); } }, icon('check'), t('done')));
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
  if (gone()) return;
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
  if (gone()) return;
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
  // The last search, kept (unless asked not to): opened again, the panel shows it as it was, without reading the
  // pages again; and a bar over the page steps through its hits (↑ ↓) without opening the panel each time.
  let lastQ = ''; let lastHits: PdfSearchHit[] = []; let hitAt = -1; let navBar: HTMLElement | null = null;
  let job: { q: string; hits: PdfSearchHit[]; done: number; total: number; running: boolean; token: { cancelled: boolean }; onHits?: (from: number) => void; onState?: () => void } | null = null;
  onDispose(() => { if (job) job.token.cancelled = true; });
  function closeNav() { navBar?.remove(); navBar = null; }
  function showHit(i: number, go = true) {
    if (!lastHits.length) return; hitAt = (i + lastHits.length) % lastHits.length; const hit = lastHits[hitAt];
    if (go) void viewer.highlightOnPage(hit.page, lastQ);
    if (!navBar) {
      navBar = h('div', { class: 'search-nav', role: 'toolbar', 'aria-label': t('searchInBook') });
      root.appendChild(navBar);
    }
    navBar.replaceChildren(
      iconButton('search', t('searchInBook'), () => openSearch()),
      h('span', { class: 'search-nav-text', dir: 'auto' }, h('b', null, `${localDigits(hitAt + 1)} / ${localDigits(lastHits.length)}`), h('span', null, ` · ${t('pageOf', { n: hit.page, total: viewer.total })}`)),
      iconButton('chevronUp', t('searchPrev'), () => showHit(hitAt - 1)),
      iconButton('chevronDown', t('searchNext'), () => showHit(hitAt + 1)),
      iconButton('close', t('close'), () => closeNav()));
  }
  onDispose(() => closeNav());
  function openSearch(initial = '') {
    const keep = searchKeep();
    if (!initial && keep && lastQ) initial = lastQ;
    panel.open(t('searchInBook'), [{ id: 'search', label: t('search'), render: (body) => {
      const input = h('input', { type: 'search', placeholder: t('searchPlaceholder'), value: initial, style: { width: '100%' }, 'aria-label': t('searchInBook') }) as HTMLInputElement;
      const status = h('div', { style: { color: 'var(--text-dim)', fontSize: '13px', margin: '10px 0' } });
      const list = h('ul', { class: 'plain-list' });
      body.append(input, keepToggle(() => { lastQ = ''; lastHits = []; if (job) { job.token.cancelled = true; job = null; } }), status, list);
      let timer: number | undefined;
      const rowOf = (hit: PdfSearchHit, i: number, q: string) => h('li', { class: 'hit' + (i === hitAt && q === lastQ ? ' current' : '') }, h('button', { type: 'button', style: { flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { lastQ = q; showHit(i); if (window.innerWidth < 900) panel.dismiss(); } },
        h('span', { class: 'meta' }, t('pageOf', { n: hit.page, total: viewer.total })), h('span', { class: 'ctx', dir: 'auto' }, hit.before, h('mark', null, hit.term), hit.after)));
      // (A search goes on after the panel is closed — a hit tapped while pages are still being read is gone to at
      // once, and the panel opened again shows the same search where it is, not from the first page.)
      const attach = (j: NonNullable<typeof job>, q: string) => {
        clear(list); j.hits.forEach((hit, i) => list.append(rowOf(hit, i, q)));
        const state = () => { if (job !== j || !status.isConnected) return; status.textContent = j.running ? `${t('pdfSearching', { n: j.done, total: j.total })}${j.hits.length ? ` · ${t('resultsCount', { n: j.hits.length })}` : ''}` : j.hits.length ? t('resultsCount', { n: j.hits.length }) : t('noResults'); };
        j.onHits = (from) => { if (!list.isConnected) return; for (let i = from; i < j.hits.length; i++) list.append(rowOf(j.hits[i], i, q)); state(); /* (the count with the list, not a page later — a far page may take a while) */ };
        j.onState = state; state(); list.querySelector('.current')?.scrollIntoView({ block: 'center' });
      };
      const run = async () => {
        const q = input.value.trim();
        if (q.length < 2) { clear(list); status.textContent = ''; return; }
        // The same search as last time (done, or still reading pages): its hits as they are.
        if (job && job.q === q && !job.token.cancelled) { attach(job, q); return; }
        searchToken.cancelled = true; searchToken = { cancelled: false };
        const token = searchToken;
        const j: NonNullable<typeof job> = { q, hits: [], done: 0, total: viewer.total, running: true, token };
        job = j; lastQ = q; lastHits = j.hits; hitAt = -1; closeNav(); attach(j, q);
        // Pages read before (here, or by the search across books) are not read again.
        if (!viewer.allTexts()) { const stored = await storedPages(book); if (stored) viewer.seedTexts(stored); }
        if (token.cancelled) return;
        await viewer.search(q, (done, total) => { j.done = done; j.total = total; j.onState?.(); }, token, (found) => { if (token.cancelled) return; const from = j.hits.length; j.hits.push(...found); j.onHits?.(from); if (navBar && lastHits === j.hits && hitAt >= 0) showHit(hitAt, false); });
        if (token.cancelled) return;
        j.running = false; j.onState?.();
        const all = viewer.allTexts(); if (all) void storePages(book, all);
      };
      input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void run(), 350); });
      if (initial) void run();
      // (Opened again with the last search in it: the caret after the words, so what is typed next follows them —
      // it stood before them, and new letters went in front.)
      setTimeout(() => { input.focus(); try { const n = input.value.length; input.setSelectionRange(n, n); } catch { /* a field that has no selection */ } }, 50);
    } }], undefined, { dock: true });
  }

  function openMore() {
    panel.open(t('more'), [{ id: 'more', label: t('more'), render: (body) => {
      // (What the reader placed in «More», and what the bars had no room for; «Customise buttons» always last.)
      body.append(moreList('pdf', bars.moreIds(), actions, () => panel.close(), () => buttonSheet('pdf')));
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
