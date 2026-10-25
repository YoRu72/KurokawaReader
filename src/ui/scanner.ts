// The document scanner: photos of pages (taken here or picked) found in the picture, straightened, cleaned
// and put in order, then saved as one PDF. Every page can be adjusted by hand — its four corners, its turn,
// its look — and the defaults are the reader's settings. The picture work is in ../scan.ts.
import { h, icon, openSheet, toast, pickButton, debounce } from './dom';
import { t, localDigits, getLang, countPages } from '../i18n';
import * as S from '../scan';
import { runner, pickFiles, pdfBlob, onSheetClosed } from './pdftools';
import { sortable, placeNumber } from './sortable';
import { scanWork, parallel } from '../scanpool';
import type { Look, Prepared } from '../scanops';

type Quality = 'standard' | 'high' | 'max';
type Settings = { size: 'page' | 'a4' | 'letter'; filter: S.Filter; quality: Quality; autoCrop: boolean; autoTurn: boolean; flatten: boolean; split: boolean };
const DEFAULTS: Settings = { size: 'page', filter: 'auto', quality: 'high', autoCrop: true, autoTurn: true, flatten: true, split: true };
const KEY = 'kr.scan';
const SIDE: Record<Quality, number> = { standard: 1700, high: 2400, max: 3300 };
const PREVIEW = 1200;

export function scanSettings(): Settings {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) }; } catch { return { ...DEFAULTS }; }
}
function saveSettings(s: Settings): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }

/** One scanned page: the photo, where the page is in it (corners as fractions of the photo), how the page
 *  bends (a book's), and how it is to come out. Until its photo has been read it is only `pending`. */
type Page = Look & { file: Blob; preview: S.Img | null; thumb: string; pending: boolean; error?: string; key: number };

/* ---------- pictures ---------- */

function toCanvas(img: S.Img, c = document.createElement('canvas')): HTMLCanvasElement {
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(img.data as unknown as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return c;
}

const FULL: S.Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const lookOf = (p: Look): Look => ({ quad: p.quad.map((c) => ({ ...c })) as S.Quad, curve: p.curve, flatten: p.flatten, turn: p.turn, filter: p.filter, adj: { ...p.adj } });

/**
 * A page's photo at working size. Only the last few used are held (each is megabytes: thirty of them held at once
 * is what can bring a phone's app down); the others are read again from the photo when needed.
 */
const held: Page[] = [];
function hold(p: Page): void {
  const i = held.indexOf(p); if (i >= 0) held.splice(i, 1);
  held.unshift(p);
  while (held.length > 6) { const o = held.pop()!; o.preview = null; }
}
async function previewOf(p: Page): Promise<S.Img> {
  if (!p.preview) p.preview = await scanWork<S.Img>({ op: 'decode', blob: p.file, maxSide: PREVIEW });
  hold(p);
  return p.preview;
}

const thumbSeq = new WeakMap<Page, number>();
async function makeThumb(p: Page): Promise<void> {
  if (p.pending) return;
  const my = (thumbSeq.get(p) ?? 0) + 1; thumbSeq.set(p, my);
  const b = await scanWork<Blob>({ op: 'thumb', preview: await previewOf(p), look: lookOf(p) });
  if (thumbSeq.get(p) !== my) return; // (Turned again meanwhile: the later thumb is the one to show.)
  if (p.thumb) URL.revokeObjectURL(p.thumb);
  p.thumb = URL.createObjectURL(b);
}

/** Run `work` over `items`, `n` at a time, in order of starting. */
async function pooled<T>(items: T[], n: number, work: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; await work(items[i], i); } }));
}

/* ---------- the scanner sheet ---------- */

