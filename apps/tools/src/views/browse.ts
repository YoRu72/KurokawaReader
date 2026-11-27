// «Browse the web» from the + menu: an address or words to search, and the sites opened lately.
import { h, icon, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { openBrowser, recentSites, addressOf } from '../browser';

const SEARCH = 'https://duckduckgo.com/?q=';

export function browseSheet(initial = ''): void {
  const sh = openSheet(t('browseTitle'), t('close'));
  const input = h('input', { type: 'text', inputmode: 'url', dir: 'ltr', class: 'search-input', value: initial, placeholder: t('browsePh'), autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go' }) as HTMLInputElement;
  const go = () => { const u = addressOf(input.value, SEARCH).url; sh.close(); openBrowser(u); };
  // (D5: what Go will do, said as it is typed — an address opened, or words searched for.)
  const will = h('p', { class: 'hint browse-will', 'aria-live': 'polite', dir: 'auto' });
  const say = () => { const v = input.value.trim(); const a = addressOf(v, SEARCH); will.hidden = !v; will.textContent = !v ? '' : a.search ? t('browseWillSearch', { q: v }) : t('browseWillOpen', { url: a.url }); };
  input.addEventListener('input', say); say();
  sh.body.append(h('form', { class: 'search-form', onsubmit: (e: Event) => { e.preventDefault(); go(); } }, input), will);
  const rec = recentSites();
  if (rec.length) sh.body.append(h('span', { class: 'label' }, t('browseRecent')), ...rec.map((u) => h('button', { type: 'button', class: 'dest-row browse-row', onclick: () => { sh.close(); openBrowser(u); } }, icon('globe'), h('span', { class: 'grow', dir: 'ltr' }, u.replace(/^https?:\/\//, '')))));
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); openBrowser(''); } }, icon('external'), t('browseOpen')), h('button', { type: 'button', class: 'btn primary', onclick: go }, icon('globe'), t('browseGo')));
  setTimeout(() => input.focus(), 60);
}
