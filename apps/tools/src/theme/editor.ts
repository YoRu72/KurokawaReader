// The theme editor and «My themes»: any theme customised with a live preview on the app itself (a glass sheet on a
// phone that can be dragged lower, a side panel on a computer), undo/redo, a contrast guard, saved under a name,
// edited again, duplicated, renamed, deleted (with Undo), passed on as a file. Shared by the Kurokawa apps: the app
// hands in its words, icons, storage, preview and Back (`EditorDeps`).
import { themeById, THEMES, upsertTheme, removeTheme, type ThemeDef, type Mode, type DarkTone } from './themes';
import { fromBase, toDef, sanitise, loadMine, lowestContrast, fixContrast, preparePicture, exportTheme, importTheme, pictureKey, pictureAsset, minePictureUrls, modeFromBase, ThemeFileError, RANGES, usesOwnPicture, type MyTheme, type MyMode, type BgKind, type MyStore } from './custom';
import { History, deferred } from './history';
import { el, themeName } from './gallery';

export interface EditorDeps {
  t(key: string, vars?: Record<string, string | number>): string;
  icon(name: string): SVGElement;
  store: MyStore;
  isPc(): boolean;
  darkTone(): DarkTone;
  /** The mode the app shows now. */
  mode(): Mode;
  /** When the device lowers the blur: a sentence saying so (null when Full is shown). */
  blurLimit(): string | null;
  /** The theme shown live while editing (null: back to the settings' theme). */
  preview(p: { def: ThemeDef; useThemeColours: boolean; pictures: Record<string, string> } | null): void;
  /** The theme put in use (and its accent choice). */
  use(id: string, useThemeColours: boolean): void;
  /** The theme in use now (to know whether a deleted one was it). */
  inUse(): string;
  /** A choice of actions in the app's sheet. */
  choose(title: string, actions: { label: string; icon?: string; danger?: boolean; run: () => void }[]): void;
  toast(msg: string, kind?: 'info' | 'error', action?: { label: string; run: () => void }, ms?: number): void;
  onBack(fn: () => boolean): () => void;
  pickFile(accept: string): Promise<Blob | null>;
  saveText(name: string, text: string): Promise<string | null>;
  /** Pictures of downloaded packs, to use as a background. */
  packPictures(): Promise<{ id: string; asset: string; label: string; url: string }[]>;
  /** Told when «My themes» changed (the gallery redraws). */
  changed(): void;
}

/* ---------- «My themes»: kept, listed, applied ---------- */
let mine: MyTheme[] = [];
let loaded = false;
export function myThemes(store: MyStore): MyTheme[] {
  if (!loaded) { loaded = true; mine = loadMine(store); for (const m of mine) upsertTheme(toDef(m)); }
  return mine;
}
export const myTheme = (id: string): MyTheme | undefined => mine.find((m) => m.id === id);
function persist(store: MyStore): void { store.save(mine); }
async function storePictures(store: MyStore, my: MyTheme, pics: Partial<Record<Mode, Blob | null>>): Promise<void> {
  for (const m of ['dark', 'light'] as Mode[]) {
    if (my[m]?.bg.kind === 'picture' && pics[m]) await store.io.putFile(pictureKey(my.id, m), pics[m]!);
    else if (my[m]?.bg.kind !== 'picture') await store.io.deleteFile(pictureKey(my.id, m)).catch(() => undefined);
  }
}
export async function saveMine(store: MyStore, my: MyTheme, pics: Partial<Record<Mode, Blob | null>>): Promise<void> {
  myThemes(store); const clean = sanitise(JSON.parse(JSON.stringify(my)));
  await storePictures(store, clean, pics);
  const i = mine.findIndex((m) => m.id === clean.id); if (i >= 0) mine[i] = clean; else mine.push(clean);
  persist(store); upsertTheme(toDef(clean));
}
export async function minePictures(store: MyStore, id: string): Promise<Record<string, string>> { const my = myTheme(id); return my ? minePictureUrls(store.io, my) : {}; }
async function blobsOf(store: MyStore, my: MyTheme): Promise<Partial<Record<Mode, Blob>>> {
  const out: Partial<Record<Mode, Blob>> = {}; for (const m of usesOwnPicture(my)) { const b = await store.io.getFile(pictureKey(my.id, m)).catch(() => undefined); if (b) out[m] = b; } return out;
}

