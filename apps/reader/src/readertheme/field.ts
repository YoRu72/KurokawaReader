// Settings → Appearance → «Interface style»: the shared gallery (src/theme/gallery.ts — a card per style drawn from
// its own tokens, the one in use marked, a download button with its size on a style whose pictures are fetched on
// demand, progress, remove with Undo, «Add style» for the repository's list, «My styles» with Customise and Import),
// the shared editor behind Customise (src/theme/editor.ts), the Reader's words, storage, preview and Back handed to
// them; the glass's blur under it (Full, Reduced, Off; left to the device, the one it was given shows, and why); the
// licences.
import READER_CSS from '../styles/reader.lazy.css' with { type: 'text' };
import { ensureStyle } from '../ui/lazycss';
import GALLERY_CSS from '../theme/gallery.css' with { type: 'text' };
import EDITOR_CSS from '../theme/editor.css' with { type: 'text' };
import { themeGallery, themeName, miniature, type GalleryDeps } from '../theme/gallery';
import type { EditorDeps } from '../theme/editor';
import { THEMES, themeById, previewOf, modesOf, type Mode } from '../theme/themes';
import { h, icon, toast, openSheet } from '../ui/dom';
import { onBack } from '../ui/backstack';
import { t, formatBytes } from '../i18n';
import type { Strings } from '../i18n/en';
import { getSettings, updateSettings, isDefault, resetSetting, applySettings, type VisualSettings } from '../settings';
import { readingThemePicker } from '../ui/options';
import { offerOptionsUndo, stepCount } from '../ui/optionsundo';
import { pushUndoScope } from '../ui/undo';
import { pagePatch } from './pagetheme';
import { blurNow, readPacks, setStylePreview } from './index';
import { themeIo, myStore } from './io';

const FIELD_CSS = `.style-field{gap:10px}.style-field>.label{display:flex;align-items:center}.style-field .glass-blur{margin-top:6px}
.style-pair{gap:14px}.pair-preview{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 2px}
.pair-preview figure{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0}.pair-preview figcaption{font-size:12px;color:var(--md-on-surface-dim);text-align:center}
.pair-preview .tg-mini,.pair-page-mini{aspect-ratio:5/4;border-radius:16px;overflow:hidden;box-shadow:inset 0 0 0 1px rgb(127 127 127 / .22)}
.pair-page-mini{display:flex;flex-direction:column;gap:6px;padding:12px 14px;font-family:var(--font-read);text-align:start}.pair-page-mini b{font-size:20px;line-height:1.1;font-weight:600}
.pair-page-mini i{display:block;height:4px;border-radius:2px;background:currentColor;opacity:.85}.pair-page-mini i.l{background:var(--pl);opacity:1;width:40%}
.pair-side{display:flex;flex-direction:column;gap:10px;padding:16px 0 4px;border-top:1px solid var(--md-outline-variant)}
.pair-side>h4{margin:0;font-size:16px;font-weight:650;color:var(--md-on-surface);display:flex;align-items:center;gap:6px}.pair-side>.hint{margin:-6px 0 0}
.pair-side .theme-swatches button{width:44px;height:44px}.pair-switch{display:flex;align-items:center;justify-content:space-between;gap:12px}.pair-switch>span{display:flex;flex-direction:column;gap:2px}
.style-pair .pair-sides{display:flex;flex-direction:column;gap:14px}
html.pc .settings-body.pc-one>.card>.field.style-pair{display:flex;flex-direction:column;border-top:0;padding-top:4px}html.pc .style-pair .pair-preview{max-width:520px;width:100%;align-self:flex-start}`;
let cssIn = false;
const ensureCss = (): void => { if (cssIn) return; cssIn = true; const s = document.createElement('style'); s.id = 'kr-gallery'; s.textContent = `${GALLERY_CSS as string}\n${EDITOR_CSS as string}\n${FIELD_CSS}`; document.head.append(s); };

