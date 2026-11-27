// Settings → Subtitles: the ONE ordered list of subtitle languages (settings.subLangs — the pack matcher, the search,
// the auto-find and the player's choice of the video's own tracks all read it): add from a searchable list (each
// language by its own name, the app's language's name beside it), remove, drag or «up» to reorder; then «Find
// subtitles automatically» (the player's preference, off by default) with «Only my languages», a switch per installed
// subtitle source (by the name its add-on carries), and on a phone «Wi-Fi only».
import { h, icon, openSheet } from '../ui/dom';
import { t, getLang } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { getPrefs, updatePrefs } from '../player/prefs';
import { nativePlatform } from '../native';

const CODES = ['ar', 'en', 'ja', 'ko', 'zh', 'fr', 'de', 'es', 'pt', 'it', 'ru', 'tr', 'fa', 'ur', 'id', 'ms', 'vi', 'th', 'hi', 'bn', 'ta', 'nl', 'pl', 'sv', 'no', 'da', 'fi', 'el', 'ro', 'hu', 'cs', 'uk', 'bg', 'hr', 'sr'];
const dn = (inLang: string, code: string): string => { try { return new Intl.DisplayNames([inLang], { type: 'language' }).of(code) ?? code; } catch { return code; } };
/** A language by its own name, and by the app's language's name when that differs. */
export const langLabel = (code: string): { own: string; ui: string } => { const own = dn(code, code); const ui = dn(getLang(), code); return { own, ui: ui.toLowerCase() === own.toLowerCase() ? '' : ui }; };
const sw = (label: string, hint: string, on: boolean, set: (v: boolean) => void, cls: string) => h('label', { class: `row switch-row ${cls}` }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }));

export function subtitleSettings(): HTMLElement[] {
  const list = h('div', { class: 'dest-list sub-lang-list' });
  const set = (l: string[]) => { updateSettings({ subLangs: l }); draw(); };
  let dragFrom = -1;
  const draw = () => {
    const l = getSettings().subLangs;
    list.replaceChildren(...l.map((code, i) => { const n = langLabel(code);
      const row = h('div', { class: 'dest-row sub-lang-row', draggable: 'true', dataset: { lang: code } }, icon('menu'), h('span', { class: 'grow' }, h('span', { class: 'name', dir: 'auto' }, n.own), n.ui ? h('small', { class: 'src' }, n.ui) : null),
        i > 0 ? h('button', { type: 'button', class: 'icon-btn sub-lang-up', title: t('subLangUp', { name: n.own }), 'aria-label': t('subLangUp', { name: n.own }), onclick: () => { const x = [...l]; [x[i - 1], x[i]] = [x[i], x[i - 1]]; set(x); } }, icon('arrowUp')) : h('span', { class: 'pack-src-gap', 'aria-hidden': 'true' }),
        h('button', { type: 'button', class: 'icon-btn sub-lang-remove', title: t('subLangRemove', { name: n.own }), 'aria-label': t('subLangRemove', { name: n.own }), disabled: l.length < 2, onclick: () => set(l.filter((x) => x !== code)) }, icon('close')));
      row.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer?.setData('text/plain', code); });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => { e.preventDefault(); if (dragFrom < 0 || dragFrom === i) return; const x = [...l]; const [m] = x.splice(dragFrom, 1); x.splice(i, 0, m); dragFrom = -1; set(x); });
      return row; }));
  };
  const add = () => {
    const sh = openSheet(t('subLangAdd'), t('close'), { stack: true }); const q = h('input', { type: 'search', class: 'search-input sub-lang-q', dir: 'auto', placeholder: t('subLangSearch'), 'aria-label': t('subLangSearch'), oninput: () => fill() }) as HTMLInputElement; const box = h('div', { class: 'dest-list' });
    const fill = () => { const w = q.value.trim().toLowerCase(); const have = getSettings().subLangs;
      box.replaceChildren(...CODES.filter((c) => !have.includes(c)).map((c) => ({ c, ...langLabel(c) })).filter((x) => !w || x.own.toLowerCase().includes(w) || x.ui.toLowerCase().includes(w) || x.c === w).map((x) => h('button', { type: 'button', class: 'dest-row sub-lang-pick', dataset: { lang: x.c }, onclick: () => { sh.close(); set([...getSettings().subLangs, x.c]); } }, h('span', { class: 'grow' }, h('span', { class: 'name', dir: 'auto' }, x.own), x.ui ? h('small', { class: 'src' }, x.ui) : null)))); };
    sh.body.append(q, box); fill();
  };
  draw();
  const auto = h('div', { class: 'sub-auto-box' });
  const drawAuto = () => {
    const on = !!getPrefs().autoSubs; const s = getSettings(); const srcBox = h('div', { class: 'sub-auto-sources' });
    auto.replaceChildren(sw(t('subAutoOn'), t('subAutoHint'), on, (v) => { updatePrefs({ autoSubs: v }); drawAuto(); }, 'sub-auto-on'));
    if (!on) return;
    auto.append(sw(t('subAutoOnly'), t('subAutoOnlyHint'), s.subAutoOnly !== false, (v) => updateSettings({ subAutoOnly: v }), 'sub-auto-only'),
      ...(nativePlatform() === 'android' ? [sw(t('subAutoWifi'), t('subAutoWifiHint'), s.subAutoWifi !== false, (v) => updateSettings({ subAutoWifi: v }), 'sub-auto-wifi')] : []),
      h('h4', null, t('subAutoSources')), srcBox);
    void import('./search').then((S) => S.subtitleSources()).then((srcs) => {
      if (!srcs.length) { srcBox.replaceChildren(h('p', { class: 'hint' }, t('subAutoNoSources'))); return; }
      srcBox.replaceChildren(...srcs.map((a) => sw(a.name, '', !(getSettings().subAutoOff ?? []).includes(a.id), (v) => { const off = new Set(getSettings().subAutoOff ?? []); if (v) off.delete(a.id); else off.add(a.id); updateSettings({ subAutoOff: [...off] }); }, 'sub-auto-src')));
      srcBox.querySelectorAll<HTMLElement>('.sub-auto-src').forEach((el, i) => { el.dataset.id = srcs[i].id; });
    }).catch(() => srcBox.replaceChildren());
  };
  drawAuto();
  return [h('h4', null, t('subLangsOrder')), h('p', { class: 'hint' }, t('subLangsOrderHint')), list, h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn tonal small sub-lang-add', onclick: add }, icon('plus'), t('subLangAdd'))), auto];
}
