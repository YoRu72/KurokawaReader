// The way back after a jump: a link followed, a contents entry, a bookmark or a search hit takes the reader
// elsewhere; a pill at the bottom offers the place they left (and the one before that, in turn). It goes away
// once the reader scrolls on by themselves for a while, since then the old place is no longer "where I was".
import { h, icon } from './dom';
import { t } from '../i18n';

export interface JumpBack { remember(): void; dispose(): void }

export function jumpBack<L>(root: HTMLElement, goTo: (loc: L) => void, current: () => L | null, scroller: HTMLElement): JumpBack {
  const stack: L[] = [];
  let pill: HTMLElement | null = null;
  let hideTimer = 0, settled = 0;
  const hide = () => { pill?.remove(); pill = null; };
  const show = () => {
    if (!stack.length) { hide(); return; }
    if (!pill) { pill = h('button', { type: 'button', class: 'jump-back', onclick: () => { const loc = stack.pop(); if (loc !== undefined) { settled = 0; goTo(loc); } show(); } }, icon('undo'), h('span', null, t('backToPlace'))); root.appendChild(pill); }
    pill.querySelector('span')!.textContent = stack.length > 1 ? `${t('backToPlace')} · ${stack.length}` : t('backToPlace');
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => { stack.length = 0; hide(); }, 120000);
  };
  // Scrolling by hand for a while after a jump means the reader has settled there: the pill is dropped.
  let last = 0; let moved = 0;
  const onScroll = () => { if (!pill) return; const now = performance.now(); if (now - last < 1500) moved += 1; else moved = 0; last = now; if (moved > 40) { stack.length = 0; hide(); } };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  return {
    remember() { const loc = current(); if (loc === null) return; stack.push(loc); if (stack.length > 10) stack.shift(); moved = 0; window.setTimeout(show, 50); },
    dispose() { scroller.removeEventListener('scroll', onScroll); window.clearTimeout(hideTimer); hide(); },
  };
}
