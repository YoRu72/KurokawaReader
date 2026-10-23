// Floating toolbar that appears over selected text: Copy · Search · Define ·
// Translate · Highlight · Speak.
import { joinLine, cleanPdfText, attachMarks, type LinePiece } from '../pdftext';
import { h, icon, toast, openSheet } from './dom';
import { t, isRtlText } from '../i18n';
import { getSettings } from '../settings';
import { showDefinition, showTranslation, showReadings } from './lookup';
import { shareText, translateWithSystem, hasSystemText } from './share';

export interface SelectionActions {
  search(text: string): void;
  highlight(range: Range, text: string, color: HighlightColor): void;
  note(range: Range, text: string): void;
  speak(text: string): void;
  textImage(text: string): void;
  /** Language of the book the selection is in (helps choose furigana vs pinyin). */
  lang?(): string | undefined;
}

export type HighlightColor = 'amber' | 'rose' | 'mint' | 'sky' | 'violet';
export const HIGHLIGHT_COLORS: [HighlightColor, string][] = [['amber', 'var(--hl-amber, #e5c56b)'], ['rose', 'var(--hl-rose, #e58a8a)'], ['mint', 'var(--hl-mint, #7fcfa5)'], ['sky', 'var(--hl-sky, #7fb4e5)'], ['violet', 'var(--hl-violet, #b9a3e8)']];


/**
 * The selected text, read the way a reader expects it rather than the way the
 * DOM happens to be ordered. In a PDF text layer the spans are absolutely
 * positioned pieces of lines; joining them with the browser's default rules
 * drops line breaks, glues words together and, for Arabic, mixes visual and
 * logical order. Here the pieces are taken in content order, line breaks are
 * kept, and Arabic runs are normalised (presentation forms → letters, reversed
 * runs turned round).
 */
export function selectionText(sel: Selection): string {
  if (sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0);
  const anc = range.commonAncestorContainer;
  const layer = (anc.nodeType === 1 ? (anc as Element) : anc.parentElement)?.closest('.textLayer, .pdf-page, .pdf-inner, .pdf-scroll');
  if (!layer) return sel.toString();
  const spans = Array.from(layer.querySelectorAll<HTMLElement>('.textLayer > span')).filter((el) => el.firstChild && range.intersectsNode(el));
  // Geometry decides the order: pieces are grouped into lines by their vertical position, and
  // within a line read right-to-left when the line is mostly Arabic/Hebrew, else left-to-right.
  // Pieces are joined by the gap between them (not with a space each): PDFs made by Word and the
  // like cut Arabic with harakat into many small pieces, often one letter or one mark each.
  type Piece = LinePiece & { y: number };
  const pieces: Piece[] = [];
  for (const el of spans) {
    const node = el.firstChild!;
    let text = el.textContent ?? '';
    if (node === range.startContainer && node === range.endContainer) text = text.slice(range.startOffset, range.endOffset);
    else if (node === range.startContainer) text = text.slice(range.startOffset);
    else if (node === range.endContainer) text = text.slice(0, range.endOffset);
    text = cleanPdfText(text);
    if (/^\u2009+$/.test(text)) text = '\u2009'; // a real space the PDF draws (see scripts/patch-pdfjs.mjs)
    else if (!text.trim()) continue;
    const rc = el.getBoundingClientRect();
    pieces.push({ text, l: rc.left, r: rc.right, y: rc.top + rc.height / 2, h: rc.height || 10 });
  }
  const kept = attachMarks(pieces);
  kept.sort((a, b) => a.y - b.y);
  const lines: Piece[][] = [];
  for (const p of kept) { const cur = lines[lines.length - 1]; if (cur && Math.abs(cur[0].y - p.y) < Math.max(cur[0].h, p.h) * 0.6) cur.push(p); else lines.push([p]); }
  const out = lines.map((line) => joinLine(line).text).filter(Boolean).join('\n');
  return fixArabic(out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' '));
}