/** A saved theme's menu: edit, duplicate, rename, set as the theme, export, delete (with Undo). */
export function mineMenu(d: EditorDeps, id: string): void {
  const my = myTheme(id); if (!my) return;
  d.choose(my.name, [
    { label: d.t('myUse'), icon: 'check', run: () => d.use(my.id, my.accent === 'theme') },
    { label: d.t('myEdit'), icon: 'pencil', run: () => void blobsOf(d.store, my).then((p) => openEditor(d, { my, existing: true, pictures: p })) },
    { label: d.t('myDuplicate'), icon: 'copy', run: () => void duplicate(d, my) },
    { label: d.t('myRename'), icon: 'type', run: () => rename(d, my) },
    { label: d.t('myExport'), icon: 'upload', run: () => void exportFile(d, my) },
    { label: d.t('myDelete'), icon: 'trash', danger: true, run: () => remove(d, my) },
  ]);
}
async function duplicate(d: EditorDeps, my: MyTheme): Promise<void> {
  const copy: MyTheme = { ...JSON.parse(JSON.stringify(my)), id: fromBase(themeById(my.base), d.darkTone(), '').id, name: d.t('myCopyName', { name: my.name }).slice(0, 60), at: Date.now() };
  await saveMine(d.store, copy, await blobsOf(d.store, my)); d.changed(); d.toast(d.t('myDuplicated', { name: copy.name }));
}
function rename(d: EditorDeps, my: MyTheme): void {
  const input = el('input', { type: 'text', class: 'te-name', value: my.name, maxlength: '60', 'aria-label': d.t('myName') }) as HTMLInputElement;
  const box = el('div', { class: 'te-rename' }, input);
  d.choose(d.t('myRename'), [{ label: d.t('save'), icon: 'check', run: () => { const n = input.value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60); if (!n) return; void saveMine(d.store, { ...my, name: n }, {}).then(() => d.changed()); } }]);
  // (The field goes into the sheet the app just opened, above its actions.)
  queueMicrotask(() => { const sheets = document.querySelectorAll('.sheet .sheet-body'); const body = sheets[sheets.length - 1]; if (body) { body.prepend(box); input.focus(); input.select(); } });
}
function remove(d: EditorDeps, my: MyTheme): void {
  // (Gone from the list at once; really deleted only when the snackbar's Undo is over.)
  const at = mine.findIndex((m) => m.id === my.id); if (at < 0) return;
  const wasInUse = d.inUse() === my.id;
  mine.splice(at, 1); removeTheme(my.id); persist(d.store); if (wasInUse) d.use(my.base, my.accent === 'theme'); d.changed();
  const job = deferred(async () => { for (const m of ['dark', 'light'] as Mode[]) await d.store.io.deleteFile(pictureKey(my.id, m)).catch(() => undefined); }, 6000);
  d.toast(d.t('myDeleted', { name: my.name }), 'info', { label: d.t('undo'), run: () => { job.undo(); mine.splice(Math.min(at, mine.length), 0, my); upsertTheme(toDef(my)); persist(d.store); if (wasInUse) d.use(my.id, my.accent === 'theme'); d.changed(); } }, 6000);
}
async function exportFile(d: EditorDeps, my: MyTheme): Promise<void> {
  try { const text = await exportTheme(my, await blobsOf(d.store, my)); const safe = my.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 40) || 'theme'; const p = await d.saveText(`${safe}.ktheme`, text); if (p) d.toast(d.t('myExported', { name: my.name })); }
  catch (e) { d.toast(String((e as Error).message ?? e), 'error'); }
}
/** A theme file chosen by the reader: checked (see custom.ts), added to «My themes». */
export async function importFile(d: EditorDeps): Promise<void> {
  const f = await d.pickFile('.ktheme,application/octet-stream,text/plain'); if (!f) return;
  try {
    const { my, pictures } = await importTheme(new Uint8Array(await f.arrayBuffer()));
    if (!THEMES.some((x) => x.id === my.base && !x.custom)) { my.base = 'frost'; for (const m of ['dark', 'light'] as Mode[]) if (my[m]?.bg.kind === 'theme') my[m]!.bg.kind = 'mesh'; }
    await saveMine(d.store, my, pictures); d.changed(); d.toast(d.t('myImported', { name: my.name }));
  } catch (e) {
    const code = e instanceof ThemeFileError ? e.code : 'format';
    d.toast(d.t(code === 'size' ? 'myImportTooBig' : code === 'picture' ? 'myImportPicture' : 'myImportBad'), 'error', undefined, 6000);
  }
}

