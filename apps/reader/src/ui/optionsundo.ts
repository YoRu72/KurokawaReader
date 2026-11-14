// The reading options' history: every change made while the Visual Options are open (or the button bars' editor) —
// any control, sub-panel, preset, «Reset» — is a step that Undo takes back and Redo does again, several deep. Steps
// are caught at the one place settings are written (src/settings.ts updateSettings → watchSettings), so no control
// can be missed; a step is stored where it was written — the open book's own settings or the app's — and undone
// there, whatever the scope is now.
//  - What is changed within one task (a theme with its colours cleared, a colour with the saved theme that has it)
//    is one step; so is a drag (a slider, the colour wheel): from the press to the release.
//  - The history lasts the reading session: closed and opened again the options still have it; it is forgotten when
//    the book is closed (another opened, back to the library).
//  - Per option: the arrow beside its name (src/ui/options.ts) brings back the value it had before this session's
//    change, then the default, then the reader's own value again — each a step of the history too.
import { watchSettings, putSettingsBack, putBgFile, bgFile, getSettings, updateSettings, resetSettings, defaultOf, globalSettings, allBookSettings, type SettingsChange, type VisualSettings } from '../settings';
import { h, icon, toast } from './dom';
import { t } from '../i18n';
import { pushUndoScope, keyHint } from './undo';

interface Step { changes: SettingsChange[]; keys: string[]; at: number; label?: string; afterUndo?: () => void }
const MAX = 100;
const past: Step[] = [], future: Step[] = [];
/** Each key's value when this session first changed it, and the reader's own value put aside by a reset. */
const origin = new Map<string, unknown>(), mine = new Map<string, unknown>();
/** (Settings that change by themselves, not by the reader's hand: never steps.) */
const NOISE = new Set(['syncLastAt', 'syncDropboxRefresh']);
let open = 0, gesture = 0, merging: Step | null = null, applying = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

const keysOf = (c: SettingsChange): string[] => {
  const ks = new Set<string>(Object.keys(c.appBefore));
  for (const o of [c.bookBefore, c.bookAfter]) for (const k of Object.keys(o ?? {})) if (JSON.stringify((c.bookBefore ?? {} as Record<string, unknown>)[k as never]) !== JSON.stringify((c.bookAfter ?? {} as Record<string, unknown>)[k as never])) ks.add(k);
  if (c.file) ks.add('bgImage');
  // (The book given settings of its own, or its own taken away: a step too.)
  if (c.book && !c.bookBefore !== !c.bookAfter) ks.add('(bookScope)');
  return [...ks];
};
/** Whether the options (or the button bars' editor) are open now. */
export function optionsOpen(): boolean {
  if (open > 0) return true;
  if (document.querySelector('.buttons-sheet')) return true;
  const g = document.querySelector('.options-grid'); if (!g?.isConnected) return false;
  const panel = g.closest('.panel'); return !panel || panel.classList.contains('open');
}

watchSettings({
  change(c) {
    if (applying || !optionsOpen()) return;
    const keys = keysOf(c).filter((k) => !NOISE.has(k)); if (!keys.length) return;
    for (const k of keys) if (!origin.has(k)) origin.set(k, k === '(bookScope)' ? !!c.bookBefore : JSON.parse(JSON.stringify((c.seen as unknown as Record<string, unknown>)[k] ?? null)));
    future.length = 0;
    if (merging) { merging.changes.push(c); for (const k of keys) if (!merging.keys.includes(k)) merging.keys.push(k); }
    else {
      const s: Step = { changes: [c], keys, at: Date.now() };
      past.push(s); if (past.length > MAX) past.shift();
      merging = s;
      // (What follows in the same task joins it; a drag keeps it open until released.)
      queueMicrotask(() => { if (!gesture && merging === s) merging = null; });
    }
    changed();
  },
  book() { past.length = 0; future.length = 0; origin.clear(); mine.clear(); merging = null; gesture = 0; changed(); },
});
// A drag (src/ui/colorpicker.ts, the options' sliders) is one step: from its start to its end.
export function gestureStart(): void { gesture++; }
export function gestureEnd(): void { if (gesture) gesture--; if (!gesture) merging = null; }
document.addEventListener('kr:gesture', (e) => { if ((e as CustomEvent).detail === 'start') gestureStart(); else gestureEnd(); });
// (Any slider: pressed, it is a drag until let go — the options' own, and those of their sub-panels.)
document.addEventListener('pointerdown', (e) => { if ((e.target as HTMLInputElement | null)?.type === 'range' && optionsOpen()) gestureStart(); }, true);
const letGo = () => { if (gesture) { gesture = 0; merging = null; } };
window.addEventListener('pointerup', letGo, true); window.addEventListener('pointercancel', letGo, true);

async function apply(s: Step, which: 'before' | 'after'): Promise<void> {
  applying = true;
  try {
    const list = which === 'before' ? [...s.changes].reverse() : s.changes;
    for (const c of list) { if (c.file) await putBgFile(which === 'before' ? c.file.before : c.file.after); putSettingsBack(c, which); }
  } finally { applying = false; }
}
export const canUndo = (): boolean => past.length > 0;
/** How many steps there are (to tell whether an action made one). */
export const stepCount = (): number => past.length;
export const canRedo = (): boolean => future.length > 0;
export async function undoOptions(): Promise<boolean> {
  merging = null; const s = past.pop(); if (!s) return false;
  await apply(s, 'before'); future.push(s); s.afterUndo?.(); changed(); appliedNow(); return true;
}
export async function redoOptions(): Promise<boolean> {
  merging = null; const s = future.pop(); if (!s) return false;
  await apply(s, 'after'); past.push(s); changed(); appliedNow(); return true;
}
/** Told after an Undo or a Redo was applied — for what shows settings outside the options themselves (Settings →
 *  Appearance's style and page pair: src/views/settings.ts), so that it is drawn as they now are. */
