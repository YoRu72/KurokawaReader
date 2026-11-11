// «Text as image» on a PDF. Two ways, the reader picks (and the pick is kept):
//  - as on the page: the lines picked cut out of the real page — its own letters and harakat, colours, ornaments and
//    layout — drawn afresh from the file at a sharp size (not the screen's picture, which may be small or in tiles);
//  - as a card: the words set again (textcard), read in reading order from the text layer as running text.
// Also the tool that cuts any part of a page by hand, for a page with no text to select (a scan without OCR).
import { PdfViewer } from '../formats/pdf';
import { getSettings, updateSettings } from '../settings';
import { t } from '../i18n';
import { h, icon, toast } from './dom';
import { renderTextCanvas, showSnapshot, type SnapKind } from './textcard';
import { pdfRangeText } from './selection';

/** At most this many pixels in all the parts drawn for one picture, and in the picture itself: a page or two picked on a
 *  phone cannot run it out of memory (with the parts and the picture both held for a moment, about 50 MB at most). */
export const SNAP_PIXELS = 6_000_000;
const WIDE = 1800;   // the widest part, in pixels: sharp enough to share …
const MOST = 6;      // … but never more than 6 pixels to a point (432 dpi): a single word is not blown up to that width
/** The reader's dark pages, as reader.css draws them (for «As shown»). */
const INVERT = 'invert(.9) hue-rotate(180deg) brightness(1.05)';

type Box = { l: number; t: number; r: number; b: number };
/** What a selection is on one page, in points of the page: the boxes of the words picked, and of all the page's words. */
interface Read { n: number; pw: number; ph: number; sel: Box[]; all: Box[]; odd: boolean }
/** One page's part of the picture, in points: the area drawn (with room above and below to look into), the block of
 *  lines inside it, whether a neighbouring line lies at the area's top or bottom edge, and the words picked per line. */
interface Part { n: number; pw: number; ph: number; area: Box; lh: number; core?: { t: number; b: number; above: boolean; below: boolean }; lines?: Box[] }

const mid = (b: Box) => (b.t + b.b) / 2;
const median = (xs: number[], d: number) => { const s = xs.filter((x) => x > 0).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : d; };

/** The words picked, page by page (in page order), as boxes in the page's points — read through each page's sheet
 *  (the whole page, whatever the margin crop and the zoom show of it). */
function readSelection(range: Range, viewer: PdfViewer): Read[] {
  const anc = range.commonAncestorContainer;
  const el = anc.nodeType === 1 ? (anc as Element) : anc.parentElement;
  const scope = el?.closest('.pdf-inner') ?? el?.closest('.pdf-page') ?? el;
  if (!scope) return [];
  const pages = new Map<number, Read & { sr: DOMRect }>();
  const toPage = (c: DOMRect | DOMRectReadOnly, pg: { sr: DOMRect; pw: number; ph: number }): Box => ({ l: ((c.left - pg.sr.left) / pg.sr.width) * pg.pw, r: ((c.right - pg.sr.left) / pg.sr.width) * pg.pw, t: ((c.top - pg.sr.top) / pg.sr.height) * pg.ph, b: ((c.bottom - pg.sr.top) / pg.sr.height) * pg.ph });
  const spans = scope.classList.contains('textLayer') ? Array.from(scope.querySelectorAll<HTMLElement>(':scope > span')) : Array.from(scope.querySelectorAll<HTMLElement>('.textLayer > span'));
  for (const sp of spans) {
    const node = sp.firstChild; if (!node || !range.intersectsNode(sp)) continue;
    const win = sp.closest<HTMLElement>('.pdf-page'); const sheet = PdfViewer.sheetOf(sp); if (!win || !sheet) continue;
    const n = Number(win.dataset.page);
    let pg = pages.get(n);
    if (!pg) {
      const size = viewer.pageSize(n); const sr = sheet.getBoundingClientRect();
      const layer = sp.parentElement as HTMLElement;
      const base = { sr, pw: size.width || sr.width, ph: size.height || sr.height };
      // (Vertical writing or a page shown turned: its lines are not rows across the page — cut as the words' box.)
      pg = { n, ...base, sel: [], odd: !!layer.querySelector(':scope > span[data-v]') || Number(layer.dataset.rot ?? 0) !== 0,
        all: Array.from(layer.querySelectorAll<HTMLElement>(':scope > span')).filter((s) => s.textContent?.trim()).map((s) => toPage(s.getBoundingClientRect(), base)) };
      pages.set(n, pg);
    }
    const r = document.createRange(); r.selectNodeContents(node);
    if (node === range.startContainer) r.setStart(node, range.startOffset);
    if (node === range.endContainer) r.setEnd(node, range.endOffset);
    if (!r.toString().trim()) continue;
    for (const c of Array.from(r.getClientRects())) if (c.width > 0.5 && c.height > 0.5) pg.sel.push(toPage(c, pg));
  }
  return [...pages.values()].filter((p) => p.sel.length).sort((a, b) => a.n - b.n);
}

