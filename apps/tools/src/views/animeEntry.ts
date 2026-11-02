// One show: its cover and facts, the synopsis, the list entry (status, progress, score — written to AniList,
// kept and sent later when offline), relations, and the episodes — each found as a torrent through the
// providers and added as a download (in order, so it can play while it comes); a batch for the whole show.
import { h, icon, iconButton, toast, openSheet, pickButton, onLongPress } from '../ui/dom';
import { t, localDigits, countEpisodes, formatBytes, dateLocale, countResults } from '../i18n';
import { back, navigate } from '../router';
import { getSettings, updateSettings } from '../settings';
import { getEngine } from '../engine';
import * as al from '../anilist';
import type { Anime, AlEntry } from '../anilist';
import { fmtUntil, titleOf, fmtFormat, statusName, tickCountdowns } from './anime';
import { buildQuery, searchAll, rank, providers, syncBuiltins, magnetOf, type TorrentResult, type ProviderEntry } from '../anime/providers';
import { parseFilename, matchesEpisode } from '../anime/anitomy';
import { ruleOf, saveRule, dropRule, downloadRange, downloadedEpisodes, fillersOf, checkRules, startAuto, type AutoRule } from '../anime/auto';
import type { Task } from '../engine/types';

export function animeEntryView(id: number): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'body anime-entry' }, h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  const title = h('div', { class: 'title' }, h('span', null, ''));
  const root = h('div', { class: 'view anime-entry-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/anime')), title, h('div', { class: 'topbar-actions' })), body) as HTMLElement & { dispose?: () => void };
  let a: Anime | null = null; let gone = false; let range = -1; let have = new Map<number, Task>(); let disk = new Map<number, { path: string; name: string }>(); let fillers = new Set<number>(); let streams = 0;
  const draw = () => {
    if (!a) return;
    const s = getSettings();
    (title.firstChild as HTMLElement).textContent = titleOf(a);
    const now = Date.now() / 1000;
    const fromSchedule = Math.max(0, ...(a.schedule ?? []).filter((x) => x.airingAt <= now).map((x) => x.episode));
    const airedCount = a.status === 'FINISHED' ? a.episodes ?? Math.max(fromSchedule, a.entry?.progress ?? 0) : a.nextAiring ? a.nextAiring.episode - 1 : a.status === 'NOT_YET_RELEASED' ? 0 : Math.max(fromSchedule, a.episodes ?? 0);
    const total = a.episodes ?? Math.max(airedCount, a.entry?.progress ?? 0);
    const facts = [a.format ? fmtFormat(a.format) : '', a.season ? `${t(({ WINTER: 'seasonWinter', SPRING: 'seasonSpring', SUMMER: 'seasonSummer', FALL: 'seasonFall' } as const)[a.season])} ${localDigits(a.seasonYear ?? '')}` : a.seasonYear ? localDigits(a.seasonYear) : '', a.episodes ? countEpisodes(a.episodes) : '', a.duration ? t('minutesEach', { n: a.duration }) : '', a.studio ?? '', a.score ? `★ ${localDigits(a.score)}%` : ''].filter(Boolean).join(' · ');
    const head = h('section', { class: 'anime-head', style: a.color ? { '--cover-color': a.color } : undefined },
      a.banner ? h('img', { class: 'anime-banner', src: a.banner, alt: '' }) : null,
      h('div', { class: 'anime-head-row' }, h('div', { class: 'anime-cover big' }, a.cover ? h('img', { src: a.cover, alt: '' }) : icon('film')),
        h('div', { class: 'anime-head-text' }, h('h2', { dir: 'auto' }, titleOf(a)), a.titleNative && a.titleNative !== titleOf(a) ? h('p', { class: 'src', dir: 'auto' }, a.titleNative) : null, h('p', { class: 'anime-facts' }, facts),
          a.nextAiring ? h('p', { class: 'anime-next', dataset: { at: String(a.nextAiring.airingAt), ep: String(a.nextAiring.episode) } }, icon('clock'), h('span', { class: 'until' }, t('animeNextEp', { n: a.nextAiring.episode, t: fmtUntil(a.nextAiring.airingAt - now) }))) : null,
          h('div', { class: 'chips' }, ...a.genres.slice(0, 6).map((g) => h('button', { type: 'button', class: 'chip small', onclick: () => navigate(`/anime?tab=search&genre=${encodeURIComponent(g)}`) }, g))))));
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
    const stream = (a.streaming ?? []).map((x, i, all) => ({ n: Number(/\b(?:Episode|Ep\.?|E)\s*(\d+)/i.exec(x.title)?.[1] ?? /(\d+)\s*$/.exec(x.title)?.[1] ?? (all.length === (a!.episodes ?? -1) ? i + 1 : NaN)), ...x }));
    const list = total || airedCount;
    const PAGE = 100; const pages = Math.ceil(list / PAGE);
    const nextUp = Math.min(list, Math.max(1, (e?.progress ?? 0) + 1));
    if (range < 0) range = Math.floor((nextUp - 1) / PAGE);
    const rangeChips = pages > 1 ? h('div', { class: 'chip-row wrap ep-ranges' }, ...Array.from({ length: pages }, (_, i) => h('button', { type: 'button', class: 'chip small' + (i === range ? ' on' : ''), onclick: () => { range = i; draw(); } }, `${localDigits(i * PAGE + 1, 'prose')}–${localDigits(Math.min(list, (i + 1) * PAGE), 'prose')}`))) : null;
    const from = pages > 1 ? range * PAGE + 1 : 1; const to = pages > 1 ? Math.min(list, (range + 1) * PAGE) : list;
    for (let n = from; n <= to; n++) {
      const aired = n <= airedCount || a.status === 'FINISHED'; const at = sched.get(n); const seen = !!e && n <= e.progress; const st = stream.find((x) => x.n === n);
      const got = have.get(n); const filler = fillers.has(n);
      // (Hayase's «hide spoilers»: past the next episode, no title and no picture.)
      const spoil = !!s.animeHideSpoilers && n > (e?.progress ?? 0) + 1;
      const epTitle = (!spoil && st?.title?.replace(/^Episode\s*\d+\s*[-–:]?\s*/i, '')) || t('episodeN', { n }); const onDisk = !got ? disk.get(n) : undefined;
      const rowEl = h('div', { class: 'ep-row' + (seen ? ' seen' : '') + (aired ? '' : ' future') + (got ? ' have' : ''), dataset: { ep: String(n) }, role: aired ? 'button' : undefined, tabindex: aired ? '0' : undefined,
        onclick: (ev: Event) => { if (!aired || (ev.target as Element).closest('button')) return; episodeSheet(a!, n, epTitle, st?.thumbnail, () => draw()); } },
        st?.thumbnail && !spoil ? h('img', { class: 'ep-thumb', src: st.thumbnail, alt: '', loading: 'lazy' }) : h('span', { class: 'ep-num' }, localDigits(n, 'prose')),
        h('span', { class: 'grow' }, h('span', { class: 'ep-title', dir: 'auto' }, epTitle, onDisk ? h('span', { class: 'ep-badge have' }, t('onDisk')) : null, filler ? h('span', { class: 'ep-badge filler' }, t('filler')) : null, got ? h('span', { class: 'ep-badge have' }, got.state === 'done' ? t('downloaded') : t('downloading', { p: localDigits(got.total ? Math.round((got.done / got.total) * 100) : 0) })) : null), h('small', { class: 'src' }, at ? (aired ? df.format(new Date(at * 1000)) : fmtUntil(at - now)) : aired ? t('animeAired') : t('animeNotYet')),
          got && got.state !== 'done' ? h('div', { class: 'task-bar thin ep-prog' + (got.state === 'paused' || got.state === 'failed' ? ' paused' : '') }, h('i', { style: { width: `${got.total ? Math.round((got.done / got.total) * 100) : 2}%` } })) : null),
        onDisk ? iconButton('play', t('play'), () => void import('./anime').then((m) => m.playLocal(a!, n, onDisk.path, onDisk.name))) :
        got && got.state === 'done' ? iconButton('play', t('play'), () => void import('./player').then((m) => m.playTaskFile(got, got.files.length > 1 ? Math.max(0, got.files.findIndex((f) => /\.(mkv|mp4|webm|avi|mov|m4v)$/i.test(f.path))) : 0))) : aired ? iconButton('download', t('animeFindTorrents'), () => torrentSheet(a!, n)) : null,
        aired && streams && !(got && got.state === 'done') ? iconButton('play', t('streamWatch'), () => void import('./animeStream').then((m) => m.streamSheet(a!, n))) : null,
        al.linked() ? iconButton(seen ? 'check' : 'circle', seen ? t('animeSeen') : t('animeMarkSeen'), () => void saveEntry({ ...(e ?? { status: 'CURRENT', progress: 0, score: 0, startedAt: al.today() }), progress: seen ? n - 1 : n, ...(n === a!.episodes && !seen ? { status: 'COMPLETED', completedAt: al.today() } : {}) })) : null);
      // (Held: the episode's options — Hayase's — among them deleting its download.)
      if (aired) onLongPress(rowEl, () => episodeMenu(a!, n, epTitle, got, seen, al.linked() ? (to) => void saveEntry({ ...(e ?? { status: 'CURRENT', progress: 0, score: 0, startedAt: al.today() }), progress: to }) : null, () => draw()));
      eps.push(rowEl);
    }
    const rule = ruleOf(a.id);
    const epsSec = h('section', { class: 'card anime-episodes' }, h('div', { class: 'card-head' }, h('h3', null, t('episodes')), h('div', { class: 'grow' }), h('button', { type: 'button', class: 'btn tonal small', onclick: () => torrentSheet(a!, 0) }, icon('magnet'), a.format === 'MOVIE' ? t('animeFindTorrents') : t('animeBatch'))),
      a.format === 'MOVIE' || !list ? null : h('div', { class: 'row-actions wrap' }, h('button', { type: 'button', class: 'btn primary small', onclick: () => rangeSheet(a!, Math.max(1, (e?.progress ?? 0) + 1), Math.max(1, airedCount)) }, icon('download'), t('autoRange')),
        a.status === 'RELEASING' || a.status === 'NOT_YET_RELEASED' ? h('button', { type: 'button', class: 'btn small ' + (rule?.enabled ? 'tonal on' : 'text'), onclick: () => ruleSheet(a!, Math.max(1, airedCount + 1), () => draw()) }, icon('bell'), rule?.enabled ? t('autoOn') : t('autoOff')) : null), ...(rangeChips ? [rangeChips] : []), ...eps, ...(!list ? [h('p', { class: 'hint' }, t('animeNotYet'))] : []));
    // Relations, links
    const rel = a.relations?.filter((r) => ['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'PARENT', 'ALTERNATIVE', 'SPIN_OFF', 'SOURCE', 'ADAPTATION'].includes(r.relation) && r.format !== 'MANGA' && r.format !== 'NOVEL') ?? [];
    const relSec = rel.length ? h('section', { class: 'card' }, h('h3', null, t('animeRelations')), h('div', { class: 'chips' }, ...rel.map((r) => h('button', { type: 'button', class: 'chip', onclick: () => navigate(`/anime/${r.id}`) }, h('small', null, relName(r.relation)), ' ', h('span', { dir: 'auto' }, r.title))))) : null;
    const links = [...(a.links ?? []).filter((l) => l.type === 'STREAMING').slice(0, 6), { site: 'AniList', url: a.url }, ...(a.idMal ? [{ site: 'MyAnimeList', url: `https://myanimelist.net/anime/${a.idMal}` }] : []), ...(a.trailer?.site === 'youtube' ? [{ site: 'YouTube', url: `https://www.youtube.com/watch?v=${a.trailer.id}` }] : [])];
    const linkSec = h('section', { class: 'card' }, h('h3', null, t('animeLinks')), h('div', { class: 'chips' }, ...links.map((l) => h('a', { class: 'chip', href: l.url, target: '_blank', rel: 'noopener' }, icon('external'), l.site))));
    body.replaceChildren(...[head, track, syn, epsSec, relSec, linkSec].filter((x): x is HTMLElement => !!x));
  };
  const saveEntry = async (entry: AlEntry) => { if (!a) return; try { const r = await al.saveOrQueue(a.id, entry); a.entry = r.entry; draw(); toast(r.sent ? t('animeSaved') : t('animeQueued')); } catch (e) { toast(`AniList: ${(e as Error).message}`, 'error'); } };
  const removeEntry = async () => { if (!a?.entry?.id) return; if (!(await askYes(t('animeRemoveEntryConfirm'), t('animeRemoveEntry')))) return; try { await al.remove(a.entry.id); a.entry = undefined; draw(); toast(t('animeRemoved')); } catch (e) { toast(`AniList: ${(e as Error).message}`, 'error'); } };
  const scoreSheet = () => {
    if (!a?.entry) return; const u = al.user()!; const max = al.scoreMax(u.scoreFormat); const step = al.scoreStep(u.scoreFormat);
    const sh = openSheet(t('animeScore'), t('close')); const out = h('output', null, localDigits(a.entry.score));
    const range = h('input', { type: 'range', min: '0', max: String(max), step: String(step), value: String(a.entry.score), oninput: () => { out.textContent = localDigits(Number(range.value)); } }) as HTMLInputElement;
    sh.body.append(h('div', { class: 'score-row' }, range, out));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); void saveEntry({ ...a!.entry!, score: Number(range.value) }); } }, t('save')));
  };
  void al.media(id).then((m) => { if (gone) return; a = m; draw(); void import('../anime/library').then((l) => l.filesFor(m.id)).then((f) => { disk = f; if (f.size && !gone) draw(); }).catch(() => undefined); void downloadedEpisodes(m.id).then((x) => { have = x; if (!gone) draw(); }); void fillersOf(m).then((x) => { fillers = x; if (x.size && !gone) draw(); }).catch(() => undefined); void import('../anime/stream').then((st) => st.streamProviders()).then((x) => { streams = x.length; if (streams && !gone) draw(); }).catch(() => undefined); }).catch((e) => body.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))));
  // Downloads of this show followed as they go: each episode's bar and percentage moved in place; the page
  // redrawn when one is added, finishes or fails.
  const offTasks = getEngine().onChange((ts) => {
    if (!a || gone) return; let redraw = false;
    for (const x of ts) {
      const m = x.meta as { anilistId?: number; episode?: number } | undefined; if (m?.anilistId !== a.id || !m.episode) continue;
      const had = have.get(m.episode); if (!had || had.state !== x.state) redraw = redraw || !had || x.state === 'done' || x.state === 'failed' || had.state === 'done';
      have.set(m.episode, x);
      const row = body.querySelector<HTMLElement>(`.ep-row[data-ep="${m.episode}"]`); if (!row) continue;
      const pct = x.total ? Math.round((x.done / x.total) * 100) : 0;
      const bar = row.querySelector<HTMLElement>('.ep-prog i'); if (bar) bar.style.width = `${Math.max(2, pct)}%`;
      const badge = row.querySelector<HTMLElement>('.ep-badge.have'); if (badge && x.state !== 'done') badge.textContent = t('downloading', { p: localDigits(pct) });
    }
    if (redraw) draw();
  });
  const tick = tickCountdowns(body);
  root.dispose = () => { gone = true; window.clearInterval(tick); offTasks(); };
  return root;
}
/** A yes/no in the app's own sheet (a browser confirm() looks foreign and blocks). */
function askYes(text: string, yes: string): Promise<boolean> {
  return new Promise((res) => { const sh = openSheet(text, t('close')); sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); res(false); } }, t('cancel')), h('button', { type: 'button', class: 'btn primary danger', onclick: () => { sh.close(); res(true); } }, yes)); });
}
const relName = (r: string): string => ({ PREQUEL: t('relPrequel'), SEQUEL: t('relSequel'), SIDE_STORY: t('relSide'), PARENT: t('relParent'), ALTERNATIVE: t('relAlternative'), SPIN_OFF: t('relSpinoff'), SOURCE: t('relSource'), ADAPTATION: t('relAdaptation') } as Record<string, string>)[r] ?? r;

