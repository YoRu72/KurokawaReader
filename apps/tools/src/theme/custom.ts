// «My themes»: themes the reader makes from any theme — its glass, shape, depth, background and accent changed —,
// kept, edited again, passed to others as a file. Shared by the Kurokawa apps (no import from either app).
//
// What is kept (`MyTheme`): FULL values, not a difference from the base — surfaces, text, accent roles, glass,
// shape, depth and background are all stored as colours and numbers, so a later update that changes the base theme
// leaves a saved theme as it was. The one reference to the base is the background «the theme's own», which is the
// base's background as the app draws it today (chosen by the reader as «the theme's own»; the base id is kept).
// Only colours (#rrggbb / #rrggbbaa), numbers in ranges and fixed words are ever stored or read back: every CSS
// value is built here from them, never taken from storage or from a file (see `sanitise`).
import { themeById, resolve, GRAPHITE, e3Roles, modesOf, contrastReport, parseColor, over, luminance, type ThemeDef, type ModeTokens, type Mode, type DarkTone, type Surfaces, type TextRoles, type Roles, type RGBA } from './themes';
import { parsePack, buildPack, sha256Hex, PackError, type PackIO } from './packs';

/** 'drift' and 'flow' (0.21): the animated backgrounds, in the theme's three colours — still, as the mesh of those
 *  colours, wherever they do not move (a phone, the animated background off). */
export type BgKind = 'theme' | 'mesh' | 'solid' | 'picture' | 'pack' | 'drift' | 'flow';
export interface MyBg { kind: BgKind; colors: [string, string, string]; solid: string; veil: number; picBlur: number; /** The reader's picture: its brightest and darkest colour (measured when it was chosen). */ extremes?: [string, string]; /** A downloaded pack's picture. */ pack?: { id: string; asset: string } }
export interface MyMode { surfaces: Surfaces; text: TextRoles; roles: Roles | null; tint: string; strength: number; blur: number; sat: number; edge: number; sheen: number; shadow: number; bg: MyBg }
export interface MyTheme { v: 1; id: string; name: string; base: string; radius: number; accent: 'app' | 'theme'; force?: Mode; dark?: MyMode; light?: MyMode; at: number }

