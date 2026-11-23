// "Text as image" (صوِّر النص): renders a selected passage onto a canvas that
// copies the reader's current look — page colour (or override), background
// picture, texture, warmth and dimming, the reading font and its size — either
// as a plain snap (just the text, like a screenshot) or as a quote card with
// the book's title and author. The canvas is shown at once; PNG encoding only
// happens when the reader saves, shares or copies it.
import { getSettings, updateSettings, loadBgImage } from '../settings';
import { isRtlText, t } from '../i18n';
import { canvasToBlob, saveImage, shareFile, copyImage } from './share';
import { h, icon, openSheet, toast } from './dom';

export interface TextCardOptions { text: string; title: string; author?: string; appName: string; style?: 'plain' | 'card';
  /** The words as the book sets them (styledBlocks), drawn so when `bookFormat` is on; else the plain text in the reader's look. */
  blocks?: SnapBlock[]; bookFormat?: boolean;
  /** A picture the selection touched (see pictureNear): drawn before the text, after it, or between its two parts. */
  picture?: PictureNear; pictureOn?: boolean }
/** A picture beside the words picked: inside the selection (the words before it and after it apart), right after
 *  them, or right before them — with whether it is shown unasked: yes unless it only comes before. */
export interface PictureNear { img: HTMLImageElement; where: 'inside' | 'after' | 'before'; before?: string; after?: string }
const isPic = (n: Node): n is HTMLImageElement => n instanceof HTMLImageElement && n.naturalWidth > 0;
const hasWords = (n: Node): boolean => n.nodeType === Node.TEXT_NODE && !!n.textContent?.trim();
export function pictureNear(range: Range | undefined): PictureNear | null {
  if (!range || range.collapsed) return null;
  const root = range.commonAncestorContainer.ownerDocument ?? document;
  // (A picture within the words picked: the first one.)
  const walker = root.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (isPic(n) && range.intersectsNode(n) && range.comparePoint(n, 0) === 0) {
    const r1 = range.cloneRange(); r1.setEndBefore(n); const r2 = range.cloneRange(); r2.setStartAfter(n);
    return { img: n, where: 'inside', before: r1.toString().trim(), after: r2.toString().trim() };
  }
  // (The next thing after the words with anything in it: a picture, or words — then there is none after.)
  const scan = (dir: 'forward' | 'back'): HTMLImageElement | null => {
    const w = root.createTreeWalker(root.body ?? root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    w.currentNode = dir === 'forward' ? range.endContainer : range.startContainer;
    for (let n = dir === 'forward' ? w.nextNode() : w.previousNode(), k = 0; n && k < 400; n = dir === 'forward' ? w.nextNode() : w.previousNode(), k++) {
      if (dir === 'forward' ? range.comparePoint(n, 0) <= 0 : range.comparePoint(n, 0) >= 0) continue;
      if (isPic(n)) return n;
      if (hasWords(n)) return null;
    }
    return null;
  };
  const after = scan('forward'); if (after) return { img: after, where: 'after' };
  const before = scan('back'); if (before) return { img: before, where: 'before' };
  return null;
}
export const pictureOnByDefault = (p: PictureNear | null): boolean => !!p && p.where !== 'before';

/** A block of the words picked as the book sets it: its alignment, first-line indent (a share of the text's size) and
 *  direction, and its runs of text each with its weight, slant, size (a share of the reader's) and face. */
export interface SnapRun { text: string; bold: boolean; italic: boolean; scale: number; family: string }
export interface SnapBlock { align: 'start' | 'center' | 'end' | 'justify'; indent: number; rtl: boolean; runs: SnapRun[] }
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, td, th, pre, div';
/** The words of `range` as the page shows them (read at once: a selection does not last). The alignment is the book's
 *  own (its centred, right-aligned and justified blocks — src/formats/titles.ts marks), else at the start. */
export function styledBlocks(range: Range | undefined, base: number): SnapBlock[] | undefined {
  if (!range || range.collapsed) return undefined;
  const root = range.commonAncestorContainer;
  const w = document.createTreeWalker(root.nodeType === 1 ? root : root.parentNode!, NodeFilter.SHOW_TEXT);
  const out: SnapBlock[] = []; let cur: Element | null = null;
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    if (!range.intersectsNode(n)) continue;
    const el = n.parentElement; if (!el || el.closest('rt, rp, script, style')) continue;
    const a = n === range.startContainer ? range.startOffset : 0, b = n === range.endContainer ? range.endOffset : n.data.length;
    const text = n.data.slice(a, b).replace(/\s+/g, ' '); if (!text) continue;
    const blk = el.closest(BLOCK) ?? el;
    if (blk !== cur) {
      cur = blk; const cs = getComputedStyle(blk);
      const mark = blk.closest('[data-kr-align]')?.getAttribute('data-kr-align');
      const align = mark === 'center' ? 'center' : mark === 'right' || mark === 'end' ? 'end' : mark === 'justify' || (cs.textAlign === 'justify' && !blk.hasAttribute('data-kr-rag')) ? 'justify' : 'start';
      out.push({ align, indent: (parseFloat(cs.textIndent) || 0) / (parseFloat(cs.fontSize) || base), rtl: cs.direction === 'rtl', runs: [] });
    }
    const cs = getComputedStyle(el);
    out[out.length - 1].runs.push({ text, bold: (parseInt(cs.fontWeight, 10) || 400) >= 600, italic: cs.fontStyle !== 'normal', scale: (parseFloat(cs.fontSize) || base) / base, family: cs.fontFamily });
  }
  for (const bl of out) { const f = bl.runs[0]; if (f) f.text = f.text.trimStart(); const l = bl.runs[bl.runs.length - 1]; if (l) l.text = l.text.trimEnd(); }
  return out.filter((bl) => bl.runs.some((r) => r.text.trim()));
}

