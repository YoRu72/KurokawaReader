// «Undo» for books moved between folders in the library (src/views/library.ts moveBooks: dropped on a folder's card or
// chip, or «Move to folder», one book or many) — each put back in the folder it was in, or in none. Undone and redone
// as later moves (src/library.ts moveToFolder stamps them), so sync takes them as the newest. Loaded when first used.
import { t, localDigits } from '../i18n';
import { moveToFolder } from '../library';
import { offerUndo } from './undo';

/** `was`: each moved book's folder before (null: none); `to`: where they went, `name` its name; `reread`: the library
 *  open read again. */
export function offerMoveUndo(was: Map<string, string | null>, to: string | null, name: string, reread: () => void): void {
  const moved = [...was.keys()];
  const back = async () => { for (const f of new Set(was.values())) await moveToFolder(moved.filter((id) => was.get(id) === f), f); reread(); };
  const n = localDigits(moved.length, 'prose');
  offerUndo(to ? t('movedToFolderToast', { name, n }) : t('movedOutToast', { n }), back, async () => { await moveToFolder(moved, to); reread(); });
}