/** The ranges every number is held to (the editor's sliders use them too). */
export const RANGES = { strength: [0, 0.98, 0.01], blur: [0, 48, 1], sat: [0.5, 2.5, 0.05], edge: [0, 0.4, 0.01], sheen: [0, 0.4, 0.01], shadow: [0, 1, 0.05], radius: [0, 2, 0.05], veil: [0, 0.85, 0.01], picBlur: [0, 40, 1] } as const;
const M3E = { xs: 8, sm: 12, md: 16, lg: 20, xl: 28, xxl: 36 };
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const toHex = (c: RGBA): string => '#' + [c[0], c[1], c[2]].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('') + (c[3] < 1 ? Math.round(c[3] * 255).toString(16).padStart(2, '0') : '');
const hexOf = (css: string): string => { try { return toHex(parseColor(css)); } catch { return '#808080'; } };
const rgb = (hex: string, a = 1): string => { const c = parseColor(hex); return `rgb(${c[0]} ${c[1]} ${c[2]} / ${+(a * c[3]).toFixed(3)})`; };
const clamp = (v: number, k: keyof typeof RANGES): number => { const [lo, hi] = RANGES[k]; return Math.min(hi, Math.max(lo, v)); };
export const uidTheme = (): string => `my-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A mode's values as the base theme has them (what «reset» goes back to). */
export function modeFromBase(base: ThemeDef, mode: Mode, darkTone: DarkTone): MyMode {
  const r = resolve({ theme: base.id, mode, darkTone, useThemeColours: true });
  // (Expressive 3 has no glass: a copy of it starts solid — its surfaces and text, its roles, panes all but opaque, no
  //  blur, a plain ground — and the editor can add glass from there.)
  if (!r.tokens) {
    const S = Object.fromEntries(Object.entries(r.surfaces).map(([k, v]) => [k, hexOf(v)])) as unknown as Surfaces; const R = e3Roles(mode);
    return { surfaces: S, text: Object.fromEntries(Object.entries(r.text).map(([k, v]) => [k, hexOf(v)])) as unknown as TextRoles, roles: R,
      tint: S.low.slice(0, 7), strength: 0.96, blur: 0, sat: 1, edge: mode === 'dark' ? 0.04 : 0.3, sheen: 0, shadow: 0.3,
      bg: { kind: 'solid', colors: [R.primaryContainer, R.tertiaryContainer, R.secondaryContainer].map((x) => hexOf(x).slice(0, 7)) as [string, string, string], solid: S.ground.slice(0, 7), veil: 0.2, picBlur: 0 } };
  }
  const t = r.tokens;
  const pane = r.pane; const edgeA = (() => { try { const e = parseColor(t.edge); return e[0] > 200 && e[1] > 200 ? e[3] : 0.1; } catch { return 0.1; } })();
  const sheenA = (() => { const m = /inset 0 1px 0 rgba?\(([^)]*)\)/.exec(t.sheen); if (!m) return mode === 'dark' ? 0.06 : 0.6; try { return parseColor(`rgb(${m[1]})`)[3]; } catch { return 0.06; } })();
  const roles = r.roles ? (Object.fromEntries(Object.entries(r.roles).map(([k, v]) => [k, hexOf(v)])) as unknown as Roles) : null;
  const S = Object.fromEntries(Object.entries(r.surfaces).map(([k, v]) => [k, hexOf(v)])) as unknown as Surfaces;
  return {
    surfaces: S, text: Object.fromEntries(Object.entries(r.text).map(([k, v]) => [k, hexOf(v)])) as unknown as TextRoles, roles,
    tint: toHex([pane[0], pane[1], pane[2], 1]), strength: +pane[3].toFixed(2), blur: t.blur, sat: t.sat, edge: +edgeA.toFixed(2), sheen: +sheenA.toFixed(2), shadow: 0.7,
    bg: { kind: 'theme', colors: [roles?.primaryContainer ?? GRAPHITE[mode].tertiaryContainer, roles?.tertiaryContainer ?? GRAPHITE[mode].primaryContainer, roles?.secondaryContainer && !roles.secondaryContainer.includes('/') ? roles.secondaryContainer : GRAPHITE[mode].secondaryContainer].map((x) => hexOf(x).slice(0, 7)) as [string, string, string], solid: S.ground.slice(0, 7), veil: 0.2, picBlur: 0 },
  };
}
/** A new theme of the reader's from a base theme: its modes as the base has them. */
export function fromBase(base: ThemeDef, darkTone: DarkTone, name: string): MyTheme {
  const src = base.custom ? undefined : base;
  const b = src ?? themeById(base.base);
  const modes: Mode[] = modesOf(b);
  const scale = (b.radius?.lg ?? 18) / 20;
  const my: MyTheme = { v: 1, id: uidTheme(), name, base: b.id, radius: +scale.toFixed(2), accent: b.followsAccent ? 'app' : 'theme', force: b.force, at: Date.now() };
  for (const m of modes) my[m] = modeFromBase(b, m, darkTone);
  return my;
}

/** The theme's tokens built from its values (every CSS string made here, from checked colours and numbers). */
export function toDef(my: MyTheme): ThemeDef {
  const base = themeById(my.base);
  const build = (m: Mode, v: MyMode): ModeTokens => {
    const g = v.surfaces.ground;
    const baseTok = (m === 'dark' ? base.dark : base.light) ?? (m === 'dark' ? base.light : base.dark);
    let bg = ''; let picture: string | undefined; let veil: string | undefined; let extremes: [string, string];
    const ex = (cols: string[]): [string, string] => { const gg = parseColor(g); const all = cols.map((c) => over(parseColor(c), gg)); all.push(gg); all.sort((a, b) => luminance(b) - luminance(a)); return [toHex(all[0]), toHex(all[all.length - 1])]; };
    if (v.bg.kind === 'theme' && baseTok) { bg = baseTok.bg; picture = baseTok.picture; veil = baseTok.veil; extremes = baseTok.extremes; }
    else if (v.bg.kind === 'solid') { bg = `linear-gradient(${rgb(v.bg.solid)}, ${rgb(v.bg.solid)})`; extremes = [v.bg.solid, v.bg.solid]; }
    else if (v.bg.kind === 'picture' || v.bg.kind === 'pack') {
      picture = v.bg.kind === 'picture' ? pictureAsset(my.id, m) : v.bg.pack?.asset; const vv = rgb(g, v.bg.veil); veil = `linear-gradient(${vv}, ${vv})`;
      extremes = v.bg.kind === 'pack' && !v.bg.extremes ? (m === 'dark' ? ['#5a5f6b', '#000002'] : ['#fefbf4', '#4c6abe']) : v.bg.extremes ?? [g, g];
      bg = `linear-gradient(${rgb(g)}, ${rgb(g)})`;
    } else {
      // (A mesh, and the still stand-in of a moving background.)
      const [a, b, c] = v.bg.colors;
      bg = `radial-gradient(90% 48% at 0% -6%, ${rgb(a, 0.62)}, transparent 72%), radial-gradient(70% 46% at 104% 46%, ${rgb(b, 0.5)}, transparent 70%), radial-gradient(100% 48% at 20% 108%, ${rgb(c, 0.55)}, transparent 72%)`;
      extremes = ex([rgb(a, 0.62), rgb(b, 0.5), rgb(c, 0.55)]);
    }
    const tint = (a: number): string => rgb(v.tint, Math.min(0.98, a));
    const light = m === 'light'; const d = v.shadow;
    const anim = v.bg.kind === 'drift' || v.bg.kind === 'flow' ? { anim: v.bg.kind, animColors: [...v.bg.colors] as [string, string, string] } : {};
    return {
      ...anim, surfaces: v.surfaces, text: v.text, roles: v.roles ?? undefined, bg, picture, veil, extremes: extremes!, bgBlur: picture && v.bg.kind !== 'theme' ? v.bg.picBlur : undefined,
      pane: tint(v.strength), card: tint(v.strength * 0.8), sheet: tint(Math.min(0.96, v.strength + 0.18)), fill: Math.min(0.9, 0.35 + v.strength * 0.4),
      blur: v.blur, sat: v.sat, edge: `rgb(255 255 255 / ${v.edge})`, sheen: `inset 0 1px 0 rgb(255 255 255 / ${v.sheen})`,
      shadow: d <= 0 ? 'none' : `0 ${Math.round(18 * d)}px ${Math.round(44 * d)}px -${Math.round(16 * d)}px rgb(0 0 0 / ${(light ? 0.28 : 0.75) * d}), 0 1px ${Math.round(3 * d)}px rgb(0 0 0 / ${(light ? 0.08 : 0.35) * d})`,
      scrim: light ? 'rgb(20 24 30 / .32)' : 'rgb(3 4 5 / .6)',
    };
  };
  const radius = Object.fromEntries(Object.entries(M3E).map(([k, r]) => [k, Math.round(r * my.radius)])) as ThemeDef['radius'];
  const def: ThemeDef = { id: my.id, name: my.name, custom: true, base: my.base, force: my.force, followsAccent: my.accent === 'app', radius };
  if (my.dark) def.dark = build('dark', my.dark);
  if (my.light) def.light = build('light', my.light);
  if (base.pack && ((my.dark?.bg.kind === 'theme') || (my.light?.bg.kind === 'theme'))) def.pack = base.pack;
  const packMode = [my.dark?.bg, my.light?.bg].find((b) => b?.kind === 'pack' && b.pack);
  if (packMode?.pack) def.pack = { id: packMode.pack.id, size: 0, assets: {} };
  return def;
}
export const usesOwnPicture = (my: MyTheme): Mode[] => (['dark', 'light'] as Mode[]).filter((m) => my[m]?.bg.kind === 'picture');

/** The lowest text contrast on the glass (and on the bare background), the reader's accent aside. */
export function lowestContrast(my: MyTheme, mode: Mode, darkTone: DarkTone): number {
  const def = toDef(my); const r = resolveDef(def, mode, darkTone);
  return Math.min(...contrastReport(r).map((x) => x.ratio));
}
function resolveDef(def: ThemeDef, mode: Mode, darkTone: DarkTone) {
  // (resolve() looks themes up by id: the one being edited may not be listed yet.)
  const tokens = (mode === 'dark' ? def.dark : def.light) ?? def.dark ?? def.light!;
  const tint = (s: string): RGBA => parseColor(typeof s === 'string' ? s : '#000');
  return { def, mode, tokens, surfaces: tokens.surfaces!, text: tokens.text!, roles: null, pane: tint(tokens.pane as string), card: tint(tokens.card as string), sheet: tint(tokens.sheet as string), _t: darkTone } as unknown as Parameters<typeof contrastReport>[0];
}
/** «Fix contrast»: more tint on the glass first (the look kept), then the background drawn nearer the ground (a
 *  picture: a thicker veil), then the secondary text drawn nearer the main one. */
export function fixContrast(my: MyTheme, mode: Mode, darkTone: DarkTone): MyTheme {
  const out: MyTheme = JSON.parse(JSON.stringify(my)); const v = out[mode]; if (!v) return out;
  const low = () => lowestContrast(out, mode, darkTone);
  const toward = (c: string, to: string, k: number) => { const x = parseColor(c), y = parseColor(to); return toHex([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k, 1]); };
  for (let i = 0; i < 40 && low() < 4.5 && v.strength < 0.94; i++) v.strength = +(v.strength + 0.03).toFixed(2);
  for (let i = 0; i < 16 && low() < 4.5; i++) {
    if (v.bg.kind === 'picture' || v.bg.kind === 'pack') v.bg.veil = Math.min(RANGES.veil[1], +(v.bg.veil + 0.06).toFixed(2));
    else if (v.bg.kind === 'solid') v.bg.solid = toward(v.bg.solid, v.surfaces.ground, 0.25);
    else if (v.bg.kind === 'mesh' || v.bg.kind === 'drift' || v.bg.kind === 'flow') v.bg.colors = v.bg.colors.map((c) => toward(c, v.surfaces.ground, 0.25)) as [string, string, string];
    else break;
  }
  for (let i = 0; i < 20 && low() < 4.5; i++) { v.text.dim = toward(v.text.dim, v.text.on, 0.2); v.text.variant = toward(v.text.variant, v.text.on, 0.2); if (i > 6) v.text.on = toward(v.text.on, mode === 'dark' ? '#ffffff' : '#000000', 0.3); }
  return out;
}

/* ---------- reading untrusted values: storage, backups, files ---------- */
export class ThemeFileError extends Error { constructor(public code: 'size' | 'schema' | 'value' | 'picture' | 'format', msg: string) { super(msg); } }
const fail = (code: ThemeFileError['code'], m: string): never => { throw new ThemeFileError(code, m); };
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (o: Record<string, unknown>, allowed: string[], where: string) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) fail('schema', `${where}: unknown field «${k.slice(0, 30)}»`); };
const colour = (x: unknown, where: string): string => (typeof x === 'string' && HEX.test(x) ? x.toLowerCase() : fail('value', `${where}: not a colour`));
const num = (x: unknown, k: keyof typeof RANGES, where: string): number => (typeof x === 'number' && Number.isFinite(x) ? clamp(x, k) : fail('value', `${where}: not a number`));
const word = <T extends string>(x: unknown, ok: readonly T[], where: string): T => (typeof x === 'string' && (ok as readonly string[]).includes(x) ? (x as T) : fail('value', `${where}: not one of ${ok.join('/')}`));
const SURF = ['ground', 'lowest', 'low', 'mid', 'high', 'highest']; const TEXT = ['on', 'variant', 'dim', 'outline', 'outlineVariant'];
const ROLES = ['primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'secondaryContainer', 'onSecondaryContainer', 'tertiaryContainer', 'onTertiaryContainer'];
const colours = (x: unknown, keys: string[], where: string): Record<string, string> => { if (!isObj(x)) fail('schema', `${where}: missing`); const o = x as Record<string, unknown>; onlyKeys(o, keys, where); return Object.fromEntries(keys.map((k) => [k, colour(o[k], `${where}.${k}`)])); };
function sanitiseMode(x: unknown, where: string): MyMode {
  if (!isObj(x)) return fail('schema', `${where}: missing`);
  onlyKeys(x, ['surfaces', 'text', 'roles', 'tint', 'strength', 'blur', 'sat', 'edge', 'sheen', 'shadow', 'bg'], where);
  const bg = x.bg; if (!isObj(bg)) return fail('schema', `${where}.bg: missing`);
  onlyKeys(bg, ['kind', 'colors', 'solid', 'veil', 'picBlur', 'extremes', 'pack'], `${where}.bg`);
  if (!Array.isArray(bg.colors) || bg.colors.length !== 3) fail('schema', `${where}.bg.colors: three colours`);
  let pack: MyBg['pack'];
  if (bg.pack !== undefined) { if (!isObj(bg.pack)) fail('schema', `${where}.bg.pack`); const p = bg.pack as Record<string, unknown>; onlyKeys(p, ['id', 'asset'], `${where}.bg.pack`); const ID = /^[a-z0-9-]{1,40}$/; if (typeof p.id !== 'string' || !ID.test(p.id) || typeof p.asset !== 'string' || !ID.test(p.asset)) fail('value', `${where}.bg.pack: not a pack name`); pack = { id: p.id as string, asset: p.asset as string }; }
  let extremes: [string, string] | undefined;
  if (bg.extremes !== undefined) { if (!Array.isArray(bg.extremes) || bg.extremes.length !== 2) fail('schema', `${where}.bg.extremes`); extremes = [colour((bg.extremes as unknown[])[0], `${where}.bg.extremes`), colour((bg.extremes as unknown[])[1], `${where}.bg.extremes`)]; }
  return {
    surfaces: colours(x.surfaces, SURF, `${where}.surfaces`) as unknown as Surfaces, text: colours(x.text, TEXT, `${where}.text`) as unknown as TextRoles,
    roles: x.roles === null || x.roles === undefined ? null : (colours(x.roles, ROLES, `${where}.roles`) as unknown as Roles),
    tint: colour(x.tint, `${where}.tint`), strength: num(x.strength, 'strength', `${where}.strength`), blur: num(x.blur, 'blur', `${where}.blur`), sat: num(x.sat, 'sat', `${where}.sat`),
    edge: num(x.edge, 'edge', `${where}.edge`), sheen: num(x.sheen, 'sheen', `${where}.sheen`), shadow: num(x.shadow, 'shadow', `${where}.shadow`),
    bg: { kind: word(bg.kind, ['theme', 'mesh', 'solid', 'picture', 'pack', 'drift', 'flow'] as const, `${where}.bg.kind`), colors: (bg.colors as unknown[]).map((c, i) => colour(c, `${where}.bg.colors[${i}]`)) as [string, string, string], solid: colour(bg.solid, `${where}.bg.solid`), veil: num(bg.veil, 'veil', `${where}.bg.veil`), picBlur: num(bg.picBlur, 'picBlur', `${where}.bg.picBlur`), extremes, pack },
  };
}
/** A theme read from anywhere (storage, a backup, a file): strictly checked, rebuilt from its colours and numbers. */
export function sanitise(x: unknown, opts: { newId?: boolean } = {}): MyTheme {
  if (!isObj(x)) return fail('schema', 'not a theme');
  onlyKeys(x, ['v', 'id', 'name', 'base', 'radius', 'accent', 'force', 'dark', 'light', 'at'], 'theme');
  if (x.v !== 1) fail('schema', 'unknown theme version');
  if (typeof x.id !== 'string' || !/^my-[a-z0-9]{1,24}$/.test(x.id)) fail('value', 'id');
  if (typeof x.base !== 'string' || !/^[a-z0-9-]{1,40}$/.test(x.base)) fail('value', 'base');
  // (A name is shown as text only; control characters and markup-like brackets are dropped, and it is kept short.)
  const name = typeof x.name === 'string' ? x.name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60) : '';
  if (!name) fail('value', 'name');
  const my: MyTheme = { v: 1, id: opts.newId ? uidTheme() : (x.id as string), name, base: x.base as string, radius: num(x.radius, 'radius', 'radius'), accent: word(x.accent, ['app', 'theme'] as const, 'accent'), at: typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : Date.now() };
  if (x.force !== undefined) my.force = word(x.force, ['dark', 'light'] as const, 'force');
  if (x.dark !== undefined) my.dark = sanitiseMode(x.dark, 'dark');
  if (x.light !== undefined) my.light = sanitiseMode(x.light, 'light');
  if (!my.dark && !my.light) fail('schema', 'no mode');
  return my;
}

/* ---------- pictures: the reader's own, made sensible for memory ---------- */
/** The rule: the long side at most 1920 px (a phone's screen at 2× is about this), re-encoded as JPEG at quality 0.85
 *  — usually 150–400 KB; a picture is decoded and drawn again, so nothing but its pixels is kept. */
export const PICTURE_MAX = 1920;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export async function preparePicture(blob: Blob): Promise<{ blob: Blob; extremes: [string, string] }> {
  if (blob.size > 40 * 1024 * 1024) fail('picture', 'picture too large');
  let bmp: ImageBitmap; try { bmp = await createImageBitmap(blob); } catch { return fail('picture', 'not a picture'); }
  if (bmp.width < 1 || bmp.height < 1 || bmp.width > 12000 || bmp.height > 12000) fail('picture', 'picture size');
  const k = Math.min(1, PICTURE_MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  const out = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.85)); if (!out) return fail('picture', 'could not encode');
  // (Its brightest and darkest parts once softened: what the contrast guard measures text against.)
  const s = document.createElement('canvas'); s.width = 48; s.height = 48; const g = s.getContext('2d')!; g.filter = 'blur(2px)'; g.drawImage(c, 0, 0, 48, 48);
  const d = g.getImageData(3, 3, 42, 42).data; let hi: RGBA = [0, 0, 0, 1], lo: RGBA = [255, 255, 255, 1];
  for (let i = 0; i < d.length; i += 4) { const px: RGBA = [d[i], d[i + 1], d[i + 2], 1]; if (luminance(px) > luminance(hi)) hi = px; if (luminance(px) < luminance(lo)) lo = px; }
  return { blob: out, extremes: [toHex(hi), toHex(lo)] };
}

/* ---------- a theme as a file: the .ktheme pack, its tokens in the header ---------- */
export const FILE_MAX = 12 * 1024 * 1024;
const ARMOUR = 'KTHEME1 base64\n';
/** One file: the pack (the reader's picture inside, checksummed), written as text (base64) so every platform's
 *  «save a text file» can keep it; reading takes the plain pack too. */
export async function exportTheme(my: MyTheme, pictures: Partial<Record<Mode, Blob>>): Promise<string> {
  const files: { name: string; type: string; bytes: Uint8Array }[] = [];
  for (const m of ['dark', 'light'] as Mode[]) { const b = pictures[m]; if (b && my[m]?.bg.kind === 'picture') files.push({ name: `mine-${m}`, type: 'image/jpeg', bytes: new Uint8Array(await b.arrayBuffer()) }); }
  const pack = await buildPack({ format: 1, id: my.id, name: my.name, version: '1', tokens: { kurokawaMyTheme: 1, theme: my } }, files);
  let s = ''; for (let i = 0; i < pack.length; i += 0x8000) s += String.fromCharCode(...pack.subarray(i, i + 0x8000));
  const b64 = btoa(s); return ARMOUR + (b64.match(/.{1,76}/g) ?? []).join('\n') + '\n';
}
const MAGIC: Record<string, number[]> = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
/** A theme file read and checked: size, armour, pack checksums, the header's schema and values, the pictures'
 *  types, magic bytes, decoding and size; a new id, so it never replaces one already here. */
export async function importTheme(bytes: Uint8Array): Promise<{ my: MyTheme; pictures: Partial<Record<Mode, Blob>> }> {
  if (bytes.length > FILE_MAX * 1.4) fail('size', 'file too large');
  let buf = bytes;
  const head = new TextDecoder().decode(bytes.subarray(0, ARMOUR.length));
  if (head === ARMOUR) {
    const text = new TextDecoder().decode(bytes.subarray(ARMOUR.length)).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) fail('format', 'not a theme file');
    const bin = atob(text); buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  }
  if (buf.length > FILE_MAX) fail('size', 'file too large');
  if (buf.length >= 12 && new DataView(buf.buffer, buf.byteOffset).getUint32(8) > 64 * 1024) fail('size', 'header too large');
  let parsed: Awaited<ReturnType<typeof parsePack>>;
  try { parsed = await parsePack(buf); } catch (e) { if (e instanceof PackError) fail(e.kind === 'checksum' ? 'format' : 'format', e.message); throw e; }
  const tok = parsed.header.tokens;
  if (!isObj(tok) || tok.kurokawaMyTheme !== 1) fail('schema', 'not a theme of one\'s own');
  onlyKeys(tok as Record<string, unknown>, ['kurokawaMyTheme', 'theme'], 'tokens');
  const my = sanitise((tok as Record<string, unknown>).theme, { newId: true });
  if (parsed.assets.length > 2) fail('schema', 'too many pictures');
  const pictures: Partial<Record<Mode, Blob>> = {};
  for (const { a, bytes: b } of parsed.assets) {
    const m = a.name === 'mine-dark' ? 'dark' : a.name === 'mine-light' ? 'light' : fail('schema', 'unknown picture');
    if (!IMAGE_TYPES.includes(a.type) || !(MAGIC[a.type] ?? []).every((v, i) => b[i] === v)) fail('picture', 'not a picture');
    if (my[m]?.bg.kind !== 'picture') fail('schema', 'picture without its background');
    const prepared = await preparePicture(new Blob([b as unknown as BlobPart], { type: a.type }));
    pictures[m] = prepared.blob; my[m]!.bg.extremes = prepared.extremes;
  }
  for (const m of ['dark', 'light'] as Mode[]) if (my[m]?.bg.kind === 'picture' && !pictures[m]) my[m]!.bg.kind = 'mesh';
  return { my, pictures };
}

/* ---------- where they are kept ---------- */
export interface MyStore { load(): unknown; save(list: MyTheme[]): void; io: PackIO }
export const pictureKey = (id: string, m: Mode): string => `mytheme:${id}:${m}`;
/** The name a theme's own picture goes by among the pictures handed to applyTheme. */
export const pictureAsset = (id: string, m: Mode): string => `${id}:${m}`;
/** The reader's themes as kept (each checked again on the way in: a restored backup is untrusted too). */
export function loadMine(store: MyStore): MyTheme[] {
  const raw = store.load(); if (!Array.isArray(raw)) return [];
  const out: MyTheme[] = []; for (const x of raw) { try { out.push(sanitise(x)); } catch { /* left out */ } }
  return out;
}
export async function minePictureUrls(io: PackIO, my: MyTheme): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of usesOwnPicture(my)) { const b = await io.getFile(pictureKey(my.id, m)).catch(() => undefined); if (b) out[pictureAsset(my.id, m)] = URL.createObjectURL(b); }
  return out;
}
export { sha256Hex };