/** The torrents of an episode (0: a batch or a movie): every provider asked at once, results ranked, one tap
 *  to download (in order, so it can play as it comes) with the show and episode remembered for tracking. */
export async function torrentSheet(a: Anime, episode: number): Promise<void> {
  const sh = openSheet(episode ? `${titleOf(a)} · ${t('episodeN', { n: episode })}` : titleOf(a), t('close'));
  await syncBuiltins().catch(() => undefined);
  const ps = (await providers()).filter((p) => p.enabled && p.role !== 'stream');
  if (!ps.length) { sh.body.append(h('div', { class: 'empty small' }, h('p', null, t('animeNoProviders')), h('button', { type: 'button', class: 'btn primary small', onclick: () => { sh.close(); navigate('/settings/anime'); } }, icon('puzzle'), t('animeProviders')))); return; }
  const status = h('div', { class: 'chips provider-chips' });
  const resetChips = () => status.replaceChildren(...ps.map((p) => h('span', { class: 'chip small busy', dataset: { id: p.id } }, h('span', { class: 'spinner tiny' }), p.name)));
  const list = h('div', { class: 'torrent-list' });
  const want = getSettings().animeQuality;
  const filterOn = h('label', { class: 'switch-row small' }, h('span', { class: 'grow' }, t('animeOnlyMatching')), h('input', { type: 'checkbox', checked: true, onchange: () => redraw() }));
  let qual = ''; let sort: 'rank' | 'seeds' | 'size' = 'rank';
  const tools = h('div', { class: 'chip-row wrap search-tools' });
  const drawTools = () => tools.replaceChildren(...['', '2160', '1080', '720', '480'].map((q) => h('button', { type: 'button', class: 'chip small' + (qual === q ? ' on' : ''), onclick: () => { qual = q; drawTools(); redraw(); } }, q ? `${q}p` : t('allQualities'))), h('span', { class: 'chip-sep' }),
    h('button', { type: 'button', class: 'chip small', onclick: () => { sort = sort === 'rank' ? 'seeds' : sort === 'seeds' ? 'size' : 'rank'; drawTools(); redraw(); } }, icon('sort'), t(sort === 'rank' ? 'sortBest' : sort === 'seeds' ? 'sortSeeds' : 'sortSize')));
  drawTools();
  // (The name the sources are asked for, changeable: when the show's own titles find nothing, any name typed.)
  const nameIn = h('input', { type: 'search', class: 'search-input', dir: 'auto', enterkeyhint: 'search', placeholder: t('searchByName') }) as HTMLInputElement;
  const altTitles = h('div', { class: 'chip-row wrap alt-titles' });
  const nameForm = h('form', { class: 'search-form torrent-name', onsubmit: (e: Event) => { e.preventDefault(); void run(nameIn.value.trim()); } }, nameIn, h('button', { type: 'submit', class: 'btn tonal small' }, icon('search'), t('search')));
  sh.body.append(nameForm, altTitles, status, tools, ...(episode ? [filterOn] : []), list);
  let all: TorrentResult[] = [];
  const row = (r: TorrentResult) => {
    const p = parseFilename(r.title);
    const bits = [r.resolution ?? p.resolution ?? '', r.size ? formatBytes(r.size) : '', `↑${localDigits(r.seeders)}`, r.type === 'best' ? t('animeBest') : r.type === 'batch' || p.batch ? t('animeBatch') : '', p.group ?? r.group ?? '', r.provider].filter(Boolean).join(' · ');
    const main = h('button', { type: 'button', class: `result-row acc-${r.accuracy}` + (r.type === 'best' ? ' best' : ''), onclick: () => void add(r) }, icon(r.url ? 'link' : 'magnet'), h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, r.title), h('small', { class: 'src' }, bits)));
    if (r.url || !canPick()) return main;
    return h('div', { class: 'result-wrap' }, main, h('button', { type: 'button', class: 'icon-btn result-files', title: t('pickFilesTitle'), 'aria-label': t('pickFilesTitle'), onclick: () => void add(r, true) }, icon('list')));
  };
  const canPick = () => !!getEngine().torrentInfo && getEngine().can.pickFiles && !(getSettings().debridDefault && getSettings().addons.includes('debrid'));
  const redraw = () => {
    const only = episode && (filterOn.querySelector('input') as HTMLInputElement).checked;
    let shown = rank(all.filter((r) => (!only || r.accuracy === 'high' || matchesEpisode(parseFilename(r.title), episode)) && (!qual || (r.resolution ?? parseFilename(r.title).resolution ?? '').startsWith(qual))), want);
    if (sort === 'seeds') shown = [...shown].sort((x, y) => y.seeders - x.seeders); else if (sort === 'size') shown = [...shown].sort((x, y) => y.size - x.size);
    list.replaceChildren(...shown.slice(0, 80).map(row));
    if (!shown.length && !status.querySelector('.busy')) list.append(h('p', { class: 'empty small' }, t('noResults')));
  };
  /** One release added: a batch (or any torrent, when asked) shows its files first — this episode's ticked. */
  const add = async (r: TorrentResult, choose = false) => {
    try {
      const source = r.url ? { url: r.url } : { magnet: magnetOf(r) }; const meta = { anilistId: a.id, title: titleOf(a), episode: episode || undefined, batch: !episode || undefined, cover: a.cover, provider: r.provider, hash: r.hash, fileIdx: r.fileIdx };
      if (!r.url && getSettings().debridDefault && getSettings().addons.includes('debrid')) { const { sendToDebrid } = await import('../debrid/transfers'); const d = await sendToDebrid(source, { meta }); toast(d.kind === 'cloud' ? t('debridSent', { name: d.name }) : t('taskAdded', { name: d.name })); sh.close(); navigate('/'); return; }
      let files: number[] | undefined = !r.url && r.fileIdx !== undefined && episode ? [r.fileIdx] : undefined;
      if (!r.url && canPick() && (choose || ((r.type === 'batch' || parseFilename(r.title).batch || !episode) && files === undefined))) {
        const { pickFiles } = await import('./pickFiles');
        const got = await pickFiles(source, r.title, episode ? [episode] : []); if (got === null) return;
        files = got === 'all' ? undefined : got;
      }
      const tk = await getEngine().add({ source, name: r.url ? r.title : undefined, sequential: !!r.url, files, meta });
      toast(t('taskAdded', { name: tk.name || r.title })); sh.close(); navigate('/');
    } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); }
  };
  const base = await buildQuery(a, episode); let token = 0;
  nameIn.value = base.titles[0] ?? '';
  altTitles.replaceChildren(...base.titles.slice(0, 6).map((n) => h('button', { type: 'button', class: 'chip small', dir: 'auto', onclick: () => { nameIn.value = n; void run(n); } }, n)));
  async function run(name: string): Promise<void> {
    const my = ++token; all = []; list.replaceChildren(); resetChips();
    // (The show's own titles at first; a name typed by hand replaces them, and the sources search by it.)
    const q = name && name !== base.titles[0] ? { ...base, titles: [name, ...base.titles.filter((x) => x !== name)], query: name } : base;
    await searchAll(q, (p: ProviderEntry, res) => {
      if (my !== token) return;
      const chip = status.querySelector<HTMLElement>(`[data-id="${CSS.escape(p.id)}"]`);
      if (chip) { chip.classList.remove('busy'); chip.querySelector('.spinner')?.remove(); if (res instanceof Error) { chip.classList.add('failed'); chip.title = res.message; chip.prepend(icon('alert')); chip.onclick = () => toast(`${p.name}: ${res.message}`, 'error', 6000); } else chip.append(h('small', null, ` ${countResults(res.length)}`)); }
      if (!(res instanceof Error)) { all = all.concat(res); redraw(); }
      else redraw();
    });
    if (my === token && !all.length) list.replaceChildren(h('div', { class: 'empty small' }, h('p', null, t('noResultsTryName')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => { nameIn.focus(); nameIn.select(); } }, icon('pen'), t('searchByName')), h('button', { type: 'button', class: 'btn text small', onclick: () => { sh.close(); navigate(`/search?q=${encodeURIComponent(`${nameIn.value.trim() || titleOf(a)}${episode ? ` ${String(episode).padStart(2, '0')}` : ''}`)}`); } }, icon('magnet'), t('searchEverywhere'))));
  }
  await run('');
}

