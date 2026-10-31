// Typographic punctuation for rendered books: straight quotes become curly ones, "--" an em dash, "..."
// an ellipsis, and a figure or short word is kept with the word after it where a line break would strand
// it. Only the text is touched — tags, code and preformatted blocks are left alone — so a publisher's own
// typography is never undone (text that already has curly quotes has nothing straight to replace).
const SKIP = new Set(['PRE', 'CODE', 'KBD', 'SAMP', 'SCRIPT', 'STYLE', 'TEXTAREA', 'RT', 'RP']);
const WORD_BEFORE = /[\p{L}\p{N}.,!?;:%)\]}»”’]/u;

/** Curly quotes, dashes and ellipses in one run of text. `prev` is the character just before it. */
export function polish(text: string, prev = ' '): string {
  let out = '';
  let p = prev;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { out += p && WORD_BEFORE.test(p) ? '”' : '“'; }
    else if (c === "'") { out += p && WORD_BEFORE.test(p) ? '’' : '‘'; }
    else if (c === '-' && text[i + 1] === '-') { out += '—'; i++; while (text[i + 1] === '-') i++; }
    else if (c === '.' && text[i + 1] === '.' && text[i + 2] === '.') { out += '…'; i += 2; }
    else out += c;
    p = out[out.length - 1];
  }
  // A number and its unit, or a one-letter word (a, I, و) and the next word, stay on one line.
  return out.replace(/(\d) (?=(?:%|°|[\p{L}]{1,3}\b))/gu, '$1 ').replace(/(^|\s)([AaIi]|[وف]) (?=\p{L})/gu, '$1$2 ');
}

const originals = new WeakMap<Text, string>();

/** Polish every text node under `root` (remembering the original, so it can be undone). */
export function applyTypography(root: Element): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && !n.parentElement.closest('pre, code, kbd, samp, rt, rp, textarea') && !SKIP.has(n.parentElement.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  let prevChar = ' ';
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const src = originals.get(node) ?? node.data;
    if (!/["'.-]/.test(src)) { if (src.trim()) prevChar = src[src.length - 1]; continue; }
    const block = node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, div, td, th, blockquote, figcaption');
    const first = block && block.firstChild === node || !node.previousSibling && !/\S/.test(prevChar);
    const next = polish(src, first ? ' ' : prevChar);
    if (next !== node.data) { if (!originals.has(node)) originals.set(node, src); node.data = next; }
    if (src.trim()) prevChar = next[next.length - 1];
  }
}

/** Put the original text back. */
export function revertTypography(root: Element): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) { const o = originals.get(node); if (o !== undefined) { node.data = o; originals.delete(node); } }
}
