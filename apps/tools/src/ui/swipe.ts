// A row swiped aside on a phone (as 1DM and the mail apps do): to one side its first action (pause, resume, retry), to
// the other its removal. What it will do shows under it while it moves, and only a swipe past a third of the row does it.
export interface SwipeAction { label: string; icon: string; run: () => void }
export function swipeable(el: HTMLElement, sides: () => { right?: SwipeAction | null; left?: SwipeAction | null }, icon: (name: string) => SVGElement | HTMLElement, enabled: () => boolean = () => true): void {
  let x0 = 0, y0 = 0, dx = 0, axis: '' | 'x' | 'y' = '', id = -1, act: { right?: SwipeAction | null; left?: SwipeAction | null } = {};
  const under = document.createElement('span'); under.className = 'swipe-under'; under.setAttribute('aria-hidden', 'true');
  const kids = () => [...el.children].filter((c) => c !== under) as HTMLElement[];
  const reset = () => { el.classList.remove('swiping', 'swipe-r', 'swipe-l', 'armed'); for (const k of kids()) { k.style.transform = ''; } under.remove(); dx = 0; axis = ''; id = -1; };
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' || !enabled() || document.documentElement.classList.contains('pc')) return; id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = 0; axis = ''; act = sides(); });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return; const mx = e.clientX - x0, my = e.clientY - y0;
    if (!axis) { if (Math.abs(mx) < 10 && Math.abs(my) < 10) return; axis = Math.abs(mx) > Math.abs(my) * 1.4 ? 'x' : 'y'; if (axis === 'y') { id = -1; return; } try { el.setPointerCapture(id); } catch { /* fine */ } }
    const side = mx > 0 ? act.right : act.left; if (!side) { dx = 0; return; }
    dx = mx; const w = el.clientWidth; const armed = Math.abs(dx) > w / 3;
    if (!under.isConnected) el.prepend(under);
    under.replaceChildren(icon(side.icon), document.createTextNode(side.label));
    el.classList.add('swiping'); el.classList.toggle('swipe-r', dx > 0); el.classList.toggle('swipe-l', dx < 0); el.classList.toggle('armed', armed);
    const shown = Math.sign(dx) * Math.min(Math.abs(dx), w * 0.6); for (const k of kids()) k.style.transform = `translateX(${shown}px)`;
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return; const w = el.clientWidth; const side = dx > 0 ? act.right : act.left; const go = axis === 'x' && side && Math.abs(dx) > w / 3;
    if (axis === 'x') { const stop = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); }; el.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 350); }
    reset(); if (go) side!.run();
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', (e) => { if (e.pointerId === id) reset(); });
}
