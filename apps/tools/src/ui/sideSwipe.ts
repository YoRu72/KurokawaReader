// A drawer from the side, as Solid Explorer has it: opened by a finger swiped from the start side of the page toward
// the middle (not only by its button), closed by a swipe back, the drawer following the finger.
// (Touch events, not pointer events: once the web view takes a finger for scrolling it cancels its pointer events,
// while touch events keep coming.)
const rtl = (): boolean => getComputedStyle(document.documentElement).direction === 'rtl';
const along = (x: number, x0: number): number => (x - x0) * (rtl() ? -1 : 1);

/** Calls `open` when a finger starting in the start-side 40% of `area` moves mostly sideways toward the middle. */
export function swipeToOpen(area: HTMLElement, open: () => void): () => void {
  let x0 = 0, y0 = 0, on = false;
  const start = (e: TouchEvent) => {
    on = false; if (e.touches.length !== 1 || document.querySelector('.sheet')) return;
    const p = e.touches[0]; const w = window.innerWidth; if ((rtl() ? w - p.clientX : p.clientX) > w * 0.4) return;
    x0 = p.clientX; y0 = p.clientY; on = true;
  };
  const move = (e: TouchEvent) => {
    if (!on) return; const p = e.touches[0]; const dx = along(p.clientX, x0), dy = Math.abs(p.clientY - y0);
    if (dy > 48 || dx < -12) { on = false; return; }
    if (dx > 64 && dx > dy * 1.6) { on = false; open(); }
  };
  const end = () => { on = false; };
  area.addEventListener('touchstart', start, { passive: true }); area.addEventListener('touchmove', move, { passive: true });
  area.addEventListener('touchend', end); area.addEventListener('touchcancel', end);
  return () => { area.removeEventListener('touchstart', start); area.removeEventListener('touchmove', move); area.removeEventListener('touchend', end); area.removeEventListener('touchcancel', end); };
}

/** Makes a sheet a side drawer: it slides in from the start side and follows a finger swiping it back shut. */
export function sideDrawer(sheet: HTMLElement, close: () => void): void {
  sheet.classList.add('side-drawer');
  let x0 = 0, y0 = 0, on = false, dragging = false, dx = 0;
  sheet.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) { on = false; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; on = true; dragging = false; dx = 0; }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!on) return; const p = e.touches[0]; dx = along(p.clientX, x0); const dy = Math.abs(p.clientY - y0);
    if (!dragging) { if (dy > 24) { on = false; return; } if (dx < -12 && -dx > dy * 1.5) { dragging = true; sheet.style.transition = 'none'; } else return; }
    sheet.style.transform = `translateX(${Math.min(0, dx) * (rtl() ? -1 : 1)}px)`;
  }, { passive: true });
  const end = () => {
    if (!on) return; on = false; if (!dragging) return; dragging = false; sheet.style.transition = '';
    if (dx < -70) { sheet.style.transform = `translateX(${rtl() ? 100 : -100}%)`; setTimeout(close, 160); } else sheet.style.transform = '';
  };
  sheet.addEventListener('touchend', end); sheet.addEventListener('touchcancel', end);
}
