// Tools' own: the theme gallery (the shared theme/gallery.ts, kept the same as the Reader's) with the «New» marks of the
// live catalogue added around it — on «Add themes» and on the rows of its list — and the themes shown there handed back
// as seen. Nothing here changes the shared file: the marks are put on what it draws.
import { themeGallery, el, type GalleryDeps } from './gallery';
import { loadIndex } from './packs';

export interface LiveGalleryDeps extends GalleryDeps {
  /** Themes of the repository's list the reader has not seen yet (marked «New»), and the ones just shown to them. */
  fresh(): Set<string>;
  shown(ids: string[]): void;
  /** The sheet, told when it goes (however it was closed): its watcher is let go then. */
  sheet(title: string, onClose?: () => void): { body: HTMLElement; close(): void };
}

/** The watchers of the gallery on the page (one Appearance card at a time): a new gallery lets the former grid's go, a
 *  sheet's goes as it closes, the settings page takes its own with it, and a watcher that finds its element gone lets
 *  itself go — nothing of them is left once the card or the sheet is closed. */
const live = new Map<MutationObserver, HTMLElement>();
const watch = (target: HTMLElement, f: () => void): MutationObserver => {
  const mo = new MutationObserver(() => { if (!target.isConnected) { drop(mo); return; } f(); });
  mo.observe(target, { childList: true, subtree: true }); live.set(mo, target); return mo;
};
const drop = (mo: MutationObserver | undefined): void => { if (!mo) return; mo.disconnect(); live.delete(mo); };
/** The watchers inside `within` let go (the settings page closed). */
export function releaseGalleryLive(within: Element): void { for (const [mo, el] of [...live]) if (within.contains(el)) drop(mo); }
let gridMo: MutationObserver | undefined;

export function themeGalleryLive(d: LiveGalleryDeps): HTMLElement {
  drop(gridMo);
  const grid = themeGallery({ ...d, sheet: (title) => { let mo: MutationObserver | undefined; const s = d.sheet(title, () => drop(mo)); mo = watchList(d, s.body); return s; } });
  const newMark = () => el('span', { class: 'tg-new' }, d.t('themeNew'));
  // («Add themes» carries the mark while some theme of the list is new and not here.)
  const mark = () => { const n = grid.querySelector('.tg-add .tg-name'); if (n && d.fresh().size && !n.querySelector('.tg-new')) n.append(newMark()); };
  gridMo = watch(grid, mark);
  return grid;
}

/** The rows of the list in the sheet, in the list's order: «New» on those not seen, then all of them counted as shown
 *  (so the marks stay while the list is open and are gone the next time). */
function watchList(d: LiveGalleryDeps, body: HTMLElement): MutationObserver {
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
  return watch(body, () => void run());
}
