// A floating pill (a snackbar with an action: Undo, unfinished jobs): it can always be closed — its own close button
// (a 48 px target) and, on a touch screen, a swipe aside — and it sits above what lies along the bottom of the screen
// (the bar of places, a selection's or a clipboard's bar, a floating button), moving with them while it is shown.
import { Track, commits, settle } from './drag';

/** What may lie along the bottom: the pill rides above whichever of these it would cover. */
const BOTTOM = '.bottom-nav, .files-selbar, .files-clipbar, .select-bar, .pick-bar, .fab';
const seen = (b: HTMLElement): boolean => { if (b.hidden || !b.getClientRects().length) return false; const cs = getComputedStyle(b); return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'; };
/** The pill placed above the bottom's bars and buttons it would cover (its own CSS place when nothing is in the way). */
export function placePill(el: HTMLElement): void {
  if (!el.isConnected || el.classList.contains('in-player') || el.classList.contains('swiped')) return;
  // (A sheet opened over the page after the pill: the pill is the page's, and would lie over the sheet's switches and
  // buttons — it waits out of sight, its time standing still (ui/undo.ts), and comes back when the sheet closes. A pill offered from
  // inside a sheet — an Undo for something done there — stays.)
  if (el.dataset.sheetAt === undefined) el.dataset.sheetAt = document.querySelectorAll('.sheet').length ? '1' : '0';
  const sheetNow = !!document.querySelector('.sheet'); el.classList.toggle('behind-sheet', sheetNow && el.dataset.sheetAt === '0');
  if (sheetNow) { if (el.style.bottom) el.style.removeProperty('bottom'); return; }
  if (el.dataset.sheetAt === '1') el.dataset.sheetAt = '0';
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
  let id = -1, tr: Track | null = null, axis: '' | 'x' | 'y' = '';
  el.style.touchAction = 'pan-y';
  const reset = () => { settle(el, { transform: '', opacity: '' }, 220); id = -1; axis = ''; tr = null; };
  // (A second finger landing anywhere puts it back, nothing closed.)
  document.addEventListener('touchstart', (e) => { if (e.touches.length > 1 && axis === 'x') reset(); }, { passive: true, capture: true });
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' || id !== -1) return; id = e.pointerId; tr = new Track(e.clientX, e.clientY, e.timeStamp); axis = ''; });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id || !tr) return; tr.add(e.clientX, e.clientY, e.timeStamp);
    if (!axis) { if (Math.max(Math.abs(tr.dx), Math.abs(tr.dy)) < 10) return; axis = Math.abs(tr.dx) > Math.abs(tr.dy) * 1.5 ? 'x' : 'y'; if (axis === 'y') { id = -1; tr = null; return; } try { el.setPointerCapture(id); } catch { /* fine */ } }
    el.style.transition = 'none'; el.style.transform = `translateX(calc(-50% + ${tr.dx}px))`; el.style.opacity = String(Math.max(0.2, 1 - Math.abs(tr.dx) / Math.max(1, el.offsetWidth)));
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return; const t = tr; const was = axis; const dx = t?.dx ?? 0;
    const v = t ? t.velocity('x', e.timeStamp) * Math.sign(dx || 1) : 0;
    if (was === 'x') { const stop = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); }; el.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 300); }
    if (was === 'x' && e.type === 'pointerup' && commits(Math.abs(dx), el.offsetWidth / 3, v, 0.5, 40)) {
      id = -1; axis = ''; tr = null; el.classList.add('swiped'); settle(el, { transform: `translateX(calc(-50% + ${Math.sign(dx) * innerWidth}px))`, opacity: '0' }, 170);
      setTimeout(close, 150); return;
    }
    reset();
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