/** Episodes from–to in one go, with the show's choices (Senpwai's batch download); optionally kept as a rule. */
function choiceFields(c: Pick<AutoRule, 'resolution' | 'group' | 'dub' | 'require' | 'avoid'>): HTMLElement[] {
  const res = h('div', { class: 'chip-row wrap' }); const drawRes = () => res.replaceChildren(...['', '2160', '1080', '720', '480'].map((q) => h('button', { type: 'button', class: 'chip small' + (c.resolution === q ? ' on' : ''), onclick: () => { c.resolution = q; drawRes(); } }, q ? `${q}p` : t('allQualities')))); drawRes();
  const dub = h('div', { class: 'chip-row wrap' }); const drawDub = () => dub.replaceChildren(...([['any', t('audioAny')], ['sub', t('audioSub')], ['dub', t('audioDub')]] as const).map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (c.dub === k ? ' on' : ''), onclick: () => { c.dub = k; drawDub(); } }, l))); drawDub();
  const text = (label: string, k: 'group' | 'require' | 'avoid', ph: string) => h('label', { class: 'field' }, h('span', null, label), h('input', { type: 'text', dir: 'ltr', value: c[k], placeholder: ph, oninput: (e: Event) => { c[k] = (e.target as HTMLInputElement).value; } }));
  return [h('span', { class: 'label' }, t('animeQuality')), res, h('span', { class: 'label' }, t('audioPref')), dub, text(t('releaseGroup'), 'group', 'SubsPlease'), text(t('mustHave'), 'require', 'HEVC, 10bit'), text(t('mustNotHave'), 'avoid', 'CR, AAC')];
}
function rangeSheet(a: Anime, from: number, to: number): void {
  const sh = openSheet(`${titleOf(a)} · ${t('autoRange')}`, t('close'));
  const r0 = ruleOf(a.id); const c = { resolution: r0?.resolution ?? getSettings().animeQuality, group: r0?.group ?? '', dub: r0?.dub ?? 'any', require: r0?.require ?? '', avoid: r0?.avoid ?? '' } as Pick<AutoRule, 'resolution' | 'group' | 'dub' | 'require' | 'avoid'>;
  const num = (label: string, v: number, set: (n: number) => void) => h('label', { class: 'num-field' }, h('span', null, label), h('input', { type: 'number', min: '1', value: String(v), inputmode: 'numeric', onchange: (e: Event) => set(Math.max(1, Number((e.target as HTMLInputElement).value) || 1)) }));
  let skipFillers = false, skipHave = true, preferBatch = a.status === 'FINISHED', keep = false, review = getSettings().animeReview ?? true;
  const sw = (label: string, on: boolean, set: (v: boolean) => void) => h('label', { class: 'row switch-row' }, h('span', null, label), h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }));
  sh.body.append(h('div', { class: 'num-row' }, num(t('fromEpisode'), from, (n) => { from = n; }), num(t('toEpisode'), to, (n) => { to = n; })), ...choiceFields(c),
    sw(t('skipFillers'), skipFillers, (v) => { skipFillers = v; }), sw(t('skipDownloaded'), skipHave, (v) => { skipHave = v; }), sw(t('preferBatch'), preferBatch, (v) => { preferBatch = v; }),
    ...(a.status === 'RELEASING' ? [sw(t('autoKeep'), keep, (v) => { keep = v; })] : []), sw(t('reviewPicks'), review, (v) => { review = v; updateSettings({ animeReview: v }); }));
  const go = h('button', { type: 'button', class: 'btn primary' }, icon('download'), t('autoRangeStart')) as HTMLButtonElement;
  sh.actions.append(go);
  go.addEventListener('click', async () => {
    if (to < from) [from, to] = [to, from];
    const log = h('div', { class: 'range-log' }); let stopped = false;
    sh.body.replaceChildren(h('p', { class: 'src' }, `${t('episodeN', { n: from })} – ${t('episodeN', { n: to })}`), log);
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { stopped = true; } }, t('stop')));
    if (keep) { saveRule({ anilistId: a.id, title: titleOf(a), cover: a.cover, ...c, next: to + 1, enabled: true }); startAuto(); }
    if (review && !(preferBatch && to - from >= 3)) { await reviewRange(sh, log, a, { from, to, choices: c, skipFillers, skipHave, preferBatch }, () => stopped); return; }
    const n = await downloadRange(a, { from, to, choices: c, skipFillers, skipHave, preferBatch }, (ep, state, title) => {
      log.prepend(h('div', { class: 'range-row s-' + state }, h('b', null, localDigits(ep)), h('span', { class: 'grow', dir: 'auto' }, state === 'added' || state === 'batch' ? title ?? '' : t(state === 'have' ? 'downloaded' : state === 'filler' ? 'filler' : 'autoNone'))));
    }, () => stopped);
    toast(t('autoRangeDone', { n: countEpisodes(n) })); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); navigate('/'); } }, t('done')));
  });
}
/** Seanime's Auto Downloader for one show: new episodes fetched as they air, with these choices. */
function ruleSheet(a: Anime, next: number, changed: () => void): void {
  const sh = openSheet(`${titleOf(a)} · ${t('autoTitle')}`, t('close'));
  const r = ruleOf(a.id) ?? { anilistId: a.id, title: titleOf(a), cover: a.cover, resolution: getSettings().animeQuality, group: '', dub: 'any', require: '', avoid: '', next, enabled: true } as AutoRule;
  const c = { ...r };
  const from = h('input', { type: 'number', min: '1', value: String(r.next), inputmode: 'numeric', onchange: (e: Event) => { c.next = Math.max(1, Number((e.target as HTMLInputElement).value) || 1); } });
  sh.body.append(h('p', { class: 'hint' }, t('autoHint')), h('label', { class: 'num-field' }, h('span', null, t('fromEpisode')), from), ...choiceFields(c));
  sh.actions.append(...(ruleOf(a.id) ? [h('button', { type: 'button', class: 'btn tonal', onclick: () => { dropRule(a.id); toast(t('autoOff')); sh.close(); changed(); } }, icon('trash'), t('autoStop'))] : []),
    h('button', { type: 'button', class: 'btn primary', onclick: async () => { saveRule({ ...c, enabled: true }); startAuto(); sh.close(); changed(); toast(t('autoOn')); await checkRules(false); } }, icon('bell'), t('autoSave')));
}

