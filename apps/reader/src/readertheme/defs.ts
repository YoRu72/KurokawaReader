// The Reader's own interface styles, in the shared theme format (src/theme/themes.ts — the module both Kurokawa apps
// carry unchanged): a library and reading room in glass. Paper & Ink (paper-white frost with ink-blue, and its ink-wash
// dark), Midnight Stacks (a library after hours: navy glass, oxblood and brass in the dark, brass hairlines), Lamplight
// (amber glass under a reading lamp, dark and light). The shared Obsidian (OLED black, thin luminous edges) and the
// ported Frosted Glass trio come from the shared module. Each dark one at most as bright as Classic's: depth from
// colour at low luminance, never grey slabs.
//
// Their bars and sheets carry .8 of their tint: they float over any page or cover — white or black — and their
// text stays at least 4.5:1 there (tests/glass.cjs). Their cards (.4–.5) sit over the still background only.
import type { ThemeDef } from '../theme/themes';

const RADII_PAPER = { xs: 8, sm: 12, md: 16, lg: 22, xl: 30, xxl: 36 };
const accentBlob = (at: string, size: string, pct: number) => `radial-gradient(${size} at ${at}, color-mix(in srgb, var(--md-primary) ${pct}%, transparent), transparent 70%)`;

export const PAPER_INK: ThemeDef = {
  id: 'paper-ink', nameKey: 'styleNamePaperInk', radius: RADII_PAPER,
  light: {
    surfaces: { ground: '#efe9de', lowest: '#fffdf8', low: '#faf7f0', mid: '#f4f0e7', high: '#ece6da', highest: '#e4ddd0' },
    text: { on: '#1a1c23', variant: '#434754', dim: '#434754', outline: '#5d6270', outlineVariant: 'rgb(26 28 35 / .14)' },
    roles: { primary: '#2f4a7a', onPrimary: '#ffffff', primaryContainer: '#d6e0f2', onPrimaryContainer: '#0d1b33', secondaryContainer: 'rgb(47 74 122 / .14)', onSecondaryContainer: '#14213d', tertiaryContainer: '#d6e0f2', onTertiaryContainer: '#0d1b33' },
    // (Paper at the top left, a cool ink wash at the foot, a sepia stain at the side, the accent faint at the top.)
    bg: 'radial-gradient(70% 60% at 8% 0%, #fbf6ea, transparent 70%), radial-gradient(75% 60% at 100% 100%, rgb(201 211 223 / .85), transparent 75%), radial-gradient(55% 45% at 0% 62%, rgb(228 207 174 / .55), transparent 70%), '
      + accentBlob('92% 6%', '55% 45%', 14),
    extremes: ['#fbf6ea', '#c9d1db'],
    pane: 'rgb(250 247 240 / .8)', card: 'rgb(255 253 248 / .46)', sheet: 'rgb(250 247 240 / .84)', fill: .55,
    blur: 22, sat: 1.35, edge: 'rgb(255 255 255 / .75)', sheen: 'inset 0 1px 0 rgb(255 255 255 / .9)',
    shadow: '0 1px 2px rgb(40 44 60 / .06), 0 10px 28px rgb(40 44 60 / .1)', scrim: 'rgb(30 32 40 / .28)',
  },
  dark: {
    surfaces: { ground: '#0f1217', lowest: '#0b0d11', low: '#161a21', mid: '#1b2029', high: '#242a35', highest: '#2d3441' },
    text: { on: '#ede9e0', variant: '#c4c0b6', dim: '#c4c0b6', outline: '#a29e95', outlineVariant: 'rgb(237 233 224 / .14)' },
    roles: { primary: '#a9c1ea', onPrimary: '#102445', primaryContainer: '#2a3d60', onPrimaryContainer: '#dce6f8', secondaryContainer: 'rgb(169 193 234 / .16)', onSecondaryContainer: '#e3eaf7', tertiaryContainer: '#2a3d60', onTertiaryContainer: '#dce6f8' },
    bg: 'radial-gradient(70% 60% at 0% 0%, #1f2838, transparent 70%), radial-gradient(60% 50% at 100% 90%, rgb(74 58 38 / .45), transparent 60%), radial-gradient(50% 45% at 60% 100%, #0a0c10, transparent 50%), '
      + accentBlob('90% 8%', '50% 45%', 16),
    extremes: ['#2a3346', '#0a0c10'],
    pane: 'rgb(22 26 34 / .8)', card: 'rgb(40 46 60 / .4)', sheet: 'rgb(22 26 34 / .84)', fill: .5,
    blur: 24, sat: 1.3, edge: 'rgb(237 233 224 / .14)', sheen: 'inset 0 1px 0 rgb(255 255 255 / .1)',
    shadow: '0 1px 2px rgb(0 0 0 / .3), 0 12px 32px rgb(0 0 0 / .38)', scrim: 'rgb(0 0 0 / .5)',
  },
};

