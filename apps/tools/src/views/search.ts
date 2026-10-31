// Search across the sources of the installed add-ons (torrent sites, anime, subtitles). Without any, it says
// where to get them.
import { h, icon, iconButton } from '../ui/dom';
import { t } from '../i18n';
import { navigate } from '../router';
import { getSettings } from '../settings';

export function searchView(q?: string, addon?: string): HTMLElement & { dispose?: () => void } {
  const input = h('input', { type: 'search', class: 'search-input', placeholder: t('search'), value: q ?? '', dir: 'auto' }) as HTMLInputElement;
  const body = h('div', { class: 'body' });
  const root = h('div', { class: 'view search-view' }, h('header', { class: 'topbar' }, h('div', { class: 'title' }, h('span', null, t('navSearch'))), h('div', { class: 'topbar-actions' }, iconButton('puzzle', t('addons'), () => navigate('/settings/addons')))), body) as HTMLElement & { dispose?: () => void };
  const searchers = getSettings().addons.filter((id) => /torrent|anime|subtitle|source/.test(id));
  if (!searchers.length) {
    body.append(h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon('puzzle')), h('h2', null, t('addons')), h('p', null, t('addonsHint')), h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('/settings/addons') }, icon('download'), t('addonInstall')))));
    return root;
  }
  body.append(h('form', { class: 'search-form', onsubmit: (e: Event) => { e.preventDefault(); navigate(`/search?q=${encodeURIComponent(input.value.trim())}${addon ? `&addon=${addon}` : ''}`, true); void run(); } }, input));
  const results = h('div', { class: 'search-results' }); body.append(results);
  const run = async () => {
    results.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
    const { runSearch } = await import('../addons/search');
    await runSearch(input.value.trim(), searchers, results, addon);
  };
  if (q) void run();
  return root;
}
