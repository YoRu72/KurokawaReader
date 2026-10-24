// Putting pages in order in a grid, three ways: press and hold a page then drag it where it goes (mouse or
// finger, the list scrolling at its edges), tap its number and type the place it goes to, or — for many pages —
// select them and move them all to one place.
import { h } from './dom';
import { t, localDigits } from '../i18n';

/**
 * Press-and-hold dragging for the tiles of `grid` (each tile `[data-k]` holding its place). `move(from, to)`
 * is called once, on release. A quick swipe still scrolls; only a held press lifts the tile.
 */
export function sortable(grid: HTMLElement, tileSel: string, move: (from: number, to: number) => void, scroller?: HTMLElement): () => void {
  let timer = 0, from = -1, startX = 0, startY = 0, ghost: HTMLElement | null = null, lifted: HTMLElement | null = null, over = -1, pid = -1;
  let raf = 0, lastY = 0;
  const tiles = () => Array.from(grid.querySelectorAll<HTMLElement>(tileSel));
  const indexAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(tileSel);
    return el && grid.contains(el) ? Number(el.dataset.k) : -1;
  };
  const clear = () => { tiles().forEach((t) => t.classList.remove('drop-before', 'drop-after')); };
  const end = (commit: boolean) => {
    window.clearTimeout(timer); cancelAnimationFrame(raf);
    if (lifted) {
      // (The tap that ends a drag is no tap on the tile.)
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      grid.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => grid.removeEventListener('click', swallow, { capture: true }), 400);
      lifted.classList.remove('lifting'); ghost?.remove(); clear();
      document.body.classList.remove('sorting');
      if (commit && over >= 0 && over !== from) move(from, over);
    }
    ghost = null; lifted = null; from = -1; over = -1; pid = -1;
  };
  // While dragging near the top or bottom of the list, it scrolls.
  const edgeScroll = () => {
    const sc = scroller ?? grid.parentElement; if (!sc || !lifted) return;
    const r = sc.getBoundingClientRect(); const zone = 56;
    const d = lastY < r.top + zone ? -(r.top + zone - lastY) : lastY > r.bottom - zone ? lastY - (r.bottom - zone) : 0;
    if (d) sc.scrollTop += Math.max(-24, Math.min(24, d / 2));
    raf = requestAnimationFrame(edgeScroll);
  };
  const down = (e: PointerEvent) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>(tileSel);
    if (!tile || !grid.contains(tile) || (e.target as HTMLElement).closest('button, input')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    from = Number(tile.dataset.k); startX = e.clientX; startY = e.clientY; pid = e.pointerId;
    // (A mouse would otherwise start the browser's own dragging of the picture, which cancels this one.)
    if (e.pointerType === 'mouse') e.preventDefault();
    // A mouse lifts at once once it moves; a finger after a short hold.
    timer = window.setTimeout(() => lift(tile, e.clientX, e.clientY), e.pointerType === 'mouse' ? 0 : 320);
  };
  const lift = (tile: HTMLElement, x: number, y: number) => {
    const r = tile.getBoundingClientRect();
    ghost = tile.cloneNode(true) as HTMLElement; ghost.classList.add('sort-ghost');
    lifted = tile; tile.classList.add('lifting'); document.body.classList.add('sorting');
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: `${x - r.width / 2}px`, top: `${y - r.height / 2}px` });
    document.body.append(ghost);
    try { grid.setPointerCapture(pid); } catch { /* released already */ }
    navigator.vibrate?.(12);
    lastY = y; raf = requestAnimationFrame(edgeScroll);
  };
  const moveP = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    if (!lifted) {
      // Moved before the hold: a scroll, not a drag (a mouse lifts as soon as it moves).
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) { if (e.pointerType === 'mouse' && from >= 0) { window.clearTimeout(timer); const tile = tiles().find((x) => Number(x.dataset.k) === from); if (tile) lift(tile, e.clientX, e.clientY); } else end(false); }
      return;
    }
    e.preventDefault();
    lastY = e.clientY;
    if (ghost) { ghost.style.left = `${e.clientX - ghost.offsetWidth / 2}px`; ghost.style.top = `${e.clientY - ghost.offsetHeight / 2}px`; }
    const k = indexAt(e.clientX, e.clientY);
    if (k >= 0 && k !== over) { over = k; clear(); const el = tiles().find((x) => Number(x.dataset.k) === k); el?.classList.add(k < from ? 'drop-before' : 'drop-after'); }
  };
  // (Once a tile is lifted, the finger drags it, not the page: the browser's scrolling is held back.)
  const noScroll = (e: TouchEvent) => { if (lifted) e.preventDefault(); };
  document.addEventListener('touchmove', noScroll, { passive: false });
  grid.addEventListener('pointerdown', down);
  grid.addEventListener('pointermove', moveP, { passive: false });
  grid.addEventListener('pointerup', () => end(true));
  grid.addEventListener('pointercancel', () => end(false));
  // (A held finger must not open the browser's own menu.)
  grid.addEventListener('contextmenu', (e) => { if (lifted || from >= 0) e.preventDefault(); });
  return () => { end(false); document.removeEventListener('touchmove', noScroll); };
}

/**
 * A page's number that can be tapped and typed over: the page moves to the place typed. `n` places in all;
 * `k` is its place now (0-based).
 */
export function placeNumber(k: number, n: number, move: (from: number, to: number) => void, label = String(k + 1)): HTMLElement {
  const b = h('button', { type: 'button', class: 'page-pos', title: t('moveToPlace'), 'aria-label': t('moveToPlace') }, localDigits(label)) as HTMLButtonElement;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = h('input', { type: 'text', inputmode: 'numeric', class: 'page-pos-input', value: String(k + 1), 'aria-label': t('moveToPlace'), dir: 'ltr' }) as HTMLInputElement;
    let done = false;
    const commit = (ok: boolean) => {
      if (done) return; done = true;
      const v = parseInt(input.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))), 10);
      input.replaceWith(b);
      if (ok && Number.isFinite(v)) { const to = Math.max(1, Math.min(n, v)) - 1; if (to !== k) move(k, to); }
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(true); } else if (ev.key === 'Escape') commit(false); });
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
    b.replaceWith(input); input.focus(); input.select();
  });
  return b;
}
