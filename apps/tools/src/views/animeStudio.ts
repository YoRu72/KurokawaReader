// A studio's page: its name over its best known show's picture, how many works it has, and its works — the most
// popular first, or the best rated, the newest, the oldest —, its own productions only or with those it helped on.
import { h, icon, iconButton } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { navigate, back } from '../router';
import * as al from '../anilist';
import type { Anime } from '../anilist';
import { animeCard, tickCountdowns } from './anime';

const SORTS: [string, string][] = [['POPULARITY_DESC', 'sortPopular'], ['SCORE_DESC', 'sortScore'], ['START_DATE_DESC', 'sortNewest'], ['START_DATE', 'dcOldest']];
export function animeStudioView(id: number, name?: string): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'body anime-body studio-body' });
  const title = h('span', { dir: 'auto' }, name ?? '');
  const root = h('div', { class: 'view anime-view studio-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/anime')), h('div', { class: 'title' }, title), h('div', { class: 'topbar-actions' }, iconButton('external', 'AniList', () => window.open(`https://anilist.co/studio/${id}`, '_blank')))), body) as HTMLElement & { dispose?: () => void };
  let sort = 'POPULARITY_DESC'; let mainOnly = true; let page = 1; let all: Anime[] = []; let runs = 0; let alive = true;
  const head = h('section', { class: 'studio-head' }); const chips = h('div', { class: 'chip-row wrap' }); const grid = h('div', { class: 'anime-grid' });
  const more = h('button', { type: 'button', class: 'btn tonal small anime-more', hidden: true, onclick: () => void load(true) }, t('loadMore')) as HTMLButtonElement;
  const drawChips = () => chips.replaceChildren(
    ...SORTS.map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (sort === k ? ' on' : ''), onclick: () => { sort = k; drawChips(); void load(); } }, t(l as 'sortPopular'))),
    h('span', { class: 'chip-sep' }),
    h('button', { type: 'button', class: 'chip small' + (mainOnly ? ' on' : ''), title: t('dcMainOnlyHint'), onclick: () => { mainOnly = !mainOnly; drawChips(); void load(); } }, icon(mainOnly ? 'check' : 'plus'), t('dcMainOnly')));
  const load = async (next = false) => {
    const mine = ++runs; if (!next) { page = 1; all = []; grid.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' }))); } else { page++; more.disabled = true; }
    try {
      const r = await al.studioWorks(id, { page, sort, mainOnly }); if (!alive || mine !== runs) return;
      if (page === 1) {
        title.textContent = r.studio.name;
        head.replaceChildren(...(r.studio.image ? [h('img', { class: 'studio-art', src: r.studio.image, alt: '' })] : []), h('div', { class: 'studio-shade' }),
          h('div', { class: 'studio-text' }, h('h2', { dir: 'auto' }, r.studio.name), h('p', null, [r.total ? t('dcWorks', { n: localDigits(r.total) }) : '', r.studio.favourites ? `♥ ${localDigits(r.studio.favourites)}` : '', r.studio.animation ? t('dcAnimationStudio') : t('dcProducer')].filter(Boolean).join(' · '))));
        if (r.studio.color) head.style.setProperty('--dc-tint', r.studio.color);
      }
      all = all.concat(r.media); grid.replaceChildren(...all.map((a) => animeCard(a)));
      if (!all.length) grid.replaceChildren(h('p', { class: 'empty small' }, t('noResults')));
      more.hidden = !r.hasNext; more.disabled = false;
    } catch (e) { if (mine === runs) grid.replaceChildren(h('p', { class: 'empty small' }, String((e as Error)?.message ?? e))); }
  };
  body.append(head, chips, grid, more); drawChips(); void load();
  const timer = tickCountdowns(grid);
  root.dispose = () => { alive = false; window.clearInterval(timer); };
  void navigate;
  return root;
}
