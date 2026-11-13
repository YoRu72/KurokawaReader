// Floating toolbar that appears over selected text: Copy · Search · Define ·
// Translate · Highlight · Speak.
import { isReading, withoutReadings, plainText } from './rubytext';
export { withoutReadings, plainText };
import { joinLine, cleanPdfText, attachMarks, findColumns, isRtlText as rtlByCount, type LinePiece } from '../pdftext';
import { h, icon, toast, openSheet } from './dom';
import { joinColumn } from '../pdfvertical';
import { t, isRtlText, getLang } from '../i18n';
import { getSettings } from '../settings';
import { showDefinition, showTranslation, showReadings } from './lookup';
import { shareText, translateWithSystem, hasSystemText } from './share';

export interface SelectionActions {
  search(text: string): void;
  highlight(range: Range, text: string, color: HighlightColor): void;
  note(range: Range, text: string): void;
  speak(text: string): void;
  textImage(text: string, range?: Range): void;
  /** A text rule made from the words picked: taken out everywhere, or others put in their place. */
  textRule?(text: string): void;
  /** A term added to the translation glossary from the words picked. */
  glossary?(text: string): void;
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
  return pdfRangeText(range) ?? withoutReadings(range) ?? sel.toString();
}

/**
 * The words of a range in a PDF's text layer as they are read (see selectionText), or null when the range is not in
 * one. Each page is read apart, in page order (a range from one page into the next held both pages' pieces as one,
 * and read them mixed). With `flow` the lines are run together as running text — for a passage set again (the
 * picture card), where the PDF's own line ends mean nothing: a line that reaches the far edge of its column goes on
 * into the next (a word cut by a hyphen joined again), and a line that stops short (a paragraph's last, a heading, a
 * centred verse) keeps its break.
 */
export function pdfRangeText(range: Range, flow = false): string | null {
  const anc = range.commonAncestorContainer;
  const el = anc.nodeType === 1 ? (anc as Element) : anc.parentElement;
  const layer = el?.closest('.textLayer, .pdf-page, .pdf-inner, .pdf-scroll');
  if (!layer) return null;
  const layers = layer.classList.contains('textLayer') ? [layer as HTMLElement] : Array.from(layer.querySelectorAll<HTMLElement>('.textLayer')).filter((l) => range.intersectsNode(l));
  let out = '', open = false;
  for (const l of layers) {
    const r = layerText(l, range, flow); if (!r.text) continue;
    out = !out ? r.text : flow && open ? runOn(out, r.text) : `${out}\n${r.text}`;
    open = r.open;
  }
  return out.trim();
}

/** What goes between a line that ran to its column's edge and the next, when they are run together: nothing after a
 *  hyphen cutting a word (the hyphen goes, see runOn) or between letters of a script set without spaces, else a space. */
function flowJoin(before: string, next: string): string {
  const last = before[before.length - 1], first = next[0] ?? '';
  if (last === '\u00ad' || ((last === '-' || last === '\u2010') && /\p{Ll}/u.test(first))) return '';
  if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af\u0e00-\u0e7f\u3001\u3002\uff0c]/.test(last) && /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af\u0e00-\u0e7f]/.test(first)) return '';
  return ' ';
}
/** The two lines run together: a hyphen that cut the word is taken out with the join. */
function runOn(before: string, next: string): string {
  const j = flowJoin(before, next);
  return j === '' && /[-\u2010\u00ad]$/.test(before) ? before.slice(0, -1) + next : before + j + next;
}

