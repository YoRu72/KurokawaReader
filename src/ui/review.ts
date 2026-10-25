// The reader's review of a book: stars and a few words of their own, kept with the book, and made into a
// picture to share — the cover, the title, the stars and the words, in one of several looks.
import { h, icon, openSheet, toast, coverColors } from './dom';
import { t, isRtlText, formatDuration, localDigits, countPages, countChapters, dateLocale, formatHijri, calendarPref } from '../i18n';
import { db, type Book } from '../db';
import { coverUrl } from '../library';
import { canvasToBlob, saveImage, shareFile, copyImage } from './share';

export type CardStyle = 'paper' | 'night' | 'cover' | 'minimal' | 'ink';
const STYLES: CardStyle[] = ['paper', 'night', 'cover', 'minimal', 'ink'];
type Palette = { bg: string; bg2: string; fg: string; dim: string; star: string; starOff: string; rule: string; font: 'serif' | 'sans' };
const PALETTES: Record<CardStyle, Palette> = {
  paper: { bg: '#f4ecdc', bg2: '#ead9b8', fg: '#2b2418', dim: '#7a6a4f', star: '#c8901c', starOff: '#d9ccb2', rule: '#d8c8a6', font: 'serif' },
  night: { bg: '#15171c', bg2: '#22262e', fg: '#eceef2', dim: '#9aa0ab', star: '#f2c14e', starOff: '#3a3f49', rule: '#2e333c', font: 'serif' },
  cover: { bg: '#1a1a1a', bg2: '#1a1a1a', fg: '#ffffff', dim: 'rgba(255,255,255,.72)', star: '#ffd166', starOff: 'rgba(255,255,255,.3)', rule: 'rgba(255,255,255,.25)', font: 'sans' },
  minimal: { bg: '#ffffff', bg2: '#ffffff', fg: '#111111', dim: '#6b6b6b', star: '#111111', starOff: '#d4d4d4', rule: '#e6e6e6', font: 'sans' },
  ink: { bg: '#0f3d3e', bg2: '#145052', fg: '#f3efe6', dim: '#b8c9c6', star: '#f4d35e', starOff: '#2d6263', rule: '#2d6263', font: 'serif' },
};

const fontOf = (kind: 'serif' | 'sans', rtl: boolean, el: HTMLElement | null) => {
  const cs = el ? getComputedStyle(el) : null;
  const get = (v: string, d: string) => cs?.getPropertyValue(v).trim() || d;
  if (rtl) return get('--r-font-rtl', "'Uthman TN1', 'Noto Naskh Arabic', serif");
  return kind === 'serif' ? get('--r-font', "'Lora', serif") : 'Inter, system-ui, sans-serif';
};

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/\r/g, '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const w of words) { const test = line ? `${line} ${w}` : w; if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test; }
    lines.push(line);
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number): void {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r); ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r * 0.46 : r; ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
  ctx.closePath(); ctx.fill();
}

export interface ReviewCardOptions { book: Book; rating: number; text: string; style: CardStyle; showCover: boolean; showDate: boolean; showTime: boolean; showPages: boolean; showChapters: boolean; chapters?: number; dateKind?: 'gregory' | 'hijri' | 'both' }