interface Piece { text: string; font: string; w: number }
interface Word { pieces: Piece[]; w: number }
interface SetLine { words: Word[]; w: number; size: number; last: boolean; first: boolean; block: SnapBlock }
const fontOf = (r: SnapRun, size: number) => `${r.italic ? 'italic ' : ''}${r.bold ? '700 ' : ''}${Math.round(size * r.scale)}px ${r.family}`;
/** Each block's lines, words kept whole (a word whose pieces differ in weight or slant one word). */
function setBlocks(ctx: CanvasRenderingContext2D, blocks: SnapBlock[], maxW: number, size: number, maxLines = 60): SetLine[][] {
  let count = 0; const all: SetLine[][] = [];
  for (const bl of blocks) {
    const words: Word[] = []; let cur: Word | null = null;
    for (const r of bl.runs) for (const part of r.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { cur = null; continue; }
      ctx.font = fontOf(r, size); const pc = { text: part, font: ctx.font, w: ctx.measureText(part).width };
      if (!cur) { cur = { pieces: [], w: 0 }; words.push(cur); }
      cur.pieces.push(pc); cur.w += pc.w;
    }
    const sizeOf = (ws: Word[]) => Math.max(size, ...ws.flatMap((x) => x.pieces.map((p) => parseFloat(/(\d+)px/.exec(p.font)?.[1] ?? '0'))));
    ctx.font = `${size}px serif`; const space = ctx.measureText(' ').width;
    const lines: SetLine[] = []; let line: Word[] = [], lw = 0;
    const indent = Math.max(0, bl.indent * size);
    for (const wd of words) {
      const room = maxW - (lines.length ? 0 : indent);
      if (line.length && lw + space + wd.w > room) { lines.push({ words: line, w: lw, size: sizeOf(line), last: false, first: !lines.length, block: bl }); line = []; lw = 0; }
      lw += (line.length ? space : 0) + wd.w; line.push(wd);
    }
    if (line.length) lines.push({ words: line, w: lw, size: sizeOf(line), last: true, first: !lines.length, block: bl });
    count += lines.length; all.push(lines);
    if (count >= maxLines) break;
  }
  return all;
}

interface Look { bg: string; fg: string; dim: string; rule: string; font: string; fontRtl: string; size: number; lh: number; align: string }

