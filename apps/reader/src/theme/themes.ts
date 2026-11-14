// Themes: frosted-glass looks laid over the Material 3 roles both Kurokawa apps already use (--md-*), and the
// choice of how much blur a device can afford. Self-contained, shared by the apps: no import from either app.
// The app gives `applyTheme` the reader's choices (theme, light or dark, dark tone, accent, blur) and the picture
// a downloaded theme brought (an object URL); this file turns them into CSS custom properties on <html>, which
// glass.css (beside this file) reads. «Classic» sets nothing: the app's own stylesheet, exactly as before.

export type Mode = 'light' | 'dark';
export type DarkTone = 'default' | 'grey' | 'black';
export type BlurPref = 'auto' | 'full' | 'reduced' | 'off';
export type Blur = 'full' | 'reduced' | 'off';

/** The opaque surfaces a theme stands on: the page's ground, then the M3 surface containers. */
export interface Surfaces { ground: string; lowest: string; low: string; mid: string; high: string; highest: string }
export interface TextRoles { on: string; variant: string; dim: string; outline: string; outlineVariant: string }
export interface Roles { primary: string; onPrimary: string; primaryContainer: string; onPrimaryContainer: string; secondaryContainer: string; onSecondaryContainer: string; tertiaryContainer: string; onTertiaryContainer: string }

/** One mode (dark or light) of a theme. Colours are CSS; the alphas and tints are what makes it glass. */
export interface ModeTokens {
  /** Surfaces; absent: the app's own for this mode and dark tone (so a chosen dark tone stays). */
  surfaces?: Surfaces;
  text?: TextRoles;
  /** The theme's own colours, used when the accent is «the theme's». */
  roles?: Roles;
  /** The page's background: CSS image layers (gradients; may use var(--md-primary) and the other roles). */
  bg: string;
  /** A picture from the theme's pack laid under `bg`'s layers (its asset name), and a veil over it. */
  picture?: string; veil?: string;
  /** A blur over the background itself (px; the reader's own picture, softened). */
  bgBlur?: number;
  /** The brightest and the darkest colour the background shows once blurred (the contrast test reads them). */
  extremes: [string, string];
  /** Tints of the glass layers: bars and the rail, cards, sheets/dialogs/menus; rgba() or {from surface, alpha}. */
  pane: Tint; card: Tint; sheet: Tint;
  /** Alpha of the surface containers (chips, fields, rows) laid on the glass. */
  fill: number;
  /** Blur radius (px) and saturation of the full glass; hairline edge colour; inner sheen; depth shadow. */
  blur: number; sat: number; edge: string; sheen: string; shadow: string;
  /** The scrim under a sheet. */
  scrim?: string;
}
export type Tint = string | { from: keyof Surfaces; a: number };
export interface ThemeDef {
  id: string;
  /** A theme the reader made (theme/custom.ts): its base theme's id. */
  custom?: boolean; base?: string;
  /** The name: an i18n key of the app's, or a proper name shown as is. */
  nameKey?: string; name?: string;
  /** Who made it (shown «by …»); its licence notice (shipped in the app and in its pack). */
  by?: string; notice?: string;
  /** No glass at all: the app's look as it was. */
  classic?: boolean;
  /** A theme made for one mode only forces it. */
  force?: Mode;
  dark?: ModeTokens; light?: ModeTokens;
  /** Corner radii (px) replacing the app's --sh-* scale. */
  radius?: Partial<Record<'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl', number>>;
  /** Pictures fetched on demand: the pack's id, its size (shown before downloading) and its assets by mode. */
  pack?: { id: string; size: number; assets: Partial<Record<Mode, string>> };
  /** Uses the reader's accent (true) or carries its own roles. */
  followsAccent?: boolean;
  /** The colours the gallery's miniature is drawn from, when the theme is not applied. */
}

/* ---------- the app's own surfaces (the same values as base.css), by mode and dark tone ---------- */
export const APP_SURFACES: Record<'light' | DarkTone, Surfaces> = {
  default: { ground: '#121314', lowest: '#0c0d0e', low: '#1a1b1d', mid: '#1e2022', high: '#282a2d', highest: '#323437' },
  grey: { ground: '#1c1b1f', lowest: '#0f0e11', low: '#232227', mid: '#28272b', high: '#323135', highest: '#3d3c41' },
  black: { ground: '#000000', lowest: '#000000', low: '#0e0f10', mid: '#151617', high: '#1f2022', highest: '#2a2b2e' },
  light: { ground: '#f7f8fa', lowest: '#ffffff', low: '#f1f3f5', mid: '#eaedf0', high: '#e3e6ea', highest: '#dcdfe4' },
};
export const APP_TEXT: Record<Mode, TextRoles> = {
  dark: { on: '#e4e4e6', variant: '#c6c8cc', dim: '#9a9ca1', outline: '#8e9196', outlineVariant: '#44474c' },
  light: { on: '#1a1c1e', variant: '#43474c', dim: '#6b7077', outline: '#767a80', outlineVariant: '#c5c8cd' },
};

