// Tools' own: the theme gallery (the shared theme/gallery.ts, kept the same as the Reader's) with the «New» marks of the
// live catalogue added around it — on «Add themes» and on the rows of its list — and the themes shown there handed back
// as seen. Nothing here changes the shared file: the marks are put on what it draws.
import { themeGallery, el, type GalleryDeps } from './gallery';
import { loadIndex } from './packs';

export interface LiveGalleryDeps extends GalleryDeps {
  /** Themes of the repository's list the reader has not seen yet (marked «New»), and the ones just shown to them. */
  fresh(): Set<string>;
  shown(ids: string[]): void;
}

export function themeGalleryLive(d: LiveGalleryDeps): HTMLElement {
  const grid = themeGallery({ ...d, sheet: (title) => { const s = d.sheet(title); watchList(d, s.body); return s; } });
  const newMark = () => el('span', { class: 'tg-new' }, d.t('themeNew'));
  // («Add themes» carries the mark while some theme of the list is new and not here.)
  const mark = () => { const n = grid.querySelector('.tg-add .tg-name'); if (n && d.fresh().size && !n.querySelector('.tg-new')) n.append(newMark()); };
  new MutationObserver(mark).observe(grid, { childList: true, subtree: true });
  return grid;
}

/** The rows of the list in the sheet, in the list's order: «New» on those not seen, then all of them counted as shown
 *  (so the marks stay while the list is open and are gone the next time). */
function watchList(d: LiveGalleryDeps, body: HTMLElement): void {
  let busy = false;
  const run = async () => {
    const rows = [...body.querySelectorAll<HTMLElement>('.tg-addrow')];
    if (busy || !rows.length || rows.every((r) => r.dataset.id)) return;
    busy = true;
    try {
      const ix = (await loadIndex(d.io)).themes; const now = [...body.querySelectorAll<HTMLElement>('.tg-addrow')];
      if (now.length !== ix.length) return;
      const fresh = d.fresh();
      now.forEach((r, i) => { r.dataset.id = ix[i].id; if (fresh.has(ix[i].id)) r.querySelector('.grow > b')?.append(el('span', { class: 'tg-new' }, d.t('themeNew'))); });
      d.shown(ix.map((e) => e.id));
    } catch { /* the list stays as the gallery drew it */ } finally { busy = false; }
  };
  new MutationObserver(() => void run()).observe(body, { childList: true, subtree: true });
}