export function scannerSheet(onDone?: () => void): void {
  const sh = openSheet(t('toolScan'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  sh.el.classList.add('scan-sheet');
  const pages: Page[] = [];
  let set = scanSettings();
  const gridEl = h('div', { class: 'page-grid scan-grid' });
  const status = h('p', { class: 'src' });
  const rtlUi = document.documentElement.dir === 'rtl';

  // Every photo gets its tile at once; the photos are read several at a time, in worker threads (the way a
  // scanning app does it: decoded straight to a small working size, the page found there), and each tile fills
  // in as its photo is ready.
  let keySeq = 0;
  const add = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i.test(f.name));
    if (!pics.length) return;
    const fresh: Page[] = pics.map((f) => ({ file: f, preview: null, quad: FULL, curve: null, flatten: set.flatten, turn: 0, filter: set.filter, adj: {}, thumb: '', pending: true, key: ++keySeq }));
    pages.push(...fresh); draw();
    let done = 0;
    status.textContent = t('scanReading', { n: localDigits('0'), total: localDigits(String(fresh.length)) });
    await pooled(fresh, parallel(), async (p) => {
      try {
        const r = await scanWork<Prepared>({ op: 'prepare', blob: p.file, maxSide: PREVIEW, autoCrop: set.autoCrop, autoTurn: set.autoTurn, flatten: set.flatten, split: set.split, filter: set.filter, rtl: getLang() === 'ar' });
        const at = pages.indexOf(p); if (at < 0) return; // (Removed while its photo was being read.)
        Object.assign(p, r.looks[0]); p.preview = r.preview; hold(p); p.thumb = URL.createObjectURL(r.thumbs[0]); p.pending = false;
        // A book open on two pages became two pages: the second one goes right after the first.
        for (let k = 1; k < r.looks.length; k++) {
          const q: Page = { ...r.looks[k], file: p.file, preview: null, thumb: URL.createObjectURL(r.thumbs[k]), pending: false, key: ++keySeq };
          pages.splice(at + k, 0, q);
        }
        if (r.looks.length > 1) draw();
      } catch (e) {
        console.error(e);
        const i = pages.indexOf(p); if (i >= 0) pages.splice(i, 1);
        toast(t(String((e as Error).message) === 'undecodable' ? 'scanUndecodable' : 'scanUnreadable', { name: (p.file as File).name ?? '' }), 'error', 5000);
      }
      status.textContent = t('scanReading', { n: localDigits(String(++done)), total: localDigits(String(fresh.length)) });
      paintTile(p);
    });
    status.textContent = '';
    draw();
  };

  // Tiles are kept and only refreshed: moving or editing one page does not rebuild the others.
  const tiles = new Map<Page, HTMLElement>();
  const moveTo = (a: number, b: number) => { if (a === b) return; pages.splice(b, 0, pages.splice(a, 1)[0]); draw(); };
  const tileFor = (p: Page) => {
    let tile = tiles.get(p);
    if (!tile) {
      tile = h('div', { class: 'page-tile', role: 'button', tabindex: 0,
        onclick: (e: Event) => { if ((e.target as HTMLElement).closest('button, input') || p.pending) return; void openEditor(pages.indexOf(p)); },
        onkeydown: (e: KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && !(e.target as HTMLElement).closest('input')) { e.preventDefault(); if (!p.pending) void openEditor(pages.indexOf(p)); } } });
      tiles.set(p, tile);
    }
    return tile;
  };
  let stale = () => { /* set once the runner is made */ };
  const paintTile = (p: Page) => {
    stale();
    const tile = tileFor(p); const k = pages.indexOf(p); if (k < 0) return;
    tile.dataset.k = String(k);
    tile.setAttribute('aria-label', t('scanEditPage', { n: localDigits(String(k + 1)) }));
    tile.classList.toggle('pending', p.pending);
    tile.replaceChildren(
      h('div', { class: 'page-frame' }, p.pending ? h('div', { class: 'spinner small' }) : h('img', { class: 'page-thumb', alt: '', src: p.thumb, draggable: false })),
      h('div', { class: 'page-meta' },
        placeNumber(k, pages.length, moveTo),
        h('button', { type: 'button', class: 'icon-btn small', title: t('rotatePage'), 'aria-label': t('rotatePage'), disabled: p.pending, onclick: async () => { p.turn = (p.turn + 1) % 4; if (p.flatten) p.curve = await scanWork<S.Curve | null>({ op: 'curve', preview: await previewOf(p), quad: p.quad, turn: p.turn }); await makeThumb(p); paintTile(p); } }, icon('rotate')),
        h('button', { type: 'button', class: 'icon-btn small', title: t('removeItem'), 'aria-label': t('removeItem'), onclick: () => { if (p.thumb) URL.revokeObjectURL(p.thumb); tiles.delete(p); pages.splice(pages.indexOf(p), 1); draw(); } }, icon('trash'))));
  };
  const draw = () => {
    stale();
    if (!pages.length) gridEl.replaceChildren(h('div', { class: 'scan-empty' }, icon('camera'), h('p', null, t('scanEmpty'))));
    else { const want = pages.map(tileFor); if (gridEl.children.length !== want.length || want.some((el, i) => gridEl.children[i] !== el)) gridEl.replaceChildren(...want); pages.forEach(paintTile); }
    go.disabled = asImages.disabled = r.running || !pages.length || pages.some((p) => p.pending);
    count.textContent = pages.length ? countPages(pages.length) : '';
  };
  const offSort = sortable(gridEl, '.page-tile', moveTo, sh.body);
  // Closed: the photos (megabytes each), the thumbs' URLs and the document's listeners are let go.
  onSheetClosed(sh.el, () => { offSort(); for (const p of pages) { if (p.thumb) URL.revokeObjectURL(p.thumb); p.preview = null; } held.length = 0; pages.length = 0; tiles.clear(); });

  // The camera: the scanner's own (the page outlined as it is found, taken by itself when held steady), each
  // photo read as it is taken; where that cannot be had, the system's camera — a file input asking for the back
  // camera (phones open it; elsewhere it is a picker).
  const shoot = async () => {
    const { openCamera } = await import('./camera');
    if (await openCamera((f) => void add([f]))) return;
    systemCamera();
  };
  const systemCamera = () => {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' } }) as HTMLInputElement;
    input.addEventListener('change', () => { const fs = [...(input.files ?? [])]; input.remove(); void add(fs); });
    input.addEventListener('cancel', () => input.remove());
    document.body.append(input); input.click();
  };
  const count = h('span', { class: 'src' });
  sh.body.append(
    h('div', { class: 'tool-bar' },
      h('button', { class: 'btn small primary', type: 'button', onclick: () => void shoot() }, icon('camera'), t('scanTakePhoto')),
      h('button', { class: 'btn small tonal', type: 'button', onclick: async () => add(await pickFiles('image/*', true)) }, icon('images'), t('scanPickPhotos')),
      h('button', { class: 'icon-btn', type: 'button', title: t('scanSettings'), 'aria-label': t('scanSettings'), onclick: () => settingsSheet(set, (s) => { set = s; stale(); }) }, icon('settings')),
      count),
    status, gridEl, h('p', { class: 'hint' }, t('scanHint')));
  const r = runner(sh.body, onDone);
  stale = () => r.stale();
  // The pages made at full size (two at a time: a page at full size takes some memory, and a phone has little).
  // Progress in steps: each page made, each page read (when the text is recognised), the file put together.
  let steps = 1, stepsDone = 0;
  const step = () => r.progress((++stepsDone / steps) * 100);
  const makePages = async (): Promise<{ blobs: Blob[]; types: string[] }> => {
    const side = SIDE[set.quality];
    const out: Blob[] = new Array(pages.length); const types: string[] = new Array(pages.length);
    await pooled(pages.slice(), Math.min(2, parallel()), async (p, i) => {
      types[i] = p.filter === 'bw' ? 'image/png' : 'image/jpeg';
      out[i] = await scanWork<Blob>({ op: 'render', blob: p.file, look: lookOf(p), side, type: types[i], quality: 0.86 });
      step();
    });
    return { blobs: out, types };
  };
  const stamp = () => { const d = new Date(); const pad = (n: number) => String(n).padStart(2, '0'); return `${t('scanFileName')} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`; };
  const go = h('button', { class: 'btn small primary', type: 'button', onclick: () => void r.run([go, asImages], async () => {
    steps = pages.length + 1; stepsDone = 0;
    const { blobs } = await makePages();
    const { imagesToPdf } = await import('../pdftools');
    const bytes = await imagesToPdf(blobs, { size: set.size, margin: 0 });
    return { blob: pdfBlob(bytes), name: `${stamp()}.pdf` };
  }) }, icon('file'), t('createPdf')) as HTMLButtonElement;
  // Or the pages as pictures: one page, one picture; several, a ZIP of them in order.
  const asImages = h('button', { class: 'btn small tonal', type: 'button', onclick: () => void r.run([go, asImages], async () => {
    steps = pages.length + 1; stepsDone = 0;
    const { blobs, types } = await makePages();
    const ext = (k: number) => (types[k] === 'image/png' ? 'png' : 'jpg');
    if (blobs.length === 1) return { blob: blobs[0], name: `${stamp()}.${ext(0)}` };
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip(); const digits = String(blobs.length).length;
    blobs.forEach((b, k) => zip.file(`${String(k + 1).padStart(digits, '0')}.${ext(k)}`, b));
    return { blob: await zip.generateAsync({ type: 'blob', compression: 'STORE' }), name: `${stamp()}.zip` };
  }) }, icon('images'), t('scanSaveImages')) as HTMLButtonElement;
  sh.actions.append(asImages, go);
  draw();

  /* ---------- one page, by hand ---------- */

  async function openEditor(k: number): Promise<void> {
    const p = pages[k]; if (!p) return;
    try { await previewOf(p); } catch { toast(t('scanUndecodable', { name: (p.file as File).name ?? '' }), 'error'); return; }
    editor(k);
  }

  function editor(k: number): void {
    const p = pages[k];
    const work: Look = { quad: p.quad.map((c) => ({ ...c })) as S.Quad, curve: p.curve, flatten: p.flatten, turn: p.turn, filter: p.filter, adj: { ...p.adj } };
    // (Corners moved: how the page bends is looked for again, once they are let go.)
    // The bend is found anew after the corners settle (and 'Done' waits for it, so the page keeps the bend of
    // the corners it has, not of the corners before the last drag); nothing runs once the editor is closed.
    let closed = false, curveDue = false, curveJob: Promise<void> | null = null;
    const findCurve = () => { curveDue = false; curveJob = scanWork<S.Curve | null>({ op: 'curve', preview, quad: S.orderQuad(work.quad.map((c) => ({ ...c }))), turn: work.turn }).then((c) => { if (closed) return; work.curve = c; syncFlat(); refresh(); }); };
    const recurveSoon = debounce(() => { if (!closed && curveDue) findCurve(); }, 250);
    const recurve = () => { curveDue = true; recurveSoon(); };
    const ed = openSheet(t('scanEditPage', { n: localDigits(String(k + 1)) }), t('close'), { stack: true });
    onSheetClosed(ed.el, () => { closed = true; });
    ed.body.style.fontFamily = 'var(--font-ui)';
    ed.el.classList.add('scan-editor');
    const preview = p.preview!;
    let mode: 'crop' | 'result' = 'crop';
    // Crop view: the photo, the page's outline and its four corners to drag.
    const photo = toCanvas(preview); photo.className = 'scan-photo';
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'scan-overlay'); svg.setAttribute('viewBox', `0 0 ${preview.width} ${preview.height}`); svg.setAttribute('preserveAspectRatio', 'none');
    const shade = document.createElementNS(NS, 'path'); shade.setAttribute('class', 'scan-shade'); shade.setAttribute('fill-rule', 'evenodd');
    const poly = document.createElementNS(NS, 'polygon'); poly.setAttribute('class', 'scan-outline');
    svg.append(shade, poly);
    const loupe = h('canvas', { class: 'scan-loupe', width: 120, height: 120, hidden: true }) as HTMLCanvasElement;
    const handles = [0, 1, 2, 3].map((i) => h('button', { type: 'button', class: 'scan-handle', 'aria-label': t('scanCorner', { n: localDigits(String(i + 1)) }) }));
    const stage = h('div', { class: 'scan-stage' }, photo, svg, ...handles, loupe);
    const result = h('canvas', { class: 'scan-result', hidden: true }) as HTMLCanvasElement;
    const place = () => {
      const q = work.quad, W = preview.width, H = preview.height;
      const pts = q.map((c) => `${c.x * W},${c.y * H}`).join(' ');
      poly.setAttribute('points', pts);
      shade.setAttribute('d', `M0 0H${W}V${H}H0Z M${q.map((c) => `${c.x * W} ${c.y * H}`).join(' L')}Z`);
      handles.forEach((hd, i) => { hd.style.left = `${q[i].x * 100}%`; hd.style.top = `${q[i].y * 100}%`; });
    };
    const showLoupe = (i: number) => {
      const c = work.quad[i]; const g = loupe.getContext('2d')!; const z = 3, s = 120 / z;
      g.fillStyle = '#000'; g.fillRect(0, 0, 120, 120);
      g.drawImage(photo, c.x * preview.width - s / 2, c.y * preview.height - s / 2, s, s, 0, 0, 120, 120);
      g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(60, 48); g.lineTo(60, 72); g.moveTo(48, 60); g.lineTo(72, 60); g.stroke();
      loupe.hidden = false;
      // (Above the finger, on the other side when the corner is near the top.)
      loupe.style.left = `${c.x * 100}%`; loupe.style.top = `${c.y * 100}%`;
      loupe.classList.toggle('below', c.y < 0.25);
    };
    handles.forEach((hd, i) => {
      let drag = false;
      hd.addEventListener('pointerdown', (e) => { drag = true; hd.setPointerCapture(e.pointerId); e.preventDefault(); showLoupe(i); });
      hd.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const b = photo.getBoundingClientRect();
        work.quad[i] = { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
        place(); showLoupe(i);
      });
      const end = () => { if (drag) recurve(); drag = false; loupe.hidden = true; };
      hd.addEventListener('pointerup', end); hd.addEventListener('pointercancel', end);
      // Arrow keys move a focused corner a little.
      hd.addEventListener('keydown', (e) => {
        const d = e.shiftKey ? 0.02 : 0.004; const c = work.quad[i];
        const m: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
        if (!m[e.key]) return; e.preventDefault();
        work.quad[i] = { x: Math.min(1, Math.max(0, c.x + m[e.key][0])), y: Math.min(1, Math.max(0, c.y + m[e.key][1])) }; place(); recurve();
      });
    });
    // (The latest change wins: a picture still being made for an earlier one is not shown.)
    let viewSeq = 0;
    const refresh = debounce(() => { if (mode !== 'result' || closed) return; const my = ++viewSeq; void scanWork<S.Img>({ op: 'view', preview, look: lookOf(work), side: 1100 }).then((img) => { if (my === viewSeq) toCanvas(img, result); }); }, 120);
    const setMode = (m: typeof mode) => {
      mode = m; stage.hidden = m !== 'crop'; result.hidden = m !== 'result';
      cropChip.classList.toggle('on', m === 'crop'); resultChip.classList.toggle('on', m === 'result');
      cropChip.setAttribute('aria-pressed', String(m === 'crop')); resultChip.setAttribute('aria-pressed', String(m === 'result'));
      refresh();
    };
    const cropChip = h('button', { type: 'button', class: 'chip small on', 'aria-pressed': 'true', onclick: () => setMode('crop') }, h('span', null, t('scanCrop')));
    const resultChip = h('button', { type: 'button', class: 'chip small', 'aria-pressed': 'false', onclick: () => setMode('result') }, h('span', null, t('scanResult')));
    const tools = h('div', { class: 'tool-bar' },
      cropChip, resultChip,
      h('button', { type: 'button', class: 'btn small tonal', onclick: async () => { const f = await scanWork<{ how: string; quad: S.Quad }>({ op: 'detect', preview }); work.quad = f.quad; place(); recurve(); toast(f.how === 'frame' ? t('scanNoEdges') : t('scanFound')); } }, icon('target'), t('scanAuto')),
      h('button', { type: 'button', class: 'btn small tonal', onclick: () => { work.quad = FULL.map((c) => ({ ...c })) as S.Quad; place(); recurve(); } }, icon('fullscreen'), t('scanWhole')),
      h('button', { type: 'button', class: 'icon-btn', title: t('rotateLeft'), 'aria-label': t('rotateLeft'), onclick: () => { work.turn = (work.turn + 3) % 4; recurve(); if (mode === 'crop') setMode('result'); else refresh(); } }, h('span', { class: 'flip-x' }, icon('rotate'))),
      h('button', { type: 'button', class: 'icon-btn', title: t('rotateRight'), 'aria-label': t('rotateRight'), onclick: () => { work.turn = (work.turn + 1) % 4; recurve(); if (mode === 'crop') setMode('result'); else refresh(); } }, icon('rotate')));
    const flatChip = h('button', { type: 'button', class: 'chip small', 'aria-pressed': 'false', title: t('scanFlattenSub'), onclick: () => { work.flatten = !work.flatten; syncFlat(); if (mode === 'crop') setMode('result'); else refresh(); } }, h('span', null, t('scanFlatten')));
    function syncFlat() { const on = work.flatten && !!work.curve; flatChip.classList.toggle('on', on); flatChip.setAttribute('aria-pressed', String(on)); flatChip.disabled = !work.curve; }
    tools.append(flatChip); syncFlat();
    const FILTERS: [S.Filter, string][] = [['auto', t('scanFilterAuto')], ['color', t('scanFilterColor')], ['gray', t('scanFilterGray')], ['bw', t('scanFilterBw')], ['original', t('scanFilterOriginal')]];
    const chips = h('div', { class: 'scan-filters', role: 'radiogroup', 'aria-label': t('scanFilter') });
    const drawChips = () => chips.replaceChildren(...FILTERS.map(([f, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(work.filter === f), class: 'chip small' + (work.filter === f ? ' on' : ''), onclick: () => { work.filter = f; drawChips(); if (mode === 'crop') setMode('result'); else refresh(); } }, h('span', null, label))));
    drawChips();
    const slider = (label: string, key: keyof S.Adjust, min: number, max: number) => {
      const input = h('input', { type: 'range', min: String(min), max: String(max), step: '0.02', value: String(work.adj[key] ?? 0) }) as HTMLInputElement;
      input.addEventListener('input', () => { work.adj[key] = +input.value; if (mode === 'crop') setMode('result'); else refresh(); });
      return h('label', { class: 'scan-slider' }, h('span', null, label), input);
    };
    ed.body.append(tools, h('div', { class: 'scan-view' }, stage, result), chips,
      h('div', { class: 'scan-sliders' }, slider(t('brightness'), 'brightness', -0.4, 0.4), slider(t('contrast'), 'contrast', -0.4, 0.6)));
    const apply = async (all: boolean) => {
      if (curveDue) findCurve();
      await curveJob;
      closed = true;
      Object.assign(p, { quad: S.orderQuad(work.quad.map((c) => ({ ...c }))), curve: work.curve, flatten: work.flatten, turn: work.turn, filter: work.filter, adj: { ...work.adj } });
      ed.close();
      // (Its place: moved when another number was typed.)
      const to = Math.max(1, Math.min(pages.length, parseInt(pos.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))), 10) || k + 1)) - 1;
      if (to !== pages.indexOf(p)) moveTo(pages.indexOf(p), to);
      await makeThumb(p); paintTile(p);
      if (all) await pooled(pages.filter((o) => o !== p && !o.pending), parallel(), async (o) => { o.filter = work.filter; o.adj = { ...work.adj }; await makeThumb(o); paintTile(o); });
    };
    const pos = h('input', { type: 'text', inputmode: 'numeric', class: 'tool-range scan-pos', dir: 'ltr', value: String(k + 1), 'aria-label': t('moveToPlace') }) as HTMLInputElement;
    ed.actions.append(h('label', { class: 'scan-pos-field' }, h('span', null, t('placeOf', { n: localDigits(String(pages.length)) })), pos));
    ed.actions.append(
      h('button', { class: 'btn small tonal', type: 'button', onclick: () => void apply(true) }, t('scanApplyAll')),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => void apply(false) }, icon('check'), t('done')));
    place();
  }
}

