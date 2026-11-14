// The Reader's own interface styles, in the shared theme format (src/theme/themes.ts — the module both Kurokawa apps
// carry unchanged): a library and reading room in glass, kept easy on the eyes. Near-neutral grounds and tints (a whisper
// of hue, depth from lightness), muted cool accents, nothing yellow, nothing that glows (tests/glass.cjs checks it).
// Paper & Ink (soft paper-grey frost with slate ink, and its ink-wash dark), Midnight Stacks (a library after hours:
// dark blue-grey glass, steel hairlines), Reading Room (soft slate, dark and light, a grey-teal accent). The shared
// Obsidian (OLED black, thin edges) and the ported Frosted Glass trio come from the shared module. Each dark one at most
// as bright as Classic's.
//
// Their bars and sheets carry .8 of their tint: they float over any page or cover — white or black — and their
// text stays at least 4.5:1 there (tests/glass.cjs). Their cards (.4–.5) sit over the still background only.
import type { ThemeDef } from '../theme/themes';

const RADII_PAPER = { xs: 8, sm: 12, md: 16, lg: 22, xl: 30, xxl: 36 };
const accentBlob = (at: string, size: string, pct: number) => `radial-gradient(${size} at ${at}, color-mix(in srgb, var(--md-primary) ${pct}%, transparent), transparent 70%)`;

export const PAPER_INK: ThemeDef = {
  id: 'paper-ink', nameKey: 'styleNamePaperInk', radius: RADII_PAPER,
  light: {
    surfaces: { ground: '#ebebe9', lowest: '#fbfbfa', low: '#f5f5f3', mid: '#efefed', high: '#e6e6e3', highest: '#dddddb' },
    text: { on: '#1f2126', variant: '#474a52', dim: '#474a52', outline: '#61646c', outlineVariant: 'rgb(31 33 38 / .13)' },
    roles: { primary: '#4a5a75', onPrimary: '#ffffff', primaryContainer: '#dfe3ea', onPrimaryContainer: '#1a2333', secondaryContainer: 'rgb(74 90 117 / .12)', onSecondaryContainer: '#1d2433', tertiaryContainer: '#dfe3ea', onTertiaryContainer: '#1a2333' },
    // (Plain paper at the top left, a cool grey wash at the foot; the ink a breath at the top.)
    bg: 'radial-gradient(70% 60% at 8% 0%, #f7f7f5, transparent 70%), radial-gradient(75% 60% at 100% 100%, rgb(214 217 222 / .7), transparent 75%), radial-gradient(55% 45% at 0% 62%, rgb(226 226 223 / .5), transparent 70%), '
      + accentBlob('92% 6%', '55% 45%', 5),
    extremes: ['#f7f7f5', '#d6d9de'],
    pane: 'rgb(245 245 243 / .8)', card: 'rgb(251 251 250 / .46)', sheet: 'rgb(245 245 243 / .84)', fill: .55,
    blur: 22, sat: 1, edge: 'rgb(255 255 255 / .7)', sheen: 'inset 0 1px 0 rgb(255 255 255 / .85)',
    shadow: '0 1px 2px rgb(30 32 36 / .06), 0 10px 28px rgb(30 32 36 / .09)', scrim: 'rgb(28 29 32 / .28)',
  },
  dark: {
    surfaces: { ground: '#17181b', lowest: '#111214', low: '#1c1d20', mid: '#222326', high: '#2a2b2e', highest: '#333437' },
    text: { on: '#e8e8e6', variant: '#bfbfbc', dim: '#bfbfbc', outline: '#9b9b98', outlineVariant: 'rgb(232 232 230 / .13)' },
    roles: { primary: '#a6b2c6', onPrimary: '#1c2433', primaryContainer: '#2f3644', onPrimaryContainer: '#dfe4ee', secondaryContainer: 'rgb(166 178 198 / .14)', onSecondaryContainer: '#e2e6ee', tertiaryContainer: '#2f3644', onTertiaryContainer: '#dfe4ee' },
    // (Ink wash: a lighter grey at the top left, near-black at the foot.)
    bg: 'radial-gradient(70% 60% at 0% 0%, #25272b, transparent 70%), radial-gradient(60% 50% at 100% 90%, rgb(36 38 42 / .5), transparent 60%), radial-gradient(50% 45% at 60% 100%, #0e0f11, transparent 50%), '
      + accentBlob('90% 8%', '50% 45%', 5),
    extremes: ['#2a2c30', '#0e0f11'],
    pane: 'rgb(27 28 31 / .8)', card: 'rgb(44 45 49 / .4)', sheet: 'rgb(27 28 31 / .84)', fill: .5,
    blur: 24, sat: 1, edge: 'rgb(232 232 230 / .12)', sheen: 'inset 0 1px 0 rgb(255 255 255 / .07)',
    shadow: '0 1px 2px rgb(0 0 0 / .3), 0 12px 32px rgb(0 0 0 / .36)', scrim: 'rgb(0 0 0 / .5)',
  },
};

