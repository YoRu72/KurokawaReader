// The floating Undo (a snackbar with an action) behaves as the Tools app's does (apps/tools/src/ui/pill.ts, ported here, the
// two apps sharing no code): it can always be closed — its own close button (a 48 px target) and, on a touch screen, a swipe
// aside — and it sits above what lies along the bottom of the screen (the reading bars, a selection's bar, a floating
// button), moving with them while it is shown; a sheet opened over it hides it (its time standing still).

/** What may lie along the bottom: the pill rides above whichever of these it would cover. */
const BOTTOM = '.fab, .selection-bar, .float-toolbar, .pdf-bar, .ink-bar, .read-status, .tr-pill, .tr-mini';
const seen = (b: HTMLElement): boolean => { if (b.hidden || !b.getClientRects().length) return false; const cs = getComputedStyle(b); return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'; };
/** The pill placed above the bottom's bars and buttons it would cover (its own CSS place when nothing is in the way). */
export function placePill(el: HTMLElement): void {
  if (!el.isConnected || el.classList.contains('swiped')) return;
  // (A sheet opened over the page after the pill: the pill is the page's, and would lie over the sheet's switches and
  // buttons — it waits out of sight, its time standing still (ui/undo.ts), and comes back when the sheet closes. A pill offered from
  // inside a sheet — an Undo for something done there — stays.)
  if (el.dataset.sheetAt === undefined) el.dataset.sheetAt = String(document.querySelectorAll('.sheet').length);
  // (A pill offered inside one sheet hides when a further sheet opens over it — a confirm never lies under an old Undo.)
  const sheets = document.querySelectorAll('.sheet').length; const sheetNow = sheets > 0; el.classList.toggle('behind-sheet', sheets > Number(el.dataset.sheetAt));
  if (sheetNow) { if (el.style.bottom) el.style.removeProperty('bottom'); return; }
  if (el.dataset.sheetAt !== '0') el.dataset.sheetAt = '0';
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

/** What the reader operates by, that a notice must never lie over: the page buttons at a chapter's end, the toolbar, the bars, a
 *  computer's page-turn arrows. */
const CONTROLS = '.chapter-nav .cn-btn, .page-arrow, .float-toolbar, .selection-bar, .pdf-bar, .ink-bar, .read-status, .fab, .tr-pill, .tr-mini';
/** A notice (the reading dictionary's offer…) put above whatever of the reading controls it would cover, from its own CSS place
 *  upward — never over them. Called again as the page scrolls or turns; with nothing in the way it is back at its CSS place. */
export function placeNotice(el: HTMLElement): void {
  if (!el.isConnected) return;
  el.style.removeProperty('bottom');
  for (let i = 0; i < 5; i++) {
    const s = el.getBoundingClientRect(); let hit = Infinity;
    for (const b of document.querySelectorAll<HTMLElement>(CONTROLS)) {
      if (el.contains(b) || !seen(b)) continue; const r = b.getBoundingClientRect();
      if (r.right <= s.left + 1 || r.left >= s.right - 1 || r.bottom <= s.top || r.top >= s.bottom) continue; hit = Math.min(hit, r.top);
    }
    if (hit === Infinity) return;
    el.style.bottom = `${Math.round(innerHeight - hit + 12)}px`;
  }
}
/** Keeps a notice placed (placeNotice) while the page scrolls, turns or is resized; the returned function stops it. */
export function keepNoticePlaced(el: HTMLElement): () => void {
  let raf = 0; const go = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; placeNotice(el); }); };
  document.addEventListener('scroll', go, { capture: true, passive: true }); window.addEventListener('resize', go); go(); const t0 = window.setTimeout(go, 400);
  return () => { document.removeEventListener('scroll', go, { capture: true }); window.removeEventListener('resize', go); cancelAnimationFrame(raf); window.clearTimeout(t0); };
}
