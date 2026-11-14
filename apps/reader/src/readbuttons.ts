// The reader's buttons, placed by the reader: every action of the flow reader and of the PDF reader in one list each
// (its id, icon and name), and where each lives — the top bar (its start or its end), the toolbar (the floating
// toolbar of a flowing book, the page bar of a PDF), the «More» menu, or hidden. The order of a saved list is the
// order within each place. The bars and the «More» menu are all drawn from these lists (src/views/reader.ts), and
// the editor is src/ui/buttonsheet.ts.
//
// Fixed, whatever is chosen (so no one can lock himself out of a book): the back arrow at the top bar's start, the
// «More» button (on the toolbar, or at the top bar's end when the toolbar holds nothing; a PDF's at the top bar's
// end), and «Customise buttons» at the foot of «More». A hidden action still answers its key and its tap zone.
// (No imports from the interface: settings.ts uses this to carry older settings over. A PDF's actions and the lists
// made whole for the bars and the editor: src/readbuttonlists.ts — not needed before a book opens.)

import type { Need } from './platform';

export type ButtonPlace = 'topStart' | 'topEnd' | 'bar' | 'more' | 'hidden';
export interface PlacedButton { id: string; at: ButtonPlace }
export const BUTTON_PLACES: readonly ButtonPlace[] = ['topStart', 'topEnd', 'bar', 'more', 'hidden'];
/** Where the toolbar stands: «auto» is today's — at the foot on a phone, in the top bar on a computer (a PDF's: down
 *  the side when the screen is upright, one row at the foot when it is wide). */
export type BarAt = 'auto' | 'bottom' | 'top' | 'start' | 'end';
export type BarLook = 'pill' | 'docked';

/** One action: its id, icon (src/ui/dom.ts PATHS) and name (an i18n key). `only`: the places it may take (the
 *  PDF's page slider is a part of its bar). `need`: where it can be done at all (src/platform.ts) — elsewhere the
 *  editor leaves it out and the reader does not draw it, its place kept. */
export interface ActionInfo { id: string; icon: string; label: string; only?: ButtonPlace[]; need?: Need }

/** A flowing book's actions. */
export const FLOW_ACTIONS: readonly ActionInfo[] = [
  { id: 'toc', icon: 'toc', label: 'contents' },
  { id: 'search', icon: 'search', label: 'searchInBook' },
  { id: 'images', icon: 'images', label: 'images' },
  { id: 'bookmark', icon: 'bookmarkAdd', label: 'addBookmark' },
  { id: 'bookmarks', icon: 'bookmark', label: 'bookmarks' },
  { id: 'highlights', icon: 'highlight', label: 'highlights' },
  { id: 'type', icon: 'type', label: 'visualOptions' },
  { id: 'translate', icon: 'translate', label: 'aiTranslate' },
  { id: 'glossary', icon: 'define', label: 'glossary' },
  { id: 'speak', icon: 'speak', label: 'readAloud' },
  { id: 'scroll', icon: 'scroll', label: 'autoScroll' },
  { id: 'speedReading', icon: 'flash', label: 'speedReading' },
  { id: 'sleepTimer', icon: 'clock', label: 'sleepTimer' },
  { id: 'dayNight', icon: 'moon', label: 'tapDayNight' },
  { id: 'fullscreen', icon: 'fullscreen', label: 'fullscreen' },
  { id: 'readingBar', icon: 'eye', label: 'tapStatusLine' },
  { id: 'info', icon: 'info', label: 'bookInfo' },
  { id: 'favorite', icon: 'heart', label: 'favorite' },
  { id: 'exportNotes', icon: 'download', label: 'exportNotes' },
  { id: 'exportAnki', icon: 'download', label: 'exportAnki' },
  { id: 'shareFile', icon: 'external', label: 'shareFile' },
  { id: 'convertFile', icon: 'convert', label: 'convertFile' },
  { id: 'readInOrder', icon: 'sort', label: 'readInOrder' },
  { id: 'jumpToBook', icon: 'books', label: 'jumpToBook' },
];