export const MIDNIGHT_STACKS: ThemeDef = {
  id: 'midnight-stacks', nameKey: 'styleNameMidnight', force: 'dark', radius: { xs: 6, sm: 10, md: 14, lg: 20, xl: 28, xxl: 34 },
  dark: {
    surfaces: { ground: '#131417', lowest: '#0f1012', low: '#18191d', mid: '#1e1f24', high: '#26282d', highest: '#2f3137' },
    text: { on: '#e6e7ea', variant: '#b9bcc3', dim: '#b9bcc3', outline: '#969aa3', outlineVariant: 'rgb(200 208 222 / .14)' },
    roles: { primary: '#9fadc4', onPrimary: '#1a2232', primaryContainer: '#2c3446', onPrimaryContainer: '#dde3ee', secondaryContainer: 'rgb(159 173 196 / .14)', onSecondaryContainer: '#e0e5ee', tertiaryContainer: '#2c3446', onTertiaryContainer: '#dde3ee' },
    // (After hours: blue-grey overhead, the stacks falling to near-black at the foot, steel at the side.)
    bg: 'radial-gradient(75% 60% at 20% 0%, #202226, transparent 75%), radial-gradient(62% 50% at 0% 100%, rgb(8 9 11 / .8), transparent 62%), radial-gradient(50% 40% at 100% 78%, rgb(54 57 64 / .22), transparent 50%), '
      + accentBlob('95% 5%', '45% 40%', 6),
    extremes: ['#232529', '#0f1012'],
    pane: 'rgb(22 23 26 / .8)', card: 'rgb(38 40 46 / .44)', sheet: 'rgb(22 23 26 / .84)', fill: .5,
    blur: 26, sat: 1, edge: 'rgb(200 210 225 / .13)', sheen: 'inset 0 1px 0 rgb(220 228 240 / .08)',
    shadow: '0 1px 2px rgb(0 0 0 / .35), 0 14px 36px rgb(0 0 0 / .45)', scrim: 'rgb(4 5 7 / .55)',
  },
};

export const READING_ROOM: ThemeDef = {
  id: 'reading-room', nameKey: 'styleNameReadingRoom', radius: { xs: 8, sm: 12, md: 16, lg: 20, xl: 28, xxl: 34 },
  dark: {
    surfaces: { ground: '#1a1c1d', lowest: '#141516', low: '#1f2122', mid: '#252728', high: '#2d3031', highest: '#36393a' },
    text: { on: '#e5e8e8', variant: '#bcc1c1', dim: '#bcc1c1', outline: '#989e9e', outlineVariant: 'rgb(210 220 220 / .13)' },
    roles: { primary: '#9db3b0', onPrimary: '#1a2a28', primaryContainer: '#2e3a39', onPrimaryContainer: '#d9e5e3', secondaryContainer: 'rgb(157 179 176 / .14)', onSecondaryContainer: '#dde6e4', tertiaryContainer: '#2e3a39', onTertiaryContainer: '#d9e5e3' },
    // (Soft slate: a lighter grey at the top left, a deeper one at the foot, the faintest cool at the side.)
    bg: 'radial-gradient(72% 58% at 6% 0%, #27292a, transparent 72%), radial-gradient(64% 52% at 100% 100%, rgb(14 15 16 / .85), transparent 66%), radial-gradient(40% 36% at 100% 30%, rgb(60 68 70 / .22), transparent 70%), '
      + accentBlob('8% 92%', '45% 40%', 5),
    extremes: ['#2a2d2e', '#111213'],
    pane: 'rgb(30 32 33 / .8)', card: 'rgb(48 51 52 / .42)', sheet: 'rgb(30 32 33 / .84)', fill: .5,
    blur: 24, sat: 1, edge: 'rgb(210 220 220 / .12)', sheen: 'inset 0 1px 0 rgb(235 245 245 / .07)',
    shadow: '0 1px 2px rgb(0 0 0 / .3), 0 14px 34px rgb(0 0 0 / .4)', scrim: 'rgb(6 7 7 / .55)',
  },
  light: {
    surfaces: { ground: '#e7e9ea', lowest: '#fafbfb', low: '#f2f3f4', mid: '#ebedee', high: '#e1e4e5', highest: '#d7dadb' },
    text: { on: '#1c2122', variant: '#444b4c', dim: '#444b4c', outline: '#5e6566', outlineVariant: 'rgb(28 33 34 / .13)' },
    roles: { primary: '#4f6966', onPrimary: '#ffffff', primaryContainer: '#d8e1e0', onPrimaryContainer: '#142321', secondaryContainer: 'rgb(79 105 102 / .12)', onSecondaryContainer: '#182624', tertiaryContainer: '#d8e1e0', onTertiaryContainer: '#142321' },
    bg: 'radial-gradient(70% 56% at 4% 0%, #f6f7f7, transparent 70%), radial-gradient(70% 56% at 0% 100%, rgb(208 213 215 / .7), transparent 70%), radial-gradient(60% 50% at 100% 70%, rgb(220 224 226 / .6), transparent 66%), '
      + accentBlob('96% 4%', '45% 40%', 5),
    extremes: ['#f6f7f7', '#cfd4d6'],
    pane: 'rgb(242 243 244 / .8)', card: 'rgb(255 255 255 / .46)', sheet: 'rgb(242 243 244 / .84)', fill: .55,
    blur: 22, sat: 1, edge: 'rgb(255 255 255 / .7)', sheen: 'inset 0 1px 0 rgb(255 255 255 / .85)',
    shadow: '0 1px 2px rgb(24 30 32 / .06), 0 10px 28px rgb(24 30 32 / .09)', scrim: 'rgb(18 22 23 / .3)',
  },
};

/** The Reader's gallery, in order: its own three, the shared Obsidian, the ported trio, Classic (the default) last —
 *  as the shared module keeps it, so a style from a pack goes in before it. */
export const READER_ORDER = ['paper-ink', 'midnight-stacks', 'reading-room', 'obsidian', 'frosted-glass', 'frosted-glass-light', 'frosted-glass-dark', 'classic'];
