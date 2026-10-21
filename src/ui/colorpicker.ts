// Colour picking: a swatch button that opens a sheet with a hue ring + SV triangle
// (drawn on a canvas, works with touch and mouse), a hex field and a few presets.
import { h, icon, openSheet } from './dom';
import { t } from '../i18n';

function hsvToRgb(hh: number, s: number, v: number): [number, number, number] {
  const c = v * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) { hh = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360; }
  return [hh, max ? d / max : 0, max];
}
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()); if (!m) { const s = /^#?([0-9a-f]{3})$/i.exec(hex.trim()); if (!s) return null; const [a, b, c] = s[1]; return [parseInt(a + a, 16), parseInt(b + b, 16), parseInt(c + c, 16)]; }
  const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');

/** Swatch + hex field; tapping the swatch opens the picker sheet. */
export function colorField(value: string, onChange: (hex: string) => void, label?: string): HTMLElement {
  const swatch = h('button', { type: 'button', class: 'color-swatch', 'aria-label': label ?? t('pickColor'), style: { background: value } });
  const hex = h('input', { type: 'text', class: 'hex-input', value, dir: 'ltr', spellcheck: 'false', maxlength: '7' }) as HTMLInputElement;
  const set = (v: string, fire = true) => { swatch.style.background = v; hex.value = v; if (fire) onChange(v); };
  hex.addEventListener('change', () => { const rgb = hexToRgb(hex.value); if (rgb) set(rgbToHex(...rgb)); else hex.value = swatch.style.background; });
  swatch.addEventListener('click', () => openColorSheet(hex.value, (v) => set(v), label));
  return h('div', { class: 'color-field' }, swatch, hex);
}

export function openColorSheet(initial: string, onChange: (hex: string) => void, title = t('pickColor')): void {
  const sh = openSheet(title, t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  let [hue, sat, val] = rgbToHsv(...(hexToRgb(initial) ?? [128, 128, 128]));
  const size = Math.min(300, window.innerWidth - 64);
  const canvas = h('canvas', { width: String(size), height: String(size), class: 'color-wheel' }) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const R = size / 2, ring = R * 0.17, rIn = R - ring, tri = rIn * 0.92;
  const preview = h('div', { class: 'color-preview' });
  const hex = h('input', { type: 'text', class: 'hex-input', dir: 'ltr', spellcheck: 'false', maxlength: '7' }) as HTMLInputElement;
  const current = () => rgbToHex(...hsvToRgb(hue, sat, val));
  const triPts = () => {
    const a = (hue * Math.PI) / 180;
    const p = (ang: number) => [R + tri * Math.cos(ang), R + tri * Math.sin(ang)] as [number, number];
    return { c: p(a), w: p(a + (2 * Math.PI) / 3), b: p(a + (4 * Math.PI) / 3) }; // pure colour, white, black
  };
  function draw() {
    ctx.clearRect(0, 0, size, size);
    // hue ring
    for (let d = 0; d < 360; d += 1) {
      ctx.beginPath(); ctx.strokeStyle = `hsl(${d} 100% 50%)`; ctx.lineWidth = ring;
      ctx.arc(R, R, R - ring / 2, ((d - 1) * Math.PI) / 180, ((d + 1.5) * Math.PI) / 180); ctx.stroke();
    }
    // SV triangle: gradient fill via image data
    const { c, w, b } = triPts();
    const img = ctx.createImageData(size, size);
    const [cr, cg, cb] = hsvToRgb(hue, 1, 1);
    const det = (w[1] - b[1]) * (c[0] - b[0]) + (b[0] - w[0]) * (c[1] - b[1]);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const l1 = ((w[1] - b[1]) * (x - b[0]) + (b[0] - w[0]) * (y - b[1])) / det;   // weight of pure colour
      const l2 = ((b[1] - c[1]) * (x - b[0]) + (c[0] - b[0]) * (y - b[1])) / det;   // weight of white
      const l3 = 1 - l1 - l2;                                                        // weight of black
      if (l1 < -0.003 || l2 < -0.003 || l3 < -0.003) continue;
      const i = (y * size + x) * 4;
      img.data[i] = cr * l1 + 255 * l2; img.data[i + 1] = cg * l1 + 255 * l2; img.data[i + 2] = cb * l1 + 255 * l2; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // markers
    const ha = (hue * Math.PI) / 180;
    ctx.beginPath(); ctx.arc(R + (R - ring / 2) * Math.cos(ha), R + (R - ring / 2) * Math.sin(ha), ring / 2 - 2, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.lineWidth = 1; ctx.strokeStyle = '#000'; ctx.stroke();
    // s,v → point: colour weight = s*v, white weight = v*(1-s), black weight = 1-v
    const l1 = sat * val, l2 = val * (1 - sat), l3 = 1 - val;
    const px = c[0] * l1 + w[0] * l2 + b[0] * l3, py = c[1] * l1 + w[1] * l2 + b[1] * l3;
    ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = val > 0.6 && sat < 0.5 ? '#000' : '#fff'; ctx.stroke();
    const hx = current(); preview.style.background = hx; hex.value = hx;
  }
  let mode: 'ring' | 'tri' | null = null;
  const pick = (ev: PointerEvent, start = false) => {
    const r = canvas.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * size, y = ((ev.clientY - r.top) / r.height) * size;
    const dx = x - R, dy = y - R, dist = Math.hypot(dx, dy);
    if (start) mode = dist > rIn - 4 && dist <= R + 6 ? 'ring' : 'tri';
    if (mode === 'ring') { hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360; }
    else {
      const { c, w, b } = triPts();
      const det = (w[1] - b[1]) * (c[0] - b[0]) + (b[0] - w[0]) * (c[1] - b[1]);
      let l1 = ((w[1] - b[1]) * (x - b[0]) + (b[0] - w[0]) * (y - b[1])) / det;
      let l2 = ((b[1] - c[1]) * (x - b[0]) + (c[0] - b[0]) * (y - b[1])) / det;
      l1 = Math.max(0, Math.min(1, l1)); l2 = Math.max(0, Math.min(1 - l1, l2));
      val = Math.min(1, l1 + l2); sat = val ? l1 / val : 0;
    }
    draw(); onChange(current());
  };
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pick(e, true); });
  canvas.addEventListener('pointermove', (e) => { if (mode && e.buttons) pick(e); });
  canvas.addEventListener('pointerup', () => { mode = null; });
  canvas.style.touchAction = 'none';
  hex.addEventListener('change', () => { const rgb = hexToRgb(hex.value); if (rgb) { [hue, sat, val] = rgbToHsv(...rgb); draw(); onChange(current()); } else hex.value = current(); });
  const presets = ['#1b1b1b', '#141414', '#000000', '#f3e8d2', '#ebe5da', '#fbfaf7', '#d2d2d2', '#cfcbc4', '#3b2f21', '#e5c56b', '#e58a8a', '#7fcfa5', '#7fb4e5', '#b9a3e8', '#8fd0f0', '#ebc47e'];
  sh.body.append(
    h('div', { class: 'color-sheet' }, canvas,
      h('div', { class: 'color-side' }, preview, hex,
        h('div', { class: 'color-presets' }, ...presets.map((p) => h('button', { type: 'button', style: { background: p }, 'aria-label': p, onclick: () => { [hue, sat, val] = rgbToHsv(...hexToRgb(p)!); draw(); onChange(current()); } }))))));
  sh.actions.append(h('button', { class: 'btn small primary', type: 'button', onclick: () => sh.close() }, icon('check'), t('done')));
  draw();
}
