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
  let timer = 0, from = -1, startX = 0, startY = 0, ghost: HTMLElement | null = null, lifted: HTMLElement | null = null, over = -1;
  let raf = 0, lastY = 0, mode: 'mouse' | 'touch' | null = null, pid = -1;
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
    ghost = null; lifted = null; from = -1; over = -1; mode = null; pid = -1;
  };
  // While dragging near the top or bottom of the list, it scrolls.
  const edgeScroll = () => {
    const sc = scroller ?? grid.parentElement; if (!sc || !lifted) return;
    const r = sc.getBoundingClientRect(); const zone = 56;
    const d = lastY < r.top + zone ? -(r.top + zone - lastY) : lastY > r.bottom - zone ? lastY - (r.bottom - zone) : 0;
    if (d) sc.scrollTop += Math.max(-24, Math.min(24, d / 2));
    raf = requestAnimationFrame(edgeScroll);
  };
  const tileAt = (t: EventTarget | null) => {
    const el = t as HTMLElement | null; const tile = el?.closest?.<HTMLElement>(tileSel);
    return tile && grid.contains(tile) && !el!.closest('button, input') ? tile : null;
  };
  const lift = (tile: HTMLElement, x: number, y: number) => {
    const r = tile.getBoundingClientRect();
    ghost = tile.cloneNode(true) as HTMLElement; ghost.classList.add('sort-ghost');
    lifted = tile; tile.classList.add('lifting'); document.body.classList.add('sorting');
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: `${x - r.width / 2}px`, top: `${y - r.height / 2}px` });
    document.body.append(ghost);
    navigator.vibrate?.(12);
    lastY = y; raf = requestAnimationFrame(edgeScroll);
  };
  const follow = (x: number, y: number) => {
    lastY = y;
    if (ghost) { ghost.style.left = `${x - ghost.offsetWidth / 2}px`; ghost.style.top = `${y - ghost.offsetHeight / 2}px`; }
    const k = indexAt(x, y);
    if (k >= 0 && k !== over) { over = k; clear(); const el = tiles().find((t) => Number(t.dataset.k) === k); el?.classList.add(k < from ? 'drop-before' : 'drop-after'); }
  };

  /* A finger: touch events, not pointer events — a phone's browser cancels the pointer as soon as it thinks of
     scrolling or of a long press (selection, a menu), which is what broke dragging there. A press held still for a
     moment lifts the tile; moving first is scrolling. Once lifted, the page does not scroll under the finger. */
  const tStart = (e: TouchEvent) => {
    if (e.touches.length !== 1 || mode) return;
    const tile = tileAt(e.target); if (!tile) return;
    const t = e.touches[0]; mode = 'touch'; from = Number(tile.dataset.k); startX = t.clientX; startY = t.clientY;
    timer = window.setTimeout(() => { if (mode === 'touch') lift(tile, startX, startY); }, 300);
  };
  const tMove = (e: TouchEvent) => {
    if (mode !== 'touch') return;
    const t = e.touches[0]; if (!t) return;
    if (!lifted) { if (Math.hypot(t.clientX - startX, t.clientY - startY) > 10) end(false); return; }
    if (e.cancelable) e.preventDefault();
    follow(t.clientX, t.clientY);
  };
  const tEnd = (e: TouchEvent) => { if (mode !== 'touch') return; if (lifted && e.cancelable) e.preventDefault(); end(e.type === 'touchend'); };

  /* A mouse (or pen): pointer events; it lifts as soon as it moves with the button down. */
  const pDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || mode) return;
    const tile = tileAt(e.target); if (!tile || e.button !== 0) return;
    mode = 'mouse'; from = Number(tile.dataset.k); startX = e.clientX; startY = e.clientY; pid = e.pointerId;
    // (Else the browser starts dragging the picture itself, which cancels this.)
    e.preventDefault();
  };
  const pMove = (e: PointerEvent) => {
    if (mode !== 'mouse' || e.pointerId !== pid) return;
    if (!lifted) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) <= 6) return;
      const tile = tiles().find((x) => Number(x.dataset.k) === from); if (!tile) { end(false); return; }
      lift(tile, e.clientX, e.clientY); try { grid.setPointerCapture(pid); } catch { /* gone */ }
    }
    e.preventDefault(); follow(e.clientX, e.clientY);
  };
  const pUp = (e: PointerEvent) => { if (mode === 'mouse' && e.pointerId === pid) end(e.type === 'pointerup'); };

  grid.addEventListener('touchstart', tStart, { passive: true });
  document.addEventListener('touchmove', tMove, { passive: false });
  document.addEventListener('touchend', tEnd, { passive: false });
  document.addEventListener('touchcancel', tEnd);
  grid.addEventListener('pointerdown', pDown);
  grid.addEventListener('pointermove', pMove, { passive: false });
  grid.addEventListener('pointerup', pUp);
  grid.addEventListener('pointercancel', pUp);
  // (A held finger must not open the browser's own menu, nor start selecting text.)
  grid.addEventListener('contextmenu', (e) => { if (mode) e.preventDefault(); });
  grid.addEventListener('selectstart', (e) => { if (mode) e.preventDefault(); });
  return () => { end(false); document.removeEventListener('touchmove', tMove); document.removeEventListener('touchend', tEnd); document.removeEventListener('touchcancel', tEnd); };
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
