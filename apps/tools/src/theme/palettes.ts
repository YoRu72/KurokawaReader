// The palette themes (Kurokawa Tools 0.21): twelve glass themes each drawn from a small palette of its own — a ground,
// two surfaces, the text, a muted text, an accent and a second accent, for dark and for light — instead of the app's
// accent. Kurokawa Tools only (not one of the files shared with the Reader), and never at the start: fetched with
// Settings → Appearance, the editor, the licences, or at the start only when one of them is the theme in use (settings.ts).
// Every colour stays out of the yellow–orange hues; every text role reads at 4.5:1 or more on every surface and glass
// layer (tests/themes.cjs measures it). Values from others are credited: Sakura Night is Catppuccin's (Macchiato and
// Latte), Plum Dusk takes Rosé Pine's iris; both under the MIT licence, their notices below. The others are our own.
import { THEMES, MIT, parseColor, over, luminance, type ThemeDef, type ModeTokens, type Surfaces, type TextRoles, type RGBA } from './themes';
import { mixHex, rolesFrom } from './hues';

/** ground, surface, raised, text, muted, accent, second accent. */
type Pal = [string, string, string, string, string, string, string];
interface PaletteTheme { id: string; key: string; dark: Pal; light: Pal; by?: string; notice?: string; glow?: boolean }

const CATPPUCCIN = `Sakura Night — colours of Catppuccin (Macchiato, Latte), https://github.com/catppuccin/catppuccin

${MIT('Catppuccin', '2021')}`;
const ROSE_PINE = `Plum Dusk — its second accent is Rosé Pine's «iris», https://github.com/rose-pine/rose-pine-theme

${MIT('Rosé Pine', '2023')}`;

export const PALETTES: PaletteTheme[] = [
  { id: 'resonance', key: 'themeResonance', dark: ['#1b2224', '#242b2e', '#2e373b', '#e4eef0', '#9aacb2', '#5fd4cc', '#f06ba8'], light: ['#f1f8f8', '#ffffff', '#e2eff0', '#17292c', '#55696e', '#0f7f86', '#c21f72'] },
  { id: 'neon-night', key: 'themeNeonNight', glow: true, dark: ['#0a0e24', '#121838', '#1b2250', '#e6ebff', '#98a3d6', '#22d3ee', '#ff3fa4'], light: ['#eef2ff', '#ffffff', '#e1e7ff', '#12163a', '#4d5693', '#0a7f9e', '#c0136f'] },
  { id: 'plum-dusk', key: 'themePlumDusk', notice: ROSE_PINE, dark: ['#1a1523', '#241c31', '#30263f', '#f0e6f5', '#b09cc0', '#f08fb0', '#c4a7e7'], light: ['#f7f0f5', '#fffafd', '#efe3ec', '#3a2540', '#6f5878', '#a8325e', '#6b4fb0'] },
  { id: 'glacier', key: 'themeGlacier', dark: ['#0e1722', '#152233', '#1e3046', '#e8f1f8', '#94acc2', '#7cc4ee', '#7fe0e6'], light: ['#eaf2f8', '#f7fbfd', '#dde9f1', '#1c2b3a', '#4b6075', '#1f6fb2', '#0e7c8a'] },
  { id: 'aurora-lake', key: 'themeAuroraLake', dark: ['#0f1a17', '#162420', '#1f332d', '#e3efe8', '#98b3a6', '#52d4b0', '#5ec2d6'], light: ['#eef5f1', '#fafdfb', '#dfece5', '#14291f', '#4a6558', '#1a7f5f', '#1b7f93'] },
  { id: 'claret', key: 'themeClaret', dark: ['#1a0f13', '#261519', '#341d23', '#f6e9ec', '#c0a0a8', '#f2566f', '#cf9ae0'], light: ['#f8eff0', '#fffafa', '#f0dfe2', '#3a1620', '#6e4a54', '#a61b3b', '#7a3c8f'] },
  { id: 'argent', key: 'themeArgent', dark: ['#121315', '#1b1d20', '#25282c', '#eceef1', '#9ea3ab', '#c9d1dc', '#8fa3bf'], light: ['#eef0f2', '#fafbfc', '#e1e4e8', '#1a1d21', '#565d67', '#3f4a5a', '#5b7596'] },
  { id: 'lilac-milk', key: 'themeLilacMilk', dark: ['#17142a', '#201c38', '#2b2647', '#eeeaff', '#aaa2d0', '#b9a2ff', '#ff9ccf'], light: ['#f3effa', '#fdfbff', '#e8e0f5', '#2a2340', '#655c85', '#6a4fc4', '#b83c8e'] },
  { id: 'abyss', key: 'themeAbyss', dark: ['#04121f', '#09202f', '#102c40', '#e0f2f7', '#86a9b8', '#2fc4d8', '#4f8df0'], light: ['#e6f3f7', '#f8fcfd', '#d3e8ef', '#0b2533', '#3f6376', '#0a7a99', '#2457c5'] },
  { id: 'slate-rain', key: 'themeSlateRain', dark: ['#14171f', '#1c212c', '#262d3b', '#e3e8f2', '#96a0b5', '#7fb2ff', '#b79cff'], light: ['#eceff5', '#fafbfd', '#dfe4ee', '#1d2433', '#566078', '#2f5fd0', '#7048c8'] },
  { id: 'sakura-night', key: 'themeSakuraNight', by: 'Catppuccin', notice: CATPPUCCIN, dark: ['#1e2030', '#24273a', '#363a4f', '#cad3f5', '#a5adcb', '#f5bde6', '#8bd5ca'], light: ['#eff1f5', '#e6e9ef', '#dce0e8', '#4c4f69', '#575a72', '#8839ef', '#179299'] },
  { id: 'nebula', key: 'themeNebula', dark: ['#0b0b1e', '#14142e', '#1e1e42', '#e9e8ff', '#a09fd0', '#8f7bff', '#35d0e8'], light: ['#f1f0fb', '#fcfcff', '#e4e2f7', '#1b1a3a', '#5a5890', '#4f46c8', '#0d7a9c'] },
];

