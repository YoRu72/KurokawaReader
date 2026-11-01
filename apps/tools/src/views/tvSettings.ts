// Settings → TV & Movies: Torrentio as its configure page offers it — the sites it reads, the order, the
// qualities left out, a language put first —, the quality wanted and what decides among equals, the Debrid
// add-on's key used or not, or a configuration copied from Torrentio's own page; the series followed.
import { h, icon, pickButton, toast } from '../ui/dom';
import { t } from '../i18n';
import { updateSettings } from '../settings';
import { PROVIDERS, QUALITY_OUT, tvPrefs, type TvPrefs } from '../tv/torrentio';
import { follows, dropFollow } from '../tv/library';

const LANGS: [string, string][] = [['', '—'], ['english', 'English'], ['arabic', 'العربية'], ['japanese', '日本語'], ['korean', '한국어'], ['chinese', '中文'], ['french', 'Français'], ['german', 'Deutsch'], ['spanish', 'Español'], ['latino', 'Latino'], ['portuguese', 'Português'], ['italian', 'Italiano'], ['russian', 'Русский'], ['turkish', 'Türkçe'], ['hindi', 'हिन्दी']];
export function tvSettingsCard(rerender: () => void): HTMLElement {
  const p = tvPrefs(); const set = (o: Partial<TvPrefs>) => updateSettings({ tv: { ...tvPrefs(), ...o } });
  const row = (label: string, control: Node, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), control);
  const multi = (opts: [string, string][], on: string[], setTo: (v: string[]) => void) => { const box = h('div', { class: 'chip-row wrap' }); const draw = () => box.replaceChildren(...opts.map(([v, l]) => h('button', { type: 'button', class: 'chip small' + (on.includes(v) ? ' on' : ''), onclick: () => { on = on.includes(v) ? on.filter((x) => x !== v) : [...on, v]; setTo(on); draw(); } }, l))); draw(); return box; };
  const fl = follows();
  return h('section', { class: 'card', id: 'tv' }, h('h3', null, t('navTv')), h('p', { class: 'hint' }, t('tvSettingsHint')),
    row(t('animeQuality'), pickButton(t('animeQuality'), [['', t('allQualities')], ['2160', '2160p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']], p.quality, (v) => set({ quality: v as '' }), t('close'))),
    row(t('animeLookup'), pickButton(t('animeLookup'), [['quality', t('lookupQuality')], ['size', t('lookupSize')], ['seeders', t('lookupSeeders')]], p.lookup, (v) => set({ lookup: v as 'quality' }), t('close'))),
    h('span', { class: 'label' }, t('tvProviders')), multi(PROVIDERS, p.providers, (v) => set({ providers: v.length ? v : ['yts'] })),
    row(t('tvSort'), pickButton(t('tvSort'), [['qualitysize', t('tvSortQualitySize')], ['quality', t('tvSortQuality')], ['seeders', t('sortSeeds')], ['size', t('sortSize')]], p.sort, (v) => set({ sort: v as 'quality' }), t('close'))),
    h('span', { class: 'label' }, t('tvLeaveOut')), multi(QUALITY_OUT, p.qualityOut, (v) => set({ qualityOut: v })),
    row(t('tvLanguage'), pickButton(t('tvLanguage'), LANGS, p.language, (v) => set({ language: v }), t('close')), t('tvLanguageHint')),
    h('label', { class: 'row switch-row' }, h('span', null, t('tvUseDebrid'), h('small', { class: 'src' }, t('tvUseDebridHint'))), h('input', { type: 'checkbox', checked: p.debrid, onchange: (e: Event) => set({ debrid: (e.target as HTMLInputElement).checked }) })),
    row(t('tvCustom'), h('input', { type: 'text', dir: 'ltr', value: p.custom, placeholder: 'https://torrentio.strem.fun/…/manifest.json', autocomplete: 'off', onchange: (e: Event) => { set({ custom: (e.target as HTMLInputElement).value.trim() }); toast(t('save')); } }), t('tvCustomHint')),
    ...(fl.length ? [h('h4', null, t('tvFollowed')), ...fl.map((f) => h('div', { class: 'dest-row' }, icon('bell'), h('span', { class: 'grow' }, h('span', { dir: 'auto' }, f.name), h('small', { class: 'src' }, ` · S${f.season}E${f.episode}${f.quality ? ` · ${f.quality}p` : ''}`)), h('button', { type: 'button', class: 'btn text small', onclick: () => { dropFollow(f.id); rerender(); } }, t('autoStop'))))] : []));
}