const applied = new Set<() => void>();
const appliedNow = () => applied.forEach((f) => f());
export function onApplied(fn: () => void): () => void { applied.add(fn); return () => applied.delete(fn); }
/** The last step (to name it, or attach what its undo also does). */
export const lastStep = (): Step | undefined => past[past.length - 1];
export function onHistory(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
/** For the test: the steps' keys. */
export const historyState = () => ({ past: past.map((s) => [...s.keys]), future: future.map((s) => [...s.keys]) });
{ const w = window as unknown as { __krUndo?: Record<string, unknown> }; w.__krUndo = { ...(w.__krUndo ?? {}), options: historyState }; }

/* ---------- one option's arrow ---------- */
/** «This book only» as it was before this session changed it (undefined: not changed). */
export const scopeOrigin = (): boolean | undefined => (origin.has('(bookScope)') ? (origin.get('(bookScope)') as boolean) : undefined);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** What the arrow beside an option does now: bring back its value before this session's change, its default, or the
 *  reader's own value put aside by that default — or nothing. */
export function arrowFor(key: keyof VisualSettings): 'undo' | 'reset' | 'mine' | null {
  const cur = getSettings()[key];
  if (origin.has(key) && !same(cur, origin.get(key))) return 'undo';
  if (!same(cur, defaultOf(key))) return 'reset';
  if (mine.has(key) && !same(cur, mine.get(key))) return 'mine';
  return null;
}
export function arrowAct(key: keyof VisualSettings): void {
  const act = arrowFor(key); const cur = getSettings()[key];
  if (act === 'undo') updateSettings({ [key]: origin.get(key) } as Partial<VisualSettings>);
  else if (act === 'reset') { mine.set(key, JSON.parse(JSON.stringify(cur ?? null))); updateSettings({ [key]: defaultOf(key) } as Partial<VisualSettings>); }
  else if (act === 'mine') updateSettings({ [key]: mine.get(key) } as Partial<VisualSettings>);
}

/** «Reset» of every reading option: one step; the background picture is kept until the snackbar's time is over
 *  (its Undo brings everything back, the picture too), and kept in memory for an undo after that. */
export async function resetAllOptions(after: () => void): Promise<void> {
  const blob = await bgFile();
  merging = null; gestureStart(); const n = past.length;
  try { resetSettings(); } finally { gestureEnd(); }
  const s = past.length > n ? lastStep() : undefined;
  if (s && blob) { const c = s.changes[0]; c.file = { before: blob, after: null }; if (!s.keys.includes('bgImage')) s.keys.push('bgImage'); }
  after();
  // (The picture's file goes when no settings use it any longer — the app's, or a book's of its own.)
  const unused = () => !globalSettings().bgImage && !Object.values(allBookSettings()).some((b) => b.bgImage);
  toast(t('optionsReset'), 'info', { action: { label: t('undo'), run: () => { if (lastStep() === s) void undoOptions().then(after); } }, onEnd: (acted) => { if (!acted && blob && unused()) void putBgFile(null); } });
}
/** A snackbar for a step that changes much at once (a preset, a theme deleted): its Undo is that step's. */
export function offerOptionsUndo(label: string, after: () => void, before = -1): void {
  if (before >= 0 && past.length <= before) return;
  const s = lastStep(); if (!s) return;
  toast(label, 'info', { action: { label: t('undo'), run: () => { if (lastStep() === s) void undoOptions().then(after); } } });
}

/** Undo and Redo buttons for a head (the options' panel, the button bars' sheet); `after` redraws what shows them.
 *  While they are on the page Ctrl+Z / Ctrl+Y (a computer) are theirs. */
export function historyButtons(after: () => void): HTMLElement {
  const label = (what: 'undo' | 'redo') => { const k = keyHint(what); return t(what) + (k ? ` (${k})` : ''); };
  const mk = (what: 'undo' | 'redo') => h('button', { type: 'button', class: 'icon-btn' + (what === 'undo' ? ' undo-btn' : ''), title: label(what), 'aria-label': t(what), 'data-icon': what, onclick: () => void (what === 'undo' ? undoOptions() : redoOptions()).then((ok) => { if (ok) after(); }) }, icon('undo'));
  const u = mk('undo'), r = mk('redo');
  const box = h('div', { class: 'opt-history', role: 'group', 'aria-label': t('optionsHistory') }, u, r);
  const paint = () => { u.disabled = !canUndo(); r.disabled = !canRedo(); };
  paint();
  const off = onHistory(() => { if (!box.isConnected) { off(); release(); return; } paint(); });
  const release = pushUndoScope({
    undo: () => { if (!box.isConnected) { off(); release(); return false; } if (!optionsOpen()) return false; void undoOptions().then((ok) => { if (ok) after(); }); return true; },
    redo: () => { if (!box.isConnected) { off(); release(); return false; } if (!optionsOpen()) return false; void redoOptions().then((ok) => { if (ok) after(); }); return true; },
  });
  // (Gone from the page: its keys let go — checked when the history moves, and when the keys are pressed.)
  return box;
}
