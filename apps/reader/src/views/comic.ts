// The comic reader: a CBZ (any zip of pictures) or a single picture read page by page or as a strip
// (src/comic/viewer.ts), in the reader's own shell as a PDF has it (src/views/reader.ts mountPdf): the top bar, the
// page bar (the reading mode, the page slider running the way the book reads, the settings, and the buttons the
// reader placed there — a PDF's list), the reading bar, bookmarks, statistics, the screen kept on, the bars hidden
// by a tap, Back. The place is the page (Locator.page, 1-based, as a PDF's) in the progress store, so «Continue
// reading», the percentage, the library's status and the statistics' pages follow it; the last page is the end.
// A book's own mode is kept with it (Book.prefs.comicMode; 0 or none: the default, Settings → comicMode).
import COMIC_CSS from '../comic/comic.lazy.css' with { type: 'text' };
import { ensureStyle } from '../ui/lazycss';
ensureStyle('kr-comic-css', COMIC_CSS as string);
import { h, icon, iconButton, toast, askText } from '../ui/dom';
import { t } from '../i18n';
import { db, uid, stampAfter, type Book, type Bookmark, type Locator, FAV_TAG } from '../db';
import { getSettings, onSettingsChange, updateSettings, applySettings, applyOrientation, type VisualSettings } from '../settings';
import { SidePanel } from '../ui/panel';
import { createReadBar } from '../ui/readbar';
import { mountBars, moreList, type ActionRun } from '../ui/buttonbars';
import { buttonSheet } from '../ui/buttonsheet';
import { shareFile, saveImage, copyImage } from '../ui/share';
import { ReadingTracker } from '../stats';
import { scheduleSync, markDeleted } from '../sync';
import { offerPutBack } from '../undoitems';
import { readingKeys } from '../readkeys';
import { onBack, arrowBack } from '../ui/backstack';
import { setImmersive, keepAwake, toggleFullscreen, leaveFullscreen, isFullscreen, nativePlatform, canDeviceBrightness, getDeviceBrightness, setDeviceBrightness } from '../native';
import { onPhone, fits } from '../platform';
import { touchBook, shareBooks } from '../library';
import { navigate } from '../router';
import { nextVolume, prevVolume } from '../series';
import { nextQueued, getQueue } from '../ui/queue';
import { showBookInfo } from '../ui/bookinfo';
import { takeJump } from '../jump';
import { diagLeaveIntent } from '../diag';
import { leaveBook, goNextVolume, toggleFavorite } from './reader';
import { openPages, type PageSource } from '../comic/pages';
import { ComicViewer, isStrip, isHorizontal, type Mode, type ViewerOptions, type Pressed } from '../comic/viewer';
import type { Edge } from '../comic/crop';
import { comicModeFields, comicGeneralFields, comicColourFields, modeName } from '../comic/settingsui';
import { stepOf } from '../comic/zones';

type OnDispose = (fn: () => void) => void;
interface Op { placed(): void; shown(): void; failed(why: string): void; size(k: 'pages' | 'paras' | 'bytes', v: number): void }
const ZONES_SEEN = 'kr.comicZonesSeen';
const MODE_ICON: Record<Mode, string> = { 1: 'modeLtr', 2: 'modeRtl', 3: 'modeVertical', 4: 'modeStrip', 5: 'modeGap' };

/** The mode a book is read in: its own, else the default. */
export function comicModeOf(book: Book, s: VisualSettings = getSettings()): Mode {
  const own = Number(book.prefs?.comicMode ?? 0);
  return (own >= 1 && own <= 5 ? own : s.comicMode) as Mode;
}
/** The arrow of the button to another volume: the way reading goes on (left in a book read right to left, down in the vertical
 *  modes) for the next volume, the opposite way for the one before. */
