// The document scanner: photos of pages (taken here or picked) found in the picture, straightened, cleaned
// and put in order, then saved as one PDF. Every page can be adjusted by hand — its four corners, its turn,
// its look — and the defaults are the reader's settings. The picture work is in ../scan.ts.
import { h, icon, openSheet, toast, pickButton, debounce } from './dom';
import { t, localDigits, getLang } from '../i18n';
import * as S from '../scan';
import { runner, pickFiles, pdfBlob, draggable } from './pdftools';

type Quality = 'standard' | 'high' | 'max';
type Settings = { size: 'page' | 'a4' | 'letter'; filter: S.Filter; quality: Quality; autoCrop: boolean; autoTurn: boolean; flatten: boolean };
const DEFAULTS: Settings = { size: 'page', filter: 'auto', quality: 'high', autoCrop: true, autoTurn: true, flatten: true };
const KEY = 'kr.scan';
const SIDE: Record<Quality, number> = { standard: 1700, high: 2400, max: 3300 };
const PREVIEW = 1200;

export function scanSettings(): Settings {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) }; } catch { return { ...DEFAULTS }; }
}
function saveSettings(s: Settings): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }

/** One scanned page: the photo, where the page is in it (corners as fractions of the photo), how the page
 *  bends (a book's), and how it is to come out. */
type Page = { file: Blob; preview: S.Img; quad: S.Quad; curve: S.Curve | null; flatten: boolean; turn: number; filter: S.Filter; adj: S.Adjust; thumb: string };
type Look = Pick<Page, 'quad' | 'curve' | 'flatten' | 'turn' | 'filter' | 'adj'>;

/* ---------- pictures ---------- */

async function decode(blob: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; done: () => void }> {
  try {
    const b = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    return { src: b, w: b.width, h: b.height, done: () => b.close() };
  } catch {
    const url = URL.createObjectURL(blob); const im = new Image(); im.src = url;
    await im.decode();
    return { src: im, w: im.naturalWidth, h: im.naturalHeight, done: () => URL.revokeObjectURL(url) };
  }
}

/** A photo's pixels, at most `maxSide` on its longer side (turned the way the camera held it). */
async function loadImg(blob: Blob, maxSide: number): Promise<S.Img> {
  const d = await decode(blob);
  const k = Math.min(1, maxSide / Math.max(d.w, d.h));
  const w = Math.max(1, Math.round(d.w * k)), hh = Math.max(1, Math.round(d.h * k));
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const g = c.getContext('2d', { willReadFrequently: true })!; g.imageSmoothingQuality = 'high'; g.drawImage(d.src, 0, 0, w, hh); d.done();
  const data = g.getImageData(0, 0, w, hh).data; c.width = c.height = 0;
  return { data, width: w, height: hh };
}

