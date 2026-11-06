// A drawer from the side, as Solid Explorer has it: opened by a finger swiped from the start side of the page toward
// the middle (not only by its button), closed by a swipe back, the drawer following the finger.
const rtl = (): boolean => document.documentElement.dir === 'rtl' || getComputedStyle(document.documentElement).direction === 'rtl';

/** Calls `open` when a finger starting in the start-side 40% of `area` moves mostly sideways toward the middle. */
export function swipeToOpen(area: HTMLElement, open: () => void): () => void {
  let x0 = 0, y0 = 0, id = -1;
  const down = (e: PointerEvent) => { if (e.pointerType === 'mouse' || document.querySelector('.sheet')) return; const w = window.innerWidth; const fromStart = rtl() ? w - e.clientX : e.clientX; if (fromStart > w * 0.4) return; id = e.pointerId; x0 = e.clientX; y0 = e.clientY; };
  const move = (e: PointerEvent) => { if (e.pointerId !== id) return; const dx = (e.clientX - x0) * (rtl() ? -1 : 1), dy = Math.abs(e.clientY - y0); if (dy > 40 || dx < -10) { id = -1; return; } if (dx > 70 && dx > dy * 2) { id = -1; open(); } };
  const end = (e: PointerEvent) => { if (e.pointerId === id) id = -1; };
  area.addEventListener('pointerdown', down, { passive: true }); area.addEventListener('pointermove', move, { passive: true }); area.addEventListener('pointerup', end); area.addEventListener('pointercancel', end);
  return () => { area.removeEventListener('pointerdown', down); area.removeEventListener('pointermove', move); area.removeEventListener('pointerup', end); area.removeEventListener('pointercancel', end); };
}

/** Makes a sheet a side drawer: it slides in from the start side and follows a finger swiping it back shut. */
export function sideDrawer(sheet: HTMLElement, close: () => void): void {
  sheet.classList.add('side-drawer');
  let x0 = 0, y0 = 0, id = -1, dragging = false;
  sheet.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dragging = false; }, { passive: true });
  sheet.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return; const dx = (e.clientX - x0) * (rtl() ? -1 : 1), dy = Math.abs(e.clientY - y0);
    if (!dragging) { if (dy > 24) { id = -1; return; } if (dx < -12 && -dx > dy * 1.5) { dragging = true; try { sheet.setPointerCapture(e.pointerId); } catch { /* a pointer the page made up */ } sheet.style.transition = 'none'; } else return; }
    sheet.style.transform = `translateX(${Math.min(0, dx) * (rtl() ? -1 : 1)}px)`;
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return; id = -1; if (!dragging) return; dragging = false;
    const dx = (e.clientX - x0) * (rtl() ? -1 : 1); sheet.style.transition = '';
    if (dx < -70) { sheet.style.transform = `translateX(${rtl() ? 100 : -100}%)`; setTimeout(close, 160); } else sheet.style.transform = '';
  };
  sheet.addEventListener('pointerup', end); sheet.addEventListener('pointercancel', end);
}
