// «name . extension»: the two fields side by side with a dot between, the downloader's «Save as» row — and the rename
// sheets' — one look everywhere.
import { h } from './dom';
export function nameDotExt(name: HTMLElement, ext: HTMLElement): HTMLElement {
  return h('div', { class: 'save-as-row name-dot-ext' }, name, h('span', { class: 'dot', 'aria-hidden': 'true' }, '.'), ext);
}
