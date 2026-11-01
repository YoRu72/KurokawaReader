// «Browse the web» from the + menu: an address or words to search, and the sites opened lately.
import { h, icon, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { openBrowser, recentSites } from '../browser';

export function browseSheet(initial = ''): void {
  const sh = openSheet(t('browseTitle'), t('close'));
  const input = h('input', { type: 'text', inputmode: 'url', dir: 'ltr', class: 'search-input', value: initial, placeholder: t('browsePh'), autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go' }) as HTMLInputElement;
  const go = () => { const v = input.value.trim(); const u = !v ? '' : /^(https?|magnet):/i.test(v) ? v : /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v) ? `https://${v}` : `https://duckduckgo.com/?q=${encodeURIComponent(v)}`; sh.close(); openBrowser(u); };
  sh.body.append(h('form', { class: 'search-form', onsubmit: (e: Event) => { e.preventDefault(); go(); } }, input));
  const rec = recentSites();
  if (rec.length) sh.body.append(h('span', { class: 'label' }, t('browseRecent')), ...rec.map((u) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); openBrowser(u); } }, icon('globe'), h('span', { class: 'grow', dir: 'ltr' }, u.replace(/^https?:\/\//, '')))));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: go }, icon('globe'), t('browseGo')));
  setTimeout(() => input.focus(), 60);
}
