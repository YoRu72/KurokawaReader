// "Back", the same everywhere: Android's back gesture, a mouse's back button, Alt+← on a PC, the desktop
// shell's back command. What is open on top closes first (the camera, a sheet, a side panel, a full-screen
// view); then a place inside the view that the view itself keeps — a series opened in the library, the books
// selected — then the view's own back; then the library. Only at the library's top does the app go away.
import { navigate } from '../router';

const handlers: (() => boolean)[] = [];
/** A view's own step back (a series opened inside it): `fn` returns true when it went back. The latest first;
 *  the returned function takes it away (the view left, the place closed). */
export function onBack(fn: () => boolean): () => void {
  handlers.push(fn);
  return () => { const i = handlers.lastIndexOf(fn); if (i >= 0) handlers.splice(i, 1); };
}

/** One step back; false at the library's top (nothing left to go back from). */
export function goBack(): boolean {
  const cam = document.querySelector('.cam-view .cam-close') as HTMLButtonElement | null;
  if (cam) { cam.click(); return true; }
  const sheets = document.querySelectorAll('.sheet .sheet-head button');
  if (sheets.length) { (sheets[sheets.length - 1] as HTMLButtonElement).click(); return true; }
  const panelClose = document.querySelector('.panel.open .panel-head button') as HTMLButtonElement | null;
  if (panelClose) { panelClose.click(); return true; }
  // Full-screen overlays (gallery, pages grid, lightbox, a cover) carry a dialog role and a close in their top bar.
  const overlays = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => !d.classList.contains('panel') && (d as HTMLElement).offsetParent !== null);
  const overlayBtn = overlays.length ? (overlays[overlays.length - 1].querySelector('.lb-close, .topbar button, button[aria-label]') as HTMLButtonElement | null) : null;
  if (overlayBtn) { overlayBtn.click(); return true; }
  for (let i = handlers.length - 1; i >= 0; i--) { const fn = handlers[i]; if (fn()) return true; }
  const viewBack = document.querySelector<HTMLButtonElement>('.view .topbar button[data-icon="back"]');
  if (viewBack) { viewBack.click(); return true; }
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
  window.addEventListener('mouseup', (e) => { if (e.button === 3) { e.preventDefault(); goBack(); } }, true);
  window.addEventListener('keydown', (e) => {
    if (!(e.altKey && e.key === 'ArrowLeft') || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if ((e.target as HTMLElement).matches?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault(); goBack();
  });
}
