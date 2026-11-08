// The bottom bar as the reader wants it: which places are on it and in what order (Settings is always there, last).
import { h, icon, iconButton, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { navPlacesAll } from '../ui/navPlaces';

export function navCustomizeSheet(): void {
  const sh = openSheet(t('navCustomize'), t('close')); const list = h('div', { class: 'dest-list nav-custom' });
  const draw = () => {
    const s = getSettings(); const all = navPlacesAll(s).filter((p) => p[0] !== 'settings'); const order = s.navOrder ?? []; const hidden = new Set(s.navHidden ?? []);
    const rank = (n: string) => { const i = order.indexOf(n); return i < 0 ? 100 + all.findIndex((d) => d[0] === n) : i; };
    const sorted = [...all].sort((a, b) => rank(a[0]) - rank(b[0])); const ids = sorted.map((p) => p[0]);
    const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= ids.length) return; const next = [...ids]; [next[i], next[j]] = [next[j], next[i]]; updateSettings({ navOrder: next }); draw(); };
    const shown = ids.filter((x) => !hidden.has(x)).length;
    list.replaceChildren(...sorted.map(([id, ic, key], i) => h('div', { class: 'dest-row' + (hidden.has(id) ? '' : ' on') },
      h('input', { type: 'checkbox', checked: !hidden.has(id), disabled: !hidden.has(id) && shown <= 1, 'aria-label': t(key as 'navDownloads'), onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; const hs = new Set(getSettings().navHidden ?? []); if (on) hs.delete(id); else hs.add(id); updateSettings({ navHidden: [...hs], navOrder: ids }); draw(); } }),
      icon(ic), h('span', { class: 'grow' }, t(key as 'navDownloads')),
      iconButton('arrowUp', t('moveUp'), () => move(i, -1)), iconButton('arrowDown', t('moveDown'), () => move(i, 1)))),
      h('div', { class: 'dest-row' }, h('input', { type: 'checkbox', checked: true, disabled: true, 'aria-label': t('navSettings') }), icon('settings'), h('span', { class: 'grow' }, t('navSettings')), h('small', { class: 'src' }, t('navAlways'))));
  };
  sh.body.append(h('p', { class: 'hint' }, t('navCustomizeHint')), list);
  sh.actions.append(h('button', { type: 'button', class: 'btn text', onclick: () => { updateSettings({ navOrder: [], navHidden: [] }); draw(); } }, icon('refresh'), t('reset')));
  draw();
}
