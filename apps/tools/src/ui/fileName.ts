// A file's name drawn in a right-to-left page: «ثلاث رسائل، 1688.pdf» read in the order its letters are meant — the stem
// by its own direction, the extension an isolated left-to-right run (otherwise the bidi rules put «.pdf» before «1688»
// and the dot between them). A name with no right-to-left letter is drawn as it is.
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
/** The name's direction: that of its first letter (what dir=auto would say — but dir=auto looks past an isolate, so it is said here). */
export function nameDir(name: string): 'rtl' | 'ltr' { const m = /\p{L}/u.exec(name); return m && RTL.test(m[0]) ? 'rtl' : 'ltr'; }
/** The name as nodes to put in an element: plain text, or the stem and the extension each in an isolate. */
export function nameNodes(name: string): (Node | string)[] {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})$/s.exec(name);
  if (!m || !m[1] || !RTL.test(m[1])) return [name];
  const stem = document.createElement('bdi'); stem.dir = 'auto'; stem.textContent = m[1];
  const ext = document.createElement('bdi'); ext.dir = 'ltr'; ext.textContent = m[2];
  return [stem, ext];
}
/** Sets an element's content to the name. */
export const setName = (el: HTMLElement, name: string): void => { el.dir = nameDir(name); el.replaceChildren(...nameNodes(name)); };
