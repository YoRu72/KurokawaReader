// The phone's gestures beyond taps, in one place: a bottom sheet dragged down to close (it follows the finger, the
// page behind it shows again as it goes); a page swiped sideways to the next place of the bottom bar (or back); a
// list pulled down at its top to refresh it. Each steps aside for what
// is under the finger and wants the same move: a field, a row that swipes, a strip that scrolls sideways, a drawer.
// (Touch events: once the web view takes a finger for scrolling it cancels its pointer events; touch events keep coming.)

import { claimTouch, touchTaken } from './touchOwner';
import { Track, commits, grab, offsetNow, settle, reducedMotion } from './drag';
const isPc = (): boolean => document.documentElement.classList.contains('pc');
const rtl = (): boolean => getComputedStyle(document.documentElement).direction === 'rtl';
const reduced = reducedMotion;
const FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** The nearest element between `from` and `stop` that scrolls along `axis` (has more to show and lets it scroll). */
function scroller(from: Element | null, stop: Element | null, axis: 'x' | 'y'): HTMLElement | null {
  for (let e = from as HTMLElement | null; e && e !== stop && e !== document.body; e = e.parentElement) {
    const cs = getComputedStyle(e); const ov = axis === 'x' ? cs.overflowX : cs.overflowY;
    if ((ov === 'auto' || ov === 'scroll') && (axis === 'x' ? e.scrollWidth > e.clientWidth + 2 : e.scrollHeight > e.clientHeight + 2)) return e;
  }
  return null;
}

/** A bottom sheet dragged down by its handle, its head, or its content already scrolled to the top: it follows the
 *  finger 1:1, and goes when pulled a third of its height or flicked (speed over the last ~100 ms); otherwise it springs
 *  back. A second finger or a cancel puts it back; a new touch while it settles takes it up where it stands. */
export function dragToClose(sheet: HTMLElement, scrim: HTMLElement | null, close: () => void): void {
  let tr: Track | null = null, dragging = false, closing = false, base = 0, inner: HTMLElement | null = null;
  const home = () => { dragging = false; tr = null; settle(sheet, { transform: '' }); if (scrim) settle(scrim, { opacity: '' }); };
  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) { if (dragging) home(); tr = null; return; }
    tr = null; dragging = false; base = 0;
    if (closing || isPc() || sheet.classList.contains('side-drawer')) return;
    const t = e.target as Element;
    if (t.closest(`${FIELD}, [data-no-drag], .files-viewer-stage, input[type=range]`)) return;
    // (Settling after an earlier drag: taken up where it stands.)
    const was = new DOMMatrix(getComputedStyle(sheet).transform).m42; if (was > 0.5) { base = grab(sheet, 'y'); if (scrim) scrim.style.transition = 'none'; }
    // (Only a sheet along the bottom — not one shown at the side, as the player's are when turned.)
    const r = sheet.getBoundingClientRect(); if (r.bottom - base < window.innerHeight - 4 || r.top - base <= 0) { if (base) home(); return; }
    inner = scroller(t, sheet, 'y'); if (inner && inner.scrollTop > 0) return;
    if (scroller(t, sheet, 'x')) return;
    tr = new Track(e.touches[0].clientX, e.touches[0].clientY, e.timeStamp);
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!tr) return; if (e.touches.length > 1) { if (dragging) home(); tr = null; return; }
    const p = e.touches[0]; tr.add(p.clientX, p.clientY, e.timeStamp);
    if (!dragging) {
      const ax = tr.read(8, 1.2); if (!ax) return;
      if (ax === 'x' || tr.dy < 0 || (inner && inner.scrollTop > 0)) { if (base) home(); tr = null; return; }
      dragging = true; sheet.style.transition = 'none'; if (scrim) scrim.style.transition = 'none';
    }
    if (e.cancelable) e.preventDefault();
    const d = Math.max(0, base + tr.dy); sheet.style.transform = `translateY(${d}px)`;
    if (scrim) scrim.style.opacity = String(Math.max(0, 1 - d / Math.max(1, sheet.offsetHeight)));
  }, { passive: false });
  const end = (e: TouchEvent) => {
    const t = tr; tr = null; if (!t) return; if (!dragging) { if (base) home(); return; } dragging = false;
    const h = sheet.offsetHeight; const d = Math.max(0, base + t.dy);
    if (commits(d, h * 0.3, t.velocity('y', e.timeStamp))) {
      closing = true; sheet.dataset.leaving = '1'; settle(sheet, { transform: 'translateY(105%)' }, 200); if (scrim) settle(scrim, { opacity: '0' }, 200);
      setTimeout(close, reduced() ? 0 : 190);
    } else home();
  };
  sheet.addEventListener('touchend', end); sheet.addEventListener('touchcancel', () => { if (dragging || base) home(); tr = null; });
}

