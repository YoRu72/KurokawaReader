// Settings → Appearance: the theme gallery (theme/gallery.ts), how much glass is blurred, light or dark, the dark
// tone (for the themes that follow it), the accent; a phone's battery choice, a computer's sidebar choice.
import { h, icon, toast, openSheet, pickButton } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { getSettings, updateSettings, glassNow, reloadThemePictures, setThemePreview, type Accent, type UiMode, type DarkTone, type Settings } from '../settings';
import { onBack } from '../ui/backstack';
import { undoScope } from '../ui/undo';
import { saveText } from '../native';
import { myStore } from '../myStore';
import type { EditorDeps } from '../theme/editor';
import { themeById, DEFAULT_THEME, type BlurPref } from '../theme/themes';
import { themeGallery } from '../theme/gallery';
import { themeIo } from '../themeIo';
import { SCENE_GROUPS, MIX_GROUPS, sceneEntry, type SceneGroup } from '../theme/sceneList';

const row = (label: string, control: Node, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), control);
const toggle = (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => { const c = h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }); return h('label', { class: 'row switch-row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), c); };
const ACCENTS: Accent[] = ['graphite', 'mono', 'teal', 'aqua', 'mint', 'olive', 'gold', 'sand', 'coral', 'rose', 'violet'];

/** A theme put in use: its own colours brought (or the accent given back), its pictures read. */
function useTheme(id: string, own: boolean): void {
  const cur = getSettings(); const next = themeById(id);
  const hasRoles = !next.classic && !!(next.dark?.roles || next.light?.roles);
  const takeOwn = own && hasRoles;
  const accent: Accent = takeOwn ? 'theme' : cur.accent === 'theme' ? (cur.accentPrev ?? 'graphite') : cur.accent;
  updateSettings({ theme: id, themeChosen: true, accent, accentPrev: takeOwn && cur.accent !== 'theme' ? cur.accent : cur.accentPrev });
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
    onBack: (fn) => onBack(fn, 'editor', 'theme editor'), pickFile, saveText: (n, txt) => saveText(n, txt, 'text/plain'),
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
const RESET_KEYS = ['theme', 'themeChosen', 'glassBlur', 'accent', 'accentCustom', 'accentPrev', 'darkTone', 'uiMode', 'uiScale', 'glassRail', 'glassBattery', 'themeKeepColours', 'animBg', 'animBgLevel', 'animBgWhere', 'animBgTint', 'animBgReact'] as const;
type AnimPref = NonNullable<Settings['animBg']>; type AnimLevel = NonNullable<Settings['animBgLevel']>;
/** «Your pictures and videos» chosen in the row while none of them is the background yet: the library shown. */
let libShown = false;
/** A computer's animated background: the choice, how much it moves, a live preview and one line saying what it does
 *  now and why (paused, still). Its engine (theme/animbg.ts) is fetched only once it is chosen. */
function animRows(rerender: () => void): (HTMLElement | null)[] {
  const s = getSettings(); const pref: AnimPref = s.animBg ?? 'off';
  // (The hint says what the choice made does; a pick's third value would be an icon, so the words go here.)
  // («Motes», «Night snowfall»: scenes of the Rust engine — core/kt-scene, loaded as wasm only when chosen; drift where it cannot load.)
  // (The scenes are many: the row offers «Scene», and the grid below it shows them all, grouped, as pictures.)
  // («Your pictures and videos»: «scene:user:<id>», drawn by the same engine path — views/bgLibrary.ts, theme/bgLib.ts.)
  const isUser = pref.startsWith('scene:user:'); const mine = isUser || libShown; if (isUser) libShown = false;
  const isSceneNow = pref.startsWith('scene:') && !isUser; const entry = isSceneNow ? sceneEntry(pref.slice(6)) : undefined;
  type Choice = 'off' | 'match' | 'drift' | 'flow' | 'scene' | 'mine';
  const what = mine ? t('animBgMineHint') : entry ? t(entry.hint as 'animBgHint') : isSceneNow && pref.startsWith('scene:mix:') ? t('mixMineHint') : ({ off: t('animBgHint'), match: t('animBgMatchHint'), drift: t('animBgDriftHint'), flow: t('animBgFlowHint') } as Record<string, string>)[pref] ?? t('animBgHint');
  const choice = row(t('animBg'), pickButton<Choice>(t('animBg'), [['off', t('animBgOff')], ['match', t('animBgMatch')], ['drift', t('animBgDrift')], ['flow', t('animBgFlow')], ['scene', t('animBgScenes')], ['mine', t('animBgMine')]], mine ? 'mine' : isSceneNow ? 'scene' : (pref as Choice), (v) => {
    libShown = v === 'mine';
    if (v !== 'mine') updateSettings({ animBg: v === 'scene' ? (isSceneNow ? pref : 'scene:night-snowfall') : v });
    rerender();
  }, t('close')), what);
  // (The library: drawn once its module is here — the row keeps its place meanwhile.)
  const lib = mine ? h('div', { class: 'row abg-grid-row', 'data-bg-lib': '' }) : null;
  if (lib) void import('./bgLibrary').then((m) => { if (lib.isConnected) m.fillLibrary(lib, rerender); });
  if (pref === 'off' || (mine && !isUser)) return [choice, lib];
  const grid = isSceneNow ? sceneGrid(pref.slice(6), rerender) : lib;
  const level: AnimLevel = s.animBgLevel ?? 'full';
  const levelRow = row(t('animBgLevel'), pickButton(t('animBgLevel'), [['full', t('animBgFull')], ['reduced', t('animBgReduced')], ['still', t('animBgStill')]], level, (v) => { updateSettings({ animBgLevel: v as AnimLevel }); rerender(); }, t('close')), level === 'full' ? t('animBgHint') : t(level === 'reduced' ? 'animBgReducedHint' : 'animBgStillHint'));
  // (A scene: where it shows, whether the app's colours follow it, how much it answers the mouse.)
  const scene = pref.startsWith('scene:');
  const where = s.animBgWhere ?? 'whole'; const react = s.animBgReact ?? 'subtle';
  const sceneRows = scene ? [
    row(t('animBgWhereRow'), pickButton(t('animBgWhereRow'), [['whole', t('animBgWhole')], ['content', t('animBgContent')]], where, (v) => { updateSettings({ animBgWhere: v as 'whole' | 'content' }); rerender(); }, t('close')), t('animBgWhereHint')),
    toggle(t('animBgTintRow'), s.animBgTint === true, (v) => { updateSettings({ animBgTint: v }); rerender(); }, t('animBgTintHint')),
    isUser ? null : row(t('animBgReactRow'), pickButton(t('animBgReactRow'), [['off', t('animBgReactOff')], ['subtle', t('animBgReactSubtle')], ['lively', t('animBgReactLively')]], react, (v) => { updateSettings({ animBgReact: v as 'off' | 'subtle' | 'lively' }); rerender(); }, t('close')), t('animBgReactHint')),
  ] : [];
  const box = h('div', { class: 'abg-preview', role: 'img', 'aria-label': t('animBgPreview') }, h('div', { class: 'abg-sample' }, h('b', null, t('animBgSample')), h('small', null, t('animBgSampleDim'))));
  const now = h('small', { class: 'src abg-now', 'aria-live': 'polite' });
  void import('../theme/animbg').then((m) => {
    if (!box.isConnected) return;
    const html = document.documentElement; const kind = m.kindFor(pref, html.dataset.theme, html.dataset.anim);
    if (!kind) { box.hidden = true; now.textContent = t('animBgNone'); return; }
    const stop = m.previewAnimBg(box, kind);
    const say = (): void => {
      if (!now.isConnected) { off(); stop(); return; }
      const st = m.animState(); const lv = getSettings().animBgLevel ?? 'full';
      now.textContent = st.fallback ? t('animBgSceneFallback') : st.paused ? t(({ hidden: 'animBgPausedHidden', focus: 'animBgPausedFocus', video: 'animBgPausedVideo', fullscreen: 'animBgPausedFull' } as const)[st.paused])
        : lv === 'still' ? t('animBgStillChosen') : st.still ? t(({ motion: 'animBgStillMotion', battery: 'animBgStillBattery', slow: 'animBgStillSlow' } as const)[st.still])
        : t(lv === 'reduced' ? 'animBgMovingReduced' : 'animBgMoving');
    };
    const off = m.watchAnim(say); say();
  });
  return [choice, grid, levelRow, ...sceneRows, h('div', { class: 'row abg-row' }, box, now)];
}

/** The scenes as a grid of pictures, grouped; each drawn once by the engine (theme/sceneThumbs.ts) and kept. A radio
 *  group: the chosen one marked, Tab reaches it, the arrow keys move between them. */
function sceneGrid(current: string, rerender: () => void): HTMLElement {
  const tiles: HTMLButtonElement[] = [];
  const pick = (id: string): void => { updateSettings({ animBg: `scene:${id}` }); rerender(); };
  const tile = (id: string, name: string, hint: string): HTMLButtonElement => {
    const on = id === current;
    const b = h('button', { type: 'button', class: 'abg-tile' + (on ? ' on' : ''), role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', 'data-scene': id, title: hint, onclick: () => pick(id) },
      h('span', { class: 'abg-thumb' }), h('span', { class: 'abg-name', dir: 'auto' }, name)) as HTMLButtonElement;
    tiles.push(b); return b;
  };
  const group = (gr: SceneGroup) => h('div', { class: 'abg-group' }, h('div', { class: 'abg-group-title' }, t(gr.key as 'animBg')),
    h('div', { class: 'abg-tiles' }, ...gr.scenes.map((sc) => tile(sc.id, t(sc.name as 'animBg'), t(sc.hint as 'animBg')))));
  // (The reader's own mixes: «Mix your own» first, then each saved one — read, cleaned, once the mixer's module is here.)
  const mineTitle = h('div', { class: 'abg-group-title' }, t('animBgGroupMine'));
  const mixer = () => import('./mixer');
  const newCard = h('button', { type: 'button', class: 'abg-tile abg-mix-new', 'data-mix-new': '', title: t('mixNewHint'), onclick: () => void mixer().then((x) => x.openMixer(rerender)) },
    h('span', { class: 'abg-thumb abg-plus' }, icon('plus')), h('span', { class: 'abg-name' }, t('mixNew')));
  const mineTiles = h('div', { class: 'abg-tiles' }, newCard);
  const mineActs = h('div', { class: 'abg-mix-acts', hidden: true });
  const groups = [...SCENE_GROUPS.map(group), ...MIX_GROUPS.map(group), h('div', { class: 'abg-group abg-mine' }, mineTitle, mineTiles, mineActs)];
  const grid = h('div', { class: 'abg-grid', role: 'radiogroup', 'aria-label': t('animBgScenes'), onkeydown: (e: KeyboardEvent) => {
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement); if (i < 0) return;
    const rtl = document.documentElement.dir === 'rtl'; const fwd = ['ArrowDown', rtl ? 'ArrowLeft' : 'ArrowRight']; const back = ['ArrowUp', rtl ? 'ArrowRight' : 'ArrowLeft'];
    const j = fwd.includes(e.key) ? (i + 1) % tiles.length : back.includes(e.key) ? (i - 1 + tiles.length) % tiles.length : e.key === 'Home' ? 0 : e.key === 'End' ? tiles.length - 1 : -1;
    if (j < 0) return; e.preventDefault(); tiles[i].tabIndex = -1; tiles[j].tabIndex = 0; tiles[j].focus();
  } }, ...groups);
  if (!tiles.some((b) => b.tabIndex === 0) && tiles[0]) tiles[0].tabIndex = 0;
  // (The pictures: drawn one after another once the grid is on the page — the saved mixes' tiles added first.)
  void Promise.all([import('../theme/sceneThumbs'), import('../theme/sceneMix')]).then(async ([m, mx]) => {
    const mine = mx.savedMixes();
    mineTitle.textContent = mine.length ? t('animBgGroupMineN', { n: localDigits(mine.length) }) : t('animBgGroupMine');
    for (const x of mine) mineTiles.append(tile(`mix:${x.id}`, x.name, t('mixMineHint')));
    // (The chosen one a saved mix: what can be done with it, under the group.)
    const cur = current.startsWith('mix:') ? mine.find((x) => `mix:${x.id}` === current) : undefined;
    if (cur) {
      const act = (ic: string, label: string, run: () => void, cls = '') => h('button', { type: 'button', class: 'btn tonal small' + cls, onclick: run }, icon(ic), label);
      mineActs.append(act('pen', t('mixEdit'), () => void mixer().then((x) => x.openMixer(rerender, cur))), act('type', t('mixRename'), () => void mixer().then((x) => x.renameMix(cur.id, rerender))), act('trash', t('mixDelete'), () => void mixer().then((x) => x.deleteMix(cur.id, rerender)), ' danger'));
      mineActs.hidden = false;
    }
    if (!tiles.some((b) => b.tabIndex === 0) && tiles[0]) tiles[0].tabIndex = 0;
    await new Promise((r) => requestAnimationFrame(r));
    for (const b of tiles) {
      if (!grid.isConnected) break;
      const url = await m.sceneThumb(b.dataset.scene!); const th = b.querySelector<HTMLElement>('.abg-thumb'); if (!th) continue;
      th.style.backgroundImage = url.startsWith('gradient:') ? url.slice(9) : `url("${url}")`; th.classList.add('drawn');
    }
  });
  return h('div', { class: 'row abg-grid-row' }, grid);
}

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
    ...(pc ? animRows(rerender) : []),
    def.force ? row(t('uiMode'), h('span', { class: 'src' }, t(def.force === 'dark' ? 'themeDarkOnly' : 'themeLightOnly'))) : row(t('uiMode'), pickButton(t('uiMode'), [['system', t('uiSystem')], ['light', t('uiLight')], ['dark', t('uiDark')]], s.uiMode, (v) => { updateSettings({ uiMode: v as UiMode }); rerender(); }, t('close')), t('uiModeHint')),
    followsTone ? row(t('darkTone'), pickButton(t('darkTone'), [['default', t('darkToneDefault')], ['grey', t('darkToneGrey')], ['black', t('darkToneBlack')]], s.darkTone, (v) => { updateSettings({ darkTone: v as DarkTone }); rerender(); }, t('close'))) : null,
    row(t('accent'), swatches, ownColours ? t('accentThemeHint') : undefined),
    h('div', { class: 'row' }, h('span', null, t('appearanceReset'), h('small', { class: 'src' }, t('appearanceResetHint'))), h('button', { type: 'button', class: 'btn text small', onclick: () => {
      const cur = getSettings(); const before = Object.fromEntries(RESET_KEYS.map((k) => [k, cur[k]])) as Partial<Settings>;
      updateSettings({ theme: DEFAULT_THEME, themeChosen: undefined, glassBlur: 'auto', accent: 'graphite', accentCustom: '#7fb8ff', accentPrev: undefined, darkTone: 'default', uiMode: 'system', uiScale: 100, glassRail: undefined, glassBattery: undefined, themeKeepColours: undefined, animBg: undefined, animBgLevel: undefined, animBgWhere: undefined, animBgTint: undefined, animBgReact: undefined }); reloadThemePictures(); rerender();
      toast(t('appearanceResetDone'), 'info', 6000, { label: t('undo'), run: () => { updateSettings(before); reloadThemePictures(); rerender(); } });
    } }, icon('refresh'), t('appearanceReset'))),
    def.by ? h('div', { class: 'row theme-credit' }, h('span', null, t('themeBy', { who: def.by }), h('small', { class: 'src' }, t('themeLicence'))), h('button', { type: 'button', class: 'btn text small', onclick: () => void import('./licences').then((m) => m.licencesSheet()) }, icon('info'), t('licenses'))) : null);
}
