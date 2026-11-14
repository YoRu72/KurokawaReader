// Settings → Appearance: the theme gallery (theme/gallery.ts), how much glass is blurred, light or dark, the dark
// tone (for the themes that follow it), the accent; a phone's battery choice, a computer's sidebar choice.
import { h, icon, toast, openSheet, pickButton } from '../ui/dom';
import { t, formatBytes } from '../i18n';
import { getSettings, updateSettings, glassNow, reloadThemePictures, setThemePreview, type Accent, type UiMode, type DarkTone, type Settings } from '../settings';
import { onBack } from '../ui/backstack';
import { undoScope } from '../ui/undo';
import { saveText } from '../native';
import { myStore } from '../myStore';
import type { EditorDeps } from '../theme/editor';
import { themeById, type BlurPref } from '../theme/themes';
import { themeGallery } from '../theme/gallery';
import { themeIo } from '../themeIo';

const row = (label: string, control: Node, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), control);
const toggle = (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => { const c = h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }); return h('label', { class: 'row switch-row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), c); };
const ACCENTS: Accent[] = ['graphite', 'mono', 'teal', 'aqua', 'mint', 'olive', 'gold', 'sand', 'coral', 'rose', 'violet'];

/** A theme put in use: its own colours brought (or the accent given back), its pictures read. */
function useTheme(id: string, own: boolean): void {
  const cur = getSettings(); const next = themeById(id);
  const hasRoles = !next.classic && !!(next.dark?.roles || next.light?.roles);
  const takeOwn = own && hasRoles;
  const accent: Accent = takeOwn ? 'theme' : cur.accent === 'theme' ? (cur.accentPrev ?? 'graphite') : cur.accent;
  updateSettings({ theme: id, accent, accentPrev: takeOwn && cur.accent !== 'theme' ? cur.accent : cur.accentPrev });
  reloadThemePictures();
}
/** A file chosen by the reader (null when the chooser was closed). */
function pickFile(accept: string): Promise<Blob | null> {
  return new Promise((res) => {
    const f = h('input', { type: 'file', accept, style: { display: 'none' } }) as HTMLInputElement;
    f.addEventListener('change', () => { res(f.files?.[0] ?? null); f.remove(); });
    f.addEventListener('cancel', () => { res(null); f.remove(); });
    document.body.append(f); f.click();
  });
}
/** What the shared theme editor needs from this app. */
export function editorDeps(rerender: () => void): EditorDeps {
  const pc = () => document.documentElement.classList.contains('pc');
  return {
    t: (k, v) => t(k as 'appearance', v), icon, store: myStore, isPc: pc, darkTone: () => getSettings().darkTone,
    mode: () => (document.documentElement.dataset.ui === 'light' ? 'light' : 'dark'),
    blurLimit: () => { if (glassNow.blur === 'full') return null; const what = { reduced: t('glassBlurReduced'), off: t('glassBlurOff') }[glassNow.blur as 'reduced' | 'off']; const why = { chosen: t('glassBlur'), platform: t(pc() ? 'glassWhyPc' : 'glassWhyPhone'), memory: t('glassWhyMemory'), transparency: t('glassWhyTransparency'), motion: t('glassWhyMotion'), battery: t('glassWhyBattery') }[glassNow.why]; return t('editorBlurLimited', { what, why }); },
    preview: (p) => setThemePreview(p), use: (id, own) => { useTheme(id, own); rerender(); }, inUse: () => getSettings().theme ?? '',
    choose: (title, actions) => { const x = openSheet(title, t('close')); x.body.append(h('div', { class: 'te-choices' }, ...actions.map((a) => h('button', { type: 'button', class: 'dest-row te-choice' + (a.danger ? ' danger' : ''), onclick: () => { x.close(); a.run(); } }, a.icon ? icon(a.icon) : null, h('span', null, a.label))))); },
    toast: (m, k, action, ms) => toast(m, k ?? 'info', ms ?? 4200, action),
    onBack, pickFile, saveText: (n, txt) => saveText(n, txt, 'text/plain'),
    packPictures: async () => {
      const { installed, pictureUrls } = await import('../theme/packs'); const { themeIo } = await import('../themeIo');
      const have = await installed(themeIo); const out: { id: string; asset: string; label: string; url: string }[] = [];
      for (const rec of Object.values(have)) { const urls = await pictureUrls(themeIo, rec.id); for (const a of rec.assets) if (urls[a]) out.push({ id: rec.id, asset: a, label: `${rec.name ?? rec.id} · ${a === 'bg-dark' ? t('uiDark') : a === 'bg-light' ? t('uiLight') : a}`, url: urls[a] }); }
      return out;
    },
    changed: () => rerender(),
    // (The app's Ctrl+Z listener takes the keys first, in the capture phase: the editor's stack goes in as its scope.)
    keys: (handler) => undoScope(handler),
  };
}
const RESET_KEYS = ['theme', 'glassBlur', 'accent', 'accentCustom', 'accentPrev', 'darkTone', 'uiMode', 'uiScale', 'glassRail', 'glassBattery', 'themeKeepColours'] as const;

export function appearanceCard(rerender: () => void): HTMLElement {
  const s = getSettings(); const def = themeById(s.theme);
  const pc = document.documentElement.classList.contains('pc');
  const ed = editorDeps(rerender);
  const editor = () => import('../theme/editor');
  const ownColours = !def.classic && !!(def.dark?.roles || def.light?.roles);
  const gallery = themeGallery({
    t: (k, v) => t(k as 'appearance', v), icon, formatBytes, io: themeIo,
    current: () => { const x = getSettings(); return { theme: themeById(x.theme).id, mode: document.documentElement.dataset.ui === 'light' ? 'light' : 'dark', darkTone: x.darkTone }; },
    // (A theme with colours of its own brings them — a theme of the reader's, as it was saved.)
    choose: (id) => { const n = themeById(id); useTheme(id, !(n.custom && n.followsAccent)); rerender(); },
    sheet: (title) => { const x = openSheet(title, t('close')); return { body: x.body, close: x.close }; },
    toast: (m, k, action, ms) => toast(m, k ?? 'info', ms ?? 4200, action),
    mine: { customise: (id) => void editor().then((m) => { m.myThemes(myStore); m.customise(ed, id); }), menu: (id) => void editor().then((m) => { m.myThemes(myStore); m.mineMenu(ed, id); }), importTheme: () => void editor().then((m) => { m.myThemes(myStore); return m.importFile(ed); }) },
    mineLoader: async (id) => { const { minePictureUrls, loadMine } = await import('../theme/custom'); const my = loadMine(myStore).find((x) => x.id === id); return my ? minePictureUrls(myStore.io, my) : {}; },
  });
  const blurNow = { full: t('glassBlurFull'), reduced: t('glassBlurReduced'), off: t('glassBlurOff') }[glassNow.blur];
  const why = { chosen: '', platform: t(pc ? 'glassWhyPc' : 'glassWhyPhone'), memory: t('glassWhyMemory'), transparency: t('glassWhyTransparency'), motion: t('glassWhyMotion'), battery: t('glassWhyBattery') }[glassNow.why];
  const glassHint = def.classic ? t('glassClassicHint') : (s.glassBlur ?? 'auto') === 'auto' ? t('glassAutoNow', { what: blurNow, why }) : t('glassBlurHint');
  const swatches = h('div', { class: 'accent-swatches' },
    ownColours ? h('button', { type: 'button', class: 'swatch theme' + (s.accent === 'theme' ? ' on' : ''), 'data-accent': 'theme', 'aria-label': t('accentTheme'), title: t('accentTheme'), style: { '--sw': (def.dark ?? def.light)!.roles!.primary } }) : null,
    ...ACCENTS.map((a) => h('button', { type: 'button', class: 'swatch' + (s.accent === a ? ' on' : ''), 'data-accent': a, 'aria-label': a, onclick: () => { updateSettings({ accent: a }); rerender(); } })),
    h('label', { class: 'swatch custom' + (s.accent === 'custom' ? ' on' : ''), title: 'custom' }, h('input', { type: 'color', value: s.accentCustom, oninput: (e: Event) => updateSettings({ accent: 'custom', accentCustom: (e.target as HTMLInputElement).value }) })));
  const themeSwatch = swatches.querySelector<HTMLElement>('.swatch.theme'); if (themeSwatch) themeSwatch.onclick = () => { updateSettings({ accent: 'theme', accentPrev: getSettings().accent === 'theme' ? getSettings().accentPrev : getSettings().accent }); rerender(); };
  const followsTone = def.classic || !!def.followsAccent && !def.force && !def.dark?.surfaces;
  return h('section', { class: 'card', id: 'appearance' }, h('h3', null, t('appearance')),
    h('p', { class: 'hint' }, t('themeGalleryHint')),
    gallery,
    def.classic ? null : row(t('glassBlur'), pickButton(t('glassBlur'), [['auto', t('glassBlurAuto')], ['full', t('glassBlurFull'), t('glassBlurFullHint')], ['reduced', t('glassBlurReduced'), t('glassBlurReducedHint')], ['off', t('glassBlurOff'), t('glassBlurOffHint')]], (s.glassBlur ?? 'auto') as BlurPref, (v) => { updateSettings({ glassBlur: v }); rerender(); }, t('close')), glassHint),
    !def.classic && !pc ? toggle(t('glassBattery'), s.glassBattery !== false, (v) => { updateSettings({ glassBattery: v }); rerender(); }, t('glassBatteryHint')) : null,
    !def.classic && pc ? toggle(t('glassRail'), s.glassRail !== false, (v) => updateSettings({ glassRail: v }), t('glassRailHint')) : null,
    def.force ? row(t('uiMode'), h('span', { class: 'src' }, t(def.force === 'dark' ? 'themeDarkOnly' : 'themeLightOnly'))) : row(t('uiMode'), pickButton(t('uiMode'), [['system', t('uiSystem')], ['light', t('uiLight')], ['dark', t('uiDark')]], s.uiMode, (v) => { updateSettings({ uiMode: v as UiMode }); rerender(); }, t('close'))),
    followsTone ? row(t('darkTone'), pickButton(t('darkTone'), [['default', t('darkToneDefault')], ['grey', t('darkToneGrey')], ['black', t('darkToneBlack')]], s.darkTone, (v) => { updateSettings({ darkTone: v as DarkTone }); rerender(); }, t('close'))) : null,
    row(t('accent'), swatches, ownColours ? t('accentThemeHint') : undefined),
    h('div', { class: 'row' }, h('span', null, t('appearanceReset'), h('small', { class: 'src' }, t('appearanceResetHint'))), h('button', { type: 'button', class: 'btn text small', onclick: () => {
      const cur = getSettings(); const before = Object.fromEntries(RESET_KEYS.map((k) => [k, cur[k]])) as Partial<Settings>;
      updateSettings({ theme: 'frost', glassBlur: 'auto', accent: 'graphite', accentCustom: '#7fb8ff', accentPrev: undefined, darkTone: 'default', uiMode: 'dark', uiScale: 100, glassRail: undefined, glassBattery: undefined, themeKeepColours: undefined }); reloadThemePictures(); rerender();
      toast(t('appearanceResetDone'), 'info', 6000, { label: t('undo'), run: () => { updateSettings(before); reloadThemePictures(); rerender(); } });
    } }, icon('refresh'), t('appearanceReset'))),
    def.by ? h('div', { class: 'row theme-credit' }, h('span', null, t('themeBy', { who: def.by }), h('small', { class: 'src' }, t('themeLicence'))), h('button', { type: 'button', class: 'btn text small', onclick: () => void import('./licences').then((m) => m.licencesSheet()) }, icon('info'), t('licenses'))) : null);
}
