// The Anime tab (shown once the Anime add-on is installed): searching AniList, the season chart with countdowns
// (AniChart's page), the week's airing schedule (LiveChart's), and the user's own watching list — each card
// leading to the show's page, where episodes are found as torrents and progress is tracked.
import { h, icon, iconButton, toast, debounce } from '../ui/dom';
import { t, localDigits, countEpisodes, dateLocale, getLang, countDays, countHours, countMinutes } from '../i18n';
import { navigate } from '../router';
import { getSettings } from '../settings';
import * as al from '../anilist';
import type { Anime, Season, AlStatus } from '../anilist';

export type AnimeTab = 'search' | 'season' | 'schedule' | 'list';
const TAB_KEY = 'kt.anime.tab';

export const seasonName = (s: Season): string => t(({ WINTER: 'seasonWinter', SPRING: 'seasonSpring', SUMMER: 'seasonSummer', FALL: 'seasonFall' } as const)[s]);
export const fmtUntil = (secs: number): string => {
  if (secs <= 0) return t('animeAiredNow');
  const d = Math.floor(secs / 86400), hh = Math.floor((secs % 86400) / 3600), m = Math.max(1, Math.floor((secs % 3600) / 60));
  // Arabic counts its nouns: «يومان و٣ ساعات», «ساعة واحدة و٢٠ دقيقةً».
  if (getLang() === 'ar') return d ? `${countDays(d)}${hh ? ` و${countHours(hh)}` : ''}` : hh ? `${countHours(hh)}${m ? ` و${countMinutes(m)}` : ''}` : countMinutes(m);
  return d ? t('untilDays', { d, h: hh }) : hh ? t('untilHours', { h: hh, m }) : t('untilMinutes', { m });
};
/** Countdowns on the page kept current: every element with data-at (seconds) shows the time left. */
export function tickCountdowns(root: HTMLElement): number {
  return window.setInterval(() => { const n = Date.now() / 1000; root.querySelectorAll<HTMLElement>('[data-at]').forEach((el) => { const at = Number(el.dataset.at); const ep = el.dataset.ep; const txt = ep ? t('animeNextEp', { n: Number(ep), t: fmtUntil(at - n) }) : fmtUntil(at - n); const target = el.querySelector('.until') ?? el; if (target.textContent !== txt) target.textContent = txt; }); }, 30000);
}
export const titleOf = (a: Anime): string => { const p = getSettings().animeTitleLang; return (p === 'romaji' ? a.titleRomaji : p === 'english' ? a.titleEnglish : p === 'native' ? a.titleNative : a.title) || a.title; };

/** A show's card: cover, title, a line of facts, the next episode's countdown when airing. */
export function animeCard(a: Anime, extra?: HTMLElement | null): HTMLElement {
  const facts = [a.format ? fmtFormat(a.format) : '', a.seasonYear ? localDigits(a.seasonYear) : '', a.episodes ? countEpisodes(a.episodes) : '', a.score ? `★ ${localDigits(a.score)}%` : ''].filter(Boolean).join(' · ');
  const next = a.nextAiring ? h('span', { class: 'anime-next', dataset: { at: String(a.nextAiring.airingAt), ep: String(a.nextAiring.episode) } }, icon('clock'), h('span', { class: 'until' }, t('animeNextEp', { n: a.nextAiring.episode, t: fmtUntil(a.nextAiring.airingAt - Date.now() / 1000) }))) : null;
  const prog = a.entry ? h('span', { class: `anime-badge s-${a.entry.status.toLowerCase()}` }, `${localDigits(a.entry.progress)}${a.episodes ? ` / ${localDigits(a.episodes)}` : ''}`) : null;
  return h('button', { type: 'button', class: 'anime-card', onclick: () => navigate(`/anime/${a.id}`), style: a.color ? { '--cover-color': a.color } : undefined },
    h('span', { class: 'anime-cover' }, a.cover ? h('img', { src: a.cover, alt: '', loading: 'lazy' }) : icon('film'), prog),
    h('span', { class: 'anime-text' }, h('span', { class: 'anime-title', dir: 'auto' }, titleOf(a)), h('span', { class: 'anime-facts' }, facts), next, extra ?? null));
}
export const fmtFormat = (f: string): string => ({ TV: 'TV', TV_SHORT: t('formatShort'), MOVIE: t('formatMovie'), SPECIAL: t('formatSpecial'), OVA: 'OVA', ONA: 'ONA', MUSIC: t('formatMusic') } as Record<string, string>)[f] ?? f;