const hex = (c: RGBA): string => '#' + [0, 1, 2].map((i) => Math.round(Math.max(0, Math.min(255, c[i]))).toString(16).padStart(2, '0')).join('');
const mix = mixHex;
const rgba = (c: string, a: number): string => { const x = parseColor(c); return `rgb(${x[0]} ${x[1]} ${x[2]} / ${a})`; };

function mode(p: Pal, dark: boolean, glow: boolean): ModeTokens {
  const [g, s, r, t, m, a, b] = p;
  const surfaces: Surfaces = dark
    ? { ground: g, lowest: mix(g, '#000000', 0.3), low: s, mid: mix(s, r, 0.5), high: r, highest: mix(r, t, 0.07) }
    : { ground: g, lowest: s, low: mix(s, g, 0.5), mid: mix(g, r, 0.4), high: r, highest: mix(r, t, 0.06) };
  const text: TextRoles = { on: t, variant: mix(t, m, 0.45), dim: m, outline: mix(m, g, 0.12), outlineVariant: mix(r, t, dark ? 0.14 : 0.16) };
  const roles = rolesFrom({ accent: a, second: b, dark, ground: g, surface: s, text: t, muted: m });
  // (The background: the accent's light from the upper corner, the second accent low on the far side, a little of
  //  the accent at the foot — a whisper over the ground; its brightest and darkest, once drawn, for the contrast guard.)
  const alpha = dark ? (glow ? [0.2, 0.14, 0.1] : [0.15, 0.1, 0.08]) : [0.12, 0.09, 0.08];
  const bg = `radial-gradient(90% 46% at 0% -6%, ${rgba(a, alpha[0])}, transparent 72%), radial-gradient(70% 44% at 104% 46%, ${rgba(b, alpha[1])}, transparent 70%), radial-gradient(100% 46% at 20% 108%, ${rgba(a, alpha[2])}, transparent 72%)`;
  const gg = parseColor(g); const drawn = [over(parseColor(rgba(a, alpha[0])), gg), over(parseColor(rgba(b, alpha[1])), gg), gg].sort((x, y) => luminance(y) - luminance(x));
  const extremes: [string, string] = [hex(drawn[0]), hex(drawn[drawn.length - 1])];
  return dark ? {
    surfaces, text, roles, bg, extremes,
    pane: { from: 'low', a: 0.7 }, card: { from: 'low', a: 0.56 }, sheet: { from: 'mid', a: 0.88 }, fill: 0.6,
    blur: 26, sat: 1, edge: glow ? rgba(a, 0.22) : rgba(t, 0.08),
    sheen: glow ? `inset 0 1px 0 ${rgba(a, 0.18)}, inset 0 0 16px -10px ${rgba(a, 0.45)}` : `inset 0 1px 0 ${rgba(t, 0.07)}`,
    shadow: glow ? `0 16px 40px -18px rgb(0 0 0 / .8), 0 0 22px -12px ${rgba(a, 0.5)}` : '0 16px 40px -18px rgb(0 0 0 / .8), 0 1px 3px rgb(0 0 0 / .4)',
    scrim: rgba(mix(g, '#000000', 0.6), 0.62),
  } : {
    surfaces, text, roles, bg, extremes,
    pane: { from: 'lowest', a: 0.66 }, card: { from: 'lowest', a: 0.58 }, sheet: { from: 'lowest', a: 0.84 }, fill: 0.72,
    blur: 26, sat: 1, edge: 'rgb(255 255 255 / .6)', sheen: 'inset 0 1px 0 rgb(255 255 255 / .7), inset 0 0 0 1px rgb(255 255 255 / .35)',
    shadow: `0 16px 40px -16px ${rgba(t, 0.26)}, 0 2px 6px ${rgba(t, 0.08)}`, scrim: rgba(t, 0.32),
  };
}

const RADII = { xs: 8, sm: 12, md: 16, lg: 20, xl: 28, xxl: 36 };
export const PALETTE_THEMES: ThemeDef[] = PALETTES.map((p) => ({
  id: p.id, nameKey: p.key, palette: true, radius: RADII, by: p.by, notice: p.notice,
  dark: mode(p.dark, true, !!p.glow), light: mode(p.light, false, !!p.glow),
}));

/** Into the list of themes once: after the built-in ones that need nothing fetched, before those with a pack. */
export function registerPalettes(): void {
  if (THEMES.some((x) => x.palette)) return;
  const at = THEMES.findIndex((x) => !!x.pack && !x.custom);
  THEMES.splice(at < 0 ? THEMES.length : at, 0, ...PALETTE_THEMES);
}
registerPalettes();
