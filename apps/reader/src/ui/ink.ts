// Ink on PDF pages: strokes drawn with a finger, pen or mouse, kept with the book (as fractions of the page, so
// they sit right at any zoom) and drawn into the file itself when it is exported. A small toolbar: pen, colours,
// widths, eraser, undo.
import { h, icon } from './dom';
import { t } from '../i18n';
import { uid, type InkStroke } from '../db';
import type { PdfViewer } from '../formats/pdf';
import { pushUndoScope, keyHint } from './undo';

const NS = 'http://www.w3.org/2000/svg';
export const INK_COLORS = ['#1a1a1a', '#d32f2f', '#1565c0', '#2e7d32', '#f9a825', '#8e24aa'];
const WIDTHS = [0.0025, 0.005, 0.01];

export interface InkOptions {
  viewer: PdfViewer;
  strokes(): InkStroke[];
  save(list: InkStroke[], removed?: string[]): void;
  /** Whose ink (the book's id): its undo history is kept for the session, across the layer made again. */
  key?: string;
}

// Undo / redo: every stroke drawn and every sweep of the eraser is a step, several deep, kept for the session by book
// (the layer is made again when the book is). A stroke brought back gets a new id: its old one is tombstoned for sync
// (src/ui/undo.ts says why).
type InkOp = { kind: 'add' | 'erase'; strokes: InkStroke[] };
const HISTORY = 100;
const histories = new Map<string, { undo: InkOp[]; redo: InkOp[] }>();

export interface Ink { toolbar: HTMLElement; render(page?: number): void; setOn(on: boolean): void; readonly on: boolean; dispose(): void }

