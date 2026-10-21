// Moon+-style brightness gesture: drag up/down along the left edge of the page
// to dim or brighten it (the reader's own dimming overlay — no system permission).
import { getSettings, updateSettings } from '../settings';
import { h } from './dom';
import { t, localDigits, isTouchDevice } from '../i18n';

export function attachEdgeBrightness(area: HTMLElement): () => void {
  if (!isTouchDevice()) return () => undefined;
  let startY = 0, startDim = 0, active = false, moved = false;
  let hud: HTMLElement | null = null; let hideT = 0;
  const show = (v: number) => {
    if (!hud) { hud = h('div', { class: 'brightness-hud' }); document.body.appendChild(hud); }
    hud.textContent = `${t('brightness')} ${localDigits(Math.round((1 - v / 0.7) * 100))}%`;
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
  };
  const move = (e: PointerEvent) => {
    if (!active) return;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dy) < 12) return;
    moved = true;
    e.preventDefault();
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