/** Where to cut a page: whole lines, from the selection's first line to its last, across its column of text (or only
 *  across the words picked) — never into the next column; with room above and below for what stands out of the
 *  lines' boxes (harakat, tall letters), up to the neighbouring lines, decided later from the ink (see keepRows). */
function planPart(pg: Read, words: boolean): Part {
  const { sel, all, pw, ph } = pg;
  const lh = median(sel.map((b) => b.b - b.t), 12);
  const clamp = (b: Box): Box => ({ l: Math.max(0, b.l), t: Math.max(0, b.t), r: Math.min(pw, b.r), b: Math.min(ph, b.b) });
  const u = { l: Math.min(...sel.map((b) => b.l)), r: Math.max(...sel.map((b) => b.r)), t: Math.min(...sel.map((b) => b.t)), b: Math.max(...sel.map((b) => b.b)) };
  if (pg.odd) return { n: pg.n, pw, ph, lh, area: clamp({ l: u.l - lh * 0.6, r: u.r + lh * 0.6, t: u.t - lh * 0.6, b: u.b + lh * 0.6 }) };
  // The lines picked: the boxes grouped by their middles (the extent of the words picked on each).
  const lines: Box[] = [];
  for (const r of [...sel].sort((a, b) => mid(a) - mid(b))) { const cur = lines[lines.length - 1]; if (cur && Math.abs(mid(cur) - mid(r)) < Math.max(cur.b - cur.t, r.b - r.t) * 0.6) { cur.l = Math.min(cur.l, r.l); cur.r = Math.max(cur.r, r.r); cur.t = Math.min(cur.t, r.t); cur.b = Math.max(cur.b, r.b); } else lines.push({ ...r }); }
  const onLine = (a: Box, ln: Box) => Math.abs(mid(a) - mid(ln)) < Math.max(a.b - a.t, ln.b - ln.t) * 0.6;
  const band = all.filter((a) => lines.some((ln) => onLine(a, ln)));
  // The column: from the words picked, grown over the words of those lines that follow on with less than a line's
  // height between (a word space, never a gutter between columns).
  let L = u.l, R = u.r;
  for (let grew = true; grew;) { grew = false; for (const a of band) if (a.r >= L - lh && a.l <= R + lh && (a.l < L - 0.01 || a.r > R + 0.01)) { L = Math.min(L, a.l); R = Math.max(R, a.r); grew = true; } }
  // (Room at the sides: half a line, never past half-way to a word outside the column.)
  const outL = Math.max(-Infinity, ...band.filter((a) => a.r <= L).map((a) => a.r)), outR = Math.min(Infinity, ...band.filter((a) => a.l >= R).map((a) => a.l));
  let x0 = Math.max(L - lh * 0.5, (outL + L) / 2), x1 = Math.min(R + lh * 0.5, (R + outR) / 2);
  if (words) { x0 = Math.max(x0, u.l - lh * 0.3); x1 = Math.min(x1, u.r + lh * 0.3); }
  const inCol = (a: Box) => a.r > L && a.l < R;
  const first = lines[0], last = lines[lines.length - 1];
  const top = Math.min(first.t, ...band.filter((a) => inCol(a) && onLine(a, first)).map((a) => a.t));
  const bottom = Math.max(last.b, ...band.filter((a) => inCol(a) && onLine(a, last)).map((a) => a.b));
  // The neighbouring lines in the column: the area reaches to their boxes (at most a line and a half away).
  const above = Math.max(-Infinity, ...all.filter((a) => inCol(a) && mid(a) < top && !band.includes(a)).map((a) => Math.min(a.b, top)));
  const below = Math.min(Infinity, ...all.filter((a) => inCol(a) && mid(a) > bottom && !band.includes(a)).map((a) => Math.max(a.t, bottom)));
  const upTo = Math.max(top - lh * 1.5, above), downTo = Math.min(bottom + lh * 1.5, below);
  const area = clamp({ l: x0, r: x1, t: upTo, b: downTo });
  return { n: pg.n, pw, ph, lh, area, core: { t: top, b: bottom, above: above > -Infinity && above >= top - lh * 1.5, below: below < Infinity && below <= bottom + lh * 1.5 }, lines };
}

