// Tools' own side of the shared theme files (themes.ts, custom.ts, gallery.ts, editor.ts — the same in both apps):
// what Kurokawa Tools says of its themes. Not shared: the Reader has its own src/theme/app.ts. Type imports only from
// themes.ts (it imports this file), so nothing here runs before it.
import type { AppTheme, Surfaces, TextRoles, Roles, OldLook } from './themes';

/** The main theme, «Expressive 3» (id 'classic'): the app's own Material 3 Expressive look (base.css), no glass — the
 *  default before the glass themes came (0.17) and the default again (0.21). Its id stays 'classic' (what that look was
 *  called meanwhile). Dark: the graphite it always had. Light: soft cool neutrals, never glaring white, cards raised by
 *  tone, an indigo accent (base.css «Expressive 3 in light»; these constants are the same values, for previews and tests). */
const MAIN = 'classic';
export const E3_LIGHT: { surfaces: Surfaces; text: TextRoles; roles: Roles; tertiary: string; inverse: { surface: string; on: string; primary: string }; onHighest: { dim: string; outline: string } } = {
  surfaces: { ground: '#eef0f6', lowest: '#fbfcfe', low: '#f8f9fc', mid: '#e7eaf2', high: '#dfe3ed', highest: '#d6dbe7' },
  text: { on: '#181b23', variant: '#3d4352', dim: '#545b6b', outline: '#5b6272', outlineVariant: '#c4c9d6' },
  roles: { primary: '#3d4e99', onPrimary: '#ffffff', primaryContainer: '#dce1fa', onPrimaryContainer: '#121a45', secondaryContainer: '#d3daf6', onSecondaryContainer: '#1b2033', tertiaryContainer: '#d2e9ec', onTertiaryContainer: '#0b2a2f' },
  tertiary: '#2b6870', inverse: { surface: '#2b2f39', on: '#eef0f6', primary: '#b9c3ff' },
  /** On the brightest surface: the outline a step darker. */ onHighest: { dim: '#545b6b', outline: '#525969' },
};
/** Expressive 3 in dark: the old default's graphite (base.css :root and data-accent='graphite'), exactly. */
export const E3_DARK = { surfaces: { ground: '#121314', lowest: '#0c0d0e', low: '#1a1b1d', mid: '#1e2022', high: '#282a2d', highest: '#323437' } as Surfaces, inverse: { surface: '#e4e4e6', on: '#2e3033', primary: '#3d4656' }, secondaryContainer: '#3a404b',
  /** On the brightest surface (selection bars, the add field): the muted inks a step lighter. */ onHighest: { dim: '#a3a5aa', outline: '#9fa2a7' } };

export const APP_THEME: AppTheme = {
  defaultTheme: MAIN, mainNameKey: 'themeExpressive', mainFirst: true,
  mainLight: { surfaces: E3_LIGHT.surfaces, text: E3_LIGHT.text, roles: E3_LIGHT.roles }, mainDarkRoles: { secondaryContainer: E3_DARK.secondaryContainer },
  mainCopyable: true, mainTag: true, animBg: true, radiusLg: 18,
  // (0.21: the editor's extras — accents, surface tint, spacing, size, progress colour, light/dark/auto, colours per background.)
  themeExtras: true,
};

/* ---------- the main theme back (0.21): Expressive 3 again, once, for those Frost was given without asking ---------- */
/** What is read from the stored settings to tell an install moved to Frost by itself from one that chose it. */
export interface StoredLook extends OldLook { theme?: string; accentPrev?: string; glassBlur?: string; glassRail?: boolean; glassBattery?: boolean; themeChosen?: boolean; themeKeepColours?: boolean }
export interface MainMove { theme: string; chosen: boolean; moved: boolean; prev?: { theme: string; themeKeepColours?: boolean } }
/** Before 0.21 nothing recorded whether a theme was chosen: 0.17 put every install on Frost (migrateLook) and a fresh
 *  install started there. Frost is taken for a choice when anything around it was touched — the reader's own themes
 *  exist, the blur, the sidebar's glass or the battery choice was set, or a theme's own colours were once taken —,
 *  otherwise it was given, and Expressive 3 comes back (once; `moved` asks for the snackbar that can undo it). Any other
 *  theme stored was chosen by hand (only Frost was ever given). From 0.21 `themeChosen` says it plainly. */
export function migrateMain(stored: StoredLook | null, hasMine: boolean): MainMove {
  if (!stored || typeof stored !== 'object') return { theme: MAIN, chosen: false, moved: false };
  const th = typeof stored.theme === 'string' && stored.theme ? stored.theme : undefined;
  if (!th) return { theme: MAIN, chosen: false, moved: false };
  if (stored.themeChosen) return { theme: th, chosen: true, moved: false };
  if (th !== 'frost') return { theme: th, chosen: th !== MAIN, moved: false };
  const touched = hasMine || (stored.glassBlur !== undefined && stored.glassBlur !== 'auto') || stored.glassRail !== undefined || stored.glassBattery !== undefined
    || stored.accentPrev !== undefined || stored.accent === 'theme';
  if (touched) return { theme: 'frost', chosen: true, moved: false };
  return { theme: MAIN, chosen: false, moved: true, prev: { theme: 'frost', themeKeepColours: stored.themeKeepColours || undefined } };
}
