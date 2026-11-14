// Settings → Appearance → «Interface style»: the shared gallery (src/theme/gallery.ts — a card per style drawn from
// its own tokens, the one in use marked, a download button with its size on a style whose pictures are fetched on
// demand, progress, remove with Undo, «Add style» for the repository's list, «My styles» with Customise and Import),
// the shared editor behind Customise (src/theme/editor.ts), the Reader's words, storage, preview and Back handed to
// them; the glass's blur under it (Full, Reduced, Off; left to the device, the one it was given shows, and why); the
// licences.
import GALLERY_CSS from '../theme/gallery.css';
import EDITOR_CSS from '../theme/editor.css';
import { themeGallery, themeName, type GalleryDeps } from '../theme/gallery';
import type { EditorDeps } from '../theme/editor';
import { THEMES, type Mode } from '../theme/themes';
import { h, icon, toast, openSheet } from '../ui/dom';
import { onBack } from '../ui/backstack';
import { t, formatBytes } from '../i18n';
import type { Strings } from '../i18n/en';
import { getSettings, updateSettings, isDefault, resetSetting, type VisualSettings } from '../settings';
import { blurNow, readPacks, setStylePreview } from './index';
import { themeIo, myStore } from './io';

const FIELD_CSS = `.style-field{gap:10px}.style-field>.label{display:flex;align-items:center}.style-field .glass-blur{margin-top:6px}`;
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

/** A snackbar with an action (Undo) beside its words; the plain one without. */
function snack(msg: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }, ms?: number): void {
  if (!action) { toast(msg, kind, ms ?? (kind === 'error' ? 5000 : 2600)); return; }
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const el = h('div', { class: 'toast' + (kind === 'error' ? ' error' : ''), role: 'status', style: { display: 'flex', alignItems: 'center', gap: '14px' } }, h('span', null, msg),
    h('button', { type: 'button', class: 'btn text small toast-act', style: { color: 'inherit', fontWeight: '700' }, onclick: () => { el.remove(); action.run(); } }, action.label));
  document.body.append(el); setTimeout(() => el.remove(), ms ?? 6000);
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

/** What the shared style editor needs from the Reader. */
export function editorDeps(rerender: () => void): EditorDeps {
  const pc = () => document.documentElement.classList.contains('pc');
  return {
    t: say, icon: ic, store: myStore, isPc: pc, darkTone: tone,
    mode: () => (document.documentElement.dataset.ui === 'light' ? 'light' : 'dark'),
    blurLimit: () => { const b = blurNow(getSettings()); if (b.blur === 'full') return null; return t('editorBlurLimited', { what: t(b.blur === 'off' ? 'blurOff' : 'blurReduced'), why: b.why === 'chosen' ? t('glassBlur') : b.why === 'transparency' || b.why === 'motion' ? t('blurWhySystem') : t('blurWhyDevice') }); },
    preview: (p) => setStylePreview(p),
    use: (id) => { updateSettings({ uiStyle: id }); rerender(); },
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
  };
}

/** The «Interface style» field. `after`: the section drawn again (a choice made). */
export function styleField(after: () => void): HTMLElement {
  ensureCss();
  void readPacks();
  const cur = getSettings();
  const reset = (key: keyof VisualSettings) => (!isDefault(key) ? h('button', { type: 'button', class: 'reset-one', title: t('resetThis'), 'aria-label': t('resetThis'), onclick: () => { resetSetting(key); after(); } }, icon('undo')) : null);
  const ed = editorDeps(after);
  const editor = () => import('../theme/editor').then((m) => { m.myThemes(myStore); return m; });
  const grid = themeGallery({
    t: say, icon: ic, formatBytes, io: themeIo,
    current: () => { const s = getSettings(); return { theme: s.uiStyle || 'classic', mode: (document.documentElement.dataset.ui === 'light' ? 'light' : 'dark') as Mode, darkTone: tone() }; },
    choose: (id) => { updateSettings({ uiStyle: id }); after(); },
    sheet: (title) => { const s = openSheet(title, t('close')); return { body: s.body, close: s.close }; },
    toast: snack,
    mine: { customise: (id) => void editor().then((m) => m.customise(ed, id)), menu: (id) => void editor().then((m) => m.mineMenu(ed, id)), importTheme: () => void editor().then((m) => m.importFile(ed)) },
    mineLoader: async (id) => { const { minePictureUrls, loadMine } = await import('../theme/custom'); const my = loadMine(myStore).find((x) => x.id === id); return my ? minePictureUrls(myStore.io, my) : {}; },
  });
  const box = h('div', { class: 'field style-field' }, h('span', { class: 'label' }, t('styleTitle'), reset('uiStyle')), h('p', { class: 'hint' }, t('styleHint')), grid);
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

/** Settings → About → Licences: the notices of what the app carries from others (the ported styles'; a pack's own), in
 *  full, as their licences ask. */
export function licencesSheet(): void {
  const { body } = openSheet(t('licences'), t('close'));
  const seen = new Map<string, string[]>();
  for (const d of THEMES) if (d.notice) seen.set(d.notice, [...(seen.get(d.notice) ?? []), themeName(d, say)]);
  for (const [notice, names] of seen) body.append(h('section', { class: 'licence' }, h('h4', null, names.join(', ')), h('pre', { class: 'licence-text', dir: 'ltr', style: { whiteSpace: 'pre-wrap', fontSize: '12px', lineHeight: '1.5' } }, notice)));
}