export const volumeArrow = (mode: Mode, next: boolean): string => (mode === 3 || mode === 4 || mode === 5 ? (next ? 'arrowDown' : 'arrowUp') : (mode === 2) === next ? 'arrowLeft' : 'arrowRight');
const optionsOf = (mode: Mode, s: VisualSettings, book?: Book): ViewerOptions => {
  const strip = isStrip(mode);
  return {
    transitions: s.comicTransitions, scale: s.comicScale, zoomStart: s.comicZoomStart, navPan: s.comicNavPan, landscapeZoom: s.comicLandscapeZoom, stripZoom: s.comicStripZoom,
    zones: strip ? s.comicZonesStrip : s.comicZonesPaged, invert: strip ? s.comicInvertStrip : s.comicInvertPaged,
    split: strip ? s.comicSplitStrip : s.comicSplit, splitInvert: strip ? s.comicSplitInvertStrip : s.comicSplitInvert,
    rotate: strip ? s.comicRotateStrip : s.comicRotate, rotateInvert: strip ? s.comicRotateInvertStrip : s.comicRotateInvert,
    dual: s.comicDual, shift: Number(book?.prefs?.comicShift ?? 0) === 1,
    crop: strip ? s.comicCropStrip : s.comicCrop, auto: s.comicBackground === 'auto',
    padding: s.comicStripPadding, noZoomOut: s.comicStripNoZoomOut, longPress: s.comicLongPress,
  };
};
const COMIC_KEYS = ['comicMode', 'comicTransitions', 'comicScale', 'comicZoomStart', 'comicNavPan', 'comicLandscapeZoom', 'comicStripZoom', 'comicZonesPaged', 'comicZonesStrip', 'comicInvertPaged', 'comicInvertStrip',
  'comicSplit', 'comicSplitInvert', 'comicRotate', 'comicRotateInvert', 'comicSplitStrip', 'comicSplitInvertStrip', 'comicRotateStrip', 'comicRotateInvertStrip', 'comicDual', 'comicCrop', 'comicCropStrip', 'comicStripPadding', 'comicStripNoZoomOut', 'comicLongPress'] as const;
