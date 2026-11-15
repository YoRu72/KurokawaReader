// "Back", the same everywhere: Android's back gesture, a mouse's back button, Alt+← or Esc on a PC, the desktop
// shell's back command, a view's top-left arrow. What is open on top closes first (the camera, a sheet, a side panel, a full-screen
// view); then a place inside the view that the view itself keeps — a series opened in the library, the books
// selected — then the view's own back; then the library. Only at the library's top does the app go away.
import { navigate } from '../router';
import { diagBack } from '../diag';

/** Where a Back came from: the phone's button or gesture ('key'), a computer's mouse button, Alt+← or the shell's command
 *  ('pc'), Esc ('esc'), a view's top-left arrow ('arrow'). Every one goes through goBack, with the same result — save
 *  that «Back twice to leave a book» guards only the presses that can be made by mistake (not the arrow). */
export type BackSource = 'key' | 'pc' | 'esc' | 'arrow';

/* The one way back. What is open is a stack of layers — each sheet, side panel, full-screen view registers itself when it
 * opens (pushLayer) and goes when it closes —, and Back closes the top one; then the open view's own steps, latest first
 * (onBack: the reader's full screen, auto-scroll, reading aloud and selection, «Next volume»'s question; the library's
 * selection, search, series, folder, tag; the settings' search); then the view itself (its top-left arrow pressed — the
 * reader's leaves the book: arrowBack); then the library. Layers not registered (a picture's full-screen view, a cover) are still found on
 * the screen, as before. */
interface Layer { close: () => void; el?: Element }
const layers: Layer[] = [];
/** A layer opened over the screen: `close` shuts it (and should take it away — the returned function). */
export function pushLayer(close: () => void, el?: Element): () => void {
  const l: Layer = { close, el }; layers.push(l);
  return () => { const i = layers.lastIndexOf(l); if (i >= 0) layers.splice(i, 1); };
}
/** The layers open now, top last (for the tests' table: src/ui/backstack.ts). */
export const openLayers = (): number => { prune(); return layers.length; };
function prune(): void { for (let i = layers.length - 1; i >= 0; i--) { const el = layers[i].el; if (el && (!el.isConnected || (el.classList.contains('panel') && !el.classList.contains('open')))) layers.splice(i, 1); } }

const handlers: ((src: BackSource) => boolean)[] = [];
let stepsTaken = 0;
/** How many Backs a view's own step took (a place left inside it): src/native.ts tells by it that a press did something. */
export const backSteps = (): number => stepsTaken;
/** A view's own step back (a series opened inside it): `fn` returns true when it went back. The latest first;
 *  the returned function takes it away (the view left, the place closed). */
export function onBack(fn: (src: BackSource) => boolean): () => void {
  handlers.push(fn);
  return () => { const i = handlers.lastIndexOf(fn); if (i >= 0) handlers.splice(i, 1); };
}
/** The click of a view's top-left arrow that leaves by a way of its own (the reader's): Back (`goBack('arrow')`) — and
 *  when goBack's last step presses the arrow, `leave`. (Pressed, not called: whatever holds the arrow's press holds it
 *  then too, and Back's safety net — src/native.ts — sees the press change nothing.) */
let pressing = false, arrowLeave: (() => void) | null = null;
export function arrowBack(leave: () => void): () => void {
  // (Pressed by goBack — another source —: leave. Pressed by a hand: Back from the arrow, whose last step leaves at once
  // — the arrow cannot be pressed again from within its own press.)
  return () => { if (pressing) { leave(); return; } arrowLeave = leave; try { goBack('arrow'); } finally { arrowLeave = null; } };
}

