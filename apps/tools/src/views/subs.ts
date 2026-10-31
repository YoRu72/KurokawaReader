// The Subtitles tab (with the Subtitles add-on): one box — a name, or an AniList / MAL / IMDb link — the title
// chosen from AniList and IMDb cards, the season and episode and languages picked, then every subtitle site at
// once, results grouped and ranked; a tap downloads the file (archives are unpacked by the Archives add-on).
import { h, icon, iconButton, toast, debounce, openSheet } from '../ui/dom';
import { t, localDigits, formatBytes, countResults, getLang } from '../i18n';
import { navigate } from '../router';
import { getSettings, updateSettings } from '../settings';
import { getEngine } from '../engine';
import { lookup, enrich, parseRef, type TitleCard } from '../subs/lookup';
import { searchSubtitles, subtitleSources, queryFor, rankSubs, resolveLink, type SubResult, type SubQuery } from '../subs/search';

export const LANG_NAMES: Record<string, string> = { en: 'English', ar: 'العربية', ja: '日本語', ko: '한국어', zh: '中文', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', it: 'Italiano', ru: 'Русский', tr: 'Türkçe', fa: 'فارسی', id: 'Indonesia', vi: 'Tiếng Việt', th: 'ไทย', nl: 'Nederlands', pl: 'Polski', sv: 'Svenska', he: 'עברית', hi: 'हिन्दी', ms: 'Melayu', el: 'Ελληνικά', ro: 'Română', hu: 'Magyar', cs: 'Čeština', uk: 'Українська', bg: 'Български', hr: 'Hrvatski', sr: 'Srpski', da: 'Dansk', fi: 'Suomi', no: 'Norsk', bn: 'বাংলা' };
const kindName = (k: TitleCard['kind']) => t(k === 'anime' ? 'kindAnime' : k === 'movie' ? 'formatMovie' : 'kindSeries');

export function subsView(q?: string): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'body subs-body' });
  const root = h('div', { class: 'view subs-view' }, h('header', { class: 'topbar' }, h('div', { class: 'title' }, h('span', null, t('navSubs'))), h('div', { class: 'topbar-actions' }, iconButton('puzzle', t('addons'), () => navigate('/settings/addons')))), body) as HTMLElement & { dispose?: () => void };
  const input = h('input', { type: 'search', class: 'search-input', placeholder: t('subsSearchHint'), value: q ?? '', enterkeyhint: 'search' }) as HTMLInputElement;
  const cards = h('div', { class: 'title-cards' }); const picked = h('div'); const results = h('div', { class: 'subs-results' });
  body.append(h('form', { class: 'search-form', onsubmit: (e: Event) => { e.preventDefault(); void find(); } }, input), cards, picked, results);
  let token = 0; let current: TitleCard | null = null; let season: number | undefined; let episode: number | undefined;
  const find = async () => {
    const s = input.value.trim(); const my = ++token; picked.replaceChildren(); results.replaceChildren(); current = null;
    if (!s) { cards.replaceChildren(); return; }
    navigate(`/subs?q=${encodeURIComponent(s)}`, true);
    cards.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
    try {
      const found = await lookup(s, getSettings().animeAdult); if (my !== token) return;
      if (!found.length) { cards.replaceChildren(h('p', { class: 'empty small' }, t('noResults'))); return; }
      cards.replaceChildren(...found.map((c) => h('button', { type: 'button', class: 'title-card', onclick: () => void pick(c) },
        c.cover ? h('img', { src: c.cover, alt: '', loading: 'lazy' }) : h('span', { class: 'title-noimg' }, icon(c.kind === 'anime' ? 'tv' : 'film')),
        h('span', { class: 'title-text' }, h('b', { dir: 'auto' }, c.title), h('small', { class: 'src' }, [kindName(c.kind), c.year ? localDigits(c.year) : '', c.episodes ? t('episodesN', { n: c.episodes }) : '', c.ids.imdb ?? ''].filter(Boolean).join(' · '))))));
      if (parseRef(s) && found.length === 1) void pick(found[0]);
    } catch (e) { cards.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
  };
  const pick = async (c: TitleCard) => {
    current = await enrich(c); season = c.kind === 'series' ? 1 : undefined; episode = undefined;
    cards.querySelectorAll('.title-card').forEach((el) => el.classList.toggle('on', (el as HTMLElement).querySelector('b')?.textContent === c.title));
    drawPicked(); void run();
  };
  const drawPicked = () => {
    const c = current!; const s = getSettings();
    const num = (label: string, val: number | undefined, max: number | undefined, set: (v: number | undefined) => void) => h('label', { class: 'num-field' }, h('span', null, label), h('input', { type: 'number', min: '1', max: max ? String(max) : undefined, value: val ?? '', placeholder: t('subsAll'), inputmode: 'numeric', onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); set(v > 0 ? v : undefined); void run(); } }));
    const langs = h('div', { class: 'chips lang-chips' }, ...s.subLangs.map((l) => h('span', { class: 'chip small on' }, LANG_NAMES[l] ?? l, iconButton('close', t('remove'), () => { updateSettings({ subLangs: s.subLangs.filter((x) => x !== l) }); drawPicked(); void run(); }))), h('button', { type: 'button', class: 'chip small', onclick: () => langSheet(() => { drawPicked(); void run(); }) }, icon('plus'), t('subsAddLang')));
    picked.replaceChildren(h('section', { class: 'card picked-card' }, h('div', { class: 'picked-row' }, c.cover ? h('img', { src: c.cover, alt: '' }) : null, h('div', { class: 'grow' }, h('b', { dir: 'auto' }, c.title), h('small', { class: 'src' }, [kindName(c.kind), c.year ? localDigits(c.year) : '', c.ids.imdb, c.ids.anilist ? `AniList ${localDigits(c.ids.anilist)}` : '', c.ids.mal ? `MAL ${localDigits(c.ids.mal)}` : ''].filter(Boolean).join(' · '))), iconButton('close', t('close'), () => { current = null; picked.replaceChildren(); results.replaceChildren(); })),
      c.kind === 'movie' ? null : h('div', { class: 'num-row' }, c.kind === 'series' ? num(t('subsSeason'), season, c.seasons, (v) => { season = v; }) : null, num(t('subsEpisode'), episode, c.episodes, (v) => { episode = v; })),
      langs));
  };
  const run = async () => {
    const c = current; if (!c) return; const my = ++token;
    const srcs = await subtitleSources();
    results.replaceChildren();
    if (!srcs.length) { results.append(h('div', { class: 'empty small' }, h('p', null, t('subsNoSources')), h('button', { type: 'button', class: 'btn primary small', onclick: () => navigate('/settings/addons') }, icon('puzzle'), t('addons')))); return; }
    const langs = getSettings().subLangs; if (!langs.length) { results.append(h('p', { class: 'empty small' }, t('subsPickLang'))); return; }
    const status = h('div', { class: 'chips provider-chips' }, ...srcs.map((a) => h('span', { class: 'chip small busy', dataset: { id: a.id } }, h('span', { class: 'spinner tiny' }), a.name)));
    const list = h('div', { class: 'sub-list' }); results.append(status, list);
    const query = queryFor(c, season, episode, langs); let all: SubResult[] = [];
    const redraw = () => { const rs = rankSubs(all, langs, episode); list.replaceChildren(...rs.slice(0, 150).map((r) => row(r, query))); if (!rs.length && !status.querySelector('.busy')) list.append(h('p', { class: 'empty small' }, t('noResults'))); };
    await searchSubtitles(query, (a, res) => {
      if (my !== token) return;
      const chip = status.querySelector<HTMLElement>(`[data-id="${CSS.escape(a.id)}"]`);
      if (chip) { chip.classList.remove('busy'); chip.querySelector('.spinner')?.remove(); if (res instanceof Error) { chip.classList.add('failed'); chip.title = res.message; chip.prepend(icon('alert')); chip.onclick = () => toast(res.message, 'error', 5000); } else chip.append(h('small', null, ` ${countResults(res.length)}`)); }
      if (!(res instanceof Error)) all = all.concat(res); redraw();
    });
  };
  const row = (r: SubResult, query: SubQuery) => h('button', { type: 'button', class: 'result-row sub-row', onclick: () => void download(r, query) },
    h('span', { class: 'lang-badge' }, (r.language ?? '?').toUpperCase()),
    h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, r.title), h('small', { class: 'src' }, [r.site, r.season && r.episode ? `S${localDigits(r.season)}E${localDigits(r.episode)}` : r.episode ? t('episodeN', { n: r.episode }) : '', r.hi ? t('subsHI') : '', r.partial ? t('subsPartial') : '', r.ai ? t('subsAI') : '', r.downloads ? `↓${localDigits(r.downloads)}` : '', r.size ? formatBytes(r.size) : '', r.archive ?? '', r.note ?? ''].filter(Boolean).join(' · '))),
    icon('download'));
  const download = async (r: SubResult, query: SubQuery) => {
    try {
      const { url, name } = await resolveLink(r, query);
      const base = `${current?.title ?? r.title}${query.season ? ` S${String(query.season).padStart(2, '0')}` : ''}${r.episode ?? query.episode ? `E${String(r.episode ?? query.episode).padStart(2, '0')}` : ''} [${(r.language ?? 'xx').toUpperCase()}] ${r.site}`.replace(/[\\/:*?"<>|]+/g, ' ');
      const ext = r.archive ? `.${r.archive}` : /\.(srt|ass|ssa|vtt|sub)$/i.exec(name ?? url)?.[0] ?? '.srt';
      const tk = await getEngine().add({ source: { url }, name: name && !r.archive ? name : `${base}${ext}`, dir: subsDir(), meta: { kind: 'subtitle', title: current?.title, episode: r.episode ?? query.episode, season: query.season, anilistId: query.anilistId, imdbId: query.imdbId, addon: r.addon, archive: r.archive, lang: r.language } });
      toast(t('taskAdded', { name: tk.name || base }));
    } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); }
  };
  if (q) void find(); else input.addEventListener('input', debounce(() => { if (parseRef(input.value)) void find(); }, 400));
  root.dispose = () => { token++; };
  return root;
}
const subsDir = (): string | undefined => { const d = getSettings().downloadDir; return d && !d.startsWith('content:') ? `${d.replace(/[\\/]$/, '')}/Subtitles` : undefined; };

export function langSheet(done: () => void): void {
  const sh = openSheet(t('subsLanguages'), t('close'), { stack: true });
  const cur = new Set(getSettings().subLangs);
  sh.body.append(h('div', { class: 'dest-list' }, ...Object.entries(LANG_NAMES).map(([code, name]) => h('label', { class: 'dest-row' + (cur.has(code) ? ' on' : '') }, h('input', { type: 'checkbox', checked: cur.has(code), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) cur.add(code); else cur.delete(code); updateSettings({ subLangs: [...cur] }); } }), h('span', { class: 'name', dir: 'auto' }, name), h('small', { class: 'src' }, code)))));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); done(); } }, t('done')));
  void getLang;
}
