// Work that can wait — a sync started by itself, an automatic backup, a web novel's file written as its chapters
// arrive — waits for the reader to be still: no finger on the screen, no scroll, wheel or key for a moment. Their big
// steps (the whole library read from the database, a sync file of megabytes parsed and written, a novel's file read
// and written whole) each hold the page for a tenth of a second or more on a slow phone, and cannot be cut smaller;
// done while the page is being moved they showed as a stutter. Done in the pause after it, nothing is seen.
// Never held: when the app is hidden (it may be ended then — the work is done at once) or after `maxMs` of a reader
// who never stops (auto-scroll, say) — it is then done anyway. What is done, and in what order, is not changed.
// (No imports: sync, backup and the sources use it.)

let lastMoved = -Infinity;
let touching = false;
if (typeof window !== 'undefined') {
  const moved = (): void => { lastMoved = performance.now(); };
  // (Capture: an element's own scroll does not bubble, but passes the window on its way down.)
  for (const ev of ['scroll', 'wheel', 'touchmove', 'keydown', 'pointerdown']) window.addEventListener(ev, moved, { capture: true, passive: true });
  window.addEventListener('touchstart', () => { touching = true; moved(); }, { capture: true, passive: true });
  const up = (): void => { touching = false; moved(); };
  window.addEventListener('touchend', up, { capture: true, passive: true });
  window.addEventListener('touchcancel', up, { capture: true, passive: true });
}

/** Resolves once the page has been still for `quietMs` (at once when it already is, or is hidden). */
export function whenStill(quietMs = 800, maxMs = 30000): Promise<void> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let timer = 0;
    // (Hidden while waiting: at once — a hidden page's timers may not fire for a minute.)
    const onHide = (): void => { if (document.visibilityState === 'hidden') done(); };
    const done = (): void => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', onHide); resolve(); };
    const check = (): void => {
      const now = performance.now();
      if (document.visibilityState === 'hidden' || now - t0 >= maxMs || (!touching && now - lastMoved >= quietMs)) { done(); return; }
      timer = window.setTimeout(check, Math.max(60, quietMs - (now - lastMoved)));
    };
    if (typeof document === 'undefined') { resolve(); return; }
    document.addEventListener('visibilitychange', onHide);
    check();
  });
}
