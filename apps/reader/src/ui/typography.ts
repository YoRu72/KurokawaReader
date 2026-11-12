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

// (Each text node changed: its original, and what it was made — a node cut in pieces since, by a highlight, is told
// by its text no longer being all of that.)
const originals = new WeakMap<Text, { src: string; out: string }>();

/** Polish every text node under `root` (remembering the original, so it can be undone). */
export function applyTypography(root: Element): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && !n.parentElement.closest('pre, code, kbd, samp, rt, rp, textarea') && !SKIP.has(n.parentElement.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  let prevChar = ' ';
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const kept = originals.get(node);
    // (A node already changed, and cut since: what it holds now is changed already — only its own part is seen.)
    const src = kept && kept.out === node.data ? kept.src : kept ? null : node.data;
    if (src === null) { if (node.data.trim()) prevChar = node.data[node.data.length - 1]; continue; }
    if (!/["'.-]/.test(src)) { if (src.trim()) prevChar = src[src.length - 1]; continue; }
    const block = node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, div, td, th, blockquote, figcaption');
    const first = block && block.firstChild === node || !node.previousSibling && !/\S/.test(prevChar);
    const next = polish(src, first ? ' ' : prevChar);
    if (next !== node.data) { originals.set(node, { src, out: next }); node.data = next; }
    if (src.trim()) prevChar = next[next.length - 1];
  }
}

/** Put the original text back. A node that was cut in pieces after it was changed (a highlight's marks wrap some of
 *  them) is put back whole when its pieces follow it as they were cut, the pieces then emptied; one that cannot be
 *  told so is left as it is — never doubled. */
export function revertTypography(root: Element): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = []; let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) nodes.push(node);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]; const o = originals.get(n);
    if (!o) continue;
    originals.delete(n);
    if (n.data === o.out) { n.data = o.src; continue; }
    if (!o.out.startsWith(n.data)) continue;
    let got = n.data; let j = i + 1; const parts: Text[] = [];
    while (got.length < o.out.length && j < nodes.length && !originals.has(nodes[j]) && o.out.startsWith(got + nodes[j].data)) { got += nodes[j].data; parts.push(nodes[j]); j++; }
    if (got !== o.out) continue;
    n.data = o.src; parts.forEach((x) => { x.data = ''; });
    i = j - 1;
  }
}