/** The review as a picture (1080 px wide; as tall as its words need). */
export async function renderReviewCanvas(o: ReviewCardOptions): Promise<HTMLCanvasElement> {
  const P = PALETTES[o.style];
  const reader = document.querySelector('.reader') as HTMLElement | null;
  const rtlTitle = isRtlText(o.book.title), rtlText = isRtlText(o.text || o.book.title);
  const titleFont = fontOf(P.font, rtlTitle, reader), textFont = fontOf(P.font, rtlText, reader);
  for (const f of [titleFont, textFont]) if (!document.fonts.check(`16px ${f}`)) { try { await document.fonts.ready; } catch { /* fine */ } }

  const W = 1080, pad = 88;
  let cover: ImageBitmap | null = null;
  if (o.showCover && o.book.cover) { try { cover = await createImageBitmap(o.book.cover); } catch { cover = null; } }
  const coverW = 300, coverH = cover ? Math.round(coverW * (cover.height / cover.width)) : 420;
  const measure = document.createElement('canvas').getContext('2d')!;
  const bodySize = 38, bodyLh = Math.round(bodySize * 1.65);
  measure.font = `${bodySize}px ${textFont}`;
  const lines = wrap(measure, o.text.trim(), W - pad * 2);
  const shown = lines.slice(0, 40); if (lines.length > 40) shown[39] += ' …';
  const textH = shown.length ? shown.length * bodyLh + 30 : 0;
  const headH = Math.max(o.showCover ? coverH : 0, 300);
  const footH = (o.showDate || o.showTime || o.showPages || o.showChapters) ? 70 : 0;
  const H = pad + headH + 60 + textH + footH + pad;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;

  // The ground.
  const [c1, c2] = coverColors(o.book.title);
  if (o.style === 'cover') {
    if (cover) { ctx.save(); ctx.filter = 'blur(60px) brightness(.45) saturate(1.3)'; const s = Math.max(W / cover.width, H / cover.height) * 1.3; ctx.drawImage(cover, (W - cover.width * s) / 2, (H - cover.height * s) / 2, cover.width * s, cover.height * s); ctx.restore(); }
    else { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, c1); g.addColorStop(1, c2); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, W, H); }
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, P.bg); g.addColorStop(1, P.bg2); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (o.style === 'paper') { ctx.save(); ctx.globalAlpha = 0.5; for (let i = 0; i < (W * H) / 220; i++) { const v = Math.random() > 0.5 ? 255 : 0; ctx.fillStyle = `rgba(${v},${v},${v},${0.05 + Math.random() * 0.07})`; ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2); } ctx.restore(); }
    if (o.style === 'minimal') { ctx.strokeStyle = P.rule; ctx.lineWidth = 3; ctx.strokeRect(pad / 2, pad / 2, W - pad, H - pad); }
  }

  // The head: the cover on the title's side, the title, the author, the stars.
  const rtl = rtlTitle;
  const coverX = rtl ? W - pad - coverW : pad;
  const textX = rtl ? (o.showCover ? coverX - 48 : W - pad) : (o.showCover ? coverX + coverW + 48 : pad);
  const textW = W - pad * 2 - (o.showCover ? coverW + 48 : 0);
  if (o.showCover) {
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 12;
    roundRect(ctx, coverX, pad, coverW, coverH, 14); ctx.clip();
    if (cover) ctx.drawImage(cover, coverX, pad, coverW, coverH);
    else { const g = ctx.createLinearGradient(coverX, pad, coverX + coverW, pad + coverH); g.addColorStop(0, c1); g.addColorStop(1, c2); ctx.fillStyle = g; ctx.fillRect(coverX, pad, coverW, coverH); ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = `600 30px ${titleFont}`; ctx.textAlign = 'center'; ctx.direction = rtl ? 'rtl' : 'ltr'; wrap(ctx, o.book.title, coverW - 40).slice(0, 6).forEach((l, i) => ctx.fillText(l, coverX + coverW / 2, pad + 70 + i * 40)); }
    ctx.restore();
  }
  ctx.direction = rtl ? 'rtl' : 'ltr'; ctx.textAlign = rtl ? 'right' : 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = P.fg; ctx.font = `700 50px ${titleFont}`;
  let y = pad + 56;
  for (const l of wrap(ctx, o.book.title, textW).slice(0, 3)) { ctx.fillText(l, textX, y); y += 60; }
  if (o.book.author) { ctx.fillStyle = P.dim; ctx.font = `32px ${titleFont}`; ctx.fillText(o.book.author, textX, y + 4); y += 52; }
  y += 30;
  const r = 24, gap = 60;
  for (let i = 0; i < 5; i++) { ctx.fillStyle = i < o.rating ? P.star : P.starOff; drawStar(ctx, rtl ? textX - r - i * gap : textX + r + i * gap, y + 4, r); }
  if (o.rating) { ctx.fillStyle = P.dim; ctx.font = `600 30px Inter, system-ui, sans-serif`; ctx.direction = 'ltr'; ctx.textAlign = rtl ? 'right' : 'left'; ctx.fillText(`${localDigits(String(o.rating))}/${localDigits("5")}`, rtl ? textX - 5 * gap - 12 : textX + 5 * gap + 12, y + 14); }

  // The words.
  let ty = pad + headH + 60;
  if (shown.length) {
    ctx.strokeStyle = P.rule; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pad, ty - 30); ctx.lineTo(W - pad, ty - 30); ctx.stroke();
    ctx.direction = rtlText ? 'rtl' : 'ltr'; ctx.textAlign = rtlText ? 'right' : 'left';
    ctx.fillStyle = P.dim; ctx.font = `${bodySize * 2.2}px ${textFont}`; ctx.fillText(rtlText ? '«' : '“', rtlText ? W - pad : pad, ty + 22);
    ctx.fillStyle = P.fg; ctx.font = `${bodySize}px ${textFont}`;
    ty += bodyLh + 10;
    for (const l of shown) { ctx.fillText(l, rtlText ? W - pad - 50 : pad + 50, ty); ty += bodyLh; }
  }

  // The foot: when, and how the book was read — the reader's own numbers, nothing of the app's.
  if (footH) {
    const bits: { text: string; sep?: string }[] = [];
    const now = new Date(); const kind = o.dateKind ?? calendarPref();
    const civil = now.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' });
    const hijri = formatHijri(now, { day: 'numeric', month: 'long', year: 'numeric' });
    if (o.showDate) { if (kind !== 'hijri') bits.push({ text: civil }); if (kind !== 'gregory') bits.push({ text: hijri, sep: '•' }); }
    if (o.showTime && o.book.stats?.ms) bits.push({ text: formatDuration(o.book.stats.ms) });
    if (o.showPages && o.book.pageCount) bits.push({ text: countPages(o.book.pageCount) });
    if (o.showChapters && o.chapters) bits.push({ text: countChapters(o.chapters) });
    // (Each piece drawn on its own, in its own direction: a date's digits and slashes would scramble inside a
    // right-to-left run on a canvas.)
    ctx.fillStyle = P.dim; ctx.font = `26px Inter, system-ui, sans-serif`;
    // Word by word, each word upright in its own script, the words of a right-to-left piece laid right to left:
    // the canvas is given no run to reorder, so «25 أكتوبر 2026» keeps its day on the right and its year on the left.
    // (The foot runs the way its own words do — the interface's language — whatever the title's script.)
    const rtl = isRtlText(bits.map((b) => b.text).join(' '));
    let x = rtl ? W - pad : pad; const gap = 14, space = ctx.measureText(' ').width;
    const pieces = bits.flatMap((bit, i) => (i ? [bit.sep ?? '·', bit.text] : [bit.text]));
    ctx.direction = 'ltr';
    for (const piece of pieces) {
      const pieceRtl = /[\u0600-\u06ff]/.test(piece);
      const words = piece.split(/\s+/).filter(Boolean); const widths = words.map((w) => ctx.measureText(w).width);
      const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
      // The piece's own edge on the card's side, then its words from there in its own direction.
      let wx = pieceRtl ? (rtl ? x : x + total) : (rtl ? x - total : x);
      ctx.textAlign = pieceRtl ? 'right' : 'left';
      words.forEach((word, i) => { ctx.fillText(word, wx, H - pad + 4); wx += pieceRtl ? -(widths[i] + space) : widths[i] + space; });
      x += rtl ? -(total + gap) : total + gap;
    }
  }
  cover?.close();
  return c;
}