/* ---------- the editor ---------- */
type Snap = { my: MyTheme; pics: Partial<Record<Mode, Blob | null>> };
let openNow: { close(force?: boolean): void } | null = null;
export const editorOpen = (): boolean => !!openNow;

export function openEditor(d: EditorDeps, start: { my: MyTheme; existing: boolean; pictures?: Partial<Record<Mode, Blob | null>> }): void {
  openNow?.close(true);
  const t = d.t; const pc = d.isPc();
  const modes = (['dark', 'light'] as Mode[]).filter((m) => start.my[m]);
  let mode: Mode = modes.includes(d.mode()) ? d.mode() : modes[0];
  const clone = (s: Snap): Snap => ({ my: JSON.parse(JSON.stringify(s.my)), pics: { ...s.pics } });
  const hist = new History<Snap>(clone({ my: start.my, pics: { ...(start.pictures ?? {}) } }));
  let saved = JSON.stringify(start.my); let savedPics = { ...(start.pictures ?? {}) };
  let existing = start.existing;
  const base = themeById(start.my.base);
  const baseline = (m: Mode): MyMode => modeFromBase(base, m, d.darkTone());
  const work = (): Snap => hist.current;
  const v = (): MyMode => work().my[mode]!;
  const urls = new Map<Blob, string>(); const urlOf = (b: Blob) => { let u = urls.get(b); if (!u) { u = URL.createObjectURL(b); urls.set(b, u); } return u; };
  let packPics: { id: string; asset: string; label: string; url: string }[] = [];
  void d.packPictures().then((p) => { packPics = p; draw(); });

  let frame = 0;
  const show = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
    const s = work(); const pictures: Record<string, string> = {};
    for (const m of ['dark', 'light'] as Mode[]) { const b = s.pics[m]; if (b) pictures[pictureAsset(s.my.id, m)] = urlOf(b); const pk = s.my[m]?.bg.pack; if (pk) { const hit = packPics.find((x) => x.id === pk.id && x.asset === pk.asset); if (hit) pictures[pk.asset] = hit.url; } }
    const def = { ...toDef(s.my), id: 'my-preview' };
    d.preview({ def, useThemeColours: s.my.accent === 'theme', pictures });
  }); };
  const change = (fn: (s: Snap) => void, key?: string, redraw = false) => { const n = clone(work()); fn(n); hist.push(n, key); show(); if (redraw) draw(); else refresh(); };
  const dirty = () => JSON.stringify(work().my) !== saved || Object.keys(work().pics).some((k) => work().pics[k as Mode] !== savedPics[k as Mode]);

  // The frame: a glass sheet (phone) or side panel (computer), with no scrim — the app shows through, live.
  const undoBtn = el('button', { type: 'button', class: 'icon-btn te-undo', title: `${t('undo')}${pc ? ' (Ctrl+Z)' : ''}`, 'aria-label': t('undo'), onclick: () => step(-1) }, d.icon('undo'));
  const redoBtn = el('button', { type: 'button', class: 'icon-btn te-redo', title: `${t('redo')}${pc ? ' (Ctrl+Shift+Z)' : ''}`, 'aria-label': t('redo'), onclick: () => step(1) }, d.icon('undo'));
  const closeBtn = el('button', { type: 'button', class: 'icon-btn te-close', title: t('close'), 'aria-label': t('close'), onclick: () => close() }, d.icon('close'));
  const handle = el('div', { class: 'te-handle', 'aria-hidden': 'true' });
  const title = el('h2', null, t('editorTitle'));
  const sub = el('small', { class: 'te-sub' });
  const body = el('div', { class: 'te-body' });
  const foot = el('div', { class: 'te-foot' });
  const root = el('aside', { class: 'te-panel panel open' + (pc ? ' pc' : ''), role: 'dialog', 'aria-label': t('editorTitle') }, handle,
    el('div', { class: 'panel-head te-head' }, closeBtn, el('div', { class: 'te-titles' }, title, sub), undoBtn, redoBtn), body, foot);
  document.body.append(root); document.documentElement.classList.add('te-editing');

  // (A phone: the sheet dragged by its handle, lower to see more of the app, or higher.)
  if (!pc) {
    let y0 = 0, h0 = 0;
    const move = (e: PointerEvent) => { const h = Math.max(innerHeight * 0.2, Math.min(innerHeight * 0.9, h0 + (y0 - e.clientY))); root.style.setProperty('--te-h', `${Math.round(h)}px`); };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    handle.addEventListener('pointerdown', (e) => { y0 = e.clientY; h0 = root.getBoundingClientRect().height; addEventListener('pointermove', move); addEventListener('pointerup', up); e.preventDefault(); });
  }
  const keys = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement)?.matches?.('input[type=text]')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); step(-1); } else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); step(1); }
  };
  addEventListener('keydown', keys);
  const offBack = d.onBack(() => { close(); return true; });

  function step(dir: 1 | -1): void { if (dir < 0 ? hist.undo() : hist.redo()) { show(); draw(); } }
  function refresh(): void {
    undoBtn.toggleAttribute('disabled', !hist.canUndo); redoBtn.toggleAttribute('disabled', !hist.canRedo);
    body.querySelectorAll<HTMLElement>('[data-path]').forEach((r) => { const b = r.querySelector<HTMLButtonElement>('.te-reset'); if (b) b.disabled = !differs(r.dataset.path!); });
    paintGuard();
  }
  const get = (path: string, m: MyMode | MyTheme): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], m);
  const set = (path: string, m: MyMode | MyTheme, val: unknown) => { const ks = path.split('.'); const last = ks.pop()!; const o = ks.reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, m as unknown as Record<string, unknown>); o[last] = val; };
  const differs = (path: string): boolean => path === 'radius' ? Math.abs(work().my.radius - (((base.radius?.lg ?? 20) / 20))) > 0.001 : JSON.stringify(get(path, v())) !== JSON.stringify(get(path, baseline(mode)));
  const reset = (path: string) => change((s) => { if (path === 'radius') s.my.radius = +(((base.radius?.lg ?? 20) / 20)).toFixed(2); else set(path, s.my[mode]!, JSON.parse(JSON.stringify(get(path, baseline(mode))))); }, undefined, true);
  // (Always there, dimmed while the value is the theme's own: one place to look, one tap back.)
  const resetBtn = (path: string) => el('button', { type: 'button', class: 'te-reset', title: t('editorReset'), 'aria-label': t('editorReset'), disabled: !differs(path), onclick: () => reset(path) }, d.icon('undo'));

  const slider = (label: string, path: string, range: keyof typeof RANGES, fmt: (n: number) => string, whole = false) => {
    const [lo, hi, st] = RANGES[range]; const cur = Number(get(path, whole ? work().my : v()));
    const val = el('output', { class: 'te-val' }, fmt(cur));
    const input = el('input', { type: 'range', min: String(lo), max: String(hi), step: String(st), value: String(cur), 'aria-label': label }) as HTMLInputElement;
    const fill = () => input.style.setProperty('--p', `${((Number(input.value) - lo) / (hi - lo)) * 100}%`); fill();
    input.addEventListener('input', () => { const n = Number(input.value); val.textContent = fmt(n); fill(); change((s) => set(path, whole ? s.my : s.my[mode]!, n), `slider:${mode}:${path}`); });
    input.addEventListener('change', () => hist.seal());
    return el('div', { class: 'te-row te-slider', 'data-path': path }, el('div', { class: 'te-row-head' }, el('span', { class: 'te-label' }, label), val, resetBtn(path)), input);
  };
  const colour = (label: string, path: string) => {
    const cur = String(get(path, v())).slice(0, 7);
    const input = el('input', { type: 'color', value: cur, 'aria-label': label }) as HTMLInputElement;
    const hex = el('span', { class: 'te-hex', dir: 'ltr' }, cur);
    const sw = el('label', { class: 'te-swatch', style: { '--c': cur } }, input);
    input.addEventListener('input', () => { sw.style.setProperty('--c', input.value); hex.textContent = input.value; change((s) => set(path, s.my[mode]!, input.value), `colour:${mode}:${path}`); });
    input.addEventListener('change', () => hist.seal());
    return el('div', { class: 'te-row te-colour', 'data-path': path }, sw, el('span', { class: 'te-label' }, label), hex, resetBtn(path));
  };
  const seg = <T extends string>(label: string, opts: [T, string][], cur: T, pick: (x: T) => void) => el('div', { class: 'te-row te-segrow' }, el('span', { class: 'te-label' }, label),
    el('div', { class: 'te-seg', role: 'radiogroup', 'aria-label': label }, ...opts.map(([k, l]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(k === cur), class: k === cur ? 'on' : '', onclick: () => { if (k !== cur) pick(k); } }, l))));
  const pct = (n: number) => `${Math.round(n * 100)}%`; const px = (n: number) => `${Math.round(n)} px`; const x2 = (n: number) => `${n.toFixed(2)}×`;

  const guard = el('div', { class: 'te-guard', role: 'status' });
  function paintGuard(): void {
    const low = lowestContrast(work().my, mode, d.darkTone());
    guard.hidden = low >= 4.5;
    if (low < 4.5) guard.replaceChildren(d.icon('alert'), el('span', null, t('editorContrastLow', { ratio: low.toFixed(1) })),
      el('button', { type: 'button', class: 'btn tonal small', onclick: () => { const f = fixContrast(work().my, mode, d.darkTone()); change((s) => { s.my = f; }, undefined, true); } }, t('editorFixContrast')));
  }

  function draw(): void {
    const s = work(); const m = v();
    sub.textContent = t('editorFrom', { base: themeName(base, t) });
    const limit = d.blurLimit();
    const nameIn = el('input', { type: 'text', class: 'te-name', value: s.my.name, maxlength: '60', 'aria-label': t('myName') }) as HTMLInputElement;
    nameIn.addEventListener('input', () => change((x) => { x.my.name = nameIn.value.slice(0, 60); }, 'name'));
    nameIn.addEventListener('change', () => hist.seal());
    const kinds: [BgKind, string][] = [['theme', t('bgTheme')], ['mesh', t('bgMesh')], ['solid', t('bgSolid')], ['picture', t('bgPicture')]];
    if (packPics.length) kinds.push(['pack', t('bgPack')]);
    const bg = m.bg;
    const setKind = (k: BgKind) => change((x) => { const b = x.my[mode]!.bg; b.kind = k; if (k === 'pack' && !b.pack && packPics[0]) b.pack = { id: packPics[0].id, asset: packPics[0].asset }; }, undefined, true);
    const pickPicture = async () => {
      const f = await d.pickFile('image/jpeg,image/png,image/webp'); if (!f) return;
      try { const p = await preparePicture(f); change((x) => { x.pics[mode] = p.blob; const b = x.my[mode]!.bg; b.kind = 'picture'; b.extremes = p.extremes; }, undefined, true); }
      catch { d.toast(t('myImportPicture'), 'error'); }
    };
    body.replaceChildren(...([
      el('div', { class: 'te-row te-namerow' }, el('span', { class: 'te-label' }, t('myName')), nameIn),
      modes.length > 1 ? seg(t('editorMode'), [['dark', t('uiDark')], ['light', t('uiLight')]] as [Mode, string][], mode, (x) => { mode = x; draw(); }) : null,
      limit ? el('p', { class: 'te-note' }, d.icon('info'), el('span', null, limit)) : null,
      guard,
      el('h3', { class: 'te-h' }, t('editorGlass')),
      colour(t('editorTint'), 'tint'),
      slider(t('editorStrength'), 'strength', 'strength', pct),
      slider(t('editorBlur'), 'blur', 'blur', px),
      slider(t('editorSat'), 'sat', 'sat', x2),
      slider(t('editorEdge'), 'edge', 'edge', pct),
      slider(t('editorSheen'), 'sheen', 'sheen', pct),
      el('h3', { class: 'te-h' }, t('editorShape')),
      slider(t('editorRadius'), 'radius', 'radius', x2, true),
      slider(t('editorShadow'), 'shadow', 'shadow', pct),
      el('h3', { class: 'te-h' }, t('editorBackground')),
      el('div', { class: 'te-chips', role: 'radiogroup', 'aria-label': t('editorBackground') }, ...kinds.map(([k, l]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(bg.kind === k), class: 'chip' + (bg.kind === k ? ' on' : ''), onclick: () => setKind(k) }, l))),
      ...(bg.kind === 'mesh' ? [colour(t('editorColour1'), 'bg.colors.0'), colour(t('editorColour2'), 'bg.colors.1'), colour(t('editorColour3'), 'bg.colors.2')] : []),
      ...(bg.kind === 'solid' ? [colour(t('editorColour1'), 'bg.solid')] : []),
      ...(bg.kind === 'picture' ? [
        el('div', { class: 'te-row te-pic' }, s.pics[mode] ? el('img', { class: 'te-thumb', src: urlOf(s.pics[mode]!), alt: '' }) : el('span', { class: 'te-thumb none' }, d.icon('images')),
          el('span', { class: 'te-label' }, s.pics[mode] ? t('editorPictureHere') : t('editorPictureNone')),
          el('button', { type: 'button', class: 'btn tonal small', onclick: () => void pickPicture() }, d.icon('images'), s.pics[mode] ? t('editorPictureChange') : t('editorPictureChoose'))),
        slider(t('editorVeil'), 'bg.veil', 'veil', pct), slider(t('editorPicBlur'), 'bg.picBlur', 'picBlur', px)] : []),
      ...(bg.kind === 'pack' ? [el('div', { class: 'te-chips' }, ...packPics.map((p) => el('button', { type: 'button', class: 'chip' + (bg.pack?.asset === p.asset && bg.pack?.id === p.id ? ' on' : ''), onclick: () => change((x) => { x.my[mode]!.bg.pack = { id: p.id, asset: p.asset }; x.my[mode]!.bg.extremes = undefined; }, undefined, true) }, p.label))),
        slider(t('editorVeil'), 'bg.veil', 'veil', pct), slider(t('editorPicBlur'), 'bg.picBlur', 'picBlur', px)] : []),
      el('h3', { class: 'te-h' }, t('accent')),
      seg(t('accent'), [['app', t('editorAccentApp')], ...(m.roles ? [['theme', t('accentTheme')]] : [])] as ['app' | 'theme', string][], s.my.accent, (x) => change((y) => { y.my.accent = x; }, undefined, true)),
    ] as (Node | null)[]).filter((x): x is Node => !!x));
    foot.replaceChildren(...([
      el('button', { type: 'button', class: 'btn text', onclick: () => close() }, t('cancel')),
      existing ? el('button', { type: 'button', class: 'btn tonal', onclick: () => void save(true) }, t('editorSaveNew')) : null,
      el('button', { type: 'button', class: 'btn filled', onclick: () => void save(!existing) }, d.icon('check'), existing ? t('save') : t('editorSaveMine')),
    ] as (Node | null)[]).filter((x): x is Node => !!x));
    refresh();
  }
  async function save(asNew: boolean): Promise<void> {
    const s = clone(work());
    if (asNew && existing) { s.my.id = fromBase(base, d.darkTone(), '').id; s.my.name = d.t('myCopyName', { name: s.my.name }).slice(0, 60); }
    if (!s.my.name.trim()) s.my.name = t('myDefaultName', { base: themeName(base, t) }).slice(0, 60);
    s.my.at = Date.now();
    try { await saveMine(d.store, s.my, s.pics); } catch (e) { d.toast(String((e as Error).message ?? e), 'error'); return; }
    existing = true; saved = JSON.stringify(s.my); savedPics = { ...s.pics }; hist.clear(s);
    d.use(s.my.id, s.my.accent === 'theme'); d.changed(); d.toast(t('mySaved', { name: s.my.name }));
    close(true);
  }
  function close(force = false): void {
    if (!force && dirty()) {
      d.choose(t('editorUnsaved'), [
        { label: existing ? t('save') : t('editorSaveMine'), icon: 'check', run: () => void save(!existing) },
        { label: t('editorDiscard'), icon: 'trash', danger: true, run: () => close(true) },
        { label: t('editorKeep'), icon: 'pencil', run: () => undefined },
      ]);
      return;
    }
    removeEventListener('keydown', keys); offBack(); cancelAnimationFrame(frame);
    root.remove(); document.documentElement.classList.remove('te-editing'); d.preview(null);
    for (const u of urls.values()) URL.revokeObjectURL(u);
    openNow = null;
  }
  openNow = { close };
  draw(); show();
}

/** «Customise» from any theme (a built-in one, or one of the reader's: then a copy of it is edited as new). */
export function customise(d: EditorDeps, defId: string): void {
  const def = themeById(defId);
  if (def.custom) { const my = myTheme(def.id); if (my) { void blobsOf(d.store, my).then((p) => openEditor(d, { my, existing: true, pictures: p })); return; } }
  if (def.classic) return;
  const my = fromBase(def, d.darkTone(), d.t('myDefaultName', { base: themeName(def, d.t) }).slice(0, 60));
  openEditor(d, { my, existing: false });
}
export { type MyTheme };
