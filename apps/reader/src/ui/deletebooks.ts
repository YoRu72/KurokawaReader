// The library's delete confirmation (src/views/library.ts: the selection bar, a computer's right-click menu, the Delete
// key, a book's details): what goes — the books, with their progress, bookmarks, notes and highlights, as before —
// and, where this app can honour it, a box «Also delete the file from the device / computer» for the ORIGINAL files
// outside the app (src/devicefiles.ts says which). The box is shown only when at least one chosen book's original
// can be deleted, starts unticked and is never remembered. Counts say how many can and cannot, and why, in one line.
//
// Undo: with the box unticked nothing is lost yet — the books are HELD (hidden from the library) while the snackbar's
// «Undo» shows, and removed for real when it ends, when another deletion comes, or when the app is put away; «Undo»
// (or Ctrl+Z on a computer) brings them back exactly as they were, since nothing was changed. With the box ticked the
// books are removed at once: on a computer the originals went to the Recycle Bin / Trash (said so; no Undo — the shell
// cannot bring a file back from there reliably), on a phone they are gone for good (the dialog said so).
// An original that could not be deleted is said in a snackbar, with a button that shows where each one lies (one
// already gone counts as deleted). There are no watched folders that would bring a book back: the device's shelf only
// lists what lies there, to import by hand.
import { h, icon, openSheet, toast } from './dom';
import { t, getLang, localDigits } from '../i18n';
import type { Book } from '../db';
import { originalState, deleteOriginal, whereIs, binWord, type OriginalState } from '../devicefiles';
import { onPhone } from '../platform';
import { offerUndo } from './undo';

const cnt = (n: number) => (getLang() === 'ar' ? localDigits(n, 'prose') : String(n));
/** How long a deletion is held, and its «Undo» shown (ms). */
export const UNDO_MS = 10000;

/* ---------- the snackbar with an action («Show»): the app's own toast with its action (src/ui/dom.ts) ---------- */
function actionSnack(msg: string, action: string | null, onAction: (() => void) | null, ms = UNDO_MS, kind: 'info' | 'error' = 'info'): void {
  toast(msg, kind, { ...(action && onAction ? { action: { label: action, run: onAction } } : {}), ms });
}

/* ---------- books held before they are removed ---------- */
let pending: { ids: string[]; timer: number; commit: () => Promise<void> } | null = null;
/** The books held for «Undo» (the library leaves them out). */
export function heldBooks(): Set<string> { return new Set(pending?.ids ?? []); }
/** The held books removed now. */
export async function commitHeld(): Promise<void> {
  const p = pending; if (!p) return;
  pending = null; window.clearTimeout(p.timer);
  await p.commit();
}
/** Books held for `ms`, then removed; `cancel` (Undo) keeps them, true when it came in time; `held`: still waiting. */
export function holdRemoval(ids: string[], remove: (ids: string[]) => Promise<void>, ms = UNDO_MS): { cancel: () => boolean; held: () => boolean } {
  void commitHeld();
  const p = { ids, timer: 0, commit: () => remove(ids) };
  // (Removed when the snackbar ends untouched — offerUndo's onEnd —; this timer only in case it is taken away unseen.)
  p.timer = window.setTimeout(() => void commitHeld(), ms + 1000);
  pending = p;
  return { cancel: () => { if (pending !== p) return false; window.clearTimeout(p.timer); pending = null; return true; }, held: () => pending === p };
}
// (Put away — another app, the window closed —: what is held is removed, so a deletion asked for is never lost.)
addEventListener('pagehide', () => void commitHeld());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void commitHeld(); });

/** Ask, then remove `books` (`remove` does the library's part); true when they were removed or are held to be.
 *  `changed`: the list is to be drawn again (books held or given back). */