export function animeView(tab?: AnimeTab, q?: string): HTMLElement & { dispose?: () => void } {
  let current: AnimeTab = tab ?? ((localStorage.getItem(TAB_KEY) as AnimeTab | null) ?? (al.linked() ? 'list' : 'season'));
  const body = h('div', { class: 'body anime-body' });
  const chips = h('div', { class: 'chips filter-chips' });
  const root = h('div', { class: 'view anime-view' }, h('header', { class: 'topbar' }, h('div', { class: 'title' }, h('span', null, t('navAnime'))), h('div', { class: 'topbar-actions' }, iconButton('puzzle', t('animeProviders'), () => navigate('/settings/anime')))), chips, body) as HTMLElement & { dispose?: () => void };
  const TABS: [AnimeTab, string, string][] = [['search', t('navSearch'), 'search'], ['season', t('animeSeason'), 'calendar'], ['schedule', t('animeSchedule'), 'clock'], ['list', t('animeMyList'), 'bookmark']];
  let timer = 0; let token = 0;
  const drawChips = () => chips.replaceChildren(...TABS.map(([k, label, ic]) => h('button', { type: 'button', class: 'chip' + (current === k ? ' on' : ''), 'aria-pressed': String(current === k), onclick: () => { current = k; localStorage.setItem(TAB_KEY, k); navigate(`/anime?tab=${k}`, true); draw(); } }, icon(ic), label)));
  const grid = (items: Anime[], extra?: (a: Anime) => HTMLElement | null) => h('div', { class: 'anime-grid' }, ...items.map((a) => animeCard(a, extra?.(a))));
  const spinner = () => h('div', { class: 'center' }, h('div', { class: 'spinner' }));
  const fail = (e: unknown) => h('p', { class: 'empty small' }, String((e as Error)?.message ?? e));

  const draw = () => {
    drawChips(); window.clearInterval(timer); const my = ++token; body.replaceChildren();
    if (current === 'search') {
      const input = h('input', { type: 'search', class: 'search-input', placeholder: t('animeSearchHint'), value: q ?? '', autofocus: true, enterkeyhint: 'search' }) as HTMLInputElement;
      const results = h('div');
      let runs = 0;
      const run = async () => { const s = input.value.trim(); const mine = ++runs; if (!s) { results.replaceChildren(); return; } results.replaceChildren(spinner()); try { const r = await al.search(s, { adult: getSettings().animeAdult }); if (my !== token || mine !== runs) return; results.replaceChildren(r.length ? grid(r) : h('p', { class: 'empty small' }, t('noResults'))); } catch (e) { if (mine === runs) results.replaceChildren(fail(e)); } };
      input.addEventListener('input', debounce(run, 450));
      body.append(h('form', { class: 'search-form', onsubmit: (e: Event) => { e.preventDefault(); void run(); } }, input), results);
      if (q) void run(); setTimeout(() => input.focus(), 50);
    } else if (current === 'season') {
      let at = al.seasonOf(); let adult = getSettings().animeAdult; let leftovers = false; let sort = 'POPULARITY_DESC';
      const head = h('div', { class: 'season-head' }); const list = h('div');
      let loads = 0;
      const load = async () => {
        const mine = ++loads;
        head.replaceChildren(iconButton('chevronLeft', t('back'), () => { at = al.seasonShift(at, -1); void load(); }), h('h2', null, `${seasonName(at.season)} ${localDigits(at.year)}`), iconButton('chevronRight', t('next'), () => { at = al.seasonShift(at, 1); void load(); }),
          h('div', { class: 'grow' }), h('button', { type: 'button', class: 'chip' + (leftovers ? ' on' : ''), onclick: () => { leftovers = !leftovers; void load(); } }, t('animeLeftovers')),
          h('button', { type: 'button', class: 'chip', onclick: () => { sort = sort === 'POPULARITY_DESC' ? 'SCORE_DESC' : sort === 'SCORE_DESC' ? 'START_DATE' : 'POPULARITY_DESC'; void load(); } }, icon('sort'), t(sort === 'POPULARITY_DESC' ? 'sortPopular' : sort === 'SCORE_DESC' ? 'sortScore' : 'sortDate')));
        list.replaceChildren(spinner());
        try {
          let r: Anime[];
          if (leftovers) r = await al.leftovers(al.seasonShift(at, -1).season, al.seasonShift(at, -1).year, adult);
          else { r = []; for (let page = 1; page <= 4; page++) { const c = await al.seasonChart(at.season, at.year, { adult, sort, page }); if (my !== token || mine !== loads) return; r.push(...c.media); if (page === 1) list.replaceChildren(grid(r)); if (!c.hasNext) break; } }
          if (my !== token || mine !== loads) return;
          // The shows on the user's list first within the season's order, so «what am I watching this season» is on top.
          list.replaceChildren(r.length ? grid(r) : h('p', { class: 'empty small' }, t('noResults')));
        } catch (e) { if (mine === loads) list.replaceChildren(fail(e)); }
      };
      body.append(head, list); void load();
      timer = tickCountdowns(list);
    } else if (current === 'schedule') {
      const list = h('div'); body.append(list); list.append(spinner());
      void (async () => {
        try {
          const now = Math.floor(Date.now() / 1000); const start = now - 6 * 3600; const items = (await al.airing(start, now + 7 * 86400)).filter((x) => getSettings().animeAdult || !x.media.isAdult);
          if (my !== token) return;
          const days = new Map<string, al.AiringItem[]>(); const df = new Intl.DateTimeFormat(dateLocale('prose'), { weekday: 'long', day: 'numeric', month: 'long' }); const tf = new Intl.DateTimeFormat(dateLocale('data'), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
          for (const it of items) { const k = df.format(new Date(it.airingAt * 1000)); (days.get(k) ?? days.set(k, []).get(k)!).push(it); }
          list.replaceChildren(...[...days].map(([day, its]) => h('section', { class: 'sched-day' }, h('h3', null, day), ...its.map((it) => h('button', { type: 'button', class: 'sched-row' + (it.airingAt <= now ? ' aired' : ''), onclick: () => navigate(`/anime/${it.media.id}`) },
            h('span', { class: 'sched-time', dir: 'ltr' }, tf.format(new Date(it.airingAt * 1000))), it.media.cover ? h('img', { src: it.media.cover, alt: '', loading: 'lazy' }) : h('span', { class: 'sched-noimg' }),
            h('span', { class: 'grow' }, h('span', { class: 'anime-title', dir: 'auto' }, titleOf(it.media)), h('small', { class: 'src' }, `${t('episodeN', { n: it.episode })}${it.media.episodes ? ` / ${localDigits(it.media.episodes, 'prose')}` : ''}${it.media.entry ? ` · ${statusName(it.media.entry.status)}` : ''}`)),
            h('span', { class: 'sched-until' }, it.airingAt <= now ? t('animeAiredNow') : fmtUntil(it.airingAt - now)))))));
          if (!days.size) list.replaceChildren(h('p', { class: 'empty small' }, t('noResults')));
          timer = window.setInterval(() => { const n = Math.floor(Date.now() / 1000); list.querySelectorAll<HTMLElement>('.sched-row').forEach((row, i) => { const it = items[i]; if (!it) return; const u = row.querySelector('.sched-until')!; u.textContent = it.airingAt <= n ? t('animeAiredNow') : fmtUntil(it.airingAt - n); row.classList.toggle('aired', it.airingAt <= n); }); }, 30000);
        } catch (e) { list.replaceChildren(fail(e)); }
      })();
    } else {
      if (!al.linked()) { body.append(h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('user')), h('h2', null, t('animeMyList')), h('p', null, t('anilistLinkFirst')), h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('/settings/anime') }, icon('link'), t('anilistSignIn'))))); return; }
      const stats: (AlStatus | 'ALL')[] = ['CURRENT', 'PLANNING', 'PAUSED', 'COMPLETED', 'DROPPED', 'REPEATING'];
      let which = (localStorage.getItem('kt.anime.listStatus') as AlStatus | null) ?? 'CURRENT';
      const sChips = h('div', { class: 'chip-row wrap list-status' });
      const drawS = () => sChips.replaceChildren(...stats.map((st) => h('button', { type: 'button', class: 'chip small' + (which === st ? ' on' : ''), onclick: () => { which = st as AlStatus; try { localStorage.setItem('kt.anime.listStatus', which); } catch { /* none */ } drawS(); void loadList(); } }, statusName(st as AlStatus))));
      drawS();
      const list = h('div'); body.append(sChips, list);
      let loadsL = 0;
      const loadList = async () => {
        const mine = ++loadsL; list.replaceChildren(spinner());
        try {
          const r = await al.myList(which); if (my !== token || mine !== loadsL) return;
          r.sort((a, b) => { const an = a.nextAiring ? 1 : 0, bn = b.nextAiring ? 1 : 0; const ar = a.entry && (a.nextAiring ? a.nextAiring.episode - 1 : a.episodes ?? 0) > a.entry.progress ? 1 : 0, br = b.entry && (b.nextAiring ? b.nextAiring.episode - 1 : b.episodes ?? 0) > b.entry.progress ? 1 : 0; return br - ar || bn - an; });
          list.replaceChildren(r.length ? grid(r, (a) => { const ready = a.entry && (which === 'CURRENT' || which === 'REPEATING') ? (a.nextAiring ? a.nextAiring.episode - 1 : a.episodes ?? 0) - a.entry.progress : 0; return ready > 0 ? h('span', { class: 'anime-ready' }, icon('download'), readyText(ready)) : null; }) : h('p', { class: 'empty small' }, t('animeListEmpty')));
        } catch (e) { if (mine === loadsL) list.replaceChildren(fail(e)); }
      };
      void loadList(); timer = tickCountdowns(list);
    }
  };
  draw();
  root.dispose = () => { window.clearInterval(timer); token++; };
  return root;
}
/** «٣ حلقات للمشاهدة» — the count with its noun in Arabic and English; CJK strings carry their own counter. */
const readyText = (n: number): string => (getLang() === 'ar' || getLang() === 'en' ? t('animeEpisodesReady', { n: countEpisodes(n) }) : t('animeEpisodesReady', { n }));
export const statusName = (s: al.AlStatus): string => t(({ CURRENT: 'statusWatching', PLANNING: 'statusPlanning', COMPLETED: 'statusCompleted', PAUSED: 'statusPaused', DROPPED: 'statusDropped', REPEATING: 'statusRepeating' } as const)[s]);