/** One episode, held: what can be done with it — watch, download, choose a release, mark it (or every one up to
 *  it) seen or not, its download's details, and its download deleted (files and all). */
function episodeMenu(a: Anime, n: number, title: string, got: Task | undefined, seen: boolean, setProgress: ((to: number) => void) | null, changed: () => void): void {
  const sh = openSheet(`${titleOf(a)} · ${t('episodeN', { n })}`, t('close')); sh.el.classList.add('ep-menu');
  const row = (ic: string, label: string, fn: () => void, cls = '') => sh.body.append(h('button', { type: 'button', class: 'dest-row' + cls, onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow', dir: 'auto' }, label)));
  sh.body.append(h('p', { class: 'src', dir: 'auto' }, title));
  row('play', got?.state === 'done' ? t('play') : t('epWatchNow'), () => void import('../anime/watch').then((m) => m.watchEpisode(a, n, `${titleOf(a)} · ${t('episodeN', { n })}`)));
  if (!got) row('download', t('epDownloadBest'), () => void (async () => { const { buildQuery, searchAll } = await import('../anime/providers'); const { bestRelease } = await import('../anime/watch'); toast(t('watchFinding')); const best = bestRelease(a, n, await searchAll(await buildQuery(a, n), () => undefined)); if (!best) { toast(t('watchNone'), 'error'); return; } const { addFor } = await import('../anime/auto'); await addFor({ ...a, title: titleOf(a) } as Anime, best, n); toast(t('taskAdded', { name: best.title })); changed(); })());
  row('magnet', t('epChoose'), () => void torrentSheet(a, n));
  if (setProgress) { row(seen ? 'circle' : 'check', seen ? t('epMarkUnseen') : t('animeMarkSeen'), () => setProgress(seen ? n - 1 : n)); if (!seen && n > 1) row('check', t('epMarkUpTo', { n: localDigits(n) }), () => setProgress(n)); }
  if (got) {
    row('info', t('details'), () => navigate(`/task/${encodeURIComponent(got.id)}`));
    row('trash', t('epDeleteDownload'), () => { const c = openSheet(t('epDeleteDownload'), t('close'), { stack: true }); c.body.append(h('p', null, t('epDeleteAsk', { n: localDigits(n) })), h('p', { class: 'src', dir: 'auto' }, got.name));
      c.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => c.close() }, t('cancel')), h('button', { type: 'button', class: 'btn primary danger', onclick: async () => { c.close(); await getEngine().remove(got.id, true).catch((er) => toast(String((er as Error).message ?? er), 'error')); void import('../downloads/episodeCache').then((m) => m.forget(got.id)); toast(t('epDeleted', { n: localDigits(n) })); changed(); } }, icon('trash'), t('epDeleteYes'))); }, ' danger');
  }
}

