// The Anime tab (shown once the Anime add-on is installed): searching AniList, the season chart with countdowns
// (AniChart's page), the week's airing schedule (LiveChart's), and the user's own watching list — each card
// leading to the show's page, where episodes are found as torrents and progress is tracked.
import { h, icon, iconButton, openSheet, toast, debounce } from '../ui/dom';
import { t, localDigits, countEpisodes, dateLocale, getLang, countDays, countHours, countMinutes } from '../i18n';
import { navigate } from '../router';
import { getSettings } from '../settings';
import * as al from '../anilist';
import * as guide from '../anime/guide';
import type { Anime, Season, AlStatus } from '../anilist';

export type AnimeTab = 'search' | 'season' | 'schedule' | 'list' | 'diary';
const TAB_KEY = 'kt.anime.tab';

export const seasonName = (s: Season): string => t(({ WINTER: 'seasonWinter', SPRING: 'seasonSpring', SUMMER: 'seasonSummer', FALL: 'seasonFall' } as const)[s]);
export const fmtUntil = (secs: number): string => {
  if (secs <= 0) return t('animeAiredNow');
  const d = Math.floor(secs / 86400), hh = Math.floor((secs % 86400) / 3600), m = Math.max(1, Math.floor((secs % 3600) / 60));
  // Arabic counts its nouns: «يومان و٣ ساعات», «ساعة واحدة و٢٠ دقيقةً».
  if (getLang() === 'ar') return d ? `${countDays(d)}${hh ? ` و${countHours(hh)}` : ''}` : hh ? `${countHours(hh)}${m ? ` و${countMinutes(m)}` : ''}` : countMinutes(m);
  return d ? (hh ? t('untilDays', { d, h: hh }) : t('untilDaysOnly', { d })) : hh ? t('untilHours', { h: hh, m }) : t('untilMinutes', { m });
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

export function animeView(tab?: AnimeTab, q?: string, preset?: Partial<al.SearchFilters>): HTMLElement & { dispose?: () => void } {
  let current: AnimeTab = tab ?? ((localStorage.getItem(TAB_KEY) as AnimeTab | null) ?? (al.linked() ? 'list' : 'season'));
  const body = h('div', { class: 'body anime-body' });
  const chips = h('div', { class: 'chips filter-chips' });
  const root = h('div', { class: 'view anime-view' }, h('header', { class: 'topbar' }, h('div', { class: 'title' }, h('span', null, t('navAnime'))), h('div', { class: 'topbar-actions' }, iconButton('puzzle', t('animeProviders'), () => navigate('/settings/anime')))), chips, body) as HTMLElement & { dispose?: () => void };
  const TABS: [AnimeTab, string, string][] = [['search', t('navSearch'), 'search'], ['season', t('animeSeason'), 'calendar'], ['schedule', t('animeSchedule'), 'clock'], ['list', t('animeMyList'), 'bookmark'], ...(al.linked() ? [['diary', t('animeDiary'), 'chart'] as [AnimeTab, string, string]] : [])];
  let timer = 0; let token = 0;
  const drawChips = () => chips.replaceChildren(...TABS.map(([k, label, ic]) => h('button', { type: 'button', class: 'chip' + (current === k ? ' on' : ''), 'aria-pressed': String(current === k), onclick: () => { current = k; localStorage.setItem(TAB_KEY, k); navigate(`/anime?tab=${k}`, true); draw(); } }, icon(ic), label)));
  const grid = (items: Anime[], extra?: (a: Anime) => HTMLElement | null) => h('div', { class: 'anime-grid' }, ...items.map((a) => animeCard(a, extra?.(a))));
  const spinner = () => h('div', { class: 'center' }, h('div', { class: 'spinner' }));
  const fail = (e: unknown) => h('p', { class: 'empty small' }, String((e as Error)?.message ?? e));

  /** «+ Plan» on a card of a show not on the list (the Season Guide's quick add). */
  const planBtn = (a: Anime): HTMLElement | null => (!al.linked() || a.entry ? null : h('span', { class: 'plan-chip', role: 'button', tabindex: '0', onclick: async (e: Event) => { e.stopPropagation(); const el = e.currentTarget as HTMLElement; el.classList.add('busy'); try { const r = await al.saveOrQueue(a.id, { status: 'PLANNING', progress: 0, score: 0 }); a.entry = r.entry; el.replaceWith(h('span', { class: 'plan-chip done' }, icon('check'), t('statusPlanning'))); } catch (er) { toast(String((er as Error).message ?? er), 'error'); el.classList.remove('busy'); } } }, icon('plus'), t('plan')));
  const draw = () => {
    drawChips(); window.clearInterval(timer); const my = ++token; body.replaceChildren();
    if (current === 'search') {
      // Words, and AniList's filters (genres, tags, format, status, season, year, sort): any alone browses by it.
      const f = searchFilters(); if (q !== undefined && !preset) f.q = q; if (preset) { Object.assign(f, preset); preset = undefined; }
      const input = h('input', { type: 'search', class: 'search-input', placeholder: t('animeSearchHint'), value: f.q ?? '', enterkeyhint: 'search' }) as HTMLInputElement;
      const results = h('div'); const active = h('div', { class: 'chip-row wrap anime-active' });
      const fbtn = h('button', { type: 'button', class: 'btn tonal small anime-filter-btn', onclick: () => filterSheet(f, () => { saveFilters(f); drawActive(); void run(); }) }, icon('filter'), t('animeFilters')) as HTMLButtonElement;
      let runs = 0; let page = 1; let all: Anime[] = [];
      const drawActive = () => {
        const n = (f.genres?.length ?? 0) + (f.tags?.length ?? 0) + (f.notTags?.length ?? 0) + (f.formats?.length ?? 0) + (f.status ? 1 : 0) + (f.season ? 1 : 0) + (f.year ? 1 : 0) + (f.minScore ? 1 : 0);
        fbtn.lastChild!.textContent = n ? `${t('animeFilters')} · ${localDigits(n)}` : t('animeFilters');
        const x = (label: string, rm: () => void, cls = '') => h('button', { type: 'button', class: 'chip small on ' + cls, onclick: () => { rm(); saveFilters(f); drawActive(); void run(); } }, h('span', { dir: 'auto' }, label), icon('close'));
        active.replaceChildren(...(f.genres ?? []).map((g) => x(g, () => { f.genres = f.genres!.filter((y) => y !== g); })), ...(f.tags ?? []).map((g) => x(`#${g}`, () => { f.tags = f.tags!.filter((y) => y !== g); })), ...(f.notTags ?? []).map((g) => x(`−${g}`, () => { f.notTags = f.notTags!.filter((y) => y !== g); }, 'not')),
          ...(f.formats ?? []).map((g) => x(fmtFormat(g), () => { f.formats = f.formats!.filter((y) => y !== g); })), ...(f.status ? [x(t(STATUS_LABEL[f.status] as 'animeAired'), () => { f.status = undefined; })] : []),
          ...(f.season ? [x(seasonName(f.season), () => { f.season = undefined; })] : []), ...(f.year ? [x(localDigits(f.year), () => { f.year = undefined; })] : []), ...(f.minScore ? [x(`≥ ${localDigits(f.minScore)}%`, () => { f.minScore = undefined; })] : []),
          ...(n ? [h('button', { type: 'button', class: 'chip small text', onclick: () => { Object.assign(f, { genres: [], tags: [], notTags: [], formats: [], status: undefined, season: undefined, year: undefined, minScore: undefined }); saveFilters(f); drawActive(); void run(); } }, t('clearAll'))] : []));
      };
      const more = h('button', { type: 'button', class: 'btn tonal small anime-more', hidden: true, onclick: () => void run(true) }, t('loadMore')) as HTMLButtonElement;
      const run = async (next = false) => {
        f.q = input.value.trim(); saveFilters(f); const mine = ++runs;
        const any = f.q || f.genres?.length || f.tags?.length || f.formats?.length || f.status || f.season || f.year || f.minScore;
        if (!any) { results.replaceChildren(h('p', { class: 'hint' }, t('animeSearchStart'))); more.hidden = true; void tagSuggestions(results, (g) => { f.genres = [...new Set([...(f.genres ?? []), g])]; saveFilters(f); drawActive(); void run(); }); return; }
        if (!next) { page = 1; all = []; results.replaceChildren(spinner()); } else { page++; more.disabled = true; }
        try {
          const r = await al.searchBy({ ...f, adult: getSettings().animeAdult }, page); if (my !== token || mine !== runs) return;
          all = all.concat(r.media); results.replaceChildren(all.length ? grid(all) : h('p', { class: 'empty small' }, t('noResults')), more); more.hidden = !r.hasNext; more.disabled = false;
        } catch (e) { if (mine === runs) results.replaceChildren(fail(e)); }
      };
      input.addEventListener('input', debounce(() => void run(), 400));
      body.append(h('form', { class: 'search-form row', onsubmit: (e: Event) => { e.preventDefault(); void run(); } }, input, fbtn), active, results);
      drawActive(); void run(); setTimeout(() => input.focus(), 50);
    } else if (current === 'season') {
      let at = al.seasonOf(); let adult = getSettings().animeAdult; let leftovers = false; let sort = 'POPULARITY_DESC';
      const head = h('div', { class: 'season-head' }); const list = h('div');
      let loads = 0;
      const load = async () => {
        const mine = ++loads;
        head.replaceChildren(iconButton('chevronLeft', t('back'), () => { at = al.seasonShift(at, -1); void load(); }), h('h2', null, `${seasonName(at.season)} ${localDigits(at.year)}`), iconButton('chevronRight', t('next'), () => { at = al.seasonShift(at, 1); void load(); }),
          h('div', { class: 'grow' }), h('button', { type: 'button', class: 'chip' + (leftovers ? ' on' : ''), onclick: () => { leftovers = !leftovers; void load(); } }, t('animeLeftovers')),
          h('button', { type: 'button', class: 'chip', onclick: () => { const order = ['POPULARITY_DESC', 'SCORE_DESC', 'START_DATE', ...(al.linked() ? ['FOR_YOU'] : [])]; sort = order[(order.indexOf(sort) + 1) % order.length]; void load(); } }, icon('sort'), t(sort === 'POPULARITY_DESC' ? 'sortPopular' : sort === 'SCORE_DESC' ? 'sortScore' : sort === 'FOR_YOU' ? 'sortForYou' : 'sortDate')));
        list.replaceChildren(spinner());
        try {
          let r: Anime[];
          if (leftovers) r = await al.leftovers(al.seasonShift(at, -1).season, al.seasonShift(at, -1).year, adult);
          else { r = []; for (let page = 1; page <= 4; page++) { const c = await al.seasonChart(at.season, at.year, { adult, sort: sort === 'FOR_YOU' ? 'POPULARITY_DESC' : sort, page }); if (my !== token || mine !== loads) return; r.push(...c.media); if (page === 1 && sort !== 'FOR_YOU') list.replaceChildren(grid(r, planBtn)); if (!c.hasNext) break; } }
          if (my !== token || mine !== loads) return;
          // «For you»: the season in the order of your taste, each card with how well it fits.
          if (sort === 'FOR_YOU') { const w = await guide.taste().catch(() => new Map<string, number>()); if (my !== token || mine !== loads) return; const fits = new Map(r.map((a) => [a.id, guide.fit(a, w)])); r = [...r].sort((x, y) => fits.get(y.id)! - fits.get(x.id)!); list.replaceChildren(grid(r, (a) => { const f = fits.get(a.id)!; const pl = planBtn(a); return h('span', { class: 'anime-fit' }, h('b', null, `${localDigits(f)}%`), ' ', t('fitForYou'), pl); })); return; }
          // The season's top ten as tiers, above the grid.
          if (!leftovers && r.length > 12) { const top = guide.tiers(r); list.replaceChildren(h('div', { class: 'tier-strip' }, ...(['S', 'A', 'B', 'C'] as const).map((tier) => h('div', { class: `tier-row t-${tier}` }, h('b', { class: 'tier-letter' }, tier), h('div', { class: 'tier-items' }, ...top.filter((x) => x.tier === tier).map(({ a }) => h('button', { type: 'button', class: 'tier-item', title: titleOf(a), onclick: () => navigate(`/anime/${a.id}`) }, a.cover ? h('img', { src: a.cover, alt: '', loading: 'lazy' }) : icon('film'))))))), grid(r, planBtn)); return; }
          // The shows on the user's list first within the season's order, so «what am I watching this season» is on top.
          list.replaceChildren(r.length ? grid(r, planBtn) : h('p', { class: 'empty small' }, t('noResults')));
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
    } else if (current === 'diary') {
      const sub = h('div', { class: 'chip-row wrap list-status' }); const out = h('div'); body.append(sub, out); let which = localStorage.getItem('kt.anime.diary') ?? 'calendar';
      const drawSub = () => sub.replaceChildren(...([['calendar', t('diaryCalendar')], ['unfinished', t('diaryUnfinished')], ['year', t('diaryYear')]] as const).map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (which === k ? ' on' : ''), onclick: () => { which = k; try { localStorage.setItem('kt.anime.diary', k); } catch { /* none */ } drawSub(); void show(); } }, l)));
      let acts: Awaited<ReturnType<typeof guide.activities>> | null = null;
      const show = async () => {
        out.replaceChildren(spinner());
        try {
          if (which === 'unfinished') { const u = await guide.unfinished(); if (my !== token) return; out.replaceChildren(u.length ? grid(u.map((x) => x.a), (a) => { const x = u.find((y) => y.a.id === a.id)!; return h('span', { class: 'anime-facts' }, [x.behind ? t('diaryBehind', { n: countEpisodes(x.behind) }) : '', new Intl.DateTimeFormat(dateLocale('prose'), { day: 'numeric', month: 'short' }).format(new Date(x.updatedAt * 1000))].filter(Boolean).join(' · ')); }) : h('p', { class: 'empty small' }, t('animeListEmpty'))); return; }
          acts ??= await guide.activities(); if (my !== token) return;
          if (which === 'calendar') out.replaceChildren(diaryCalendar(guide.diaryDays(acts)));
          else out.replaceChildren(diaryYear(acts));
        } catch (e) { out.replaceChildren(fail(e)); }
      };
      drawSub(); void show();
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

/** The year as a heatmap of episodes watched (each day a square, darker for more), and the days listed below. */
function diaryCalendar(days: Map<string, guide.DiaryDay>): HTMLElement {
  const year = new Date().getFullYear(); let shownYear = year;
  const box = h('div', { class: 'diary' }); const detail = h('div', { class: 'diary-day' });
  const draw = () => {
    const start = new Date(shownYear, 0, 1); const cells: HTMLElement[] = []; const lead = start.getDay();
    for (let i = 0; i < lead; i++) cells.push(h('i', { class: 'hm empty' }));
    for (let d = new Date(start); d.getFullYear() === shownYear; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; const day = days.get(key);
      const n = day ? day.items.reduce((s, x) => s + Math.max(1, x.episodes.length), 0) : 0; const lvl = n === 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : n < 8 ? 3 : 4;
      const cell = h('button', { type: 'button', class: `hm l${lvl}`, title: key, onclick: () => showDay(key) }); cells.push(cell);
    }
    box.replaceChildren(h('div', { class: 'season-head' }, iconButton('chevronLeft', t('back'), () => { shownYear--; draw(); }), h('h2', null, localDigits(shownYear, 'prose')), iconButton('chevronRight', t('next'), () => { if (shownYear < year) { shownYear++; draw(); } })), h('div', { class: 'heatmap' }, ...cells), detail);
    const recent = [...days.keys()].filter((k) => k.startsWith(String(shownYear))).sort().pop(); if (recent) showDay(recent); else detail.replaceChildren();
    // (Today's end of the year in view.)
    requestAnimationFrame(() => { const hm = box.querySelector<HTMLElement>('.heatmap'); if (hm) hm.scrollLeft = hm.scrollWidth; });
  };
  const showDay = (key: string) => { const d = days.get(key); const df = new Intl.DateTimeFormat(dateLocale('prose'), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); detail.replaceChildren(h('h3', null, df.format(new Date(`${key}T12:00:00`))), ...(d ? d.items.map((it) => h('button', { type: 'button', class: 'sched-row', onclick: () => navigate(`/anime/${it.id}`) }, it.cover ? h('img', { src: it.cover, alt: '', loading: 'lazy' }) : h('span', { class: 'sched-noimg' }), h('span', { class: 'grow' }, h('span', { class: 'anime-title', dir: 'auto' }, it.title), h('small', { class: 'src' }, it.episodes.length ? t('diaryEpisodes', { n: [...new Set(it.episodes)].sort((a, b) => a - b).map((x) => localDigits(x, 'prose')).join('، ') }) : statusText(it.status))))) : [h('p', { class: 'empty small' }, t('diaryNothing'))])); };
  draw(); return box;
}
const statusText = (s: string) => (/completed/.test(s) ? t('statusCompleted') : /dropped/.test(s) ? t('statusDropped') : /paused/.test(s) ? t('statusPaused') : /plans/.test(s) ? t('statusPlanning') : s);
/** The year in review: episodes, hours, shows, the longest streak, the busiest day, months, top shows, genres, studios. */
function diaryYear(acts: Awaited<ReturnType<typeof guide.activities>>): HTMLElement {
  let y = new Date().getFullYear(); const box = h('div', { class: 'diary' });
  const draw = () => {
    const r = guide.yearReview(acts, y); const max = Math.max(1, ...r.months);
    const stat = (v: string, l: string) => h('div', { class: 'stat' }, h('b', null, v), h('small', null, l));
    const bars = (rows: [string, number][]) => h('div', { class: 'bars' }, ...rows.map(([k, v]) => h('div', { class: 'bar-row' }, h('span', { class: 'grow', dir: 'auto' }, k), h('i', { style: { inlineSize: `${(v / Math.max(1, rows[0]?.[1] ?? 1)) * 60}%` } }), h('small', null, localDigits(v, 'prose')))));
    const mf = new Intl.DateTimeFormat(dateLocale('prose'), { month: 'short' });
    box.replaceChildren(h('div', { class: 'season-head' }, iconButton('chevronLeft', t('back'), () => { y--; draw(); }), h('h2', null, localDigits(y, 'prose')), iconButton('chevronRight', t('next'), () => { if (y < new Date().getFullYear()) { y++; draw(); } })),
      h('div', { class: 'stats' }, stat(localDigits(r.episodes, 'prose'), t('diaryStatEpisodes')), stat(localDigits(Math.round(r.minutes / 60), 'prose'), t('diaryStatHours')), stat(localDigits(r.shows, 'prose'), t('diaryStatShows')), stat(localDigits(r.completed, 'prose'), t('statusCompleted')), stat(localDigits(r.longestStreak, 'prose'), t('diaryStatStreak'))),
      ...(r.busiest ? [h('p', { class: 'src' }, t('diaryBusiest', { date: new Intl.DateTimeFormat(dateLocale('prose'), { day: 'numeric', month: 'long' }).format(new Date(`${r.busiest.date}T12:00:00`)), n: countEpisodes(r.busiest.episodes) }))] : []),
      h('div', { class: 'months' }, ...r.months.map((v, i) => h('div', { class: 'month' }, h('i', { style: { blockSize: `${(v / max) * 100}%` } }), h('small', null, mf.format(new Date(y, i, 1)))))),
      ...(r.top.length ? [h('h3', null, t('diaryTopShows')), bars(r.top)] : []), ...(r.genres.length ? [h('h3', null, t('diaryTopGenres')), bars(r.genres)] : []), ...(r.studios.length ? [h('h3', null, t('diaryTopStudios')), bars(r.studios)] : []));
  };
  draw(); return box;
}

/* ---------- the search's filters ---------- */
const FKEY = 'kt.anime.search';
function searchFilters(): al.SearchFilters { try { return { genres: [], tags: [], notTags: [], formats: [], ...(JSON.parse(localStorage.getItem(FKEY) ?? '{}') as al.SearchFilters) }; } catch { return { genres: [], tags: [], notTags: [], formats: [] }; } }
function saveFilters(f: al.SearchFilters): void { try { localStorage.setItem(FKEY, JSON.stringify(f)); } catch { /* full */ } }
const STATUS_LABEL: Record<string, string> = { RELEASING: 'animeStatusReleasing', FINISHED: 'animeStatusFinished', NOT_YET_RELEASED: 'animeNotYet', HIATUS: 'animeStatusHiatus' };
const SORTS: [string, string][] = [['POPULARITY_DESC', 'sortPopular'], ['SCORE_DESC', 'sortScore'], ['TRENDING_DESC', 'sortTrending'], ['START_DATE_DESC', 'sortNewest'], ['FAVOURITES_DESC', 'sortFavourites'], ['TITLE_ROMAJI', 'sortTitle']];
/** Genres to start from when nothing is asked yet. */
async function tagSuggestions(out: HTMLElement, pick: (g: string) => void): Promise<void> {
  try { const { genres } = await al.genresAndTags(); if (!out.isConnected) return; out.append(h('div', { class: 'chip-row wrap genre-start' }, ...genres.map((g) => h('button', { type: 'button', class: 'chip', onclick: () => pick(g) }, g)))); } catch { /* offline */ }
}
/** The filters sheet: genres, tags (by category, searchable; a tap includes, a second leaves out, a third clears),
 *  format, status, season and year, minimum score, sort. */
function filterSheet(f: al.SearchFilters, done: () => void): void {
  const sh = openSheet(t('animeFilters'), t('close')); sh.el.classList.add('anime-filters');
  const sec = (title: string, ...kids: Node[]) => h('section', { class: 'af-sec' }, h('h4', null, title), ...kids);
  const toggle = (list: 'genres' | 'formats', v: string, label: string) => { const b = h('button', { type: 'button', class: 'chip small' + (f[list]?.includes(v) ? ' on' : ''), onclick: () => { const l = new Set(f[list] ?? []); if (l.has(v)) l.delete(v); else l.add(v); f[list] = [...l]; b.classList.toggle('on', l.has(v)); } }, label); return b; };
  const genres = h('div', { class: 'chip-row wrap' }, h('div', { class: 'spinner small' }));
  const tagQ = h('input', { type: 'search', class: 'search-input small', placeholder: t('animeTagSearch') }) as HTMLInputElement;
  const tags = h('div', { class: 'af-tags' });
  let allTags: al.AlTag[] = [];
  const tagChip = (tg: al.AlTag) => { const st = () => (f.tags?.includes(tg.name) ? 'on' : f.notTags?.includes(tg.name) ? 'not' : ''); const b = h('button', { type: 'button', class: 'chip small ' + st(), title: tg.description ?? '', onclick: () => { const cur = st(); f.tags = (f.tags ?? []).filter((x) => x !== tg.name); f.notTags = (f.notTags ?? []).filter((x) => x !== tg.name); if (cur === '') f.tags.push(tg.name); else if (cur === 'on') f.notTags.push(tg.name); b.className = 'chip small ' + st(); } }, tg.name); return b; };
  const drawTags = () => {
    const needle = tagQ.value.trim().toLowerCase(); const adult = getSettings().animeAdult;
    const list = allTags.filter((x) => (adult || !x.isAdult) && (!needle || x.name.toLowerCase().includes(needle) || x.category.toLowerCase().includes(needle)));
    const cats = new Map<string, al.AlTag[]>(); for (const x of list) (cats.get(x.category) ?? cats.set(x.category, []).get(x.category)!).push(x);
    tags.replaceChildren(...[...cats].map(([c, xs]) => h('details', { class: 'af-cat', open: !!needle || xs.some((x) => f.tags?.includes(x.name) || f.notTags?.includes(x.name)) }, h('summary', null, c, h('small', { class: 'src' }, ` ${localDigits(xs.length)}`)), h('div', { class: 'chip-row wrap' }, ...xs.map(tagChip)))));
  };
  tagQ.addEventListener('input', drawTags);
  void al.genresAndTags().then(({ genres: gs, tags: ts }) => { genres.replaceChildren(...gs.map((g) => toggle('genres', g, g))); allTags = ts; drawTags(); }).catch((e) => genres.replaceChildren(h('small', { class: 'src' }, String((e as Error).message ?? e))));
  const formats = h('div', { class: 'chip-row wrap' }, ...['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'].map((x) => toggle('formats', x, fmtFormat(x))));
  const one = <K extends 'status' | 'season' | 'sort'>(k: K, opts: [string, string][]) => { const row = h('div', { class: 'chip-row wrap' }); const draw = () => row.replaceChildren(...opts.map(([v, l]) => h('button', { type: 'button', class: 'chip small' + ((f[k] ?? '') === v ? ' on' : ''), onclick: () => { (f as Record<string, unknown>)[k] = (f[k] ?? '') === v && k !== 'sort' ? undefined : v || undefined; draw(); } }, l))); draw(); return row; };
  const year = h('input', { type: 'number', min: '1940', max: String(new Date().getFullYear() + 2), value: f.year ? String(f.year) : '', placeholder: t('animeYear'), inputmode: 'numeric', class: 'num-small', onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); f.year = v >= 1940 ? v : undefined; } });
  const score = h('input', { type: 'range', min: '0', max: '90', step: '5', value: String(f.minScore ?? 0) }) as HTMLInputElement; const scoreOut = h('output', null, f.minScore ? `≥ ${localDigits(f.minScore)}%` : t('animeAny'));
  score.addEventListener('input', () => { const v = Number(score.value); f.minScore = v || undefined; scoreOut.textContent = v ? `≥ ${localDigits(v)}%` : t('animeAny'); });
  sh.body.append(
    sec(t('animeSort'), one('sort', SORTS.map(([v, l]) => [v, t(l as 'sortPopular')]))),
    sec(t('animeGenres'), genres),
    sec(t('animeTags'), h('p', { class: 'hint' }, t('animeTagsHint')), tagQ, tags),
    sec(t('animeFormat'), formats),
    sec(t('animeStatus'), one('status', Object.entries(STATUS_LABEL).map(([v, l]) => [v, t(l as 'animeAired')]))),
    sec(t('animeSeasonYear'), one('season', al.SEASONS.map((x) => [x, seasonName(x)])), year),
    sec(t('animeMinScore'), h('div', { class: 'score-row' }, score, scoreOut)));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); done(); } }, icon('search'), t('animeShowResults')));
}