/** The background colours; «Automatic» takes white or black from the page's own border. */
const BG: Record<'black' | 'grey' | 'white', string> = { black: '#000', grey: '#4a4a4a', white: '#fff' };
const BLEND_CSS: Record<VisualSettings['comicTintBlend'], string> = { normal: 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay', lighten: 'lighten', darken: 'darken' };

export async function mountComic(root: HTMLElement, book: Book, onDispose: OnDispose, gone: () => boolean, op?: Op): Promise<void> {
  // (The opening timed from here — the file fetched, its directory read, the first page decoded: «first page visible».)
  const t0 = performance.now();
  const file = await db.getFile(book.id);
  if (gone()) return;
  if (!file) { op?.failed('file missing'); diagLeaveIntent('missing'); toast(t(book.source ? 'linkedFileMissing' : 'openError', { title: book.title, error: '' }), 'error', 5000); navigate('/', true); return; }
  const source: PageSource = await openPages(file, book.format === 'image' ? 'image' : 'cbz', book.fileName, { get: () => db.getMeta(`comic:${book.id}`), set: (v) => db.setMeta(`comic:${book.id}`, v) });
  if (gone()) { source.dispose(); return; }
  onDispose(() => source.dispose());
  if (!source.pages.length) { toast(t('openError', { title: book.title, error: '' }), 'error', 5000); navigate('/', true); return; }
  const total = source.pages.length;
  if (book.pageCount !== total) { book.pageCount = total; void db.updateBook(book.id, (b) => { b.pageCount = total; }); }

  root.classList.add('comic-reader');
  const reader = h('div', { class: 'reader comic-stage' });
  applySettings(reader);
  document.body.style.background = '#000';
  onDispose(() => { document.body.style.background = ''; });
  const title = h('div', { class: 'title', dir: 'auto' }, book.title, h('small', null, book.author ?? ''));
  const panel = new SidePanel(root);
  let mode = comicModeOf(book);
  let viewer: ComicViewer;

  // The page bar: the reading mode, the slider (running the way the book reads), the settings; the placed buttons.
  const slider = h('input', { type: 'range', min: '1', max: String(total), value: '1', 'aria-label': t('page'), class: 'cm-slider' }) as HTMLInputElement;
  const count = h('span', { class: 'pcount' });
  const seek = h('div', { class: 'cm-seek', hidden: true, 'aria-hidden': 'true' });
  const modeBtn = iconButton(MODE_ICON[mode], t('comicModeTitle'), () => pickMode());
  modeBtn.classList.add('cm-mode-btn');
  const setBtn = iconButton('settings', t('comicSettings'), () => openSettings());
  setBtn.classList.add('cm-settings-btn');
  // (The arrows go the way they point: in a right-to-left book the left one is the next page.)
  const leftBtn = iconButton('chevronLeft', t('previousPage'), () => viewer.step(stepOf('left', viewer.rtl), { pan: false }));
  const rightBtn = iconButton('chevronRight', t('nextPage'), () => viewer.step(stepOf('right', viewer.rtl), { pan: false }));
  // The quick buttons: borders trimmed, the pairing shifted by a page (when two pages stand side by side), and the screen's rotation (a phone).
  const cropBtn = iconButton('crop', t('comicCrop'), () => { const k = isStrip(mode) ? 'comicCropStrip' : 'comicCrop'; updateSettings({ [k]: !getSettings()[k] } as Partial<VisualSettings>); });
  cropBtn.classList.add('cm-quick', 'cm-crop-btn');
  const pairBtn = iconButton('pairs', t('comicShift'), () => setShift(Number(book.prefs?.comicShift ?? 0) !== 1));
  pairBtn.classList.add('cm-quick', 'cm-shift-btn');
  const orientBtn = iconButton('rotate', t('comicOrient'), () => pickOrient());
  orientBtn.classList.add('cm-quick', 'cm-orient-btn');
  const quick = h('div', { class: 'cm-quick-row' }, cropBtn, pairBtn, ...(onPhone() ? [orientBtn] : []));
  const barNav = h('div', { class: 'pdf-bar-nav cm-bar-nav' }, modeBtn, leftBtn, slider, rightBtn, count, setBtn);
  const barTools = h('div', { class: 'pdf-bar-tools' });
  const portrait = matchMedia('(orientation: portrait)');
  const bar = h('div', { class: 'pdf-bar cm-bar' }, barNav, quick, barTools, seek);
  const relayout = () => { const s = getSettings(); bar.dataset.layout = portrait.matches ? 'rows' : 'row'; bar.dataset.row = 'bottom'; bar.dataset.look = s.pdfBarLook === 'docked' ? 'docked' : 'pill'; };
  relayout(); onDispose(onSettingsChange(relayout)); portrait.addEventListener('change', relayout); onDispose(() => portrait.removeEventListener('change', relayout));
  const backBtn = iconButton('back', t('back'), arrowBack(() => leaveBook(book, false)));
  const moreBtn = iconButton('more', t('more'), () => openMore());
  const topbar = h('header', { class: 'topbar' }, backBtn, title, moreBtn);
  const pnum = h('div', { class: 'cm-pnum', 'aria-live': 'off' });
  const no = () => false;
  const savePage = async (how: 'save' | 'share' | 'copy') => {
    try {
      const p = source.pages[viewer.page]; const blob = await p.blob(); const ext = (p.name.split('.').pop() || 'png').toLowerCase();
      const name = `${book.title.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40)} - p${viewer.page + 1}.${ext}`;
      if (how === 'copy') { if (await copyImage(blob)) toast(t('copied')); } else if (how === 'share') await shareFile(blob, name, book.title); else await saveImage(blob, name);
    } catch (err) { toast(String((err as Error).message ?? err), 'error'); }
  };
  const goToPage = async () => {
    const v = await askText({ title: t('goToPage'), label: t('page'), ok: t('go'), cancel: t('cancel'), numeric: true, value: String(viewer.page + 1) });
    const n = Number(String(v ?? '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))); if (n) viewer.goTo(Math.min(total, Math.max(1, n)) - 1);
  };
  // A PDF's actions (src/readbuttons.ts PDF_ACTIONS), those a book of pictures has; the others are not drawn.
  const actions: Record<string, ActionRun> = {
    pageNav: { run: () => undefined },
    toc: { run: () => openContents('toc') },
    goToPage: { run: () => void goToPage() },
    zoomOut: { run: () => viewer.zoomBy(-0.5) },
    zoomIn: { run: () => viewer.zoomBy(0.5) },
    info: { run: () => showBookInfo({ book, stats: tracker.current, speed: tracker.speed(), pages: total, currentPage: viewer.page + 1, pct: (viewer.page + 1) / total }) },
    shareFile: { run: () => void shareBooks([book.id]) },
    convertFile: { run: () => void import('../ui/convert').then((m) => m.convertSheet(book)) },
    savePageImage: { run: () => void savePage('save') },
    sharePage: { run: () => void savePage('share') },
    copyPageImage: { run: () => void savePage('copy') },
    bookmark: { run: () => void addBookmark() },
    bookmarks: { run: () => openContents('bookmarks') },
    readInOrder: { run: () => void import('../ui/queue').then((m) => m.queueSheet(getQueue().length ? getQueue() : [book.id], { onChange: () => void findVolumes() })) },
    favorite: { run: () => void toggleFavorite(book), label: () => (book.tags?.includes(FAV_TAG) ? t('unfavorite') : t('favorite')), icon: () => (book.tags?.includes(FAV_TAG) ? 'heartFill' : 'heart') },
    type: { run: () => openSettings(), label: () => t('comicSettings') },
    readingBar: { run: () => updateSettings({ showStatusLine: !getSettings().showStatusLine }), label: () => (getSettings().showStatusLine ? t('hideReadingBar') : t('showReadingBar')) },
    fullscreen: { run: () => { void toggleFullscreen(root); } },
    // (Not for a book of pictures: no text, no ink, no outline of pages.)
    search: { run: () => undefined, available: no }, grid: { run: () => undefined, available: no }, fitWidth: { run: () => undefined, available: no },
  };
  const bars = mountBars({ kind: 'pdf', root, topbar, back: backBtn, title, toolbar: barTools, toolbarBox: bar, keepRoom: () => [barNav], more: moreBtn, actions,
    onNav: (on) => { slider.hidden = !on; leftBtn.hidden = !on; rightBtn.hidden = !on; count.hidden = !on; },
    after: ({ toolbarEmpty }) => { barTools.hidden = toolbarEmpty; } });
  bars.render();
  { const redo = () => bars.render(); onDispose(onSettingsChange(redo)); portrait.addEventListener('change', redo); onDispose(() => portrait.removeEventListener('change', redo)); }
  onDispose(() => bars.dispose());
  const readBar = createReadBar(root, onDispose);
  const comfort = h('div', { class: 'reader-comfort', 'aria-hidden': 'true' });
  const syncComfort = () => { const st = getComputedStyle(reader); const warm = st.getPropertyValue('--r-warmth').trim(), dim = st.getPropertyValue('--r-dim-overlay').trim(); root.style.setProperty('--r-warmth', warm); root.style.setProperty('--r-dim-overlay', dim); comfort.hidden = !(Number(warm) > 0 || Number(dim) > 0); comfort.dataset.warm = Number(warm) > 0 ? '1' : '0'; };
  root.append(reader, topbar, bar, pnum, readBar.el, comfort);
  queueMicrotask(syncComfort);
  // (The page number stands above the page bar while it is shown: its room measured.)
  { const ro = new ResizeObserver(() => { const r = bar.getBoundingClientRect(); root.style.setProperty('--cm-bar-room', `${Math.max(0, Math.round(innerHeight - r.top))}px`); }); ro.observe(bar); onDispose(() => ro.disconnect()); }

  // The pages between volumes: the end («Finished», the next volume) and, when there is one, the volume before.
  let nextBook: Book | null = null, prevBook: Book | null = null, queued = false;
  const betweenCard = (lines: (HTMLElement | null)[]) => h('div', { class: 'cm-between-card' }, ...lines.filter((x): x is HTMLElement => !!x));
  const openBtn = (b: Book, next: boolean) => h('button', { type: 'button', class: 'btn tonal cm-open-volume', dataset: { book: b.id }, onclick: () => { if (next) goNextVolume(book.id, b.id); else { diagLeaveIntent('prev-volume'); navigate(`/read/${b.id}`, true); } } }, icon(volumeArrow(mode, next)), h('span', null, t('comicOpenVolume')));
  const before = (): HTMLElement | null => (getSettings().comicBetween && prevBook ? betweenCard([
    h('p', { class: 'cm-b-label', dir: 'auto' }, t('comicPrevious', { title: prevBook.title })), openBtn(prevBook, false),
    h('p', { class: 'cm-b-label cm-b-main', dir: 'auto' }, t('comicStartOf', { title: book.title }))]) : null);
  const after = (): HTMLElement | null => (getSettings().comicBetween ? betweenCard([
    h('p', { class: 'cm-b-label cm-b-main', dir: 'auto' }, t('comicFinished', { title: book.title })),
    nextBook ? h('p', { class: 'cm-b-label', dir: 'auto' }, t(queued ? 'comicNextQueued' : 'comicNext', { title: nextBook.title })) : h('p', { class: 'cm-b-label hint' }, t('comicNoNext')),
    nextBook ? openBtn(nextBook, true) : null]) : null);
  const findVolumes = async () => {
    const all = await db.allBooks();
    const q = await nextQueued(book.id).catch(() => null);
    const nb = q ?? nextVolume(book, all); const pb = prevVolume(book, all);
    queued = !!q;
    if (gone()) return;
    if (nb?.id !== nextBook?.id || pb?.id !== prevBook?.id) { nextBook = nb; prevBook = pb; viewer?.rebuild(); }
  };

  // The place: saved a moment after a turn, and as the book is left.
  let placed = false; let saveTimer = 0;
  const savePlace = (sync = true) => {
    window.clearTimeout(saveTimer); saveTimer = 0;
    if (!placed) return;
    const page = viewer.page + 1; const loc: Locator = { bookId: book.id, page, offset: viewer.offset(), pct: page / total };
    book.progress = loc; void db.updateBook(book.id, (b) => { b.progress = loc; b.progressAt = stampAfter(b.progressAt); });
    if (sync) scheduleSync();
  };
  const tracker = new ReadingTracker(book, () => true);
  let nextPill: HTMLElement | null = null;
  const onChange = (st: { page: number; kind: string; shown: number; shownEnd: number; shownTotal: number }) => {
    const n = st.page + 1;
    // (The count is of the pieces shown: a wide page split in two counts two, two pages side by side count two.)
    const shown = st.shown === st.shownEnd ? String(st.shown) : `${st.shown}-${st.shownEnd}`;
    slider.max = String(Math.max(1, st.shownTotal)); slider.value = String(st.shown); count.textContent = `${shown} / ${st.shownTotal}`;
    pnum.textContent = `${shown} / ${st.shownTotal}`; pnum.hidden = !getSettings().comicPageNumber || st.kind !== 'page';
    readBar.set({ title: book.title, bookPage: n, bookPages: total, bookPct: Math.round((n / total) * 100), page: n, pages: total, chapterPct: Math.round((n / total) * 100), chapter: chapterAt(st.page) });
    tracker.advance(0, n / total);
    // (No page between volumes: at the last page the next volume is offered as a PDF offers it.)
    if (n >= total && !getSettings().comicBetween && nextBook && !nextPill) { const nb = nextBook; nextPill = h('button', { type: 'button', class: 'jump-back next-volume', onclick: () => goNextVolume(book.id, nb.id) }, h('span', { dir: 'auto' }, `${queued ? t('nextInOrder') : t('nextVolume')}: ${nb.title}`), icon('arrowRight')); root.append(nextPill); }
    if (placed) { window.clearTimeout(saveTimer); saveTimer = window.setTimeout(() => savePlace(), 600); }
  };
  const chapterAt = (page: number) => { let label = ''; for (const c of source.chapters) if (c.start <= page) label = c.label; return label; };
  const setSliderDir = () => { slider.style.direction = viewer.rtl ? 'rtl' : 'ltr'; bar.dataset.dir = viewer.rtl ? 'rtl' : 'ltr'; };
  const toggleBars = () => { const on = root.classList.toggle('immersive'); if (nativePlatform() === 'android' || nativePlatform() === 'ios') void setImmersive(on || getSettings().hideSystemBars); };

  // The background (black, grey, white, or by the page's border) and the colour over the pages.
  let edge: Edge = 'none'; let autoBg = BG.black;
  const applyBackground = () => {
    const s = getSettings(); if (s.comicBackground === 'auto') { if (edge === 'white') autoBg = BG.white; else if (edge === 'black') autoBg = BG.black; }
    const col = s.comicBackground === 'auto' ? autoBg : BG[s.comicBackground] ?? BG.black;
    root.style.setProperty('--cm-bg', col); document.body.style.background = col;
  };
  const tint = h('div', { class: 'cm-colour cm-tint', 'aria-hidden': 'true', hidden: true });
  const dim = h('div', { class: 'cm-colour cm-dim', 'aria-hidden': 'true', hidden: true });
  reader.append(tint, dim);
  let savedBright: number | null = null;
  const applyColour = () => {
    const s = getSettings(); const f: string[] = [];
    if (s.comicGrey) f.push('grayscale(1)');
    if (s.comicInvertColours) f.push('invert(1)');
    const v = s.comicBrightOn ? s.comicBrightness : 0;
    // (Below 0 a black layer darkens the pages; above 0 the device's own brightness is raised where the platform allows, else the pages are lightened.)
    dim.hidden = !(v < 0); dim.style.background = '#000'; dim.style.opacity = v < 0 ? String(-v / 100) : '0';
    if (v > 0 && canDeviceBrightness()) {
      if (savedBright === null) void getDeviceBrightness().then((b) => { if (savedBright === null) { savedBright = b; void setDeviceBrightness(Math.min(1, 0.5 + getSettings().comicBrightness / 200)); } });
      else void setDeviceBrightness(Math.min(1, 0.5 + v / 200));
    } else {
      if (v > 0) f.push(`brightness(${(1 + v / 100).toFixed(2)})`);
      if (savedBright !== null) { void setDeviceBrightness(savedBright); savedBright = null; }
    }
    root.style.setProperty('--cm-filter', f.length ? f.join(' ') : 'none'); reader.style.setProperty('--cm-filter', f.length ? f.join(' ') : 'none');
    const on = s.comicTintOn && s.comicTintA > 0;
    tint.hidden = !on; tint.style.background = `rgb(${s.comicTintR} ${s.comicTintG} ${s.comicTintB} / ${(s.comicTintA / 255).toFixed(3)})`; tint.style.mixBlendMode = BLEND_CSS[s.comicTintBlend] ?? 'normal';
  };
  applyBackground(); applyColour();
  onDispose(() => { if (savedBright !== null) void setDeviceBrightness(savedBright); });
  viewer = new ComicViewer({ container: reader, source, before, after, onChange, onMenu: () => { if (hideZones()) return; toggleBars(); }, onBackground: (e) => { edge = e; applyBackground(); }, onLongPress: (hit) => openPageMenu(hit) }, mode, optionsOf(mode, getSettings(), book));
  (window as unknown as { __krComic?: unknown }).__krComic = { viewer, source, mode: () => mode, openMs: 0 };
  onDispose(() => { viewer.dispose(); delete (window as unknown as { __krComic?: unknown }).__krComic; });
  setSliderDir();
  // The slider: the page's number shown as it is dragged, the page turned to when it is let go.
  slider.addEventListener('input', () => { seek.hidden = false; seek.textContent = `${slider.value} / ${slider.max}`; });
  slider.addEventListener('change', () => { seek.hidden = true; viewer.goToDisplay(Number(slider.value)); });
  slider.addEventListener('pointerup', () => { seek.hidden = true; });

  // Back to the place it was left (a bookmark's, when opened from one).
  const jump = takeJump();
  const bm = jump?.kind === 'bm' ? book.bookmarks.find((x) => x.id === jump.id) : undefined;
  const at = bm?.locator ?? book.progress;
  const startPage = at?.page ? at.page - 1 : at?.pct ? Math.round(at.pct * total) - 1 : 0;
  viewer.goTo(Math.max(0, Math.min(total - 1, startPage)), at?.offset ?? 0);
  placed = true;
  // (First page visible: its picture decoded.)
  const firstShown = () => { const img = reader.querySelector<HTMLImageElement>('.cm-current img.cm-img, .cm-block img.cm-img'); if (img?.complete && img.naturalWidth) { (window as unknown as { __krComic: { openMs: number } }).__krComic.openMs = Math.round(performance.now() - t0); op?.shown(); return; } if (!gone()) requestAnimationFrame(firstShown); };
  requestAnimationFrame(firstShown);
  op?.size('bytes', file.size); op?.size('pages', total); op?.placed();
  void touchBook(book.id);
  void findVolumes();
  tracker.start();
  onDispose(() => { savePlace(); void tracker.stop(); });
  const flush = () => { void tracker.save(); savePlace(false); };
  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', onHide);
  onDispose(() => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', onHide); });

  // Settings changed (here, or in the panel): the mode and the viewer's options again, the bars' state.
  let seen = JSON.stringify(COMIC_KEYS.map((k) => getSettings()[k]));
  let betweenSeen = getSettings().comicBetween;
  onDispose(onSettingsChange((s) => {
    applySettings(reader, s); syncComfort(); applyBackground(); applyColour(); syncQuick();
    const now = JSON.stringify(COMIC_KEYS.map((k) => s[k]));
    if (now !== seen) { seen = now; mode = comicModeOf(book, s); applyMode(); }
    pnum.hidden = !s.comicPageNumber || viewer.itemKind !== 'page';
    if (betweenSeen !== s.comicBetween) { betweenSeen = s.comicBetween; viewer.rebuild(); }
  }));
  const applyMode = () => { viewer.set(mode, optionsOf(mode, getSettings(), book)); setSliderDir(); modeBtn.replaceChildren(icon(MODE_ICON[mode])); modeBtn.dataset.mode = String(mode); refreshKeys(); syncQuick(); };
  modeBtn.dataset.mode = String(mode);
  const setBookMode = (m: number) => {
    book.prefs = { ...(book.prefs ?? {}), comicMode: m };
    if (!m) delete book.prefs.comicMode;
    void db.updateBook(book.id, (b) => { b.prefs = { ...(b.prefs ?? {}) }; if (m) b.prefs.comicMode = m; else delete b.prefs.comicMode; });
    mode = comicModeOf(book); applyMode();
  };
  function pickMode(): void {
    import('../ui/dom').then(({ pickSheet }) => pickSheet(t('comicModeTitle'), [['0', t('comicModeDefault', { mode: modeName(getSettings().comicMode) })], ...([1, 2, 3, 4, 5] as Mode[]).map((m) => [String(m), modeName(m)] as ['1', string])], String(Number(book.prefs?.comicMode ?? 0) || 0) as '0', (v) => setBookMode(Number(v)), t('close'))).catch(() => undefined);
  }
  function openSettings(): void {
    panel.open(t('comicSettings'), [
      { id: 'mode', label: t('comicModeTitle'), render: (body) => { const box = h('div', { class: 'options-grid cm-options' }); comicModeFields(box, { bookMode: () => Number(book.prefs?.comicMode ?? 0), setBookMode, showZones: () => { panel.close(); showZones(); } }); body.append(box); } },
      { id: 'general', label: t('comicTabGeneral'), render: (body) => { const box = h('div', { class: 'options-grid cm-options' }); comicGeneralFields(box); body.append(box); } },
      { id: 'colour', label: t('comicTabColour'), render: (body) => { const box = h('div', { class: 'options-grid cm-options' }); comicColourFields(box); body.append(box); } },
    ], 'mode');
  }

  // The tap zones shown: tinted, each named; for a new reader once, and from «Show the zones».
  let zonesEl: HTMLElement | null = null; let zonesTimer = 0;
  function hideZones(): boolean { if (!zonesEl) return false; zonesEl.remove(); zonesEl = null; window.clearTimeout(zonesTimer); root.classList.remove('cm-zones-up'); return true; }
  function showZones(): void {
    hideZones();
    const el = h('div', { class: 'cm-zones', role: 'presentation' });
    for (const z of viewer.zones()) {
      const step = stepOf(z.a, viewer.rtl); const [x0, y0, x1, y1] = z.r;
      el.append(h('div', { class: 'cm-zone', dataset: { step: step > 0 ? 'next' : 'prev' }, style: { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` } }, h('span', null, t(step > 0 ? 'comicZoneNext' : 'comicZonePrev'))));
    }
    // («Menu» written where no zone lies: the middle when it is free, else a side.)
    const zs = viewer.zones(); const free = [[0.5, 0.5], [0.5, 0.15], [0.5, 0.85], [0.15, 0.5], [0.85, 0.5]].find(([x, y]) => !zs.some((z) => x >= z.r[0] && x < z.r[2] && y >= z.r[1] && y < z.r[3]));
    if (free) el.append(h('div', { class: 'cm-zone-menu', style: { left: `${free[0] * 100}%`, top: `${free[1] * 100}%` } }, h('span', null, t('comicZoneMenu'))));
    el.append(h('p', { class: 'cm-zones-hint' }, t('comicZonesClose')));
    el.addEventListener('pointerup', (e) => { e.stopPropagation(); hideZones(); });
    reader.append(el); zonesEl = el; root.classList.add('cm-zones-up');
    zonesTimer = window.setTimeout(hideZones, 6000);
  }
  try { if (onPhone() && !localStorage.getItem(ZONES_SEEN)) { localStorage.setItem(ZONES_SEEN, '1'); showZones(); } } catch { /* no storage: not shown */ }
  onDispose(() => { window.clearTimeout(zonesTimer); });

  // The keys: ← → by the reading direction, ↑ ↓, Page Up / Down, Space / Shift+Space, Home / End.
  onDispose(onBack(() => { if (hideZones()) return true; if (!isFullscreen()) return false; void leaveFullscreen(root); return true; }));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return;
    if ((e.target as HTMLElement).matches?.('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const rtl = viewer.rtl;
    switch (e.key) {
      case 'ArrowRight': viewer.step(isHorizontal(mode) ? stepOf('right', rtl) : 1); break;
      case 'ArrowLeft': viewer.step(isHorizontal(mode) ? stepOf('left', rtl) : -1); break;
      case 'ArrowDown': case 'PageDown': viewer.step(1); break;
      case 'ArrowUp': case 'PageUp': viewer.step(-1); break;
      case ' ': viewer.step(e.shiftKey ? -1 : 1); break;
      case 'Home': viewer.goFirst(); break;
      case 'End': viewer.goLast(); break;
      case '+': case '=': viewer.zoomBy(0.5); break;
      case '-': case '_': viewer.zoomBy(-0.5); break;
      case 'b': void addBookmark(); break;
      case 'c': openContents('toc'); break;
      case 'v': openSettings(); break;
      case 'f': void toggleFullscreen(root); break;
      default: return;
    }
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  onDispose(() => window.removeEventListener('keydown', onKey));
  // The phone's volume keys (Android, as set): the next or previous page.
  let offKeys: (() => void) | null = null;
  const refreshKeys = () => { offKeys?.(); offKeys = readingKeys({ sideways: () => isHorizontal(mode), sounding: () => false, turn: (forward) => viewer.step(forward ? 1 : -1), barsShown: () => !root.classList.contains('immersive'), root }); };
  refreshKeys(); onDispose(() => offKeys?.());
  void applyOrientation();
  // (The pages full screen as the reader is entered: the bars come with a tap.)
  root.classList.add('immersive');
  if (getSettings().hideSystemBars || nativePlatform() === 'android' || nativePlatform() === 'ios') void setImmersive(true);
  keepAwake(getSettings().keepAwake);
  onDispose(() => { void setImmersive(false); keepAwake(false); });

  // The quick buttons' state: borders trimmed (pressed), the pairing shifted, shown only when they matter; the rotation lock.
  function syncQuick(): void {
    const s = getSettings(); const trimmed = isStrip(mode) ? s.comicCropStrip : s.comicCrop;
    cropBtn.setAttribute('aria-pressed', String(trimmed)); cropBtn.setAttribute('aria-label', trimmed ? `${t('comicCrop')}` : t('comicCrop'));
    const pairs = !isStrip(mode) && s.comicDual !== 'never';
    pairBtn.hidden = !pairs; pairBtn.setAttribute('aria-pressed', String(Number(book.prefs?.comicShift ?? 0) === 1));
    orientBtn.setAttribute('aria-pressed', String((book.prefs?.comicOrient ?? 'auto') !== 'auto'));
  }
  function setShift(on: boolean): void {
    book.prefs = { ...(book.prefs ?? {}), comicShift: on ? 1 : 0 };
    void db.updateBook(book.id, (b) => { b.prefs = { ...(b.prefs ?? {}), comicShift: on ? 1 : 0 }; });
    viewer.set(mode, optionsOf(mode, getSettings(), book)); syncQuick(); toast(t(on ? 'comicShiftOn' : 'comicShiftOff'));
  }
  // The screen's rotation for this book: free (the app's own setting), portrait, landscape — a phone's.
  const applyOrient = () => { const o = String(book.prefs?.comicOrient ?? 'auto'); if (o === 'portrait' || o === 'landscape') void applyOrientation({ ...getSettings(), orientation: o }); else void applyOrientation(); };
  function pickOrient(): void {
    import('../ui/dom').then(({ pickSheet }) => pickSheet(t('comicOrient'), [['auto', t('comicOrientFree')], ['portrait', t('orientationPortrait')], ['landscape', t('orientationLandscape')]], String(book.prefs?.comicOrient ?? 'auto') as 'auto', (v) => {
      book.prefs = { ...(book.prefs ?? {}), comicOrient: v }; void db.updateBook(book.id, (b) => { b.prefs = { ...(b.prefs ?? {}), comicOrient: v }; }); applyOrient(); syncQuick();
    }, t('close'))).catch(() => undefined);
  }
  if (onPhone()) { applyOrient(); onDispose(() => { void applyOrientation(); }); }
  syncQuick();
  // The page's own menu: a long press (a right click on a computer).
  function openPageMenu(hit: Pressed): void {
    if (!getSettings().comicLongPress) return;
    hideZones();
    void import('../comic/pagemenu').then((m) => m.pageMenu({ book, source, hit, coverChanged: () => { void import('../library').then((l) => l.forgetCover(book.id)); } }));
  }

  async function addBookmark(): Promise<void> {
    const page = viewer.page + 1;
    const mark: Bookmark = { id: uid(), label: t('pageOf', { n: page, total }), excerpt: chapterAt(page - 1), locator: { bookId: book.id, page, offset: viewer.offset(), pct: page / total }, createdAt: Date.now() };
    book.bookmarks = [...(book.bookmarks ?? []), mark]; scheduleSync();
    await db.updateBook(book.id, (b) => { b.bookmarks = book.bookmarks; });
    toast(t('bookmarkAdded')); panel.refresh();
  }
  const putBack = (b: Book | undefined) => { if (b) { book.bookmarks = b.bookmarks; panel.refresh(); } };
  function openContents(tab: 'toc' | 'bookmarks'): void {
    panel.open(t('contents'), [
      { id: 'toc', label: t('contents'), render: (body) => {
        if (!source.chapters.length) { body.append(h('p', { class: 'center' }, t('noContents'))); return; }
        const curCh = source.pages[viewer.page]?.chapter ?? 0;
        body.append(h('ul', { class: 'toc-list' }, ...source.chapters.map((c, i) => h('li', { class: 'depth-0' }, h('button', { type: 'button', dir: 'auto', class: i === curCh ? 'current' : '', onclick: () => { viewer.goTo(c.start); panel.dismiss(); } }, h('span', { style: { flex: '1' } }, c.label), h('span', { class: 'meta' }, String(c.start + 1)))))));
      } },
      { id: 'bookmarks', label: t('bookmarks'), render: (body) => {
        const list = [...(book.bookmarks ?? [])].sort((a, b) => b.createdAt - a.createdAt);
        if (!list.length) { body.append(h('p', { class: 'center' }, t('noBookmarks'))); return; }
        body.append(h('ul', { class: 'plain-list' }, ...list.map((m) => h('li', null,
          h('button', { type: 'button', style: { flex: '1', flexDirection: 'column', alignItems: 'stretch' }, onclick: () => { viewer.goTo((m.locator.page ?? 1) - 1, m.locator.offset ?? 0); panel.dismiss(); } }, h('span', null, m.label), m.excerpt ? h('span', { class: 'meta', dir: 'auto' }, m.excerpt) : null),
          h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { void markDeleted(m.id); book.bookmarks = book.bookmarks.filter((x) => x.id !== m.id); await db.updateBook(book.id, (b) => { b.bookmarks = book.bookmarks; }); panel.refresh(); offerPutBack(t('bookmarkDeleted'), book.id, 'bookmarks', m, putBack, () => root.isConnected); } }, icon('trash'))))));
      } },
    ], tab, { dock: true });
  }
  function openMore(): void {
    panel.open(t('more'), [{ id: 'more', label: t('more'), render: (body) => { body.append(moreList('pdf', bars.moreIds(), actions, () => panel.close(), () => buttonSheet('pdf'))); } }]);
  }
}
