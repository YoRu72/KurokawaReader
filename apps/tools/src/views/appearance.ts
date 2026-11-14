// Settings → Appearance: the theme gallery (theme/gallery.ts), how much glass is blurred, light or dark, the dark
// tone (for the themes that follow it), the accent; a phone's battery choice, a computer's sidebar choice.
import { h, icon, toast, openSheet, pickButton } from '../ui/dom';
import { t, formatBytes } from '../i18n';
import { getSettings, updateSettings, glassNow, reloadThemePictures, type Accent, type UiMode, type DarkTone } from '../settings';
import { themeById, type BlurPref } from '../theme/themes';
import { themeGallery } from '../theme/gallery';
import { themeIo } from '../themeIo';

const row = (label: string, control: Node, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), control);
const toggle = (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => { const c = h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }); return h('label', { class: 'row switch-row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), c); };
const ACCENTS: Accent[] = ['graphite', 'mono', 'teal', 'aqua', 'mint', 'olive', 'gold', 'sand', 'coral', 'rose', 'violet'];

export function appearanceCard(rerender: () => void): HTMLElement {
  const s = getSettings(); const def = themeById(s.theme);
  const pc = document.documentElement.classList.contains('pc');
  const ownColours = !def.classic && !!(def.dark?.roles || def.light?.roles);
  const gallery = themeGallery({
    t: (k, v) => t(k as 'appearance', v), icon, formatBytes, io: themeIo,
    current: () => { const x = getSettings(); return { theme: themeById(x.theme).id, mode: document.documentElement.dataset.ui === 'light' ? 'light' : 'dark', darkTone: x.darkTone }; },
    choose: (id) => {
      const next = themeById(id); const cur = getSettings();
      const own = !next.classic && !!(next.dark?.roles || next.light?.roles);
      // (A theme with colours of its own brings them; going back to one that follows the accent brings the accent back.)
      const accent: Accent = own ? 'theme' : cur.accent === 'theme' ? (cur.accentPrev ?? 'graphite') : cur.accent;
      updateSettings({ theme: id, accent, accentPrev: own && cur.accent !== 'theme' ? cur.accent : cur.accentPrev });
      reloadThemePictures(); rerender();
    },
    sheet: (title) => { const x = openSheet(title, t('close')); return { body: x.body, close: x.close }; },
    toast: (m, k) => toast(m, k ?? 'info', 4200),
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
    def.by ? h('div', { class: 'row theme-credit' }, h('span', null, t('themeBy', { who: def.by }), h('small', { class: 'src' }, t('themeLicence'))), h('button', { type: 'button', class: 'btn text small', onclick: () => void import('./licences').then((m) => m.licencesSheet()) }, icon('info'), t('licenses'))) : null);
}