/** One episode, tapped: watch it now (the best release, played while it comes), online through a streaming
 *  extension, download it (the best release, or one chosen from the list), play what is downloaded, mark it seen. */
function episodeSheet(a: Anime, n: number, title: string, thumb: string | undefined, changed: () => void): void {
  const sh = openSheet(`${titleOf(a)} · ${t('episodeN', { n })}`, t('close')); sh.el.classList.add('ep-sheet');
  sh.body.append(h('div', { class: 'ep-sheet-head' }, thumb ? h('img', { src: thumb, alt: '' }) : h('span', { class: 'ep-num big' }, localDigits(n, 'prose')), h('b', { dir: 'auto' }, title)));
  const row = (ic: string, label: string, hint: string, fn: () => void, primary = false) => sh.body.append(h('button', { type: 'button', class: 'dest-row' + (primary ? ' primary' : ''), onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, h('span', null, label), hint ? h('small', { class: 'src' }, hint) : null)));
  const show = titleOf(a);
  void (async () => {
    const got = (await downloadedEpisodes(a.id)).get(n);
    if (got) {
      const pct = got.total ? Math.round((got.done / got.total) * 100) : 0;
      sh.body.append(h('div', { class: 'ep-sheet-prog' }, h('div', { class: 'task-bar' }, h('i', { style: { width: `${got.state === 'done' ? 100 : pct}%` } })), h('small', { class: 'src' }, got.state === 'done' ? t('downloaded') : t('downloading', { p: localDigits(pct) }))));
      row('play', got.state === 'done' ? t('play') : t('stream'), got.state === 'done' ? '' : t('epStreamHint'), () => void import('../anime/watch').then((m) => m.watchEpisode(a, n, `${show} · ${t('episodeN', { n })}`)), true);
      row('info', t('details'), '', () => navigate(`/task/${encodeURIComponent(got.id)}`));
    } else {
      row('play', t('epWatchNow'), t('epWatchNowHint'), () => void import('../anime/watch').then((m) => m.watchEpisode(a, n, `${show} · ${t('episodeN', { n })}`)), true);
      void import('../anime/stream').then((st) => st.streamProviders()).then((ps) => { if (ps.length && sh.el.isConnected) row('globe', t('streamWatch'), t('epOnlineHint'), () => void import('./animeStream').then((m) => m.streamSheet(a, n))); });
      row('download', t('epDownloadBest'), t('epDownloadBestHint'), () => void (async () => {
        const { buildQuery, searchAll, magnetOf } = await import('../anime/providers'); const { bestRelease } = await import('../anime/watch');
        toast(t('watchFinding'));
        const rs = await searchAll(await buildQuery(a, n), () => undefined); const best = bestRelease(a, n, rs);
        if (!best) { toast(t('watchNone'), 'error', 5000); torrentSheet(a, n); return; }
        const { addFor } = await import('../anime/auto'); await addFor({ ...a, title: show } as Anime, best, n);
        toast(t('taskAdded', { name: best.title })); changed();
      })().catch((e) => toast(String((e as Error).message ?? e), 'error')));
    }
    row('magnet', t('epChoose'), t('epChooseHint'), () => void torrentSheet(a, n));
  })();
}