/** The paper's colour: the commonest colour round the edges and across the middle of what was drawn. */
function paperOf(ctx: CanvasRenderingContext2D, W: number, H: number): [number, number, number] {
  const counts = new Map<number, [number, number, number, number]>();
  const take = (x: number, y: number, w: number, hh: number) => {
    if (w <= 0 || hh <= 0) return; const d = ctx.getImageData(x, y, w, hh).data;
    for (let i = 0; i < d.length; i += 4 * 3) { const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); const c = counts.get(k); if (c) { c[0] += d[i]; c[1] += d[i + 1]; c[2] += d[i + 2]; c[3]++; } else counts.set(k, [d[i], d[i + 1], d[i + 2], 1]); }
  };
  const s = Math.min(2, W, H);
  take(0, 0, W, s); take(0, H - s, W, s); take(0, 0, s, H); take(W - s, 0, s, H); take(0, H >> 1, W, 1);
  let best: [number, number, number, number] = [255, 255, 255, 1];
  for (const c of counts.values()) if (c[3] > best[3]) best = c;
  return [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3])];
}

/** Which rows of a band beside the lines carry ink (anything well apart from the paper), ordered outwards from the lines. */
function inkRows(ctx: CanvasRenderingContext2D, W: number, y0: number, y1: number, paper: [number, number, number], outwards: 1 | -1): boolean[] {
  const n = Math.max(0, y1 - y0); if (!n) return [];
  const d = ctx.getImageData(0, y0, W, n).data; const rows: boolean[] = [];
  for (let y = 0; y < n; y++) { let ink = false; for (let i = y * W * 4, e = i + W * 4; i < e; i += 4) if (Math.abs(d[i] - paper[0]) + Math.abs(d[i + 1] - paper[1]) + Math.abs(d[i + 2] - paper[2]) > 90) { ink = true; break; } rows.push(ink); }
  return outwards === 1 ? rows : rows.reverse();
}

/** How many rows of a band to keep, counted outwards from the lines. The band's ink comes in runs of rows: a run
 *  touching the lines is theirs (harakat joined to a letter, a tall letter), one touching the neighbour's box at the far
 *  edge is the neighbour's, one in between belongs to whichever it is nearer to. The cut falls half-way between the
 *  last run of ours and the first of the neighbour's, and never more than `pad` past our last ink. A run touching
 *  both (the lines set solid) is cut through the middle. With no neighbour, all the ink is ours. */
