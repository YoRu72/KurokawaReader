// A row swiped aside on a phone (as 1DM and the mail apps do): to one side its first action (pause, resume, retry), to
// the other its removal. What it will do shows under it while it moves, and only a swipe past a third of the row does it.
import { claimTouch } from './touchOwner';
import { Track, commits } from './drag';
const rtl = (): boolean => getComputedStyle(document.documentElement).direction === 'rtl';
// (One listener for all rows: a second finger landing anywhere drops the swipe under way — put back, nothing done.)
let dropSwipe: (() => void) | null = null;
document.addEventListener('touchstart', (e) => { if (e.touches.length > 1) dropSwipe?.(); }, { passive: true, capture: true });
export interface SwipeAction { label: string; icon: string; run: () => void }
export function swipeable(el: HTMLElement, sides: () => { right?: SwipeAction | null; left?: SwipeAction | null }, icon: (name: string) => SVGElement | HTMLElement, enabled: () => boolean = () => true): void {
  let x0 = 0, y0 = 0, dx = 0, axis: '' | 'x' | 'y' = '', id = -1, tr: Track | null = null, act: { right?: SwipeAction | null; left?: SwipeAction | null } = {};
  let stopClick: ((ev: Event) => void) | null = null;
  el.dataset.swipe = '1'; el.style.touchAction = 'pan-y';
  const under = document.createElement('span'); under.className = 'swipe-under'; under.setAttribute('aria-hidden', 'true');
  const kids = () => [...el.children].filter((c) => c !== under) as HTMLElement[];
  const reset = () => { el.classList.remove('swiping', 'swipe-r', 'swipe-l', 'armed'); for (const k of kids()) { k.style.transform = ''; } under.remove(); dx = 0; axis = ''; id = -1; };
  const unStop = () => { if (stopClick) { el.removeEventListener('click', stopClick, true); stopClick = null; } };
  // (The first action is the one toward the END of the line — pause, resume — the other toward its start; so in Arabic the
  // first is a swipe to the left, as the drawer and the page swipe are mirrored too.)
  const sideOf = (mx: number) => ((mx > 0) !== rtl() ? act.right : act.left);
  el.addEventListener('pointerdown', (e) => {
    // (A second finger landing while one swipes: the swipe is dropped, nothing done; it never takes the swipe over.)
    if (id !== -1) { if (e.pointerId !== id) reset(); return; }
    unStop(); if (e.pointerType === 'mouse' || !enabled() || document.documentElement.classList.contains('pc')) return; id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = 0; axis = ''; act = sides(); tr = new Track(x0, y0, e.timeStamp);
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return; const mx = e.clientX - x0, my = e.clientY - y0; tr?.add(e.clientX, e.clientY, e.timeStamp);
    // (ui/touchOwner.ts: 12 px before the direction is read; sideways only at twice as much across as down, and only toward a
    // side that has an action — the other way is left to the drawer.)
    if (!axis) { if (Math.abs(mx) < 12 && Math.abs(my) < 12) return; axis = Math.abs(mx) > Math.abs(my) * 2 && sideOf(mx) && claimTouch('row') ? 'x' : 'y'; if (axis === 'y') { id = -1; return; } try { el.setPointerCapture(id); } catch { /* fine */ } }
    // (Turned into a scroll after all: let go, nothing done.)
    if (Math.abs(my) > 40) { reset(); return; }
    const side = sideOf(mx); if (!side) { dx = 0; for (const k of kids()) k.style.transform = ''; under.remove(); el.classList.remove('swiping', 'armed'); return; }
    dx = mx; const w = el.clientWidth; const armed = Math.abs(dx) > w / 3;
    if (!under.isConnected) el.prepend(under);
    under.replaceChildren(icon(side.icon), document.createTextNode(side.label));
    el.classList.add('swiping'); el.classList.toggle('swipe-r', dx > 0); el.classList.toggle('swipe-l', dx < 0); el.classList.toggle('armed', armed);
    const shown = Math.sign(dx) * Math.min(Math.abs(dx), w * 0.6); for (const k of kids()) k.style.transform = `translateX(${shown}px)`;
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return; const w = el.clientWidth; const side = sideOf(dx); const go = e.type === 'pointerup' && axis === 'x' && side && commits(Math.abs(dx), w / 3, Math.abs(tr?.velocity('x', e.timeStamp) ?? 0) * (Math.sign(tr?.velocity('x', e.timeStamp) ?? 0) === Math.sign(dx) ? 1 : 0), 0.5, 48);
    // (A sideways drag is not a tap: the click it may bring is swallowed — only that one, let go at the next touch.)
    if (axis === 'x') { unStop(); const stop = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); unStop(); }; stopClick = stop; el.addEventListener('click', stop, true); setTimeout(() => { if (stopClick === stop) unStop(); }, 350); }
    reset(); if (go) side!.run();
  };
  el.addEventListener('pointerdown', () => { dropSwipe = () => { if (id !== -1) reset(); }; });
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', (e) => { if (e.target === el && e.pointerId === id) reset(); });
}
