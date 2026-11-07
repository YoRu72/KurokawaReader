// TV & Movies → Schedule, as Anime's: the week's new episodes, day by day, from TVmaze's open schedule (the
// streaming services' and the US channels'), each with its time, its show's picture, its season and episode and how
// long until it airs; the shows you watch or keep on your list first, and a «Yours» filter. A tap opens the show's
// page (by its IMDb id, the way Cinemeta knows it).
import { h, icon } from '../ui/dom';
import { t, localDigits, dateLocale } from '../i18n';
import { navigate } from '../router';
import { request } from '../http';
import { watchlist, watchingIds } from '../tv/library';

interface MazeShow { id: number; name: string; image?: { medium?: string } | null; externals?: { imdb?: string | null }; network?: { name: string } | null; webChannel?: { name: string } | null; type?: string; language?: string | null }
interface MazeEp { id: number; season: number; number: number | null; name: string; airstamp: string; show?: MazeShow; _embedded?: { show: MazeShow } }
interface Row { at: number; show: MazeShow; imdb: string; season: number; episode: number | null; title: string; mine: boolean }

const day = (d: Date) => d.toISOString().slice(0, 10);
const cache = new Map<string, { at: number; eps: MazeEp[] }>();
async function dayOf(url: string): Promise<MazeEp[]> {
  const c = cache.get(url); if (c && Date.now() - c.at < 30 * 60_000) return c.eps;
  const r = await request(url, { headers: { Accept: 'application/json' } }); if (r.status !== 200) throw new Error(`TVmaze: HTTP ${r.status}`);
  const eps = JSON.parse(r.body) as MazeEp[]; cache.set(url, { at: Date.now(), eps }); return eps;
}

export function tvSchedule(body: HTMLElement, live: () => boolean): () => void {
  const head = h('div', { class: 'chip-row tv-sched-head' }); const list = h('div', { class: 'tv-sched' }, h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  body.append(head, list);
  let rows: Row[] = []; let onlyMine = (() => { try { return localStorage.getItem('kt.tv.schedMine') === '1'; } catch { return false; } })();
  let timer = 0;
  const until = async (secs: number) => (await import('./anime')).fmtUntil(secs);
  const paint = async () => {
    const now = Date.now() / 1000; const mineN = rows.filter((r) => r.mine).length;
    const chip = (on: boolean, label: string, fn: () => void) => h('button', { type: 'button', class: 'chip small' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => { fn(); try { localStorage.setItem('kt.tv.schedMine', onlyMine ? '1' : '0'); } catch { /* full */ } void paint(); } }, label);
    head.replaceChildren(chip(!onlyMine, t('tvAll'), () => { onlyMine = false; }), chip(onlyMine, mineN ? `${t('tvSchedMine')} · ${localDigits(mineN)}` : t('tvSchedMine'), () => { onlyMine = true; }));
    const shown = onlyMine ? rows.filter((r) => r.mine) : rows;
    if (!shown.length) { list.replaceChildren(h('p', { class: 'empty small' }, onlyMine ? t('tvSchedMineNone') : t('noResults'))); return; }
    const df = new Intl.DateTimeFormat(dateLocale('prose'), { weekday: 'long', day: 'numeric', month: 'long' }); const tf = new Intl.DateTimeFormat(dateLocale('data'), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const days = new Map<string, Row[]>(); for (const r of shown) { const k = df.format(new Date(r.at * 1000)); (days.get(k) ?? days.set(k, []).get(k)!).push(r); }
    const out: HTMLElement[] = [];
    for (const [d, rs] of days) {
      // (Within a day, yours first, then by the time they air.)
      rs.sort((a, b) => Number(b.mine) - Number(a.mine) || a.at - b.at);
      const rowsEl = await Promise.all(rs.map(async (r) => h('button', { type: 'button', class: 'sched-row' + (r.at <= now ? ' aired' : '') + (r.mine ? ' mine' : ''), onclick: () => navigate(`/tv/series/${r.imdb}${r.season ? `?s=${r.season}` : ''}`) },
        h('span', { class: 'sched-time', dir: 'ltr' }, tf.format(new Date(r.at * 1000))),
        r.show.image?.medium ? h('img', { src: r.show.image.medium.replace(/^http:/, 'https:'), alt: '', loading: 'lazy' }) : h('span', { class: 'sched-noimg' }),
        h('span', { class: 'grow' }, h('span', { class: 'anime-title', dir: 'auto' }, r.show.name, r.mine ? h('span', { class: 'tv-sched-mine', title: t('tvSchedMine') }, icon('bookmark')) : null),
          h('small', { class: 'src', dir: 'auto' }, [`S${String(r.season).padStart(2, '0')}${r.episode != null ? `E${String(r.episode).padStart(2, '0')}` : ''}`, r.title, r.show.webChannel?.name ?? r.show.network?.name].filter(Boolean).join(' · '))),
        h('span', { class: 'sched-until' }, r.at <= now ? t('animeAiredNow') : await until(r.at - now)))));
      out.push(h('section', { class: 'sched-day' }, h('h3', null, d), ...rowsEl));
    }
    if (live()) list.replaceChildren(...out);
  };
  void (async () => {
    try {
      const mine = new Set([...watchlist().map((w) => w.id), ...watchingIds()]);
      const dates = Array.from({ length: 7 }, (_, i) => day(new Date(Date.now() + i * 86400_000)));
      const urls = dates.flatMap((d) => [`https://api.tvmaze.com/schedule/web?date=${d}`, `https://api.tvmaze.com/schedule?country=US&date=${d}`]);
      // (Four at a time: TVmaze asks callers to go easy.)
      const got: MazeEp[][] = []; let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => { while (next < urls.length) { const i = next++; got[i] = await dayOf(urls[i]).catch(() => []); } }));
      if (!live()) return;
      const seen = new Set<number>(); const start = Date.now() / 1000 - 6 * 3600;
      rows = got.flat().map((e) => ({ e, show: e._embedded?.show ?? e.show })).filter((x): x is { e: MazeEp; show: MazeShow } => !!x.show?.externals?.imdb && !seen.has(x.e.id) && !!seen.add(x.e.id))
        .map(({ e, show }) => ({ at: Date.parse(e.airstamp) / 1000, show, imdb: show.externals!.imdb!, season: e.season, episode: e.number, title: e.name, mine: mine.has(show.externals!.imdb!) }))
        .filter((r) => r.at >= start && isFinite(r.at)).sort((a, b) => a.at - b.at);
      if (!rows.length && got.every((x) => !x.length)) throw new Error('TVmaze: nothing came back');
      await paint();
      timer = window.setInterval(() => void paint(), 60_000);
    } catch (e) { if (live()) list.replaceChildren(h('p', { class: 'empty small' }, String((e as Error)?.message ?? e))); }
  })();
  return () => window.clearInterval(timer);
}