function toCanvas(img: S.Img, c = document.createElement('canvas')): HTMLCanvasElement {
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(img.data as unknown as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return c;
}
const toBlob = (img: S.Img, type: string, q?: number) => new Promise<Blob>((res, rej) => { const c = toCanvas(img); c.toBlob((b) => { c.width = c.height = 0; if (b) res(b); else rej(new Error('encode')); }, type, q); });

const scaleQuad = (q: S.Quad, w: number, hh: number): S.Quad => q.map((p) => ({ x: p.x * w, y: p.y * hh })) as S.Quad;
const FULL: S.Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

/** The page as it comes out of a picture of the photo: flattened, cleaned, turned upright. */
function render(src: S.Img, p: Look, maxSide: number): S.Img {
  const q = S.orderQuad(scaleQuad(p.quad, src.width, src.height));
  let flat = S.warp(src, q, S.flatSize(q, maxSide));
  // A book's page: its lines straightened, the book's edge and the next page cut away.
  if (p.flatten && p.curve) flat = S.trimMargins(S.unwarp(flat, p.curve));
  return S.rotate(S.applyFilter(flat, p.filter, p.adj), p.turn);
}

/** How the page within these corners bends (looked for in the photo's preview). */
function curveOf(preview: S.Img, quad: S.Quad): S.Curve | null {
  const q = S.orderQuad(scaleQuad(quad, preview.width, preview.height));
  try { return S.findCurve(S.warp(preview, q, S.flatSize(q, 1100))); } catch { return null; }
}

/** Find the page in a new photo and decide which way up it goes. */
function autoPlace(p: Page, set: Settings): void {
  const { preview } = p;
  if (set.autoCrop) { const f = S.detectPage(preview); p.quad = f.quad.map((c) => ({ x: c.x / preview.width, y: c.y / preview.height })) as S.Quad; }
  p.curve = curveOf(preview, p.quad); p.flatten = set.flatten;
  if (set.autoTurn) {
    const flat = render(preview, { ...p, turn: 0, filter: 'gray', adj: {} }, 700);
    p.turn = S.uprightTurn(flat, getLang() === 'ar');
  }
}

async function makeThumb(p: Page): Promise<void> {
  const img = render(p.preview, p, 420);
  const b = await toBlob(img, 'image/jpeg', 0.8);
  if (p.thumb) URL.revokeObjectURL(p.thumb);
  p.thumb = URL.createObjectURL(b);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

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

  const add = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i.test(f.name));
    let k = 0;
    for (const f of pics) {
      status.textContent = t('scanReading', { n: localDigits(String(++k)), total: localDigits(String(pics.length)) });
      await tick();
      try {
        const preview = await loadImg(f, PREVIEW);
        const p: Page = { file: f, preview, quad: FULL, curve: null, flatten: set.flatten, turn: 0, filter: set.filter, adj: {}, thumb: '' };
        autoPlace(p, set); await makeThumb(p);
        pages.push(p); draw();
      } catch (e) { console.error(e); toast(t('scanUnreadable', { name: f.name }), 'error'); }
    }
    status.textContent = '';
  };

  const draw = () => {
    gridEl.replaceChildren();
    if (!pages.length) gridEl.append(h('div', { class: 'scan-empty' }, icon('camera'), h('p', null, t('scanEmpty'))));
    pages.forEach((p, k) => {
      const move = (a: number, b: number) => { pages.splice(b, 0, pages.splice(a, 1)[0]); draw(); };
      const tile = h('div', { class: 'page-tile', role: 'button', tabindex: 0, 'aria-label': t('scanEditPage', { n: localDigits(String(k + 1)) }),
        onclick: (e: Event) => { if ((e.target as HTMLElement).closest('button')) return; editor(k); },
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editor(k); } } },
        h('div', { class: 'page-frame' }, h('img', { class: 'page-thumb', alt: '', src: p.thumb })),
        h('div', { class: 'page-meta' },
          h('button', { type: 'button', class: 'icon-btn small', title: t('moveEarlier'), 'aria-label': t('moveEarlier'), disabled: k === 0, onclick: () => move(k, k - 1) }, icon(rtlUi ? 'chevronRight' : 'chevronLeft')),
          h('b', null, localDigits(String(k + 1))),
          h('button', { type: 'button', class: 'icon-btn small', title: t('rotatePage'), 'aria-label': t('rotatePage'), onclick: async () => { p.turn = (p.turn + 1) % 4; await makeThumb(p); draw(); } }, icon('rotate')),
          h('button', { type: 'button', class: 'icon-btn small', title: t('removeItem'), 'aria-label': t('removeItem'), onclick: () => { URL.revokeObjectURL(p.thumb); pages.splice(k, 1); draw(); } }, icon('trash')),
          h('button', { type: 'button', class: 'icon-btn small', title: t('moveLater'), 'aria-label': t('moveLater'), disabled: k === pages.length - 1, onclick: () => move(k, k + 1) }, icon(rtlUi ? 'chevronLeft' : 'chevronRight'))));
      draggable(tile, k, move);
      gridEl.append(tile);
    });
    go.disabled = !pages.length;
    count.textContent = pages.length ? t('pageCount', { n: pages.length }) : '';
  };

  // The camera: an ordinary file input asking for the back camera (phones open it; elsewhere it is a picker).
  const shoot = () => {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' } }) as HTMLInputElement;
    input.addEventListener('change', () => { const fs = [...(input.files ?? [])]; input.remove(); void add(fs); });
    document.body.append(input); input.click();
  };
  const count = h('span', { class: 'src' });
  sh.body.append(
    h('div', { class: 'tool-bar' },
      h('button', { class: 'btn small primary', type: 'button', onclick: shoot }, icon('camera'), t('scanTakePhoto')),
      h('button', { class: 'btn small tonal', type: 'button', onclick: async () => add(await pickFiles('image/*', true)) }, icon('images'), t('scanPickPhotos')),
      h('button', { class: 'icon-btn', type: 'button', title: t('scanSettings'), 'aria-label': t('scanSettings'), onclick: () => settingsSheet(set, (s) => { set = s; }) }, icon('settings')),
      count),
    status, gridEl, h('p', { class: 'hint' }, t('scanHint')));
  const r = runner(sh.body, onDone);
  const go = h('button', { class: 'btn small primary', type: 'button', onclick: () => void r.run([go], async () => {
    const side = SIDE[set.quality];
    const out: Blob[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      await tick();
      const src = await loadImg(p.file, Math.round(side * 1.25));
      const img = render(src, p, side);
      // (Black and white keeps its edges sharp as PNG; photographs are JPEG.)
      out.push(await toBlob(img, p.filter === 'bw' ? 'image/png' : 'image/jpeg', 0.86));
      r.progress(((i + 1) / (pages.length + 1)) * 100);
    }
    const { imagesToPdf } = await import('../pdftools');
    const bytes = await imagesToPdf(out, { size: set.size, margin: 0 });
    const d = new Date(); const pad = (n: number) => String(n).padStart(2, '0');
    return { blob: pdfBlob(bytes), name: `${t('scanFileName')} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.pdf` };
  }) }, icon('file'), t('createPdf')) as HTMLButtonElement;
  sh.actions.append(go);
  draw();

  /* ---------- one page, by hand ---------- */

  function editor(k: number): void {
    const p = pages[k];
    const work: Look = { quad: p.quad.map((c) => ({ ...c })) as S.Quad, curve: p.curve, flatten: p.flatten, turn: p.turn, filter: p.filter, adj: { ...p.adj } };
    // (Corners moved: how the page bends is looked for again, once they are let go.)
    const recurve = debounce(() => { work.curve = curveOf(preview, S.orderQuad(work.quad.map((c) => ({ ...c })))); syncFlat(); refresh(); }, 250);
    const ed = openSheet(t('scanEditPage', { n: localDigits(String(k + 1)) }), t('close'), { stack: true });
    ed.body.style.fontFamily = 'var(--font-ui)';
    ed.el.classList.add('scan-editor');
    const { preview } = p;
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
    const refresh = debounce(() => { if (mode === 'result') toCanvas(render(preview, work, 1100), result); }, 120);
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
      h('button', { type: 'button', class: 'btn small tonal', onclick: () => { const f = S.detectPage(preview); work.quad = f.quad.map((c) => ({ x: c.x / preview.width, y: c.y / preview.height })) as S.Quad; place(); recurve(); toast(f.how === 'frame' ? t('scanNoEdges') : t('scanFound')); } }, icon('target'), t('scanAuto')),
      h('button', { type: 'button', class: 'btn small tonal', onclick: () => { work.quad = FULL.map((c) => ({ ...c })) as S.Quad; place(); recurve(); } }, icon('fullscreen'), t('scanWhole')),
      h('button', { type: 'button', class: 'icon-btn', title: t('rotateLeft'), 'aria-label': t('rotateLeft'), onclick: () => { work.turn = (work.turn + 3) % 4; if (mode === 'crop') setMode('result'); else refresh(); } }, h('span', { class: 'flip-x' }, icon('rotate'))),
      h('button', { type: 'button', class: 'icon-btn', title: t('rotateRight'), 'aria-label': t('rotateRight'), onclick: () => { work.turn = (work.turn + 1) % 4; if (mode === 'crop') setMode('result'); else refresh(); } }, icon('rotate')));
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
      Object.assign(p, { quad: S.orderQuad(work.quad.map((c) => ({ ...c }))), curve: work.curve, flatten: work.flatten, turn: work.turn, filter: work.filter, adj: { ...work.adj } });
      if (all) for (const o of pages) if (o !== p) { o.filter = work.filter; o.adj = { ...work.adj }; await makeThumb(o); }
      await makeThumb(p); ed.close(); draw();
    };
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
  const check = (label: string, key: 'autoCrop' | 'autoTurn' | 'flatten', sub: string) => {
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
    check(t('scanAutoTurn'), 'autoTurn', t('scanAutoTurnSub')));
  sh.actions.append(h('button', { class: 'btn small primary', type: 'button', onclick: sh.close }, t('done')));
}