/** A list pulled down at its top to refresh it: a round mark follows the finger, turns as it nears the point where
 *  letting go refreshes, and spins while `run` works. Returns a function that removes it. */
export function pullToRefresh(area: HTMLElement, run: () => Promise<unknown> | unknown, opts: { scroller?: () => HTMLElement | null } = {}): () => void {
  const mark = document.createElement('div'); mark.className = 'ptr-mark'; mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/></svg>';
  const GO = 72; let y0 = 0, x0 = 0, on = false, pulling = false, pull = 0, busy = false;
  const top = (): boolean => { const s = opts.scroller?.() ?? null; return window.scrollY <= 0 && (!s || s.scrollTop <= 0); };
  const place = () => { const r = area.getBoundingClientRect(); mark.style.top = `${Math.max(0, r.top) + 8}px`; mark.style.left = `${r.left + r.width / 2}px`; };
  const show = (d: number) => { mark.style.transition = ''; if (!mark.isConnected) { document.body.append(mark); place(); } const k = Math.min(1, d / GO); mark.style.transform = `translate(-50%, ${Math.min(d, GO + 24) - 40}px) rotate(${Math.round(k * 300)}deg)`; mark.style.opacity = String(Math.min(1, k * 1.4)); mark.classList.toggle('ready', d >= GO); };
  const hide = () => { mark.classList.remove('ready', 'spin'); mark.style.transition = 'transform .2s, opacity .2s'; mark.style.opacity = '0'; mark.style.transform = 'translate(-50%, -40px)'; setTimeout(() => { mark.style.transition = ''; if (!pulling && !busy) mark.remove(); }, 220); };
  const start = (e: TouchEvent) => {
    if (pulling) { pulling = false; hide(); }   // (a second finger landing mid pull: put it back, nothing refreshed)
    on = false; pull = 0;
    if (busy || e.touches.length !== 1 || isPc() || document.querySelector('.sheet') || !top()) return;
    const t = e.target as Element; if (t.closest(`${FIELD}, [data-no-pull], .files-fast`)) return;
    const inner = scroller(t, area, 'y'); if (inner && inner.scrollTop > 0) return;
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; on = true;
  };
  const move = (e: TouchEvent) => {
    if (!on) return; const p = e.touches[0]; const dy = p.clientY - y0, dx = Math.abs(p.clientX - x0);
    if (!pulling) { if (dy < -4 || dx > 16 || e.touches.length !== 1 || touchTaken('pull')) { on = false; return; } if (dy > 10 && dy > dx * 1.5 && top() && claimTouch('pull')) pulling = true; else return; }
    e.preventDefault(); pull = Math.max(0, dy) * 0.5; show(pull);
  };
  const end = async () => {
    if (!on) return; on = false; if (!pulling) return; pulling = false;
    if (pull < GO) { hide(); return; }
    busy = true; mark.classList.add('spin'); mark.style.transform = 'translate(-50%, 32px)'; try { navigator.vibrate?.(8); } catch { /* none */ }
    try { await run(); } catch { /* the list says what went wrong */ } finally { busy = false; hide(); }
  };
  area.addEventListener('touchstart', start, { passive: true }); area.addEventListener('touchmove', move, { passive: false });
  area.addEventListener('touchend', end); area.addEventListener('touchcancel', () => { if (pulling) { pulling = false; on = false; hide(); } });
  return () => { area.removeEventListener('touchstart', start); area.removeEventListener('touchmove', move); area.removeEventListener('touchend', end); mark.remove(); };
}

