// The reader's buttons, for the bars and their editor (src/ui/buttonbars.ts, src/ui/buttonsheet.ts): a PDF's
// actions, a saved list made whole, the ids in a place, the old toolbar form. Apart from src/readbuttons.ts (the
// flowing book's actions, the defaults, the migration — which settings.ts needs at the start) so that the library's
// first screen does not carry them.
import { FLOW_ACTIONS, DEFAULT_FLOW_BUTTONS, DEFAULT_PDF_BUTTONS, BUTTON_PLACES, isSep, type ActionInfo, type ButtonPlace, type PlacedButton } from './readbuttons';

/** A PDF's actions. */
export const PDF_ACTIONS: readonly ActionInfo[] = [
  { id: 'pageNav', icon: 'chevronRight', label: 'pageSlider', only: ['bar', 'hidden'] },
  { id: 'search', icon: 'search', label: 'searchInBook' },
  { id: 'toc', icon: 'toc', label: 'contents' },
  { id: 'grid', icon: 'grid', label: 'pagesGrid' },
  { id: 'goToPage', icon: 'target', label: 'goToPage' },
  { id: 'zoomOut', icon: 'zoomOut', label: 'zoomOut' },
  { id: 'zoomIn', icon: 'zoomIn', label: 'zoomIn' },
  { id: 'fitWidth', icon: 'fullscreen', label: 'fitWidth' },
  { id: 'ink', icon: 'pen', label: 'inkNotes' },
  { id: 'pageStrip', icon: 'images', label: 'pageStrip' },
  { id: 'info', icon: 'info', label: 'bookInfo' },
  { id: 'exportNotes', icon: 'download', label: 'exportNotes' },
  { id: 'exportAnki', icon: 'download', label: 'exportAnki' },
  { id: 'shareFile', icon: 'external', label: 'shareFile' },
  { id: 'convertFile', icon: 'convert', label: 'convertFile' },
  { id: 'savePageImage', icon: 'camera', label: 'savePageImage' },
  { id: 'sharePage', icon: 'external', label: 'sharePage' },
  { id: 'copyPageImage', icon: 'copy', label: 'copyPageImage' },
  { id: 'cutPagePart', icon: 'images', label: 'cutPagePart' },
  { id: 'savePagesRange', icon: 'images', label: 'savePagesRange' },
  { id: 'exportWithInk', icon: 'download', label: 'exportWithInk' },
  { id: 'print', icon: 'file', label: 'print' },
  { id: 'openWithApp', icon: 'external', label: 'openWithApp', need: 'android' },
  { id: 'toolExtract', icon: 'file', label: 'toolExtract' },
  { id: 'pdfTools', icon: 'grid', label: 'pdfTools' },
  { id: 'bookmark', icon: 'bookmarkAdd', label: 'addBookmark' },
  { id: 'noteOnPage', icon: 'note', label: 'noteOnPage' },
  { id: 'highlights', icon: 'note', label: 'notes' },
  { id: 'crop', icon: 'fullscreen', label: 'cropMargins' },
  { id: 'readInOrder', icon: 'sort', label: 'readInOrder' },
  { id: 'favorite', icon: 'heart', label: 'favorite' },
  { id: 'type', icon: 'type', label: 'visualOptions' },
  { id: 'readingBar', icon: 'eye', label: 'tapStatusLine' },
  { id: 'dayNight', icon: 'moon', label: 'tapDayNight' },
  { id: 'fullscreen', icon: 'fullscreen', label: 'fullscreen' },
  { id: 'bookmarks', icon: 'bookmark', label: 'bookmarks' },
];

/** A saved list made whole: unknown ids left out, each id once, places valid (and allowed for the action), every
 *  known action present — one missing (new since the list was saved) goes to «More», never lost. Separators kept
 *  only on the toolbar. */
export function normalizeButtons(saved: unknown, kind: 'flow' | 'pdf'): PlacedButton[] {
  const actions = kind === 'pdf' ? PDF_ACTIONS : FLOW_ACTIONS;
  const defaults = kind === 'pdf' ? DEFAULT_PDF_BUTTONS : DEFAULT_FLOW_BUTTONS;
  if (!Array.isArray(saved) || !saved.length) return defaults.map((x) => ({ ...x }));
  const known = new Map(actions.map((a) => [a.id, a]));
  const out: PlacedButton[] = []; const seen = new Set<string>();
  for (const x of saved as Partial<PlacedButton>[]) {
    if (!x || typeof x.id !== 'string' || seen.has(x.id)) continue;
    const at = BUTTON_PLACES.includes(x.at as ButtonPlace) ? x.at as ButtonPlace : 'more';
    if (isSep(x.id)) { if (kind === 'flow' && at === 'bar') { seen.add(x.id); out.push({ id: x.id, at }); } continue; }
    const a = known.get(x.id); if (!a) continue;
    seen.add(x.id);
    out.push({ id: x.id, at: a.only && !a.only.includes(at) ? (defaults.find((d) => d.id === x.id)?.at ?? 'hidden') : at });
  }
  for (const d of defaults) if (!seen.has(d.id) && !isSep(d.id)) { const a = known.get(d.id); out.push({ id: d.id, at: a?.only && !a.only.includes('more') ? d.at : 'more' }); }
  return out;
}

/** The ids in one place, in order. */
export const idsAt = (list: readonly PlacedButton[], at: ButtonPlace): string[] => list.filter((x) => x.at === at).map((x) => x.id);

/** The ids on the toolbar in the old form (`readerToolbar`): kept up to date with the new lists, for a version
 *  before them reading the same settings (a backup, sync). */
export function toolbarOf(list: readonly PlacedButton[]): string[] {
  return [...list.filter((x) => x.at === 'bar').map((x) => (isSep(x.id) ? 'sep' : x.id)), 'more'];
}
