// Undo and Redo, the same everywhere: an action that can be taken back offers it in a snackbar («Undo», for a
// while longer than a plain message), then «Redo» once undone. The actions of this session are kept (a few dozen,
// the oldest let go), each with the place it was done in, so a computer's Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y take back
// (and bring again) the last one of the page in front — never while a text field is being typed in, where the field
// has its own. An action that cannot be taken back once done (a file deleted, a change sent away) is held instead:
// done for real only when its chance to be undone is over (`commit`). An editor with a stack of its own (the
// subtitle workshop) takes the keys first while it is open (`undoScope`).
import { h, icon, openSheet, toast } from './dom';
import { t } from '../i18n';
import { placePill, swipeAway } from './pill';

type Fn = () => unknown;
interface Entry { label: string; undo: Fn; redo?: Fn; commit?: Fn; scope: string; state: 'done' | 'undone'; at: number; timer?: number; /** A held action's deadline (the clock's ms). */ until?: number; sticky?: boolean }
export interface UndoOpts {
  /** Held: what really happens when the chance to undo is over (the snackbar's time, the page left). */
  commit?: Fn;
  /** How long the snackbar (and a held action's chance) lasts; 0: until dismissed by hand. */
  ms?: number;
  /** The page the action belongs to, when not the one in front (the player's sheets: 'player'; '*': any page). */
  scope?: string;
}
const MAX = 40; const WAIT = 7000;
const entries: Entry[] = []; let seq = 0;
const isPc = (): boolean => document.documentElement.classList.contains('pc');
/** The page in front: the player when it is open, else the route (its query aside). */
export function scopeNow(): string {
  if (document.querySelector('.kt-player')) return 'player';
  return location.hash.replace(/^#/, '').split('?')[0] || '/';
}
const fail = (e: unknown) => toast(String((e as Error)?.message ?? e), 'error', 5000);
const run = async (f: Fn | undefined): Promise<boolean> => { try { await f?.(); return true; } catch (e) { fail(e); return false; } };

/* ---------- the snackbar ---------- */
// (Its time is a deadline on the clock, not only a timer: a phone's web view put in the background stops or slows its
// timers, so the deadline is looked at again whenever the page is seen again — and four times a second while the
// pill is up, which also keeps it above the bars along the bottom as they come and go. It can always be closed: its ×
// (48 px) or a swipe aside; closing a held action does it then, exactly once.)
let snack: { el: HTMLElement; tick: number; until: number; entry: Entry } | null = null;
function hideSnack(): void { pausedAtLast = false; if (!snack) return; window.clearInterval(snack.tick); snack.el.remove(); snack = null; }
/** The snackbar closed by hand (its ×, a swipe): a held action is done now; an Undo offer simply ends. */
function closeSnack(e: Entry): void { if (snack?.entry === e) hideSnack(); if (e.state === 'done' && e.commit) void settle(e); }
function showSnack(e: Entry, mode: 'undo' | 'redo', ms: number): void {
  hideSnack(); wireClock();
  // (A plain message on the screen gives way: what it said is this action's own line now.)
  document.querySelectorAll('.toast:not(.undo-snack)').forEach((x) => x.remove());
  const pc = isPc(); const key = mode === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z';
  const act = h('button', { type: 'button', class: 'toast-act', title: pc ? `${mode === 'undo' ? t('undoAct') : t('redoAct')} (${key})` : null, onclick: () => void (mode === 'undo' ? undoEntry(e) : redoEntry(e)) }, mode === 'undo' ? t('undoAct') : t('redoAct'));
  const el = h('div', { class: 'toast with-action undo-snack' + (e.scope === 'player' ? ' in-player' : ''), role: 'status', 'data-mode': mode },
    h('span', { class: 'grow', dir: 'auto' }, mode === 'undo' ? e.label : t('undoneMsg')), act,
    pc ? h('kbd', { class: 'undo-key', dir: 'ltr' }, key) : null,
    h('button', { type: 'button', class: 'toast-x', 'aria-label': t('dismiss'), title: t('dismiss'), onclick: () => closeSnack(e) }, icon('close')));
  swipeAway(el, () => closeSnack(e));
  document.body.appendChild(el);
  const tick = window.setInterval(() => { sweep(); if (snack?.el === el) placePill(el); }, 250);
  snack = { el, entry: e, tick, until: ms ? Date.now() + ms : Infinity }; lastTick = Date.now(); pausedAtLast = false;
  placePill(el); requestAnimationFrame(() => placePill(el));
}

/* ---------- the history ---------- */
function drop(e: Entry): void { const i = entries.indexOf(e); if (i >= 0) entries.splice(i, 1); if (snack?.entry === e) hideSnack(); }
/** A held action done for real, once; it cannot be taken back after this. */
async function settle(e: Entry): Promise<void> { window.clearTimeout(e.timer); e.until = undefined; const c = e.commit; e.commit = undefined; drop(e); if (c) await run(c); }
function arm(e: Entry, ms: number): void { window.clearTimeout(e.timer); e.until = undefined; if (e.commit && ms) { e.until = Date.now() + ms; e.timer = window.setTimeout(sweep, ms + 20); } }
/** Whatever's time is over goes now: held actions done, the snackbar gone (a timer late or never run changes nothing). */
// (The snackbar's time runs only while it is SEEN: behind a sheet opened after it, or with the page hidden, it stands
// still, and seen again it has what was left — 3 s at least. The time between two looks counts as the first look
// found it.)
let lastTick = 0; let pausedAtLast = false;
function sweep(): void {
  const now = Date.now(); const s = snack;
  if (s) {
    const e = s.entry; const paused = document.visibilityState === 'hidden' || s.el.classList.contains('behind-sheet');
    if (pausedAtLast && lastTick) {
      const dt = Math.max(0, now - lastTick); if (s.until !== Infinity) s.until += dt; if (e.until !== undefined) e.until += dt;
      if (!paused) { const min = now + 3000; if (s.until !== Infinity && s.until < min) s.until = min; if (e.until !== undefined && e.until < min) e.until = min; }
      if (e.until !== undefined) { window.clearTimeout(e.timer); e.timer = window.setTimeout(sweep, Math.max(0, e.until - now) + 20); }
    }
    pausedAtLast = paused; lastTick = now;
  }
  for (const e of [...entries]) if (e.commit && e.state === 'done' && e.until !== undefined && e.until <= now) void settle(e);
  if (snack && snack.until <= now) hideSnack();
}
let clockWired = false;
function wireClock(): void {
  if (clockWired) return; clockWired = true;
  const seenAgain = () => sweep(); // (hidden too: from then on its time stands still)
  document.addEventListener('visibilitychange', seenAgain); addEventListener('focus', seenAgain); addEventListener('pageshow', seenAgain); document.addEventListener('resume', seenAgain);
  // (Another page: its snackbar does not follow — a held action of the page left is done then, as its comment says.)
  addEventListener('hashchange', () => {
    const s = snack; if (!s) return; const e = s.entry;
    if (e.scope === '*' || e.scope === 'player' || e.sticky || e.scope === scopeNow()) return;
    if (e.commit && e.state === 'done') void settle(e); else hideSnack();
  });
}

/** Offers «Undo» for what was just done: `undo` takes it back exactly, `redo` (when given) does it again.
 *  With `opts.commit` the action is only held (shown done) until its chance is over. */
export function offerUndo(label: string, undo: Fn, redo?: Fn, opts: UndoOpts = {}): void {
  const scope = opts.scope ?? scopeNow(); const ms = opts.ms ?? WAIT;
  // (A new action: what was undone in the same page cannot be brought again over it.)
  for (const x of entries.filter((y) => y.scope === scope && y.state === 'undone')) drop(x);
  const e: Entry = { label, undo, redo, commit: opts.commit, scope, state: 'done', at: ++seq, sticky: opts.ms === 0 };
  entries.push(e);
  while (entries.length > MAX) { const old = entries[0]; if (old.commit) void settle(old); else entries.shift(); }
  arm(e, ms); showSnack(e, 'undo', ms);
}
async function undoEntry(e: Entry): Promise<void> {
  if (e.state !== 'done' || !entries.includes(e)) return;
  window.clearTimeout(e.timer); e.until = undefined; e.state = 'undone'; e.at = ++seq;
  if (!(await run(e.undo))) { drop(e); return; }
  if (e.redo) showSnack(e, 'redo', WAIT); else { drop(e); hideSnack(); toast(t('undoneMsg')); }
}
async function redoEntry(e: Entry): Promise<void> {
  if (e.state !== 'undone' || !e.redo || !entries.includes(e)) return;
  e.state = 'done'; e.at = ++seq;
  if (!(await run(e.redo))) { drop(e); return; }
  arm(e, WAIT); showSnack(e, 'undo', WAIT);
}
/** The page's last action taken back (true when there was one). */
export function undoLast(scope = scopeNow()): boolean {
  const e = entries.filter((x) => (x.scope === scope || x.scope === '*') && x.state === 'done').sort((a, b) => b.at - a.at)[0];
  if (!e) return false; void undoEntry(e); return true;
}
/** The page's last undone action done again (true when there was one). */
export function redoLast(scope = scopeNow()): boolean {
  const e = entries.filter((x) => (x.scope === scope || x.scope === '*') && x.state === 'undone' && x.redo).sort((a, b) => b.at - a.at)[0];
  if (!e) return false; void redoEntry(e); return true;
}
/** Everything held done now (the app going away) — but what waits to be dismissed by hand. */
export function settleAll(): void { for (const e of [...entries]) if (e.commit && e.state === 'done' && !e.sticky) void settle(e); }

/* ---------- an editor's own stack, first while it is open ---------- */
const scopes: ((op: 'undo' | 'redo') => boolean)[] = [];
/** While open, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y go to `fn` first (true: it took them). Returns its removal. */
export function undoScope(fn: (op: 'undo' | 'redo') => boolean): () => void {
  scopes.push(fn); return () => { const i = scopes.lastIndexOf(fn); if (i >= 0) scopes.splice(i, 1); };
}
const typing = (el: Element | null): boolean => !!el && ((el as HTMLElement).isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset|file|color)$/i.test((el as HTMLInputElement).type)));
let wired = false;
/** A computer's keys: Ctrl+Z undo; Ctrl+Shift+Z and Ctrl+Y redo (⌘ on a Mac). */
export function wireUndoKeys(): void {
  if (wired) return; wired = true;
  addEventListener('pagehide', settleAll);
  window.addEventListener('keydown', (e) => {
    if (!isPc() || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase(); const op = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' && !e.shiftKey ? 'redo' : null;
    if (!op || typing(e.target as Element) || typing(document.activeElement)) return;
    let took = false;
    for (let i = scopes.length - 1; i >= 0 && !took; i--) took = scopes[i](op);
    if (!took) took = op === 'undo' ? undoLast() : redoLast();
    // (Taken or not, the key is the app's: the page's own undo would do nothing sensible here.)
    e.preventDefault(); e.stopPropagation();
  }, true);
}

/* ---------- asking first ---------- */
/** A question before something that cannot be taken back: true when the reader went on. */
export function confirmSheet(title: string, lines: (string | HTMLElement)[], ok: string, danger = true): Promise<boolean> {
  return new Promise((done) => {
    let answered = false; const sh = openSheet(title, t('cancel'), { stack: true, onClose: () => { if (!answered) done(false); } }); sh.el.classList.add('confirm-sheet');
    sh.body.append(...lines.map((l) => (typeof l === 'string' ? h('p', { dir: 'auto' }, l) : l)));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => sh.close() }, t('cancel')),
      h('button', { type: 'button', class: 'btn primary' + (danger ? ' danger' : ''), onclick: () => { answered = true; sh.close(); done(true); } }, ok));
  });
}
/** Unsaved work and the editor closing: Save, Discard, or Keep editing (its own close, Back and Escape: keep). */
export function askUnsaved(what?: string): Promise<'save' | 'discard' | 'keep'> {
  return new Promise((done) => {
    let answer: 'save' | 'discard' | 'keep' = 'keep';
    const sh = openSheet(t('unsavedTitle'), t('unsavedKeep'), { stack: true, onClose: () => done(answer) }); sh.el.classList.add('confirm-sheet', 'unsaved-sheet');
    sh.body.append(h('p', { dir: 'auto' }, what ? t('unsavedAskNamed', { name: what }) : t('unsavedAsk')));
    const b = (a: typeof answer, label: string, cls: string, ic?: string) => h('button', { type: 'button', class: 'btn ' + cls, 'data-answer': a, onclick: () => { answer = a; sh.close(); } }, ic ? icon(ic) : null, label);
    sh.actions.append(b('keep', t('unsavedKeep'), 'text'), b('discard', t('unsavedDiscard'), 'tonal danger', 'trash'), b('save', t('save'), 'primary', 'check'));
  });
}
/** For openSheet's `beforeClose`: nothing unsaved closes at once; else asked (Save runs `save`, which says whether it worked). */
export function dirtyGuard(isDirty: () => boolean, save: () => Promise<boolean>, what?: () => string): () => Promise<boolean> {
  let asking = false;
  return async () => {
    if (!isDirty()) return true; if (asking) return false; asking = true;
    try { const a = await askUnsaved(what?.()); return a === 'discard' ? true : a === 'save' ? await save() : false; } finally { asking = false; }
  };
}
