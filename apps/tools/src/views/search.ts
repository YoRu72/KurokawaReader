// Torrent search, the OTL way: what is typed is looked up on AniList and IMDb (through Cinemeta) as covers to
// pick from, while every torrent-search add-on is asked; the releases that come back are taken apart and put
// under the work each belongs to — its cover, title, year and ids — the best releases first. Picking a work
// asks the sources again by its ids (a series by season and episode), and an anime opens its own page when
// the Anime add-on is there.
import { h, icon, iconButton, toast } from '../ui/dom';
import { t, formatBytes, localDigits, countResults } from '../i18n';
import { navigate } from '../router';
import { getSettings } from '../settings';
import { lookup, enrich, type TitleCard } from '../subs/lookup';
import { runSearch, searchSources, warmSources, addResult, type SearchResult, type TitleCtx } from '../addons/search';
import { parseRelease, groupKey, matchRelease, type Release } from '../meta/match';
import { similar } from '../anime/anitomy';

const kindName = (k: TitleCard['kind']) => t(k === 'anime' ? 'kindAnime' : k === 'movie' ? 'formatMovie' : 'kindSeries');
const QUAL = ['2160p', '1080p', '720p', '480p'];

export function searchView(q?: string): HTMLElement & { dispose?: () => void } {
  const input = h('input', { type: 'search', class: 'search-input', placeholder: t('torrentSearchHint'), value: q ?? '', dir: 'auto', enterkeyhint: 'search' }) as HTMLInputElement;
  const body = h('div', { class: 'body search-body' });
  const root = h('div', { class: 'view search-view' }, h('header', { class: 'topbar' }, h('div', { class: 'title' }, h('span', null, t('navSearch'))), h('div', { class: 'topbar-actions' }, iconButton('puzzle', t('addons'), () => navigate('/settings/addons')))), body) as HTMLElement & { dispose?: () => void };
  let token = 0; let picked: TitleCard | null = null; let season: number | undefined; let episode: number | undefined; let qual = ''; let sort: 'seeds' | 'size' | 'name' = 'seeds';
  const cards = h('div', { class: 'title-cards' }); const pickedBox = h('div'); const status = h('div', { class: 'chips provider-chips' }); const tools = h('div', { class: 'chip-row wrap search-tools' }); const list = h('div', { class: 'release-groups' });
  body.append(h('form', { class: 'search-form', onsubmit: (e: Event) => { e.preventDefault(); picked = null; void find(); } }, input), cards, pickedBox, status, tools, list);
  let found: TitleCard[] = []; let results: SearchResult[] = []; const matched = new Map<string, TitleCard | null>();
  // (While typing: the works it may be, as covers, before Enter — the sources are asked on Enter or a cover's tap.)
  let typeTimer = 0; let typed = '';
  input.addEventListener('input', () => { window.clearTimeout(typeTimer); const s = input.value.trim(); if (s.length < 3 || s === typed) return; typeTimer = window.setTimeout(() => { typed = s; const my = token; void lookup(s, getSettings().animeAdult).then((c) => { if (my !== token || input.value.trim() !== s || picked) return; found = c; drawCards(); }).catch(() => undefined); }, 450); });

  const empty = async () => {
    if ((await searchSources()).length) return false;
    list.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('magnet')), h('h2', null, t('torrentSearch')), h('p', null, t('torrentSearchNoSources')), h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('/settings/addons') }, icon('puzzle'), t('addons')))));
    return true;
  };
  const find = async () => {
    const s = input.value.trim(); const my = ++token; results = []; matched.clear(); list.replaceChildren(); status.replaceChildren(); tools.replaceChildren(); pickedBox.replaceChildren();
    if (!s) { cards.replaceChildren(); return; }
    navigate(`/search?q=${encodeURIComponent(s)}`, true);
    if (await empty()) return;
    cards.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' })));
    void lookup(s, getSettings().animeAdult).then((c) => { if (my !== token) return; found = c; drawCards(); regroup(); }).catch(() => { if (my === token) cards.replaceChildren(); });
    await search(s, undefined, my);
  };
  const drawCards = () => {
    cards.replaceChildren(...found.slice(0, 14).map((c) => h('button', { type: 'button', class: 'title-card' + (picked === c ? ' on' : ''), onclick: () => void pick(c) },
      c.cover ? h('img', { src: c.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'title-noimg' }, icon(c.kind === 'anime' ? 'tv' : 'film')),
      h('span', { class: 'title-text' }, h('b', { dir: 'auto' }, c.title), h('small', { class: 'src' }, [kindName(c.kind), c.year ? localDigits(c.year, 'prose') : ''].filter(Boolean).join(' · '))))));
  };
  const pick = async (c: TitleCard) => {
    if (picked === c) { picked = null; drawCards(); pickedBox.replaceChildren(); void find(); return; }
    picked = c; drawCards(); season = c.kind === 'series' ? 1 : undefined; episode = c.kind === 'series' ? 1 : undefined;
    pickedBox.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' })));
    const e = await enrich(c).catch(() => c); if (picked !== c) return; picked = e; drawPicked(); void searchPicked();
  };
  const drawPicked = () => {
    const c = picked!; const s = getSettings();
    const num = (label: string, val: number | undefined, set: (v: number | undefined) => void) => h('label', { class: 'num-field' }, h('span', null, label), h('input', { type: 'number', min: '0', value: val ?? '', placeholder: t('subsAll'), inputmode: 'numeric', onchange: (ev: Event) => { const v = Number((ev.target as HTMLInputElement).value); set(v > 0 ? v : undefined); void searchPicked(); } }));
    pickedBox.replaceChildren(h('section', { class: 'card picked-card' },
      h('div', { class: 'picked-row' }, c.cover ? h('img', { src: c.cover, alt: '', referrerpolicy: 'no-referrer' }) : null,
        h('div', { class: 'grow' }, h('b', { dir: 'auto' }, c.title), h('small', { class: 'src' }, [kindName(c.kind), c.year ? localDigits(c.year, 'prose') : '', c.ids.imdb ?? '', c.ids.anilist ? `AniList ${c.ids.anilist}` : ''].filter(Boolean).join(' · '))),
        iconButton('close', t('close'), () => { picked = null; drawCards(); pickedBox.replaceChildren(); void find(); })),
      c.kind === 'series' ? h('div', { class: 'num-row' }, num(t('subsSeason'), season, (v) => { season = v; }), num(t('subsEpisode'), episode, (v) => { episode = v; })) : null,
      c.kind === 'anime' && c.ids.anilist && s.addons.includes('anime') ? h('button', { type: 'button', class: 'btn tonal small', onclick: () => navigate(`/anime/${c.ids.anilist}`) }, icon('tv'), t('openInAnime')) : null));
  };
  const searchPicked = async () => {
    const c = picked; if (!c) return; const my = ++token; results = []; matched.clear(); list.replaceChildren();
    const ctx: TitleCtx = { kind: c.kind, title: c.title, titles: c.titles, year: c.year, imdb: c.ids.imdb, anilist: c.ids.anilist, mal: c.ids.mal, kitsu: c.ids.kitsu, season, episode };
    const name = c.kind === 'movie' ? `${c.title}${c.year ? ` ${c.year}` : ''}` : c.kind === 'series' && season ? `${c.title} S${String(season).padStart(2, '0')}${episode ? `E${String(episode).padStart(2, '0')}` : ''}` : c.titles.find((x) => /^[\x20-\x7e]+$/.test(x)) ?? c.title;
    await search(name, ctx, my);
  };
  const search = async (query: string, ctx: TitleCtx | undefined, my: number) => {
    const srcs = await searchSources(); if (my !== token) return;
    status.replaceChildren(...srcs.map((a) => h('span', { class: 'chip small busy', dataset: { id: a.id } }, h('span', { class: 'spinner tiny' }), a.name)));
    list.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
    await runSearch(query, ctx, (a, res) => {
      if (my !== token) return;
      const chip = status.querySelector<HTMLElement>(`[data-id="${CSS.escape(a.id)}"]`);
      if (chip) { chip.classList.remove('busy'); chip.querySelector('.spinner')?.remove(); if (res instanceof Error) { chip.classList.add('failed'); chip.title = res.message; chip.prepend(icon('alert')); chip.onclick = () => toast(res.message, 'error', 6000); } else chip.append(h('small', null, ` ${countResults(res.length)}`)); }
      if (!(res instanceof Error)) { results = results.concat(res); regroup(); } else if (!status.querySelector('.busy')) regroup();
    });
    if (my === token) regroup();
  };

  // ---- grouping under works ----
  type Group = { key: string; rel: Release; rows: { r: SearchResult; p: Release }[] };
  let groupTimer = 0;
  const regroup = () => { clearTimeout(groupTimer); groupTimer = window.setTimeout(draw, 120); };
  const draw = () => {
    const busy = !!status.querySelector('.busy');
    let rows = results.map((r) => ({ r, p: parseRelease(r.title) }));
    if (qual) rows = rows.filter((x) => (x.r.quality ?? x.p.resolution ?? '').toLowerCase().startsWith(qual));
    rows.sort((a, b) => (sort === 'size' ? (b.r.size ?? 0) - (a.r.size ?? 0) : sort === 'name' ? a.r.title.localeCompare(b.r.title) : (b.r.seeds ?? 0) - (a.r.seeds ?? 0)));
    tools.replaceChildren(...(results.length ? [
      ...['', ...QUAL].map((q) => h('button', { type: 'button', class: 'chip small' + (qual === q ? ' on' : ''), onclick: () => { qual = q; draw(); } }, q || t('allQualities'))),
      h('span', { class: 'chip-sep' }),
      h('button', { type: 'button', class: 'chip small', onclick: () => { sort = sort === 'seeds' ? 'size' : sort === 'size' ? 'name' : 'seeds'; draw(); } }, icon('sort'), t(sort === 'seeds' ? 'sortSeeds' : sort === 'size' ? 'sortSize' : 'sortName')),
    ] : []));
    if (!rows.length) { list.replaceChildren(busy ? h('div', { class: 'center' }, h('div', { class: 'spinner' })) : h('p', { class: 'empty small' }, t('noResults'))); return; }
    // When a work is picked, everything is under it.
    if (picked) {
      // Under the picked work: what the id-searching sources returned for it, and the named releases that are it.
      const c = picked; const byId = new Set(['torrentio', 'yts', 'eztv']);
      const mine = rows.filter(({ r, p }) => byId.has(r.source) || (Math.max(...[c.title, ...c.titles].map((x) => similar(x, p.title))) >= 0.62 && (!p.year || !c.year || Math.abs(p.year - c.year) <= 1) && (c.kind !== 'movie' || p.season === undefined)));
      list.replaceChildren(mine.length ? groupCard({ key: 'picked', rel: parseRelease(c.title), rows: mine }, c, true) : h('p', { class: 'empty small' }, busy ? '' : t('noResults'))); return;
    }
    const groups = new Map<string, Group>();
    for (const x of rows) { const k = groupKey(x.p) || x.r.title; const g = groups.get(k) ?? groups.set(k, { key: k, rel: x.p, rows: [] }).get(k)!; g.rows.push(x); }
    // Groups that are the same work once matched are joined under it.
    const byWork = new Map<string, { card: TitleCard | null; groups: Group[] }>();
    for (const g of groups.values()) { const c = matched.get(g.key); const wk = c ? `${c.kind}:${c.ids.anilist ?? c.ids.imdb ?? c.title}` : `g:${g.key}`; const w = byWork.get(wk) ?? byWork.set(wk, { card: c ?? null, groups: [] }).get(wk)!; w.groups.push(g); }
    const works = [...byWork.values()].map((w) => ({ card: w.card, rows: w.groups.flatMap((g) => g.rows), rel: w.groups[0].rel, key: w.groups[0].key }));
    works.sort((a, b) => (b.card ? 1 : 0) - (a.card ? 1 : 0) || Math.max(...b.rows.map((x) => x.r.seeds ?? 0)) - Math.max(...a.rows.map((x) => x.r.seeds ?? 0)));
    list.replaceChildren(...works.slice(0, 40).map((w) => groupCard(w, w.card, false)));
    // Covers for the groups not yet matched: the ones on top first, a few at a time.
    const todo = [...groups.values()].filter((g) => !matched.has(g.key)).sort((a, b) => b.rows.length - a.rows.length).slice(0, 10);
    // (Three at a time: each is a lookup on AniList or Cinemeta, and one slow answer no longer holds the rest.)
    const my = token; let next = 0;
    const worker = async () => { while (next < todo.length) { const g = todo[next++]; if (my !== token) return; if (matched.has(g.key)) continue; matched.set(g.key, null); const c = await matchRelease(g.rel, found, getSettings().animeAdult).catch(() => null); if (my !== token) return; matched.set(g.key, c); if (c) regroup(); } };
    for (let k = 0; k < 3; k++) void worker();
  };
  const groupCard = (w: { rows: { r: SearchResult; p: Release }[]; rel: Release; key: string }, card: TitleCard | null, open: boolean) => {
    const more = w.rows.length > 4 && !open; let expanded = open;
    const rowsBox = h('div', { class: 'release-rows' });
    const fill = () => { rowsBox.replaceChildren(...(expanded ? w.rows : w.rows.slice(0, 4)).slice(0, 120).map(({ r, p }) => releaseRow(r, p, card)), ...(more ? [h('button', { type: 'button', class: 'btn text small', onclick: () => { expanded = !expanded; fill(); } }, expanded ? t('showLess') : t('showAllN', { n: w.rows.length }))] : [])); };
    fill();
    const title = card?.title ?? w.rel.title ?? w.rows[0].r.title;
    const facts = card ? [kindName(card.kind), card.year ? localDigits(card.year, 'prose') : '', card.ids.imdb ?? ''].filter(Boolean).join(' · ') : [w.rel.year ? localDigits(w.rel.year, 'prose') : '', w.rel.anime ? t('kindAnime') : ''].filter(Boolean).join(' · ');
    return h('section', { class: 'release-group' },
      h('div', { class: 'release-head' + (card ? ' tappable' : ''), onclick: card ? () => { if (!found.includes(card)) found.unshift(card); void pick(card); } : undefined },
        card?.cover ? h('img', { class: 'release-cover', src: card.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'release-cover none' }, icon(w.rel.anime ? 'tv' : 'magnet')),
        h('div', { class: 'grow' }, h('b', { dir: 'auto' }, title), h('small', { class: 'src' }, [facts, countResults(w.rows.length)].filter(Boolean).join(' · ')))),
      rowsBox);
  };
  const releaseRow = (r: SearchResult, p: Release, card: TitleCard | null) => h('button', { type: 'button', class: 'result-row', onclick: () => void addResult(r, card ? { anilistId: card.ids.anilist, imdbId: card.ids.imdb, cover: card.cover, title: card.title, episode: p.episode, season: p.season } : {}) },
    icon(r.magnet || r.torrent ? 'magnet' : 'link'),
    h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, r.title),
      h('small', { class: 'src' }, [r.quality ?? p.resolution, r.size ? formatBytes(r.size) : '', r.seeds !== undefined ? `↑${localDigits(r.seeds)}` : '', p.season !== undefined && p.episode !== undefined ? `S${String(p.season).padStart(2, '0')}E${String(p.episode).padStart(2, '0')}` : p.episode !== undefined ? t('episodeN', { n: p.episode }) : '', p.batch ? t('animeBatch') : '', r.date ?? '', r.source].filter(Boolean).join(' · '))));

  void warmSources();
  if (q) void find(); else void empty();
  root.dispose = () => { token++; };
  return root;
}