const COMMON_AR = /\b(في|من|على|إلى|الى|أن|ان|كان|هذا|هذه|التي|الذي|ما|لا|قال|عن|ثم|أو|او|كل|بين|عند|حتى|إذا|اذا|لم|قد|هو|هي|ذلك|بعد|قبل|غير|مع|يا|إن|لكن)\b/g;
/** Arabic text as a PDF exposes it is often in presentation forms or reversed per line; put it right. */
export function fixArabic(text: string): string {
  if (!/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) return text;
  // Presentation forms (ﻻ, ﺑ …) → plain letters; tatweel out; ligature lam-alef into two letters.
  let t = text.normalize('NFKC').replace(/\u0640/g, '');
  return t.split('\n').map((line) => {
    if (!/[\u0600-\u06FF]/.test(line)) return line;
    const rev = reverseArabicRuns(line);
    const hits = (s: string) => (s.match(COMMON_AR) ?? []).length;
    const a = hits(line), b = hits(rev);
    return b > a ? rev : line;
  }).join('\n');
}
function reverseArabicRuns(line: string): string {
  // Reverse the order of words and the letters inside each Arabic run, leaving digits and Latin alone.
  const words = line.split(' ');
  return words.reverse().map((w) => (/^[\u0600-\u06FF\s؛،؟.!:«»()]+$/.test(w) ? [...w].reverse().map((c) => ({ '(': ')', ')': '(', '«': '»', '»': '«' }[c] ?? c)).join('') : w)).join(' ');
}