/** One page's text layer: the words of the range on it, in reading order; `open` when its last line ran to the edge. */
function layerText(layer: HTMLElement, range: Range, flow: boolean): { text: string; open: boolean } {
  const all = Array.from(layer.querySelectorAll<HTMLElement>(':scope > span'));
  const spans = all.filter((el) => el.firstChild && range.intersectsNode(el));
  // Columns of vertical writing are laid in reading order already: taken as they come, a paragraph's columns
  // run on and paragraphs end lines.
  const cut = (el: HTMLElement) => {
    const node = el.firstChild!; let text = el.textContent ?? '';
    if (node === range.startContainer && node === range.endContainer) text = text.slice(range.startOffset, range.endOffset);
    else if (node === range.startContainer) text = text.slice(range.startOffset);
    else if (node === range.endContainer) text = text.slice(0, range.endOffset);
    return text;
  };
  const vSpans = spans.filter((el) => el.dataset.v);
  let vText = '';
  for (const el of vSpans) vText = joinColumn(vText, cut(el)) + (el.dataset.br ? '\n' : '');
  vText = vText.trim();
  if (vSpans.length === spans.length) return { text: vText, open: false };
  // Geometry decides the order: pieces are grouped into lines by their vertical position, and
  // within a line read right-to-left when the line is mostly Arabic/Hebrew, else left-to-right.
  // Pieces are joined by the gap between them (not with a space each): PDFs made by Word and the
  // like cut Arabic with harakat into many small pieces, often one letter or one mark each.
  type Piece = LinePiece & { y: number; b: number };
  // (A page shown turned: its boxes are read back as the page was written.)
  const rot = Number(layer.dataset.rot ?? 0);
  const place = (rc: DOMRect): { l: number; r: number; y: number; h: number } =>
    rot === 90 ? { l: rc.top, r: rc.bottom, y: -(rc.left + rc.right) / 2, h: rc.width || 10 }
    : rot === 180 ? { l: -rc.right, r: -rc.left, y: -(rc.top + rc.bottom) / 2, h: rc.height || 10 }
    : rot === 270 ? { l: -rc.bottom, r: -rc.top, y: (rc.left + rc.right) / 2, h: rc.width || 10 }
    : { l: rc.left, r: rc.right, y: rc.top + rc.height / 2, h: rc.height || 10 };
  const pieces: Piece[] = [];
  for (const el of spans) {
    if (el.dataset.v) continue;
    const b = Number(el.dataset.b ?? 0);
    let text = cleanPdfText(cut(el));
    if (/^\u2009+$/.test(text)) text = '\u2009'; // a real space the PDF draws (see scripts/patch-pdfjs.mjs)
    else if (!text.trim()) continue;
    pieces.push({ text, ...place(el.getBoundingClientRect()), b });
  }
  // The layer's blocks (a box of text, a column, a label beside a paragraph) are read one after the other as
  // the layer laid them; within a block, lines by their vertical position.
  const blocks = new Map<number, Piece[]>();
  for (const p of pieces) { const list = blocks.get(p.b); if (list) list.push(p); else blocks.set(p.b, [p]); }
  // (The page's own direction, for the lines of both scripts: what the whole layer holds, not the selection.)
  const pageRtl = rtlByCount((layer.closest('.pdf-page') ?? layer).textContent ?? '');
  // (Running text: the edges of each block's column, from all its words on the page — not only those picked.)
  const whole = flow ? all.filter((el) => !el.dataset.v && el.textContent?.trim()).map((el) => ({ b: Number(el.dataset.b ?? 0), ...place(el.getBoundingClientRect()) })) : [];
  const texts: string[] = [];
  let open = false;
  for (const b of [...blocks.keys()].sort((x, y) => x - y)) {
    const kept = attachMarks(blocks.get(b)!);
    kept.sort((a, b2) => a.y - b2.y);
    const lines: Piece[][] = [];
    for (const p of kept) { const cur = lines[lines.length - 1]; if (cur && Math.abs(cur[0].y - p.y) < Math.max(cur[0].h, p.h) * 0.6) cur.push(p); else lines.push([p]); }
    // A block in columns is copied column by column (the right one first on a right-to-left page).
    const cols = findColumns(lines);
    const groups = cols ? cols.map(([a, b2]) => ({ a, b: b2, lines: lines.map((line) => line.filter((p) => (p.l + p.r) / 2 >= a && (p.l + p.r) / 2 < b2)).filter((l) => l.length) })) : [{ a: -Infinity, b: Infinity, lines }];
    if (cols && isRtlText(kept.map((p) => p.text).join(''))) groups.reverse();
    for (const g of groups) {
      if (!flow) { texts.push(...g.lines.map((line) => joinLine(line, pageRtl).text).filter(Boolean)); continue; }
      const mine = whole.filter((w) => w.b === b && (w.l + w.r) / 2 >= g.a && (w.l + w.r) / 2 < g.b);
      const edgeL = Math.min(...mine.map((w) => w.l)), edgeR = Math.max(...mine.map((w) => w.r));
      let text = texts.length ? texts.pop()! : '';
      for (const line of g.lines) {
        const tx = joinLine(line, pageRtl).text; if (!tx) continue;
        text = !text ? tx : open ? runOn(text, tx) : `${text}\n${tx}`;
        const hh = Math.max(...line.map((p) => p.h)), l = Math.min(...line.map((p) => p.l)), r = Math.max(...line.map((p) => p.r));
        open = isRtlText(tx) ? l <= edgeL + hh * 1.2 : r >= edgeR - hh * 1.2;
      }
      texts.push(text);
    }
  }
  const flat = fixArabic(texts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' '));
  return { text: vText ? [flat, vText].filter(Boolean).join('\n') : flat, open: open && !vText };
}