// The shared gallery's and editor's words, as the Reader says them (its own keys in src/i18n — one string where one
// serves both; «My themes» is the Reader's reading themes, so the styles' own are «My styles»).
const WORDS: Record<string, keyof Strings> = {
  themeGallery: 'styleTitle', themeClassic: 'styleClassic', themeObsidian: 'styleNameObsidian',
  themeBy: 'styleBy', themeBuiltIn: 'styleBuiltIn', themeDarkOnly: 'uiDark', themeLightOnly: 'uiLight',
  themeNeedsDownload: 'styleGet', themeDownload: 'styleGet', themeGet: 'styleGet', themeOnDevice: 'styleOnDevice',
  themeDownloading: 'styleGetting', themeDownloadingShort: 'loading', themeInstalled: 'styleGot', themeRemove: 'delete', themeRemoved: 'styleRemoved',
  themeRetry: 'retry', themeErrOffline: 'styleOffline', themeErrMissing: 'styleFailed', themeErrChecksum: 'styleBadSum', themeErrStorage: 'styleNoSpace', themeErrFormat: 'styleFailed',
  themeAdd: 'styleAdd', themeAddHint: 'styleAddHint', themeAddTitle: 'styleAdd', themeAddLoading: 'loading', themeAddEmpty: 'styleNone',
  themeIndexOffline: 'styleOffline', themeIndexMissing: 'styleFailed', themeHere: 'downloaded', myThemes: 'myStyles',
};
const say: GalleryDeps['t'] = (key, vars) => {
  const k = (WORDS[key] ?? key) as keyof Strings;
  const v = vars && 'who' in vars ? { ...vars, name: vars.who } : vars;
  return t(k, v);
};
// (The shared module's icons by the Reader's names.)
const ICONS: Record<string, string> = { pencil: 'pen' };
const ic = (n: string): SVGElement => icon(ICONS[n] ?? n);

/** A snackbar with an action (Undo) beside its words; the plain one without. (The app's one snackbar — src/ui/dom.ts
 *  toast, its look src/styles/undo.css —, as every other.) */