export const MIDNIGHT_STACKS: ThemeDef = {
  id: 'midnight-stacks', nameKey: 'styleNameMidnight', force: 'dark', radius: { xs: 6, sm: 10, md: 14, lg: 20, xl: 28, xxl: 34 },
  dark: {
    surfaces: { ground: '#090d1b', lowest: '#070a16', low: '#10152a', mid: '#151b33', high: '#1d2440', highest: '#262e4d' },
    text: { on: '#ece9f4', variant: '#c3bfd3', dim: '#c3bfd3', outline: '#a19db4', outlineVariant: 'rgb(214 196 150 / .18)' },
    roles: { primary: '#e2c77f', onPrimary: '#2b2208', primaryContainer: '#4a3b17', onPrimaryContainer: '#f7e6b9', secondaryContainer: 'rgb(226 199 127 / .16)', onSecondaryContainer: '#f3e8cb', tertiaryContainer: '#4a3b17', onTertiaryContainer: '#f7e6b9' },
    // (Navy overhead, oxblood leather at the foot, brass at the side.)
    bg: 'radial-gradient(75% 60% at 20% 0%, #18224a, transparent 75%), radial-gradient(62% 50% at 0% 100%, rgb(74 32 32 / .55), transparent 62%), radial-gradient(50% 40% at 100% 78%, rgb(110 84 36 / .3), transparent 50%), '
      + accentBlob('95% 5%', '45% 40%', 12),
    extremes: ['#1f2a55', '#090d1b'],
    pane: 'rgb(14 19 38 / .8)', card: 'rgb(26 33 62 / .44)', sheet: 'rgb(14 19 38 / .84)', fill: .5,
    blur: 26, sat: 1.4, edge: 'rgb(226 204 152 / .22)', sheen: 'inset 0 1px 0 rgb(255 232 180 / .18)',
    shadow: '0 1px 2px rgb(0 0 0 / .35), 0 14px 36px rgb(2 4 14 / .5)', scrim: 'rgb(2 4 12 / .55)',
  },
};

export const LAMPLIGHT: ThemeDef = {
  id: 'lamplight', nameKey: 'styleNameLamplight', radius: { xs: 8, sm: 14, md: 18, lg: 24, xl: 32, xxl: 40 },
  dark: {
    surfaces: { ground: '#120d08', lowest: '#0d0906', low: '#1c140c', mid: '#231910', high: '#2e2216', highest: '#3a2b1d' },
    text: { on: '#f7ecd9', variant: '#d8c4a4', dim: '#d8c4a4', outline: '#b8a283', outlineVariant: 'rgb(255 206 140 / .16)' },
    roles: { primary: '#f2b65a', onPrimary: '#3a2300', primaryContainer: '#5c3c10', onPrimaryContainer: '#ffe2b5', secondaryContainer: 'rgb(242 182 90 / .18)', onSecondaryContainer: '#fbe6c6', tertiaryContainer: '#5c3c10', onTertiaryContainer: '#ffe2b5' },
    // (The lamp at the top right; its glow falls off into umber; embers at the foot.)
    bg: 'radial-gradient(72% 60% at 100% 0%, rgb(122 78 22 / .75), transparent 72%), radial-gradient(65% 55% at 0% 100%, rgb(62 36 18 / .9), transparent 65%), radial-gradient(28% 22% at 85% 8%, rgb(192 128 42 / .22), transparent 70%), '
      + accentBlob('10% 20%', '45% 40%', 10),
    extremes: ['#5f3f14', '#120d08'],
    pane: 'rgb(32 23 14 / .8)', card: 'rgb(62 44 26 / .42)', sheet: 'rgb(32 23 14 / .84)', fill: .5,
    blur: 24, sat: 1.45, edge: 'rgb(255 206 140 / .2)', sheen: 'inset 0 1px 0 rgb(255 220 170 / .22)',
    shadow: '0 1px 2px rgb(0 0 0 / .3), 0 14px 34px rgb(10 5 0 / .45)', scrim: 'rgb(8 4 0 / .5)',
  },
  light: {
    surfaces: { ground: '#f4e8d2', lowest: '#fffaf0', low: '#fbf3e3', mid: '#f6ecd8', high: '#efe2ca', highest: '#e8d8bd' },
    text: { on: '#29190a', variant: '#55402a', dim: '#55402a', outline: '#6e5841', outlineVariant: 'rgb(110 70 20 / .16)' },
    roles: { primary: '#8a5310', onPrimary: '#ffffff', primaryContainer: '#ffdcae', onPrimaryContainer: '#2c1700', secondaryContainer: 'rgb(138 83 16 / .14)', onSecondaryContainer: '#2c1a06', tertiaryContainer: '#ffdcae', onTertiaryContainer: '#2c1700' },
    bg: 'radial-gradient(70% 60% at 100% 0%, rgb(246 214 153 / .9), transparent 70%), radial-gradient(60% 50% at 0% 30%, #fbf5e9, transparent 60%), radial-gradient(60% 50% at 40% 100%, rgb(237 191 144 / .55), transparent 60%), '
      + accentBlob('0% 100%', '45% 40%', 12),
    extremes: ['#fbf5e9', '#ecc79a'],
    pane: 'rgb(252 245 230 / .8)', card: 'rgb(255 250 238 / .48)', sheet: 'rgb(252 245 230 / .84)', fill: .55,
    blur: 22, sat: 1.4, edge: 'rgb(255 255 255 / .7)', sheen: 'inset 0 1px 0 rgb(255 255 255 / .85)',
    shadow: '0 1px 2px rgb(90 60 20 / .08), 0 10px 28px rgb(90 60 20 / .12)', scrim: 'rgb(40 24 8 / .28)',
  },
};

/** The Reader's gallery, in order: its own three, the shared Obsidian, the ported trio, Classic (the default) last —
 *  as the shared module keeps it, so a style from a pack goes in before it. */
export const READER_ORDER = ['paper-ink', 'midnight-stacks', 'lamplight', 'obsidian', 'frosted-glass', 'frosted-glass-light', 'frosted-glass-dark', 'classic'];
