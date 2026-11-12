// Rules that change a book's text as it is shown — a site's watermark ("Read at novelbin.me") taken out, a
// name spelt the way the reader wants — for one book or every book, as words or as a regular expression
// (LNReader's text modifications, IReader's content filters). Applied to the text as it is laid out, so what
// is read aloud, searched for and copied follows them; the book's file is not touched.

export interface TextRule { id: string; find: string; replace: string; regex?: boolean; caseSensitive?: boolean; /** a book's id, or every book when absent */ book?: string; off?: boolean }

const KEY = 'kr.textRules';
let cache: TextRule[] | null = null;
export function textRules(): TextRule[] {
  if (cache) return cache;
  try { cache = (JSON.parse(localStorage.getItem(KEY) ?? '[]') as TextRule[]).filter((r) => r && typeof r.find === 'string' && r.find); } catch { cache = []; }
  return cache;
}
export function saveTextRules(list: TextRule[]): void {
  cache = list;
  try { if (list.length) localStorage.setItem(KEY, JSON.stringify(list)); else localStorage.removeItem(KEY); } catch { /* full */ }
  listeners.forEach((fn) => fn());
}
/** Books taken out of the library: their own rules let go (every book's stay). */
export function forgetBooks(ids: Iterable<string>): void { const gone = new Set(ids); if (textRules().some((r) => r.book && gone.has(r.book))) saveTextRules(textRules().filter((r) => !r.book || !gone.has(r.book))); }
const listeners = new Set<() => void>();
export function onTextRules(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether a pattern has a repeat inside a repeat — «(a+)+», «(\\w+\\s?)*», «(.*)*», «(?:x|y+){2,}» — the shape
 *  that can take the regular-expression engine exponential time on a line it does not match, freezing the reader
 *  (nothing can stop a match once begun on the page's thread). What this cannot see: overlapping alternatives
 *  under one repeat («(a|a)+»), long chains of repeats side by side, back-references; those are rare by hand. */
export function nestedRepeat(src: string): boolean {
  const stack: boolean[] = [false]; let lastGroup: boolean | null = null; let atom = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const q = c === '+' || c === '*' ? 1 : c === '{' ? /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i)) : null;
    if (q && atom) {
      const m = q === 1 ? null : q; const many = q === 1 || (!!m![2] && (m![3] === '' || Number(m![3]) >= 8));
      if (m) i += m[0].length - 1; if (src[i + 1] === '?' || src[i + 1] === '+') i++;
      if (many) { if (lastGroup) return true; stack[stack.length - 1] = true; }
      atom = false; lastGroup = null; continue;
    }
    lastGroup = null; atom = true;
    if (c === '\\') { i++; if (src[i] === 'p' || src[i] === 'P' || src[i] === 'u' || src[i] === 'x') { if (src[i + 1] === '{') i = Math.max(i, src.indexOf('}', i)); } continue; }
    if (c === '[') { i++; if (src[i] === '^') i++; if (src[i] === ']') i++; while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } continue; }
    if (c === '(') { stack.push(false); atom = false; if (src[i + 1] === '?') { i++; if (src[i + 1] === '<' && src[i + 2] !== '=' && src[i + 2] !== '!') i = Math.max(i, src.indexOf('>', i)); else i++; } continue; }
    if (c === ')') { const inner = stack.length > 1 ? stack.pop()! : false; if (inner) stack[stack.length - 1] = true; lastGroup = inner; continue; }
    if (c === '|' || c === '^' || c === '$') { atom = false; continue; }
  }
  return false;
}
/** A rule as a regular expression (null when its pattern is not one, or is one that could freeze the reader). A
 *  pattern of the reader's is read with the «u» flag (so «\\p{L}» is a letter), else — written for the older
 *  reading, «\\-» or a lone «{» in it — as before. */
export function patternOf(r: TextRule): RegExp | null {
  const flags = r.caseSensitive ? 'g' : 'gi';
  if (!r.regex) { try { return new RegExp(escape(r.find).replace(/\s+/g, '\\s+'), flags); } catch { return null; } }
  if (nestedRepeat(r.find)) return null;
  try { return new RegExp(r.find, flags + 'u'); } catch { /* the older reading */ }
  try { return new RegExp(r.find, flags); } catch { return null; }
}
/** The rules that apply to a book, as patterns. */
export function rulesFor(bookId: string): { re: RegExp; to: string }[] {
  const out: { re: RegExp; to: string }[] = [];
  for (const r of textRules()) { if (r.off || (r.book && r.book !== bookId)) continue; const re = patternOf(r); if (re) out.push({ re, to: r.replace }); }
  return out;
}
/** A text with the rules applied. */
export function applyRulesTo(text: string, rules: { re: RegExp; to: string }[]): string {
  let s = text;
  for (const { re, to } of rules) { re.lastIndex = 0; s = s.replace(re, to); }
  return s;
}

const done = new WeakSet<Text>();
/** The rules applied to the text under `root` not yet seen (a chapter fetched later is passed through when it
 *  comes). A paragraph left with nothing is hidden. Readings (furigana) are stepped over. */
export function applyTextRules(root: HTMLElement, bookId: string, only?: TextRule[]): number {
  // (`only`: rules just made, passed over the whole text — what was seen included.)
  const rules = only ? only.flatMap((r) => { const re = patternOf(r); return re ? [{ re, to: r.replace }] : []; }) : rulesFor(bookId);
  if (!rules.length) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => ((!only && done.has(n as Text)) || (n.parentElement?.closest('rt, rp, script, style')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes: Text[] = []; for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let changed = 0;
  const emptied = new Set<HTMLElement>();
  for (const n of nodes) {
    done.add(n);
    const was = n.data; if (!was.trim()) continue;
    const now = applyRulesTo(was, rules);
    if (now === was) continue;
    n.data = now; changed++;
    if (!now.trim() && n.parentElement) emptied.add(n.parentElement.closest<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6, div, blockquote') ?? n.parentElement);
  }
  for (const el of emptied) if (!(el.textContent ?? '').trim() && !el.querySelector('img, svg, video, audio') && !el.classList.contains('kr-chap') && !el.classList.contains('kr-content')) el.hidden = true;
  return changed;
}