function snack(msg: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }, ms?: number): void {
  if (!action) { toast(msg, kind, ms ?? (kind === 'error' ? 5000 : 2600)); return; }
  toast(msg, kind, { action, ms });
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
/** A style file saved: shared on a phone (to a file manager, a chat), downloaded elsewhere. */
async function saveText(name: string, text: string): Promise<string | null> {
  const { shareFile, downloadBlob } = await import('../ui/share');
  const blob = new Blob([text], { type: 'text/plain' });
  try { if (/android|iphone|ipad/i.test(navigator.userAgent) && (window as unknown as { Capacitor?: unknown }).Capacitor) { await shareFile(blob, name); return name; } downloadBlob(blob, name); return name; } catch { return null; }
}
const tone = () => { const d = getSettings().darkTone; return d === 'grey' ? 'grey' : d === 'black' ? 'black' : 'default'; };

const modeNow = (): Mode => (document.documentElement.dataset.ui === 'light' ? 'light' : 'dark');
/** The book page that matches a style, as one change (readertheme/pagetheme.ts). */
function matchPatch(id: string, s: VisualSettings = getSettings()): Partial<VisualSettings> {
  const def = THEMES.find((d) => d.id === id) ?? themeById('classic'); const mode: Mode = def.force ?? modeNow();
  const name = themeName(def, say) + (modesOf(def).length > 1 ? ` · ${t(mode === 'light' ? 'uiLight' : 'uiDark')}` : '');
  return pagePatch(s, def, mode, name);
}
/** A style chosen — from the gallery, the editor, the reset — and, with the page kept matched, its page too: one change,
 *  so one step of Undo. */
export function chooseStyle(id: string): void {
  const s = getSettings();
  updateSettings(s.pageFollowsStyle ? { uiStyle: id, ...matchPatch(id, s) } : { uiStyle: id });
}
/** «Use for the book page too»: the chosen style's page as the reading theme — that alone. */
export function useStyleForPage(): void { const s = getSettings(); updateSettings(matchPatch(s.uiStyle || 'classic', s)); }

/** What the shared style editor needs from the Reader. */
export function editorDeps(rerender: () => void): EditorDeps {
  const pc = () => document.documentElement.classList.contains('pc');
  return {
    t: say, icon: ic, store: myStore, isPc: pc, darkTone: tone,
    mode: () => (document.documentElement.dataset.ui === 'light' ? 'light' : 'dark'),
    blurLimit: () => { const b = blurNow(getSettings()); if (b.blur === 'full') return null; return t('editorBlurLimited', { what: t(b.blur === 'off' ? 'blurOff' : 'blurReduced'), why: b.why === 'chosen' ? t('glassBlur') : b.why === 'transparency' || b.why === 'motion' ? t('blurWhySystem') : t('blurWhyDevice') }); },
    preview: (p) => setStylePreview(p),
    use: (id) => { chooseStyle(id); rerender(); },
    inUse: () => getSettings().uiStyle,
    choose: (title, actions) => { const x = openSheet(title, t('close')); x.body.append(h('div', { class: 'te-choices' }, ...actions.map((a) => h('button', { type: 'button', class: 'dest-row te-choice' + (a.danger ? ' danger' : ''), onclick: () => { x.close(); a.run(); } }, a.icon ? ic(a.icon) : null, h('span', null, a.label))))); },
    toast: snack, onBack, pickFile, saveText,
    packPictures: async () => {
      const { installed, pictureUrls } = await import('../theme/packs');
      const have = await installed(themeIo); const out: { id: string; asset: string; label: string; url: string }[] = [];
      for (const rec of Object.values(have)) { const urls = await pictureUrls(themeIo, rec.id); for (const a of rec.assets) if (urls[a]) out.push({ id: rec.id, asset: a, label: `${rec.name ?? rec.id} · ${a === 'bg-dark' ? t('uiDark') : a === 'bg-light' ? t('uiLight') : a}`, url: urls[a] }); }
      return out;
    },
    changed: () => rerender(),
    // (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y on a computer: the editor's own history first while it is open — a scope of the
    // app's one undo handler, src/ui/undo.ts —, so neither takes the other's keys; never while a text field has them.)
    keys: (handler) => pushUndoScope({ undo: () => handler('undo'), redo: () => handler('redo') }),
  };
}

/** The «Interface style» field. `after`: the section drawn again (a choice made). */
export function styleField(after: () => void, bare = false): HTMLElement {
  ensureCss();
  void readPacks();
  const cur = getSettings();
  const reset = (key: keyof VisualSettings) => (!isDefault(key) ? h('button', { type: 'button', class: 'reset-one', title: t('resetThis'), 'aria-label': t('resetThis'), onclick: () => { if (key === 'uiStyle') chooseStyle('classic'); else resetSetting(key); after(); } }, icon('undo')) : null);
  const ed = editorDeps(after);
  const editor = () => import('../theme/editor').then((m) => { m.myThemes(myStore); return m; });
  const grid = themeGallery({
    t: say, icon: ic, formatBytes, io: themeIo,
    current: () => { const s = getSettings(); return { theme: s.uiStyle || 'classic', mode: (document.documentElement.dataset.ui === 'light' ? 'light' : 'dark') as Mode, darkTone: tone() }; },
    choose: (id) => { chooseStyle(id); after(); },
    sheet: (title) => { const s = openSheet(title, t('close')); return { body: s.body, close: s.close }; },
    toast: snack,
    mine: { customise: (id) => void editor().then((m) => m.customise(ed, id)), menu: (id) => void editor().then((m) => m.mineMenu(ed, id)), importTheme: () => void editor().then((m) => m.importFile(ed)) },
    mineLoader: async (id) => { const { minePictureUrls, loadMine } = await import('../theme/custom'); const my = loadMine(myStore).find((x) => x.id === id); return my ? minePictureUrls(myStore.io, my) : {}; },
  });
  const box = h('div', { class: 'field style-field' }, bare ? null : h('span', { class: 'label' }, t('styleTitle'), reset('uiStyle')), bare ? null : h('p', { class: 'hint' }, t('styleHint')), grid);
  (box as HTMLElement & { reset?: HTMLElement | null }).reset = bare ? reset('uiStyle') : null;
  if (cur.uiStyle !== 'classic' && THEMES.some((d) => d.id === cur.uiStyle && !d.classic)) {
    const b = blurNow(cur);
    const why = b.why === 'chosen' ? null : b.why === 'transparency' || b.why === 'motion' ? t('blurAutoSystem') : b.blur === 'full' ? null : t('blurAutoMemory');
    box.append(h('div', { class: 'field glass-blur' }, h('span', { class: 'label' }, t('glassBlur'), reset('glassBlur')),
      h('div', { class: 'segmented' }, ...([['full', t('blurFull')], ['reduced', t('blurReduced')], ['off', t('blurOff')]] as ['full' | 'reduced' | 'off', string][]).map(([v, label]) =>
        h('button', { type: 'button', 'data-blur': v, 'aria-pressed': String(b.blur === v), onclick: () => { updateSettings({ glassBlur: v }); after(); } }, label))),
      why ? h('p', { class: 'hint' }, why) : null));
  }
  return box;
}

/** The page in force now, as the reader would show it (the night theme in its hours included): its colours. */
function pageColours(): { bg: string; fg: string; link: string } {
  ensureStyle('kr-reader-css', READER_CSS as string); // (the probe is read through the reading screen's rules)
  const probe = h('div', { class: 'reader', style: { position: 'absolute', visibility: 'hidden', width: '1px', height: '1px' } });
  document.body.append(probe); applySettings(probe, getSettings());
  const cs = getComputedStyle(probe); const out = { bg: cs.backgroundColor, fg: cs.color, link: cs.getPropertyValue('--r-link-override').trim() || cs.getPropertyValue('--r-link').trim() };
  probe.remove(); return out;
}
const sw = (label: string, on: boolean, set: (v: boolean) => void, cls: string, hint?: string): HTMLElement => {
  const c = h('input', { type: 'checkbox', class: cls, onchange: () => set(c.checked) }) as HTMLInputElement; c.checked = on;
  return h('label', { class: 'pair-switch' }, h('span', null, label, hint ? h('small', { class: 'hint' }, hint) : null), h('span', { class: 'switch' }, c, h('i')));
};
/** Settings → Appearance: the two looks as a pair, of equal weight — «App interface» (the style: library, bars, menus,
 *  settings) and «Book page» (the reading theme: page and text) —, a live miniature of both together, and the ways to
 *  join them: the style's own page for the book («Use for the book page too», or kept matched), the interface kept
 *  matched to the page («Follow the page»). Either can be chosen alone; both can be had. */
export function pairField(after: () => void): HTMLElement {
  ensureCss();
  const s = getSettings(); const html = document.documentElement;
  const def = THEMES.find((d) => d.id === s.uiStyle) ?? themeById('classic'); const mode = def.force ?? modeNow();
  const pv = previewOf(def, mode, tone()); const page = pageColours();
  const preview = h('div', { class: 'pair-preview', role: 'img', 'aria-label': t('pairBoth') },
    h('figure', null, miniature(pv), h('figcaption', null, t('pairApp'))),
    h('figure', null, (() => { const m = h('div', { class: 'pair-page-mini', style: { background: page.bg, color: page.fg } }, h('b', null, 'Aa'), h('i'), h('i'), h('i', { class: 'l' }), h('i'), h('i', { style: { width: '70%' } })); m.style.setProperty('--pl', page.link || page.fg); return m; })(), h('figcaption', null, t('pairPage'))));
  const style = styleField(after, true);
  const app = h('section', { class: 'pair-side pair-app' }, h('h4', null, t('pairApp'), (style as HTMLElement & { reset?: HTMLElement | null }).reset ?? null), h('p', { class: 'hint' }, t('pairAppHint')), style,
    h('div', { class: 'sg-actions' }, h('button', { type: 'button', class: 'btn tonal small pair-use', onclick: () => { const n = stepCount(); useStyleForPage(); after(); offerOptionsUndo(t('pairUsed', { name: themeName(def, say) }), after, n); } }, icon('library'), t('pairUseForPage'))),
    // (Linked: the page matched now and kept so — one change, so one step of Undo.)
    sw(t('pairLinked'), s.pageFollowsStyle, (v) => { updateSettings(v ? { pageFollowsStyle: true, ...matchPatch(s.uiStyle || 'classic') } : { pageFollowsStyle: false }); after(); }, 'pair-linked', t('pairLinkedHint')));
  const pageSide = h('section', { class: 'pair-side pair-page' }, h('h4', null, t('pairPage')), h('p', { class: 'hint' }, t('pairPageHint')), ...readingThemePicker(after),
    sw(t('pairFollowPage'), s.uiMode === 'page', (v) => { updateSettings({ uiMode: v ? 'page' : html.dataset.ui === 'light' ? 'light' : 'dark' }); after(); }, 'pair-follow', t('pairFollowHint')));
  return h('div', { class: 'field style-pair' }, preview, h('div', { class: 'pair-sides' }, app, pageSide));
}

/** Settings → About → Licences: the notices of what the app carries from others (the ported styles'; a pack's own), in
 *  full, as their licences ask. */
export function licencesSheet(): void {
  const { body } = openSheet(t('licences'), t('close'));
  const seen = new Map<string, string[]>();
  for (const d of THEMES) if (d.notice) seen.set(d.notice, [...(seen.get(d.notice) ?? []), themeName(d, say)]);
  for (const [notice, names] of seen) body.append(h('section', { class: 'licence' }, h('h4', null, names.join(', ')), h('pre', { class: 'licence-text', dir: 'ltr', style: { whiteSpace: 'pre-wrap', fontSize: '12px', lineHeight: '1.5' } }, notice)));
}
