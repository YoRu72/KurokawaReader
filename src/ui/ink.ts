// Ink on PDF pages: strokes drawn with a finger, pen or mouse, kept with the book (as fractions of the page, so
// they sit right at any zoom) and drawn into the file itself when it is exported. A small toolbar: pen, colours,
// widths, eraser, undo.
import { h, icon } from './dom';
import { t } from '../i18n';
import { uid, type InkStroke } from '../db';
import type { PdfViewer } from '../formats/pdf';

const NS = 'http://www.w3.org/2000/svg';
export const INK_COLORS = ['#1a1a1a', '#d32f2f', '#1565c0', '#2e7d32', '#f9a825', '#8e24aa'];
const WIDTHS = [0.0025, 0.005, 0.01];

export interface InkOptions {
  viewer: PdfViewer;
  strokes(): InkStroke[];
  save(list: InkStroke[], removed?: string[]): void;
}

export interface Ink { toolbar: HTMLElement; render(page?: number): void; setOn(on: boolean): void; readonly on: boolean; dispose(): void }

/** The ink layer over a viewer's pages. */
export function inkLayer(o: InkOptions): Ink {
  const root = o.viewer.root;
  let on = false, mode: 'pen' | 'erase' = 'pen', color = INK_COLORS[0], width = WIDTHS[1];
  try { const s = JSON.parse(localStorage.getItem('kr.ink') ?? '{}') as { color?: string; width?: number }; if (s.color) color = s.color; if (s.width) width = s.width; } catch { /* defaults */ }
  const remember = () => { try { localStorage.setItem('kr.ink', JSON.stringify({ color, width })); } catch { /* private mode */ } };
  const undone: InkStroke[] = [];

  const layerOf = (page: HTMLElement): SVGSVGElement => {
    let svg = page.querySelector<SVGSVGElement>(':scope > svg.pdf-ink');
    if (!svg) { svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'pdf-ink'); page.append(svg); }
    const w = page.offsetWidth || 1, hh = page.offsetHeight || 1;
    svg.setAttribute('viewBox', `0 0 1000 ${Math.round((1000 * hh) / w)}`);
    return svg;
  };
  const ratioOf = (page: HTMLElement) => (page.offsetHeight || 1) / (page.offsetWidth || 1);
  const pathD = (s: InkStroke, ratio: number): string => {
    const p = s.pts; if (p.length < 2) return '';
    if (p.length === 2) return `M${p[0] * 1000} ${p[1] * 1000 * ratio} l0.01 0`;
    let d = `M${p[0] * 1000} ${p[1] * 1000 * ratio}`;
    for (let i = 2; i < p.length; i += 2) d += ` L${p[i] * 1000} ${p[i + 1] * 1000 * ratio}`;
    return d;
  };
  const pathEl = (s: InkStroke, ratio: number): SVGPathElement => {
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', pathD(s, ratio)); el.setAttribute('stroke', s.color); el.setAttribute('stroke-width', String(s.w * 1000));
    el.setAttribute('fill', 'none'); el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round'); el.dataset.id = s.id;
    return el;
  };
  const render = (page?: number) => {
    const list = o.strokes();
    const pages = page ? [page] : [...new Set(list.map((s) => s.page))];
    for (const n of pages) {
      const el = o.viewer.pageElement(n); if (!el) continue;
      const svg = layerOf(el); const ratio = ratioOf(el);
      svg.replaceChildren(...list.filter((s) => s.page === n).map((s) => pathEl(s, ratio)));
    }
  };

  // Drawing: the pointer on a page, while the pen is on. Only one finger draws; a second one is left to the
  // viewer (pinching, scrolling).
  let live: { page: HTMLElement; n: number; pts: number[]; el: SVGPathElement; id: number } | null = null;
  const frac = (e: PointerEvent, page: HTMLElement) => { const b = page.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))]; };
  const down = (e: PointerEvent) => {
    if (!on || live || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const page = (e.target as HTMLElement).closest<HTMLElement>('.pdf-page'); if (!page) return;
    e.preventDefault(); e.stopPropagation();
    const n = Number(page.dataset.page);
    if (mode === 'erase') { eraseAt(e, page, n); live = { page, n, pts: [], el: null as unknown as SVGPathElement, id: e.pointerId }; return; }
    const [x, y] = frac(e, page);
    const s: InkStroke = { id: 'live', page: n, color, w: width, pts: [x, y], createdAt: 0 };
    const el = pathEl(s, ratioOf(page)); layerOf(page).append(el);
    live = { page, n, pts: s.pts, el, id: e.pointerId };
    root.setPointerCapture?.(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!live || e.pointerId !== live.id) return;
    e.preventDefault();
    if (mode === 'erase') { eraseAt(e, live.page, live.n); return; }
    const [x, y] = frac(e, live.page);
    const p = live.pts; const lx = p[p.length - 2], ly = p[p.length - 1];
    if (Math.hypot(x - lx, y - ly) < 0.0015) return;
    p.push(x, y);
    live.el.setAttribute('d', pathD({ id: '', page: 0, color, w: width, pts: p, createdAt: 0 }, ratioOf(live.page)));
  };
  const up = (e: PointerEvent) => {
    if (!live || e.pointerId !== live.id) return;
    const l = live; live = null;
    if (mode === 'erase') return;
    l.el.remove();
    const s: InkStroke = { id: uid(), page: l.n, color, w: width, pts: l.pts.map((v) => Math.round(v * 10000) / 10000), createdAt: Date.now() };
    o.save([...o.strokes(), s]); undone.length = 0; render(l.n); syncBar();
  };
  const eraseAt = (e: PointerEvent, page: HTMLElement, n: number) => {
    const [x, y] = frac(e, page); const ratio = ratioOf(page);
    const hit = o.strokes().filter((s) => { if (s.page !== n) return false; const tol = Math.max(0.012, s.w * 2); for (let i = 0; i < s.pts.length; i += 2) if (Math.hypot(s.pts[i] - x, (s.pts[i + 1] - y) * ratio) < tol) return true; return false; });
    if (!hit.length) return;
    const ids = new Set(hit.map((s) => s.id));
    o.save(o.strokes().filter((s) => !ids.has(s.id)), [...ids]); render(n);
  };
  root.addEventListener('pointerdown', down, true);
  root.addEventListener('pointermove', move, true);
  root.addEventListener('pointerup', up, true);
  root.addEventListener('pointercancel', up, true);

  // The toolbar.
  const penBtn = h('button', { type: 'button', class: 'icon-btn', title: t('inkPen'), 'aria-label': t('inkPen'), 'aria-pressed': 'false', onclick: () => { mode = 'pen'; syncBar(); } }, icon('pen'));
  const eraseBtn = h('button', { type: 'button', class: 'icon-btn', title: t('inkEraser'), 'aria-label': t('inkEraser'), 'aria-pressed': 'false', onclick: () => { mode = 'erase'; syncBar(); } }, icon('eraser'));
  const undoBtn = h('button', { type: 'button', class: 'icon-btn', title: t('undo'), 'aria-label': t('undo'), onclick: () => {
    const list = o.strokes(); if (!list.length) return;
    const last = list.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)); undone.push(last);
    o.save(list.filter((s) => s.id !== last.id), [last.id]); render(last.page); syncBar();
  } }, icon('back'));
  const redoBtn = h('button', { type: 'button', class: 'icon-btn', title: t('redo'), 'aria-label': t('redo'), onclick: () => { const s = undone.pop(); if (!s) return; o.save([...o.strokes(), { ...s, id: uid(), createdAt: Date.now() }]); render(s.page); syncBar(); } }, icon('arrowRight'));
  const colors = h('div', { class: 'ink-colors', role: 'radiogroup', 'aria-label': t('color') }, ...INK_COLORS.map((c) => h('button', { type: 'button', role: 'radio', class: 'ink-color', style: { background: c }, 'aria-label': c, 'aria-checked': String(c === color), onclick: () => { color = c; mode = 'pen'; remember(); syncBar(); } })));
  const widths = h('div', { class: 'ink-widths', role: 'radiogroup', 'aria-label': t('inkWidth') }, ...WIDTHS.map((w, i) => h('button', { type: 'button', role: 'radio', class: 'ink-width', 'aria-label': `${i + 1}`, 'aria-checked': String(w === width), onclick: () => { width = w; mode = 'pen'; remember(); syncBar(); } }, h('i', { style: { height: `${3 + i * 3}px` } }))));
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', title: t('close'), 'aria-label': t('close'), onclick: () => setOn(false) }, icon('close'));
  const toolbar = h('div', { class: 'ink-bar', hidden: true, role: 'toolbar', 'aria-label': t('inkNotes') }, penBtn, colors, widths, eraseBtn, undoBtn, redoBtn, closeBtn);
  const syncBar = () => {
    penBtn.setAttribute('aria-pressed', String(mode === 'pen')); eraseBtn.setAttribute('aria-pressed', String(mode === 'erase'));
    colors.querySelectorAll('.ink-color').forEach((b) => b.setAttribute('aria-checked', String(b.getAttribute('aria-label') === color)));
    widths.querySelectorAll('.ink-width').forEach((b, i) => b.setAttribute('aria-checked', String(WIDTHS[i] === width)));
    undoBtn.disabled = !o.strokes().length; redoBtn.disabled = !undone.length;
    root.dataset.ink = on ? mode : '';
  };
  const setOn = (v: boolean) => { on = v; toolbar.hidden = !v; root.classList.toggle('inking', v); if (v) mode = 'pen'; syncBar(); };
  syncBar();
  return {
    toolbar, render, setOn, get on() { return on; },
    dispose() { root.removeEventListener('pointerdown', down, true); root.removeEventListener('pointermove', move, true); root.removeEventListener('pointerup', up, true); root.removeEventListener('pointercancel', up, true); },
  };
}
