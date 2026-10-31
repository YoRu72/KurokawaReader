// One show: its cover and facts, the synopsis, the list entry (status, progress, score — written to AniList,
// kept and sent later when offline), relations, and the episodes — each found as a torrent through the
// providers and added as a download (in order, so it can play while it comes); a batch for the whole show.
import { h, icon, iconButton, toast, openSheet, pickButton } from '../ui/dom';
import { t, localDigits, countEpisodes, formatBytes, dateLocale, countResults } from '../i18n';
import { back, navigate } from '../router';
import { getSettings } from '../settings';
import { getEngine } from '../engine';
import * as al from '../anilist';
import type { Anime, AlEntry } from '../anilist';
import { fmtUntil, titleOf, fmtFormat, statusName } from './anime';
import { buildQuery, searchAll, rank, providers, syncBuiltins, magnetOf, type TorrentResult, type ProviderEntry } from '../anime/providers';
import { parseFilename, matchesEpisode } from '../anime/anitomy';

export function animeEntryView(id: number): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'body anime-entry' }, h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  const title = h('div', { class: 'title' }, h('span', null, ''));
  const root = h('div', { class: 'view anime-entry-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/anime')), title, h('div', { class: 'topbar-actions' })), body) as HTMLElement & { dispose?: () => void };
  let a: Anime | null = null; let gone = false;
  const draw = () => {
    if (!a) return;
    const s = getSettings();
    (title.firstChild as HTMLElement).textContent = titleOf(a);
    const now = Date.now() / 1000;
    const airedCount = a.status === 'FINISHED' ? a.episodes ?? 0 : a.nextAiring ? a.nextAiring.episode - 1 : a.status === 'NOT_YET_RELEASED' ? 0 : a.episodes ?? 0;
    const total = a.episodes ?? Math.max(airedCount, a.entry?.progress ?? 0);
    const facts = [a.format ? fmtFormat(a.format) : '', a.season ? `${t(({ WINTER: 'seasonWinter', SPRING: 'seasonSpring', SUMMER: 'seasonSummer', FALL: 'seasonFall' } as const)[a.season])} ${localDigits(a.seasonYear ?? '')}` : a.seasonYear ? localDigits(a.seasonYear) : '', a.episodes ? countEpisodes(a.episodes) : '', a.duration ? t('minutesEach', { n: a.duration }) : '', a.studio ?? '', a.score ? `★ ${localDigits(a.score)}%` : ''].filter(Boolean).join(' · ');
    const head = h('section', { class: 'anime-head', style: a.color ? { '--cover-color': a.color } : undefined },
      a.banner ? h('img', { class: 'anime-banner', src: a.banner, alt: '' }) : null,
      h('div', { class: 'anime-head-row' }, h('div', { class: 'anime-cover big' }, a.cover ? h('img', { src: a.cover, alt: '' }) : icon('film')),
        h('div', { class: 'anime-head-text' }, h('h2', { dir: 'auto' }, titleOf(a)), a.titleNative && a.titleNative !== titleOf(a) ? h('p', { class: 'src', dir: 'auto' }, a.titleNative) : null, h('p', { class: 'anime-facts' }, facts),
          a.nextAiring ? h('p', { class: 'anime-next' }, icon('clock'), t('animeNextEp', { n: a.nextAiring.episode, t: fmtUntil(a.nextAiring.airingAt - now) })) : null,
          h('div', { class: 'chips' }, ...a.genres.slice(0, 6).map((g) => h('span', { class: 'chip small' }, g))))));
    // The list entry
    const e = a.entry;
    const track = h('section', { class: 'card anime-track' }, h('h3', null, t('tracking')),
      !al.linked() ? h('p', { class: 'hint' }, t('anilistLinkFirst'), ' ', h('button', { type: 'button', class: 'btn text small', onclick: () => navigate('/settings/anime') }, t('anilistSignIn')))
        : h('div', { class: 'track-row' },
          pickButton(t('animeStatus'), al.AL_STATUSES.map((st) => [st, statusName(st)] as [al.AlStatus, string]), e?.status ?? 'CURRENT', (v) => void saveEntry({ ...(e ?? { progress: 0, score: 0 }), status: v, ...(v === 'COMPLETED' && a!.episodes ? { progress: a!.episodes, completedAt: e?.completedAt ?? al.today() } : {}), ...(v === 'CURRENT' && !e?.startedAt ? { startedAt: al.today() } : {}) }), t('close')),
          h('div', { class: 'progress-ctl' }, iconButton('minus', t('less'), () => e && e.progress > 0 && void saveEntry({ ...e, progress: e.progress - 1 })), h('span', { class: 'progress-num' }, `${localDigits(e?.progress ?? 0, 'prose')}${total ? ` / ${localDigits(total, 'prose')}` : ''}`), iconButton('plus', t('more'), () => void saveEntry({ ...(e ?? { status: 'CURRENT', progress: 0, score: 0, startedAt: al.today() }), progress: (e?.progress ?? 0) + 1 }))),
          e ? h('button', { type: 'button', class: 'btn text small', onclick: () => scoreSheet() }, icon('star'), e.score ? localDigits(e.score) : t('animeScore')) : h('button', { type: 'button', class: 'btn tonal small', onclick: () => void saveEntry({ status: 'PLANNING', progress: 0, score: 0 }) }, icon('bookmark'), t('animeAddToList')),
          e ? iconButton('trash', t('animeRemoveEntry'), () => void removeEntry()) : null));
    // Synopsis
    const syn = a.description ? h('section', { class: 'card anime-synopsis' }, h('h3', null, t('animeSynopsis')), h('p', { class: 'clamp', dir: 'auto', onclick: (ev: Event) => (ev.currentTarget as HTMLElement).classList.toggle('clamp') }, a.description)) : null;
    // Episodes
    const eps: HTMLElement[] = [];
    const sched = new Map((a.schedule ?? []).map((x) => [x.episode, x.airingAt]));
    const df = new Intl.DateTimeFormat(dateLocale('data'), { day: 'numeric', month: 'short' });
    const stream = (a.streaming ?? []).map((x) => ({ n: Number(/(\d+)\s*$/.exec(x.title)?.[1]), ...x }));
    const list = Math.min(total || airedCount, 500);
    for (let n = 1; n <= list; n++) {
      const aired = n <= airedCount || a.status === 'FINISHED'; const at = sched.get(n); const seen = !!e && n <= e.progress; const st = stream.find((x) => x.n === n);
      eps.push(h('div', { class: 'ep-row' + (seen ? ' seen' : '') + (aired ? '' : ' future') },
        st?.thumbnail ? h('img', { class: 'ep-thumb', src: st.thumbnail, alt: '', loading: 'lazy' }) : h('span', { class: 'ep-num' }, localDigits(n)),
        h('span', { class: 'grow' }, h('span', { class: 'ep-title', dir: 'auto' }, st?.title?.replace(/^Episode\s*\d+\s*[-–:]?\s*/i, '') || t('episodeN', { n })), h('small', { class: 'src' }, at ? (aired ? df.format(new Date(at * 1000)) : fmtUntil(at - now)) : aired ? t('animeAired') : t('animeNotYet'))),
        aired ? iconButton('download', t('animeFindTorrents'), () => torrentSheet(a!, n)) : null,
        al.linked() ? iconButton(seen ? 'check' : 'circle', seen ? t('animeSeen') : t('animeMarkSeen'), () => void saveEntry({ ...(e ?? { status: 'CURRENT', progress: 0, score: 0, startedAt: al.today() }), progress: seen ? n - 1 : n, ...(n === a!.episodes && !seen ? { status: 'COMPLETED', completedAt: al.today() } : {}) })) : null));
    }
    const epsSec = h('section', { class: 'card anime-episodes' }, h('div', { class: 'card-head' }, h('h3', null, t('episodes')), h('div', { class: 'grow' }), h('button', { type: 'button', class: 'btn tonal small', onclick: () => torrentSheet(a!, 0) }, icon('magnet'), a.format === 'MOVIE' ? t('animeFindTorrents') : t('animeBatch'))), ...eps, ...(!list ? [h('p', { class: 'hint' }, t('animeNotYet'))] : []));
    // Relations, links
    const rel = a.relations?.filter((r) => ['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'PARENT', 'ALTERNATIVE', 'SPIN_OFF', 'SOURCE', 'ADAPTATION'].includes(r.relation) && r.format !== 'MANGA' && r.format !== 'NOVEL') ?? [];
    const relSec = rel.length ? h('section', { class: 'card' }, h('h3', null, t('animeRelations')), h('div', { class: 'chips' }, ...rel.map((r) => h('button', { type: 'button', class: 'chip', onclick: () => navigate(`/anime/${r.id}`) }, h('small', null, relName(r.relation)), ' ', h('span', { dir: 'auto' }, r.title))))) : null;
    const links = [...(a.links ?? []).filter((l) => l.type === 'STREAMING').slice(0, 6), { site: 'AniList', url: a.url }, ...(a.idMal ? [{ site: 'MyAnimeList', url: `https://myanimelist.net/anime/${a.idMal}` }] : []), ...(a.trailer?.site === 'youtube' ? [{ site: 'YouTube', url: `https://www.youtube.com/watch?v=${a.trailer.id}` }] : [])];
    const linkSec = h('section', { class: 'card' }, h('h3', null, t('animeLinks')), h('div', { class: 'chips' }, ...links.map((l) => h('a', { class: 'chip', href: l.url, target: '_blank', rel: 'noopener' }, icon('external'), l.site))));
    body.replaceChildren(...[head, track, syn, epsSec, relSec, linkSec].filter((x): x is HTMLElement => !!x));
  };
  const saveEntry = async (entry: AlEntry) => { if (!a) return; try { const r = await al.saveOrQueue(a.id, entry); a.entry = r.entry; draw(); toast(r.sent ? t('animeSaved') : t('animeQueued')); } catch (e) { toast(`AniList: ${(e as Error).message}`, 'error'); } };
  const removeEntry = async () => { if (!a?.entry?.id) return; if (!confirm(t('animeRemoveEntryConfirm'))) return; try { await al.remove(a.entry.id); a.entry = undefined; draw(); toast(t('animeRemoved')); } catch (e) { toast(`AniList: ${(e as Error).message}`, 'error'); } };
  const scoreSheet = () => {
    if (!a?.entry) return; const u = al.user()!; const max = al.scoreMax(u.scoreFormat); const step = al.scoreStep(u.scoreFormat);
    const sh = openSheet(t('animeScore'), t('close')); const out = h('output', null, localDigits(a.entry.score));
    const range = h('input', { type: 'range', min: '0', max: String(max), step: String(step), value: String(a.entry.score), oninput: () => { out.textContent = localDigits(Number(range.value)); } }) as HTMLInputElement;
    sh.body.append(h('div', { class: 'score-row' }, range, out));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); void saveEntry({ ...a!.entry!, score: Number(range.value) }); } }, t('save')));
  };
  void al.media(id).then((m) => { if (gone) return; a = m; draw(); }).catch((e) => body.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))));
  root.dispose = () => { gone = true; };
  return root;
}
const relName = (r: string): string => ({ PREQUEL: t('relPrequel'), SEQUEL: t('relSequel'), SIDE_STORY: t('relSide'), PARENT: t('relParent'), ALTERNATIVE: t('relAlternative'), SPIN_OFF: t('relSpinoff'), SOURCE: t('relSource'), ADAPTATION: t('relAdaptation') } as Record<string, string>)[r] ?? r;

