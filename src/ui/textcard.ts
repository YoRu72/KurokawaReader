// "Text as image": renders a selected passage as a quote card — the book's
// title and author, the text in the reading font on the current page colours.
import { getSettings, updateSettings } from '../settings';
import { isRtlText, t } from '../i18n';
import { canvasToBlob, saveImage, shareFile } from './share';
import { h, openSheet } from './dom';

export interface TextCardOptions { text: string; title: string; author?: string; appName: string; style?: 'plain' | 'card' }

function readerColors(): { bg: string; fg: string; dim: string; rule: string } {
  const el = document.querySelector('.reader') as HTMLElement | null;
  const cs = el ? getComputedStyle(el) : null;
  const get = (v: string, d: string) => cs?.getPropertyValue(v).trim() || d;
  return { bg: get('--r-bg', '#141414'), fg: get('--r-fg', '#cfcbc4'), dim: get('--r-dim', '#8d8a84'), rule: get('--r-rule', '#2f2f2f') };
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

export async function renderTextCard(o: TextCardOptions): Promise<Blob> {
  await document.fonts.ready;
  const s = getSettings();
  const colors = readerColors();
  const rtl = isRtlText(o.text);
  const W = 1080, pad = 84;
  const el = document.querySelector('.reader') as HTMLElement | null;
  const cs = el ? getComputedStyle(el) : null;
  const family = (rtl ? cs?.getPropertyValue('--r-font-rtl') : cs?.getPropertyValue('--r-font'))?.trim() || (rtl ? "'Uthman TN1'" : "'Lora'");
  const fontSize = rtl ? 46 : 40;
  const lh = Math.round(fontSize * (rtl ? 1.9 : 1.6));

  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `${fontSize}px ${family}`;
  const lines = wrap(measure, o.text.trim(), W - pad * 2);
  const maxLines = 40;
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] += ' …';
  const plain = (o.style ?? s.snapStyle) === 'plain';
  if (plain) {
    // A plain snap: just the passage on the page colour, as if screenshotted.
    const H = pad * 2 + shown.length * lh - (lh - fontSize);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = colors.fg; ctx.font = `${fontSize}px ${family}`;
    ctx.textBaseline = 'alphabetic';
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = rtl ? 'right' : 'left';
    let y = pad + fontSize;
    for (const line of shown) { ctx.fillText(line, rtl ? W - pad : pad, y); y += lh; }
    return canvasToBlob(c, 'image/png');
  }
  const H = pad * 2 + 110 + shown.length * lh + 120;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H);
  // subtle frame
  ctx.strokeStyle = colors.rule; ctx.lineWidth = 2; ctx.strokeRect(pad / 2, pad / 2, W - pad, H - pad);
  // opening mark
  ctx.fillStyle = colors.dim; ctx.font = `120px ${family}`; ctx.textBaseline = 'alphabetic';
  ctx.textAlign = rtl ? 'right' : 'left';
  ctx.fillText(rtl ? '«' : '“', rtl ? W - pad : pad, pad + 70);
  // text
  ctx.fillStyle = colors.fg; ctx.font = `${fontSize}px ${family}`;
  ctx.direction = rtl ? 'rtl' : 'ltr';
  let y = pad + 110 + fontSize;
  for (const line of shown) { ctx.fillText(line, rtl ? W - pad : pad, y); y += lh; }
  // footer: title · author · app
  ctx.direction = isRtlText(o.title) ? 'rtl' : 'ltr';
  ctx.textAlign = isRtlText(o.title) ? 'right' : 'left';
  ctx.fillStyle = colors.fg; ctx.font = `600 30px ${family}`;
  ctx.fillText(o.title, isRtlText(o.title) ? W - pad : pad, H - pad - 34);
  ctx.fillStyle = colors.dim; ctx.font = `26px ${family}`;
  if (o.author) ctx.fillText(o.author, isRtlText(o.title) ? W - pad : pad, H - pad + 2);
  ctx.direction = 'ltr'; ctx.textAlign = isRtlText(o.title) ? 'left' : 'right';
  ctx.font = `24px Inter, system-ui, sans-serif`;
  ctx.fillText(o.appName, isRtlText(o.title) ? pad : W - pad, H - pad - 10);
  return canvasToBlob(c, 'image/png');
}

/** Preview a rendered snapshot with Save / Share buttons. */
export function showSnapshot(blob: Blob, filename: string, title: string): void {
  const sheet = openSheet(t('textAsImage'), t('close'));
  sheet.body.style.fontFamily = 'var(--font-ui)';
  const url = URL.createObjectURL(blob);
  const img = h('img', { class: 'snap-preview', alt: title });
  img.src = url;
  sheet.body.appendChild(img);
  const styleBtn = h('button', { class: 'btn small' }, t(getSettings().snapStyle === 'plain' ? 'snapCard' : 'snapPlain'));
  const save = h('button', { class: 'btn small primary' }, t('saveImage'));
  const share = h('button', { class: 'btn small' }, t('shareText'));
  save.addEventListener('click', () => { void saveImage(blob, filename); sheet.close(); });
  share.addEventListener('click', () => { void shareFile(blob, filename, title); sheet.close(); });
  styleBtn.addEventListener('click', () => { updateSettings({ snapStyle: getSettings().snapStyle === 'plain' ? 'card' : 'plain' }); sheet.close(); document.dispatchEvent(new CustomEvent('kr:resnap')); });
  sheet.actions.append(styleBtn, share, save);
  sheet.el.addEventListener('transitionend', () => { if (!sheet.el.isConnected) URL.revokeObjectURL(url); });
}
