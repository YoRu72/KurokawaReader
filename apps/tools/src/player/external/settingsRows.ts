// Settings → Player: another app for each kind of video (the phone's apps on a phone, the computer's programs on a
// computer — never the other's), one's own command (computer only), «Mark as watched?», and what was found here.
import { h, pickButton } from '../../ui/dom';
import { t, getLang } from '../../i18n';
import { getSettings, updateSettings } from '../../settings';
import { SERVICES, playersFor, type Service } from './logic';
import { platform, defaultFor, setDefault, installed, nameOf } from './run';

const row = (label: string, control: Node, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), control);
const LABEL: Record<Service, () => string> = { torrent: () => t('extForTorrent'), online: () => t('extForOnline'), http: () => t('extForHttp'), local: () => t('extForLocal') };

export function externalRows(): HTMLElement | null {
  const p = platform(); if (!p) return null;
  const box = h('div', { class: 'ext-settings' });
  const opts: [string, string][] = [['ask', t('playerAsk')], ['app', t('playerApp')], ...playersFor(p).map((d): [string, string] => [d.id, nameOf(d)])];
  const found = h('p', { class: 'hint ext-found' });
  box.append(h('h4', { class: 'ext-title' }, t('extDefaultsTitle')), h('p', { class: 'hint' }, t('extDefaultsHint')),
    ...SERVICES.map((s) => { const b = pickButton(LABEL[s](), opts, defaultFor(p, s), (v) => setDefault(p, s, v), t('close')); b.dataset.service = s; return row(LABEL[s](), b); }));
  if (p !== 'android') {
    const inp = h('input', { type: 'text', dir: 'ltr', class: 'ext-custom', spellcheck: false, value: getSettings().extCustom ?? '', placeholder: 'mpv --fs {url}', onchange: (e: Event) => updateSettings({ extCustom: (e.target as HTMLInputElement).value.trim() }) });
    box.append(row(t('extCustomLabel'), inp, t('extCustomHint')));
  }
  const ask = getSettings().extAskWatched; const cur = ask === true ? 'always' : ask === false ? 'never' : 'tracked';
  box.append(row(t('extAskWatchedLabel'), pickButton(t('extAskWatchedLabel'), [['tracked', t('extAskTracked')], ['always', t('extAskAlways')], ['never', t('extAskNever')]], cur, (v) => updateSettings({ extAskWatched: v === 'always' ? true : v === 'never' ? false : undefined }), t('close')), t('extAskWatchedHint')), found);
  void installed(p).then((list) => { const names = list.filter((x) => x.def.id !== 'any' && x.def.id !== 'custom').map((x) => nameOf(x.def)); found.textContent = names.length ? t('extFound', { list: names.join(getLang() === 'ar' ? '، ' : ', ') }) : t('extFoundNone'); });
  return box;
}
