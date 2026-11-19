// A floating pill (a snackbar with an action: Undo, unfinished jobs): it can always be closed — its own close button
// (a 48 px target) and, on a touch screen, a swipe aside — and it sits above what lies along the bottom of the screen
// (the bar of places, a selection's or a clipboard's bar, a floating button), moving with them while it is shown.

/** What may lie along the bottom: the pill rides above whichever of these it would cover. */
const BOTTOM = '.bottom-nav, .files-selbar, .files-clipbar, .select-bar, .pick-bar, .fab';
const seen = (b: HTMLElement): boolean => { if (b.hidden || !b.getClientRects().length) return false; const cs = getComputedStyle(b); return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'; };
/** The pill placed above the bottom's bars and buttons it would cover (its own CSS place when nothing is in the way). */
export function placePill(el: HTMLElement): void {
  if (!el.isConnected || el.classList.contains('in-player') || el.classList.contains('swiped')) return;
  const s = el.getBoundingClientRect(); let top = Infinity;
  for (const b of document.querySelectorAll<HTMLElement>(BOTTOM)) {
    if (b === el || el.contains(b) || !seen(b)) continue; const r = b.getBoundingClientRect();
    // (Only what is along the bottom half and under the pill's width.)
    if (r.top < innerHeight / 2 || r.right <= s.left || r.left >= s.right) continue; top = Math.min(top, r.top);
  }
  const want = top === Infinity ? '' : `${Math.round(innerHeight - top + 12)}px`;
  if (el.style.bottom !== want) { if (want) el.style.bottom = want; else el.style.removeProperty('bottom'); }
}
/** A touch screen's finger swiping the pill aside (past a third of its width, or flicked): it goes, and `close` is told
 *  once. A tap on its buttons stays a tap; a sideways drag is never taken for one. */
export function swipeAway(el: HTMLElement, close: () => void): void {
  let id = -1, x0 = 0, y0 = 0, t0 = 0, dx = 0, axis: '' | 'x' | 'y' = '';
  el.style.touchAction = 'pan-y';
  const reset = () => { el.style.transition = 'transform .18s ease, opacity .18s ease'; el.style.transform = ''; el.style.opacity = ''; id = -1; axis = ''; };
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' || id !== -1) return; id = e.pointerId; x0 = e.clientX; y0 = e.clientY; t0 = performance.now(); dx = 0; axis = ''; });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return; const mx = e.clientX - x0, my = e.clientY - y0;
    if (!axis) { if (Math.abs(mx) < 10 && Math.abs(my) < 10) return; axis = Math.abs(mx) > Math.abs(my) * 1.5 ? 'x' : 'y'; if (axis === 'y') { id = -1; return; } try { el.setPointerCapture(id); } catch { /* fine */ } }
    dx = mx; el.style.transition = 'none'; el.style.transform = `translateX(calc(-50% + ${dx}px))`; el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / Math.max(1, el.offsetWidth)));
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return; const was = axis; const fast = Math.abs(dx) / Math.max(1, performance.now() - t0) > 0.5 && Math.abs(dx) > 40;
    if (was === 'x') { const stop = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); }; el.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 300); }
    if (was === 'x' && e.type === 'pointerup' && (Math.abs(dx) > el.offsetWidth / 3 || fast)) {
      id = -1; axis = ''; el.classList.add('swiped'); el.style.transition = 'transform .16s ease-in, opacity .16s'; el.style.transform = `translateX(calc(-50% + ${Math.sign(dx) * innerWidth}px))`; el.style.opacity = '0';
      setTimeout(close, 150); return;
    }
    reset();
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
