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
  // (With a picture inside the words: the words before it and after it as two runs, the picture between.)
  const runs: (string[] | 'pic')[] = [];
  const wrapText = (tx: string) => { const ls = wrap(measure, tx.trim(), W - pad * 2); const maxLines = 60; const out = ls.slice(0, maxLines); if (ls.length > maxLines) out[maxLines - 1] += ' …'; return out; };
  if (pic?.where === 'inside') { if (pic.before) runs.push(wrapText(pic.before)); runs.push('pic'); if (pic.after) runs.push(wrapText(pic.after)); }
  else if (pic?.where === 'before') { runs.push('pic', wrapText(o.text)); }
  else { runs.push(wrapText(o.text)); if (pic) runs.push('pic'); }
  const picW = W - pad * 2; const picH = pic ? Math.round(Math.min(picW * (pic.img.naturalHeight / Math.max(1, pic.img.naturalWidth)), 1400)) : 0;
  const gap = Math.round(lh * 0.8);
  const plain = (o.style ?? s.snapStyle) === 'plain';
  const textH = runs.reduce((n, r, i) => n + (r === 'pic' ? picH : r.length * lh - (lh - fontSize)) + (i ? gap : 0), 0);
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
    for (const line of r) { ctx.fillText(line, x, y); y += lh; }
    y -= lh - fontSize;
  }

  if (!plain) {
    const titleRtl = isRtlText(o.title);
    ctx.direction = titleRtl ? 'rtl' : 'ltr';
    ctx.textAlign = titleRtl ? 'right' : 'left';
    const tx = titleRtl ? W - pad : pad;
    ctx.fillStyle = L.fg; ctx.font = `600 30px ${titleRtl ? L.fontRtl : L.font}`;
    ctx.fillText(o.title, tx, H - pad - 34);
    ctx.fillStyle = L.dim; ctx.font = `26px ${titleRtl ? L.fontRtl : L.font}`;
    if (o.author) ctx.fillText(o.author, tx, H - pad + 2);
    ctx.direction = 'ltr'; ctx.textAlign = titleRtl ? 'left' : 'right';
    if (o.appName) { ctx.font = `24px Inter, system-ui, sans-serif`; ctx.fillText(o.appName, titleRtl ? pad : W - pad, H - pad - 10); }
  }
  return c;
}

export async function renderTextCard(o: TextCardOptions): Promise<Blob> {
  return canvasToBlob(await renderTextCanvas(o), 'image/png');
}

/** The ways a passage can be pictured, when there is more than the card (a PDF: the page itself, cut out): the one
 *  shown first, each drawn when it is picked, the options each has under the preview, and the pick remembered. */
export type SnapKind = 'page' | 'card';
export interface SnapChoice { kind: SnapKind; kinds: SnapKind[]; draw(kind: SnapKind): Promise<HTMLCanvasElement>; options(kind: SnapKind, redraw: () => void): HTMLElement | null; picked(kind: SnapKind): void }

/** Preview the snapshot with Save / Share / Copy and a style switch (and, with `choice`, the kinds to choose from). */
export function showSnapshot(canvas: HTMLCanvasElement, filename: string, title: string, rerender: (style: 'plain' | 'card', pictureOn?: boolean) => Promise<HTMLCanvasElement>, picture?: { has: boolean; on: boolean }, choice?: SnapChoice): void {
  const sheet = openSheet(t('textAsImage'), t('close'));
  sheet.body.style.fontFamily = 'var(--font-ui)';
  const holder = h('div', { class: 'snap-holder' });
  let blob: Blob | null = null;
  // (A picture replaced is let go of at once: a page cut can be large.)
  const mount = (c: HTMLCanvasElement) => { const old = holder.firstChild as HTMLCanvasElement | null; holder.replaceChildren(c); c.className = 'snap-preview'; canvas = c; blob = null; if (old && old !== c) old.width = old.height = 0; };
  mount(canvas);
  let kind: SnapKind = choice?.kind ?? 'card';
  const opts = h('div', { class: 'snap-options' });
  let seq = 0;
  const redraw = async () => { const my = ++seq; const c = kind === 'card' ? await rerender(getSettings().snapStyle, picOn) : await choice!.draw(kind); if (my === seq) mount(c); else c.width = c.height = 0; };
  const fillOpts = () => { opts.replaceChildren(); const o = choice?.options(kind, () => void redraw().catch((e) => toast(String((e as Error).message ?? e), 'error'))); if (o) opts.append(o); };
  if (choice && choice.kinds.length > 1) {
    const seg = h('div', { class: 'segmented snap-kind', role: 'radiogroup', 'aria-label': t('textAsImage') });
    const paint = () => seg.replaceChildren(...choice.kinds.map((k) => h('button', { type: 'button', role: 'radio', 'aria-pressed': String(k === kind), 'aria-checked': String(k === kind), 'data-kind': k, onclick: () => {
      if (k === kind) return; kind = k; choice.picked(k); paint(); fillOpts(); styleBtn.hidden = kind !== 'card'; void redraw().catch((e) => toast(String((e as Error).message ?? e), 'error'));
    } }, t(k === 'page' ? 'snapAsPage' : 'snapAsCard'))));
    paint(); sheet.body.appendChild(seg);
  }
  sheet.body.appendChild(holder);
  if (choice) { fillOpts(); sheet.body.appendChild(opts); }
  let picOn = picture?.on ?? false;
  // (A picture the words touched: shown with them, or not — on unless it only came before the words.)
  if (picture?.has) {
    const box = h('input', { type: 'checkbox', checked: picOn }) as HTMLInputElement;
    box.addEventListener('change', async () => { picOn = box.checked; mount(await rerender(getSettings().snapStyle, picOn)); });
    sheet.body.appendChild(h('label', { class: 'check-row snap-pic-row' }, box, h('span', null, t('snapIncludePicture'))));
  }
  const png = async () => blob ?? (blob = await canvasToBlob(canvas, 'image/png'));
  const styleBtn = h('button', { class: 'btn small', type: 'button' }, t(getSettings().snapStyle === 'plain' ? 'snapCard' : 'snapPlain'));
  styleBtn.hidden = kind !== 'card';
  styleBtn.addEventListener('click', async () => {
    const next = getSettings().snapStyle === 'plain' ? 'card' : 'plain';
    updateSettings({ snapStyle: next });
    styleBtn.textContent = t(next === 'plain' ? 'snapCard' : 'snapPlain');
    mount(await rerender(next, picOn));
  });
  const copy = h('button', { class: 'btn small', type: 'button', onclick: async () => { if (await copyImage(await png())) toast(t('copied')); } }, icon('copy'), t('copyImage'));
  const share = h('button', { class: 'btn small', type: 'button', onclick: async () => { const b = await png(); sheet.close(); void shareFile(b, filename, title); } }, icon('share'), t('shareText'));
  const save = h('button', { class: 'btn small primary', type: 'button', onclick: async () => { const b = await png(); sheet.close(); void saveImage(b, filename); } }, icon('download'), t('saveImage'));
  sheet.actions.append(styleBtn, copy, share, save);
}