/* ---------- settings ---------- */

function settingsSheet(cur: Settings, onChange: (s: Settings) => void): void {
  const sh = openSheet(t('scanSettings'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const s = { ...cur };
  const commit = () => { saveSettings(s); onChange({ ...s }); };
  const check = (label: string, key: 'autoCrop' | 'autoTurn' | 'flatten' | 'split', sub: string) => {
    const input = h('input', { type: 'checkbox', checked: s[key] }) as HTMLInputElement;
    input.addEventListener('change', () => { s[key] = input.checked; commit(); });
    return h('label', { class: 'scan-check' }, input, h('span', null, h('b', null, label), h('small', null, sub)));
  };
  sh.body.append(h('div', { class: 'tool-opts scan-opts' },
    h('label', null, h('span', null, t('pageSize')), pickButton(t('pageSize'), [['page', t('scanSizePage')], ['a4', t('sizeA4')], ['letter', t('sizeLetter')]], s.size, (v) => { s.size = v; commit(); }, t('close'))),
    h('label', null, h('span', null, t('scanFilter')), pickButton(t('scanFilter'), [['auto', t('scanFilterAuto')], ['color', t('scanFilterColor')], ['gray', t('scanFilterGray')], ['bw', t('scanFilterBw')], ['original', t('scanFilterOriginal')]], s.filter, (v) => { s.filter = v; commit(); }, t('close'))),
    h('label', null, h('span', null, t('scanQuality')), pickButton(t('scanQuality'), [['standard', t('scanQualityStandard')], ['high', t('scanQualityHigh')], ['max', t('scanQualityMax')]], s.quality, (v) => { s.quality = v; commit(); }, t('close')))),
    check(t('scanAutoCrop'), 'autoCrop', t('scanAutoCropSub')),
    check(t('scanFlatten'), 'flatten', t('scanFlattenSub')),
    check(t('scanAutoTurn'), 'autoTurn', t('scanAutoTurnSub')),
    check(t('scanSplit'), 'split', t('scanSplitSub')));
  sh.actions.append(h('button', { class: 'btn small primary', type: 'button', onclick: sh.close }, t('done')));
}

