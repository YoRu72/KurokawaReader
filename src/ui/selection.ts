// Floating toolbar that appears over selected text: Copy · Search · Define ·
// Translate · Highlight · Speak.
import { h, icon, toast } from './dom';
import { t } from '../i18n';
import { showDefinition, showTranslation } from './lookup';

export interface SelectionActions {
  search(text: string): void;
  highlight(range: Range, text: string): void;
  speak(text: string): void;
}

export function attachSelectionToolbar(scope: HTMLElement, actions: SelectionActions): () => void {
  let bar: HTMLElement | null = null;
  let timer: number | undefined;

  const hide = () => { bar?.remove(); bar = null; };

  const show = () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hide(); return; }
    const range = sel.getRangeAt(0);
    if (!scope.contains(range.commonAncestorContainer)) { hide(); return; }
    const text = sel.toString().trim();
    if (!text) { hide(); return; }
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { hide(); return; }
    if (rect.bottom < 0 || rect.top > window.innerHeight) { hide(); return; }
    if (!bar) {
      const btn = (name: string, label: string, fn: () => void) => h('button', { type: 'button', onclick: (e: Event) => { e.preventDefault(); fn(); } }, icon(name), h('span', null, label));
      bar = h('div', { class: 'sel-toolbar', role: 'toolbar' },
        btn('copy', t('copySelected'), async () => { try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { document.execCommand('copy'); toast(t('copied')); } hide(); }),
        btn('search', t('searchSelected'), () => { actions.search(text); hide(); }),
        btn('define', t('defineSelected'), () => { showDefinition(text); hide(); }),
        btn('translate', t('translateSelected'), () => { showTranslation(text); hide(); }),
        btn('highlight', t('highlight'), () => { const r = sel.getRangeAt(0).cloneRange(); actions.highlight(r, text); sel.removeAllRanges(); hide(); }),
        'speechSynthesis' in window ? btn('speak', t('speakSelected'), () => { actions.speak(text); hide(); }) : null,
      );
      // Keep the selection when tapping toolbar buttons.
      bar.addEventListener('mousedown', (e) => e.preventDefault());
      bar.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      document.body.appendChild(bar);
    }
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let x = rect.left + rect.width / 2;
    x = Math.max(bw / 2 + 8, Math.min(window.innerWidth - bw / 2 - 8, x));
    let y = rect.top - bh - 10;
    if (y < 64) y = rect.bottom + 10;
    y = Math.max(64, Math.min(window.innerHeight - bh - 20, y));
    bar.style.left = `${x}px`;
    bar.style.top = `${y}px`;
  };

  const onChange = () => { window.clearTimeout(timer); timer = window.setTimeout(show, 180); };
  document.addEventListener('selectionchange', onChange);
  const onScroll = () => { if (bar) show(); };
  scope.addEventListener('scroll', onScroll, { passive: true, capture: true });
  return () => { document.removeEventListener('selectionchange', onChange); scope.removeEventListener('scroll', onScroll, true); hide(); };
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
