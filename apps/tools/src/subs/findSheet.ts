// The «Find subtitles» sheet (the Subtitles add-on's sources): the show looked up by its id or the words typed, an
// episode (blank: the whole season, for sources that give packs), the results ranked like a pack's files (this
// episode's first, the user's languages in order, the video's own group, .ass before .srt; ../player/subMatch); each
// source's wait seen, a slow one said, a failed one said plainly with «Try again»; the words, season and episode kept
// for the next time it opens on the same show. A result can be previewed (its first lines, the files an archive holds)
// before it is applied, applied in one tap, and — a season's pack — used for the show (it becomes one of its sources);
// what is done with the one applied is the caller's — loaded into the player, or saved into the show's subtitles
// folder from its page.
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { getSettings } from '../settings';
import type { SubQuery, SubResult, RankedSub } from './search';

export interface FindOptions { title: string; anilistId?: number; imdbId?: string; season?: number; episode?: number;
  /** A season field too (a series' page). */ askSeason?: boolean; /** Only results the app can open itself (a .zip/.gz or a plain file). */ openableOnly?: boolean;
  /** The video's own name (its release group ranks results), and the show's key (what was applied before is kept by it). */ videoName?: string; showKey?: string | null;
  onPick(r: SubResult, q: SubQuery, close: () => void, files?: { name: string; bytes: Uint8Array }[]): Promise<void>;
  /** A pack result made one of the show's sources. */ onUseForShow?(files: { name: string; bytes: Uint8Array }[], r: SubResult, close: () => void): Promise<void>;
  /** The Subtitles add-on is not there: what «Get it» does besides closing. */ onGetAddon?(): void }

const LAST = 'kt.tmp.subsFind';
const SLOW_MS = 6000;
/** A result's files, fetched and unpacked (an archive's subtitle files, this episode's first). */
export async function fetchResult(r: SubResult, query: SubQuery): Promise<{ name: string; bytes: Uint8Array }[]> {
  const { resolveLink } = await import('./search'); const { request } = await import('../http'); const { unpackSubtitle } = await import('../player/subPack');
  const { url, name } = await resolveLink(r, query); const res = await request(url, { binary: true }); if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const bytes = Uint8Array.from(atob(res.body), (c) => c.charCodeAt(0));
  return unpackSubtitle(name ?? `${r.title}.${r.archive ?? 'srt'}`, bytes, query.animeEpisode ?? query.episode);
}
/** The first spoken lines of a subtitle file (styling taken out). */
async function firstLines(f: { name: string; bytes: Uint8Array }, n = 5): Promise<string[]> {
  const S = await import('../player/subs'); const text = S.decodeSubtitle(f.bytes); const fmt = S.sniffFormat(f.name, text); if (fmt === 'unknown') return [];
  return S.parseCues(text, fmt).map((c) => c.text.replace(/\{[^}]*\}/g, '').replace(/<[^>]+>/g, '').replace(/\\N/g, ' ').trim()).filter(Boolean).slice(0, n);
}