/** Rate a book and write a few words; make a picture of it. */
export function reviewSheet(book: Book, onChange: () => void): void {
  const s = openSheet(t('reviewBook'), t('close'), { stack: true });
  s.body.style.fontFamily = 'var(--font-ui)';
  let rating = book.rating ?? 0; let text = book.review ?? '';
  const stars = h('div', { class: 'stars big', role: 'radiogroup', 'aria-label': t('rating') });
  const paint = () => stars.replaceChildren(...[1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', class: 'star' + (rating >= n ? ' on' : ''), 'aria-label': `${n}`, onclick: () => { rating = rating === n ? 0 : n; paint(); } }, '★')));
  paint();
  const words = h('textarea', { class: 'review-text', rows: 5, placeholder: t('reviewPlaceholder'), dir: 'auto' }) as HTMLTextAreaElement; words.value = text;
  words.addEventListener('input', () => { text = words.value; });
  const url = coverUrl(book);
  s.body.append(
    h('div', { class: 'review-head' }, url ? h('img', { class: 'review-cover', src: url, alt: '' }) : null, h('div', null, h('b', { dir: 'auto' }, book.title), book.author ? h('div', { class: 'src', dir: 'auto' }, book.author) : null, stars)),
    words);
  const save = async () => {
    const at = Date.now();
    await db.updateBook(book.id, (b) => { if (rating) b.rating = rating; else delete b.rating; b.ratingAt = at; if (text.trim()) b.review = text.trim(); else delete b.review; b.reviewAt = at; });
    if (rating) book.rating = rating; else delete book.rating; book.ratingAt = at; if (text.trim()) book.review = text.trim(); else delete book.review; book.reviewAt = at;
    onChange();
    void import('./track').then((m) => m.pushStars(book, rating));
  };
  s.actions.append(
    h('button', { class: 'btn small tonal', type: 'button', onclick: async () => { await save(); reviewCardSheet(book); } }, icon('images'), t('reviewCard')),
    h('button', { class: 'btn small primary', type: 'button', onclick: async () => { await save(); s.close(); toast(t('reviewSaved')); } }, icon('check'), t('done')));
}

/** The picture of a review, in the look the reader picks, with the cover, the date and the numbers to show or not. */
export function reviewCardSheet(book: Book): void {
  const sheet = openSheet(t('reviewCard'), t('close'), { stack: true });
  sheet.body.style.fontFamily = 'var(--font-ui)';
  const KEY = 'kr.reviewCard';
  let opts: Omit<ReviewCardOptions, 'book' | 'rating' | 'text' | 'chapters'> = { style: 'paper', showCover: true, showDate: true, showTime: false, showPages: false, showChapters: false, dateKind: calendarPref() };
  try { opts = { ...opts, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<typeof opts>) }; } catch { /* defaults */ }
  // The chapter count: the reader's own number when set, else what the contents list says (read once).
  let tocCount = 0;
  void import('../views/book').then((m) => m.outlineOf(book)).then((o) => { tocCount = o.toc.length; chaptersIn.placeholder = tocCount ? String(tocCount) : ''; if (opts.showChapters) void render(); });
  const holder = h('div', { class: 'snap-holder' });
  let canvas: HTMLCanvasElement | null = null; let blob: Blob | null = null; let seq = 0;
  const render = async () => {
    const my = ++seq; blob = null;
    try { localStorage.setItem(KEY, JSON.stringify(opts)); } catch { /* private mode */ }
    const c = await renderReviewCanvas({ book, rating: book.rating ?? 0, text: book.review ?? '', chapters: book.chapters ?? tocCount, ...opts });
    if (my !== seq) return;
    c.className = 'snap-preview'; holder.replaceChildren(c); canvas = c;
  };
  const chips = h('div', { class: 'scan-filters', role: 'radiogroup', 'aria-label': t('cardStyle') });
  const drawChips = () => chips.replaceChildren(...STYLES.map((st) => h('button', { type: 'button', role: 'radio', class: 'chip small' + (opts.style === st ? ' on' : ''), 'aria-checked': String(opts.style === st), onclick: () => { opts.style = st; drawChips(); void render(); } }, h('span', null, t(`cardStyle_${st}` as 'cardStyle_paper')))));
  drawChips();
  const check = (label: string, key: 'showCover' | 'showDate' | 'showTime' | 'showPages' | 'showChapters') => { const input = h('input', { type: 'checkbox', checked: opts[key] }) as HTMLInputElement; input.addEventListener('change', () => { opts[key] = input.checked; void render(); }); return h('label', { class: 'chip small check' }, input, h('span', null, label)); };
  // The reader's words, written or changed here as well, and the chapter count they decide on.
  const words = h('textarea', { class: 'review-text', rows: 3, placeholder: t('reviewPlaceholder'), dir: 'auto' }) as HTMLTextAreaElement; words.value = book.review ?? '';
  let wordsTimer = 0;
  words.addEventListener('input', () => { window.clearTimeout(wordsTimer); wordsTimer = window.setTimeout(async () => { const text = words.value.trim(); const at = Date.now(); if (text) book.review = text; else delete book.review; book.reviewAt = at; await db.updateBook(book.id, (b) => { if (text) b.review = text; else delete b.review; b.reviewAt = at; }); void render(); }, 400); });
  const chaptersIn = h('input', { type: 'number', min: '0', inputmode: 'numeric', value: book.chapters ? String(book.chapters) : '', style: { width: '72px' }, 'aria-label': t('cardChapters') }) as HTMLInputElement;
  chaptersIn.addEventListener('change', async () => { const n = Math.max(0, Math.round(Number(chaptersIn.value) || 0)); const at = Date.now(); if (n) book.chapters = n; else delete book.chapters; book.chaptersAt = at; await db.updateBook(book.id, (b) => { if (n) b.chapters = n; else delete b.chapters; b.chaptersAt = at; }); void import('../sync').then((m) => m.scheduleSync()).catch(() => undefined); void render(); });
  sheet.body.append(chips,
    h('div', { class: 'scan-filters' }, check(t('cardShowCover'), 'showCover'), check(t('cardShowDate'), 'showDate'),
      (() => { const sel = h('select', { 'aria-label': t('calendarKind') }, ...([['gregory', t('calGregory')], ['hijri', t('calHijri')], ['both', t('calBoth')]] as const).map(([v, l]) => h('option', { value: v, selected: opts.dateKind === v }, l))) as HTMLSelectElement; sel.addEventListener('change', () => { opts.dateKind = sel.value as 'gregory' | 'hijri' | 'both'; void render(); }); return h('label', { class: 'chip small check' }, sel); })(), check(t('cardShowTime'), 'showTime'), check(t('cardShowPages'), 'showPages'), check(t('cardShowChapters'), 'showChapters'),
      h('label', { class: 'chip small check' }, h('span', null, t('cardChapters')), chaptersIn)),
    words, holder);
  void render();
  const png = async () => blob ?? (blob = await canvasToBlob(canvas!, 'image/png'));
  const name = `${book.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'review'} — ${t('reviewCard')}.png`;
  sheet.actions.append(
    h('button', { class: 'btn small', type: 'button', onclick: async () => { if (!canvas) return; if (await copyImage(await png())) toast(t('copied')); } }, icon('copy'), t('copyImage')),
    h('button', { class: 'btn small', type: 'button', onclick: async () => { if (!canvas) return; const b = await png(); void shareFile(b, name, book.title); } }, icon('share'), t('shareImage')),
    h('button', { class: 'btn small primary', type: 'button', onclick: async () => { if (!canvas) return; const b = await png(); void saveImage(b, name); } }, icon('download'), t('saveImage')));
}
