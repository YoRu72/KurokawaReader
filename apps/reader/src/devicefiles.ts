// A book's ORIGINAL file, outside the app — what «Also delete the file from the device» (the library's delete dialog,
// src/ui/deletebooks.ts) may delete. Which books have one, and whether this app may delete it:
//  - a book with no `source` is the app's own copy, kept in its database: removing the book from the library already
//    deletes that copy (db.deleteBook); there is no other file of the app's to delete.
//  - Android (KurokawaPlugin.java canDeleteDocument / deleteDocument): a file found by «Pick a folder» (a document of a
//    folder granted with write access, SAF tree URI) — DocumentsContract.deleteDocument; a file found by the whole-device
//    or Download scan (a file:// path, read with «All files access») — deleted when that access lets the app write
//    there (Android 11 and later; before, the app only reads); a file picked one by one, or opened from another app
//    (a content:// URI): only when that app granted writing and the document can be deleted — older picks and most
//    «Open with» handed over reading alone. Deleted for good: Android's own trash is for media the system indexes,
//    not for these documents.
//  - iOS (KurokawaPlugin.swift): a file of a folder picked in Files (security-scoped bookmark) — removed for good.
//  - A computer (the Tauri shell's kr_trash_file, Electron's shell.trashItem): a file linked by its path — moved to the
//    Recycle Bin / Trash, never erased.
//  - A plain web page: never (it holds copies only).
import type { Book } from './db';
import { shellOf } from './platform';

/** own: the app's copy (removed with the book); can: the original may be deleted; cannot: it may not (why). */
export type OriginalState = { kind: 'own' } | { kind: 'can' } | { kind: 'cannot'; why: 'readonly' | 'gone' };
type DocPlug = {
  canDeleteDocument?(o: { uri: string; tree?: string }): Promise<{ can: boolean; gone?: boolean }>;
  deleteDocument?(o: { uri: string; tree?: string }): Promise<{ deleted: boolean; gone?: boolean }>;
};
type DeskTrash = { trashFile?(p: string): Promise<{ ok: boolean; gone?: boolean; error?: string }>; platform?: string };
const plug = (): DocPlug | undefined => (window as unknown as { Capacitor?: { Plugins?: { Kurokawa?: DocPlug } } }).Capacitor?.Plugins?.Kurokawa;
const desk = (): DeskTrash | undefined => (window as unknown as { kurokawaDesktop?: DeskTrash }).kurokawaDesktop;

/** Whether a book's original can be deleted here (asked of the platform once per book). */
export async function originalState(b: Book): Promise<OriginalState> {
  const src = b.source;
  if (!src || (!src.uri && !src.path)) return { kind: 'own' };
  const shell = shellOf();
  if (shell === 'desktop') return src.path && desk()?.trashFile ? { kind: 'can' } : { kind: 'cannot', why: 'readonly' };
  if ((shell === 'android' || shell === 'ios') && src.uri && plug()?.canDeleteDocument) {
    try { const r = await plug()!.canDeleteDocument!({ uri: src.uri, ...(src.tree ? { tree: src.tree } : {}) }); return r?.can ? { kind: 'can' } : { kind: 'cannot', why: r?.gone ? 'gone' : 'readonly' }; }
    catch { return { kind: 'cannot', why: 'readonly' }; }
  }
  return { kind: 'cannot', why: 'readonly' };
}

/** The original deleted (a computer: moved to the Recycle Bin / Trash). `gone`: it was no longer there (counted as done). */
export async function deleteOriginal(b: Book): Promise<{ ok: boolean; gone?: boolean; error?: string }> {
  const src = b.source;
  if (!src) return { ok: true };
  try {
    if (shellOf() === 'desktop') {
      if (!src.path || !desk()?.trashFile) return { ok: false, error: 'unsupported' };
      const r = await desk()!.trashFile!(src.path); return { ok: !!r?.ok || !!r?.gone, gone: !!r?.gone, error: r?.error };
    }
    if (!src.uri || !plug()?.deleteDocument) return { ok: false, error: 'unsupported' };
    const r = await plug()!.deleteDocument!({ uri: src.uri, ...(src.tree ? { tree: src.tree } : {}) });
    return { ok: !!r?.deleted || !!r?.gone, gone: !!r?.gone };
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

/** Where the original lies, for the reader to find it (a path, or the document's address). */
export function whereIs(b: Book): string {
  const s = b.source; if (!s) return '';
  if (s.path) return s.path;
  try { return decodeURIComponent(s.uri ?? ''); } catch { return s.uri ?? ''; }
}

/** What happens to the deleted original on this platform: a computer's bin, or gone for good. */
export function binWord(): 'win' | 'mac' | 'linux' | 'none' {
  if (shellOf() !== 'desktop') return 'none';
  const p = desk()?.platform; return p === 'win32' ? 'win' : p === 'darwin' ? 'mac' : 'linux';
}