const MIT = (who: string, year: string) => `MIT License

Copyright (c) ${year} ${who}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
/** The Frosted Glass themes' notice: their look (palette, glass, radii, shadows) and their two pictures. */
export const FROSTED_NOTICE = `Frosted Glass, Frosted Glass Light, Frosted Glass Dark — Home Assistant themes by Wessam Lauf (version 1.4.0),
ported to this app's colour roles; the two background pictures are shipped unchanged.

${MIT('Wessam Lauf', '2025')}`;

/* ---------- our own themes ---------- */
// Shared M3 Expressive depth: a soft key light from above, a long ambient shadow under the glass.
const SHEEN_DARK = 'inset 0 1px 0 rgb(255 255 255 / .12), inset 0 0 0 1px rgb(255 255 255 / .03)';
const SHEEN_LIGHT = 'inset 0 1px 0 rgb(255 255 255 / .7), inset 0 0 0 1px rgb(255 255 255 / .35)';
const SHADOW_DARK = '0 18px 44px -14px rgb(0 0 0 / .6), 0 2px 8px rgb(0 0 0 / .28)';
const SHADOW_LIGHT = '0 16px 40px -16px rgb(28 36 60 / .28), 0 2px 6px rgb(28 36 60 / .08)';
const M3E_RADII = { xs: 8, sm: 12, md: 16, lg: 20, xl: 28, xxl: 36 };

/** «Frost × Material 3 Expressive»: today's graphite, darker and layered — deep, desaturated fields of the accent's
 *  containers under dark glass; depth from colour at low luminance, never from grey light. */
const FROST: ThemeDef = {
  id: 'frost', nameKey: 'themeFrost', followsAccent: true, radius: M3E_RADII,
  dark: {
    text: { on: '#e2e4e8', variant: '#b4b8bf', dim: '#8f949c', outline: '#7d828a', outlineVariant: '#2c3036' },
    // (Three fields you can only just tell apart: blue-graphite ink above, the accent's container low at the side, a cooler ink at the foot.)
    bg: 'radial-gradient(90% 46% at 0% -6%, color-mix(in srgb, var(--md-tertiary-container) 34%, transparent), transparent 72%),'
      + ' radial-gradient(70% 44% at 104% 46%, color-mix(in srgb, var(--md-primary-container) 16%, transparent), transparent 70%),'
      + ' radial-gradient(100% 46% at 20% 108%, color-mix(in srgb, var(--md-tertiary-container) 26%, transparent), transparent 72%)',
    extremes: ['#1c2026', '#17181b'],
    pane: { from: 'low', a: .66 }, card: { from: 'low', a: .5 }, sheet: { from: 'mid', a: .86 }, fill: .55,
    blur: 28, sat: 1, edge: 'rgb(255 255 255 / .07)', sheen: 'inset 0 1px 0 rgb(255 255 255 / .055)', shadow: '0 16px 40px -18px rgb(0 0 0 / .8), 0 1px 3px rgb(0 0 0 / .4)', scrim: 'rgb(4 4 4 / .62)',
  },
  light: {
    text: { on: '#171a1d', variant: '#3b4047', dim: '#535860', outline: '#6d727a', outlineVariant: '#c5c9cf' },
    bg: 'radial-gradient(70% 48% at 8% -4%, color-mix(in srgb, var(--md-primary-container) 46%, transparent), transparent 72%),'
      + ' radial-gradient(60% 46% at 104% 34%, color-mix(in srgb, var(--md-tertiary-container) 50%, transparent), transparent 70%),'
      + ' radial-gradient(80% 52% at 26% 106%, color-mix(in srgb, var(--md-secondary-container) 56%, transparent), transparent 72%)',
    extremes: ['#ffffff', '#c9cfd8'],
    pane: { from: 'lowest', a: .62 }, card: { from: 'lowest', a: .55 }, sheet: { from: 'lowest', a: .8 }, fill: .7,
    blur: 26, sat: 1, edge: 'rgb(255 255 255 / .6)', sheen: SHEEN_LIGHT, shadow: SHADOW_LIGHT, scrim: 'rgb(31 34 43 / .32)',
  },
};
/** The soft charcoal the default stands on (and a neutral paper in light); kept colours use the app's own instead. */
export const FROST_GRAPHITE: Surfaces = { ground: '#17181b', lowest: '#111214', low: '#1c1d20', mid: '#222326', high: '#2a2b2e', highest: '#333437' };
export const FROST_LIGHT: Surfaces = { ground: '#ebebe9', lowest: '#fbfbfa', low: '#f5f5f3', mid: '#efefed', high: '#e6e6e3', highest: '#dddddb' };

const CLASSIC: ThemeDef = { id: 'classic', nameKey: 'themeClassic', classic: true, followsAccent: true };

/** Aurora: a polar night with the faintest curtains of sea-green and lilac, close to grey; in light, the same on ice. */
const AURORA: ThemeDef = {
  id: 'aurora', nameKey: 'themeAurora', radius: M3E_RADII,
  dark: {
    surfaces: { ground: '#131417', lowest: '#0f1012', low: '#18191d', mid: '#1e1f24', high: '#26282d', highest: '#2f3137' },
    text: { on: '#eceef1', variant: '#cfd5df', dim: '#b6bfcc', outline: '#8693a6', outlineVariant: '#374151' },
    roles: { primary: '#a1c0bc', onPrimary: '#172020', primaryContainer: '#293d3b', onPrimaryContainer: '#ccdddb', secondaryContainer: '#2d3342', onSecondaryContainer: '#e1e4ea', tertiaryContainer: '#453e5c', onTertiaryContainer: '#eceaf0' },
    bg: 'radial-gradient(90% 34% at 30% -6%, rgb(121 149 145 / .22), transparent 70%),'
      + ' radial-gradient(46% 60% at 96% 18%, rgb(164 159 179 / .30), transparent 70%),'
      + ' radial-gradient(70% 40% at 0% 70%, rgb(106 120 134 / .22), transparent 70%),'
      + ' radial-gradient(80% 40% at 70% 108%, rgb(84 106 103 / .2), transparent 70%)',
    extremes: ['#334549', '#131417'],
    pane: { from: 'mid', a: .58 }, card: { from: 'low', a: .48 }, sheet: { from: 'mid', a: .76 }, fill: .6,
    blur: 30, sat: 1, edge: 'rgb(208 215 217 / .12)', sheen: 'inset 0 1px 0 rgb(219 225 226 / .09), inset 0 0 0 1px rgb(219 225 226 / .04)', shadow: SHADOW_DARK, scrim: 'rgb(7 7 7 / .55)',
  },
  light: {
    surfaces: { ground: '#e7e9ea', lowest: '#fafbfb', low: '#f2f3f4', mid: '#ebedee', high: '#e1e4e5', highest: '#d7dadb' },
    text: { on: '#141a1d', variant: '#303e47', dim: '#42515b', outline: '#6c7b85', outlineVariant: '#bdcbd2' },
    roles: { primary: '#314847', onPrimary: '#ffffff', primaryContainer: '#c8d9d7', onPrimaryContainer: '#0d1313', secondaryContainer: '#e0e4e9', onSecondaryContainer: '#1c2129', tertiaryContainer: '#ecebf0', onTertiaryContainer: '#2b2738' },
    bg: 'radial-gradient(90% 36% at 28% -8%, rgb(138 162 158 / .32), transparent 70%),'
      + ' radial-gradient(50% 60% at 100% 20%, rgb(194 191 204 / .28), transparent 70%),'
      + ' radial-gradient(80% 44% at 50% 110%, rgb(180 188 195 / .26), transparent 70%)',
    extremes: ['#ffffff', '#c2cbd3'],
    pane: { from: 'lowest', a: .6 }, card: { from: 'lowest', a: .55 }, sheet: { from: 'lowest', a: .8 }, fill: .7,
    blur: 28, sat: 1, edge: 'rgb(255 255 255 / .65)', sheen: SHEEN_LIGHT, shadow: '0 16px 40px -16px rgb(45 52 56 / .26), 0 2px 6px rgb(45 52 56 / .08)', scrim: 'rgb(25 29 31 / .32)',
  },
};

/** Obsidian: true black for OLED screens; the glass is drawn by its edges, lit in the accent. */
const OBSIDIAN: ThemeDef = {
  id: 'obsidian', nameKey: 'themeObsidian', force: 'dark', followsAccent: true, radius: { xs: 6, sm: 10, md: 14, lg: 18, xl: 24, xxl: 32 },
  dark: {
    surfaces: { ground: '#000000', lowest: '#000000', low: '#090909', mid: '#0e0e0f', high: '#17181a', highest: '#222225' },
    text: { on: '#ececee', variant: '#c8c9cd', dim: '#9fa1a6', outline: '#8a8c91', outlineVariant: '#3a3c40' },
    bg: 'radial-gradient(120% 30% at 50% -18%, color-mix(in srgb, var(--md-primary) 16%, transparent), transparent 70%)',
    extremes: ['#24262a', '#000000'],
    pane: { from: 'lowest', a: .72 }, card: { from: 'low', a: .55 }, sheet: { from: 'low', a: .86 }, fill: .7,
    blur: 20, sat: 1, edge: 'color-mix(in srgb, var(--md-primary) 30%, transparent)',
    sheen: 'inset 0 1px 0 color-mix(in srgb, var(--md-primary) 32%, transparent), inset 0 0 18px -10px color-mix(in srgb, var(--md-primary) 40%, transparent)',
    shadow: '0 0 0 1px rgb(0 0 0 / .9), 0 18px 40px -16px color-mix(in srgb, var(--md-primary) 18%, transparent)', scrim: 'rgb(0 0 0 / .7)',
  },
};

/** Indigo Paper: rice paper with indigo ink in its fibres; in the dark, the ink stone (sumi) it was ground on. */
const WASHI: ThemeDef = {
  id: 'washi', nameKey: 'themeWashi', radius: { xs: 6, sm: 10, md: 14, lg: 16, xl: 22, xxl: 28 },
  light: {
    surfaces: { ground: '#ebebe9', lowest: '#fbfbfa', low: '#f5f5f3', mid: '#efefed', high: '#e6e6e3', highest: '#dddddb' },
    text: { on: '#1b1e27', variant: '#343a4d', dim: '#3e455b', outline: '#6c7490', outlineVariant: '#c5c9d7' },
    roles: { primary: '#4e5475', onPrimary: '#ffffff', primaryContainer: '#ebebf1', onPrimaryContainer: '#252736', secondaryContainer: '#e5e5ed', onSecondaryContainer: '#1c1e2a', tertiaryContainer: '#e4e5ea', onTertiaryContainer: '#1d1f26' },
    // (Long fibres across the sheet, a grey-blue ink soaked in from the upper corner, the paper's own grey at the foot.)
    bg: 'repeating-linear-gradient(100deg, rgb(86 90 109 / .045) 0 1px, transparent 1px 9px),'
      + ' repeating-linear-gradient(8deg, rgb(96 98 104 / .03) 0 1px, transparent 1px 13px),'
      + ' radial-gradient(80% 46% at 100% -4%, rgb(86 90 109 / .26), transparent 70%),'
      + ' radial-gradient(60% 34% at 0% 30%, rgb(86 90 109 / .12), transparent 70%),'
      + ' radial-gradient(80% 50% at 10% 104%, rgb(170 171 175 / .34), transparent 70%)',
    extremes: ['#ffffff', '#bbbfcf'],
    pane: { from: 'lowest', a: .66 }, card: { from: 'lowest', a: .62 }, sheet: { from: 'lowest', a: .86 }, fill: .72,
    blur: 18, sat: 1, edge: 'rgb(86 90 109 / .12)', sheen: 'inset 0 1px 0 rgb(255 255 255 / .8)', shadow: '0 10px 30px -14px rgb(30 31 36 / .25), 0 1px 3px rgb(30 31 36 / .1)', scrim: 'rgb(30 31 36 / .3)',
  },
  dark: {
    surfaces: { ground: '#1a1c1d', lowest: '#141516', low: '#1f2122', mid: '#252728', high: '#2d3031', highest: '#36393a' },
    text: { on: '#e8e9ef', variant: '#c4c8d6', dim: '#9ca2b4', outline: '#878ea3', outlineVariant: '#3a4054' },
    roles: { primary: '#d5d7e2', onPrimary: '#373b52', primaryContainer: '#484d6a', onPrimaryContainer: '#ebebf1', secondaryContainer: '#2d3141', onSecondaryContainer: '#e5e6ec', tertiaryContainer: '#3d3f46', onTertiaryContainer: '#e3e4ea' },
    bg: 'repeating-linear-gradient(102deg, rgb(216 216 223 / .018) 0 1px, transparent 1px 7px),'
      + ' radial-gradient(70% 40% at 100% 0%, rgb(144 146 166 / .22), transparent 70%),'
      + ' radial-gradient(70% 46% at 0% 100%, rgb(110 112 120 / .14), transparent 70%)',
    extremes: ['#333647', '#1a1c1d'],
    pane: { from: 'mid', a: .66 }, card: { from: 'low', a: .55 }, sheet: { from: 'mid', a: .82 }, fill: .65,
    blur: 18, sat: 1, edge: 'rgb(216 216 223 / .1)', sheen: 'inset 0 1px 0 rgb(236 236 239 / .06)', shadow: SHADOW_DARK, scrim: 'rgb(7 7 7 / .55)',
  },
};

/* ---------- Frosted Glass (Wessam Lauf), ported ---------- */
// Their values: header rgba(2,6,11,.10) blur 8 sat 1.1 (dark) / rgba(254,244,242,.10) blur 6 sat 1.2 (light);
// sidebar .10 blur 20 sat 1.3/1.35; cards transparent, blur 10/8 sat 1.25, 0.5px border rgba(234,235,238,.22) /
// rgba(255,255,255,.3), radius 18; popups rgba(…, .35) blur 18 sat 1.2; text rgba(234,235,238,.98)/.8 and
// rgba(19,21,54,.98)/.8; primary #8b9fad / #8e91af. Our panes carry a little more tint than theirs where text sits
// on them, secondary text is a little more opaque (.9/.88 for their .8) and the light picture gets a .3 veil (theirs
// none), so text stays readable (≥ 4.5:1) over the brightest and darkest parts of their pictures.
const FG_DARK: ModeTokens = {
  surfaces: { ground: '#060606', lowest: '#040404', low: '#101112', mid: '#151617', high: '#1f2123', highest: '#292c2f' },
  text: { on: 'rgb(234 235 238 / .98)', variant: 'rgb(234 235 238 / .9)', dim: 'rgb(234 235 238 / .88)', outline: 'rgb(234 235 238 / .5)', outlineVariant: 'rgb(90 111 128 / .45)' },
  roles: { primary: '#7fa1b9', onPrimary: '#0b1114', primaryContainer: '#2c4251', onPrimaryContainer: '#e5ecf1', secondaryContainer: 'rgb(127 161 185 / .24)', onSecondaryContainer: '#e5ecf1', tertiaryContainer: '#426279', onTertiaryContainer: '#f2f6f8' },
  // (The stand-in until the picture is here: their dark room — a cold blue light upper left, a pale floor.)
  bg: 'radial-gradient(42% 30% at 24% 26%, rgb(62 73 88 / .55), transparent 70%),'
    + ' radial-gradient(40% 30% at 48% 46%, rgb(90 96 110 / .45), transparent 70%),'
    + ' radial-gradient(60% 10% at 56% 74%, rgb(120 128 140 / .32), transparent 70%),'
    + ' radial-gradient(40% 30% at 82% 10%, rgb(70 66 72 / .45), transparent 70%),'
    + ' radial-gradient(40% 30% at 6% 92%, rgb(53 37 48 / .4), transparent 70%)',
  picture: 'bg-dark', extremes: ['#5a5f6b', '#010101'],
  pane: 'rgb(6 6 6 / .38)', card: 'rgb(6 6 6 / .22)', sheet: 'rgb(6 6 6 / .55)', fill: .5,
  blur: 18, sat: 1, edge: 'rgb(234 235 238 / .22)',
  sheen: '3px 3px .5px -3.5px rgb(255 255 255 / .3) inset, -2px -2px .5px -2px rgb(255 255 255 / .2) inset, 0 0 8px 1px rgb(255 255 255 / .06) inset, 0 0 2px 0 rgb(0 0 0 / .18)',
  shadow: '0 14px 38px rgb(0 0 0 / .34), 0 2px 10px rgb(0 0 0 / .24)', scrim: 'rgb(0 0 0 / .5)',
};
const FG_LIGHT: ModeTokens = {
  surfaces: { ground: '#f8f8f8', lowest: '#ffffff', low: '#f9f9f9', mid: '#f3f1f1', high: '#eae8e9', highest: '#e2dee3' },
  text: { on: 'rgb(30 30 43 / .98)', variant: 'rgb(30 30 43 / .92)', dim: 'rgb(30 30 43 / .86)', outline: 'rgb(30 30 43 / .5)', outlineVariant: 'rgb(30 30 43 / .16)' },
  roles: { primary: '#5e65a8', onPrimary: '#ffffff', primaryContainer: 'rgb(130 135 187 / .24)', onPrimaryContainer: '#1a1b2f', secondaryContainer: 'rgb(255 255 255 / .55)', onSecondaryContainer: '#1a1b2f', tertiaryContainer: '#ebebf3', onTertiaryContainer: '#1a1b2f' },
  // (Their morning sky: blush at the upper left to periwinkle at the lower right.)
  bg: 'linear-gradient(118deg, #f6f5f3 0%, #ececf1 26%, #d8dde3 52%, #b8c0cd 76%, #8e96b0 100%)',
  picture: 'bg-light', veil: 'linear-gradient(rgb(249 247 247 / .3), rgb(249 247 247 / .3))', extremes: ['#faf9f8', '#707b9a'],
  pane: 'rgb(248 248 248 / .42)', card: 'rgb(248 248 248 / .4)', sheet: 'rgb(248 248 248 / .62)', fill: .55,
  blur: 16, sat: 1, edge: 'rgb(255 255 255 / .3)',
  sheen: '3px 3px .5px -3.5px rgb(255 255 255 / .3) inset, -2px -2px .5px -2px rgb(255 255 255 / .3) inset, 0 0 8px 1px rgb(255 255 255 / .1) inset, 0 0 2px 0 rgb(0 0 0 / .1)',
  shadow: '0 10px 32px rgb(28 29 38 / .12), 0 2px 8px rgb(28 29 38 / .08)', scrim: 'rgb(0 0 0 / .38)',
};
const FG_RADII = { xs: 8, sm: 12, md: 14, lg: 18, xl: 22, xxl: 28 };
const FG_PACK = { id: 'frosted-glass', size: 784_506, assets: { dark: 'bg-dark', light: 'bg-light' } as Partial<Record<Mode, string>> };
const FG_BASE = { by: 'Wessam Lauf', notice: FROSTED_NOTICE, radius: FG_RADII };
const FROSTED: ThemeDef = { ...FG_BASE, id: 'frosted-glass', name: 'Frosted Glass', dark: FG_DARK, light: FG_LIGHT, pack: FG_PACK };
const FROSTED_LIGHT: ThemeDef = { ...FG_BASE, id: 'frosted-glass-light', name: 'Frosted Glass Light', force: 'light', light: FG_LIGHT, pack: { ...FG_PACK, size: 784_506, assets: { light: 'bg-light' } } };
const FROSTED_DARK: ThemeDef = { ...FG_BASE, id: 'frosted-glass-dark', name: 'Frosted Glass Dark', force: 'dark', dark: FG_DARK, pack: { ...FG_PACK, size: 784_506, assets: { dark: 'bg-dark' } } };

export const THEMES: ThemeDef[] = [FROST, AURORA, OBSIDIAN, WASHI, FROSTED, FROSTED_LIGHT, FROSTED_DARK, CLASSIC];
export const DEFAULT_THEME = 'frost';
export const themeById = (id: string | undefined): ThemeDef => THEMES.find((x) => x.id === id) ?? FROST;
/** A theme made by the reader: added (or replaced) among «My themes»; removed again. */
export function upsertTheme(def: ThemeDef): void { const i = THEMES.findIndex((x) => x.id === def.id); if (i >= 0) THEMES[i] = def; else THEMES.push(def); }
export function removeTheme(id: string): void { const i = THEMES.findIndex((x) => x.id === id && x.custom); if (i >= 0) THEMES.splice(i, 1); }
/** A theme that came in a pack (its tokens in the pack's header), added before Classic. */
export function registerTheme(def: ThemeDef): void {
  if (!def || typeof def.id !== 'string' || THEMES.some((x) => x.id === def.id) || !(def.dark || def.light)) return;
  const at = THEMES.findIndex((x) => x.classic); THEMES.splice(at < 0 ? THEMES.length : at, 0, { ...def, classic: false, custom: false });
}

/* ---------- colour arithmetic (sRGB), for alpha blending and WCAG contrast ---------- */
export type RGBA = [number, number, number, number];
export function parseColor(c: string): RGBA {
  const s = c.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) { let x = m[1]; if (x.length === 3) x = x.split('').map((k) => k + k).join(''); const n = parseInt(x.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, x.length === 8 ? parseInt(x.slice(6), 16) / 255 : 1]; }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) { const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]); return [+m[1], +m[2], +m[3], a]; }
  throw new Error(`colour not understood: ${c}`);
}
/** `top` laid over the opaque `under`. */
export function over(top: RGBA, under: RGBA): RGBA { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; }
export function luminance(c: RGBA): number { const f = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
export function contrast(a: RGBA, b: RGBA): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const css = (c: RGBA): string => `rgb(${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])}${c[3] < 1 ? ` / ${+c[3].toFixed(3)}` : ''})`;

/* ---------- what a theme resolves to for a reader's choices ---------- */
export interface Choice { theme: string; mode: Mode; darkTone: DarkTone; useThemeColours: boolean; keepColours?: boolean }
export interface Resolved { def: ThemeDef; mode: Mode; tokens: ModeTokens | null; surfaces: Surfaces; text: TextRoles; roles: Roles | null; pane: RGBA; card: RGBA; sheet: RGBA }
/** The mode a theme shows in: forced by a one-mode theme, else the reader's (a theme without it: Frost's). */
export const modeFor = (def: ThemeDef, wanted: Mode): Mode => def.force ?? wanted;
export function resolve(c: Choice): Resolved {
  const def = themeById(c.theme); const mode = modeFor(def, c.mode);
  const own = mode === 'dark' ? def.dark : def.light;
  const tokens = def.classic ? null : own ?? (mode === 'dark' ? FROST.dark! : FROST.light!);
  const appS = mode === 'light' ? APP_SURFACES.light : APP_SURFACES[c.darkTone];
  // (Frost follows the dark tone: the refined graphite for the default, unless the earlier colours were kept.)
  const surfaces = tokens?.surfaces ?? (mode === 'dark' ? (c.darkTone === 'default' && !c.keepColours ? FROST_GRAPHITE : appS) : c.keepColours ? appS : FROST_LIGHT);
  const text = tokens?.text ?? APP_TEXT[mode];
  const tint = (t: Tint): RGBA => { if (typeof t === 'string') return parseColor(t); const b = parseColor(surfaces[t.from]); return [b[0], b[1], b[2], t.a]; };
  return { def, mode, tokens, surfaces: def.classic ? appS : surfaces, text, roles: c.useThemeColours ? tokens?.roles ?? null : null, pane: tokens ? tint(tokens.pane) : [0, 0, 0, 0], card: tokens ? tint(tokens.card) : [0, 0, 0, 0], sheet: tokens ? tint(tokens.sheet) : [0, 0, 0, 0] };
}

/** Contrast of each text role on each glass layer over the background's brightest and darkest parts (and on the bare background). */
export function contrastReport(r: Resolved): { layer: string; text: string; over: string; ratio: number }[] {
  if (!r.tokens) return [];
  const out: { layer: string; text: string; over: string; ratio: number }[] = [];
  const ground = parseColor(r.surfaces.ground);
  for (const ex of r.tokens.extremes) {
    let back = over(parseColor(ex), ground);
    if (r.tokens.veil) { const v = /rgba?\([^)]*\)/.exec(r.tokens.veil); if (v) back = over(parseColor(v[0]), back); }
    const layers: [string, RGBA][] = [['background', back], ['pane', over(r.pane, back)], ['card', over(r.card, back)], ['sheet', over(r.sheet, back)]];
    for (const [layer, under] of layers) for (const k of ['on', 'variant', 'dim'] as const) out.push({ layer, text: k, over: ex, ratio: contrast(over(parseColor(r.text[k]), under), under) });
  }
  return out;
}

/* ---------- blur: what the reader chose, what the device can afford ---------- */
export interface Env { platform: 'android' | 'desktop' | 'web'; phone: boolean; webkitGtk: boolean; deviceMemory?: number; reducedTransparency: boolean; reducedMotion: boolean; lowBattery: boolean }
/** Per platform, measured (see the report in the change that brought this file): Android and phone-sized web
 *  get Reduced; a computer Full; WebKitGTK (the Linux Tauri shell) Reduced. */
export function platformDefault(env: Env): Blur { if (env.webkitGtk) return 'reduced'; if (env.platform === 'android' || env.phone) return 'reduced'; return 'full'; }
export function resolveBlur(pref: BlurPref, env: Env): { blur: Blur; why: 'chosen' | 'platform' | 'memory' | 'transparency' | 'motion' | 'battery' } {
  if (pref !== 'auto') return { blur: pref, why: 'chosen' };
  if (env.reducedTransparency) return { blur: 'off', why: 'transparency' };
  const base = platformDefault(env);
  if (base === 'full') {
    if (env.deviceMemory !== undefined && env.deviceMemory <= 4) return { blur: 'reduced', why: 'memory' };
    if (env.reducedMotion) return { blur: 'reduced', why: 'motion' };
    if (env.lowBattery) return { blur: 'reduced', why: 'battery' };
  } else if (env.deviceMemory !== undefined && env.deviceMemory <= 2) return { blur: 'off', why: 'memory' };
  else if (env.lowBattery) return { blur: 'off', why: 'battery' };
  return { blur: base, why: 'platform' };
}
/** The environment as this browser tells it (the battery is read by the app, which may know more). */
export function readEnv(platform: Env['platform'], lowBattery = false): Env {
  const mm = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return {
    platform, phone: mm('(max-width: 719px)') || mm('(pointer: coarse)'),
    webkitGtk: /Linux/.test(ua) && /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android/.test(ua),
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    reducedTransparency: mm('(prefers-reduced-transparency: reduce)'), reducedMotion: mm('(prefers-reduced-motion: reduce)'), lowBattery,
  };
}

/* ---------- applying it ---------- */
const SET = new Set<string>();
function put(html: HTMLElement, k: string, v: string): void { html.style.setProperty(k, v); SET.add(k); }
const ROLE_VARS: [keyof Roles, string][] = [['primary', '--md-primary'], ['onPrimary', '--md-on-primary'], ['primaryContainer', '--md-primary-container'], ['onPrimaryContainer', '--md-on-primary-container'], ['secondaryContainer', '--md-secondary-container'], ['onSecondaryContainer', '--md-on-secondary-container'], ['tertiaryContainer', '--md-tertiary-container'], ['onTertiaryContainer', '--md-on-tertiary-container']];
export interface ApplyState extends Choice { blur: Blur; /** Object URLs of a downloaded theme's pictures, by asset name. */ pictures?: Record<string, string> }
/** Sets the theme on <html>; returns the mode shown and the ground colour (for the browser's bar). Classic clears everything. */
export function applyTheme(html: HTMLElement, st: ApplyState): { mode: Mode; ground: string; glass: boolean } {
  for (const k of SET) html.style.removeProperty(k); SET.clear();
  const r = resolve(st);
  html.dataset.theme = r.def.id;
  if (!r.tokens) { delete html.dataset.glass; delete html.dataset.picture; return { mode: r.mode, ground: r.surfaces.ground, glass: false }; }
  const t = r.tokens; html.dataset.glass = st.blur;
  const S = r.surfaces; const g = parseColor(S.ground);
  put(html, '--md-surface', S.ground); put(html, '--th-ground', S.ground);
  const fillOf = (hex: string) => { const c = parseColor(hex); return css([c[0], c[1], c[2], t.fill]); };
  put(html, '--md-surface-container-lowest', fillOf(S.lowest)); put(html, '--md-surface-container-low', fillOf(S.low)); put(html, '--md-surface-container', fillOf(S.mid));
  put(html, '--md-surface-container-high', fillOf(S.high)); put(html, '--md-surface-container-highest', fillOf(S.highest));
  // (Opaque versions, for what floats over moving content without a blur of its own.)
  for (const [k, v] of [['lowest', S.lowest], ['low', S.low], ['mid', S.mid], ['high', S.high], ['highest', S.highest]] as const) put(html, `--th-solid-${k}`, v);
  put(html, '--md-on-surface', r.text.on); put(html, '--md-on-surface-variant', r.text.variant); put(html, '--md-on-surface-dim', r.text.dim); put(html, '--md-outline', r.text.outline); put(html, '--md-outline-variant', r.text.outlineVariant);
  if (r.roles) for (const [k, v] of ROLE_VARS) put(html, v, r.roles[k]);
  // (Without blur, «solid» glass: the tint laid over the background's middle tone, opaque — the same palette, nothing seen through.)
  const [hi, lo] = t.extremes.map((x) => over(parseColor(x), g)); const mid: RGBA = [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2, 1];
  for (const [name, tint] of [['pane', r.pane], ['card', r.card], ['sheet', r.sheet]] as const) { put(html, `--g-${name}-t`, css(tint)); put(html, `--g-${name}-s`, css(over([tint[0], tint[1], tint[2], Math.max(tint[3], .82)], mid))); }
  put(html, '--g-blur', `${t.blur}px`); put(html, '--g-sat', String(t.sat)); put(html, '--g-edge', t.edge); put(html, '--g-sheen', t.sheen); put(html, '--g-shadow', t.shadow);
  if (t.scrim) put(html, '--md-scrim', t.scrim);
  const pic = t.picture ? st.pictures?.[t.picture] : undefined;
  put(html, '--th-bg', [t.veil && pic ? t.veil : '', pic ? `url("${pic}")` : '', t.bg].filter(Boolean).join(', ') || 'none');
  if (pic && t.bgBlur) { put(html, '--th-bg-filter', `blur(${t.bgBlur}px)`); put(html, '--th-bg-bleed', `${Math.round(t.bgBlur * 2)}px`); }
  if (pic) html.dataset.picture = '1'; else delete html.dataset.picture;
  for (const [k, v] of Object.entries(r.def.radius ?? {})) put(html, `--sh-${k}`, `${v}px`);
  return { mode: r.mode, ground: S.ground, glass: true };
}

/* ---------- moving earlier settings to themes (once) ---------- */
export interface OldLook { uiMode?: string; darkTone?: string; accent?: string; accentCustom?: string }
/** What an install gets the first time this code runs: everyone the new default; who had chosen their own dark
 *  tone or accent keeps those colours under the glass. `stored` is null on a fresh install. */
export function migrateLook(stored: OldLook | null): { theme: string; keepColours: boolean } {
  if (!stored) return { theme: DEFAULT_THEME, keepColours: false };
  const custom = (stored.darkTone !== undefined && stored.darkTone !== 'default') || (stored.accent !== undefined && stored.accent !== 'graphite');
  return { theme: DEFAULT_THEME, keepColours: custom };
}

/** The colours a gallery card is drawn with: ground, the glass, the text, the accent; and its background layers. */
/** The default accent's roles (graphite, as base.css has them): what a theme that follows the accent is previewed with. */
export const GRAPHITE: Record<Mode, Roles> = {
  dark: { primary: '#c9ccd2', onPrimary: '#1f2226', primaryContainer: '#3a3e45', onPrimaryContainer: '#e6e8ec', secondaryContainer: '#2e3237', onSecondaryContainer: '#dfe2e6', tertiaryContainer: '#2b3540', onTertiaryContainer: '#d6e1ec' },
  light: { primary: '#3f444b', onPrimary: '#ffffff', primaryContainer: '#dfe2e6', onPrimaryContainer: '#15181b', secondaryContainer: '#e6e8ec', onSecondaryContainer: '#1a1d20', tertiaryContainer: '#d8e3ee', onTertiaryContainer: '#0f1d2a' },
};
export interface Preview { mode: Mode; ground: string; bg: string; picture?: string; veil?: string; pane: string; card: string; text: string; dim: string; edge: string; vars: Record<string, string> }
export function previewOf(def: ThemeDef, mode: Mode, darkTone: DarkTone): Preview {
  const r = resolve({ theme: def.id, mode, darkTone, useThemeColours: true });
  const t = r.tokens; const roles = r.roles ?? GRAPHITE[r.mode];
  const vars: Record<string, string> = {}; for (const [k, v] of ROLE_VARS) vars[v] = roles[k];
  return { mode: r.mode, ground: r.surfaces.ground, bg: t?.bg ?? 'none', picture: t?.picture, veil: t?.veil, pane: t ? css(r.pane) : r.surfaces.mid, card: t ? css(r.card) : r.surfaces.low, text: r.text.on, dim: r.text.dim, edge: t?.edge ?? r.text.outlineVariant, vars };
}
/** The modes a theme has (one-mode themes: theirs only). */
export const modesOf = (def: ThemeDef): Mode[] => (def.force ? [def.force] : def.classic ? ['dark', 'light'] : (['dark', 'light'] as Mode[]).filter((m) => (m === 'dark' ? def.dark : def.light)));
