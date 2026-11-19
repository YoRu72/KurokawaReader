// The theme editor and «My themes»: any theme customised with a live preview on the app itself (a glass sheet on a
// phone that can be dragged lower, a side panel on a computer), undo/redo, a contrast guard, saved under a name,
// edited again, duplicated, renamed, deleted (with Undo), passed on as a file. Shared by the Kurokawa apps: the app
// hands in its words, icons, storage, preview and Back (`EditorDeps`).
// An app with `APP_THEME.themeExtras` gets more: its two accents, the progress lines' colour, a tint over the surfaces,
// spacing (comfortable or compact), the interface's size, light/dark/auto, and on a computer colours of the theme's own
// while a chosen background is shown. Every colour picked anywhere here keeps out of yellow and orange (theme/hues.ts,
// the background library's rule): one in that band is moved to the nearest allowed hue, with a short note.
import { themeById, THEMES, upsertTheme, removeTheme, GRAPHITE, type ThemeDef, type Mode, type DarkTone, type Surfaces } from './themes';
import { fromBase, toDef, sanitise, loadMine, lowestContrast, fixContrast, preparePicture, exportTheme, importTheme, pictureKey, pictureAsset, minePictureUrls, modeFromBase, cleanThemeName, ThemeFileError, RANGES, PER_BG_MAX, usesOwnPicture, type MyTheme, type MyMode, type BgKind, type MyStore } from './custom';
import { allowedHex, rolesFrom, mixHex, hsl, fromHsl } from './hues';
import { History, deferred } from './history';
import { APP_THEME } from './app';
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
  /** Optional: the app's own undo keys (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y) handed to `handler` first while the editor is
   * open (true: it took them); returns its removal. Without it the editor listens to those keys itself. */
  keys?(handler: (op: 'undo' | 'redo') => boolean): () => void;
  /** Optional (a computer's backgrounds): the one shown now (its settings id, null when none) and a name for any id. */
  backgrounds?: { current(): string | null; name(id: string): string };
}

