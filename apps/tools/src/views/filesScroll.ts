// The fast scroller of a long Files list: a handle on the page's end edge (the left in the Arabic page) that is dragged to
// run through the folder, with a bubble naming where it is — the first letter, the month, the size bucket or the type, as the
// folder is sorted. On a computer the page's own scrollbar does the dragging; the bubble shows while it is scrolled.
// The list is drawn in slices (views/files.ts), so the place is an INDEX, not a pixel: the handle's place is the index
// of the row in sight over the list's length, and a drag asks the page to draw down to its index and bring it to the top.
import { claimTouch } from '../ui/touchOwner';
export interface FastScroll {
  /** How many rows the list holds. */ total(): number;
  /** The index of the row at the top of the screen (a fraction inside a slice counted). */ current(): number;
  /** Text for the bubble at an index. */ label(i: number): string;
  /** Bring the row at this index to the top of the screen (drawing down to it first). */ jump(i: number): void;
  /** The space the handle runs in: from `top` to `bottom` px of the window. */ track(): { top: number; bottom: number };
  pc: boolean; /** The handle's accessible name. */ name: string;
}
export interface FastHandle { update(): void; dispose(): void; el: HTMLElement }
export function fastScroller(host: HTMLElement, o: FastScroll): FastHandle {
  const thumb = document.createElement('div'); thumb.className = 'files-fast-thumb'; thumb.setAttribute('role', 'slider'); thumb.tabIndex = 0; thumb.setAttribute('aria-label', o.name);
  const grip = document.createElement('span'); grip.className = 'files-fast-grip'; thumb.append(grip);
  const bubble = document.createElement('div'); bubble.className = 'files-fast-bubble'; bubble.setAttribute('aria-hidden', 'true'); const said = document.createElement('bdi'); bubble.append(said);
  const el = document.createElement('div'); el.className = 'files-fast' + (o.pc ? ' pc' : ''); el.dataset.noPull = ''; el.dataset.noEdge = ''; el.dataset.noPageSwipe = ''; el.append(bubble, thumb); host.append(el);
  const H = 56; let held: { top: number; bottom: number } | null = null; let dragging = false; let hide = 0; let raf = 0; let aim = -1;
  const trackNow = () => held ?? o.track();
  const place = (i: number) => { const { top, bottom } = trackNow(); const run = Math.max(1, bottom - top - H); const n = Math.max(1, o.total() - 1); const y = top + Math.min(1, Math.max(0, i / n)) * run; el.style.top = `${top}px`; el.style.height = `${Math.max(H, bottom - top)}px`; thumb.style.transform = `translateY(${y - top}px)`; bubble.style.transform = `translateY(${y - top + H / 2 - 20}px)`; };
  const say = (i: number) => { said.textContent = o.label(Math.max(0, Math.min(o.total() - 1, Math.round(i)))); thumb.setAttribute('aria-valuetext', said.textContent); };
  const show = (ms: number) => { el.classList.add('on'); clearTimeout(hide); hide = window.setTimeout(() => { if (!dragging) el.classList.remove('on', 'bubble'); }, ms); };
  const update = () => { if (dragging) return; const i = o.current(); place(i); say(i); show(o.pc ? 900 : 1400); if (o.pc) el.classList.add('bubble'); };
  const fromY = (clientY: number): number => { const { top, bottom } = trackNow(); const run = Math.max(1, bottom - top - H); const f = Math.min(1, Math.max(0, (clientY - top - H / 2) / run)); return f * Math.max(0, o.total() - 1); };
  const go = () => { raf = 0; if (aim >= 0) { place(aim); say(aim); o.jump(Math.round(aim)); } };
  const move = (ev: PointerEvent) => { aim = fromY(ev.clientY); if (!raf) raf = requestAnimationFrame(go); };
  const down = (ev: PointerEvent) => { if (o.pc) return; claimTouch('fast'); held = o.track(); dragging = true; thumb.setPointerCapture(ev.pointerId); el.classList.add('on', 'drag', 'bubble'); move(ev); ev.preventDefault(); };
  const up = (ev: PointerEvent) => { if (!dragging) return; dragging = false; held = null; try { thumb.releasePointerCapture(ev.pointerId); } catch { /* none */ } el.classList.remove('drag'); show(900); };
  const key = (ev: KeyboardEvent) => { const d = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : ev.key === 'PageDown' ? 20 : ev.key === 'PageUp' ? -20 : 0; if (!d) return; ev.preventDefault(); o.jump(Math.max(0, Math.min(o.total() - 1, Math.round(o.current()) + d))); };
  thumb.addEventListener('pointerdown', down); thumb.addEventListener('pointermove', (ev) => { if (dragging) move(ev); }); thumb.addEventListener('pointerup', up); thumb.addEventListener('pointercancel', up); thumb.addEventListener('keydown', key);
  let tick = 0; const onScroll = () => { if (tick) return; tick = requestAnimationFrame(() => { tick = 0; update(); }); };
  window.addEventListener('scroll', onScroll, { passive: true }); document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onScroll);
  place(0); say(0);
  return { el, update, dispose: () => { window.removeEventListener('scroll', onScroll); document.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); clearTimeout(hide); if (raf) cancelAnimationFrame(raf); if (tick) cancelAnimationFrame(tick); el.remove(); } };
}