function look(): Look {
  const el = document.querySelector('.reader') as HTMLElement | null;
  const cs = el ? getComputedStyle(el) : null;
  const get = (v: string, d: string) => cs?.getPropertyValue(v).trim() || d;
  return {
    bg: get('--r-bg', '#1b1b1b'), fg: get('--r-fg', '#d2d2d2'), dim: get('--r-dim', '#8f8f8f'), rule: get('--r-rule', '#303030'),
    font: get('--r-font', "'Merriweather', serif"), fontRtl: get('--r-font-rtl', "'Uthman TN1', serif"),
    size: parseFloat(get('--r-size', '19')) || 19, lh: parseFloat(get('--r-lh', '1.7')) || 1.7, align: get('--r-align', 'start'),
  };
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/\r/g, '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

/** Background picture, texture and comfort overlays, as the reader shows them. */
async function paintBackground(ctx: CanvasRenderingContext2D, W: number, H: number, L: Look): Promise<void> {
  const s = getSettings();
  ctx.fillStyle = L.bg; ctx.fillRect(0, 0, W, H);
  if (s.bgImage) {
    try {
      const url = await loadBgImage();
      if (url) {
        const img = new Image(); img.src = url; await img.decode();
        const scale = Math.max(W / img.width, H / img.height) * 1.04;
        const w = img.width * scale, hh = img.height * scale;
        ctx.save(); ctx.globalAlpha = s.bgImageOpacity; if (s.bgBlur) ctx.filter = `blur(${s.bgBlur * (W / 480)}px)`;
        ctx.drawImage(img, (W - w) / 2, (H - hh) / 2, w, hh); ctx.restore();
        if (s.bgShade) { ctx.save(); ctx.globalAlpha = s.bgImageOpacity * s.bgShade; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
      }
    } catch { /* picture is optional */ }
  }
  if (s.texture === 'paper' || s.texture === 'parchment') {
    // grain: sparse translucent specks
    ctx.save(); ctx.globalAlpha = s.textureOpacity * 0.5;
    const n = Math.floor((W * H) / 180);
    for (let i = 0; i < n; i++) { const v = Math.random() > 0.5 ? 255 : 0; ctx.fillStyle = `rgba(${v},${v},${v},${0.08 + Math.random() * 0.1})`; ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
    if (s.texture === 'parchment') {
      const g = ctx.createRadialGradient(W * 0.2, H * 0.1, 0, W * 0.2, H * 0.1, W * 0.6); g.addColorStop(0, 'rgba(255,210,140,.14)'); g.addColorStop(1, 'rgba(255,210,140,0)');
      ctx.globalAlpha = s.textureOpacity; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const g2 = ctx.createRadialGradient(W * 0.8, H * 0.9, 0, W * 0.8, H * 0.9, W * 0.6); g2.addColorStop(0, 'rgba(120,70,20,.18)'); g2.addColorStop(1, 'rgba(120,70,20,0)');
      ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  } else if (s.texture === 'linen') {
    ctx.save(); ctx.globalAlpha = s.textureOpacity; const step = 3 * (W / 480);
    ctx.fillStyle = 'rgba(255,255,255,.035)'; for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, 1);
    ctx.fillStyle = 'rgba(0,0,0,.05)'; for (let x = 0; x < W; x += step) ctx.fillRect(x, 0, 1, H);
    ctx.restore();
  }
  if (s.warmth > 0) { ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = `rgba(255,170,60,${s.warmth})`; ctx.fillRect(0, 0, W, H); ctx.restore(); }
  if (s.dimOverlay > 0) { ctx.fillStyle = `rgba(0,0,0,${s.dimOverlay})`; ctx.fillRect(0, 0, W, H); }
}

/** Draws the snapshot; returns the canvas (cheap to show, encode later). */
export async function renderTextCanvas(o: TextCardOptions): Promise<HTMLCanvasElement> {
  const s = getSettings();
  const L = look();
  const rtl = isRtlText(o.text);
  const family = rtl ? L.fontRtl : L.font;
  // Only wait for fonts if the one we need is not loaded yet.
  try { await document.fonts.load(`16px ${family}`); } catch { /* ignore */ }

  const W = 1080, pad = 84;
  const scale = W / Math.min(Math.max(window.innerWidth, 320), 720); // match on-screen proportions
  const fontSize = Math.round(L.size * scale);
  const lh = Math.round(fontSize * L.lh);
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `${fontSize}px ${family}`;
  const pic = o.picture && o.pictureOn ? o.picture : null;
  const set = o.bookFormat && o.blocks?.length ? setBlocks(measure, o.blocks, W - pad * 2, fontSize) : null;
  // (With a picture inside the words: the words before it and after it as two runs, the picture between.)
  const runs: (string[] | 'pic')[] = [];
  const wrapText = (tx: string) => { const ls = wrap(measure, tx.trim(), W - pad * 2); const maxLines = 60; const out = ls.slice(0, maxLines); if (ls.length > maxLines) out[maxLines - 1] += ' …'; return out; };
  if (set) { if (pic?.where === 'before') runs.push('pic'); runs.push([]); if (pic && pic.where !== 'before') runs.push('pic'); }
  else if (pic?.where === 'inside') { if (pic.before) runs.push(wrapText(pic.before)); runs.push('pic'); if (pic.after) runs.push(wrapText(pic.after)); }
  else if (pic?.where === 'before') { runs.push('pic', wrapText(o.text)); }
  else { runs.push(wrapText(o.text)); if (pic) runs.push('pic'); }
  const picW = W - pad * 2; const picH = pic ? Math.round(Math.min(picW * (pic.img.naturalHeight / Math.max(1, pic.img.naturalWidth)), 1400)) : 0;
  const gap = Math.round(lh * 0.8);
  const plain = (o.style ?? s.snapStyle) === 'plain';
  // (Set as the book sets it: each line as high as its largest letters, a paragraph's breath between blocks.)
  const lineH = (ln: SetLine) => Math.round(ln.size * L.lh);
  const setH = set ? set.reduce((n, ls, i) => n + ls.reduce((m, ln) => m + lineH(ln), 0) + (i ? Math.round(fontSize * 0.5) : 0), 0) - (lh - fontSize) : 0;
  const textH = runs.reduce((n, r, i) => n + (r === 'pic' ? picH : set ? setH : r.length * lh - (lh - fontSize)) + (i ? gap : 0), 0);
  const H = plain ? pad * 2 + textH : pad * 2 + 110 + textH + 150;
  const c = document.createElement('canvas');
  c.width = W; c.height = H; c.dataset.text = o.text; c.dataset.dir = rtl ? 'rtl' : 'ltr';   // (what it was given: for the tests)
  const ctx = c.getContext('2d')!;
  await paintBackground(ctx, W, H, L);

  const alignRight = rtl ? L.align !== 'end' && L.align !== 'left' : L.align === 'end' || L.align === 'right';
  const center = L.align === 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = center ? 'center' : alignRight ? 'right' : 'left';
  const x = center ? W / 2 : alignRight ? W - pad : pad;

  let y = pad + fontSize + (plain ? 0 : 110);
  if (!plain) {
    ctx.strokeStyle = L.rule; ctx.lineWidth = 2; ctx.strokeRect(pad / 2, pad / 2, W - pad, H - pad);
    ctx.fillStyle = L.dim; ctx.font = `${Math.round(fontSize * 2.6)}px ${family}`;
    ctx.fillText(rtl ? '«' : '“', x, pad + 70);
  }
  ctx.fillStyle = L.fg; ctx.font = `${fontSize}px ${family}`;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]; if (i) y += gap;
    if (r === 'pic') {
      // (The picture at the text's width, its corners rounded; one the page may not read is left out.)
      const top = y - fontSize; ctx.save(); ctx.beginPath(); const rad = 18; ctx.roundRect(pad, top, picW, picH, rad); ctx.clip();
      try { ctx.drawImage(pic!.img, pad, top, picW, picH); } catch { /* tainted: skipped */ } ctx.restore(); y += picH; continue;
    }
    if (set) { y = drawSet(ctx, set, y, pad, W - pad * 2, fontSize, lineH, L.fg) + fontSize; ctx.font = `${fontSize}px ${family}`; continue; }
    for (const line of r) { ctx.fillText(line, x, y); y += lh; }
    y -= lh - fontSize;
  }

  if (!plain) {
    const titleRtl = isRtlText(o.title);
    ctx.direction = titleRtl ? 'rtl' : 'ltr';
    ctx.textAlign = titleRtl ? 'right' : 'left';
    const tx = titleRtl ? W - pad : pad;
    ctx.fillStyle = L.fg; ctx.font = `600 30px ${titleRtl ? L.fontRtl : L.font}`;
    if (o.title) ctx.fillText(o.title, tx, H - pad - 34);
    ctx.fillStyle = L.dim; ctx.font = `26px ${titleRtl ? L.fontRtl : L.font}`;
    if (o.author) ctx.fillText(o.author, tx, H - pad + 2);
    ctx.direction = 'ltr'; ctx.textAlign = titleRtl ? 'left' : 'right';
    if (o.appName) { ctx.font = `24px Inter, system-ui, sans-serif`; ctx.fillText(o.appName, titleRtl ? pad : W - pad, H - pad - 10); }
  }
  return c;
}

/** Draws the set lines from `y` (the first baseline); returns the last baseline. Justified lines are spread only while a
 *  gap stays within a word space and 0.8 em (as src/ui/smartjustify.ts): a line that would open a river is left at the start. */
function drawSet(ctx: CanvasRenderingContext2D, set: SetLine[][], y: number, left: number, maxW: number, size: number, lineH: (l: SetLine) => number, fg: string): number {
  ctx.fillStyle = fg; ctx.textBaseline = 'alphabetic';
  ctx.font = `${size}px serif`; const space = ctx.measureText(' ').width;
  let first = true;
  set.forEach((lines, bi) => {
    if (bi) y += Math.round(size * 0.5);
    for (const ln of lines) {
      if (!first) y += lineH(ln);
      first = false;
      const { align, rtl } = ln.block;
      const indent = ln.first ? Math.max(0, ln.block.indent * size) : 0;
      const room = maxW - indent; const gaps = ln.words.length - 1;
      let gapW = space;
      if (align === 'justify' && !ln.last && gaps > 0) { const extra = (room - ln.w) / gaps; if (extra > 0 && extra <= 0.8 * size) gapW = space + extra; }
      const used = ln.w + (gapW - space) * gaps;
      let pos = indent + (align === 'center' ? (room - used) / 2 : align === 'end' ? room - used : 0);
      ctx.direction = rtl ? 'rtl' : 'ltr'; ctx.textAlign = rtl ? 'right' : 'left';
      for (const wd of ln.words) {
        let px = pos;
        for (const pc of wd.pieces) { ctx.font = pc.font; ctx.fillText(pc.text, rtl ? left + maxW - px : left + px, y); px += pc.w; }
        pos += wd.w + gapW;
      }
    }
  });
  ctx.direction = 'ltr';
  return y;
}

export async function renderTextCard(o: TextCardOptions): Promise<Blob> {
  return canvasToBlob(await renderTextCanvas(o), 'image/png');
}

/** The ways a passage can be pictured, when there is more than the card (a PDF: the page itself, cut out): the one
 *  shown first, each drawn when it is picked, the options each has under the preview, and the pick remembered. */
export type SnapKind = 'page' | 'card';
/** The card's title and author lines, editable under the preview: prefilled from the book; `change` redraws with
 *  them; `remember` keeps an author with the book; `useTitle` makes the title the book's shown one. */
export interface SnapNames { title: string; author: string; change(title: string, author: string): void; remember(author: string): Promise<void> | void; useTitle(title: string): Promise<void> | void }
export interface SnapChoice { kind: SnapKind; kinds: SnapKind[]; draw(kind: SnapKind): Promise<HTMLCanvasElement>; options(kind: SnapKind, redraw: () => void): HTMLElement | null; picked(kind: SnapKind): void }

/** Preview the snapshot with Save / Share / Copy and a style switch (and, with `choice`, the kinds to choose from). */
export function showSnapshot(canvas: HTMLCanvasElement, filename: string, title: string, rerender: (style: 'plain' | 'card', pictureOn?: boolean, bookFormat?: boolean) => Promise<HTMLCanvasElement>, picture?: { has: boolean; on: boolean }, choice?: SnapChoice, format?: { has: boolean }, names?: SnapNames): void {
  const sheet = openSheet(t('textAsImage'), t('close'));
  sheet.el.classList.add('snap-sheet');
  sheet.body.style.fontFamily = 'var(--font-ui)';
  const holder = h('div', { class: 'snap-holder' });
  let blob: Blob | null = null;
  // (A picture replaced is let go of at once: a page cut can be large.)
  const mount = (c: HTMLCanvasElement) => { const old = holder.firstChild as HTMLCanvasElement | null; holder.replaceChildren(c); c.className = 'snap-preview'; canvas = c; blob = null; if (old && old !== c) old.width = old.height = 0; };
  mount(canvas);
  let kind: SnapKind = choice?.kind ?? 'card';
  const opts = h('div', { class: 'snap-options' });
  let seq = 0;
  const redraw = async () => { const my = ++seq; const c = kind === 'card' ? await rerender(getSettings().snapStyle, picOn, fmtOn) : await choice!.draw(kind); if (my === seq) mount(c); else c.width = c.height = 0; };
  const fillOpts = () => { opts.replaceChildren(); const o = choice?.options(kind, () => void redraw().catch((e) => toast(String((e as Error).message ?? e), 'error'))); if (o) opts.append(o); };
  if (choice && choice.kinds.length > 1) {
    const seg = h('div', { class: 'segmented snap-kind', role: 'radiogroup', 'aria-label': t('textAsImage') });
    const paint = () => seg.replaceChildren(...choice.kinds.map((k) => h('button', { type: 'button', role: 'radio', 'aria-pressed': String(k === kind), 'aria-checked': String(k === kind), 'data-kind': k, onclick: () => {
      if (k === kind) return; kind = k; choice.picked(k); paint(); fillOpts(); styleBtn.hidden = kind !== 'card'; showNames(); void redraw().catch((e) => toast(String((e as Error).message ?? e), 'error'));
    } }, t(k === 'page' ? 'snapAsPage' : 'snapAsCard'))));
    paint(); sheet.body.appendChild(seg);
  }
  sheet.body.appendChild(holder);
  if (choice) { fillOpts(); sheet.body.appendChild(opts); }
  let picOn = picture?.on ?? false;
  // (The book's own formatting, or the plain text in the reader's look: the choice remembered — settings snapBookFormat.)
  let fmtOn = !!format?.has && getSettings().snapBookFormat;
  // (A picture the words touched: shown with them, or not — on unless it only came before the words.)
  if (picture?.has) {
    const box = h('input', { type: 'checkbox', checked: picOn }) as HTMLInputElement;
    box.addEventListener('change', async () => { picOn = box.checked; mount(await rerender(getSettings().snapStyle, picOn, fmtOn)); });
    sheet.body.appendChild(h('div', { class: 'options-grid snap-pic' }, h('label', { class: 'row snap-pic-row' }, h('span', { class: 'label' }, t('snapIncludePicture')), h('span', { class: 'switch' }, box, h('i')))));
  }
  if (format?.has) {
    // (The app's own switch row — its name and a line under it, the switch at the end — as in the Visual Options.)
    const box = h('input', { type: 'checkbox', checked: fmtOn }) as HTMLInputElement;
    box.addEventListener('change', async () => { fmtOn = box.checked; updateSettings({ snapBookFormat: fmtOn }); mount(await rerender(getSettings().snapStyle, picOn, fmtOn)); });
    sheet.body.appendChild(h('div', { class: 'options-grid snap-fmt', style: { marginTop: '14px' } },
      h('label', { class: 'row snap-fmt-row' }, h('span', { class: 'label' }, t('snapBookFormat')), h('span', { class: 'switch' }, box, h('i'))),
      h('p', { class: 'hint', style: { marginTop: '-16px' } }, t('snapBookFormatHint'))));
  }
  // The card's title and author lines: two small fields, applied to the picture as they are typed (only where the
  // card carries them: the card with title and author, not the page cut or the plain look).
  let namesBox: HTMLElement | null = null; let namesTimer = 0; let saveTimer = 0;
  const showNames = () => { if (namesBox) namesBox.hidden = !(kind === 'card' && getSettings().snapStyle !== 'plain'); };
  if (names) {
    const ti = h('input', { type: 'text', class: 'textpic-title', id: 'textpic-title', dir: 'auto', value: names.title, placeholder: t('cardTitleField'), 'aria-label': t('cardTitleField') }) as HTMLInputElement;
    const au = h('input', { type: 'text', class: 'textpic-author', id: 'textpic-author', dir: 'auto', value: names.author, placeholder: t('addAuthor'), 'aria-label': t('cardAuthorField') }) as HTMLInputElement;
    const rem = h('input', { type: 'checkbox', role: 'switch', class: 'textpic-remember' }) as HTMLInputElement; rem.checked = true;
    const use = h('button', { type: 'button', class: 'btn small tonal textpic-use', hidden: true }, t('useAsBookTitle'));
    const keep = () => { if (rem.checked && au.value.trim() && au.value.trim() !== names.author.trim()) { const v = au.value.trim(); void Promise.resolve(names.remember(v)).then(() => { names.author = v; }); } };
    const apply = () => { use.hidden = !ti.value.trim() || ti.value.trim() === names.title; names.change(ti.value.trim(), au.value.trim()); window.clearTimeout(namesTimer); namesTimer = window.setTimeout(() => void redraw().catch(() => undefined), 120); window.clearTimeout(saveTimer); saveTimer = window.setTimeout(keep, 500); };
    ti.addEventListener('input', apply); au.addEventListener('input', apply); rem.addEventListener('change', keep);
    use.addEventListener('click', async () => { const v = ti.value.trim(); if (!v) return; await names.useTitle(v); names.title = v; use.hidden = true; toast(t('saved')); });
    namesBox = h('div', { class: 'textpic-names' }, h('div', { class: 'field' }, h('label', { for: 'textpic-title' }, t('cardTitleField')), ti), h('div', { class: 'field' }, h('label', { for: 'textpic-author' }, t('cardAuthorField')), au), h('label', { class: 'row textpic-remember-row' }, h('span', { class: 'label' }, t('rememberAuthor'), h('small', { class: 'hint' }, t('rememberAuthorHint'))), h('span', { class: 'switch' }, rem, h('i'))), use);
    holder.after(namesBox); showNames();
  }
  const png = async () => blob ?? (blob = await canvasToBlob(canvas, 'image/png'));
  const styleBtn = h('button', { class: 'btn small', type: 'button' }, t(getSettings().snapStyle === 'plain' ? 'snapCard' : 'snapPlain'));
  styleBtn.hidden = kind !== 'card';
  styleBtn.addEventListener('click', async () => {
    const next = getSettings().snapStyle === 'plain' ? 'card' : 'plain';
    updateSettings({ snapStyle: next });
    styleBtn.textContent = t(next === 'plain' ? 'snapCard' : 'snapPlain'); showNames();
    mount(await rerender(next, picOn, fmtOn));
  });
  const copy = h('button', { class: 'btn small', type: 'button', onclick: async () => { if (await copyImage(await png())) toast(t('copied')); } }, icon('copy'), t('copyImage'));
  const share = h('button', { class: 'btn small', type: 'button', onclick: async () => { const b = await png(); sheet.close(); void shareFile(b, filename, title); } }, icon('share'), t('shareText'));
  const save = h('button', { class: 'btn small primary', type: 'button', onclick: async () => { const b = await png(); sheet.close(); void saveImage(b, filename); } }, icon('download'), t('saveImage'));
  sheet.actions.append(styleBtn, copy, share, save);
}
