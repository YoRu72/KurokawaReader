// Lets the reader choose which buttons the floating toolbar shows, and in what order.
import { h, icon, openSheet } from './dom';
import { t } from '../i18n';
import { getSettings, updateSettings } from '../settings';

const ALL: [string, string, string][] = [
  ['toc', 'toc', 'contents'], ['search', 'search', 'searchInBook'], ['images', 'images', 'images'], ['bookmark', 'bookmarkAdd', 'addBookmark'], ['bookmarks', 'bookmark', 'bookmarks'],
  ['type', 'type', 'visualOptions'], ['translate', 'translate', 'aiTranslate'], ['speak', 'speak', 'readAloud'], ['scroll', 'scroll', 'autoScroll'], ['info', 'info', 'bookInfo'], ['fullscreen', 'fullscreen', 'fullscreen'], ['sep', 'more', 'separator'],
];

export function toolbarSheet(): void {
  const sh = openSheet(t('toolbarButtons'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  sh.body.append(h('p', { class: 'src' }, t('toolbarButtonsBody')));
  const list = h('div', { class: 'dest-list' });
  const render = () => {
    list.replaceChildren();
    const cur = getSettings().readerToolbar.filter((id) => id !== 'more');
    const rows = [...cur, ...ALL.map(([id]) => id).filter((id) => !cur.includes(id) && id !== 'sep')];
    rows.forEach((id) => {
      const def = ALL.find((a) => a[0] === id); if (!def) return;
      const onIdx = cur.indexOf(id);
      const row = h('div', { class: 'dest-row' + (onIdx >= 0 ? ' on' : '') },
        h('input', { type: 'checkbox', checked: onIdx >= 0, onchange: (e: Event) => { const next = (e.target as HTMLInputElement).checked ? [...cur, id] : cur.filter((x) => x !== id); updateSettings({ readerToolbar: [...next, 'more'] }); render(); } }),
        icon(def[1]), h('span', { class: 'name' }, t(def[2] as 'contents')),
        onIdx >= 0 ? h('span', { class: 'row-actions' },
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('moveUp'), disabled: onIdx === 0, onclick: () => { const n = [...cur]; [n[onIdx - 1], n[onIdx]] = [n[onIdx], n[onIdx - 1]]; updateSettings({ readerToolbar: [...n, 'more'] }); render(); } }, icon('chevronUp')),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('moveDown'), disabled: onIdx === cur.length - 1, onclick: () => { const n = [...cur]; [n[onIdx + 1], n[onIdx]] = [n[onIdx], n[onIdx + 1]]; updateSettings({ readerToolbar: [...n, 'more'] }); render(); } }, icon('chevronDown'))) : null);
      list.append(row);
    });
    list.append(h('button', { class: 'btn small', type: 'button', style: { marginTop: '8px' }, onclick: () => { updateSettings({ readerToolbar: ['toc', 'search', 'images', 'bookmark', 'sep', 'type', 'more'] }); render(); } }, t('resetDefaults')));
  };
  render();
  sh.body.append(list);
}