const COMMON_AR = /\b(في|من|على|إلى|الى|أن|ان|كان|هذا|هذه|التي|الذي|ما|لا|قال|عن|ثم|أو|او|كل|بين|عند|حتى|إذا|اذا|لم|قد|هو|هي|ذلك|بعد|قبل|غير|مع|يا|إن|لكن)\b/g;
/** Arabic text as a PDF exposes it is often in presentation forms or reversed per line; put it right. */
export function fixArabic(text: string): string {
  if (!/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) return text;
  // Presentation forms (ﻻ, ﺑ …) → plain letters; tatweel out; ligature lam-alef into two letters.
  // (The tatweel of «هـ», the Hijri year's mark, stays; the kashida of justified lines goes.)
  let t = text.normalize('NFKC').replace(/\u0640+/g, (m, at: number, all: string) => (all[at - 1] === 'ه' && !/[\u0600-\u06ff]/.test(all[at + m.length] ?? '') ? '\u0640' : ''));
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
  // (A selection that was off the screen when it was made — the text still reflowing as a window changes size —: the
  // bar comes once it is on the screen.)
  let offscreen = false;
  const hide = () => { bar?.remove(); bar = null; };

  const build = () => {
    const act = (fn: () => void) => (e: Event) => { e.preventDefault(); e.stopPropagation(); fn(); };
    const cur = () => ({ text: state.text, range: state.range?.cloneRange() ?? document.createRange() });
    const btn = (name: string, label: string, fn: () => void) => h('button', { type: 'button', onclick: act(fn) }, icon(name), h('span', null, label));
    const colors = h('div', { class: 'sel-colors' }, ...HIGHLIGHT_COLORS.map(([id, hex]) => h('button', { type: 'button', class: 'dot', title: t('highlight'), 'aria-label': `${t('highlight')} ${id}`, style: { background: hex }, onclick: act(() => { const c = cur(); actions.highlight(c.range, c.text, id); document.getSelection()?.removeAllRanges(); hide(); }) })));
    const row = h('div', { class: 'sel-row' },
      btn('copy', t('copySelected'), async () => { const { text } = cur(); try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { document.execCommand('copy'); toast(t('copied')); } hide(); }),
      btn('search', t('searchSelected'), () => { actions.search(cur().text); hide(); }),
      btn('define', t('defineSelected'), () => { const c = cur(); showDefinition(c.text, sentenceAround(c.range, c.text)); hide(); }),
      btn('translate', t('translateSelected'), () => { showTranslation(cur().text); hide(); }),
      btn('type', t('readings'), () => { showReadings(cur().text, actions.lang?.()); hide(); }),
      btn('note', t('note'), () => { const c = cur(); actions.note(c.range, c.text); document.getSelection()?.removeAllRanges(); hide(); }),
      btn('images', t('textAsImage'), () => { const c = cur(); actions.textImage(c.text, c.range); hide(); }),
      btn('more', t('more'), () => { hide(); suppressed = true; moreSheet(cur().text, actions, () => { suppressed = false; }); }),
    );
    const el = h('div', { class: 'sel-toolbar', role: 'toolbar' }, colors, row);
    el.addEventListener('mousedown', (e) => e.preventDefault());
    return el;
  };

  const show = () => {
    offscreen = false;
    if (suppressed) { hide(); return; }
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hide(); return; }
    const range = sel.getRangeAt(0);
    if (!scope.contains(range.commonAncestorContainer)) { hide(); return; }
    const text = selectionText(sel).trim();
    if (!text) { hide(); return; }
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { hide(); return; }
    if (rect.bottom < 0 || rect.top > window.innerHeight) { hide(); offscreen = true; return; }
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
  const onScroll = () => { if (bar || offscreen) show(); };
  // (The window resized, full screen, the zoom, a phone's keyboard: the bar placed again over the selection, once the
  // layout has settled in the next frame.)
  let rz = 0;
  const onResize = () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (bar || offscreen) show(); }); };
  const vv = window.visualViewport;
  window.addEventListener('resize', onResize); vv?.addEventListener('resize', onResize);
  // (Copied with the system's own Copy — the keyboard, the phone's menu — the text without its readings.)
  const onCopy = (e: ClipboardEvent) => { const sel = document.getSelection(); if (!sel?.rangeCount || !scope.contains(sel.anchorNode)) return; const clean = withoutReadings(sel.getRangeAt(0)); if (clean === null || !e.clipboardData) return; e.clipboardData.setData('text/plain', clean); e.preventDefault(); };
  document.addEventListener('copy', onCopy);
  document.addEventListener('selectionchange', onChange);
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true });
  scope.addEventListener('scroll', onScroll, { passive: true, capture: true });
  return () => {
    document.removeEventListener('selectionchange', onChange); document.removeEventListener('copy', onCopy);
    document.removeEventListener('touchstart', onTouchStart);
    document.removeEventListener('touchend', onTouchEnd); document.removeEventListener('touchcancel', onTouchEnd);
    scope.removeEventListener('scroll', onScroll, true); hide();
    window.removeEventListener('resize', onResize); vv?.removeEventListener('resize', onResize); cancelAnimationFrame(rz);
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
    actions.textRule ? item('pen', t('textRuleFromSelection'), () => actions.textRule!(text)) : null,
    actions.glossary ? item('define', t('glossaryAddSelection'), () => actions.glossary!(text)) : null,
    // (Shamela's «search in the books»: the words looked for in the texts of the whole library.)
    ar ? item('books', t('searchShamelaTexts'), () => { try { const k = 'kr.src.shamela.filters'; const f = JSON.parse(localStorage.getItem(k) ?? '{}'); localStorage.setItem(k, JSON.stringify({ ...f, mode: 'texts', match: f.match ?? 'words' })); } catch { /* none */ } location.hash = `#/sources/shamela?q=${encodeURIComponent(text.trim().slice(0, 120))}`; }) : null,
    item('search', t('searchWeb'), () => { const e = getSettings().searchEngine ?? 'duckduckgo'; const urls: Record<string, string> = { duckduckgo: `https://duckduckgo.com/?q=${q}`, google: `https://www.google.com/search?q=${q}`, bing: `https://www.bing.com/search?q=${q}`, wikipedia: `https://${(getLang() || 'en').split('-')[0]}.wikipedia.org/wiki/Special:Search?search=${q}`, yandex: `https://yandex.ru/search/?text=${q}`, baidu: `https://www.baidu.com/s?wd=${q}` }; window.open(urls[e] ?? urls.duckduckgo, '_blank', 'noopener'); }),
    item('define', t('wikipedia'), () => window.open(`https://${ar ? 'ar' : 'en'}.wikipedia.org/w/index.php?search=${q}`, '_blank', 'noopener')),
  ));
}

