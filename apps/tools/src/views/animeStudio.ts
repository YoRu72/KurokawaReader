// A studio's page: its name over its best known show's picture, how many works it has, and its works — the most
// popular first, or the best rated, the newest, the oldest —, its own productions only or with those it helped on.
import { h, icon, iconButton, toast } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { navigate, back } from '../router';
import * as al from '../anilist';
import type { Anime } from '../anilist';
import { animeCard, tickCountdowns } from './anime';
import { netLoad, scope, reasonOf } from './animeNet';

const SORTS: [string, string][] = [['POPULARITY_DESC', 'sortPopular'], ['SCORE_DESC', 'sortScore'], ['START_DATE_DESC', 'sortNewest'], ['START_DATE', 'dcOldest']];
export function animeStudioView(id: number, name?: string): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'body anime-body studio-body' });
  const title = h('span', { dir: 'auto' }, name ?? '');
  const root = h('div', { class: 'view anime-view studio-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/anime')), h('div', { class: 'title' }, title), h('div', { class: 'topbar-actions' }, iconButton('external', 'AniList', () => window.open(`https://anilist.co/studio/${id}`, '_blank')))), body) as HTMLElement & { dispose?: () => void };
  const sc = scope(); let sort = 'POPULARITY_DESC'; let mainOnly = true; let page = 1; let all: Anime[] = []; let runs = 0; let alive = true;
  const head = h('section', { class: 'studio-head' }); const chips = h('div', { class: 'chip-row wrap' }); const grid = h('div', { class: 'anime-grid' });
  const more = h('button', { type: 'button', class: 'btn tonal small anime-more', hidden: true, onclick: () => load(true) }, t('loadMore')) as HTMLButtonElement;
  const drawChips = () => chips.replaceChildren(
    ...SORTS.map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (sort === k ? ' on' : ''), onclick: () => { sort = k; drawChips(); load(); } }, t(l as 'sortPopular'))),
    h('span', { class: 'chip-sep' }),
    h('button', { type: 'button', class: 'chip small' + (mainOnly ? ' on' : ''), title: t('dcMainOnlyHint'), onclick: () => { mainOnly = !mainOnly; drawChips(); load(); } }, icon(mainOnly ? 'check' : 'plus'), t('dcMainOnly')));
  const box = h('div');
  const paint = (r: Awaited<ReturnType<typeof al.studioWorks>>, first: boolean) => {
    if (first) {
      title.textContent = r.studio.name;
      head.replaceChildren(...(r.studio.image ? [h('img', { class: 'studio-art', src: r.studio.image, alt: '' })] : []), h('div', { class: 'studio-shade' }),
        h('div', { class: 'studio-text' }, h('h2', { dir: 'auto' }, r.studio.name), h('p', null, [r.total ? t('dcWorks', { n: localDigits(r.total) }) : '', r.studio.favourites ? `♥ ${localDigits(r.studio.favourites)}` : '', r.studio.animation ? t('dcAnimationStudio') : t('dcProducer')].filter(Boolean).join(' · '))));
      if (r.studio.color) head.style.setProperty('--dc-tint', r.studio.color);
    }
    all = first ? r.media : all.concat(r.media);
    grid.replaceChildren(...all.flatMap((a) => { try { return [animeCard(a)]; } catch { return []; } }));
    if (!all.length) grid.replaceChildren(h('p', { class: 'empty small' }, t('noResults')));
    more.hidden = !r.hasNext; more.disabled = false;
  };
  const load = (next = false) => {
    const mine = ++runs; const sig = sc.next();
    if (next) {
      page++; more.disabled = true;
      void al.studioWorks(id, { page, sort, mainOnly, net: { signal: sig } }).then((r) => { if (alive && mine === runs) paint(r, false); }).catch((e) => { if (alive && mine === runs) { page--; more.disabled = false; toast(reasonOf(e), 'error'); } });
      return;
    }
    page = 1; all = [];
    netLoad<Awaited<ReturnType<typeof al.studioWorks>>>({ host: box, signal: sig, live: () => alive && mine === runs, key: `studio:${id}:${sort}:${mainOnly ? 1 : 0}`, empty: (r) => !r.media.length,
      ask: (net) => al.studioWorks(id, { page: 1, sort, mainOnly, net }), show: (r, b) => { b.replaceChildren(grid); paint(r, true); } });
  };
  body.append(head, chips, box, more); drawChips(); load();
  const timer = tickCountdowns(grid);
  root.dispose = () => { alive = false; sc.stop(); window.clearInterval(timer); };
  void navigate;
  return root;
}
