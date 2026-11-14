// «Apply to both»: the book page that matches an interface style — a plain page in the style's own ground (no glass,
// no picture behind text), its text pushed until it reads at 7:1 or more (a reading surface asks more than chrome's
// 4.5:1), its links at 4.5:1 or more in the style's accent, the selection in the accent. It is an ordinary reading
// theme: put among the reader's own themes (`myThemes`, under the style's name) and chosen as theme «custom» — the same
// way a theme saved in Visual Options is — so it can be adjusted there, and every reading rule stays: a book with a
// theme of its own keeps it, the night theme still wins in its hours.
import { resolve, parseColor, over, contrast, type ThemeDef, type Mode, type RGBA } from '../theme/themes';
import type { VisualSettings } from '../settings';

export interface PageTheme { bg: string; fg: string; link: string; sel: string }
const hex = (c: RGBA): string => '#' + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a: RGBA, b: RGBA, k: number): RGBA => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, 1];
/** `c` moved toward white or black — away from `bg` — until it reads at `ratio` against it. */
function until(c: RGBA, bg: RGBA, ratio: number): RGBA {
  const to: RGBA = contrast([255, 255, 255, 1], bg) > contrast([0, 0, 0, 1], bg) ? [255, 255, 255, 1] : [0, 0, 0, 1];
  let k = 0; let x = c;
  while (contrast(x, bg) < ratio && k < 1) { k = Math.min(1, k + 0.02); x = mix(c, to, k); }
  return x;
}
/** The page that matches `def` in `mode`. */
export function pageThemeOf(def: ThemeDef, mode: Mode): PageTheme {
  const r = resolve({ theme: def.id, mode, darkTone: 'default', useThemeColours: true });
  const ground = parseColor(r.surfaces.ground);
  // (A light ground is lifted a little toward its brightest surface: paper, not a tinted card.)
  const bg = r.mode === 'light' ? mix(ground, parseColor(r.surfaces.lowest), 0.35) : ground;
  const fg = until(over(parseColor(r.text.on), bg), bg, 7.2);
  const accent = parseColor((r.roles ?? { primary: r.text.variant }).primary);
  const link = until(over(accent, bg), bg, 4.6);
  return { bg: hex(bg), fg: hex(fg), link: hex(link), sel: `rgba(${Math.round(accent[0])},${Math.round(accent[1])},${Math.round(accent[2])},0.35)` };
}
/** The reading settings that put the matching page in force, as one change (one step of Undo): the page among the
 *  reader's own themes under the style's name (the same entry again for the same style and mode), chosen. */
export function pagePatch(s: VisualSettings, def: ThemeDef, mode: Mode, name: string): Partial<VisualSettings> {
  const p = pageThemeOf(def, mode); const id = `style-${def.id}-${mode}`;
  const entry = { id, name, ...p };
  const list = s.myThemes.some((m) => m.id === id) ? s.myThemes.map((m) => (m.id === id ? entry : m)) : [...s.myThemes, entry];
  return { myThemes: list, theme: 'custom', myTheme: id, customBg: p.bg, customFg: p.fg, linkOverride: p.link, selOverride: p.sel, fgOverride: '', bgOverride: '' };
}