export function keepRows(rows: boolean[], neighbour: boolean, pad: number): number {
  const n = rows.length; const runs: [number, number][] = [];
  for (let i = 0; i < n; i++) if (rows[i]) { if (runs.length && runs[runs.length - 1][1] === i - 1) runs[runs.length - 1][1] = i; else runs.push([i, i]); }
  let lastMine = -1, firstTheirs = n;
  for (const [s, e] of runs) {
    if (neighbour && s === 0 && e === n - 1) return n >> 1;
    const mine = !neighbour || s === 0 || (e < n - 1 && s <= n - 1 - e);
    if (!mine) { firstTheirs = s; break; }
    lastMine = e;
  }
  return Math.max(0, Math.min(n, lastMine + 1 + pad, firstTheirs < n ? Math.ceil((lastMine + 1 + firstTheirs) / 2) : n));
}

/** The 1×1 colour `c` as it looks through `filter`. */
function filtered(c: [number, number, number], filter: string): [number, number, number] {
  const a = document.createElement('canvas'); a.width = a.height = 1; const g = a.getContext('2d')!; g.fillStyle = `rgb(${c})`; g.fillRect(0, 0, 1, 1);
  const b = document.createElement('canvas'); b.width = b.height = 1; const g2 = b.getContext('2d', { willReadFrequently: true })!; g2.filter = filter; g2.drawImage(a, 0, 0);
  const d = g2.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]];
}

/** The picture: each page's part drawn afresh from the file, its rows beyond the lines' own ink cut away, the words
 *  not picked masked with the paper (only the words picked), the parts one under the other with a thin gap, on the
 *  page's own paper, with the title and page under them when asked. */
