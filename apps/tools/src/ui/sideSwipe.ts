// A drawer from the side, as Solid Explorer has it: opened by a finger swiped from the start side of the page toward
// the middle (not only by its button), closed by a swipe back, the drawer following the finger.
// (Touch events, not pointer events: once the web view takes a finger for scrolling it cancels its pointer events,
// while touch events keep coming.)
import { claimTouch, inSideScroller, touchTaken } from './touchOwner';
import { Track, commits, grab, offsetNow, settle } from './drag';
const rtl = (): boolean => getComputedStyle(document.documentElement).direction === 'rtl';
const along = (x: number, x0: number): number => (x - x0) * (rtl() ? -1 : 1);

/** Calls `open` when a finger starting in the start-side 40% of `area` moves mostly sideways toward the middle — never
 *  on a strip that scrolls sideways (chips, the way here), with two fingers, or once another gesture has the touch
 *  (ui/touchOwner.ts has the rules). The drawer opens on letting go: 64 px toward the middle, or a flick (a shorter
 *  swipe at speed); drawn back to where it began, or cancelled, nothing opens. */
export function swipeToOpen(area: HTMLElement, open: () => void): () => void {
  let tr: Track | null = null, mine = false;
  const start = (e: TouchEvent) => {
    tr = null; mine = false; if (e.touches.length !== 1 || document.querySelector('.sheet')) return;
    const p = e.touches[0]; const w = window.innerWidth; if ((rtl() ? w - p.clientX : p.clientX) > w * 0.4) return;
    if (inSideScroller(e.target as Element, area) || (e.target as Element).closest?.('.files-fast, [data-no-edge]')) return;
    tr = new Track(p.clientX, p.clientY, e.timeStamp);
  };
  const move = (e: TouchEvent) => {
    if (!tr) return; if (e.touches.length !== 1 || touchTaken('drawer')) { tr = null; return; }
    const p = e.touches[0]; tr.add(p.clientX, p.clientY, e.timeStamp); const dx = along(p.clientX, tr.x0), dy = Math.abs(tr.dy);
    if (dy > 32 || dx < -12) { tr = null; return; }
    if (!mine && dx > 24 && dx > dy * 2 && claimTouch('drawer')) mine = true;
  };
  const end = (e: TouchEvent) => {
    const t = tr; tr = null; if (!t || !mine) return; mine = false;
    const dx = along(t.x0 + t.dx, t.x0), dy = Math.abs(t.dy); const v = along(t.velocity('x', e.timeStamp), 0);
    if (dy <= 32 && dx > dy * 2 && commits(dx, 64, v, 0.5, 28)) open();
  };
  const cancel = () => { tr = null; mine = false; };
  area.addEventListener('touchstart', start, { passive: true }); area.addEventListener('touchmove', move, { passive: true });
  area.addEventListener('touchend', end); area.addEventListener('touchcancel', cancel); area.dataset.edgeDrawer = '1';
  return () => { delete area.dataset.edgeDrawer; area.removeEventListener('touchstart', start); area.removeEventListener('touchmove', move); area.removeEventListener('touchend', end); area.removeEventListener('touchcancel', cancel); };
}

/** Makes a sheet a side drawer: it slides in from the start side and follows a finger swiping it back shut (its scrim
 *  fading as it goes); shut by 70 px or a flick, put back by a short pull, a second finger or a cancel. */
export function sideDrawer(sheet: HTMLElement, close: () => void): void {
  sheet.classList.add('side-drawer'); sheet.style.touchAction = 'pan-y';   // (the axis it does not use: the list keeps scrolling, sideways is the drawer's)
  const scrim = (): HTMLElement | null => { const p = sheet.previousElementSibling as HTMLElement | null; return p?.classList.contains('scrim') ? p : null; };
  const dir = (): number => (rtl() ? -1 : 1);
  let tr: Track | null = null, dragging = false, closing = false, base = 0;
  const home = () => { dragging = false; tr = null; settle(sheet, { transform: '' }); const sc = scrim(); if (sc) settle(sc, { opacity: '' }); };
  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) { if (dragging) home(); tr = null; return; }
    tr = null; dragging = false; base = 0; if (closing) return;
    if (Math.abs(offsetNow(sheet, 'x')) > 0.5) { base = grab(sheet, 'x'); const sc = scrim(); if (sc) sc.style.transition = 'none'; }
    tr = new Track(e.touches[0].clientX, e.touches[0].clientY, e.timeStamp);
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!tr) return; if (e.touches.length > 1) { if (dragging) home(); tr = null; return; }
    tr.add(e.touches[0].clientX, e.touches[0].clientY, e.timeStamp); const pos = Math.min(0, (tr.dx + base) * dir());
    if (!dragging) { const ax = tr.read(10, 1.5); if (!ax) return; if (ax === 'y' || (!base && tr.dx * dir() > 0)) { if (base) home(); tr = null; return; } dragging = true; sheet.style.transition = 'none'; }
    const off = pos; sheet.style.transform = `translateX(${off * dir()}px)`;
    const sc = scrim(); if (sc) { sc.style.transition = 'none'; sc.style.opacity = String(Math.max(0, 1 + off / Math.max(1, sheet.offsetWidth))); }
  }, { passive: true });
  const end = (e: TouchEvent) => {
    const t = tr; tr = null; if (!t) return; if (!dragging) { if (base) home(); return; } dragging = false;
    const off = Math.min(0, (t.dx + base) * dir()); const v = -t.velocity('x', e.timeStamp) * dir();
    if (commits(-off, Math.min(70, sheet.offsetWidth * 0.3), v, 0.5, 30)) {
      closing = true; sheet.dataset.leaving = '1'; settle(sheet, { transform: `translateX(${rtl() ? 105 : -105}%)` }, 200); const sc = scrim(); if (sc) settle(sc, { opacity: '0' }, 200);
      setTimeout(close, 190);
    } else home();
  };
  sheet.addEventListener('touchend', end); sheet.addEventListener('touchcancel', () => { if (dragging || base) home(); tr = null; });
}
