// Interface styles in the Reader («Settings → Appearance → Interface style»): the shared theme module (src/theme/, the
// same files as the Tools app's) laid over the Reader's chrome — the library, the bars, sheets, menus, panels,
// settings, the window's own title bar — while the page being read keeps its reading theme. Fetched only when a style
// other than Classic is chosen (settings.ts applyChrome): with Classic, the default, none of this is loaded and nothing
// in the page changes.
//
// What the Reader adds to the shared module: its own styles (defs.ts) and their order; the reader's bars as glass
// floating over the page, tinted with the page's own colours when the interface follows the page (reader.lazy.css);
// no frost anywhere while reading with the bars hidden; the selection colour of the page kept as Classic has it; the
// storage of packs in the app's IndexedDB with pictures made the screen's size (io.ts).
import GLASS_CSS from '../theme/glass.css' with { type: 'text' };
import READER_CSS from './reader.lazy.css' with { type: 'text' };
import { THEMES, applyTheme, readEnv, resolveBlur, upsertTheme, removeTheme, type ThemeDef, type Blur, type DarkTone, type Mode } from '../theme/themes';
import { loadMine, toDef, pictureKey, pictureAsset } from '../theme/custom';
import { installed, pictureUrls } from '../theme/packs';
import { PAPER_INK, MIDNIGHT_STACKS, LAMPLIGHT, READER_ORDER } from './defs';
import { themeIo, myStore } from './io';
import { onRoute, parseRoute } from '../router';
import { shellOf } from '../platform';
import { pageIsLight, applyChrome, type VisualSettings } from '../settings';

// (The shared list carries the Tools app's own styles too; the Reader shows its own, the shared Obsidian, the ported
// trio and Classic — and a pack's, once installed.)
const order = (): void => {
  for (const d of [PAPER_INK, MIDNIGHT_STACKS, LAMPLIGHT]) if (!THEMES.some((x) => x.id === d.id)) THEMES.push(d);
  const keep = THEMES.filter((d) => READER_ORDER.includes(d.id)).sort((a, b) => READER_ORDER.indexOf(a.id) - READER_ORDER.indexOf(b.id));
  THEMES.splice(0, THEMES.length, ...keep);
};
order();
// (The reader's own styles, saved with the shared editor — src/theme/editor.ts —: in the list from the start.)
for (const m of loadMine(myStore)) upsertTheme(toDef(m));
/** The style being edited, shown live in place of the chosen one (null: the chosen one again). */
let previewing: { def: ThemeDef; useThemeColours: boolean; pictures: Record<string, string> } | null = null;
export function setStylePreview(p: typeof previewing): void { previewing = p; if (p) upsertTheme(p.def); else { removeTheme('my-preview'); picturesFor = null; } applyChrome(); }
/** Pictures a style draws: its pack's, and the reader's own for a style of theirs. */
async function picturesOf(def: ThemeDef): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (def.pack?.id) Object.assign(out, await pictureUrls(themeIo, def.pack.id).catch(() => ({})));
  if (def.custom && def.id !== 'my-preview') for (const m of ['dark', 'light'] as Mode[]) { if ((m === 'dark' ? def.dark : def.light)?.picture !== pictureAsset(def.id, m)) continue; const b = await myStore.io.getFile(pictureKey(def.id, m)).catch(() => undefined); if (b) out[pictureAsset(def.id, m)] = URL.createObjectURL(b); }
  return out;
}
let packsRead = false;
/** Styles that came in packs (their tokens kept with the pack's record), added to the list once. */
export async function readPacks(): Promise<void> {
  if (packsRead) return; packsRead = true;
  const { registerTheme } = await import('../theme/themes');
  for (const rec of Object.values(await installed(themeIo))) if (rec.def) registerTheme(rec.def as ThemeDef);
}

/** A style the Reader knows (none: Classic). */
export const styleOf = (id: string | undefined): ThemeDef | undefined => (previewing ? previewing.def : id && id !== 'classic' ? THEMES.find((d) => d.id === id && !d.classic) : undefined);
/** The mode a style forces (one mode only), or none: it follows the interface's light or dark. */
export function forced(s: Pick<VisualSettings, 'uiStyle'>): boolean | undefined { const d = styleOf(s.uiStyle); return d?.force ? d.force === 'light' : undefined; }