async function drawParts(viewer: PdfViewer, parts: Part[], o: { words: boolean; shown: boolean; caption: ((pages: string) => string) | null }): Promise<HTMLCanvasElement> {
  const wide = Math.max(...parts.map((p) => p.area.r - p.area.l));
  const pts = parts.reduce((s, p) => s + (p.area.r - p.area.l) * (p.area.b - p.area.t), 0);
  // (Pixels to a point: the widest part ~1800 across, at most 6, and all the parts within 85% of the budget — the rest
  // is for the margins and the caption.)
  const k = Math.min(WIDE / wide, MOST, Math.sqrt((SNAP_PIXELS * 0.85) / Math.max(1, pts)));
  const cuts: { c: HTMLCanvasElement; y0: number; y1: number; part: Part; kk: number }[] = [];
  let paper: [number, number, number] = [255, 255, 255];
  try {
    for (const p of parts) {
      const w = p.area.r - p.area.l, hh = p.area.b - p.area.t;
      const c = await viewer.renderRegion(p.n, [p.area.l / p.pw, p.area.t / p.ph, w / p.pw, hh / p.ph], Math.max(1, Math.round(w * k)));
      const kk = c.width / w; const ctx = c.getContext('2d', { willReadFrequently: true })!;
      const pp = paperOf(ctx, c.width, c.height); if (!cuts.length) paper = pp;
      let y0 = 0, y1 = c.height;
      if (p.core) {
        const ct = Math.round((p.core.t - p.area.t) * kk), cb = Math.round((p.core.b - p.area.t) * kk), pad = Math.round(p.lh * 0.25 * kk);
        y0 = ct - keepRows(inkRows(ctx, c.width, 0, ct, pp, -1), p.core.above, pad);
        y1 = cb + keepRows(inkRows(ctx, c.width, cb, c.height, pp, 1), p.core.below, pad);
      }
      if (o.words && p.lines) {
        // (Each line's words picked kept, the rest of its band — to half-way to the lines either side — painted over.)
        ctx.fillStyle = `rgb(${pp})`; const m = p.lh * 0.2;
        p.lines.forEach((ln, i) => {
          const t0 = i ? (p.lines![i - 1].b + ln.t) / 2 : -Infinity, t1 = i < p.lines!.length - 1 ? (ln.b + p.lines![i + 1].t) / 2 : Infinity;
          const yA = Math.max(0, Math.round((t0 - p.area.t) * kk)), yB = Math.min(c.height, Math.round((t1 - p.area.t) * kk));
          const xa = Math.round((ln.l - m - p.area.l) * kk), xb = Math.round((ln.r + m - p.area.l) * kk);
          if (xa > 0) ctx.fillRect(0, yA, xa, yB - yA); if (xb < c.width) ctx.fillRect(xb, yA, c.width - xb, yB - yA);
        });
      }
      cuts.push({ c, y0, y1: Math.max(y0 + 1, y1), part: p, kk });
    }
    const lh = Math.max(...parts.map((p) => p.lh)) * k;
    const m = Math.round(Math.min(48, Math.max(16, lh * 0.8))), gap = m;
    const capPx = Math.round(Math.max(18, Math.min(64, lh * 0.5)));   // (half the lines' height: small beside them, still legible)
    const capH = o.caption ? Math.round(capPx * 2.2) : 0;
    let W = Math.max(...cuts.map((x) => x.c.width)) + m * 2;
    let H = cuts.reduce((s, x) => s + (x.y1 - x.y0), 0) + gap * (cuts.length - 1) + m * 2 + capH;
    // (Never past the budget, whatever the margins and the caption took: the whole drawn smaller.)
    const f = Math.min(1, Math.sqrt(SNAP_PIXELS / (W * H)));
    const out = document.createElement('canvas'); out.width = Math.floor(W * f); out.height = Math.floor(H * f);
    const g = out.getContext('2d')!; g.scale(f, f); W = out.width / f; H = out.height / f;
    const bg = o.shown ? filtered(paper, INVERT) : paper;
    g.fillStyle = `rgb(${bg})`; g.fillRect(0, 0, W, H);
    const light = bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114 > 140;
    const ink = light ? 'rgba(0,0,0,' : 'rgba(255,255,255,';
    let y = m; const placed: unknown[] = [];
    cuts.forEach((x, i) => {
      if (i) { g.fillStyle = `${ink}.14)`; g.fillRect(m, y + gap / 2 - 0.5, W - m * 2, 1); y += gap; }
      const hh = x.y1 - x.y0, xo = Math.round((W - x.c.width) / 2);
      if (o.shown) g.filter = INVERT;
      g.drawImage(x.c, 0, x.y0, x.c.width, hh, xo, y, x.c.width, hh);
      g.filter = 'none';
      const p = x.part;
      placed.push({ n: p.n, box: [p.area.l / p.pw, (p.area.t + x.y0 / x.kk) / p.ph, (p.area.r - p.area.l) / p.pw, hh / x.kk / p.ph], x: xo * f, y: y * f, w: x.c.width * f, h: hh * f });
      y += hh;
    });
    if (o.caption) {
      const ns = [...new Set(parts.map((p) => p.n))]; const label = o.caption(ns.length > 1 ? `${ns[0]}–${ns[ns.length - 1]}` : String(ns[0]));
      g.fillStyle = `${ink}.62)`; g.font = `500 ${capPx}px Inter, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, W / 2, H - m - capH / 2 + capPx * 0.3, W - m * 2);
    }
    // (Where each part came from and where it went: for the tests.)
    out.dataset.cuts = JSON.stringify(placed); out.dataset.paper = paper.join(',');
    return out;
  } finally { for (const x of cuts) x.c.width = x.c.height = 0; }
}

/** The options of a page cut: the width (when it came from a selection), the colours (when the pages are shown dark),
 *  the caption — each change drawn again. */
function pageOptions(redraw: () => void, o: { text: boolean; colours: { v: 'original' | 'shown' } | null }): HTMLElement {
  const seg = <T extends string>(opts: [T, string][], cur: () => T, set: (v: T) => void, cls: string) => {
    const row = h('div', { class: `segmented ${cls}`, role: 'radiogroup' });
    const paint = () => row.replaceChildren(...opts.map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-pressed': String(cur() === v), 'aria-checked': String(cur() === v), 'data-v': v, onclick: () => { if (cur() === v) return; set(v); paint(); redraw(); } }, l)));
    paint(); return row;
  };
  const box = h('div', { class: 'snap-page-options' });
  if (o.text) box.append(seg([['column', t('snapWholeWidth')], ['words', t('snapOnlyWords')]], () => getSettings().pdfSnapCut, (v) => updateSettings({ pdfSnapCut: v }), 'snap-cut'));
  const col = o.colours; if (col) box.append(seg([['original', t('snapOriginalColors')], ['shown', t('snapAsShown')]], () => col.v, (v) => { col.v = v; }, 'snap-colours'));
  const cb = h('input', { type: 'checkbox', checked: getSettings().pdfSnapCaption }) as HTMLInputElement;
  cb.addEventListener('change', () => { updateSettings({ pdfSnapCaption: cb.checked }); redraw(); });
  box.append(h('label', { class: 'check-row snap-caption-row' }, cb, h('span', null, t('snapCaption'))));
  return box;
}

export interface SnapBook { title: string; author?: string }

/** «Text as image» on a PDF selection: the page cut and the card, to choose between. Everything is read from the
 *  selection at once (the text layer of a page scrolled away is let go of). */
export async function pdfSnapshot(viewer: PdfViewer, range: Range, book: SnapBook, filename: string, appName: string, fallback: string): Promise<void> {
  const read = readSelection(range, viewer);
  const text = (pdfRangeText(range, true) || fallback).trim();
  const card = (style?: 'plain' | 'card') => renderTextCanvas({ text, title: book.title, author: book.author, appName, style });
  if (!read.length) { showSnapshot(await card(), filename, book.title, (style) => card(style)); return; }
  const plans = { column: read.map((r) => planPart(r, false)), words: read.map((r) => planPart(r, true)) };
  const colours = getSettings().pdfInvert ? { v: 'original' as 'original' | 'shown' } : null;
  const caption = (pages: string) => t('snapPageCaption', { title: book.title, n: pages });
  const page = () => { const s = getSettings(); return drawParts(viewer, plans[s.pdfSnapCut], { words: s.pdfSnapCut === 'words', shown: colours?.v === 'shown', caption: s.pdfSnapCaption ? caption : null }); };
  const kind: SnapKind = getSettings().pdfSnapKind === 'card' ? 'card' : 'page';
  showSnapshot(kind === 'page' ? await page() : await card(), filename, book.title, (style) => card(style), undefined, {
    kind, kinds: ['page', 'card'],
    draw: (k) => (k === 'page' ? page() : card()),
    options: (k, redraw) => (k === 'page' ? pageOptions(redraw, { text: true, colours }) : null),
    picked: (k) => updateSettings({ pdfSnapKind: k }),
  });
}

/** «Cut a part of the page»: a frame dragged over the page (finger or mouse), its corners to adjust and the whole to
 *  move, then Done — the same picture as a page cut, of that part. Where it lies is read through the page's sheet, so
 *  the margin crop and the zoom are allowed for. */
export function cutPagePart(viewer: PdfViewer, book: SnapBook, filename: string): void {
  const rect = h('div', { class: 'pdf-cut-rect', hidden: true });
  const handles = ([[0, 0], [1, 0], [0, 1], [1, 1]] as const).map(([cx, cy]) => { const el = h('div', { class: 'pdf-cut-h', 'data-cx': String(cx), 'data-cy': String(cy) }); rect.append(el); return el; });
  const done = h('button', { type: 'button', class: 'btn small primary', disabled: true }, icon('check'), t('done')) as HTMLButtonElement;
  const cancel = h('button', { type: 'button', class: 'btn small' }, t('cancel'));
  const bar = h('div', { class: 'pdf-cutter-bar' }, h('span', null, t('cutPageHint')), cancel, done);
  const layer = h('div', { class: 'pdf-cutter', role: 'dialog', 'aria-label': t('cutPagePart') }, rect, bar);
  document.body.append(layer);
  let r: Box | null = null;
  const show = () => { if (!r) return; rect.hidden = false; Object.assign(rect.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.r - r.l}px`, height: `${r.b - r.t}px` }); handles.forEach((el) => { el.style.left = `${Number(el.dataset.cx) * 100}%`; el.style.top = `${Number(el.dataset.cy) * 100}%`; }); done.disabled = r.r - r.l < 8 || r.b - r.t < 8; };
  let drag: { mode: 'new' | 'move' | 'corner'; x: number; y: number; start: Box; cx?: number; cy?: number } | null = null;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { layer.remove(); window.removeEventListener('keydown', onKey, true); };
  window.addEventListener('keydown', onKey, true);
  cancel.addEventListener('click', close);
  layer.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.pdf-cutter-bar')) return;
    e.preventDefault(); layer.setPointerCapture(e.pointerId);
    const hd = (e.target as HTMLElement).closest<HTMLElement>('.pdf-cut-h');
    if (hd && r) drag = { mode: 'corner', x: e.clientX, y: e.clientY, start: { ...r }, cx: Number(hd.dataset.cx), cy: Number(hd.dataset.cy) };
    else if (r && e.target === rect) drag = { mode: 'move', x: e.clientX, y: e.clientY, start: { ...r } };
    else { r = { l: e.clientX, t: e.clientY, r: e.clientX, b: e.clientY }; drag = { mode: 'new', x: e.clientX, y: e.clientY, start: { ...r } }; show(); }
  });
  layer.addEventListener('pointermove', (e) => {
    if (!drag || !r) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y, s = drag.start;
    if (drag.mode === 'new') r = { l: Math.min(drag.x, e.clientX), r: Math.max(drag.x, e.clientX), t: Math.min(drag.y, e.clientY), b: Math.max(drag.y, e.clientY) };
    else if (drag.mode === 'move') r = { l: s.l + dx, r: s.r + dx, t: s.t + dy, b: s.b + dy };
    else { const x = drag.cx ? s.r + dx : s.l + dx, y = drag.cy ? s.b + dy : s.t + dy, ox = drag.cx ? s.l : s.r, oy = drag.cy ? s.t : s.b; r = { l: Math.min(x, ox), r: Math.max(x, ox), t: Math.min(y, oy), b: Math.max(y, oy) }; }
    show();
  });
  const end = () => { drag = null; }; layer.addEventListener('pointerup', end); layer.addEventListener('pointercancel', end);
  done.addEventListener('click', () => {
    if (!r) return; const sel = r;
    // The page the frame is most on, the frame kept to what is shown of it (its window), as points of the whole page.
    let best: { win: HTMLElement; a: number } | null = null;
    for (const win of Array.from(viewer.root.querySelectorAll<HTMLElement>('.pdf-page'))) {
      const w = win.getBoundingClientRect(); const a = Math.max(0, Math.min(w.right, sel.r) - Math.max(w.left, sel.l)) * Math.max(0, Math.min(w.bottom, sel.b) - Math.max(w.top, sel.t));
      if (a > (best?.a ?? 0)) best = { win, a };
    }
    if (!best) { toast(t('cutPageHint')); return; }
    const n = Number(best.win.dataset.page), w = best.win.getBoundingClientRect(), sr = (PdfViewer.sheetOf(best.win) ?? best.win).getBoundingClientRect(), { width: pw, height: ph } = viewer.pageSize(n);
    const fx = (x: number) => ((Math.min(w.right, Math.max(w.left, x)) - sr.left) / sr.width) * pw, fy = (y: number) => ((Math.min(w.bottom, Math.max(w.top, y)) - sr.top) / sr.height) * ph;
    const part: Part = { n, pw, ph, lh: 12, area: { l: fx(sel.l), r: fx(sel.r), t: fy(sel.t), b: fy(sel.b) } };
    close();
    const colours = getSettings().pdfInvert ? { v: 'original' as 'original' | 'shown' } : null;
    const draw = () => drawParts(viewer, [part], { words: false, shown: colours?.v === 'shown', caption: getSettings().pdfSnapCaption ? (pages) => t('snapPageCaption', { title: book.title, n: pages }) : null });
    void draw().then((c) => showSnapshot(c, filename, book.title, () => draw(), undefined, { kind: 'page', kinds: ['page'], draw: () => draw(), options: (_k, redraw) => pageOptions(redraw, { text: false, colours }), picked: () => undefined }))
      .catch((err) => toast(String((err as Error).message ?? err), 'error'));
  });
}
