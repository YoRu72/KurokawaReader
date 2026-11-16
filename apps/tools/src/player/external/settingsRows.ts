// Settings → Player: the way for each kind of video (ask, the app's own player, the outside way — «Another app» on a
// phone, «A player on this PC» on a computer); on a computer which player that is (Automatic, one found, or a
// program picked in the shell's own dialog, with its arguments line kept by the shell, not in these settings);
// «Mark as watched?».
import { h, pickButton } from '../../ui/dom';
import { t } from '../../i18n';
import { getSettings, updateSettings } from '../../settings';
import { SERVICES, autoPick, type Service, type Way } from './logic';
import { platform, defaultFor, setDefault, outName, pcPlayer, chooseProgram } from './run';

const row = (label: string, control: Node, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), control);
const LABEL: Record<Service, () => string> = { torrent: () => t('extForTorrent'), online: () => t('extForOnline'), http: () => t('extForHttp'), local: () => t('extForLocal') };

export function externalRows(): HTMLElement | null {
  const p = platform(); if (!p) return null;
  const box = h('div', { class: 'ext-settings' });
  const opts: [Way, string][] = [['ask', t('playerAsk')], ['app', t('playerApp')], ['out', outName(p)]];
  box.append(h('h4', { class: 'ext-title' }, t('extDefaultsTitle')), h('p', { class: 'hint' }, t('extDefaultsHint')),
    ...SERVICES.map((s) => { const b = pickButton(LABEL[s](), opts, defaultFor(p, s), (v) => setDefault(p, s, v), t('close')); b.dataset.service = s; return row(LABEL[s](), b); }));
  if (p !== 'android') { const slot = h('div', { class: 'ext-pc' }); box.append(slot); void pcRows(slot); }
  const ask = getSettings().extAskWatched; const cur = ask === true ? 'always' : ask === false ? 'never' : 'tracked';
  box.append(row(t('extAskWatchedLabel'), pickButton(t('extAskWatchedLabel'), [['tracked', t('extAskTracked')], ['always', t('extAskAlways')], ['never', t('extAskNever')]], cur, (v) => updateSettings({ extAskWatched: v === 'always' ? true : v === 'never' ? false : undefined }), t('close')), t('extAskWatchedHint')));
  return box;
}
/** «Player on this PC»: Automatic (what it finds), each player found, the program picked, «Choose a program…». */
async function pcRows(slot: HTMLElement): Promise<void> {
  const { list, want } = await pcPlayer();
  const auto = autoPick(list.found);
  const opts: [string, string][] = [['auto', auto ? t('extAuto', { name: auto.name }) : t('extAutoNone')], ...list.found.map((f): [string, string] => [f.id, f.name])];
  if (list.chosen?.there) opts.push(['chosen', list.chosen.path.split(/[\\/]/).pop() ?? list.chosen.path]);
  opts.push(['pick', t('extChooseProgram')]);
  const cur = opts.some((o) => o[0] === want) ? want : 'auto';
  const b = pickButton(t('extPcPlayerLabel'), opts, cur, (v) => { if (v === 'pick') void chooseProgram().then(() => void pcRows(slot)); else { updateSettings({ extPcPlayer: v }); void pcRows(slot); } }, t('close'));
  b.classList.add('ext-pc-pick');
  const kids: Node[] = [row(t('extPcPlayerLabel'), b, list.chosen?.there && cur === 'chosen' ? list.chosen.path : undefined)];
  if (list.chosen?.there && cur === 'chosen') {
    const d = window.kurokawaTools as unknown as { extPlayerArgs?(o: { args: string }): Promise<unknown> } | undefined;
    kids.push(row(t('extArgsLabel'), h('input', { type: 'text', dir: 'ltr', class: 'ext-args', spellcheck: false, value: list.chosen.args, placeholder: '--fullscreen {url}', onchange: (e: Event) => void d?.extPlayerArgs?.({ args: (e.target as HTMLInputElement).value.trim() }) }), t('extArgsHint')));
  }
  slot.replaceChildren(...kids);
}