const p = (at: ButtonPlace, ...ids: string[]): PlacedButton[] => ids.map((id) => ({ id, at }));
/** A flowing book's buttons as they were before they could be placed: the full-screen button at the top bar's end;
 *  contents, search, pictures, a bookmark, a line, the visual options on the toolbar; the rest in «More», in its
 *  order. (Actions new with the placing — the glossary, day and night — come into «More», at its end.) */
export const DEFAULT_FLOW_BUTTONS: readonly PlacedButton[] = [
  ...p('topEnd', 'fullscreen'),
  ...p('bar', 'toc', 'search', 'images', 'bookmark', 'sep', 'type'),
  ...p('more', 'info', 'favorite', 'speak', 'scroll', 'bookmarks', 'exportNotes', 'exportAnki', 'speedReading', 'readInOrder', 'shareFile', 'convertFile', 'sleepTimer', 'translate', 'readingBar', 'highlights', 'jumpToBook', 'glossary', 'dayNight'),
];
/** A PDF's as they were: search, contents and the pages' grid at the top bar's end; the page slider, «go to», zoom,
 *  fit, ink and the page strip on the page bar; the rest in «More». */
export const DEFAULT_PDF_BUTTONS: readonly PlacedButton[] = [
  ...p('topEnd', 'search', 'toc', 'grid'),
  ...p('bar', 'pageNav', 'goToPage', 'zoomOut', 'zoomIn', 'fitWidth', 'ink', 'pageStrip'),
  ...p('more', 'info', 'exportNotes', 'exportAnki', 'shareFile', 'convertFile', 'savePageImage', 'sharePage', 'copyPageImage', 'cutPagePart', 'savePagesRange', 'exportWithInk', 'print', 'openWithApp', 'toolExtract', 'pdfTools', 'bookmark', 'noteOnPage', 'crop', 'readInOrder', 'favorite', 'type', 'readingBar', 'fullscreen', 'bookmarks', 'highlights', 'dayNight'),
];

/** A separator's id: «sep», «sep2», «sep3»… (only on the toolbar). */
export const isSep = (id: string): boolean => /^sep\d*$/.test(id);

/** The floating toolbar's buttons as an older version kept them (`readerToolbar`, the ids in order, «more» last) put
 *  into places: those on the toolbar, the full-screen button at the top bar's end (unless it was on the toolbar), the
 *  rest in «More». */
export function buttonsFromToolbar(toolbar: unknown): PlacedButton[] {
  if (!Array.isArray(toolbar)) return DEFAULT_FLOW_BUTTONS.map((x) => ({ ...x }));
  const known = new Set(FLOW_ACTIONS.map((a) => a.id));
  let seps = 0; const bar: PlacedButton[] = []; const seen = new Set<string>();
  for (const id of toolbar) {
    if (typeof id !== 'string') continue;
    if (id === 'sep') { seps++; bar.push({ id: seps === 1 ? 'sep' : `sep${seps}`, at: 'bar' }); continue; }
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id); bar.push({ id, at: 'bar' });
  }
  const top: PlacedButton[] = seen.has('fullscreen') ? [] : [{ id: 'fullscreen', at: 'topEnd' }];
  const more = DEFAULT_FLOW_BUTTONS.filter((d) => !isSep(d.id) && !seen.has(d.id) && d.id !== 'fullscreen').map((d) => ({ id: d.id, at: 'more' as ButtonPlace }));
  return [...top, ...bar, ...more];
}

/** Older settings carried over: a list of toolbar buttons from before the placing (`readerToolbar` without
 *  `readerButtons`) becomes the placed list. Anything else is left as it is. */
export function buttonsMigrated<T extends { readerToolbar?: string[]; readerButtons?: PlacedButton[] }>(v: T): T {
  if (!v || typeof v !== 'object' || 'readerButtons' in v || !Array.isArray(v.readerToolbar)) return v;
  return { ...v, readerButtons: buttonsFromToolbar(v.readerToolbar) };
}
