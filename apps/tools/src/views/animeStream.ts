// Watch an episode online, through Seanime's streaming extensions: the extension (the last one used first), sub
// or dub, the show it matched (changeable — the choice is kept), the server, then each quality with Play (in the
// app's player, its subtitles loaded, the episode marked watched near the end) and Download (yt-dlp, which
// handles HLS, with the headers the site wants, named after the show and episode).
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { navigate } from '../router';
import { getEngine } from '../engine';
import { titleOf } from './anime';
import type { Anime } from '../anilist';
import type { ProviderEntry } from '../anime/providers';
import * as S from '../anime/stream';

const LAST = 'kt.stream.last';
const pref = (): { id?: string; dub?: boolean; server?: string } => { try { return JSON.parse(localStorage.getItem(LAST) ?? '{}') as { id?: string; dub?: boolean; server?: string }; } catch { return {}; } };
const keepPref = (x: { id?: string; dub?: boolean; server?: string }) => { try { localStorage.setItem(LAST, JSON.stringify({ ...pref(), ...x })); } catch { /* full */ } };

export async function streamSheet(a: Anime, episode: number): Promise<void> {
  const n = episode || 1;
  const sh = openSheet(`${titleOf(a)} · ${t('episodeN', { n })}`, t('close')); sh.el.classList.add('stream-sheet');
  const ps = await S.streamProviders();
  if (!ps.length) { sh.body.append(h('div', { class: 'empty small' }, h('p', null, t('streamNoProviders')), h('button', { type: 'button', class: 'btn primary small', onclick: () => { sh.close(); navigate('/settings/anime'); } }, icon('apps'), t('animeMarket')))); return; }
  const P = pref(); let p: ProviderEntry = ps.find((x) => x.id === P.id) ?? ps[0]; let dub = !!P.dub; let serverName = P.server ?? ''; let run = 0;
  const provRow = h('div', { class: 'chip-row wrap' }); const optRow = h('div', { class: 'chip-row wrap' }); const matchRow = h('div', { class: 'stream-match' }); const srvRow = h('div', { class: 'chip-row wrap' }); const out = h('div', { class: 'stream-sources' });
  sh.body.append(provRow, optRow, matchRow, srvRow, out);
  const busy = (el: HTMLElement, text: string) => el.replaceChildren(h('div', { class: 'row-busy' }, h('span', { class: 'spinner tiny' }), h('span', null, text)));
  const fail = (e: unknown) => out.replaceChildren(h('p', { class: 'empty small' }, String((e as Error)?.message ?? e)));
  const drawProv = () => provRow.replaceChildren(...ps.map((x) => h('button', { type: 'button', class: 'chip small' + (x === p ? ' on' : ''), onclick: () => { p = x; keepPref({ id: x.id }); serverName = ''; drawProv(); void go(); } }, x.icon ? h('img', { class: 'chip-icon', src: x.icon, alt: '' }) : null, x.name)));
  drawProv();

  async function go(): Promise<void> {
    const my = ++run; srvRow.replaceChildren(); out.replaceChildren(); optRow.replaceChildren();
    let st = { episodeServers: [] as string[], supportsDub: false };
    try { st = await S.settingsOf(p); } catch (e) { if (my === run) fail(e); return; }
    if (st.supportsDub) optRow.replaceChildren(...[false, true].map((d) => h('button', { type: 'button', class: 'chip small' + (dub === d ? ' on' : ''), onclick: () => { dub = d; keepPref({ dub: d }); void go(); } }, d ? t('streamDub') : t('streamSub'))));
    else dub = false;
    busy(matchRow, t('streamMatching'));
    let hit: S.StreamHit | null = null; let hits: S.StreamHit[] = [];
    try { ({ hit, hits } = await S.matchShow(p, a, dub)); } catch (e) { if (my === run) { matchRow.replaceChildren(); fail(e); } return; }
    if (my !== run) return;
    if (!hit) { pickShow(hits, true); return; }
    showMatch(hit);
    await episodeFor(hit, st.episodeServers, my);
  }
  function showMatch(hit: S.StreamHit) {
    matchRow.replaceChildren(icon('check'), h('span', { class: 'grow', dir: 'auto' }, t('streamMatched', { title: hit.title })), h('button', { type: 'button', class: 'btn text small', onclick: () => pickShow([], false) }, t('streamChange')));
  }
  /** The show chosen by hand: the hits so far, and a search by another name. */
  function pickShow(hits: S.StreamHit[], none: boolean) {
    const input = h('input', { type: 'search', class: 'search-input', enterkeyhint: 'search', placeholder: t('streamSearchPh'), value: a.titleRomaji || a.title, dir: 'auto' }) as HTMLInputElement;
    const list = h('div', { class: 'result-list' });
    const fill = (xs: S.StreamHit[]) => list.replaceChildren(...(xs.length ? xs.slice(0, 30).map((x) => h('button', { type: 'button', class: 'result-row', onclick: () => { S.saveMatch(p, a, dub, x); showMatch(x); void S.settingsOf(p).then((st) => episodeFor(x, st.episodeServers, ++run)); } }, icon('film'), h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, x.title), h('small', { class: 'src' }, x.subOrDub === 'both' ? `${t('streamSub')} · ${t('streamDub')}` : x.subOrDub === 'dub' ? t('streamDub') : t('streamSub'))))) : [h('p', { class: 'empty small' }, t('noResults'))]));
    const find = async () => { busy(list, t('streamMatching')); try { fill(await S.search(p, a, dub, input.value.trim())); } catch (e) { list.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); } };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void find(); });
    matchRow.replaceChildren(h('p', { class: 'hint' }, none ? t('streamNoMatch') : t('streamPickShow')), h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'btn tonal small', onclick: () => void find() }, icon('search'), t('search'))), list);
    srvRow.replaceChildren(); out.replaceChildren();
    if (hits.length) fill(hits); else void find();
  }
  async function episodeFor(hit: S.StreamHit, servers: string[], my: number) {
    busy(out, t('loading'));
    let eps: S.StreamEpisode[]; try { eps = await S.episodes(p, hit.id); } catch (e) { if (my === run) fail(e); return; }
    if (my !== run) return;
    // (Some sites number a later season from where the first left off: the n-th episode of the list stands in.)
    const ep = eps.find((x) => x.number === n) ?? (eps.length >= n && !eps.some((x) => x.number === n) && eps[0]?.number > 1 ? eps[n - 1] : undefined);
    if (!ep) { out.replaceChildren(h('p', { class: 'empty small' }, t('streamNoEpisode', { n }))); return; }
    const drawSrv = () => srvRow.replaceChildren(...(servers.length > 1 ? [h('span', { class: 'label' }, t('streamServer')), ...servers.map((s) => h('button', { type: 'button', class: 'chip small' + (s === serverName ? ' on' : ''), onclick: () => { serverName = s; keepPref({ server: s }); drawSrv(); void sources(ep, my); } }, s))] : []));
    if (!servers.includes(serverName)) serverName = servers[0] ?? '';
    drawSrv(); await sources(ep, my);
  }
  async function sources(ep: S.StreamEpisode, my: number) {
    busy(out, t('loading'));
    let sv: S.StreamServer; try { sv = await S.anyServer(p, ep, serverName); } catch (e) { if (my === run) fail(e); return; }
    if (my !== run) return;
    if (sv.server && sv.server !== serverName) { serverName = sv.server; srvRow.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.textContent === sv.server)); }
    const subs = sv.videoSources.flatMap((v) => v.subtitles).filter((x, i, all) => all.findIndex((y) => y.url === x.url) === i);
    out.replaceChildren(...sv.videoSources.map((v) => h('div', { class: 'stream-row' },
      h('span', { class: 'grow' }, h('b', null, v.quality ? localDigits(v.quality) : v.label || v.type.toUpperCase()), h('small', { class: 'src' }, [v.label && v.quality ? v.label : '', v.type === 'm3u8' ? 'HLS' : v.type === 'mp4' ? 'MP4' : '', sv.server].filter(Boolean).join(' · '))),
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => void download(v, sv, ep) }, icon('download'), t('download')),
      h('button', { type: 'button', class: 'btn primary small', onclick: () => void play(v, sv, ep, subs) }, icon('play'), t('play')))),
      ...(subs.length ? [h('p', { class: 'hint' }, t('streamSubs', { list: [...new Set(subs.map((s) => s.language))].join('، ') }))] : []));
  }
  async function play(v: S.StreamSource, sv: S.StreamServer, ep: S.StreamEpisode, subs: S.StreamSource['subtitles']) {
    try {
      const url = await S.playableUrl(v, sv.headers);
      const { openPlayer } = await import('./player');
      sh.close();
      await openPlayer(url, `${titleOf(a)} - ${String(ep.number).padStart(2, '0')}`, { meta: { anilistId: a.id, title: titleOf(a), episode: n, cover: a.cover }, subtitles: subs.map((s) => ({ url: s.url, name: s.language, lang: s.language, isDefault: s.isDefault })) });
    } catch (e) { toast(String((e as Error).message ?? e), 'error'); }
  }
  async function download(v: S.StreamSource, sv: S.StreamServer, ep: S.StreamEpisode) {
    const name = `${titleOf(a)} - ${String(ep.number).padStart(2, '0')}${v.quality ? ` [${v.quality}]` : ''}`;
    try {
      const meta = { anilistId: a.id, title: titleOf(a), episode: n, cover: a.cover };
      // (A file goes to the downloader itself — several connections, resumable; HLS to yt-dlp, which joins its parts.)
      let tk;
      if (v.type === 'mp4') tk = await getEngine().add({ source: { url: v.url, headers: sv.headers }, name: `${name}.mp4`, sequential: true, meta });
      else { const { videoSupported } = await import('../video/ytdlp'); if (!videoSupported()) { toast(t('streamNeedsVideo'), 'error', 6000); return; } tk = await getEngine().add({ source: { url: v.url, headers: sv.headers }, name, meta, video: { title: name, site: p.name, label: v.quality, headers: sv.headers, outName: name } }); }
      toast(t('taskAdded', { name: tk.name || name })); sh.close(); navigate('/');
    } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); }
  }
  await go();
}