/** The ink layer over a viewer's pages. */
export function inkLayer(o: InkOptions): Ink {
  const root = o.viewer.root;
  let on = false, mode: 'pen' | 'erase' = 'pen', color = INK_COLORS[0], width = WIDTHS[1];
  try { const s = JSON.parse(localStorage.getItem('kr.ink') ?? '{}') as { color?: string; width?: number }; if (s.color) color = s.color; if (s.width) width = s.width; } catch { /* defaults */ }
  const remember = () => { try { localStorage.setItem('kr.ink', JSON.stringify({ color, width })); } catch { /* private mode */ } };
  const hist = o.key ? (histories.get(o.key) ?? histories.set(o.key, { undo: [], redo: [] }).get(o.key)!) : { undo: [], redo: [] };
  const pushOp = (op: InkOp) => { hist.undo.push(op); if (hist.undo.length > HISTORY) hist.undo.shift(); hist.redo.length = 0; };
  const pagesOf = (list: InkStroke[]) => [...new Set(list.map((s) => s.page))];
  const drop = (ids: string[]) => { const set = new Set(ids); o.save(o.strokes().filter((s) => !set.has(s.id)), ids); };
  const bring = (list: InkStroke[]): InkStroke[] => { const again = list.map((s) => ({ ...s, id: uid() })); o.save([...o.strokes(), ...again]); return again; };
  let sweep: InkOp | null = null;
  const undoInk = (): boolean => {
    const op = hist.undo.pop();
    if (!op) {
      // (Nothing done here this session: the last stroke drawn before is taken back, as always.)
      const list = o.strokes(); if (!list.length) return false;
      const last = list.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      drop([last.id]); hist.redo.push({ kind: 'add', strokes: [last] }); pagesOf([last]).forEach((n) => render(n)); syncBar(); return true;
    }
    if (op.kind === 'add') drop(op.strokes.map((s) => s.id)); else op.strokes = bring(op.strokes);
    hist.redo.push(op); pagesOf(op.strokes).forEach((n) => render(n)); syncBar(); return true;
  };
  const redoInk = (): boolean => {
    const op = hist.redo.pop(); if (!op) return false;
    if (op.kind === 'add') op.strokes = bring(op.strokes); else drop(op.strokes.map((s) => s.id));
    hist.undo.push(op); pagesOf(op.strokes).forEach((n) => render(n)); syncBar(); return true;
  };
  let releaseKeys: (() => void) | null = null;

  const layerOf = (page: HTMLElement): SVGSVGElement => {
    let svg = page.querySelector<SVGSVGElement>(':scope > svg.pdf-ink');
    if (!svg) { svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'pdf-ink'); page.append(svg); }
    const w = page.offsetWidth || 1, hh = page.offsetHeight || 1;
    svg.setAttribute('viewBox', `0 0 1000 ${Math.round((1000 * hh) / w)}`);
    return svg;
  };
  const ratioOf = (page: HTMLElement) => { const s = page.querySelector<HTMLElement>(':scope > .pdf-sheet') ?? page; return (s.offsetHeight || 1) / (s.offsetWidth || 1); };
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
  const frac = (e: PointerEvent, page: HTMLElement) => { const b = (page.querySelector<HTMLElement>(':scope > .pdf-sheet') ?? page).getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))]; };
  const down = (e: PointerEvent) => {
    if (!on || live || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const win = (e.target as HTMLElement).closest<HTMLElement>('.pdf-page'); if (!win) return;
    const page = win.querySelector<HTMLElement>(':scope > .pdf-sheet') ?? win;
    e.preventDefault(); e.stopPropagation();
    const n = Number(win.dataset.page);
    if (mode === 'erase') { eraseAt(e, page, n, true); live = { page, n, pts: [], el: null as unknown as SVGPathElement, id: e.pointerId }; root.setPointerCapture?.(e.pointerId); return; }
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
    const l = live; live = null; strokeEnded = Date.now();
    if (mode === 'erase') { lastErase = null; sweep = null; return; }
    l.el.remove();
    const s: InkStroke = { id: uid(), page: l.n, color, w: width, pts: l.pts.map((v) => Math.round(v * 10000) / 10000), createdAt: Date.now() };
    o.save([...o.strokes(), s]); pushOp({ kind: 'add', strokes: [s] }); render(l.n); syncBar();
  };
  // The eraser takes every stroke its path comes near: the distance measured to the stroke's segments (not only
  // its sampled points — a touch between two of them counts), along the eraser's own path from where it last was
  // (a quick swipe does not jump over a stroke).
  let lastErase: [number, number] | null = null;
  const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay; const len = dx * dx + dy * dy;
    const u = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
  };
  const eraseAt = (e: PointerEvent, page: HTMLElement, n: number, first = false) => {
    const [x, y] = frac(e, page); const ratio = ratioOf(page);
    const from = first || !lastErase ? [x, y] : lastErase; lastErase = [x, y];
    const steps = Math.max(1, Math.ceil(Math.hypot(x - from[0], (y - from[1]) * ratio) / 0.004));
    const probes: [number, number][] = []; for (let k = 0; k <= steps; k++) probes.push([from[0] + ((x - from[0]) * k) / steps, (from[1] + ((y - from[1]) * k) / steps) * ratio]);
    const near = (s: InkStroke) => {
      if (s.page !== n) return false;
      const tol = Math.max(0.012, s.w * 2); const p = s.pts;
      for (const [qx, qy] of probes) {
        if (p.length === 2) { if (Math.hypot(p[0] - qx, p[1] * ratio - qy) < tol) return true; continue; }
        for (let i = 2; i < p.length; i += 2) if (segDist(qx, qy, p[i - 2], p[i - 1] * ratio, p[i], p[i + 1] * ratio) < tol) return true;
      }
      return false;
    };
    const hit = o.strokes().filter(near);
    if (!hit.length) return;
    const ids = new Set(hit.map((s) => s.id));
    o.save(o.strokes().filter((s) => !ids.has(s.id)), [...ids]);
    // (One sweep of the eraser, however many strokes it takes, is one step.)
    if (first || !sweep) { sweep = { kind: 'erase', strokes: [] }; pushOp(sweep); }
    sweep.strokes.push(...hit);
    render(n); syncBar();
  };
  // (While the pen is on, a tap or a click on a page is the pen's: the reader's tap zones — its bars shown or
  // hidden, a page turned — would move the page under the pen.)
  // (The click that ends a stroke lands on the viewer itself — the pointer was captured there — so it is
  // known by its time: a click right after a stroke or an erasure is the pen's too.)
  let strokeEnded = 0;
  const swallow = (e: Event) => {
    if (!on || (e.target as HTMLElement).closest?.('.ink-bar')) return;
    if ((e.target as HTMLElement).closest?.('.pdf-page') || Date.now() - strokeEnded < 600) { e.stopPropagation(); e.preventDefault(); }
  };
  root.addEventListener('click', swallow, true);
  root.addEventListener('dblclick', swallow, true);
  root.addEventListener('pointerdown', down, true);
  root.addEventListener('pointermove', move, true);
  root.addEventListener('pointerup', up, true);
  root.addEventListener('pointercancel', up, true);

  // The toolbar.
  const penBtn = h('button', { type: 'button', class: 'icon-btn', title: t('inkPen'), 'aria-label': t('inkPen'), 'aria-pressed': 'false', onclick: () => { mode = 'pen'; syncBar(); } }, icon('pen'));
  const eraseBtn = h('button', { type: 'button', class: 'icon-btn', title: t('inkEraser'), 'aria-label': t('inkEraser'), 'aria-pressed': 'false', onclick: () => { mode = 'erase'; syncBar(); } }, icon('eraser'));
  const tip = (what: 'undo' | 'redo') => t(what) + (keyHint(what) ? ` (${keyHint(what)})` : '');
  const undoBtn = h('button', { type: 'button', class: 'icon-btn undo-btn', title: tip('undo'), 'aria-label': t('undo'), 'data-icon': 'undo', onclick: () => { undoInk(); } }, icon('undo'));
  const redoBtn = h('button', { type: 'button', class: 'icon-btn', title: tip('redo'), 'aria-label': t('redo'), 'data-icon': 'redo', onclick: () => { redoInk(); } }, icon('undo'));
  const colors = h('div', { class: 'ink-colors', role: 'radiogroup', 'aria-label': t('color') }, ...INK_COLORS.map((c) => h('button', { type: 'button', role: 'radio', class: 'ink-color', style: { background: c }, 'aria-label': c, 'aria-checked': String(c === color), onclick: () => { color = c; mode = 'pen'; remember(); syncBar(); } })));
  const widths = h('div', { class: 'ink-widths', role: 'radiogroup', 'aria-label': t('inkWidth') }, ...WIDTHS.map((w, i) => h('button', { type: 'button', role: 'radio', class: 'ink-width', 'aria-label': `${i + 1}`, 'aria-checked': String(w === width), onclick: () => { width = w; mode = 'pen'; remember(); syncBar(); } }, h('i', { style: { height: `${3 + i * 3}px` } }))));
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', title: t('close'), 'aria-label': t('close'), onclick: () => setOn(false) }, icon('close'));
  // The colours and widths: in the bar on a wide screen; on a phone behind one swatch (the pen's colour and
  // width), opening above the bar — so the bar stays one short row at the bottom, off the page.
  const palette = h('div', { class: 'ink-palette' }, colors, widths);
  const swatch = h('i', { class: 'ink-swatch-dot' });
  const styleBtn = h('button', { type: 'button', class: 'icon-btn ink-swatch', title: t('color'), 'aria-label': t('color'), 'aria-expanded': 'false', onclick: () => { const open = !palette.classList.contains('open'); palette.classList.toggle('open', open); styleBtn.setAttribute('aria-expanded', String(open)); } }, swatch);
  palette.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) { palette.classList.remove('open'); styleBtn.setAttribute('aria-expanded', 'false'); } });
  const toolbar = h('div', { class: 'ink-bar', hidden: true, role: 'toolbar', 'aria-label': t('inkNotes') }, penBtn, eraseBtn, palette, styleBtn, undoBtn, redoBtn, closeBtn);
  const syncBar = () => {
    penBtn.setAttribute('aria-pressed', String(mode === 'pen')); eraseBtn.setAttribute('aria-pressed', String(mode === 'erase'));
    colors.querySelectorAll('.ink-color').forEach((b) => b.setAttribute('aria-checked', String(b.getAttribute('aria-label') === color)));
    widths.querySelectorAll('.ink-width').forEach((b, i) => b.setAttribute('aria-checked', String(WIDTHS[i] === width)));
    swatch.style.background = color; swatch.style.width = swatch.style.height = `${10 + WIDTHS.indexOf(width) * 4}px`;
    undoBtn.disabled = !hist.undo.length && !o.strokes().length; redoBtn.disabled = !hist.redo.length;
    root.dataset.ink = on ? mode : '';
  };
  // (While the pen is out, Ctrl+Z and Ctrl+Y are the ink's — on a computer: src/ui/undo.ts.)
  const setOn = (v: boolean) => { releaseKeys?.(); releaseKeys = v ? pushUndoScope({ undo: () => { undoInk(); return true; }, redo: () => { redoInk(); return true; } }) : null; on = v; toolbar.hidden = !v; root.classList.toggle('inking', v); root.closest('.reader-view')?.classList.toggle('inking', v); if (v) mode = 'pen'; syncBar(); };
  syncBar();
  return {
    toolbar, render, setOn, get on() { return on; },
    dispose() { releaseKeys?.(); releaseKeys = null; root.removeEventListener('click', swallow, true); root.removeEventListener('dblclick', swallow, true); root.removeEventListener('pointerdown', down, true); root.removeEventListener('pointermove', move, true); root.removeEventListener('pointerup', up, true); root.removeEventListener('pointercancel', up, true); },
  };
}
