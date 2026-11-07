// (The same file is in both apps' src/ui: a change to one goes to both.)
// An icon made from any picture: chosen, moved under a square frame by the finger or the mouse, zoomed (wheel,
// pinch, slider), turned by quarters, its shape seen as a launcher would show it (round, rounded, square), and
// what the picture leaves bare filled with a colour. Gives a 512×512 PNG (a data URL), or null when let go.
import { h, icon, iconButton, openSheet, toast } from './dom';
import { t, localDigits } from '../i18n';

const OUT = 512;
export type IconShape = 'circle' | 'squircle' | 'square';

/** Asks for a picture (a file), then crops it. */
export function pickIconImage(): Promise<string | null> {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept: 'image/*', hidden: true }) as HTMLInputElement; document.body.append(inp);
    inp.addEventListener('change', () => { const f = inp.files?.[0]; inp.remove(); if (!f) { resolve(null); return; } const r = new FileReader(); r.onload = () => void cropIcon(String(r.result)).then(resolve); r.onerror = () => { toast(t('iconCantRead'), 'error'); resolve(null); }; r.readAsDataURL(f); });
    inp.addEventListener('cancel', () => { inp.remove(); resolve(null); });
    inp.click();
  });
}

export function cropIcon(src: string, o: { title?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image(); img.decoding = 'async';
    img.onerror = () => { toast(t('iconCantRead'), 'error'); resolve(null); };
    img.onload = () => {
      let done = false; const finish = (v: string | null) => { if (done) return; done = true; resolve(v); };
      const sh = openSheet(o.title ?? t('iconCropTitle'), t('cancel'), { stack: true }); sh.el.classList.add('icon-crop');
      // (Closed any way — its button, the scrim, Escape —: nothing chosen.)
      const mo = new MutationObserver(() => { if (!sh.el.isConnected) { mo.disconnect(); finish(null); } }); mo.observe(document.body, { childList: true });
      const SZ = 280; const dpr = Math.min(3, window.devicePixelRatio || 1);
      const cv = h('canvas', { class: 'ic-canvas', width: String(SZ * dpr), height: String(SZ * dpr), 'aria-label': t('iconCropTitle') }) as HTMLCanvasElement; const ctx = cv.getContext('2d')!;
      let shape: IconShape = 'squircle'; let bg = '#ffffff'; let fill = false; let rot = 0;
      const fit = () => { const w = rot % 2 ? img.height : img.width, hh = rot % 2 ? img.width : img.height; return Math.max(SZ / w, SZ / hh); };
      let base = fit(); let zoom = 1; let x = 0, y = 0;
      const clampPan = () => { const s = base * zoom; const w = (rot % 2 ? img.height : img.width) * s, hh = (rot % 2 ? img.width : img.height) * s; const mx = Math.max(0, (w - SZ) / 2), my = Math.max(0, (hh - SZ) / 2); if (!fill) { x = Math.max(-mx, Math.min(mx, x)); y = Math.max(-my, Math.min(my, y)); } };
      const clip = (c: CanvasRenderingContext2D, size: number) => { c.beginPath(); if (shape === 'circle') c.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); else if (shape === 'squircle') c.roundRect(0, 0, size, size, size * 0.24); else c.rect(0, 0, size, size); c.closePath(); };
      const paint = (c: CanvasRenderingContext2D, size: number, preview: boolean) => {
        const k = size / SZ; c.save(); c.clearRect(0, 0, size, size);
        if (preview) { c.fillStyle = '#0003'; c.fillRect(0, 0, size, size); }
        clip(c, size); c.save(); c.clip();
        if (fill) { c.fillStyle = bg; c.fillRect(0, 0, size, size); }
        c.translate(size / 2 + x * k, size / 2 + y * k); c.rotate((rot * Math.PI) / 2); const s = base * zoom * k; c.drawImage(img, (-img.width * s) / 2, (-img.height * s) / 2, img.width * s, img.height * s);
        c.restore(); if (preview) { clip(c, size); c.strokeStyle = '#fff8'; c.lineWidth = 2 * dpr; c.stroke(); } c.restore();
      };
      const draw = () => { clampPan(); paint(ctx, SZ * dpr, true); };
      // (Moving: one finger or the mouse; two fingers pinch; the wheel zooms.)
      const pts = new Map<number, { x: number; y: number }>(); let pinch0 = 0, zoom0 = 1;
      cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = zoom; } });
      cv.addEventListener('pointermove', (e) => { const p = pts.get(e.pointerId); if (!p) return; if (pts.size === 2) { pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch0) setZoom(zoom0 * (d / pinch0)); return; } x += e.clientX - p.x; y += e.clientY - p.y; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); draw(); });
      const up = (e: PointerEvent) => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = 0; }; cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      cv.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }, { passive: false });
      const slider = h('input', { type: 'range', min: '0.3', max: '5', step: '0.01', value: '1', 'aria-label': t('iconZoom'), oninput: (e: Event) => setZoom(Number((e.target as HTMLInputElement).value)) }) as HTMLInputElement;
      const setZoom = (v: number) => { zoom = Math.max(fill ? 0.3 : 1, Math.min(5, v)); slider.value = String(zoom); draw(); };
      const seg = <T extends string>(opts: [T, string][], cur: () => T, set: (v: T) => void) => { const row = h('div', { class: 'segmented' }); const paintRow = () => row.replaceChildren(...opts.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(cur() === v), onclick: () => { set(v); paintRow(); draw(); } }, l))); paintRow(); return row; };
      const color = h('input', { type: 'color', value: bg, 'aria-label': t('iconBackground'), oninput: (e: Event) => { bg = (e.target as HTMLInputElement).value; draw(); } }) as HTMLInputElement;
      const fillBox = h('label', { class: 'switch-row ic-fill' }, h('input', { type: 'checkbox', onchange: (e: Event) => { fill = (e.target as HTMLInputElement).checked; color.disabled = !fill; if (!fill) setZoom(Math.max(1, zoom)); else draw(); } }), h('span', null, t('iconFill')), color);
      color.disabled = true;
      sh.body.append(
        h('div', { class: 'ic-stage' }, cv),
        h('div', { class: 'ic-row' }, icon('search'), slider, iconButton('rotate', t('iconRotate'), () => { rot = (rot + 1) % 4; base = fit(); x = y = 0; draw(); }), iconButton('undo', t('iconResetCrop'), () => { rot = 0; base = fit(); zoom = 1; x = y = 0; slider.value = '1'; draw(); })),
        h('div', { class: 'field' }, h('label', null, t('iconShape')), seg<IconShape>([['circle', t('iconShapeCircle')], ['squircle', t('iconShapeRounded')], ['square', t('iconShapeSquare')]], () => shape, (v) => { shape = v; })),
        fillBox, h('p', { class: 'hint' }, t('iconCropHint', { n: localDigits(OUT) })));
      sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { const out = document.createElement('canvas'); out.width = out.height = OUT; paint(out.getContext('2d')!, OUT, false); const url = out.toDataURL('image/png'); finish(url); sh.close(); } }, icon('check'), t('iconUse')));
      draw();
    };
    img.src = src;
  });
}