export function findSubsSheet(o: FindOptions): void {
  const sh = openSheet(t('subsFind'), t('close')); sh.el.classList.add('subs-find');
  if (!getSettings().addons.includes('subtitles')) {
    sh.body.append(h('p', { class: 'hint' }, t('subsNoSources')), h('button', { type: 'button', class: 'btn filled', onclick: () => { sh.close(); o.onGetAddon?.(); location.hash = '#/settings/addons'; } }, icon('plus'), t('subsGetAddon')));
    return;
  }
  // (The last search on this show, kept for the session.)
  let last: { words?: string; season?: string; ep?: string } = {};
  try { const all = JSON.parse(sessionStorage.getItem(LAST) ?? '{}') as Record<string, typeof last>; last = all[o.showKey ?? o.title] ?? {}; } catch { /* none */ }
  const q = h('input', { type: 'search', class: 'sub-find-q', dir: 'auto', value: last.words ?? o.title, placeholder: t('subsSearchHint'), enterkeyhint: 'search', 'aria-label': t('subsSearchHint') }) as HTMLInputElement;
  const num = (v: string | undefined, ph: string) => h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', class: 'sub-find-num', value: v ?? '', placeholder: ph, style: { width: '5.5em' }, 'aria-label': ph }) as HTMLInputElement;
  const seIn = o.askSeason ? num(last.season ?? (o.season != null ? String(o.season) : undefined), t('tvSeason')) : null; const epIn = num(last.ep ?? (o.episode != null ? String(o.episode) : undefined), t('subsEpisode'));
  const out = h('div', { class: 'sub-results' }); const status = h('div', { class: 'chips provider-chips sub-find-status', 'aria-live': 'polite' });
  const form = h('form', { class: 'row sub-search', onsubmit: (e: Event) => { e.preventDefault(); void run(); } }, q, ...(seIn ? [seIn] : []), epIn, h('button', { type: 'submit', class: 'btn tonal small' }, icon('search'), t('search')));
  sh.body.append(form, ...(o.openableOnly ? [h('p', { class: 'hint' }, t('subsWholeSeasonHint'))] : []), status, out);
  let token = 0; const timers: number[] = [];
  const stopTimers = () => { while (timers.length) window.clearTimeout(timers.pop()); };
  const obs = new MutationObserver(() => { if (!sh.el.isConnected) { token++; stopTimers(); obs.disconnect(); } }); obs.observe(document.body, { childList: true, subtree: true });
  const keep = () => { try { const all = JSON.parse(sessionStorage.getItem(LAST) ?? '{}') as Record<string, typeof last>; all[o.showKey ?? o.title] = { words: q.value.trim(), season: seIn?.value.trim(), ep: epIn.value.trim() }; sessionStorage.setItem(LAST, JSON.stringify(all)); } catch { /* */ } };
  const numOf = (el: HTMLInputElement | null) => { const v = el?.value.trim() ?? ''; if (!v) return undefined; const n = Number(v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))); return Number.isFinite(n) && n >= 0 ? n : undefined; };
  const retryBtn = () => h('button', { type: 'button', class: 'btn tonal small sub-find-retry', onclick: () => void run() }, icon('refresh'), t('subsTryAgain'));
  const run = async () => {
    const S = await import('./search'); const { lookup, enrich } = await import('./lookup');
    const my = ++token; stopTimers(); keep(); const words = q.value.trim(); const ep = numOf(epIn); const season = seIn ? numOf(seIn) : o.season;
    status.replaceChildren();
    if (!words) { out.replaceChildren(h('p', { class: 'empty small' }, t('subsSearchHint'))); return; }
    out.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
    let query: SubQuery; let title = words;
    try {
      // (The show's own id while the words are still its title — the right show, not the first by that name.)
      const same = words === o.title; const ref = same && o.anilistId ? `anilist:${o.anilistId}` : same && o.imdbId ? o.imdbId : words;
      const cards = await lookup(ref); if (my !== token) return;
      if (!cards.length) { out.replaceChildren(h('p', { class: 'empty small' }, t('noResults'))); return; }
      const c = await enrich(cards[0]); if (my !== token) return; title = c.title; query = S.queryFor(c, season, ep, getSettings().subLangs);
    } catch (e) { if (my === token) out.replaceChildren(h('div', { class: 'empty small sub-find-error' }, h('p', null, String((e as Error).message ?? e)), retryBtn())); return; }
    const srcs = await S.subtitleSources(); if (my !== token) return;
    if (!srcs.length) { out.replaceChildren(h('p', { class: 'empty small' }, t('subsNoSources'))); return; }
    const list = h('div', { class: 'sub-list' }); const more = h('div');
    out.replaceChildren(h('p', { class: 'src', dir: 'auto' }, `${title}${ep != null ? ` · ${t('episodeN', { n: ep })}` : o.openableOnly ? ` · ${t('subsWholeSeason')}` : ''}`), list, more);
    // (Each source's wait seen; one still silent after a few seconds said by name.)
    const chips = new Map(srcs.map((a) => [a.id, h('span', { class: 'chip small busy', dataset: { id: a.id } }, h('span', { class: 'spinner tiny' }), a.name)]));
    status.replaceChildren(...chips.values());
    const slow = h('p', { class: 'hint sub-find-slow', hidden: true }); status.after(slow);
    timers.push(window.setTimeout(() => { if (my !== token) return; const waiting = srcs.filter((a) => chips.get(a.id)?.classList.contains('busy')); if (waiting.length) { slow.hidden = false; slow.textContent = t('subsWaiting', { name: waiting.map((a) => a.name).join(', ') }); } }, SLOW_MS));
    const applied = o.showKey ? S.appliedFor(o.showKey, season, ep) : undefined;
    let found: SubResult[] = []; let shown = 60; const failed: string[] = [];
    const draw = async () => {
      const rs = await S.rankForEpisode(found, { langs: getSettings().subLangs, episode: ep, season, videoName: o.videoName, applied }); if (my !== token) return;
      const rows: HTMLElement[] = []; let otherHead = false;
      for (const x of rs.slice(0, shown)) { if (x.otherLang && !otherHead) { otherHead = true; rows.push(h('h4', { class: 'sub-other-head' }, t('subsOtherLangs'))); } rows.push(row(x, query, ep, season)); }
      list.replaceChildren(...rows);
      more.replaceChildren(...(rs.length > shown ? [h('button', { type: 'button', class: 'btn text small sub-more', onclick: () => { shown += 60; void draw(); } }, t('subsMoreResults'))] : []));
      const busy = [...chips.values()].some((c) => c.classList.contains('busy'));
      if (!rs.length && !busy) list.append(h('div', { class: 'empty small' }, h('p', null, failed.length === srcs.length ? failed.join(' · ') : t('noResults')), ...(failed.length ? [retryBtn()] : [])));
    };
    await S.searchSubtitles(query, (a, res) => {
      if (my !== token) return; const chip = chips.get(a.id);
      if (chip) { chip.classList.remove('busy'); chip.querySelector('.spinner')?.remove(); }
      if (res instanceof Error) {
        const why = /timed out/i.test(res.message) ? t('subsTimeout', { name: a.name }) : t('subsFailedOne', { name: a.name, why: res.message.replace(new RegExp(`^${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`), '') });
        failed.push(why); chip?.classList.add('failed'); if (chip) { chip.prepend(icon('alert')); chip.title = why; chip.append(h('small', null, ` ${t('subsTryAgain')}`)); chip.onclick = () => void run(); }
        status.append(h('span', { class: 'sub-find-fail' }, why));
      } else { found = found.concat(res.filter((r) => !o.openableOnly || !r.archive || /^(zip|gz)$/i.test(r.archive))); chip?.append(h('small', null, ` ${localDigits(res.length)}`)); }
      if (![...chips.values()].some((c) => c.classList.contains('busy'))) slow.hidden = true;
      void draw();
    });
    if (my === token) void draw();
  };
  const row = (x: RankedSub, query: SubQuery, ep: number | undefined, season: number | undefined) => {
    const r = x.r; const pv = h('div', { class: 'sub-preview', hidden: true }); let files: { name: string; bytes: Uint8Array }[] | null = null;
    const get = async () => (files ??= await fetchResult(r, query));
    const apply = async () => { try { const fs = await get(); if (o.showKey) (await import('./search')).rememberApplied(o.showKey, season, ep, r); await o.onPick(r, query, () => sh.close(), fs); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } };
    const badges = [h('span', { class: 'lang-badge' }, (r.language ?? '?').toUpperCase()), ...(x.format ? [h('span', { class: 'chip small sub-badge' }, x.format)] : []), ...(x.pack ? [h('span', { class: 'chip small sub-badge pack' }, t('subsBadgeSeason'))] : []), ...(x.applied ? [h('span', { class: 'chip small sub-badge on' }, t('subsAppliedBefore'))] : [])];
    const preview = async () => {
      if (!pv.hidden) { pv.hidden = true; return; }
      pv.hidden = false; pv.replaceChildren(h('div', { class: 'spinner small' }));
      try {
        const fs = await get(); const first = fs[0]; const lines = first ? await firstLines(first) : [];
        pv.replaceChildren(...(fs.length > 1 ? [h('small', { class: 'src' }, t('subsBadgeFiles', { n: localDigits(fs.length) }))] : []), ...(first ? [h('small', { class: 'src', dir: 'auto' }, t('subsPreviewOf', { name: first.name }))] : []),
          ...(lines.length ? lines.map((l) => h('p', { class: 'sub-line', dir: 'auto' }, l)) : [h('p', { class: 'hint' }, t('subsPreviewEmpty'))]),
          h('div', { class: 'row-actions sub-pv-actions' }, h('button', { type: 'button', class: 'btn filled small sub-apply', onclick: () => void apply() }, icon('check'), t('subsApply')),
            ...(o.onUseForShow && (x.pack || fs.length > 1) ? [h('button', { type: 'button', class: 'btn tonal small sub-use-show', onclick: async () => { try { await o.onUseForShow!(fs, r, () => sh.close()); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } } }, icon('folder'), t('subsUseForShow'))] : [])));
      } catch (e) { pv.replaceChildren(h('p', { class: 'hint' }, String((e as Error).message ?? e)), retryBtn()); files = null; }
    };
    return h('div', { class: 'sub-result' + (x.applied ? ' applied' : '') + (x.otherLang ? ' other-lang' : '') },
      h('div', { class: 'result-row sub-row' },
        h('button', { type: 'button', class: 'grow sub-row-main', dir: 'auto', onclick: () => void apply() }, h('span', { class: 'sub-badges' }, ...badges), h('span', { class: 'result-title' }, r.title), h('small', { class: 'src' }, [r.site, r.season && r.episode ? `S${localDigits(r.season)}E${localDigits(r.episode)}` : r.episode ? t('episodeN', { n: r.episode }) : '', r.hi ? t('subsHI') : '', r.archive ?? ''].filter(Boolean).join(' · '))),
        iconButton('eye', t('subsPreview'), () => void preview())),
      pv);
  };
  void run();
}