/* ---------- colours the editor makes (its extras) ---------- */
const HEXRE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const toHex6 = (c: [number, number, number, number]): string => '#' + [0, 1, 2].map((i) => Math.round(Math.max(0, Math.min(255, c[i]))).toString(16).padStart(2, '0')).join('');
/** Every colour of a theme kept out of yellow and orange (an imported one, say): true when one was moved. */
function keepHues(o: unknown): boolean {
  let moved = false;
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (typeof v === 'string' && HEXRE.test(v)) { const a = allowedHex(v); if (a.moved) { (x as Record<string, unknown>)[k] = a.hex + v.slice(7); moved = true; } }
      else walk(v);
    }
  };
  walk(o); return moved;
}
/** The second accent a theme has when none was picked: its tertiary's hue (or the accent's, turned 60°) at the accent's tone. */
function secondOf(accent: string, tertiary: string | undefined): string {
  const pa = hexRgba(accent); const [, s, l] = hsl(pa); const h = tertiary ? hsl(hexRgba(tertiary))[0] : (hsl(pa)[0] + 60) % 360;
  return allowedHex(toHex6(fromHsl(h, Math.max(0.3, s), l))).hex;
}
const hexRgba = (h: string): [number, number, number, number] => { const n = parseInt(h.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; };
const mixSurfaces = (S: Surfaces, tint: string, k: number): Surfaces => Object.fromEntries(Object.entries(S).map(([n, c]) => [n, mixHex(c.slice(0, 7), tint, k)])) as unknown as Surfaces;

/** The editor's own key listener, when the app hands in no `keys`. */
function ownKeys(handler: (op: 'undo' | 'redo') => boolean): () => void {
  const keys = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement)?.matches?.('input[type=text]')) return;
    const k = e.key.toLowerCase();
    const op = k === 'z' && !e.shiftKey ? 'undo' : (k === 'z' && e.shiftKey) || k === 'y' ? 'redo' : null;
    if (op && handler(op)) e.preventDefault();
  };
  addEventListener('keydown', keys);
  return () => removeEventListener('keydown', keys);
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
  d.choose(d.t('myRename'), [{ label: d.t('save'), icon: 'check', run: () => { const n = cleanThemeName(input.value); if (!n) return; void saveMine(d.store, { ...my, name: n }, {}).then(() => d.changed()); } }]);
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
    keepHues(my);
    if (!THEMES.some((x) => x.id === my.base && !x.custom)) { my.base = 'frost'; for (const m of ['dark', 'light'] as Mode[]) if (my[m]?.bg.kind === 'theme') my[m]!.bg.kind = 'mesh'; }
    await saveMine(d.store, my, pictures); d.changed(); d.toast(d.t('myImported', { name: my.name }));
  } catch (e) {
    const code = e instanceof ThemeFileError ? e.code : 'format';
    d.toast(d.t(code === 'size' ? 'myImportTooBig' : code === 'picture' ? 'myImportPicture' : code === 'value' ? 'myImportValues' : code === 'schema' ? 'myImportNotTheme' : 'myImportBad'), 'error', undefined, 6000);
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
  const extras = !!APP_THEME.themeExtras;
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
  // (An app with its own undo keys hands in `keys`, so the editor's stack is asked first while it is open; else its own listener.)
  const offKeys = (d.keys ?? ownKeys)((op) => { step(op === 'undo' ? -1 : 1); return true; });
  const offBack = d.onBack(() => { close(); return true; });

  function step(dir: 1 | -1): void { if (dir < 0 ? hist.undo() : hist.redo()) { show(); draw(); } }
  function refresh(): void {
    undoBtn.toggleAttribute('disabled', !hist.canUndo); redoBtn.toggleAttribute('disabled', !hist.canRedo);
    body.querySelectorAll<HTMLElement>('[data-path]').forEach((r) => { const b = r.querySelector<HTMLButtonElement>('.te-reset'); if (b) b.disabled = !differs(r.dataset.path!); });
    paintGuard();
  }
  const get = (path: string, m: MyMode | MyTheme): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], m);
  const set = (path: string, m: MyMode | MyTheme, val: unknown) => { const ks = path.split('.'); const last = ks.pop()!; const o = ks.reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, m as unknown as Record<string, unknown>); o[last] = val; };
  // (The theme-wide values and what the base has for them; every other path is the mode's.)
  const WHOLE: Record<string, unknown> = { radius: +(((base.radius?.lg ?? 20) / 20)).toFixed(2), scale: undefined };
  const isWhole = (path: string) => path in WHOLE;
  const differs = (path: string): boolean => path === 'radius' ? Math.abs(work().my.radius - (WHOLE.radius as number)) > 0.001 : isWhole(path) ? get(path, work().my) !== WHOLE[path]
    : JSON.stringify(get(path, v()) ?? null) !== JSON.stringify(get(path, baseline(mode)) ?? null);
  const reset = (path: string) => change((s) => { if (isWhole(path)) set(path, s.my, WHOLE[path]); else { set(path, s.my[mode]!, JSON.parse(JSON.stringify(get(path, baseline(mode)) ?? null)) ?? undefined); derive(s.my, mode, path); } }, undefined, true);
  /** The accent a mode shows now (its own, its roles', the default's). */
  const accentOf = (m: Mode, my: MyTheme): string => (my[m]?.accent ?? my[m]?.roles?.primary ?? GRAPHITE[m].primary).slice(0, 7);
  const perRoles = (accent: string, accent2: string | undefined, x: MyMode, m: Mode) => rolesFrom({ accent, second: accent2 ?? secondOf(accent, undefined), dark: m === 'dark', ground: x.surfaces.ground.slice(0, 7), surface: x.surfaces.low.slice(0, 7), text: x.text.on.slice(0, 7), muted: x.text.dim.slice(0, 7) });
  const refreshPer = (my: MyTheme, e: NonNullable<MyTheme['perBg']>[number]) => { for (const m of ['dark', 'light'] as Mode[]) { const x = my[m]; if (x) e[m] = perRoles(e.accent, e.accent2, x, m); else delete e[m]; } };
  /** What follows from the extras: the surfaces — the base's, the tint laid over —; the roles from the two accents (the
   *  base's own again once neither is set); the colours per background made again over the new surfaces. */
  function derive(my: MyTheme, m: Mode, path = ''): void {
    const x = my[m]; if (!x) return; const b = baseline(m);
    if (/^surf/.test(path)) { const k = x.surfMix ?? 0; x.surfaces = k > 0 ? mixSurfaces(b.surfaces, x.surfTint ?? accentOf(m, my), k) : b.surfaces; if (k > 0 && !x.surfTint) x.surfTint = accentOf(m, my); }
    if (/^(accent|surf)/.test(path)) {
      if (x.accent || x.accent2) { const a = accentOf(m, my); x.roles = rolesFrom({ accent: a, second: x.accent2 ?? secondOf(a, b.roles?.tertiaryContainer), dark: m === 'dark', ground: x.surfaces.ground.slice(0, 7), surface: x.surfaces.low.slice(0, 7), text: x.text.on.slice(0, 7), muted: x.text.dim.slice(0, 7) }); my.accent = 'theme'; }
      else if (path.startsWith('accent')) { x.roles = b.roles; if (!b.roles) my.accent = 'app'; }
    }
    for (const e of my.perBg ?? []) refreshPer(my, e);
  }
  // (Always there, dimmed while the value is the theme's own: one place to look, one tap back.)
  const resetBtn = (path: string) => el('button', { type: 'button', class: 'te-reset', title: t('editorReset'), 'aria-label': t('editorReset'), disabled: !differs(path), onclick: () => reset(path) }, d.icon('undo'));

  const slider = (label: string, path: string, range: keyof typeof RANGES, fmt: (n: number) => string, whole = false, after?: (s: Snap) => void) => {
    const [lo, hi, st] = RANGES[range]; const cur = Number(get(path, whole ? work().my : v()) ?? (range === 'scale' ? 1 : lo));
    const val = el('output', { class: 'te-val' }, fmt(cur));
    const input = el('input', { type: 'range', min: String(lo), max: String(hi), step: String(st), value: String(cur), 'aria-label': label }) as HTMLInputElement;
    const fill = () => input.style.setProperty('--p', `${((Number(input.value) - lo) / (hi - lo)) * 100}%`); fill();
    input.addEventListener('input', () => { const n = Number(input.value); val.textContent = fmt(n); fill(); change((s) => { set(path, whole ? s.my : s.my[mode]!, n); after?.(s); }, `slider:${mode}:${path}`); });
    input.addEventListener('change', () => hist.seal());
    return el('div', { class: 'te-row te-slider', 'data-path': path }, el('div', { class: 'te-row-head' }, el('span', { class: 'te-label' }, label), val, resetBtn(path)), input);
  };
  // (A colour in the yellow–orange band is moved to the nearest allowed hue as it is picked; a note says so once.)
  const colour = (label: string, path: string, shown?: string, onPick?: (s: Snap, hex: string) => void) => {
    const cur = (shown ?? String(get(path, v()))).slice(0, 7);
    const input = el('input', { type: 'color', value: cur, 'aria-label': label }) as HTMLInputElement;
    const hex = el('span', { class: 'te-hex', dir: 'ltr' }, cur);
    const sw = el('label', { class: 'te-swatch', style: { '--c': cur } }, input);
    let moved = false;
    input.addEventListener('input', () => { const a = allowedHex(input.value); moved = a.moved; if (a.moved) input.value = a.hex; sw.style.setProperty('--c', a.hex); hex.textContent = a.hex; change((s) => (onPick ? onPick(s, a.hex) : set(path, s.my[mode]!, a.hex)), `colour:${mode}:${path}`); });
    input.addEventListener('change', () => { hist.seal(); if (moved) d.toast(t('editorHueMoved')); moved = false; });
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
    // (A computer: the two moving backgrounds, in the three colours below — still wherever they do not move.)
    if (APP_THEME.animBg && d.isPc()) kinds.push(['drift', t('animBgDrift')], ['flow', t('animBgFlow')]);
    const bg = m.bg;
    const setKind = (k: BgKind) => change((x) => { const b = x.my[mode]!.bg; b.kind = k; if (k === 'pack' && !b.pack && packPics[0]) b.pack = { id: packPics[0].id, asset: packPics[0].asset }; }, undefined, true);
    const pickPicture = async () => {
      const f = await d.pickFile('image/jpeg,image/png,image/webp'); if (!f) return;
      try { const p = await preparePicture(f); change((x) => { x.pics[mode] = p.blob; const b = x.my[mode]!.bg; b.kind = 'picture'; b.extremes = p.extremes; }, undefined, true); }
      catch { d.toast(t('myImportPicture'), 'error'); }
    };
    const accentSeg = seg(t('accent'), [['app', t('editorAccentApp')], ...(m.roles ? [['theme', t('accentTheme')]] : [])] as ['app' | 'theme', string][], s.my.accent, (x) => change((y) => { y.my.accent = x; }, undefined, true));
    const tert = m.roles?.tertiaryContainer ?? GRAPHITE[mode].tertiaryContainer;
    const extraTop = extras ? [
      el('h3', { class: 'te-h' }, t('editorColours')),
      accentSeg,
      colour(t('editorAccent1'), 'accent', accentOf(mode, s.my), (x, h) => { x.my[mode]!.accent = h; derive(x.my, mode, 'accent'); }),
      colour(t('editorAccent2'), 'accent2', m.accent2 ?? secondOf(accentOf(mode, s.my), tert), (x, h) => { x.my[mode]!.accent2 = h; derive(x.my, mode, 'accent2'); }),
      colour(t('editorProgress'), 'progress', m.progress ?? accentOf(mode, s.my)),
      el('h3', { class: 'te-h' }, t('editorSurfaces')),
      colour(t('editorSurfTint'), 'surfTint', m.surfTint ?? accentOf(mode, s.my), (x, h) => { const y = x.my[mode]!; y.surfTint = h; if (!y.surfMix) y.surfMix = 0.08; derive(x.my, mode, 'surfTint'); }),
      slider(t('editorSurfMix'), 'surfMix', 'surfMix', pct, false, (x) => derive(x.my, mode, 'surfMix')),
    ] : [];
    body.replaceChildren(...([
      el('div', { class: 'te-row te-namerow' }, el('span', { class: 'te-label' }, t('myName')), nameIn),
      extras && modes.length > 1 ? seg(t('editorShowIn'), [['auto', t('editorAuto')], ['dark', t('uiDark')], ['light', t('uiLight')]] as ['auto' | Mode, string][], s.my.force ?? 'auto', (x) => change((y) => { y.my.force = x === 'auto' ? undefined : x; }, undefined, true)) : null,
      modes.length > 1 ? seg(t('editorMode'), [['dark', t('uiDark')], ['light', t('uiLight')]] as [Mode, string][], mode, (x) => { mode = x; draw(); }) : null,
      limit ? el('p', { class: 'te-note' }, d.icon('info'), el('span', null, limit)) : null,
      guard,
      ...extraTop,
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
      ...(extras ? [seg(t('editorDensity'), [['comfortable', t('editorComfortable')], ['compact', t('editorCompact')]] as ['comfortable' | 'compact', string][], s.my.density ?? 'comfortable', (x) => change((y) => { y.my.density = x === 'compact' ? x : undefined; }, undefined, true)),
        slider(t('editorScale'), 'scale', 'scale', pct, true)] : []),
      el('h3', { class: 'te-h' }, t('editorBackground')),
      el('div', { class: 'te-chips', role: 'radiogroup', 'aria-label': t('editorBackground') }, ...kinds.map(([k, l]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(bg.kind === k), class: 'chip' + (bg.kind === k ? ' on' : ''), onclick: () => setKind(k) }, l))),
      ...((bg.kind === 'drift' || bg.kind === 'flow') && APP_THEME.animBg && d.isPc() ? [el('p', { class: 'te-note' }, d.icon('info'), el('span', null, t('editorAnimNote')))] : []),
      ...(bg.kind === 'mesh' || bg.kind === 'drift' || bg.kind === 'flow' ? [colour(t('editorColour1'), 'bg.colors.0'), colour(t('editorColour2'), 'bg.colors.1'), colour(t('editorColour3'), 'bg.colors.2')] : []),
      ...(bg.kind === 'solid' ? [colour(t('editorColour1'), 'bg.solid')] : []),
      ...(bg.kind === 'picture' ? [
        el('div', { class: 'te-row te-pic' }, s.pics[mode] ? el('img', { class: 'te-thumb', src: urlOf(s.pics[mode]!), alt: '' }) : el('span', { class: 'te-thumb none' }, d.icon('images')),
          el('span', { class: 'te-label' }, s.pics[mode] ? t('editorPictureHere') : t('editorPictureNone')),
          el('button', { type: 'button', class: 'btn tonal small', onclick: () => void pickPicture() }, d.icon('images'), s.pics[mode] ? t('editorPictureChange') : t('editorPictureChoose'))),
        slider(t('editorVeil'), 'bg.veil', 'veil', pct), slider(t('editorPicBlur'), 'bg.picBlur', 'picBlur', px)] : []),
      ...(bg.kind === 'pack' ? [el('div', { class: 'te-chips' }, ...packPics.map((p) => el('button', { type: 'button', class: 'chip' + (bg.pack?.asset === p.asset && bg.pack?.id === p.id ? ' on' : ''), onclick: () => change((x) => { x.my[mode]!.bg.pack = { id: p.id, asset: p.asset }; x.my[mode]!.bg.extremes = undefined; }, undefined, true) }, p.label))),
        slider(t('editorVeil'), 'bg.veil', 'veil', pct), slider(t('editorPicBlur'), 'bg.picBlur', 'picBlur', px)] : []),
      ...(extras ? perBgRows() : [el('h3', { class: 'te-h' }, t('accent')), accentSeg]),
      !extras ? null : el('div', { class: 'te-row te-resetall' }, el('button', { type: 'button', class: 'btn text small', onclick: () => change((x) => { const f = fromBase(base, d.darkTone(), x.my.name); x.my = { ...f, id: x.my.id, name: x.my.name, at: x.my.at }; }, undefined, true) }, d.icon('undo'), t('editorResetAll', { base: themeName(base, t) }))),
    ] as (Node | null)[]).filter((x): x is Node => !!x));
    foot.replaceChildren(...([
      el('button', { type: 'button', class: 'btn text', onclick: () => close() }, t('cancel')),
      existing ? el('button', { type: 'button', class: 'btn tonal', onclick: () => void save(true) }, t('editorSaveNew')) : null,
      el('button', { type: 'button', class: 'btn filled', onclick: () => void save(!existing) }, d.icon('check'), existing ? t('save') : t('editorSaveMine')),
    ] as (Node | null)[]).filter((x): x is Node => !!x));
    refresh();
  }
  /** A computer's backgrounds: colours of the theme's own while one is shown — one row each (its two accents, its
   *  name, remove), and «Own colours with …» for the one shown now. */
  function perBgRows(): Node[] {
    const bgs = d.backgrounds; if (!bgs || !d.isPc()) return [];
    const my = work().my; const list = my.perBg ?? []; const cur = bgs.current();
    const swatch = (val: string, label: string, key: string, put: (x: MyTheme, h: string) => void) => {
      const input = el('input', { type: 'color', value: val.slice(0, 7), 'aria-label': label }) as HTMLInputElement; let moved = false;
      const lab = el('label', { class: 'te-swatch small', title: label, style: { '--c': val.slice(0, 7) } }, input);
      input.addEventListener('input', () => { const a = allowedHex(input.value); moved = a.moved; if (a.moved) input.value = a.hex; lab.style.setProperty('--c', a.hex); change((x) => put(x.my, a.hex), key); });
      input.addEventListener('change', () => { hist.seal(); if (moved) d.toast(t('editorHueMoved')); moved = false; });
      return lab;
    };
    const rows = list.map((e, i) => {
      const name = bgs.name(e.bg);
      return el('div', { class: 'te-row te-perbg', 'data-bg': e.bg },
        swatch(e.accent, `${t('editorAccent1')} — ${name}`, `perbg:${i}:a`, (x, h) => { const y = x.perBg![i]; y.accent = h; refreshPer(x, y); }),
        swatch(e.accent2 ?? secondOf(e.accent, undefined), `${t('editorAccent2')} — ${name}`, `perbg:${i}:b`, (x, h) => { const y = x.perBg![i]; y.accent2 = h; refreshPer(x, y); }),
        el('span', { class: 'te-label', dir: 'auto' }, name, e.bg === cur ? el('small', { class: 'te-now' }, t('editorPerBgNow')) : null),
        el('button', { type: 'button', class: 'te-reset te-perbg-rm', title: t('editorPerBgRemove'), 'aria-label': `${t('editorPerBgRemove')} — ${name}`, onclick: () => change((x) => { x.my.perBg = x.my.perBg!.filter((_, j) => j !== i); if (!x.my.perBg.length) delete x.my.perBg; }, undefined, true) }, d.icon('close')));
    });
    const add = cur && !list.some((e) => e.bg === cur) && list.length < PER_BG_MAX
      ? el('button', { type: 'button', class: 'btn tonal small te-perbg-add', onclick: () => change((x) => { const e = { bg: cur, accent: secondOf(accentOf(mode, x.my), undefined) }; refreshPer(x.my, e); x.my.perBg = [...(x.my.perBg ?? []), e]; }, undefined, true) }, d.icon('plus'), el('span', { dir: 'auto' }, t('editorPerBgAdd', { name: bgs.name(cur) })))
      : null;
    return [el('h3', { class: 'te-h' }, t('editorPerBg')), el('p', { class: 'te-note' }, d.icon('info'), el('span', null, cur ? t('editorPerBgHint') : t('editorPerBgNone'))), ...rows,
      ...(add ? [add] : []), el('small', { class: 'te-count' }, t('editorPerBgCount', { n: String(list.length), max: String(PER_BG_MAX) }))];
  }
  async function save(asNew: boolean): Promise<void> {
    const s = clone(work());
    if (asNew && existing) { s.my.id = fromBase(base, d.darkTone(), '').id; s.my.name = d.t('myCopyName', { name: s.my.name }).slice(0, 60); }
    if (!s.my.name.trim()) s.my.name = t('myDefaultName', { base: themeName(base, t) }).slice(0, 60);
    s.my.at = Date.now();
    // (The guard's last word: text that would be too faint anywhere is corrected before the theme is kept.)
    let fixed = false;
    for (const m of ['dark', 'light'] as Mode[]) if (s.my[m] && lowestContrast(s.my, m, d.darkTone()) < 4.5) { s.my = fixContrast(s.my, m, d.darkTone()); fixed = true; }
    try { await saveMine(d.store, s.my, s.pics); } catch (e) { d.toast(String((e as Error).message ?? e), 'error'); return; }
    existing = true; saved = JSON.stringify(s.my); savedPics = { ...s.pics }; hist.clear(s);
    d.use(s.my.id, s.my.accent === 'theme'); d.changed(); d.toast(t(fixed ? 'editorContrastFixed' : 'mySaved', { name: s.my.name }));
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
    offKeys(); offBack(); cancelAnimationFrame(frame);
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
  if (def.classic && !APP_THEME.mainCopyable) return;
  const my = fromBase(def, d.darkTone(), d.t('myDefaultName', { base: themeName(def, d.t) }).slice(0, 60));
  openEditor(d, { my, existing: false });
}
export { type MyTheme };