export async function deleteBooksDialog(books: Book[], remove: (ids: string[]) => Promise<void>, o: { changed?: () => void } = {}): Promise<boolean> {
  if (!books.length) return false;
  const states = new Map<string, OriginalState>(await Promise.all(books.map(async (b) => [b.id, await originalState(b)] as [string, OriginalState])));
  const of = (k: OriginalState['kind']) => books.filter((b) => states.get(b.id)!.kind === k);
  const own = of('own'), can = of('can'), cannot = of('cannot');
  const gone = cannot.filter((b) => { const s = states.get(b.id)!; return s.kind === 'cannot' && s.why === 'gone'; });
  const readonly = cannot.length - gone.length;
  const withNotes = books.filter((b) => b.highlights?.length || b.bookmarks?.length || b.pdfHighlights?.length || b.pins?.length || b.ink?.length).length;
  const pc = !onPhone();
  const n = books.length;
  const bin = binWord();

  return new Promise<boolean>((resolve) => {
    let result = false;
    const sh = openSheet(t('deleteBooksTitle'), t('cancel'), { onClose: () => resolve(result) });
    sh.el.classList.add('del-sheet');
    sh.body.style.fontFamily = 'var(--font-ui)';
    sh.body.append(h('p', { class: 'del-lead' }, n === 1 ? t('deleteOneLine', { title: books[0].title }) : t('deleteManyLine', { n: cnt(n) })));
    sh.body.append(h('p', { class: 'hint' }, n === 1 ? t('deleteGoesWithOne') : t('deleteGoesWith')));
    if (withNotes) sh.body.append(h('p', { class: 'hint warn' }, n === 1 ? t('deleteNotesOne') : t('deleteNotesMany', { n: cnt(withNotes) })));
    // (The app's own copies: deleted with the books — nothing to choose.)
    if (own.length && (can.length || cannot.length)) sh.body.append(h('p', { class: 'hint del-count', dataset: { count: 'own' } }, icon('books'), t('deleteOwnCount', { n: cnt(own.length) })));
    let box: HTMLInputElement | null = null;
    if (can.length) {
      box = h('input', { type: 'checkbox', class: 'del-box' }) as HTMLInputElement;
      const detail = bin === 'win' ? t('deleteToRecycleBin') : bin === 'mac' || bin === 'linux' ? t('deleteToTrash') : t('deleteForGood');
      // (The app's switch row — base.css .switch-row — not a native checkbox; off unless chosen.)
      sh.body.append(h('label', { class: 'switch-row del-opt' },
        h('span', { class: 'del-opt-text' }, h('b', null, pc ? t('deleteAlsoComputer') : t('deleteAlsoDevice')), h('small', null, detail)), box));
      if (cannot.length || own.length) sh.body.append(h('p', { class: 'hint del-count', dataset: { count: 'can' } }, icon('check'), t('deleteCanCount', { n: cnt(can.length) })));
    }
    if (readonly) sh.body.append(h('p', { class: 'hint del-count', dataset: { count: 'cannot' } }, icon('info'), can.length ? t('deleteCannotCount', { n: cnt(readonly) }) : t('deleteStayCount', { n: cnt(readonly) })));
    if (gone.length) sh.body.append(h('p', { class: 'hint del-count', dataset: { count: 'gone' } }, icon('info'), t('deleteGoneCount', { n: cnt(gone.length) })));
    const ids = books.map((b) => b.id);
    const go = h('button', { type: 'button', class: 'btn danger primary del-go', onclick: async () => {
      go.disabled = true;
      if (!box?.checked) {
        // Held, with «Undo» (src/ui/undo.ts: the snackbar, Ctrl+Z / Ctrl+Shift+Z on a computer): nothing is removed
        // until the snackbar ends — or the next deletion, or the app put away. Undone, the books were never touched;
        // redone, held again, with the snackbar again.
        result = true; sh.close();
        let hd = holdRemoval(ids, remove); let back = false;
        o.changed?.();
        offerUndo(t('deletedHeld', { n: cnt(n) }),
          () => { if (hd.cancel()) { back = true; o.changed?.(); } },
          () => { hd = holdRemoval(ids, remove); back = false; o.changed?.(); },
          { ms: UNDO_MS, alive: () => back || hd.held(), onEnd: (undone) => { if (!undone && hd.held()) void commitHeld(); } });
        return;
      }
      await commitHeld();
      const failed: Book[] = []; let done = 0;
      for (const b of can) { const r = await deleteOriginal(b); if (!r.ok) failed.push(b); else done++; }
      await remove(ids);
      result = true; sh.close(); o.changed?.();
      if (failed.length) failedSnack(failed);
      else if (done) actionSnack(bin === 'win' ? t('deletedToRecycleBin', { n: cnt(done) }) : bin === 'none' ? t('deletedFilesGone', { n: cnt(done) }) : t('deletedToTrash', { n: cnt(done) }), null, null, 4000);
    } }, icon('trash'), t('delete')) as HTMLButtonElement;
    sh.actions.append(h('button', { type: 'button', class: 'btn', onclick: () => sh.close() }, t('cancel')), go);
  });
}

/** A snackbar saying which originals could not be deleted, with a button that lists where they lie. */
function failedSnack(list: Book[]): void {
  actionSnack(t('deleteFilesFailed', { n: cnt(list.length) }), t('deleteFilesShow'), () => {
    const sh = openSheet(t('deleteFilesWhere'), t('close')); sh.body.style.fontFamily = 'var(--font-ui)';
    sh.body.append(h('p', { class: 'hint' }, t('deleteFilesWhy')), h('ul', { class: 'del-where' }, ...list.map((b) => h('li', null, h('b', { dir: 'auto' }, b.title), h('code', { dir: 'ltr' }, whereIs(b))))));
  }, 10000, 'error');
}
