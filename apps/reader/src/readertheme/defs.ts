// The Reader's own interface styles, in the shared theme format (src/theme/themes.ts — the module both Kurokawa apps
// carry unchanged): a library and reading room in glass. Paper & Ink (paper-white frost with ink-blue, and its ink-wash
// dark), Midnight Stacks (a library after hours: navy glass, oxblood and brass in the dark, brass hairlines), Reading
// Room (sea-green glass over green baize and slate, dark and light; cool and quiet). The shared Obsidian (OLED black, thin luminous edges) and the
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

export const READING_ROOM: ThemeDef = {
  id: 'reading-room', nameKey: 'styleNameReadingRoom', radius: { xs: 8, sm: 12, md: 16, lg: 20, xl: 28, xxl: 34 },
  dark: {
    surfaces: { ground: '#0a1513', lowest: '#070f0e', low: '#0f1e1b', mid: '#132622', high: '#1a302c', highest: '#223b36' },
    text: { on: '#e4eeeb', variant: '#b9cdc8', dim: '#b9cdc8', outline: '#94aaa4', outlineVariant: 'rgb(160 220 205 / .16)' },
    roles: { primary: '#8fd1c1', onPrimary: '#00382f', primaryContainer: '#1f4a42', onPrimaryContainer: '#c8efe5', secondaryContainer: 'rgb(143 209 193 / .16)', onSecondaryContainer: '#d6efe8', tertiaryContainer: '#1f4a42', onTertiaryContainer: '#c8efe5' },
    // (Green baize under a reading-room ceiling: sea-green at the top left, slate blue at the foot, verdigris at the side.)
    bg: 'radial-gradient(72% 58% at 6% 0%, #14322d, transparent 72%), radial-gradient(64% 52% at 100% 100%, rgb(30 42 60 / .9), transparent 66%), radial-gradient(40% 36% at 100% 30%, rgb(47 93 85 / .3), transparent 70%), '
      + accentBlob('8% 92%', '45% 40%', 10),
    extremes: ['#1b3d37', '#0a1513'],
    pane: 'rgb(12 26 23 / .8)', card: 'rgb(26 50 45 / .42)', sheet: 'rgb(12 26 23 / .84)', fill: .5,
    blur: 24, sat: 1.3, edge: 'rgb(160 220 205 / .16)', sheen: 'inset 0 1px 0 rgb(200 255 240 / .12)',
    shadow: '0 1px 2px rgb(0 0 0 / .3), 0 14px 34px rgb(0 8 6 / .45)', scrim: 'rgb(0 6 5 / .55)',
  },
  light: {
    surfaces: { ground: '#eaf1ef', lowest: '#ffffff', low: '#f5f9f8', mid: '#eef4f2', high: '#e3ece9', highest: '#d9e4e1' },
    text: { on: '#10201d', variant: '#334a45', dim: '#334a45', outline: '#506662', outlineVariant: 'rgb(16 32 29 / .14)' },
    roles: { primary: '#1f6a5c', onPrimary: '#ffffff', primaryContainer: '#cdeee5', onPrimaryContainer: '#002019', secondaryContainer: 'rgb(31 106 92 / .13)', onSecondaryContainer: '#0c2a24', tertiaryContainer: '#cdeee5', onTertiaryContainer: '#002019' },
    bg: 'radial-gradient(70% 56% at 4% 0%, #f8fcfb, transparent 70%), radial-gradient(70% 56% at 0% 100%, rgb(198 224 216 / .85), transparent 70%), radial-gradient(60% 50% at 100% 70%, rgb(212 222 234 / .8), transparent 66%), '
      + accentBlob('96% 4%', '45% 40%', 10),
    extremes: ['#f8fcfb', '#c4d9d3'],
    pane: 'rgb(244 249 247 / .8)', card: 'rgb(255 255 255 / .46)', sheet: 'rgb(244 249 247 / .84)', fill: .55,
    blur: 22, sat: 1.3, edge: 'rgb(255 255 255 / .72)', sheen: 'inset 0 1px 0 rgb(255 255 255 / .9)',
    shadow: '0 1px 2px rgb(20 50 44 / .06), 0 10px 28px rgb(20 50 44 / .1)', scrim: 'rgb(10 26 22 / .3)',
  },
};

/** The Reader's gallery, in order: its own three, the shared Obsidian, the ported trio, Classic (the default) last —
 *  as the shared module keeps it, so a style from a pack goes in before it. */
export const READER_ORDER = ['paper-ink', 'midnight-stacks', 'reading-room', 'obsidian', 'frosted-glass', 'frosted-glass-light', 'frosted-glass-dark', 'classic'];
