// A file's name drawn in a right-to-left page. The base direction is that of the first strong letter of the name. In a
// right-to-left name the extension and the left-to-right tail before it («1688», «v3», «- 02 (BD)») are ONE isolated
// left-to-right run, so «ثلاث رسائل، 1688.pdf» reads Arabic words on the right and «1688.pdf» unbroken on the left —
// not «.pdf1688». Nothing is added to the text (the copied name is the exact name); a long name is cut in the middle,
// at the end of its words, and the run stays whole. A name that starts left-to-right is left as it is.
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LATIN = /[A-Za-zÀ-ɏ]/;
const ARABIC_PUNCT = /[،؛؟۔]/;
/** The name's direction: that of its first letter (dir=auto looks past an isolate, so it is said here). */
export function nameDir(name: string): 'rtl' | 'ltr' { const m = /\p{L}/u.exec(name); return m && RTL.test(m[0]) ? 'rtl' : 'ltr'; }
/** The extension of a name, with its dot («.pdf», «.tar.gz»), or ''. A leading dot alone is no extension. */
function extOf(name: string): string {
  const t = /\.tar\.(gz|xz|bz2|zst)$/i.exec(name); if (t) return t[0];
  const m = /\.[A-Za-z0-9]{1,8}$/.exec(name); return m && m.index > 0 ? m[0] : '';
}
/** Where, in a stem, the trailing left-to-right run begins (the stem's length when there is none): digits, Latin letters and
 *  the punctuation and spaces among them, not the spaces or the Arabic punctuation that follow the Arabic words. */
function tailStart(stem: string): number {
  let i = stem.length;
  while (i > 0) { const ch = stem[i - 1]; if (/\p{M}/u.test(ch) || (/\p{L}/u.test(ch) && !LATIN.test(ch))) break; i--; }
  while (i < stem.length && (/\s/.test(stem[i]) || ARABIC_PUNCT.test(stem[i]))) i++;
  return i;
}
/** The name as nodes to put in an element whose direction is nameDir(name). */
export function nameNodes(name: string): (Node | string)[] {
  if (nameDir(name) !== 'rtl') return [name];
  const ext = extOf(name); if (!ext) return [name];
  const stem = name.slice(0, name.length - ext.length); const at = tailStart(stem);
  const wrap = document.createElement('span'); wrap.className = 'nm'; wrap.dir = 'rtl';
  const head = document.createElement('span'); head.className = 'nm-stem'; head.textContent = stem.slice(0, at);
  const run = document.createElement('bdi'); run.className = 'nm-run'; run.dir = 'ltr'; run.textContent = stem.slice(at) + ext;
  if (at > 0) wrap.append(head); wrap.append(run); return [wrap];
}
/** Sets an element's content to the name. */
export const setName = (el: HTMLElement, name: string): void => { el.dir = nameDir(name); el.replaceChildren(...nameNodes(name)); };
