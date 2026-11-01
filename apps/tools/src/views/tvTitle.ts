// A film's or a series' page: its picture, facts and summary, the cast, the trailer; the watchlist and «follow»
// (new episodes fetched as they air); a series' seasons and episodes — each marked seen or not, tapped to watch
// now (the best release from Torrentio, played while it comes), download it, or choose a release; a film the same.
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t, localDigits, formatBytes, dateLocale } from '../i18n';
import { back, navigate } from '../router';
import { getEngine } from '../engine';
import type { Task } from '../engine/types';
import { openExternal } from '../native';
import * as cm from '../tv/cinemeta';
import type { TvMeta, TvKind, TvEpisode } from '../tv/cinemeta';
import { streams, bestOf, tvPrefs, type TvRelease } from '../tv/torrentio';
import * as lib from '../tv/library';
import { magnetOf } from '../anime/providers';
import { parseFilename } from '../anime/anitomy';

const epKey = (m: TvMeta, v: { season: number; episode: number }) => `${m.id}:${v.season}:${v.episode}`;
const label = (r: TvRelease) => [r.resolution ?? '', r.size ? formatBytes(r.size) : '', r.packSize && r.packSize !== r.size ? `${t('tvPack')} ${formatBytes(r.packSize)}` : '', `↑${localDigits(r.seeders)}`, r.cached ? t('tvCached') : '', r.provider].filter(Boolean).join(' · ');

/** The downloads of this title (by its IMDb id, and season/episode). */
async function tasksOf(id: string): Promise<Task[]> { try { return (await getEngine().list()).filter((x) => (x.meta as { imdbId?: string } | undefined)?.imdbId === id); } catch { return []; } }

