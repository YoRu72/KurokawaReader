// Moon+-style brightness gesture: drag up/down along the left edge of the page
// to dim or brighten it (the reader's own dimming overlay — no system permission).
import { getSettings, updateSettings } from '../settings';
import { canDeviceBrightness, getDeviceBrightness, setDeviceBrightness } from '../native';
import { h } from './dom';
import { t, localDigits, isTouchDevice } from '../i18n';

export function attachEdgeBrightness(area: HTMLElement): () => void {
  if (!isTouchDevice()) return () => undefined;
  let startY = 0, startDim = 0, active = false, moved = false;
  let device = false, startBright = 0.5, lastBright = -1;
  let hud: HTMLElement | null = null; let hideT = 0;
  const show = (v: number) => {
    if (!hud) { hud = h('div', { class: 'brightness-hud' }); document.body.appendChild(hud); }
    hud.textContent = `${t('brightness')} ${localDigits(Math.round(device ? v * 100 : (1 - v / 0.7) * 100))}%`;
    hud.classList.add('on');
    window.clearTimeout(hideT); hideT = window.setTimeout(() => hud?.classList.remove('on'), 900);
  };
  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' || !getSettings().edgeBrightness) return;
    const r = area.getBoundingClientRect();
    const edge = (e.clientX - r.left) / r.width;
    const rtl = getComputedStyle(area).direction === 'rtl';
    // The "left edge" of the page as the reader sees it: 14% strip on the left in LTR, on the right in RTL.
    if (rtl ? edge < 0.86 : edge > 0.14) return;
    active = true; moved = false; startY = e.clientY; startDim = getSettings().dimOverlay;
    device = getSettings().brightnessMode === 'device' && canDeviceBrightness();
    if (device) void getDeviceBrightness().then((v) => { startBright = v; });
  };
  const move = (e: PointerEvent) => {
    if (!active) return;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dy) < 12) return;
    moved = true;
    e.preventDefault();
    if (device) {
      // Up brightens, down darkens the screen itself.
      const b = Math.min(1, Math.max(0.02, startBright - dy / area.clientHeight * 1.2));
      if (Math.abs(b - lastBright) >= 0.01) { lastBright = b; void setDeviceBrightness(b); }
      show(b);
      return;
    }
    const v = Math.min(0.7, Math.max(0, startDim + dy / area.clientHeight * 0.9));
    updateSettings({ dimOverlay: Math.round(v * 100) / 100 });
    show(v);
  };
  const up = () => { active = false; };
  area.addEventListener('pointerdown', down);
  area.addEventListener('pointermove', move, { passive: false });
  area.addEventListener('pointerup', up); area.addEventListener('pointercancel', up);
  return () => { area.removeEventListener('pointerdown', down); area.removeEventListener('pointermove', move); area.removeEventListener('pointerup', up); area.removeEventListener('pointercancel', up); hud?.remove(); };
}

/** Two-finger pinch on the page changes the text size (touch screens). */
export function attachPinchText(area: HTMLElement): () => void {
  if (!isTouchDevice()) return () => undefined;
  let startDist = 0, startSize = 0, last = 0;
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const start = (e: TouchEvent) => { if (e.touches.length === 2 && getSettings().pinchText) { startDist = dist(e.touches); startSize = getSettings().fontSize; last = startSize; } else startDist = 0; };
  const move = (e: TouchEvent) => {
    if (!startDist || e.touches.length !== 2) return;
    e.preventDefault();
    const size = Math.round(Math.min(40, Math.max(12, startSize * (dist(e.touches) / startDist))));
    if (size !== last) { last = size; updateSettings({ fontSize: size }); }
  };
  const end = () => { startDist = 0; };
  area.addEventListener('touchstart', start, { passive: true });
  area.addEventListener('touchmove', move, { passive: false });
  area.addEventListener('touchend', end); area.addEventListener('touchcancel', end);
  return () => { area.removeEventListener('touchstart', start); area.removeEventListener('touchmove', move); area.removeEventListener('touchend', end); area.removeEventListener('touchcancel', end); };
}
