// «Smart justify» (src/settings.ts align 'smart', and the blocks a book justifies under «Book's own»): the lines are
// justified, but a paragraph where justifying would open a gap wider than the word space and MAX_EXTRA_EM more — a
// short line of three words stretched across a narrow column at a large size, a long word pushed to the next line —
// is set ragged (data-kr-rag, src/styles/reader.css) instead of showing rivers.
//  - Measured, not guessed: the width each ordinary space between words is given on the screen (a Range over the one
//    character), against the space's own width in the paragraph's face (a canvas measure) with the word and letter
//    spacing in force. Alignment does not change where lines break, so marking a paragraph ragged never changes its
//    lines (no back and forth).
//  - Cheap on large chapters: only paragraphs near the screen are looked at (an IntersectionObserver a screen ahead),
//    each once for a given width and type (`gen`), within a few milliseconds a turn; the rest wait for idle moments.
//  - Japanese, Chinese and Korean text (justified between letters) is left as it is.
// (0.8 em more than a word space: about four spaces' width — a justified line opens that much now and then at a phone's
// width; wider is the river the eye falls into.)
export const MAX_EXTRA_EM = 0.8;
const SPACE = / (?=[^\s])/g;

let gen = 0;
const judged = new WeakMap<Element, number>();
const pending = new Set<HTMLElement>();
let ctx: CanvasRenderingContext2D | null = null;
const natural = new Map<string, number>();
let range: Range | null = null;

/** The widest gap between words in `p` as laid out now, and the widest it may be (px). */
export function gapReport(p: HTMLElement): { max: number; limit: number; spaces: number } {
  const cs = getComputedStyle(p);
  const size = parseFloat(cs.fontSize) || 16;
  const font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
  let w = natural.get(font);
  if (w === undefined) {
    ctx ??= document.createElement('canvas').getContext('2d');
    if (ctx) ctx.font = font;
    w = ctx ? ctx.measureText(' ').width : size * 0.27;
    natural.set(font, w);
  }
  const ws = parseFloat(cs.wordSpacing) || 0, ls = parseFloat(cs.letterSpacing) || 0;
  const limit = w + ws + ls + MAX_EXTRA_EM * size;
  range ??= document.createRange();
  let max = 0, spaces = 0;
  const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    const d = n.data; if (d.length < 2 || d.indexOf(' ') < 0) continue;
    SPACE.lastIndex = 0;
    for (let m = SPACE.exec(d); m; m = SPACE.exec(d)) {
      const i = m.index; if (i === 0 || /\s/.test(d[i - 1])) continue;
      range.setStart(n, i); range.setEnd(n, i + 1);
      const r = range.getBoundingClientRect(); spaces++;
      if (r.width > max) max = r.width;
    }
  }
  return { max, limit, spaces };
}

/** Whether `p` is to be set ragged: justified now (its mark taken off first) and some gap too wide. */
function judge(p: HTMLElement): void {
  judged.set(p, gen);
  if (!p.isConnected) return;
  p.removeAttribute('data-kr-rag');
  const cs = getComputedStyle(p);
  if (cs.textAlign !== 'justify' || /^(ja|zh|ko)/.test(p.closest('[lang]')?.getAttribute('lang') ?? '')) return;
  const g = gapReport(p);
  if (g.max > g.limit) p.setAttribute('data-kr-rag', '');
}

const near = new Set<HTMLElement>();
let idleId = 0;
function drain(deadline?: IdleDeadline): void {
  idleId = 0;
  const end = performance.now() + 6;
  for (const p of pending) {
    if (deadline ? deadline.timeRemaining() < 1 : performance.now() > end) break;
    pending.delete(p);
    if (judged.get(p) !== gen) judge(p);
  }
  if (pending.size && !idleId) idleId = (window.requestIdleCallback ?? ((f: IdleRequestCallback) => window.setTimeout(() => f({ timeRemaining: () => 8, didTimeout: true }), 50)))(drain);
}
const blocksOf = (c: Element) => c.querySelectorAll<HTMLElement>('p, li, blockquote, dd');

/** Watch the paragraphs of `el` (and those added later, on its «kr-content-changed»). Only the paragraphs of the runs
 *  or chapters near the screen are observed themselves: a book of thirty thousand paragraphs is not thirty thousand
 *  targets. */
export function watchJustify(el: HTMLElement): () => void {
  const mine = new Set<HTMLElement>();
  let io: IntersectionObserver | null = null, outer: IntersectionObserver | null = null, gone = false, tries = 0;
  const add = () => {
    if (!outer) return;
    const runs = el.querySelectorAll<HTMLElement>('.kr-run'); const ps = runs.length ? runs : el.querySelectorAll<HTMLElement>(':scope > .kr-chapter');
    if (ps.length) ps.forEach((c) => outer!.observe(c)); else outer.observe(el);
  };
  const start = () => {
    if (gone) return;
    // (The reader's scroller as the root — with the window's, a margin does not reach past the scroller's edge —: waited
    // for while the text is not yet put in it.)
    const root = el.closest('.reader-scroll');
    if (!root && tries++ < 60) { requestAnimationFrame(start); return; }
    io = new IntersectionObserver((es) => {
      for (const e of es) {
        const p = e.target as HTMLElement;
        if (e.isIntersecting) { near.add(p); if (judged.get(p) !== gen) pending.add(p); } else { near.delete(p); pending.delete(p); }
      }
      drain();
    }, { root, rootMargin: '100% 0px' });
    outer = new IntersectionObserver((es) => {
      for (const e of es) for (const p of blocksOf(e.target)) {
        if (e.isIntersecting) { io!.observe(p); mine.add(p); } else { io!.unobserve(p); mine.delete(p); near.delete(p); pending.delete(p); }
      }
    }, { root, rootMargin: '200% 0px' });
    add();
  };
  start();
  el.addEventListener('kr-content-changed', add);
  return () => {
    gone = true;
    el.removeEventListener('kr-content-changed', add);
    io?.disconnect(); outer?.disconnect();
    for (const p of mine) { near.delete(p); pending.delete(p); }
    mine.clear();
  };
}

/** The width, the type or the alignment changed: every paragraph is judged again, those near the screen at once. */
export function rejudge(): void {
  gen++; natural.clear();
  for (const p of near) pending.add(p);
  drain();
}

// (The window resized — another width for the lines — or a face come in after the text was judged.)
{
  let tmr = 0;
  const later = () => { window.clearTimeout(tmr); tmr = window.setTimeout(rejudge, 150); };
  window.addEventListener('resize', later);
  document.fonts?.addEventListener?.('loadingdone', later);
}