/** One step back; false at the library's top (nothing left to go back from). */
export function goBack(src: BackSource = 'key'): boolean {
  // (The app lock's cover: back does not get past it.)
  if (document.querySelector('.app-lock')) return true;
  const cam = document.querySelector('.cam-view .cam-close') as HTMLButtonElement | null;
  if (cam) { cam.click(); return true; }
  prune();
  const top = layers.pop();
  if (top) { top.close(); return true; }
  // (A sheet not registered: its close — else the last button of its head.)
  const sheet = [...document.querySelectorAll('.sheet')].pop();
  const sheetBtn = sheet?.querySelector<HTMLButtonElement>('.sheet-head button[data-icon="close"]') ?? [...(sheet?.querySelectorAll<HTMLButtonElement>('.sheet-head button') ?? [])].pop();
  if (sheetBtn) { sheetBtn.click(); return true; }
  // (Its close button — not the first in its head: the reading options put their Undo / Redo there, src/ui/optionsundo.ts.)
  const panelClose = document.querySelector('.panel.open .panel-head > button[data-icon="close"]') as HTMLButtonElement | null;
  if (panelClose) { panelClose.click(); return true; }
  // Full-screen overlays (gallery, pages grid, lightbox, a cover) carry a dialog role and a close in their top bar.
  // (Shown, by its boxes: a fixed overlay — the cover view — has no offset parent though it is on the screen.)
  const overlays = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => !d.classList.contains('panel') && d.getClientRects().length > 0 && getComputedStyle(d).visibility !== 'hidden');
  // (Its close — not the first labelled button: a picture's bar starts with «previous».)
  const ov = overlays[overlays.length - 1];
  const overlayBtn = ov ? ov.querySelector<HTMLButtonElement>('.lb-close') ?? ov.querySelector<HTMLButtonElement>('.topbar button[data-icon="back"], button[data-icon="close"]') ?? ov.querySelector<HTMLButtonElement>('.topbar button, button[aria-label]') : null;
  if (overlayBtn) { overlayBtn.click(); return true; }
  for (let i = handlers.length - 1; i >= 0; i--) { const fn = handlers[i]; if (fn(src)) { stepsTaken++; return true; } }
  const viewBack = document.querySelector<HTMLButtonElement>('.view .topbar button[data-icon="back"]');
  if (src === 'arrow' && arrowLeave) { arrowLeave(); return true; }
  if (viewBack) { pressing = true; try { viewBack.click(); } finally { pressing = false; } return true; }
  if (location.hash && location.hash !== '#/' && location.hash !== '#') { navigate('/'); return true; }
  return false;
}

let wired = false;
/** A PC's ways back: the mouse's back button, Alt+← (not while typing). */
export function wirePcBack(): void {
  if (wired) return; wired = true;
  // (The mouse's back button: its press kept from the page, so no text is selected and the browser does not
  // go back a page on its own.)
  window.addEventListener('mousedown', (e) => { if (e.button === 3) e.preventDefault(); }, true);
  window.addEventListener('mouseup', (e) => { if (e.button === 3) { e.preventDefault(); diagBack('back-pc'); goBack('pc'); } }, true);
  window.addEventListener('keydown', (e) => {
    if (!(e.altKey && e.key === 'ArrowLeft') || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if ((e.target as HTMLElement).matches?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault(); diagBack('back-pc'); goBack('pc');
  });
  // Esc: Back, as the phone's (a view's own Esc — a sheet's, a picture's — taken first: one that marks the key handled
  // is left alone). Read once every listener has had it.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || e.repeat) return;
    // (Typing in a field, or a list of choices open: Esc is the field's — a search emptied, else the field left —, never
    // a step back.)
    const f = e.target as HTMLElement | null;
    if (f && (f.matches?.('input, textarea, select') || f.isContentEditable)) {
      window.setTimeout(() => {
        if (e.defaultPrevented) return;
        const i = f as HTMLInputElement;
        if (i.type === 'search' && i.value) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); } else f.blur();
      }, 0);
      return;
    }
    window.setTimeout(() => { if (!e.defaultPrevented) { diagBack('back-esc'); goBack('esc'); } }, 0);
  });
}
