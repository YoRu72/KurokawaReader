import { h, icon, iconButton, toast, clear, openSheet, pickButton } from '../ui/dom';
import { t, formatBytes, getLangPref, setLangPref, getDirPref, setDirPref, isTouchDevice, type LangPref, type DirPref, LANGS, systemLang, localDigits } from '../i18n';
import { navigate } from '../router';
import { db } from '../db';
import { renderOptions } from '../ui/options';
import { colorField } from '../ui/colorpicker';
import { getSettings, updateSettings, applyOrientation, isDefault, resetSetting, type VisualSettings, type UiMode, type Accent, type Orientation } from '../settings';
import { listFonts, listSystemFonts, canListSystemFonts, addFontFromFile, addFontFromUrl, removeFont, setFontScript, type FontScript } from '../fonts';
import { renderUpdateCard, APP_VERSION } from '../updates';
import { nativePlatform, canSetAppName, setAppName } from '../native';
import { decksCard } from '../ui/decks';
import { SHORTCUTS, bindingFor, setBinding, resetBindings, comboOf } from '../shortcuts';

declare global { interface Window { __krInstallPrompt?: { prompt(): Promise<void> } } }

export function settingsView(): HTMLElement {
  const body = h('div', { class: 'settings-body' });
  const root = h('div', { class: 'view settings-view' },
    h('header', { class: 'topbar' }, iconButton('back', t('back'), () => navigate('/')), h('div', { class: 'title' }, t('settings'))),
    body);
  const s = getSettings();

  // Language & direction
  const langs: [LangPref, string][] = [['system', `${t('langSystem')} · ${LANGS.find(([c]) => c === systemLang())?.[1] ?? 'English'}`], ...LANGS];
  const dirs: [DirPref, string][] = [['auto', t('dirAuto')], ['ltr', t('dirLtr')], ['rtl', t('dirRtl')]];
  body.append(h('section', { class: 'card' }, h('h3', null, t('language')),
    // A list rather than a row of buttons: it grows as interface languages are added.
    pickButton<LangPref>(t('language'), langs.map(([id, label]): [LangPref, string] => [id, label]), getLangPref(), (id) => { setLangPref(id); navigate('/settings', true); }, t('close')),
    ...(canSetAppName() ? [h('div', { class: 'field' }, resettable(t('appNameOnDevice'), 'appName', () => { void setAppName('auto'); renderAppearance(); }), pickButton<VisualSettings['appName']>(t('appNameOnDevice'), [['auto', t('appNameAuto')], ['en', 'KurokawaReader'], ['ar', 'قارئ كروكاوا'], ['ja', '黒川リーダー'], ['zh', '黑川阅读器'], ['ko', '쿠로카와 리더']], getSettings().appName, (v) => { updateSettings({ appName: v }); void setAppName(v); toast(t('appNameChanged')); }, t('close')), h('span', { class: 'hint' }, t('appNameHint')))] : []),
    h('div', { class: 'field' }, h('span', { class: 'label' }, t('direction')), h('div', { class: 'segmented' }, ...dirs.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(getDirPref() === id), onclick: () => { setDirPref(id); navigate('/settings', true); } }, label))))));

  // Appearance: interface mode, accent, orientation
  const appearance = h('section', { class: 'card' });
  const renderAppearance = () => {
    clear(appearance);
    const cur = getSettings();
    const modes: [UiMode, string][] = [['system', t('uiSystem')], ['light', t('uiLight')], ['dark', t('uiDark')], ['page', t('uiPage')]];
    const accents: [Accent, string, string][] = [['graphite', t('accentGraphite'), '#c9ccd2'], ['aqua', t('accentAqua'), '#8fd0f0'], ['teal', t('accentTeal'), '#86d6cf'], ['gold', t('accentGold'), '#ebc47e'], ['coral', t('accentCoral'), '#ffb59f'], ['rose', t('accentRose'), '#f3b3c6'], ['mint', t('accentMint'), '#a6d3c4'], ['violet', t('accentViolet'), '#cdbdff'], ['olive', t('accentOlive'), '#c3cf9a'], ['sand', t('accentSand'), '#e3c9a3'], ['mono', t('accentMono'), '#e2e2e2'], ['custom', t('accentCustom'), cur.accentCustom]];
    const orients: [Orientation, string][] = [['auto', t('orientationAuto')], ['portrait', t('orientationPortrait')], ['landscape', t('orientationLandscape')]];
    const parts: (HTMLElement | null)[] = [h('h3', null, t('appearance')),
      h('div', { class: 'field' }, resettable(t('uiMode'), 'uiMode', () => { renderAppearance(); void applyOrientation(); }), h('div', { class: 'segmented' }, ...modes.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(cur.uiMode === id), onclick: () => { updateSettings({ uiMode: id }); renderAppearance(); } }, label)))),
      h('div', { class: 'field' }, resettable(t('accent'), 'accent', () => { renderAppearance(); void applyOrientation(); }), h('div', { class: 'theme-swatches' }, ...accents.map(([id, label, color]) => h('button', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(cur.accent === id), style: { background: color, color: '#111' }, onclick: () => { updateSettings({ accent: id }); renderAppearance(); } }, id === 'custom' ? icon('type') : '')))),
      cur.accent === 'custom' ? h('div', { class: 'row', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('span', null, t('accentCustom')), colorField(cur.accentCustom, (v) => updateSettings({ accentCustom: v }), t('accentCustom'))) : null,
      h('div', { class: 'field' }, resettable(t('orientation'), 'orientation', () => { renderAppearance(); void applyOrientation(); }), h('div', { class: 'segmented' }, ...orients.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(cur.orientation === id), onclick: () => { updateSettings({ orientation: id }); void applyOrientation(); renderAppearance(); } }, label)))),
      h('div', { class: 'field' }, resettable(t('libraryView'), 'libraryView', () => { renderAppearance(); void applyOrientation(); }), h('div', { class: 'segmented' }, ...([['cards', t('viewCards')], ['chips', t('viewChips')]] as ['cards' | 'chips', string][]).map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(cur.libraryView === id), onclick: () => { updateSettings({ libraryView: id }); renderAppearance(); } }, label)))),
      h('div', { class: 'field' }, resettable(t('importButtonPlace'), 'importButton', () => { renderAppearance(); void applyOrientation(); }), h('div', { class: 'segmented' }, ...([['chips', t('importChips')], ['top', t('importTop')], ['fab', t('importFab')]] as ['chips' | 'top' | 'fab', string][]).map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(cur.importButton === id), onclick: () => { updateSettings({ importButton: id }); renderAppearance(); } }, label)))),
      h('div', { class: 'field' }, resettable(t('coverSize'), 'coverSize', () => { renderAppearance(); void applyOrientation(); }), h('div', { class: 'segmented' }, ...([['small', t('coverSmall')], ['medium', t('coverMedium')], ['large', t('coverLarge')]] as ['small' | 'medium' | 'large', string][]).map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(cur.coverSize === id), onclick: () => { updateSettings({ coverSize: id }); renderAppearance(); } }, label)))),
      h('label', { class: 'row', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' } }, h('span', null, t('openLastOnLaunch')), (() => { const c = h('input', { type: 'checkbox', checked: cur.openLastOnLaunch, onchange: () => updateSettings({ openLastOnLaunch: c.checked }) }) as HTMLInputElement; return c; })()),
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
    Array.from(fontsCard.children).forEach((c) => { if (!c.matches('h3.card-title')) c.remove(); });
    const fonts = await listFonts();
    const url = h('input', { type: 'text', placeholder: t('fontUrlPlaceholder'), style: { flex: '1' }, dir: 'ltr' }) as HTMLInputElement;
    if (!fontsCard.querySelector('h3.card-title')) fontsCard.prepend(h('h3', null, t('fonts')));
    fontsCard.append(h('p', null, t('fontsBody')),
      h('p', { class: 'sample' }, 'The quick brown fox jumps over the lazy dog — Lora carries the Latin text.'),
      h('p', { class: 'sample ar' }, 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ — خطُّ عثمان طه للنصِّ العربيِّ، وسلطانُ للواجهة.'),
      h('h3', null, t('customFonts')), h('p', null, t('customFontsBody')),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn small', onclick: () => fileInput.click() }, icon('import'), t('addFontFile')), fileInput,
        h('button', { class: 'btn small', onclick: () => fontSitesSheet() }, icon('external'), t('browseFonts')),
        canListSystemFonts() ? h('button', { class: 'btn small', onclick: () => void systemFontsSheet() }, icon('type'), t('systemFontsPick')) : null),
      h('form', { style: { display: 'flex', gap: '8px' }, onsubmit: async (e: Event) => { e.preventDefault(); if (!url.value.trim()) return; try { const font = await addFontFromUrl(url.value.trim()); toast(t('fontAdded', { name: font.name })); url.value = ''; void renderFonts(); } catch (err) { toast(navigator.onLine ? String((err as Error).message ?? err) : t('offlineService'), 'error', 4000); } } }, url, h('button', { class: 'btn small tonal', type: 'submit' }, icon('download'), t('addFontUrl'))),
      fonts.length ? h('ul', { class: 'plain-list' }, ...fonts.map((f) => h('li', null,
        h('span', { style: { flex: '1', fontFamily: `'${f.family}'`, fontSize: '18px', padding: '8px 10px' }, dir: 'auto' }, f.name, h('span', { class: 'meta' }, formatBytes(f.size))),
        h('div', { class: 'segmented', style: { flex: '0 0 auto' } }, ...(['latin', 'arabic'] as FontScript[]).map((sc) => h('button', { type: 'button', style: { height: '34px', padding: '0 10px' }, 'aria-pressed': String(f.script === sc), onclick: async () => { await setFontScript(f.id, sc); void renderFonts(); } }, sc === 'latin' ? t('fontForLatin') : t('fontForArabic')))),
        h('button', { type: 'button', class: 'del', 'aria-label': t('delete'), onclick: async () => { await removeFont(f.id); toast(t('fontRemoved')); void renderFonts(); } }, icon('trash'))))) : h('p', { style: { fontSize: '13px' } }, t('noCustomFonts')));
  };
  void renderFonts();
  body.append(fontsCard);

  function fontSitesSheet() {
    const sh = openSheet(t('browseFonts'), t('close'));
    sh.body.style.fontFamily = 'var(--font-ui)';
    sh.body.append(h('p', { class: 'src' }, t('browseFontsBody')));
    const site = (name: string, url: string) => h('li', null, h('a', { class: 'plain-link', href: url, target: '_blank', rel: 'noopener' }, icon('external'), name));
    sh.body.append(h('ul', { class: 'plain-list' },
      site('Google Fonts — Arabic', 'https://fonts.google.com/?subset=arabic'),
      site('Google Fonts', 'https://fonts.google.com/'),
      site('Font Squirrel', 'https://www.fontsquirrel.com/'),
      site('Fontsource', 'https://fontsource.org/'),
      site('Amiri · Scheherazade · Noto Naskh (GitHub)', 'https://github.com/aliftype/amiri/releases')));
  }

  async function systemFontsSheet() {
    const sh = openSheet(t('systemFontsPick'), t('close'));
    sh.body.style.fontFamily = 'var(--font-ui)';
    sh.body.append(h('p', { class: 'src' }, t('systemFontsBody')));
    const list = h('div', { class: 'dest-list', style: { maxHeight: '50vh', overflowY: 'auto' } });
    const search = h('input', { type: 'search', placeholder: t('searchLibrary'), style: { width: '100%', marginBottom: '8px' } }) as HTMLInputElement;
    sh.body.append(search, list);
    const fonts = await listSystemFonts();
    if (!fonts.length) { list.append(h('p', { class: 'src' }, t('notSupportedHere'))); return; }
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const chosen = new Set(getSettings().systemFonts);
      list.replaceChildren(...fonts.filter((f) => !q || f.family.toLowerCase().includes(q)).slice(0, 400).map((f) => h('label', { class: 'dest-row' + (chosen.has(f.family) ? ' on' : '') },
        h('input', { type: 'checkbox', checked: chosen.has(f.family), onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; const next = new Set(getSettings().systemFonts); if (on) next.add(f.family); else next.delete(f.family); updateSettings({ systemFonts: [...next] }); render(); } }),
        icon('type'), h('span', { class: 'name', style: { fontFamily: `'${f.family}'`, fontSize: '17px' } }, f.family))));
    };
    search.addEventListener('input', render);
    render();
  }

  // Reader options (shared with the reader panel)
  const opts = h('div');
  renderOptions(opts);
  body.append(h('section', { class: 'card' }, h('h3', null, t('readerSettings')), opts));

  // Starter books
  body.append(h('section', { class: 'card' }, h('h3', null, t('sampleBooks')), h('p', null, t('sampleBooksBody')),
    h('div', null, h('button', { class: 'btn tonal small', onclick: async () => { toast(t('addingSamples'), 'info', 60000); try { const { importSamples } = await import('../samples'); const a = await importSamples(); toast(t('imported', { n: a.length })); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } } }, icon('books'), t('sampleBooks')))));

  // AI (translation & voices)
  body.append(h('section', { class: 'card' }, h('h3', null, t('aiSection')), h('p', null, t('aiTranslateBody')),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', { class: 'btn tonal small', onclick: async () => { const { aiSettingsSheet } = await import('../ui/aisettings'); aiSettingsSheet(); } }, icon('settings'), t('aiSetup')))));

  // Account & sync
  body.append(h('section', { class: 'card' }, h('h3', null, t('sync')), h('p', null, t('syncBody')),
    h('div', null, h('button', { class: 'btn tonal small', onclick: () => void import('../ui/syncsheet').then((m) => m.syncSheet()) }, icon('cloud'), t('sync')))));

  // Backup & restore
  const restoreInput = h('input', { type: 'file', accept: '.json,.zip,application/json,application/zip', hidden: true }) as HTMLInputElement;
  const bkStatus = h('p', { class: 'src' });
  restoreInput.addEventListener('change', async () => {
    const f = restoreInput.files?.[0]; restoreInput.value = ''; if (!f) return;
    bkStatus.textContent = t('importing', { n: 1 });
    try { const { restoreBackup } = await import('../backup'); const n = await restoreBackup(f, (title) => { bkStatus.textContent = title; }); bkStatus.textContent = t('restored', { n }); toast(t('restored', { n })); }
    catch (err) { bkStatus.textContent = `${t('restoreFailed')} — ${String((err as Error).message ?? err)}`; }
  });
  body.append(h('section', { class: 'card' }, h('h3', null, t('backup')), h('p', null, t('backupBody')),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', { class: 'btn tonal small', onclick: async () => { const { backupNotes } = await import('../backup'); await backupNotes(); } }, icon('download'), t('backupNotes')),
      h('button', { class: 'btn small', onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; try { const { backupFull } = await import('../backup'); await backupFull((d, n) => { bkStatus.textContent = `${d}/${n}`; }); bkStatus.textContent = ''; } finally { b.disabled = false; } } }, icon('books'), t('backupFull')),
      h('button', { class: 'btn small outlined', onclick: () => restoreInput.click() }, icon('import'), t('restore')), restoreInput),
    bkStatus));

  // Keyboard shortcuts: every PC and browser (touch-screen laptops included); phones and tablets skip it.
  if (nativePlatform() !== 'android' && nativePlatform() !== 'ios') {
    const list = h('div', { class: 'dest-list' });
    const renderKeys = () => {
      list.replaceChildren(...SHORTCUTS.map((sc) => {
        const combo = bindingFor(sc.id);
        const keyBtn = h('button', { type: 'button', class: 'key-cap', dir: 'ltr', 'aria-label': t('pressNewShortcut') }, combo || '—');
        keyBtn.addEventListener('click', () => {
          keyBtn.textContent = t('pressKeys'); keyBtn.classList.add('listening');
          const onKey = (e: KeyboardEvent) => {
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Escape') { window.removeEventListener('keydown', onKey, true); renderKeys(); return; }
            const c = comboOf(e); if (!c) return;
            window.removeEventListener('keydown', onKey, true);
            setBinding(sc.id, c); renderKeys();
          };
          window.addEventListener('keydown', onKey, true);
        });
        return h('div', { class: 'dest-row' }, icon(sc.scope === 'reader' ? 'books' : 'library'), h('span', { class: 'name' }, t(sc.label as 'library')), keyBtn);
      }));
    };
    renderKeys();
    body.append(h('section', { class: 'card' }, h('h3', null, t('keyboardShortcuts')), h('p', null, t('shortcutsEditBody')), list,
      h('div', null, h('button', { class: 'btn small outlined', onclick: () => { resetBindings(); renderKeys(); } }, t('resetDefaults')))));
  }

  // Learning decks: optional downloads, nothing installed by default
  body.append(decksCard());

  // Updates
  const upd = h('section', { class: 'card' }, h('h3', null, t('updates')));
  renderUpdateCard(upd);
  const desk = (window as unknown as { kurokawaDesktop?: { platform?: string; openDefaultApps?(): Promise<unknown> } }).kurokawaDesktop;
  if (desk?.openDefaultApps && desk.platform === 'win32') upd.append(h('p', { style: { marginTop: '12px' } }, t('defaultAppsBody')), h('button', { class: 'btn small', onclick: () => void desk.openDefaultApps!() }, icon('external'), t('defaultApps')));
  body.append(upd);

  // Storage
  const storageP = h('p', null, t('storageUnknown'));
  const storageActions = h('div', { class: 'actions-row', style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } });
  const paintStorage = () => void import('../storage').then(async (m) => {
    const r = await m.storageReport();
    storageP.textContent = [r.total != null ? t('storageAppTotal', { size: formatBytes(r.total) }) : null, t('storageBooks', { n: r.books, linked: r.linked, copied: r.copied.length, size: formatBytes(r.copiedBytes) }), r.cache != null ? t('storageCache', { size: formatBytes(r.cache) }) : null].filter(Boolean).join(' · ');
    clear(storageActions);
    storageActions.append(h('button', { class: 'btn small', type: 'button', onclick: async () => { const freed = await m.freeSpace(); toast(t('spaceFreed', { size: formatBytes(freed) })); paintStorage(); } }, icon('trash'), t('freeSpace')));
    if (r.copied.length && m.canMoveOut()) {
      const status = h('span', { class: 'hint' });
      storageActions.append(h('button', { class: 'btn small tonal', type: 'button', onclick: async (e: Event) => {
        (e.currentTarget as HTMLButtonElement).disabled = true;
        const n = await m.moveBooksOut(r.copied, (done, total, name) => { status.textContent = name ? `${localDigits(done + 1)}/${localDigits(total)} · ${name}` : ''; });
        toast(t('movedOut', { n })); paintStorage();
      } }, icon('folder'), t('moveOut', { n: r.copied.length, size: formatBytes(r.copiedBytes) })), status);
    }
  }).catch(() => undefined);
  paintStorage();
  if (navigator.storage?.persist) navigator.storage.persisted().then((p) => { if (!p) void navigator.storage.persist(); }).catch(() => undefined);
  const importModeField = (nativePlatform() === 'android' || 'kurokawaDesktop' in window) ? h('div', { class: 'field' }, resettable(t('importMode'), 'importMode', () => renderAppearance()), h('div', { class: 'segmented' }, ...([['link', t('importLink')], ['copy', t('importCopy')]] as ['link' | 'copy', string][]).map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(getSettings().importMode === id), onclick: () => { updateSettings({ importMode: id }); navigate('/settings', true); } }, label))), h('span', { class: 'hint' }, t('importModeHint'))) : null;
  body.append(h('section', { class: 'card' }, h('h3', null, t('storage')), storageP, storageActions, importModeField,
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

  // ---- Sections, collapsing and search ----
  const cards = Array.from(body.querySelectorAll<HTMLElement>(':scope > .card'));
  // the fonts card fills in asynchronously; give it its title now so it collapses and appears in the nav
  if (!fontsCard.querySelector('h3')) fontsCard.prepend(h('h3', null, t('fonts')));
  const nav = h('div', { class: 'folder-chips settings-nav', role: 'tablist' });
  const search = h('input', { type: 'search', class: 'settings-search', placeholder: t('searchSettings'), 'aria-label': t('searchSettings') }) as HTMLInputElement;
  const head = h('div', { class: 'settings-head' }, search, nav);
  body.prepend(head);
  cards.forEach((card, i) => {
    const title = card.querySelector('h3');
    if (!title) return;
    card.id = `s-${i}`;
    title.classList.add('card-title');
    title.setAttribute('role', 'button'); title.setAttribute('tabindex', '0');
    title.prepend(icon('chevronDown'));
    // Everything starts folded except Updates, so the page is a short list of headings.
    if ((title.textContent ?? '').trim() !== t('updates')) card.classList.add('collapsed');
    const toggleCard = () => card.classList.toggle('collapsed');
    title.addEventListener('click', toggleCard);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(); } });
    nav.append(h('button', { type: 'button', class: 'chip small', onclick: () => { card.classList.remove('collapsed'); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, h('span', null, title.textContent ?? '')));
  });
  const applySearch = () => {
    const q = search.value.trim().toLowerCase();
    for (const card of cards) {
      if (!q) { card.hidden = false; card.querySelectorAll<HTMLElement>('[data-sq]').forEach((el) => { el.hidden = false; el.removeAttribute('data-sq'); }); continue; }
      card.classList.remove('collapsed');
      let any = false;
      // rows under the card title: show those whose text (or a nested label) mentions the query
      for (const row of Array.from(card.children) as HTMLElement[]) {
        if (row.matches('h3')) continue;
        const hit = (row.textContent ?? '').toLowerCase().includes(q);
        // inside the reader options grid, filter control by control; a section heading stays if any control under it matches
        const grid = row.querySelector<HTMLElement>('.options-grid');
        if (grid) {
          let sub = false; let heading: HTMLElement | null = null; let headingHit = false;
          const kids = Array.from(grid.children) as HTMLElement[];
          const flush = () => { if (heading) { heading.hidden = !headingHit; heading.setAttribute('data-sq', '1'); } };
          for (const k of kids) {
            if (k.tagName === 'H4') { flush(); heading = k; headingHit = false; continue; }
            const ok = (k.textContent ?? '').toLowerCase().includes(q) || Array.from(k.querySelectorAll('[title],[aria-label]')).some((e) => ((e.getAttribute('title') ?? '') + (e.getAttribute('aria-label') ?? '')).toLowerCase().includes(q));
            k.hidden = !ok; k.setAttribute('data-sq', '1'); if (ok) { sub = true; headingHit = true; }
          }
          flush();
          row.hidden = !sub; row.setAttribute('data-sq', '1'); if (sub) any = true; continue;
        }
        row.hidden = !hit; row.setAttribute('data-sq', '1'); if (hit) any = true;
      }
      card.hidden = !any;
    }
  };
  search.addEventListener('input', applySearch);
  return root;
}

/** Field label with a "back to default" button once the setting has been changed. */
function resettable(text: string, key: keyof VisualSettings, after: () => void): HTMLElement {
  const span = h('span', { class: 'label' }, text);
  if (!isDefault(key)) span.append(h('button', { type: 'button', class: 'reset-one', title: t('resetThis'), 'aria-label': t('resetThis'), onclick: () => { resetSetting(key); after(); } }, icon('undo')));
  return span;
}