/** The page swiped sideways to the bottom bar's next place (toward the reading's end) or its previous one: the page
 *  follows the finger a little, and the move is made when the finger travelled far enough or was flicked. */
export function pageSwipe(o: { enabled: () => boolean; step: (dir: 1 | -1) => boolean; view: () => HTMLElement | null }): void {
  let tr: Track | null = null, axis: '' | 'x' | 'y' = '';
  const along = (dx: number): number => dx * (rtl() ? -1 : 1);
  const settleBack = () => { const v = o.view(); if (v) settle(v, { transform: '', opacity: '' }, 220); };
  const give = () => { if (axis === 'x') settleBack(); tr = null; axis = ''; };
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) { give(); return; }
    tr = null; axis = '';
    if (isPc() || !o.enabled() || document.querySelector('.sheet, body > .kt-player, .side-drawer')) return;
    const t = e.target as Element;
    if (!t.closest('#app, .bottom-nav') || t.closest(`${FIELD}, [data-swipe], [data-no-page-swipe], video, canvas, .kt-player`)) return;
    if (scroller(t, null, 'x')) return;
    // (A page with a drawer at its start side: a swipe from that side opens the drawer, not the previous place.)
    const p = e.touches[0]; const w = window.innerWidth; const fromStart = (rtl() ? w - p.clientX : p.clientX) < w * 0.4;
    if (fromStart && t.closest('[data-edge-drawer]')) return;
    const v = o.view(); if (v && Math.abs(offsetNow(v, 'x')) > 0.5) grab(v, 'x');
    tr = new Track(p.clientX, p.clientY, e.timeStamp);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!tr) return; const p = e.touches[0];
    if (touchTaken('page') || e.touches.length !== 1) { give(); return; }
    tr.add(p.clientX, p.clientY, e.timeStamp);
    if (!axis) { const ax = tr.read(12, 1.6); if (!ax) { if (Math.max(Math.abs(tr.dx), Math.abs(tr.dy)) >= 12) { tr = null; } return; } if (ax === 'y' || !claimTouch('page')) { tr = null; return; } axis = 'x'; }
    if (e.cancelable) e.preventDefault();
    const dx = along(tr.dx); const v = o.view();
    if (v && !reduced()) { const d = Math.sign(dx) * Math.min(80, Math.abs(dx) * 0.3); v.style.transition = 'none'; v.style.transform = `translateX(${d * (rtl() ? -1 : 1)}px)`; v.style.opacity = String(1 - Math.min(0.35, Math.abs(dx) / 900)); }
  }, { passive: false });
  const end = (e: TouchEvent) => {
    const t = tr; tr = null; const was = axis; axis = ''; if (!t || was !== 'x') return;
    const dx = along(t.dx); const speed = along(t.velocity('x', e.timeStamp)) * Math.sign(dx || 1);
    if (commits(Math.abs(dx), Math.min(120, window.innerWidth * 0.28), speed)) {
      const dir: 1 | -1 = dx < 0 ? 1 : -1; const v = o.view(); if (v) { v.style.transition = 'none'; v.style.transform = ''; v.style.opacity = ''; }
      if (o.step(dir)) { document.documentElement.classList.remove('page-in-next', 'page-in-prev'); void document.documentElement.offsetWidth; document.documentElement.classList.add(dir > 0 ? 'page-in-next' : 'page-in-prev'); setTimeout(() => document.documentElement.classList.remove('page-in-next', 'page-in-prev'), 320); return; }
    }
    const v = o.view(); if (v) settle(v, { transform: '', opacity: '' }, 220);
  };
  document.addEventListener('touchend', end); document.addEventListener('touchcancel', () => { give(); });
}