/** Wrap every text node intersecting `range` in a <mark>. Returns the marks. */
export function wrapRange(range: Range, cls: string, color: string, id: string): HTMLElement[] {
  const marks: HTMLElement[] = [];
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root.nodeType === 3 ? root.parentNode! : root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (range.intersectsNode(n) && n.textContent?.trim() && !isReading(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
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

/**
 * Where a highlight is among the places its words have in its chapter: which of them (`at`, counted from 0) and a
 * little of the text just before and after it — so that words a chapter has more than once come back where they were
 * marked. Kept with the highlight (db Highlight); an earlier version passes these by.
 */
export interface TextPlace { at?: number; before?: string; after?: string }

/** How many letters of the text around a highlight are kept with it. */
const CONTEXT = 32;

/**
 * One character as it is compared when words are looked for: space of any kind, soft hyphens and joiners count for
 * nothing (a selection across paragraphs has line breaks where the page has none, and the reverse); typographic
 * punctuation as the plain kind (curly quotes, an em dash for two hyphens, an ellipsis for three dots), so words marked
 * with "typographic punctuation" on are found with it off, and the reverse.
 */
function foldChar(c: string): string {
  if (/[\s\u00ad\u200b-\u200d\u2060\ufeff]/.test(c)) return '';
  switch (c) {
    case '\u201c': case '\u201d': case '\u201e': case '\u201f': return '"';
    case '\u2018': case '\u2019': case '\u201a': case '\u201b': return "'";
    case '\u2014': return '-';
    case '\u2026': return '...';
    default: return c;
  }
}
/** Text as it is compared (see foldChar); `map` gives, for each character of the result, its index in `text`. */
function fold(text: string, map?: number[]): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const f = foldChar(text[i]);
    if (!f) continue;
    // (A run of hyphens is one dash: «--» and «---» are both made one «—».)
    if (f === '-' && out[out.length - 1] === '-') continue;
    for (let k = 0; k < f.length; k++) { out += f[k]; map?.push(i); }
  }
  return out;
}

interface Flat { nodes: Text[]; starts: number[]; full: string; folded: string; map: number[] }
/** The text of `root` (readings left out), and the same as it is compared, with the way back from one to the other. */
function flatten(root: Element): Flat {
  // (Readings, and the numbers of the notes' bubbles, are not the book's text.)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (isReading(n) || n.parentElement?.closest('.kr-note-badge') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes: Text[] = []; const starts: number[] = [];
  let full = ''; let node: Node | null;
  while ((node = walker.nextNode())) { nodes.push(node as Text); starts.push(full.length); full += node.textContent ?? ''; }
  const map: number[] = [];
  const folded = fold(full, map);
  return { nodes, starts, full, folded, map };
}
/** Every place the folded words start in the folded text (overlapping ones too). */
function placesOf(f: Flat, needle: string): number[] {
  const out: number[] = [];
  for (let i = f.folded.indexOf(needle); i >= 0; i = f.folded.indexOf(needle, i + 1)) out.push(i);
  return out;
}
function rangeAt(f: Flat, at: number, len: number): Range {
  const s = f.map[at], e = f.map[at + len - 1] + 1;
  const locate = (pos: number, isEnd: boolean) => {
    let lo = 0, hi = f.nodes.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (f.starts[m] < pos || (isEnd && f.starts[m] === pos)) lo = m; else hi = m - 1; }
    return { node: f.nodes[lo], offset: pos - f.starts[lo] };
  };
  const a = locate(s, false), b = locate(e, true);
  const range = document.createRange();
  range.setStart(a.node, Math.min(a.offset, a.node.length));
  range.setEnd(b.node, Math.min(b.offset, b.node.length));
  return range;
}
const commonEnd = (a: string, b: string) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
const commonStart = (a: string, b: string) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };

/**
 * Find `text` inside `root` and return a Range, or null. Spaces, line breaks and typographic punctuation do not count
 * (see foldChar). With a `place` (kept with the highlight when it was made) the one of several places that fits it best
 * — the text around it first, then which of them it was; without one (a highlight from an earlier version) the first,
 * as before: one whose words match exactly preferred to one that matches only so.
 */
export function findTextRange(root: Element, text: string, place?: TextPlace): Range | null {
  const needle = fold(text);
  if (!needle) return null;
  const f = flatten(root);
  const hits = placesOf(f, needle);
  if (!hits.length) return null;
  let pick = hits[0];
  if (hits.length > 1 && place && (place.at !== undefined || place.before || place.after)) {
    const before = fold(place.before ?? ''), after = fold(place.after ?? '');
    let best = -1;
    hits.forEach((h, i) => {
      const score = commonEnd(before, f.folded.slice(Math.max(0, h - before.length), h)) + commonStart(after, f.folded.slice(h + needle.length, h + needle.length + after.length)) + (i === place.at ? 4 : 0);
      if (score > best) { best = score; pick = h; }
    });
  } else if (hits.length > 1) {
    const exact = text.replace(/\s+/g, ' ').trim();
    pick = hits.find((h) => f.full.slice(f.map[h], f.map[h + needle.length - 1] + 1).replace(/\s+/g, ' ').trim() === exact) ?? hits[0];
  }
  return rangeAt(f, pick, needle.length);
}

