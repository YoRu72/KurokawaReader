// Settings → Anime (present once the Anime add-on is installed): the AniList account, how titles and
// qualities are chosen, and the anime sources — the add-on's own providers and the extension repositories the
// user adds (Hayase, Seanime), each provider switchable, removable, updatable.
import { h, icon, iconButton, toast, pickButton, openSheet } from '../ui/dom';
import { t, getLang, countSources } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import * as al from '../anilist';
import { providers, installRepo, removeProvider, setEnabled, updateAll, syncBuiltins, optionsOf, installEntry, type ProviderEntry } from '../anime/providers';
import { MARKETS, STREMIO_SUGGESTED, readMarket, resolveEntry, type MarketItem } from '../anime/market';
import { ktPlugin } from '../native';

const card = (id: string, title: string, ...kids: (Node | null)[]) => h('section', { class: 'card', id }, h('h3', null, title), ...kids.filter((k): k is Node => !!k));
const row = (label: string, control: Node, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), control);
const toggle = (label: string, on: boolean, set: (v: boolean) => void) => { const c = h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }); return h('label', { class: 'row switch-row' }, h('span', null, label), c); };

/** The address a sign-in window ends on, through whichever shell can watch one; null when none can. */
async function captureAddress(url: string, marker: string, title: string): Promise<string | null | undefined> {
  const d = window.kurokawaTools as (typeof window.kurokawaTools & { captureUrl?(o: { url: string; marker: string; title: string }): Promise<string | null> }) | undefined;
  if (d?.captureUrl) return d.captureUrl({ url, marker, title });
  const p = ktPlugin() as (ReturnType<typeof ktPlugin> & { captureUrl?(o: { url: string; marker: string; title: string }): Promise<{ url: string | null }> }) | null;
  if (p?.captureUrl) return (await p.captureUrl({ url, marker, title })).url;
  return undefined;
}

