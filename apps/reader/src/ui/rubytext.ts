// Text without its readings.
/** Readings (furigana, pinyin: <rt>, <rp>) are not the text: what is copied, searched, highlighted or read
 *  aloud is the text without them. */
export const isReading = (n: Node | null): boolean => !!(n && (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest('rt, rp'));
/** A range's text without its readings, or null when it has none (the caller reads it as usual). */
export function withoutReadings(range: Range): string | null {
  const frag = range.cloneContents();
  if (!frag.querySelector('rt, rp')) return null;
  frag.querySelectorAll('rt, rp').forEach((e) => e.remove());
  return frag.textContent ?? '';
}
/** An element's text without its readings. */
export function plainText(el: Element): string {
  if (!el.querySelector('rt, rp')) return el.textContent ?? '';
  let out = ''; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (isReading(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n = w.nextNode(); n; n = w.nextNode()) out += n.textContent ?? '';
  return out;
}

