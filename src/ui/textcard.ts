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

export interface TextCardOptions { text: string; title: string; author?: string; appName: string; style?: 'plain' | 'card' }

interface Look { bg: string; fg: string; dim: string; rule: string; font: string; fontRtl: string; size: number; lh: number; align: string }

function look(): Look {
  const el = document.querySelector('.reader') as HTMLElement | null;
  const cs = el ? getComputedStyle(el) : null;
  const get = (v: string, d: string) => cs?.getPropertyValue(v).trim() || d;
  return {
    bg: get('--r-bg', '#1b1b1b'), fg: get('--r-fg', '#d2d2d2'), dim: get('--r-dim', '#8f8f8f'), rule: get('--r-rule', '#303030'),
    font: get('--r-font', "'Lora', serif"), fontRtl: get('--r-font-rtl', "'Uthman TN1', serif"),
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
  } else if (s.texture === 'dots') {
    ctx.save(); ctx.globalAlpha = s.textureOpacity; ctx.fillStyle = 'rgba(255,255,255,.08)';
    for (let y = 7; y < H; y += 14 * (W / 480)) for (let x = 7; x < W; x += 14 * (W / 480)) { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); }
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
  if (!document.fonts.check(`16px ${family}`)) { try { await document.fonts.ready; } catch { /* ignore */ } }

  const W = 1080, pad = 84;
  const scale = W / Math.min(Math.max(window.innerWidth, 320), 720); // match on-screen proportions
  const fontSize = Math.round(L.size * scale);
  const lh = Math.round(fontSize * L.lh);
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `${fontSize}px ${family}`;
  const lines = wrap(measure, o.text.trim(), W - pad * 2);
  const maxLines = 60;
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] += ' …';

  const plain = (o.style ?? s.snapStyle) === 'plain';
  const textH = shown.length * lh - (lh - fontSize);
  const H = plain ? pad * 2 + textH : pad * 2 + 110 + textH + 150;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
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
  for (const line of shown) { ctx.fillText(line, x, y); y += lh; }

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

/** Preview the snapshot with Save / Share / Copy and a style switch. */
export function showSnapshot(canvas: HTMLCanvasElement, filename: string, title: string, rerender: (style: 'plain' | 'card') => Promise<HTMLCanvasElement>): void {
  const sheet = openSheet(t('textAsImage'), t('close'));
  sheet.body.style.fontFamily = 'var(--font-ui)';
  const holder = h('div', { class: 'snap-holder' });
  const mount = (c: HTMLCanvasElement) => { holder.replaceChildren(c); c.className = 'snap-preview'; canvas = c; };
  mount(canvas);
  sheet.body.appendChild(holder);
  let blob: Blob | null = null;
  const png = async () => blob ?? (blob = await canvasToBlob(canvas, 'image/png'));
  const styleBtn = h('button', { class: 'btn small', type: 'button' }, t(getSettings().snapStyle === 'plain' ? 'snapCard' : 'snapPlain'));
  styleBtn.addEventListener('click', async () => {
    const next = getSettings().snapStyle === 'plain' ? 'card' : 'plain';
    updateSettings({ snapStyle: next }); blob = null;
    styleBtn.textContent = t(next === 'plain' ? 'snapCard' : 'snapPlain');
    mount(await rerender(next));
  });
  const copy = h('button', { class: 'btn small', type: 'button', onclick: async () => { if (await copyImage(await png())) toast(t('copied')); } }, icon('copy'), t('copyImage'));
  const share = h('button', { class: 'btn small', type: 'button', onclick: async () => { const b = await png(); sheet.close(); void shareFile(b, filename, title); } }, icon('share'), t('shareText'));
  const save = h('button', { class: 'btn small primary', type: 'button', onclick: async () => { const b = await png(); sheet.close(); void saveImage(b, filename); } }, icon('download'), t('saveImage'));
  sheet.actions.append(styleBtn, copy, share, save);
}
