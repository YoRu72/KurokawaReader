// The «Find subtitles» sheet (the Subtitles add-on's sources): the show looked up by its id or the words typed, an
// episode (blank: the whole season, for sources that give packs), the results ranked; what is done with the one
// tapped is the caller's — loaded into the player, or saved into the show's subtitles folder from its page.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { getSettings } from '../settings';
import type { SubQuery, SubResult } from './search';

export interface FindOptions { title: string; anilistId?: number; imdbId?: string; season?: number; episode?: number;
  /** A season field too (a series' page). */ askSeason?: boolean; /** Only results the app can open itself (a .zip/.gz or a plain file). */ openableOnly?: boolean;
  onPick(r: SubResult, q: SubQuery, close: () => void): Promise<void>; /** The Subtitles add-on is not there: what «Get it» does besides closing. */ onGetAddon?(): void }

export function findSubsSheet(o: FindOptions): void {
  const sh = openSheet(t('subsFind'), t('close'));
  if (!getSettings().addons.includes('subtitles')) {
    sh.body.append(h('p', { class: 'hint' }, t('subsNoSources')), h('button', { type: 'button', class: 'btn filled', onclick: () => { sh.close(); o.onGetAddon?.(); location.hash = '#/settings/addons'; } }, icon('plus'), t('subsGetAddon')));
    return;
  }
  const q = h('input', { type: 'search', dir: 'auto', value: o.title, placeholder: t('subsSearchHint'), enterkeyhint: 'search' }) as HTMLInputElement;
  const num = (v: number | undefined, ph: string) => h('input', { type: 'number', min: '0', inputmode: 'numeric', value: v != null ? String(v) : '', placeholder: ph, style: { width: '5.5em' }, 'aria-label': ph }) as HTMLInputElement;
  const seIn = o.askSeason ? num(o.season, t('tvSeason')) : null; const epIn = num(o.episode, t('subsEpisode'));
  const out = h('div', { class: 'sub-results' });
  const form = h('form', { class: 'row sub-search', onsubmit: (e: Event) => { e.preventDefault(); void run(); } }, q, ...(seIn ? [seIn] : []), epIn, h('button', { type: 'submit', class: 'btn tonal small' }, icon('search'), t('search')));
  sh.body.append(form, ...(o.openableOnly ? [h('p', { class: 'hint' }, t('subsWholeSeasonHint'))] : []), out);
  let token = 0;
  const run = async () => {
    const { lookup, enrich } = await import('./lookup'); const { searchSubtitles, queryFor, rankSubs } = await import('./search');
    const my = ++token; const words = q.value.trim(); const ep = epIn.value.trim() === '' ? undefined : Number(epIn.value); const season = seIn ? (seIn.value.trim() === '' ? undefined : Number(seIn.value)) : o.season;
    if (!words) { out.replaceChildren(h('p', { class: 'empty small' }, t('subsSearchHint'))); return; }
    out.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
    try {
      // (The show's own id while the words are still its title — the right show, not the first by that name.)
      const same = words === o.title; const ref = same && o.anilistId ? `anilist:${o.anilistId}` : same && o.imdbId ? o.imdbId : words;
      const cards = await lookup(ref); if (my !== token) return;
      if (!cards.length) { out.replaceChildren(h('p', { class: 'empty small' }, t('noResults'))); return; }
      const c = await enrich(cards[0]); const query = queryFor(c, season, ep, getSettings().subLangs); const list = h('div', { class: 'sub-list' }); if (my !== token) return;
      out.replaceChildren(h('p', { class: 'src', dir: 'auto' }, `${c.title}${ep != null ? ` · ${t('episodeN', { n: ep })}` : o.openableOnly ? ` · ${t('subsWholeSeason')}` : ''}`), list);
      let found: SubResult[] = [];
      await searchSubtitles(query, (_a, res) => { if (my !== token) return; if (!(res instanceof Error)) found = found.concat(res.filter((r) => !o.openableOnly || !r.archive || /^(zip|gz)$/i.test(r.archive)));
        list.replaceChildren(...rankSubs(found, getSettings().subLangs, ep).slice(0, 60).map((r) => h('button', { type: 'button', class: 'result-row sub-row', onclick: async () => { try { await o.onPick(r, query, () => sh.close()); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } } }, h('span', { class: 'lang-badge' }, (r.language ?? '?').toUpperCase()), h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, r.title), h('small', { class: 'src' }, [r.site, o.openableOnly && r.episode === undefined ? t('subsWholeSeason') : '', r.hi ? t('subsHI') : '', r.archive ?? ''].filter(Boolean).join(' · ')))))); });
      if (my === token && !found.length) list.append(h('p', { class: 'empty small' }, t('noResults')));
    } catch (e) { if (my === token) out.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
  };
  void run();
}
