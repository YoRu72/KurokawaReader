import { h, icon, iconButton, toast } from '../ui/dom';
import { t, getLang, setLang, formatBytes } from '../i18n';
import { navigate } from '../router';
import { db } from '../db';
import { renderOptions } from '../ui/options';

declare global { interface Window { __krInstallPrompt?: { prompt(): Promise<void> } } }

export function settingsView(): HTMLElement {
  const body = h('div', { class: 'settings-body' });
  const root = h('div', { class: 'view settings-view' },
    h('header', { class: 'topbar' }, iconButton('back', t('back'), () => navigate('/')), h('div', { class: 'title' }, t('settings'))),
    body);

  // Language
  const langSeg = h('div', { class: 'segmented' },
    h('button', { type: 'button', 'aria-pressed': String(getLang() === 'en'), onclick: () => { setLang('en'); navigate('/settings', true); } }, t('languageEnglish')),
    h('button', { type: 'button', 'aria-pressed': String(getLang() === 'ar'), style: { fontFamily: 'var(--font-ui-ar)', fontSize: '16px' }, onclick: () => { setLang('ar'); navigate('/settings', true); } }, t('languageArabic')));
  body.append(h('section', { class: 'card' }, h('h3', null, t('language')), langSeg));

  // Fonts sample
  body.append(h('section', { class: 'card' }, h('h3', null, t('fonts')), h('p', null, t('fontsBody')),
    h('p', { class: 'sample' }, 'The quick brown fox jumps over the lazy dog — Lora carries the Latin text.'),
    h('p', { class: 'sample ar' }, 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ — خطُّ عثمان طه للنصِّ العربيِّ، وسلطانُ للواجهة.')));

  // Visual options (shared with the reader)
  const opts = h('div');
  renderOptions(opts);
  body.append(h('section', { class: 'card' }, h('h3', null, t('visualOptions')), opts));

  // Storage
  const storageP = h('p', null, t('storageUnknown'));
  navigator.storage?.estimate?.().then((e) => { if (e.usage != null && e.quota != null) storageP.textContent = t('storageUsed', { used: formatBytes(e.usage), quota: formatBytes(e.quota) }); }).catch(() => undefined);
  if (navigator.storage?.persist) navigator.storage.persisted().then((p) => { if (!p) void navigator.storage.persist(); }).catch(() => undefined);
  body.append(h('section', { class: 'card' }, h('h3', null, t('storage')), storageP,
    h('div', null, h('button', { class: 'btn danger small', onclick: async () => { if (confirm(t('deleteConfirm', { n: (await db.allBooks()).length }))) { await db.clearAll(); toast(t('done')); } } }, icon('trash'), t('clearLibrary')))));

  // Install
  const installBtn = h('button', { class: 'btn primary small', onclick: async () => { await window.__krInstallPrompt?.prompt(); } }, icon('download'), t('installApp'));
  const standalone = matchMedia('(display-mode: standalone)').matches;
  body.append(h('section', { class: 'card' }, h('h3', null, t('about')), h('p', null, t('aboutBody')),
    h('p', null, `${t('version')} 0.1.0`),
    standalone ? h('p', null, t('installed')) : window.__krInstallPrompt ? installBtn : null,
    h('h3', null, t('supportedFormats')),
    h('ul', null, ...(['fmtEpub', 'fmtPdf', 'fmtDocx', 'fmtXlsx', 'fmtPptx', 'fmtText', 'fmtFb2', 'fmtOdt', 'fmtCbz', 'fmtImages'] as const).map((k) => h('li', null, t(k)))),
    h('h3', null, t('keyboardShortcuts')), h('p', null, t('shortcutsBody'))));

  return root;
}
