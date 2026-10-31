// A picture to look closer at, as the cover view has it: two fingers to pinch, one to move about once zoomed,
// a double tap (or double click) to go in at that spot and back out, the wheel or + and − on a PC. A single tap
// and a swipe sideways (not zoomed) are told to the caller: the viewer closes, or goes to the next picture.

export interface Zoomable { reset(): void; dispose(): void; readonly zoomed: boolean }

export function zoomable(stage: HTMLElement, img: () => HTMLElement | null, o: { tap?(): void; swipe?(dir: 1 | -1): void } = {}): Zoomable {
  let s = 1, tx = 0, ty = 0;
  const apply = () => { const el = img(); if (el) { el.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`; el.style.transformOrigin = 'center'; } stage.classList.toggle('zoomed', s > 1.01); };
  const clampPan = () => {
    const el = img(); if (!el) return;
    const w = el.offsetWidth * s, hgt = el.offsetHeight * s, W = stage.clientWidth, H = stage.clientHeight;
    const mx = Math.max(0, (w - W) / 2), my = Math.max(0, (hgt - H) / 2);
    tx = Math.min(mx, Math.max(-mx, tx)); ty = Math.min(my, Math.max(-my, ty));
  };
  const zoomAt = (to: number, x: number, y: number) => {
    const r = stage.getBoundingClientRect(); const px = x - (r.left + r.width / 2), py = y - (r.top + r.height / 2);
    to = Math.min(8, Math.max(1, to));
    tx = px - (px - tx) * (to / s); ty = py - (py - ty) * (to / s); s = to;
    if (s <= 1.01) { s = 1; tx = 0; ty = 0; }
    clampPan(); apply();
  };
  const reset = () => { s = 1; tx = 0; ty = 0; apply(); };
  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; s: number } | null = null; let moved = false; let downAt = 0; let start = { x: 0, y: 0 };
  let lastTap = { at: 0, x: 0, y: 0 }; let tapTimer = 0;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  const down = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* gone */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { moved = false; downAt = performance.now(); start = { x: e.clientX, y: e.clientY }; }
    if (pts.size === 2) { pinch = { d: dist(), s }; moved = true; }
  };
  const move = (e: PointerEvent) => {
    const p = pts.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size >= 2 && pinch) { const m = mid(); zoomAt(pinch.s * (dist() / pinch.d), m.x, m.y); return; }
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) moved = true;
    if (s > 1) { tx += dx; ty += dy; clampPan(); apply(); }
  };
  const up = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size || e.type === 'pointercancel') return;
    // (A quick sideways swipe at full size: the next or the previous picture.)
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (moved && s === 1 && o.swipe && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && performance.now() - downAt < 600) { o.swipe(dx < 0 ? 1 : -1); return; }
    if (moved || performance.now() - downAt > 450) return;
    const now = performance.now();
    if (now - lastTap.at < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      clearTimeout(tapTimer); lastTap.at = 0;
      if (s > 1.01) reset(); else zoomAt(2.5, e.clientX, e.clientY);
      return;
    }
    lastTap = { at: now, x: e.clientX, y: e.clientY };
    tapTimer = window.setTimeout(() => { if (s <= 1.01) o.tap?.(); }, 300);
  };
  const wheel = (e: WheelEvent) => { e.preventDefault(); zoomAt(s * Math.exp(-e.deltaY / 300), e.clientX, e.clientY); };
  const key = (e: KeyboardEvent) => {
    if (!stage.isConnected) return;
    const r = stage.getBoundingClientRect();
    if (e.key === '+' || e.key === '=') zoomAt(s * 1.4, r.left + r.width / 2, r.top + r.height / 2);
    else if (e.key === '-') zoomAt(s / 1.4, r.left + r.width / 2, r.top + r.height / 2);
    else if (e.key === '0') reset();
  };
  stage.style.touchAction = 'none';
  stage.addEventListener('pointerdown', down); stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', wheel, { passive: false });
  document.addEventListener('keydown', key);
  const onResize = () => { clampPan(); apply(); };
  window.addEventListener('resize', onResize);
  return {
    reset,
    get zoomed() { return s > 1.01; },
    dispose() { clearTimeout(tapTimer); document.removeEventListener('keydown', key); window.removeEventListener('resize', onResize); },
  };
}