export function tvTitleView(type: TvKind, id: string, season?: number): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'body anime-entry tv-entry' }, h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  const title = h('div', { class: 'title' }, h('span', null, ''));
  const root = h('div', { class: 'view anime-entry-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/tv')), title), body) as HTMLElement & { dispose?: () => void };
  let m: TvMeta | null = null; let gone = false; let tasks: Task[] = []; let sel = season ?? -1;
  const draw = () => {
    if (!m || gone) return; const mm = m;
    (title.firstChild as HTMLElement).textContent = mm.name;
    const facts = [mm.type === 'movie' ? t('tvFilm') : t('tvSeries'), mm.releaseInfo ?? mm.year ?? '', mm.runtime ?? '', mm.imdbRating ? `IMDb ★ ${localDigits(mm.imdbRating)}` : '', mm.country ?? ''].filter(Boolean).join(' · ');
    const inWl = lib.inWatchlist(mm.id); const fol = lib.followOf(mm.id);
    const head = h('section', { class: 'anime-head tv-head-sec' },
      mm.background ? h('img', { class: 'anime-banner', src: mm.background, alt: '' }) : null,
      h('div', { class: 'anime-head-row' }, h('div', { class: 'anime-cover big' }, mm.poster ? h('img', { src: mm.poster, alt: '' }) : icon('film')),
        h('div', { class: 'anime-head-text' }, h('h2', { dir: 'auto' }, mm.name), h('p', { class: 'anime-facts' }, facts),
          h('div', { class: 'chips' }, ...mm.genres.slice(0, 5).map((g) => h('span', { class: 'chip small' }, g))),
          h('div', { class: 'row-actions wrap' },
            h('button', { type: 'button', class: 'btn small ' + (inWl ? 'tonal on' : 'tonal'), onclick: () => { const on = lib.toggleWatchlist(mm); toast(on ? t('tvAddedWl') : t('tvRemovedWl')); draw(); } }, icon('bookmark'), inWl ? t('tvInWatchlist') : t('tvAddWatchlist')),
            mm.type === 'series' ? h('button', { type: 'button', class: 'btn small ' + (fol?.enabled ? 'tonal on' : 'text'), onclick: () => followSheet(mm, draw) }, icon('bell'), fol?.enabled ? t('autoOn') : t('tvFollow')) : null,
            mm.trailer ? h('button', { type: 'button', class: 'btn small text', onclick: () => void openExternal(`https://www.youtube.com/watch?v=${mm.trailer}`) }, icon('play'), t('tvTrailer')) : null))));
    const syn = mm.description ? h('section', { class: 'card anime-synopsis' }, h('h3', null, t('animeSynopsis')), h('p', { class: 'clamp', dir: 'auto', onclick: (ev: Event) => (ev.currentTarget as HTMLElement).classList.toggle('clamp') }, mm.description),
      mm.cast?.length ? h('p', { class: 'src tv-cast' }, `${t('tvCast')}: ${mm.cast.join('، ')}`) : null, mm.director?.length ? h('p', { class: 'src' }, `${t('tvDirector')}: ${mm.director.join('، ')}`) : null) : null;
    let main: HTMLElement;
    if (mm.type === 'movie') {
      const got = tasks[0]; const seenIt = lib.isSeen(mm.id);
      main = h('section', { class: 'card tv-movie' }, h('h3', null, t('tvWatch')),
        got ? progressLine(got) : null,
        h('div', { class: 'row-actions wrap' },
          h('button', { type: 'button', class: 'btn primary', onclick: () => void watch(mm) }, icon('play'), got?.state === 'done' ? t('play') : t('epWatchNow')),
          !got ? h('button', { type: 'button', class: 'btn tonal', onclick: () => void downloadBest(mm) }, icon('download'), t('epDownloadBest')) : null,
          h('button', { type: 'button', class: 'btn text', onclick: () => void releasesSheet(mm) }, icon('magnet'), t('epChoose')),
          h('button', { type: 'button', class: 'btn text', onclick: () => { lib.setSeen(mm.id, !seenIt); draw(); } }, icon(seenIt ? 'check' : 'circle'), seenIt ? t('animeSeen') : t('animeMarkSeen'))));
    } else {
      const seasons = cm.seasonsOf(mm); const next = lib.nextUp(mm);
      if (sel < 0) sel = next?.season ?? seasons[0] ?? 1;
      const eps = (mm.videos ?? []).filter((v) => v.season === sel);
      const df = new Intl.DateTimeFormat(dateLocale('data'), { day: 'numeric', month: 'short', year: 'numeric' });
      main = h('section', { class: 'card anime-episodes' },
        h('div', { class: 'card-head' }, h('h3', null, t('episodes')), h('div', { class: 'grow' }),
          next ? h('button', { type: 'button', class: 'btn primary small', onclick: () => void watch(mm, next) }, icon('play'), `${t('epWatchNow')} · S${localDigits(next.season)}E${localDigits(next.episode)}`) : null),
        h('div', { class: 'chip-row wrap ep-ranges' }, ...seasons.map((s) => h('button', { type: 'button', class: 'chip small' + (s === sel ? ' on' : ''), onclick: () => { sel = s; draw(); } }, s === 0 ? t('tvSpecials') : t('tvSeasonN', { n: localDigits(s) })))),
        h('div', { class: 'row-actions wrap' }, h('button', { type: 'button', class: 'btn text small', onclick: () => { const all = eps.filter((v) => cm.aired(v)); const allSeen = all.every((v) => lib.isSeen(epKey(mm, v))); for (const v of all) lib.setSeen(epKey(mm, v), !allSeen); draw(); } }, icon('check'), t('tvSeasonSeen'))),
        ...eps.map((v) => {
          const aired = cm.aired(v); const seen = lib.isSeen(epKey(mm, v)); const got = tasks.find((x) => x.meta?.season === v.season && x.meta?.episode === v.episode);
          return h('div', { class: 'ep-row' + (seen ? ' seen' : '') + (aired ? '' : ' future') + (got ? ' have' : ''), dataset: { se: `${v.season}:${v.episode}` }, role: aired ? 'button' : undefined, tabindex: aired ? '0' : undefined, onclick: (ev: Event) => { if (!aired || (ev.target as Element).closest('button')) return; episodeSheet(mm, v, got); } },
            v.thumbnail ? h('img', { class: 'ep-thumb', src: v.thumbnail, alt: '', loading: 'lazy' }) : h('span', { class: 'ep-num' }, localDigits(v.episode)),
            h('span', { class: 'grow' }, h('span', { class: 'ep-title', dir: 'auto' }, `${localDigits(v.episode)}. ${v.name || t('episodeN', { n: v.episode })}`, got ? h('span', { class: 'ep-badge have' }, got.state === 'done' ? t('downloaded') : t('downloading', { p: localDigits(got.total ? Math.round((got.done / got.total) * 100) : 0) })) : null),
              h('small', { class: 'src' }, v.released ? (aired ? df.format(new Date(v.released)) : `${t('animeNotYet')} · ${df.format(new Date(v.released))}`) : ''),
              got && got.state !== 'done' ? h('div', { class: 'task-bar thin ep-prog' }, h('i', { style: { width: `${got.total ? Math.round((got.done / got.total) * 100) : 2}%` } })) : null),
            aired ? iconButton('play', t('epWatchNow'), () => void watch(mm, v)) : null,
            aired ? iconButton(seen ? 'check' : 'circle', seen ? t('animeSeen') : t('animeMarkSeen'), () => { lib.setSeen(epKey(mm, v), !seen); draw(); }) : null);
        }));
    }
    body.replaceChildren(...[head, main, syn].filter((x): x is HTMLElement => !!x));
  };
  const episodeSheet = (mm: TvMeta, v: TvEpisode, got?: Task) => {
    const sh = openSheet(`${mm.name} · S${localDigits(v.season)}E${localDigits(v.episode)}`, t('close')); sh.el.classList.add('ep-sheet');
    sh.body.append(h('div', { class: 'ep-sheet-head' }, v.thumbnail ? h('img', { src: v.thumbnail, alt: '' }) : h('span', { class: 'ep-num big' }, localDigits(v.episode)), h('div', null, h('b', { dir: 'auto' }, v.name), v.overview ? h('p', { class: 'src clamp', dir: 'auto' }, v.overview) : null)));
    if (got) sh.body.append(progressLine(got));
    const row = (ic: string, l: string, hint: string, fn: () => void, primary = false) => sh.body.append(h('button', { type: 'button', class: 'dest-row' + (primary ? ' primary' : ''), onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, h('span', null, l), hint ? h('small', { class: 'src' }, hint) : null)));
    row('play', got?.state === 'done' ? t('play') : t('epWatchNow'), got ? '' : t('epWatchNowHint'), () => void watch(mm, v), true);
    if (!got) row('download', t('epDownloadBest'), t('tvBestHint'), () => void downloadBest(mm, v));
    row('magnet', t('epChoose'), t('epChooseHint'), () => void releasesSheet(mm, v));
    if (got) row('info', t('details'), '', () => navigate(`/task/${encodeURIComponent(got.id)}`));
  };
  const load = async () => { try { m = await cm.meta(type, id); tasks = await tasksOf(id); draw(); } catch (e) { body.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); } };
  const off = getEngine().onChange((ts) => { if (!m || gone) return; const mine = ts.filter((x) => (x.meta as { imdbId?: string } | undefined)?.imdbId === id); const changed = mine.length !== tasks.length || mine.some((x, i) => x.state !== tasks[i]?.state); tasks = mine; if (changed) { draw(); return; }
    // (Only the bars moved: each episode's bar set in place.)
    for (const x of mine) { const bar = body.querySelector<HTMLElement>(x.meta?.season !== undefined ? `.ep-row[data-se="${x.meta.season}:${x.meta.episode}"] .ep-prog i` : '.tv-movie .task-bar i'); if (bar) bar.style.width = `${x.total ? Math.round((x.done / x.total) * 100) : 2}%`; } });
  void load();
  root.dispose = () => { gone = true; off(); };
  return root;
}
function progressLine(x: Task): HTMLElement {
  const pct = x.state === 'done' ? 100 : x.total ? Math.round((x.done / x.total) * 100) : 0;
  return h('div', { class: 'ep-sheet-prog' }, h('div', { class: 'task-bar' }, h('i', { style: { width: `${pct}%` } })), h('small', { class: 'src' }, x.state === 'done' ? t('downloaded') : t('downloading', { p: localDigits(pct) })));
}
const idOf = (m: TvMeta, v?: TvEpisode) => (v ? `${m.id}:${v.season}:${v.episode}` : m.id);
const titleOf = (m: TvMeta, v?: TvEpisode) => (v ? `${m.name} · S${String(v.season).padStart(2, '0')}E${String(v.episode).padStart(2, '0')}` : m.name);
const metaOf = (m: TvMeta, r: TvRelease, v?: TvEpisode): Task['meta'] => ({ imdbId: m.id, title: m.name, season: v?.season, episode: v?.episode, cover: m.poster, provider: r.provider, hash: r.hash, fileIdx: r.fileIdx });
/** The episode's file in a release (its own index from Torrentio, else matched by S/E, else the largest video). */
function pickFile(x: Task, v?: TvEpisode): number {
  const vids = x.files.filter((f) => /\.(mkv|mp4|m4v|webm|avi|mov|ts)$/i.test(f.path)); if (!vids.length) return x.files[0]?.index ?? 0;
  if (v && vids.length > 1) { const m = vids.find((f) => { const p = parseFilename(f.path.split('/').pop() ?? f.path); return p.episode === v.episode && (p.season ?? v.season) === v.season; }); if (m) return m.index; }
  return [...vids].sort((a, b) => b.size - a.size)[0].index;
}
async function watch(m: TvMeta, v?: TvEpisode): Promise<void> {
  const { watchWith } = await import('../anime/watch');
  await watchWith({ title: titleOf(m, v), have: async () => (await tasksOf(m.id)).find((x) => (v ? x.meta?.season === v.season && x.meta?.episode === v.episode : true)), find: async () => bestOf(await streams(m.type, idOf(m, v))), meta: (r) => metaOf(m, r as TvRelease, v), pick: (x) => pickFile(x, v) });
}
async function downloadBest(m: TvMeta, v?: TvEpisode): Promise<void> {
  toast(t('watchFinding'));
  try { const best = bestOf(await streams(m.type, idOf(m, v))); if (!best) { toast(t('watchNone'), 'error', 5000); void releasesSheet(m, v); return; } await addRelease(m, best, v); }
  catch (e) { toast(String((e as Error).message ?? e), 'error', 6000); }
}
async function addRelease(m: TvMeta, r: TvRelease, v?: TvEpisode): Promise<void> {
  const tk = await getEngine().add({ source: r.url ? { url: r.url } : { magnet: magnetOf(r) }, name: r.url ? (r.file ?? r.title) : undefined, sequential: true, files: !r.url && r.fileIdx !== undefined ? [r.fileIdx] : undefined, meta: metaOf(m, r, v) });
  toast(t('taskAdded', { name: tk.name || r.title }));
}
/** Every release Torrentio has for a film or an episode: filtered by quality, ordered as asked, one tap to add. */
async function releasesSheet(m: TvMeta, v?: TvEpisode): Promise<void> {
  const sh = openSheet(titleOf(m, v), t('close'));
  const list = h('div', { class: 'torrent-list' }, h('div', { class: 'center' }, h('div', { class: 'spinner' }))); const tools = h('div', { class: 'chip-row wrap search-tools' });
  sh.body.append(tools, list);
  let all: TvRelease[] = []; let qual = ''; let sort: 'best' | 'seeds' | 'size' = 'best';
  const redraw = () => {
    tools.replaceChildren(...['', '2160p', '1080p', '720p', '480p'].map((q) => h('button', { type: 'button', class: 'chip small' + (qual === q ? ' on' : ''), onclick: () => { qual = q; redraw(); } }, q || t('allQualities'))), h('span', { class: 'chip-sep' }),
      h('button', { type: 'button', class: 'chip small', onclick: () => { sort = sort === 'best' ? 'seeds' : sort === 'seeds' ? 'size' : 'best'; redraw(); } }, icon('sort'), t(sort === 'best' ? 'sortBest' : sort === 'seeds' ? 'sortSeeds' : 'sortSize')));
    let rs = all.filter((r) => !qual || r.resolution === qual);
    if (sort === 'seeds') rs = [...rs].sort((a, b) => b.seeders - a.seeders); else if (sort === 'size') rs = [...rs].sort((a, b) => b.size - a.size);
    list.replaceChildren(...(rs.length ? rs.slice(0, 120).map((r) => h('button', { type: 'button', class: 'result-row' + (r.cached ? ' best' : ''), onclick: () => void addRelease(m, r, v).then(() => sh.close()).catch((e) => toast(String((e as Error).message ?? e), 'error')) },
      icon(r.url ? 'link' : 'magnet'), h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, r.file ?? r.title), h('small', { class: 'src' }, label(r)), r.file && r.file !== r.title ? h('small', { class: 'src' }, r.title) : null, r.languages ? h('small', { class: 'src' }, r.languages) : null))) : [h('p', { class: 'empty small' }, t('noResults'))]));
  };
  try { all = await streams(m.type, idOf(m, v)); redraw(); } catch (e) { list.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
}
/** Following a series: new episodes fetched as they come out, from the one set, in the quality set. */
function followSheet(m: TvMeta, changed: () => void): void {
  const sh = openSheet(`${m.name} · ${t('tvFollow')}`, t('close'));
  const last = lib.lastSeen(m); const cur = lib.followOf(m.id);
  const latest = (m.videos ?? []).filter((v) => v.season > 0 && cm.aired(v)).pop();
  const f: lib.Follow = cur ?? { id: m.id, name: m.name, poster: m.poster, season: latest?.season ?? 1, episode: (latest?.episode ?? 0) + 1, quality: tvPrefs().quality, enabled: true };
  if (!cur && last) { f.season = last.season; f.episode = last.episode + 1; }
  const num = (labelTxt: string, val: number, set: (n: number) => void) => h('label', { class: 'num-field' }, h('span', null, labelTxt), h('input', { type: 'number', min: '0', value: String(val), inputmode: 'numeric', onchange: (e: Event) => set(Math.max(0, Number((e.target as HTMLInputElement).value) || 0)) }));
  const q = h('div', { class: 'chip-row wrap' }); const drawQ = () => q.replaceChildren(...['', '2160', '1080', '720', '480'].map((x) => h('button', { type: 'button', class: 'chip small' + (f.quality === x ? ' on' : ''), onclick: () => { f.quality = x; drawQ(); } }, x ? `${x}p` : t('allQualities')))); drawQ();
  sh.body.append(h('p', { class: 'hint' }, t('tvFollowHint')), h('div', { class: 'num-row' }, num(t('tvSeason'), f.season, (n) => { f.season = n; }), num(t('fromEpisode'), f.episode, (n) => { f.episode = n; })), h('span', { class: 'label' }, t('animeQuality')), q);
  sh.actions.append(...(cur ? [h('button', { type: 'button', class: 'btn tonal', onclick: () => { lib.dropFollow(m.id); sh.close(); changed(); toast(t('autoOff')); } }, icon('trash'), t('autoStop'))] : []),
    h('button', { type: 'button', class: 'btn primary', onclick: async () => { lib.saveFollow({ ...f, enabled: true }); sh.close(); changed(); toast(t('autoOn')); const a = await import('../tv/auto'); a.startTvAuto(); await a.checkFollows(false); } }, icon('bell'), t('autoSave')));
}
