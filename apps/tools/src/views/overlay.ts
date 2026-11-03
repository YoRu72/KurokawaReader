// The computer's screen translator, on the screen itself (desktop/screentr.cjs opens these windows): the frozen
// screen to draw a region on — or all of it — with the translations drawn over the words, on their own colours;
// the small caption window of «auto», under a watched region; the clipboard's text translated by the mouse.
import { h, icon } from '../ui/dom';
import { t } from '../i18n';
import { loadScreen, type ScreenConfig } from '../screen/config';
import { translateTexts, aiVision } from '../screen/translate';

type Block = { text: string; x: number; y: number; width: number; height: number; tr?: string };
type Job = { mode: 'region' | 'full' | 'result' | 'text'; image?: string; width?: number; height?: number; scale?: number; text?: string; cfg: Partial<ScreenConfig> };
type Bridge = { screenJob(): Promise<Job | null>; screenRegion(r: { x: number; y: number; width: number; height: number } | null): Promise<{ blocks?: Block[]; ai?: string; offset?: { x: number; y: number }; scale?: number }>; screenClose(): Promise<void>; screenCaptionSize(o: { height: number }): Promise<void>; onScreenCaption(cb: (o: { text: string }) => void): () => void; screenStatus(): Promise<{ region: { x: number; y: number; width: number; height: number } | null }> };
const bridge = (): Bridge | null => (window as unknown as { kurokawaTools?: Bridge }).kurokawaTools ?? null;

export function overlayView(): HTMLElement {
  document.documentElement.classList.add('kt-overlay-doc');
  const q = new URLSearchParams(location.hash.split('?')[1] ?? ''); const root = h('div', { class: 'kt-overlay' });
  const cfg = loadScreen();
  if (q.get('caption')) { caption(root, cfg); return root; }
  if (q.get('text')) { void textPopup(root, cfg); return root; }
  void frozen(root, cfg, q.get('go') === '1');
  return root;
}

const close = () => void bridge()?.screenClose();
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.documentElement.classList.contains('kt-overlay-doc')) close(); });

