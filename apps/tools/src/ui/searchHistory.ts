// What was searched before (per search: anime, films and series…), offered as chips when the box is empty.
import { h, icon } from './dom';
import { t } from '../i18n';

const key = (k: string) => `kt.searchHistory.${k}`;
export function historyOf(k: string): string[] { try { return (JSON.parse(localStorage.getItem(key(k)) ?? '[]') as string[]).filter((x) => typeof x === 'string'); } catch { return []; } }
export function remember(k: string, q: string): void {
  const s = q.trim(); if (s.length < 2) return;
  const list = [s, ...historyOf(k).filter((x) => x.toLowerCase() !== s.toLowerCase())].slice(0, 12);
  try { localStorage.setItem(key(k), JSON.stringify(list)); } catch { /* full */ }
}
export function forget(k: string, q?: string): void { try { if (q === undefined) localStorage.removeItem(key(k)); else localStorage.setItem(key(k), JSON.stringify(historyOf(k).filter((x) => x !== q))); } catch { /* none */ } }
/** The chips: a tap searches again, a long press (or the ×) forgets one; «Clear» forgets all. */
export function historyChips(k: string, pick: (q: string) => void): HTMLElement | null {
  const list = historyOf(k); if (!list.length) return null;
  const box = h('div', { class: 'search-history' }, h('span', { class: 'hint small' }, icon('history'), t('recentSearches')));
  const draw = () => { const l = historyOf(k); if (!l.length) { box.remove(); return; }
    box.replaceChildren(h('span', { class: 'hint small' }, icon('history'), t('recentSearches')), h('div', { class: 'chip-row wrap' }, ...l.map((q) => h('span', { class: 'chip small hist-chip' }, h('button', { type: 'button', class: 'hist-q', dir: 'auto', onclick: () => pick(q) }, q), h('button', { type: 'button', class: 'hist-x', 'aria-label': t('remove'), onclick: () => { forget(k, q); draw(); } }, '×'))),
      h('button', { type: 'button', class: 'chip small text', onclick: () => { forget(k); draw(); } }, t('clearAll')))); };
  draw(); return box;
}
