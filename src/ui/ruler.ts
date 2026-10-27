// The reading ruler: a clear band two or three lines tall that follows the mouse, or the last touch, while
// the rest of the page is dimmed a little — the eye keeps its line, as a finger under the text would. The
// band is a layer of its own over the text and never touches it, so selection and taps work as before.
import { getSettings, onSettingsChange } from '../settings';

export function attachRuler(root: HTMLElement, area: HTMLElement): () => void {
  let band: HTMLElement | null = null;
  let y = -1;
  const lines = () => { const s = getSettings(); return s.fontSize * s.lineHeight; };
  const place = () => {
    if (!band) return;
    const r = area.getBoundingClientRect(); const rr = root.getBoundingClientRect();
    const hgt = Math.round(lines() * 2.4);
    const top = y < 0 ? r.top - rr.top + r.height * 0.4 : Math.min(r.bottom - rr.top - hgt, Math.max(r.top - rr.top, y - rr.top - hgt / 2));
    band.style.height = `${hgt}px`; band.style.top = `${top}px`;
  };
  const sync = () => {
    const on = getSettings().readingRuler;
    if (on && !band) { band = document.createElement('div'); band.className = 'read-ruler'; band.setAttribute('aria-hidden', 'true'); root.appendChild(band); place(); }
    else if (!on && band) { band.remove(); band = null; }
    else if (band) place();
  };
  const move = (e: PointerEvent) => { if (!band) return; if (e.pointerType === 'touch' && e.type === 'pointermove') return; y = e.clientY; place(); };
  area.addEventListener('pointermove', move, { passive: true });
  area.addEventListener('pointerdown', move, { passive: true });
  const off = onSettingsChange(sync);
  sync();
  return () => { off(); area.removeEventListener('pointermove', move); area.removeEventListener('pointerdown', move); band?.remove(); band = null; };
}
