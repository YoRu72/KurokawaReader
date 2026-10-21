import { h, icon, iconButton, toast, clear } from '../ui/dom';
import { t, formatBytes, getLangPref, setLangPref, getDirPref, setDirPref, isTouchDevice, type LangPref, type DirPref } from '../i18n';
import { navigate } from '../router';
import { db } from '../db';
import { renderOptions } from '../ui/options';
import { getSettings, updateSettings, applyOrientation, type UiMode, type Accent, type Orientation } from '../settings';
import { listFonts, addFontFromFile, addFontFromUrl, removeFont, setFontScript, type FontScript } from '../fonts';
import { renderUpdateCard, APP_VERSION } from '../updates';

declare global { interface Window { __krInstallPrompt?: { prompt(): Promise<void> } } }

export function settingsView(): HTMLElement {
  const body = h('div', { class: 'settings-body' });
  const root = h('div', { class: 'view settings-view' },
    h('header', { class: 'topbar' }, iconButton('back', t('back'), () => navigate('/')), h('div', { class: 'title' }, t('settings'))),
    body);
  const s = getSettings();

  // Language & direction
  const langs: [LangPref, string][] = [['system', t('langSystem')], ['en', t('languageEnglish')], ['ar', t('languageArabic')]];
  const dirs: [DirPref, string][] = [['auto', t('dirAuto')], ['ltr', t('dirLtr')], ['rtl', t('dirRtl')]];
  body.append(h('section', { class: 'card' }, h('h3', null, t('language')),
    h('div', { class: 'segmented' }, ...langs.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(getLangPref() === id), style: id === 'ar' ? { fontFamily: 'var(--font-ui-ar)', fontSize: '16px' } : undefined, onclick: () => { setLangPref(id); navigate('/settings', true); } }, label))),
    h('div', { class: 'field' }, h('span', { class: 'label' }, t('direction')), h('div', { class: 'segmented' }, ...dirs.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(getDirPref() === id), onclick: () => { setDirPref(id); navigate('/settings', true); } }, label))))));

  // Appearance: interface mode, accent, orientation
  const appearance = h('section', { class: 'card' });
  const renderAppearance = () => {
    clear(appearance);
    const cur = getSettings();
    const modes: [UiMode, string][] = [['system', t('uiSystem')], ['light', t('uiLight')], ['dark', t('uiDark')], ['page', t('uiPage')]];
    const accents: [Accent, string, string][] = [['graphite', t('accentGraphite'), '#c9ccd2'], ['aqua', t('accentAqua'), '#8fd0f0'], ['teal', t('accentTeal'), '#86d6cf'], ['gold', t('accentGold'), '#ebc47e'], ['coral', t('accentCoral'), '#ffb59f'], ['rose', t('accentRose'), '#f3b3c6'], ['mint', t('accentMint'), '#a6d3c4'], ['violet', t('accentViolet'), '#cdbdff'], ['mono', t('accentMono'), '#e2e2e2'], ['custom', t('accentCustom'), cur.accentCustom]];
    const orients: [Orientation, string][] = [['auto', t('orientationAuto')], ['portrait', t('orientationPortrait')], ['landscape', t('orientationLandscape')]];
    const parts: (HTMLElement | null)[] = [h('h3', null, t('appearance')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('uiMode')), h('div', { class: 'segmented' }, ...modes.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(cur.uiMode === id), onclick: () => { updateSettings({ uiMode: id }); renderAppearance(); } }, label)))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('accent')), h('div', { class: 'theme-swatches' }, ...accents.map(([id, label, color]) => h('button', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(cur.accent === id), style: { background: color, color: '#111' }, onclick: () => { updateSettings({ accent: id }); renderAppearance(); } }, id === 'custom' ? icon('type') : '')))),
      cur.accent === 'custom' ? h('div', { class: 'row', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('span', null, t('accentCustom')), (() => { const c = h('input', { type: 'color', value: cur.accentCustom, oninput: () => updateSettings({ accentCustom: c.value }) }) as HTMLInputElement; return c; })()) : null,
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('orientation')), h('div', { class: 'segmented' }, ...orients.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(cur.orientation === id), onclick: () => { updateSettings({ orientation: id }); void applyOrientation(); renderAppearance(); } }, label)))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('libraryView')), h('div', { class: 'segmented' }, ...([['cards', t('viewCards')], ['chips', t('viewChips')]] as ['cards' | 'chips', string][]).map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(cur.libraryView === id), onclick: () => { updateSettings({ libraryView: id }); renderAppearance(); } }, label)))),
    ];
    appearance.append(...parts.filter((x): x is HTMLElement => x !== null));
  };
  renderAppearance();
  body.append(appearance);

  // Fonts: samples + custom fonts
  const fontsCard = h('section', { class: 'card' });
  const fileInput = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2,font/*', multiple: true, hidden: true }) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    for (const f of Array.from(fileInput.files ?? [])) {
      try { const font = await addFontFromFile(f); toast(t('fontAdded', { name: font.name })); } catch (e) { toast(`${f.name}: ${String((e as Error).message ?? e)}`, 'error', 4000); }
    }
    fileInput.value = '';
    void renderFonts();
  });
  const renderFonts = async () => {
    clear(fontsCard);
    const fonts = await listFonts();
    const url = h('input', { type: 'text', placeholder: t('fontUrlPlaceholder'), style: { flex: '1' }, dir: 'ltr' }) as HTMLInputElement;
    fontsCard.append(h('h3', null, t('fonts')), h('p', null, t('fontsBody')),
      h('p', { class: 'sample' }, 'The quick brown fox jumps over the lazy dog — Lora carries the Latin text.'),
      h('p', { class: 'sample ar' }, 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ — خطُّ عثمان طه للنصِّ العربيِّ، وسلطانُ للواجهة.'),
      h('h3', null, t('customFonts')), h('p', null, t('customFontsBody')),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn small', onclick: () => fileInput.click() }, icon('import'), t('addFontFile')), fileInput),
      h('form', { style: { display: 'flex', gap: '8px' }, onsubmit: async (e: Event) => { e.preventDefault(); if (!url.value.trim()) return; try { const font = await addFontFromUrl(url.value.trim()); toast(t('fontAdded', { name: font.name })); url.value = ''; void renderFonts(); } catch (err) { toast(navigator.onLine ? String((err as Error).message ?? err) : t('offlineService'), 'error', 4000); } } }, url, h('button', { class: 'btn small tonal', type: 'submit' }, icon('download'), t('addFontUrl'))),
      fonts.length ? h('ul', { class: 'plain-list' }, ...fonts.map((f) => h('li', null,
        h('span', { style: { flex: '1', fontFamily: `'${f.family}'`, fontSize: '18px', padding: '8px 10px' }, dir: 'auto' }, f.name, h('span', { class: 'meta' }, formatBytes(f.size))),
        h('div', { class: 'segmented', style: { flex: '0 0 auto' } }, ...(['latin', 'arabic'] as FontScript[]).map((sc) => h('button', { type: 'button', style: { height: '34px', padding: '0 10px' }, 'aria-pressed': String(f.script === sc), onclick: async () => { await setFontScript(f.id, sc); void renderFonts(); } }, sc === 'latin' ? t('fontForLatin') : t('fontForArabic')))),
        h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { await removeFont(f.id); toast(t('fontRemoved')); void renderFonts(); } }, icon('trash'))))) : h('p', { style: { fontSize: '13px' } }, t('noCustomFonts')));
  };
  void renderFonts();
  body.append(fontsCard);

  // Reader options (shared with the reader panel)
  const opts = h('div');
  renderOptions(opts);
  body.append(h('section', { class: 'card' }, h('h3', null, t('readerSettings')), opts));

  // Starter books
  body.append(h('section', { class: 'card' }, h('h3', null, t('sampleBooks')), h('p', null, t('sampleBooksBody')),
    h('div', null, h('button', { class: 'btn tonal small', onclick: async () => { toast(t('addingSamples'), 'info', 60000); try { const { importSamples } = await import('../samples'); const a = await importSamples(); toast(t('imported', { n: a.length })); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } } }, icon('books'), t('sampleBooks')))));

  // Updates
  const upd = h('section', { class: 'card' }, h('h3', null, t('updates')));
  renderUpdateCard(upd);
  body.append(upd);

  // Storage
  const storageP = h('p', null, t('storageUnknown'));
  navigator.storage?.estimate?.().then((e) => { if (e.usage != null && e.quota != null) storageP.textContent = t('storageUsed', { used: formatBytes(e.usage), quota: formatBytes(e.quota) }); }).catch(() => undefined);
  if (navigator.storage?.persist) navigator.storage.persisted().then((p) => { if (!p) void navigator.storage.persist(); }).catch(() => undefined);
  body.append(h('section', { class: 'card' }, h('h3', null, t('storage')), storageP,
    h('div', null, h('button', { class: 'btn danger small', onclick: async () => { if (confirm(t('deleteConfirm', { n: (await db.allBooks()).length }))) { await db.clearAll(); toast(t('done')); } } }, icon('trash'), t('clearLibrary')))));

  // About
  const installBtn = h('button', { class: 'btn primary small', onclick: async () => { await window.__krInstallPrompt?.prompt(); } }, icon('download'), t('installApp'));
  const standalone = matchMedia('(display-mode: standalone)').matches;
  body.append(h('section', { class: 'card' }, h('h3', null, t('about')), h('p', null, t('aboutBody')),
    h('p', null, `${t('version')} ${APP_VERSION}`),
    standalone ? h('p', null, t('installed')) : window.__krInstallPrompt ? installBtn : null,
    h('h3', null, t('supportedFormats')),
    h('ul', null, ...(['fmtEpub', 'fmtPdf', 'fmtDocx', 'fmtXlsx', 'fmtPptx', 'fmtText', 'fmtFb2', 'fmtOdt', 'fmtCbz', 'fmtImages'] as const).map((k) => h('li', null, t(k)))),
    ...(isTouchDevice() ? [] : [h('h3', null, t('keyboardShortcuts')), h('p', null, t('shortcutsBody'))])));

  void s;
  return root;
}