/**
 * The place (see TextPlace) of the words `text`, selected as `range`, among their places in `root` — kept with a
 * highlight when it is made. Empty when the words are not found as they are in `root` (it is then found as before).
 */
export function textPlace(root: Element, range: Range, text: string): TextPlace {
  const needle = fold(text);
  if (!needle) return {};
  const f = flatten(root);
  const hits = placesOf(f, needle);
  if (!hits.length) return {};
  // Where the selection starts, in the text of `root`.
  let pos = -1;
  for (let k = 0; k < f.nodes.length; k++) {
    const n = f.nodes[k];
    if (n === range.startContainer) { pos = f.starts[k] + range.startOffset; break; }
    if (range.intersectsNode(n) && (n.textContent ?? '').trim()) { pos = f.starts[k]; break; }
  }
  if (pos < 0) return {};
  let start = f.map.findIndex((m) => m >= pos); if (start < 0) start = f.folded.length;
  let at = 0;
  hits.forEach((h, i) => { if (Math.abs(h - start) < Math.abs(hits[at] - start)) at = i; });
  const h = hits[at], end = h + needle.length;
  const clean = (s: string) => s.replace(/\s+/g, ' ');
  const before = h > 0 ? clean(f.full.slice(f.map[Math.max(0, h - CONTEXT)], f.map[h])) : '';
  const after = end < f.folded.length ? clean(f.full.slice(f.map[end - 1] + 1, f.map[Math.min(f.folded.length, end + CONTEXT) - 1] + 1)) : '';
  return { at, ...(before ? { before } : {}), ...(after ? { after } : {}) };
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

/** The sentence the selection sits in (for the vocabulary notebook), or nothing when it cannot be told. */
function sentenceAround(range: Range, text: string): string {
  const block = range.startContainer.parentElement?.closest('p, li, blockquote, h1, h2, h3, h4, td, div, span.pdf-line, .pdf-text');
  const all = (block?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const at = all.indexOf(text.trim().split(/\s+/)[0] ?? '');
  if (!all || at < 0) return '';
  const parts = all.split(/(?<=[.!?؟。！？])\s+/);
  let pos = 0;
  for (const p of parts) { if (at < pos + p.length + 1) return p.length > 320 ? p.slice(Math.max(0, at - pos - 120), at - pos + 200) : p; pos += p.length + 1; }
  return '';
}