/** The frozen screen: a region drawn (or all of it), read, translated, drawn over. */
async function frozen(root: HTMLElement, cfg: ScreenConfig, again: boolean): Promise<void> {
  const job = await bridge()?.screenJob(); if (!job?.image) { close(); return; }
  const img = h('img', { class: 'kt-ov-shot', src: job.image, alt: '', draggable: false }) as HTMLImageElement;
  const shade = h('div', { class: 'kt-ov-shade' }); const sel = h('div', { class: 'kt-ov-sel', hidden: true }); const boxes = h('div', { class: 'kt-ov-boxes' });
  const hint = h('div', { class: 'kt-ov-hint' }, job.mode === 'region' && !again ? t('scr_drawRegion') : t('scrOvReading'));
  const bar = h('div', { class: 'kt-ov-bar', hidden: true });
  root.append(img, shade, sel, boxes, hint, bar);
  await img.decode().catch(() => undefined);
  const go = async (r: { x: number; y: number; width: number; height: number } | null) => {
    hint.textContent = t('scrOvReading'); hint.hidden = false; shade.classList.add('busy');
    try {
      const res = await bridge()!.screenRegion(r); let blocks: Block[] = res.blocks ?? [];
      if (res.ai) { const area = r ?? { x: 0, y: 0, width: innerWidth, height: innerHeight }; const v = await aiVision(res.ai, cfg); blocks = v.map((b) => ({ text: b.text, tr: b.tr, x: area.x + b.x * area.width, y: area.y + b.y * area.height, width: b.w * area.width, height: b.h * area.height })); }
      else if (blocks.length) { const tr = await translateTexts(blocks.map((b) => b.text), cfg); blocks.forEach((b, i) => { b.tr = tr[i]; }); }
      if (!blocks.length) { hint.textContent = t('scr_noText'); setTimeout(close, 1400); return; }
      hint.hidden = true; shade.classList.remove('busy'); shade.classList.add('done');
      draw(blocks); toolbar(blocks);
    } catch (e) { const m = String((e as Error).message ?? e); hint.textContent = m === 'ocr-missing' ? t('scrOvNoOcr') : /deeplKey/.test(m) ? t('scrNeedEngine') : `${t('scr_failed')}: ${m.slice(0, 160)}`; shade.classList.remove('busy'); }
  };
  const colours = (() => { try { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d', { willReadFrequently: true })!; x.drawImage(img, 0, 0); return x; } catch { return null; } })();
  const s = job.scale ?? 1;
  const around = (b: Block): [string, string] | null => {
    if (!colours || cfg.style.smart === false) return null;
    const count = new Map<number, number>(); let best = 0, bestN = -1;
    const px = (x: number, y: number) => { const d = colours.getImageData(Math.max(0, Math.min(img.naturalWidth - 1, Math.round(x * s))), Math.max(0, Math.min(img.naturalHeight - 1, Math.round(y * s))), 1, 1).data; const k = ((d[0] & 0xf0) << 16) | ((d[1] & 0xf0) << 8) | (d[2] & 0xf0); const n = (count.get(k) ?? 0) + 1; count.set(k, n); if (n > bestN) { bestN = n; best = k; } };
    for (let i = 0; i <= 12; i++) { const x = b.x - 2 + (b.width + 4) * i / 12; px(x, b.y - 2); px(x, b.y + b.height + 2); }
    for (let i = 0; i <= 6; i++) { const y = b.y + b.height * i / 6; px(b.x - 2, y); px(b.x + b.width + 2, y); }
    const r = (best >> 16) & 255, g = (best >> 8) & 255, bl = best & 255; const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
    return [`rgb(${r + 8},${g + 8},${bl + 8})`, lum > 140 ? '#111' : '#fff'];
  };
  function draw(blocks: Block[]): void {
    const st = cfg.style; boxes.replaceChildren();
    for (const b of blocks) {
      if (!b.tr) continue; const col = around(b);
      const el = h('div', { class: 'kt-ov-box', dir: 'auto', title: b.text, style: { left: `${b.x}px`, top: `${b.y}px`, minWidth: `${Math.max(24, b.width)}px`, minHeight: `${Math.max(14, b.height)}px`, maxWidth: `${Math.max(b.width * 1.6, 120)}px`, color: col?.[1] ?? st.fg, background: st.bgMode === 'none' ? 'transparent' : col?.[0] ?? `color-mix(in srgb, ${st.bg} ${Math.round(st.bgAlpha * 100)}%, transparent)`, borderRadius: `${st.radius}px`, fontWeight: st.bold ? '700' : '400', textAlign: st.center ? 'center' : 'start', textShadow: st.outline ? '0 0 3px #000, 0 0 2px #000' : 'none' } }, b.tr);
      el.addEventListener('click', (e) => { e.stopPropagation(); void navigator.clipboard?.writeText(b.tr ?? '').catch(() => undefined); el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 700); });
      boxes.append(el);
      // (The text fitted to the words' own height: smaller until it fits, never under 9 px.)
      let size = Math.max(10, Math.min(st.size * 1.4, b.height * 0.92)); el.style.fontSize = `${size}px`;
      while (size > 9 && (el.scrollHeight > Math.max(b.height, 14) * 1.25 || el.scrollWidth > el.clientWidth + 1)) { size -= 1; el.style.fontSize = `${size}px`; }
    }
  }
  function toolbar(blocks: Block[]): void {
    bar.hidden = false;
    bar.replaceChildren(
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => void navigator.clipboard?.writeText(blocks.map((b) => b.tr).join('\n')).catch(() => undefined) }, icon('copy'), t('copy')),
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => { boxes.classList.toggle('hidden'); } }, icon('eye'), t('scrOvOriginal')),
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const l = h('div', { class: 'kt-ov-list', dir: 'auto' }, ...blocks.map((b) => h('p', null, h('b', null, b.tr ?? ''), h('small', null, b.text)))); root.append(l); } }, icon('list'), t('scr_list')),
      h('button', { type: 'button', class: 'btn filled small', onclick: close }, icon('close'), t('close')));
  }
  if (job.mode === 'full') { void go(null); return; }
  if (again) { const st = await bridge()!.screenStatus(); if (st.region) { void go({ x: st.region.x, y: st.region.y, width: st.region.width, height: st.region.height }); return; } }
  // Drawing the region.
  let start: { x: number; y: number } | null = null;
  root.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).closest('.kt-ov-bar, .kt-ov-box, .kt-ov-list')) return; if (shade.classList.contains('done')) { close(); return; } start = { x: e.clientX, y: e.clientY }; sel.hidden = false; root.setPointerCapture(e.pointerId); });
  root.addEventListener('pointermove', (e) => { if (!start) return; const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY); Object.assign(sel.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - start.x)}px`, height: `${Math.abs(e.clientY - start.y)}px` }); });
  root.addEventListener('pointerup', (e) => { if (!start) return; const r = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) }; start = null; if (r.width < 8 || r.height < 6) { sel.hidden = true; return; } void go(r); });
}

/** «Auto»: the watched region's text, translated, in the small window beneath it. */
function caption(root: HTMLElement, cfg: ScreenConfig): void {
  root.classList.add('kt-ov-caption'); const line = h('div', { class: 'kt-ov-cap', dir: 'auto' }); root.append(line);
  line.style.fontSize = `${Math.max(14, cfg.style.size + 3)}px`; line.style.color = cfg.style.fg; line.style.background = `color-mix(in srgb, ${cfg.style.bg} ${Math.round(cfg.style.bgAlpha * 100)}%, transparent)`;
  let n = 0;
  bridge()?.onScreenCaption(async ({ text }) => {
    const my = ++n;
    try { const [tr] = await translateTexts([text.replace(/\n+/g, ' ')], cfg); if (my !== n) return; line.textContent = tr; } catch (e) { line.textContent = String((e as Error).message ?? e).slice(0, 120); }
    void bridge()?.screenCaptionSize({ height: line.scrollHeight + 16 });
  });
}

/** The clipboard's text, translated, by the mouse. */
async function textPopup(root: HTMLElement, cfg: ScreenConfig): Promise<void> {
  root.classList.add('kt-ov-popup'); const job = await bridge()?.screenJob(); const text = job?.text ?? '';
  const out = h('p', { class: 'kt-ov-tr', dir: 'auto' }, '…');
  root.append(h('div', { class: 'kt-ov-pophead' }, h('b', null, t('scrTitle')), h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), onclick: close }, icon('close'))), out, h('p', { class: 'kt-ov-orig', dir: 'auto' }, text),
    h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn tonal small', onclick: () => void navigator.clipboard?.writeText(out.textContent ?? '').catch(() => undefined) }, icon('copy'), t('copy'))));
  try { const lines = text.split(/\n/); const tr = await translateTexts(lines, cfg); out.textContent = tr.join('\n'); } catch (e) { out.textContent = String((e as Error).message ?? e); }
}