export function attachSelectionToolbar(scope: HTMLElement, actions: SelectionActions): () => void {
  let bar: HTMLElement | null = null;
  let timer: number | undefined;
  let touching = false;
  const touch = matchMedia('(pointer: coarse)').matches;
  // The current selection, refreshed every time it changes while the bar is up — so a
  // selection the reader extends with the handles is what the buttons act on.
  const state = { text: '', range: null as Range | null };

  let suppressed = false; // while the More sheet is up the toolbar stays away
  let lastAuto = '';
  const hide = () => { bar?.remove(); bar = null; };

  const build = () => {
    const act = (fn: () => void) => (e: Event) => { e.preventDefault(); e.stopPropagation(); fn(); };
    const cur = () => ({ text: state.text, range: state.range?.cloneRange() ?? document.createRange() });
    const btn = (name: string, label: string, fn: () => void) => h('button', { type: 'button', onclick: act(fn) }, icon(name), h('span', null, label));
    const colors = h('div', { class: 'sel-colors' }, ...HIGHLIGHT_COLORS.map(([id, hex]) => h('button', { type: 'button', class: 'dot', title: t('highlight'), 'aria-label': `${t('highlight')} ${id}`, style: { background: hex }, onclick: act(() => { const c = cur(); actions.highlight(c.range, c.text, id); document.getSelection()?.removeAllRanges(); hide(); }) })));
    const row = h('div', { class: 'sel-row' },
      btn('copy', t('copySelected'), async () => { const { text } = cur(); try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { document.execCommand('copy'); toast(t('copied')); } hide(); }),
      btn('search', t('searchSelected'), () => { actions.search(cur().text); hide(); }),
      btn('define', t('defineSelected'), () => { showDefinition(cur().text); hide(); }),
      btn('translate', t('translateSelected'), () => { showTranslation(cur().text); hide(); }),
      btn('type', t('readings'), () => { showReadings(cur().text, actions.lang?.()); hide(); }),
      btn('note', t('note'), () => { const c = cur(); actions.note(c.range, c.text); document.getSelection()?.removeAllRanges(); hide(); }),
      btn('images', t('textAsImage'), () => { actions.textImage(cur().text); hide(); }),
      btn('more', t('more'), () => { hide(); suppressed = true; moreSheet(cur().text, actions, () => { suppressed = false; }); }),
    );
    const el = h('div', { class: 'sel-toolbar', role: 'toolbar' }, colors, row);
    el.addEventListener('mousedown', (e) => e.preventDefault());
    return el;
  };

  const show = () => {
    if (suppressed) { hide(); return; }
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hide(); return; }
    const range = sel.getRangeAt(0);
    if (!scope.contains(range.commonAncestorContainer)) { hide(); return; }
    const text = selectionText(sel).trim();
    if (!text) { hide(); return; }
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { hide(); return; }
    if (rect.bottom < 0 || rect.top > window.innerHeight) { hide(); return; }
    state.text = text; state.range = range.cloneRange();
    if (!bar) { bar = build(); document.body.appendChild(bar); }
    // The Reading button only matters for Chinese / Japanese text.
    const rb = bar.querySelector<HTMLElement>('.sel-row button:nth-child(5)'); if (rb) rb.hidden = !/[\u3040-\u30ff\u3400-\u9fff]/.test(text);
    // Automatic readings: a popover with furigana / pinyin as soon as CJK text is selected.
    if (getSettings().autoReadings && /[\u3040-\u30ff\u3400-\u9fff]/.test(text) && text.length <= 400 && text !== lastAuto) { lastAuto = text; showAutoReadings(text, actions.lang?.(), range); }
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let x = rect.left + rect.width / 2;
    x = Math.max(bw / 2 + 8, Math.min(window.innerWidth - bw / 2 - 8, x));
    // Above the selection (clear of the handles); below it only when there is no room above.
    let y = rect.top - bh - (touch ? 28 : 10);
    if (y < 64) y = rect.bottom + (touch ? 28 : 10);
    y = Math.max(64, Math.min(window.innerHeight - bh - 20, y));
    bar.style.left = `${x}px`;
    bar.style.top = `${y}px`;
  };

  // On touch screens wait until the finger lifts and the selection stops changing,
  // so the toolbar appears once, over the final selection, instead of jumping around.
  const shown = () => { show(); if (bar) bar.style.opacity = ''; };
  const schedule = () => { window.clearTimeout(timer); if (touch && touching) return; timer = window.setTimeout(shown, touch ? 450 : 180); };
  const onChange = () => { if (touch && bar) { const sel = document.getSelection(); if (sel && !sel.isCollapsed) bar.style.opacity = '0'; } schedule(); };
  const onTouchStart = () => { touching = true; window.clearTimeout(timer); };
  const onTouchEnd = () => { touching = false; schedule(); };
  const onScroll = () => { if (bar) show(); };
  document.addEventListener('selectionchange', onChange);
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true });
  scope.addEventListener('scroll', onScroll, { passive: true, capture: true });
  return () => {
    document.removeEventListener('selectionchange', onChange);
    document.removeEventListener('touchstart', onTouchStart);
    document.removeEventListener('touchend', onTouchEnd); document.removeEventListener('touchcancel', onTouchEnd);
    scope.removeEventListener('scroll', onScroll, true); hide();
  };
}

function moreSheet(text: string, actions: SelectionActions, onClose?: () => void): void {
  const s = openSheet(t('more'), t('close'));
  if (onClose) { const obs = new MutationObserver(() => { if (!s.el.isConnected) { obs.disconnect(); onClose(); } }); obs.observe(document.body, { childList: true }); }
  s.body.style.fontFamily = 'var(--font-ui)';
  s.body.style.fontSize = '14px';
  s.body.append(h('p', { class: 'src', dir: 'auto' }, text.length > 200 ? text.slice(0, 200) + '…' : text));
  const item = (name: string, label: string, fn: () => void) => h('li', null, h('button', { type: 'button', onclick: () => { s.close(); fn(); } }, icon(name), label));
  const q = encodeURIComponent(text.slice(0, 300));
  const ar = isRtlText(text);
  s.body.append(h('ul', { class: 'plain-list' },
    hasSystemText() ? item('translate', t('systemTranslate'), () => void translateWithSystem(text)) : null,
    item('external', t('shareText'), () => void shareText(text)),
    item('speak', t('speakSelected'), () => actions.speak(text)),
    item('search', t('searchWeb'), () => window.open(`https://duckduckgo.com/?q=${q}`, '_blank', 'noopener')),
    item('define', t('wikipedia'), () => window.open(`https://${ar ? 'ar' : 'en'}.wikipedia.org/w/index.php?search=${q}`, '_blank', 'noopener')),
  ));
}