/** The torrents of an episode (0: a batch or a movie): every provider asked at once, results ranked, one tap
 *  to download (in order, so it can play as it comes) with the show and episode remembered for tracking. */
export async function torrentSheet(a: Anime, episode: number): Promise<void> {
  const sh = openSheet(episode ? `${titleOf(a)} · ${t('episodeN', { n: episode })}` : titleOf(a), t('close'));
  await syncBuiltins().catch(() => undefined);
  const ps = (await providers()).filter((p) => p.enabled);
  if (!ps.length) { sh.body.append(h('div', { class: 'empty small' }, h('p', null, t('animeNoProviders')), h('button', { type: 'button', class: 'btn primary small', onclick: () => { sh.close(); navigate('/settings/anime'); } }, icon('puzzle'), t('animeProviders')))); return; }
  const status = h('div', { class: 'chips provider-chips' }, ...ps.map((p) => h('span', { class: 'chip small busy', dataset: { id: p.id } }, h('span', { class: 'spinner tiny' }), p.name)));
  const list = h('div', { class: 'torrent-list' });
  const want = getSettings().animeQuality;
  const filterOn = h('label', { class: 'switch-row small' }, h('span', { class: 'grow' }, t('animeOnlyMatching')), h('input', { type: 'checkbox', checked: true, onchange: () => redraw() }));
  sh.body.append(status, ...(episode ? [filterOn] : []), list);
  let all: TorrentResult[] = [];
  const row = (r: TorrentResult) => {
    const p = parseFilename(r.title);
    const bits = [r.resolution ?? p.resolution ?? '', r.size ? formatBytes(r.size) : '', `↑${localDigits(r.seeders)}`, r.type === 'best' ? t('animeBest') : r.type === 'batch' || p.batch ? t('animeBatch') : '', p.group ?? r.group ?? '', r.provider].filter(Boolean).join(' · ');
    return h('button', { type: 'button', class: `result-row acc-${r.accuracy}` + (r.type === 'best' ? ' best' : ''), onclick: () => void add(r) }, icon(r.url ? 'link' : 'magnet'), h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, r.title), h('small', { class: 'src' }, bits)));
  };
  const redraw = () => {
    const only = episode && (filterOn.querySelector('input') as HTMLInputElement).checked;
    const shown = rank(all.filter((r) => !only || r.accuracy === 'high' || matchesEpisode(parseFilename(r.title), episode)), want);
    list.replaceChildren(...shown.slice(0, 80).map(row));
    if (!shown.length && !status.querySelector('.busy')) list.append(h('p', { class: 'empty small' }, t('noResults')));
  };
  const add = async (r: TorrentResult) => {
    try {
      const source = r.url ? { url: r.url } : { magnet: magnetOf(r) }; const meta = { anilistId: a.id, title: titleOf(a), episode: episode || undefined, batch: !episode || undefined, cover: a.cover, provider: r.provider, hash: r.hash, fileIdx: r.fileIdx };
      if (!r.url && getSettings().debridDefault && getSettings().addons.includes('debrid')) { const { sendToDebrid } = await import('../debrid/transfers'); const d = await sendToDebrid(source, { meta }); toast(d.kind === 'cloud' ? t('debridSent', { name: d.name }) : t('taskAdded', { name: d.name })); sh.close(); navigate('/'); return; }
      const tk = await getEngine().add({ source, name: r.url ? r.title : undefined, sequential: true, meta });
      toast(t('taskAdded', { name: tk.name || r.title })); sh.close(); navigate('/');
    } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); }
  };
  const q = await buildQuery(a, episode);
  await searchAll(q, (p: ProviderEntry, res) => {
    const chip = status.querySelector<HTMLElement>(`[data-id="${CSS.escape(p.id)}"]`);
    if (chip) { chip.classList.remove('busy'); chip.querySelector('.spinner')?.remove(); if (res instanceof Error) { chip.classList.add('failed'); chip.title = res.message; chip.prepend(icon('alert')); } else chip.append(h('small', null, ` ${countResults(res.length)}`)); }
    if (!(res instanceof Error)) { all = all.concat(res); redraw(); }
    else redraw();
  });
}