/** Senpwai's review: every episode's pick shown before anything is added — changeable from the releases that fit —
 *  and, when every pick is clear, added by itself after a short countdown (which can be stopped). */
async function reviewRange(sh: ReturnType<typeof openSheet>, log: HTMLElement, a: Anime, o: Parameters<typeof downloadRange>[1], stopped: () => boolean): Promise<void> {
  const { planRange, addFor } = await import('../anime/auto');
  const rowOf = new Map<number, HTMLElement>();
  const label = (r: TorrentResult) => { const p = parseFilename(r.title); return [r.resolution ?? p.resolution ?? '', r.size ? formatBytes(r.size) : '', `↑${localDigits(r.seeders)}`, p.group ?? r.group ?? '', r.provider].filter(Boolean).join(' · '); };
  const draw = (it: import('../anime/auto').PlanItem) => {
    const el = h('div', { class: 'range-row review s-' + (it.state === 'pick' ? (it.clear ? 'added' : 'unsure') : it.state) },
      h('b', null, localDigits(it.ep)),
      h('span', { class: 'grow' }, h('span', { dir: 'auto' }, it.pick ? it.pick.title : t(it.state === 'have' ? 'downloaded' : it.state === 'filler' ? 'filler' : 'autoNone')), it.pick ? h('small', { class: 'src' }, `${label(it.pick)}${it.clear ? '' : ` · ${t('reviewUnsure')}`}`) : null),
      it.options.length > 1 ? h('button', { type: 'button', class: 'btn text small', onclick: () => { const s2 = openSheet(`${t('episodeN', { n: it.ep })}`, t('close'), { stack: true }); s2.body.append(...it.options.map((r) => h('button', { type: 'button', class: 'result-row' + (r === it.pick ? ' best' : ''), onclick: () => { it.pick = r; it.clear = true; s2.close(); const nel = draw(it); rowOf.get(it.ep)?.replaceWith(nel); rowOf.set(it.ep, nel); } }, icon('magnet'), h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, r.title), h('small', { class: 'src' }, label(r)))))); } }, t('reviewChange')) : null);
    return el;
  };
  log.replaceChildren(h('p', { class: 'hint' }, t('reviewFinding')));
  const plan = await planRange(a, o, (it) => { const el = draw(it); rowOf.set(it.ep, el); log.append(el); }, stopped);
  log.querySelector('.hint')?.remove();
  const picks = () => plan.filter((x) => x.state === 'pick' && x.pick);
  let timer = 0;
  const addAll = async () => {
    window.clearInterval(timer); let n = 0; sh.actions.replaceChildren(h('div', { class: 'spinner small' }));
    for (const it of picks()) { try { await addFor(a, it.pick!, it.ep); n++; } catch { /* next */ } }
    toast(t('autoRangeDone', { n: countEpisodes(n) })); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); navigate('/'); } }, t('done')));
  };
  const add = h('button', { type: 'button', class: 'btn primary' }, icon('download'), t('reviewAdd', { n: countEpisodes(picks().length) })) as HTMLButtonElement;
  add.addEventListener('click', () => void addAll());
  sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { window.clearInterval(timer); sh.close(); } }, t('cancel')), add);
  if (!picks().length) { add.disabled = true; return; }
  // Every pick clear: added after ten seconds unless stopped or changed (Senpwai's countdown).
  if (plan.every((x) => x.state !== 'pick' || x.clear)) {
    let left = 10; const note = h('p', { class: 'hint review-count' }); log.prepend(note);
    const tick = () => { note.textContent = t('reviewCountdown', { n: localDigits(left) }); if (left-- <= 0) void addAll(); };
    tick(); timer = window.setInterval(tick, 1000);
    log.addEventListener('click', () => { window.clearInterval(timer); note.remove(); }, { once: true });
  }
}