/** Wrap every text node intersecting `range` in a <mark>. Returns the marks. */
export function wrapRange(range: Range, cls: string, color: string, id: string): HTMLElement[] {
  const marks: HTMLElement[] = [];
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root.nodeType === 3 ? root.parentNode! : root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (range.intersectsNode(n) && n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  for (const node of nodes) {
    let start = 0, end = node.length;
    if (node === range.startContainer) start = range.startOffset;
    if (node === range.endContainer) end = range.endOffset;
    if (start >= end) continue;
    const target = node.splitText(start);
    target.splitText(end - start);
    const mark = document.createElement('mark');
    mark.className = cls;
    mark.dataset.color = color;
    mark.dataset.hl = id;
    target.parentNode!.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }
  return marks;
}

/** Find `text` inside `root` (whitespace-insensitive) and return a Range, or null. */
export function findTextRange(root: Element, text: string): Range | null {
  const needle = text.replace(/\s+/g, ' ').trim();
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let full = '';
  let node: Node | null;
  while ((node = walker.nextNode())) {
    nodes.push(node as Text);
    starts.push(full.length);
    full += node.textContent ?? '';
  }
  // Build a whitespace-collapsed copy with an index map back to `full`.
  const collapsed: string[] = []; const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < full.length; i++) {
    const ch = full[i];
    if (/\s/.test(ch)) { if (prevSpace) continue; prevSpace = true; collapsed.push(' '); map.push(i); }
    else { prevSpace = false; collapsed.push(ch); map.push(i); }
  }
  const idx = collapsed.join('').indexOf(needle);
  if (idx < 0) return null;
  const s = map[idx], e = map[idx + needle.length - 1] + 1;
  const locate = (pos: number, isEnd: boolean) => {
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] < pos || (isEnd && starts[m] === pos)) lo = m; else hi = m - 1; }
    return { node: nodes[lo], offset: pos - starts[lo] };
  };
  const a = locate(s, false), b = locate(e, true);
  const range = document.createRange();
  range.setStart(a.node, Math.min(a.offset, a.node.length));
  range.setEnd(b.node, Math.min(b.offset, b.node.length));
  return range;
}

/** A floating ruby popover above the selection (auto-readings setting). Disappears when the selection changes. */
let autoPop: HTMLElement | null = null;
function showAutoReadings(text: string, lang: string | undefined, range: Range): void {
  autoPop?.remove();
  const pop = h('div', { class: 'readings-pop', lang: /[\u3040-\u30ff]/.test(text) ? 'ja' : 'zh' }, h('div', { class: 'spinner', style: { width: '16px', height: '16px' } }));
  autoPop = pop; document.body.appendChild(pop);
  const place = () => { const r = range.getBoundingClientRect(); const w = pop.offsetWidth; let x = r.left + r.width / 2 - w / 2; x = Math.max(8, Math.min(window.innerWidth - w - 8, x)); pop.style.left = `${x}px`; pop.style.top = `${Math.max(8, r.bottom + 12)}px`; };
  place();
  void import('../readings').then((m) => m.readingsHtml(text, lang)).then((html) => { if (autoPop !== pop) return; if (!html) { pop.remove(); return; } pop.innerHTML = html; place(); }).catch(() => pop.remove());
  const onChange = () => { const sel = document.getSelection(); if (!sel || sel.isCollapsed || sel.toString().trim() !== text) { pop.remove(); if (autoPop === pop) autoPop = null; document.removeEventListener('selectionchange', onChange); } };
  setTimeout(() => document.addEventListener('selectionchange', onChange), 50);
}
