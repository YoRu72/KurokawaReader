// Undo and redo, one small mechanism for the whole app.
//
//  - `offerUndo(label, undo, redo?)`: after something was taken away or overwritten — a highlight removed, a note
//    deleted, a glossary term gone — the snackbar says so with «Undo»; undone, it offers «Redo».
//  - Each is kept, for this session only, in a short history (the last HISTORY), with the view it was done in: on a
//    computer Ctrl+Z (⌘Z) undoes the last one done in the view open, Ctrl+Shift+Z or Ctrl+Y redoes it — never while
//    a text field has the keys (its own undo is the browser's). An entry whose thing is gone (its book closed, its
//    list deleted) says so with `alive`, and is passed over and dropped.
//  - A part of the app with an undo history of its own (the ink on a PDF, the reading options) pushes a scope while
//    it is open: the keys go to it first.
//
// Sync (src/sync.ts) and deletions: a deleted highlight, note, bookmark or pin is tombstoned at once (as before) —
// the tombstone is the deletion, and goes out with the next sync, even one in the middle of the snackbar's time.
// Undo then puts the thing back under a NEW id (its contents, place and creation time kept): no device has a
// tombstone for that id, so every device takes it as new and keeps it, whatever was synced in between; the old id
// stays deleted everywhere. (Keeping the id and holding the tombstone back would not do: a sync during the snackbar
// would bring the remote copy back here — and an Undo pressed after a sync, with Ctrl+Z, would meet a tombstone.)
// A note's text is not deleted but changed: its undo is a new edit, stamped later (stampAfter), which wins.
// Books deleted from the library are the exception — HELD, not removed (src/ui/deletebooks.ts): nothing is written
// until the snackbar ends (or the next deletion, or the app put away), so a sync meanwhile sees the book unchanged and
// sends no deletion — book deletions were never tombstoned —, and Undo only lets go of the hold. The library's pins
// (src/ui/pinmenu.ts) are not synced; its folder moves (src/ui/moveundo.ts) are undone and redone as later moves.
import { toast } from './dom';
import { t } from '../i18n';
import { fits } from '../platform';

export interface UndoEntry {
  label: string;
  undo: () => unknown;
  redo?: () => unknown;
  /** The view it was done in (the route's path); Ctrl+Z acts on the entries of the view open. */
  view: string;
  /** Whether what it undoes is still there to act on. */
  alive?: () => boolean;
  /** Its snackbar's time and end (offerUndo's `opts`): the first one's, and again each time a Redo offers «Undo». */
  ms?: number;
  onEnd?: (undone: boolean) => void;
}
export interface UndoScope { undo(): boolean; redo(): boolean }

const HISTORY = 30;
const done: UndoEntry[] = [];
const undone: UndoEntry[] = [];
const scopes: UndoScope[] = [];

const viewNow = (): string => (location.hash || '#/').replace(/\?.*$/, '');
const live = (e: UndoEntry) => { try { return e.alive ? e.alive() : true; } catch { return false; } };

/** Says what was done, with «Undo»; keeps it for Ctrl+Z. `opts.onEnd(undone)`: once the snackbar goes (and once more
 *  each time a Redo shows «Undo» again — the library's deletion held anew: src/ui/deletebooks.ts). */
export function offerUndo(label: string, undo: () => unknown, redo?: () => unknown, opts: { alive?: () => boolean; ms?: number; onEnd?: (undone: boolean) => void } = {}): UndoEntry {
  const e: UndoEntry = { label, undo, redo, view: viewNow(), alive: opts.alive, ms: opts.ms, onEnd: opts.onEnd };
  done.push(e); if (done.length > HISTORY) done.shift();
  undone.length = 0;
  snack(e);
  return e;
}
const snack = (e: UndoEntry) => toast(e.label, 'info', { ms: e.ms, action: { label: t('undo'), run: () => void undoEntry(e) }, onEnd: e.onEnd ? (acted) => e.onEnd!(acted) : undefined });

/** Undo this entry (from its snackbar, or the last of the view with Ctrl+Z). */
export async function undoEntry(e: UndoEntry): Promise<void> {
  const i = done.lastIndexOf(e); if (i < 0) return;
  done.splice(i, 1);
  if (!live(e)) return;
  await e.undo();
  if (e.redo) { undone.push(e); toast(t('undoneThing', { what: e.label }), 'info', { action: { label: t('redo'), run: () => void redoEntry(e) } }); }
  else toast(t('undoneThing', { what: e.label }));
}
export async function redoEntry(e: UndoEntry): Promise<void> {
  const i = undone.lastIndexOf(e); if (i < 0 || !e.redo) return;
  undone.splice(i, 1);
  if (!live(e)) return;
  await e.redo();
  done.push(e);
  snack(e);
}

/** The last entry of the view open, the dead ones dropped on the way. */
function lastOf(list: UndoEntry[]): UndoEntry | undefined {
  const v = viewNow();
  for (let i = list.length - 1; i >= 0; i--) { const e = list[i]; if (e.view !== v) continue; if (!live(e)) { list.splice(i, 1); continue; } return e; }
  return undefined;
}
export function undoLast(): boolean { const e = lastOf(done); if (!e) return false; void undoEntry(e); return true; }
export function redoLast(): boolean { const e = lastOf(undone); if (!e) return false; void redoEntry(e); return true; }

/** A part with an undo of its own takes the keys while open; returns its release. */
export function pushUndoScope(s: UndoScope): () => void {
  scopes.push(s);
  return () => { const i = scopes.lastIndexOf(s); if (i >= 0) scopes.splice(i, 1); };
}

/** For tests and the views: what is there to undo here. */
export const undoState = () => ({ done: done.map((e) => e.label), undone: undone.map((e) => e.label) });
/** The history of one thing forgotten (its book closed): `match` tells its entries. */
export function forgetUndo(match: (e: UndoEntry) => boolean): void {
  for (const list of [done, undone]) for (let i = list.length - 1; i >= 0; i--) if (match(list[i])) list.splice(i, 1);
}

/** A field where Ctrl+Z is the browser's own undo of what is typed. */
function typing(el: EventTarget | null): boolean {
  const x = el as HTMLElement | null;
  if (!x || !x.tagName) return false;
  if (x.isContentEditable) return true;
  if (x.tagName === 'TEXTAREA' || x.tagName === 'SELECT') return true;
  if (x.tagName !== 'INPUT') return false;
  return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes((x as HTMLInputElement).type);
}

/** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, on a computer. */
export function undoKey(e: KeyboardEvent): 'undo' | 'redo' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && !e.shiftKey) return 'redo';
  return null;
}
/** The keys' names for a button's tooltip on a computer (nothing on a phone: it has no keys). */
export function keyHint(what: 'undo' | 'redo'): string {
  if (!fits('computer')) return '';
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  return what === 'undo' ? (mac ? '⌘Z' : 'Ctrl+Z') : (mac ? '⇧⌘Z' : 'Ctrl+Y');
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    const what = undoKey(e); if (!what || e.defaultPrevented || !fits('computer') || typing(e.target)) return;
    for (let i = scopes.length - 1; i >= 0; i--) { const s = scopes[i]; if (what === 'undo' ? s.undo() : s.redo()) { e.preventDefault(); e.stopPropagation(); return; } }
    if (what === 'undo' ? undoLast() : redoLast()) { e.preventDefault(); e.stopPropagation(); }
  });
  (window as unknown as { __krUndo?: unknown }).__krUndo = { state: undoState };
}