export function animeSettingsCard(rerender: () => void): HTMLElement {
  const s = getSettings(); const u = al.user();
  const acct: HTMLElement[] = [];
  if (u) acct.push(h('div', { class: 'track-user' }, u.avatar ? h('img', { src: u.avatar, alt: '' }) : null, h('span', null, t('anilistLinkedAs', { name: u.name })), h('button', { type: 'button', class: 'btn small', onclick: () => { al.unlink(); rerender(); } }, icon('close'), t('anilistUnlink'))),
    toggle(t('anilistAutoProgress'), s.anilistAutoProgress, (v) => updateSettings({ anilistAutoProgress: v })));
  else {
    const id = h('input', { type: 'text', value: s.anilistClientId, placeholder: '12345', inputmode: 'numeric', dir: 'ltr', style: { width: '120px' }, onchange: () => updateSettings({ anilistClientId: id.value.trim() }) }) as HTMLInputElement;
    const tk = h('textarea', { rows: 3, placeholder: t('anilistTokenPlaceholder'), dir: 'ltr', style: { width: '100%', fontFamily: 'monospace', fontSize: '12px' } }) as HTMLTextAreaElement;
    const linkWith = async (token: string) => { try { const user = await al.link(token); toast(t('anilistLinkedAs', { name: user.name })); rerender(); } catch (e) { toast(`AniList: ${(e as Error).message}`, 'error'); } };
    acct.push(h('p', { class: 'hint' }, t('anilistHowTo'), ' ', h('a', { href: 'https://anilist.co/settings/developer', target: '_blank', rel: 'noopener' }, 'anilist.co/settings/developer')),
      row(t('anilistClientId'), id),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn tonal small', onclick: async () => {
        updateSettings({ anilistClientId: id.value.trim() }); if (!id.value.trim()) { toast(t('anilistNeedClient'), 'error'); return; }
        const at = await captureAddress(al.authUrl(), 'access_token=', t('anilistSignInWindow'));
        if (at === undefined) { window.open(al.authUrl(), '_blank', 'noopener'); return; }
        const token = at ? /access_token=([^&]+)/.exec(at)?.[1] : null; if (token) await linkWith(decodeURIComponent(token));
      } }, icon('external'), t('anilistSignIn'))),
      tk, h('div', null, h('button', { type: 'button', class: 'btn primary small', onclick: () => void linkWith(tk.value) }, icon('check'), t('anilistLink'))));
  }
  const prefs = [
    row(t('animeQuality'), pickButton(t('animeQuality'), [['', t('unlimited')], ['2160', '2160p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']], s.animeQuality, (v) => updateSettings({ animeQuality: v as '' }), t('close'))),
    row(t('animeLookup'), pickButton(t('animeLookup'), [['quality', t('lookupQuality')], ['size', t('lookupSize')], ['seeders', t('lookupSeeders')]], s.animeLookup ?? 'quality', (v) => updateSettings({ animeLookup: v as 'quality' }), t('close'))),
    row(t('animeTitleLang'), pickButton(t('animeTitleLang'), [['preferred', t('titlePreferred')], ['romaji', t('titleRomaji')], ['english', t('titleEnglish')], ['native', t('titleNative')]], s.animeTitleLang, (v) => updateSettings({ animeTitleLang: v as 'preferred' }), t('close'))),
    toggle(t('animeAdult'), s.animeAdult, (v) => updateSettings({ animeAdult: v })),
  ];
  // Sources
  const list = h('div', { class: 'addons-list' }, h('div', { class: 'center small' }, h('div', { class: 'spinner small' })));
  const drawList = async () => {
    await syncBuiltins().catch(() => undefined);
    const ps = await providers(); const lang = getLang();
    if (!ps.length) { list.replaceChildren(h('p', { class: 'src' }, t('animeProvidersNone'))); return; }
    list.replaceChildren(...ps.map((p) => {
      const sw = h('input', { type: 'checkbox', checked: p.enabled, onchange: (e: Event) => void setEnabled(p.id, (e.target as HTMLInputElement).checked) });
      return h('div', { class: 'addon-row' }, p.icon ? h('img', { class: 'addon-icon', src: p.icon, alt: '' }) : icon(p.role === 'stream' ? 'play' : 'magnet'),
        h('div', { class: 'grow' }, h('b', { dir: 'auto' }, p.name, p.role === 'stream' ? h('span', { class: 'market-badge s-stream' }, t('marketStream')) : null), h('small', { class: 'src', dir: 'auto' }, [p.description, p.builtin ? t('animeProviderBuiltin') : p.repo ? new URL(p.repo).host : '', p.format === 'seanime' ? 'Seanime' : p.format === 'hayase' ? 'Hayase' : p.format === 'stremio' ? 'Stremio' : ''].filter(Boolean).join(' · '))),
        Object.keys(p.options ?? {}).length ? iconButton('settings', t('addonSettings'), () => optionsSheet(p, lang)) : null,
        p.builtin ? null : iconButton('trash', t('remove'), async () => { await removeProvider(p.id); void drawList(); }),
        h('label', { class: 'switch-row inline' }, sw));
    }));
  };
  void drawList();
  const urlIn = h('input', { type: 'url', placeholder: 'https://…/index.json', dir: 'ltr', class: 'grow' }) as HTMLInputElement;
  const addBtn = h('button', { type: 'button', class: 'btn tonal small', onclick: async () => { const u = urlIn.value.trim(); if (!u) return; addBtn.disabled = true; try { const r = await installRepo(u); toast(t('animeRepoAdded', { what: countSources(r.length) })); urlIn.value = ''; rerender(); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } finally { addBtn.disabled = false; } } }, icon('plus'), t('animeRepoAdd')) as HTMLButtonElement;
  const repos = getSettings().animeRepos.map((u) => h('div', { class: 'repo-row' }, h('span', { class: 'src grow', dir: 'ltr' }, u), iconButton('trash', t('animeRepoRemove'), async () => { const ps = await providers(); for (const p of ps) if (p.repo === u) await removeProvider(p.id); updateSettings({ animeRepos: getSettings().animeRepos.filter((x) => x !== u) }); rerender(); })));
  return card('anime', t('navAnime'), ...acct, ...prefs,
    h('h4', null, t('animeProviders')), list, h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn text small', onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; try { const n = await updateAll(); toast(t('animeRepoAdded', { what: countSources(n) })); void drawList(); } finally { b.disabled = false; } } }, icon('refresh'), t('animeProvidersUpdate'))),
    h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn primary small', onclick: () => marketSheet(() => void drawList()) }, icon('apps'), t('animeMarket'))),
    h('h4', null, t('animeRepos')), h('p', { class: 'hint' }, t('animeReposHint')), ...repos, h('div', { class: 'repo-add' }, urlIn, addBtn));
}