/** How much this device blurs: the reader's choice, or what the device can afford (the shared rule, src/theme/themes.ts). */
export function blurNow(s: Pick<VisualSettings, 'glassBlur'>): ReturnType<typeof resolveBlur> {
  const sh = shellOf(); const env = readEnv(sh === 'android' ? 'android' : sh === 'desktop' ? 'desktop' : 'web');
  const gb = (globalThis as { krDeviceMemory?: number }).krDeviceMemory; if (typeof gb === 'number') env.deviceMemory = gb;
  return resolveBlur(s.glassBlur ?? 'auto', env);
}

let sheet: HTMLStyleElement | null = null; let local: HTMLStyleElement | null = null; let routed = false; let applied = false;
let pictures: Record<string, string> = {}; let picturesFor: string | null = null;
if (typeof window !== 'undefined') window.addEventListener('kr:packs-changed', () => setTimeout(() => { picturesFor = null; pictures = {}; if (document.documentElement.dataset.glass) applyChrome(); }));
// (After the pack module has let go of its pictures' addresses: the event comes as its record is written.)
const ROLE_VARS = ['--md-primary', '--md-on-primary', '--md-primary-container', '--md-on-primary-container', '--md-secondary-container', '--md-on-secondary-container', '--md-tertiary-container', '--md-on-tertiary-container'];
/** The style chosen, at its blur, in the light or dark that applyChrome settled (`light`, a forced mode included). */
export function applyStyle(s: VisualSettings, light: boolean): void {
  const html = document.documentElement; const def = styleOf(s.uiStyle);
  if (!def) {
    if (applied) { applyTheme(html, { theme: 'classic', mode: light ? 'light' : 'dark', darkTone: 'default', useThemeColours: false, blur: 'off' }); applied = false; }
    delete html.dataset.theme; delete html.dataset.gMatch; html.classList.remove('g-reading', 'g-page-bars'); local?.remove(); return;
  }
  if (!sheet) { sheet = document.createElement('style'); sheet.id = 'kr-glass'; sheet.textContent = `${GLASS_CSS as string}\n${READER_CSS as string}`; }
  if (!sheet.isConnected) document.head.append(sheet);
  if (!local) { local = document.createElement('style'); local.id = 'kr-glass-page'; }
  if (!local.isConnected) document.head.append(local);
  if (!routed) { routed = true; onRoute((r) => html.classList.toggle('g-reading', r.name === 'read' && !!html.dataset.glass)); }
  // (At this point the accent's colours on the page are Classic's: applyChrome has just set them, or taken a style's off.)
  // (The page's selection keeps Classic's accent: read in the light or dark the interface would have had, before the
  // style's own colours go on.)
  const ui = html.dataset.ui; const own = s.uiMode === 'light' ? true : s.uiMode === 'dark' ? false : s.uiMode === 'page' ? pageIsLight(s) : typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  const kept = ROLE_VARS.map((k) => [k, html.style.getPropertyValue(k)] as const);
  html.dataset.ui = own ? 'light' : 'dark'; const readPrimary = getComputedStyle(html).getPropertyValue('--md-primary').trim(); html.dataset.ui = ui;
  // (The style's own colours unless an accent of the reader's own is chosen — the neutral default gives way to them;
  // the ported themes keep theirs.)
  const useThemeColours = previewing ? previewing.useThemeColours : def.custom ? !def.followsAccent : s.accent === 'graphite' || !!def.by;
  const tone: DarkTone = s.darkTone === 'grey' ? 'grey' : s.darkTone === 'black' ? 'black' : 'default';
  const packId = `${def.id}|${def.pack?.id ?? ''}`;
  if (packId !== picturesFor) { picturesFor = packId; pictures = {}; void picturesOf(def).then((p) => { if (picturesFor === packId && Object.keys(p).length) { pictures = p; applyChrome(); } }).catch(() => undefined); }
  const blur = blurNow(s);
  const got = applyTheme(html, { theme: def.id, mode: light ? 'light' : 'dark', darkTone: tone, useThemeColours, blur: blur.blur as Blur, pictures: previewing ? { ...pictures, ...previewing.pictures } : pictures });
  applied = true;
  // (Without the style's colours, an accent of the reader's own — set inline by applyChrome — comes back.)
  if (!useThemeColours) for (const [k, v] of kept) if (v) html.style.setProperty(k, v);
  html.dataset.ui = got.mode;
  html.classList.toggle('g-page-bars', s.uiMode === 'page' && !def.force);
  if ((got.mode === 'light') === pageIsLight(s)) html.dataset.gMatch = ''; else delete html.dataset.gMatch;
  html.classList.toggle('g-reading', parseRoute().name === 'read');
  local.textContent = readPrimary ? `html[data-glass] .reader{--md-primary:${readPrimary}}` : '';
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', got.ground);
}