function optionsSheet(p: ProviderEntry, lang: string): void {
  const sh = openSheet(`${p.name} · ${t('addonSettings')}`, t('close'));
  const key = p.code.startsWith('addon:') ? p.code.slice(6) : p.id;
  const cur = optionsOf(p);
  const save = (k: string, v: string | number | boolean) => updateSettings({ addonSettings: { ...getSettings().addonSettings, [key]: { ...optionsOf(p), [k]: v } } });
  for (const [k, f] of Object.entries(p.options ?? {})) {
    const label = (f as { labels?: Record<string, string> }).labels?.[lang] ?? f.label ?? f.description ?? k;
    if (f.type === 'boolean' || f.type === 'switch' || f.type === 'toggle') sh.body.append(h('label', { class: 'switch-row' }, h('span', { class: 'grow' }, label), h('input', { type: 'checkbox', checked: String(cur[k]) === 'true', onchange: (e: Event) => save(k, (e.target as HTMLInputElement).checked) })));
    else if (f.type === 'select' && f.values?.length) sh.body.append(h('label', { class: 'field' }, h('span', null, label), h('select', { onchange: (e: Event) => save(k, (e.target as HTMLSelectElement).value) }, ...f.values.map((o) => { const v = typeof o === 'object' && o ? String((o as { value: unknown }).value) : String(o); return h('option', { value: v, selected: String(cur[k] ?? '') === v }, v || '—'); }))));
    else sh.body.append(h('label', { class: 'field' }, h('span', null, label), f.description && f.label ? h('small', { class: 'src' }, f.description) : null, h('input', { type: f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text', value: String(cur[k] ?? ''), dir: 'ltr', autocomplete: 'off', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; save(k, f.type === 'number' ? Number(v) : v); } })));
  }
}

/** The marketplaces: every anime torrent source they list, filtered by name and language, installed one by one. */
function marketSheet(changed: () => void): void {
  const sh = openSheet(t('animeMarket'), t('close'));
  sh.el.classList.add('market-sheet');
  let market = MARKETS[0]; let q = ''; let lang = ''; let role: '' | 'torrent' | 'stream' = ''; let items: MarketItem[] = []; let mine = new Map<string, ProviderEntry>();
  const tabs = h('div', { class: 'chip-row wrap' }); const filters = h('div', { class: 'chip-row wrap' }); const list = h('div', { class: 'addons-list market-list' });
  const search = h('input', { type: 'search', class: 'search-input', placeholder: t('search'), oninput: (e: Event) => { q = (e.target as HTMLInputElement).value.trim().toLowerCase(); draw(); } }) as HTMLInputElement;
  const stremio = h('div', { class: 'market-stremio' }, h('h4', null, 'Stremio'), h('p', { class: 'hint' }, t('animeStremioHint')), h('div', { class: 'chip-row wrap' }, ...STREMIO_SUGGESTED.map((x) => h('button', { type: 'button', class: 'chip small', onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; try { await installRepo(x.url); toast(t('addonInstalledToast', { name: x.name })); changed(); } catch (er) { toast(`${x.name}: ${(er as Error).message}`, 'error'); } b.disabled = false; } }, icon('plus'), x.name))));
  sh.body.append(tabs, search, filters, list, stremio);
  const drawTabs = () => tabs.replaceChildren(...MARKETS.map((m) => h('button', { type: 'button', class: 'chip small' + (m === market ? ' on' : ''), onclick: () => { market = m; lang = ''; drawTabs(); void load(); } }, m.name)));
  const load = async () => {
    list.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' }))); filters.replaceChildren();
    try { const [its, ps] = await Promise.all([readMarket(market), providers()]); items = its; mine = new Map(ps.map((p) => [p.id, p])); draw(); }
    catch (e) { list.replaceChildren(h('p', { class: 'src' }, t('addonsFailed', { error: String((e as Error).message ?? e) }))); }
  };
  const draw = () => {
    const langs = [...new Set(items.map((x) => x.lang).filter((x): x is string => !!x))].sort();
    const both = items.some((x) => x.entry.role === 'stream') && items.some((x) => x.entry.role !== 'stream');
    filters.replaceChildren(...(both ? (['torrent', 'stream'] as const).map((r) => h('button', { type: 'button', class: 'chip small' + (role === r ? ' on' : ''), 'aria-pressed': String(role === r), onclick: () => { role = role === r ? '' : r; draw(); } }, icon(r === 'stream' ? 'play' : 'magnet'), r === 'torrent' ? t('marketTorrent') : t('marketStream'))) : []), ...(both && langs.length > 1 ? [h('span', { class: 'chip-sep' })] : []),
      ...(langs.length > 1 ? ['', ...langs].map((l) => h('button', { type: 'button', class: 'chip small' + (lang === l ? ' on' : ''), onclick: () => { lang = l; draw(); } }, l ? l.toUpperCase() : t('allQualities'))) : []));
    const shown = items.filter((x) => (!role || (role === 'stream') === (x.entry.role === 'stream')) && (!lang || x.lang === lang) && (!q || `${x.entry.name} ${x.entry.description ?? ''} ${x.author ?? ''}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.status === 'broken' || a.status === 'deprecated' ? 1 : 0) - (b.status === 'broken' || b.status === 'deprecated' ? 1 : 0) || a.entry.name.localeCompare(b.entry.name));
    if (!shown.length) { list.replaceChildren(h('p', { class: 'src' }, t('noResults'))); return; }
    list.replaceChildren(...shown.map((it) => {
      const e = it.entry; const have = mine.get(e.id);
      const btn = h('button', { type: 'button', class: 'btn small ' + (have ? (have.version !== e.version ? 'tonal' : 'text') : 'primary'), disabled: !!have && have.version === e.version }, have ? (have.version !== e.version ? t('addonUpdate') : t('addonInstalled')) : t('addonInstall')) as HTMLButtonElement;
      btn.addEventListener('click', async () => { btn.disabled = true; try { await installEntry(await resolveEntry(it)); mine.set(e.id, e); toast(t('addonInstalledToast', { name: e.name })); changed(); draw(); } catch (er) { toast(`${e.name}: ${(er as Error).message}`, 'error'); btn.disabled = false; } });
      const badge = it.status ? h('span', { class: `market-badge s-${it.status}` }, t(it.status === 'working' ? 'marketWorking' : it.status === 'broken' ? 'marketBroken' : 'marketDeprecated')) : null;
      return h('div', { class: 'addon-row' + (it.status === 'broken' || it.status === 'deprecated' ? ' dim' : '') }, e.icon ? h('img', { class: 'addon-icon', src: e.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (ev: Event) => { (ev.target as HTMLElement).replaceWith(icon('magnet')); } }) : icon('magnet'),
        h('div', { class: 'grow' }, h('b', { dir: 'auto' }, e.name, ' ', badge, e.role === 'stream' ? h('span', { class: 'market-badge s-stream' }, t('marketStream')) : null), h('small', { class: 'src', dir: 'auto' }, [e.description, it.lang ? it.lang.toUpperCase() : '', it.author, `v${e.version}`].filter(Boolean).join(' · '))), btn);
    }));
  };
  drawTabs(); void load();
}
