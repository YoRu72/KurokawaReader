// The hues the Kurokawa apps never show (yellow, amber, gold, orange) and the one rule that keeps a colour out of them:
// shared by the background library's palette (theme/bgLib.ts, Tools) and the theme editor (theme/editor.ts, both apps).
// Also the colour roles made from an accent and a second accent (the editor's accents, Tools' palette themes). Pure
// arithmetic on sRGB colours; never at the start of either app.
import { parseColor, luminance, type RGBA, type Roles } from './themes';

export function hsl(c: RGBA): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2; const d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1)); let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360;
  return [h, s, l];
}
export function fromHsl(h: number, s: number, l: number): RGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255, 1];
}
/** The hues the app never shows (yellow, amber, gold, orange: 20°–85°). */
export const BANNED: readonly [number, number] = [20, 85];
const chromaOf = (c: RGBA): number => (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255;
/** A colour moved out of the banned hues to the nearest allowed neighbour — a rose red below, a green above — keeping
 *  its lightness and saturation; a colour with almost no hue stays (a neutral). */
export function shiftHue(c: RGBA): RGBA {
  const [h, s, l] = hsl(c);
  if (chromaOf(c) < 0.06 || h < BANNED[0] || h > BANNED[1]) return [c[0], c[1], c[2], 1];
  return fromHsl(h < (BANNED[0] + BANNED[1]) / 2 ? 352 : 95, s, l);
}
export const hueOf = (c: RGBA): number => hsl(c)[0];
/** Is it in the banned band (and coloured enough to be seen as such)? */
export const banned = (c: RGBA): boolean => { const h = hueOf(c); return chromaOf(c) >= 0.06 && h >= BANNED[0] && h <= BANNED[1]; };
const hex2 = (c: RGBA): string => '#' + [0, 1, 2].map((i) => Math.round(Math.max(0, Math.min(255, c[i]))).toString(16).padStart(2, '0')).join('');
/** A #rrggbb colour kept as it is, or moved out of the banned hues (`moved` then says so). */
export function allowedHex(hex: string): { hex: string; moved: boolean } {
  const m = /^#([0-9a-f]{6})/i.exec(hex); if (!m) return { hex: '#808080', moved: false };
  const n = parseInt(m[1], 16); const c: RGBA = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  if (!banned(c)) return { hex: `#${m[1].toLowerCase()}`, moved: false };
  return { hex: hex2(shiftHue(c)), moved: true };
}

/* ---------- colour roles from two accents ---------- */
/** `a` moved toward `b` by k (0: a, 1: b), as #rrggbb. */
export const mixHex = (a: string, b: string, k: number): string => { const x = parseColor(a), y = parseColor(b); return hex2([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k, 1]); };
export const ratioHex = (a: string, b: string): number => { const x = luminance(parseColor(a)), y = luminance(parseColor(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** The text colour on a filled colour: its own deep or pale tone, else black or white — whichever reads at 4.5:1. */
export function onOf(fill: string, dark: boolean): string {
  for (const k of [0.8, 0.88, 0.94]) { const c = mixHex(fill, dark ? '#000000' : '#ffffff', k); if (ratioHex(c, fill) >= 4.6) return c; }
  return ratioHex('#000000', fill) >= ratioHex('#ffffff', fill) ? '#000000' : '#ffffff';
}
/** Text on a container: from the hue toward white (dark) or black (light) until it reads at 4.6:1. */
export function inkOn(fill: string, hue: string, dark: boolean): string {
  for (let k = 0.7; k <= 1.001; k += 0.04) { const c = mixHex(hue, dark ? '#ffffff' : '#000000', k); if (ratioHex(c, fill) >= 4.6) return c; }
  return dark ? '#ffffff' : '#000000';
}
/** The M3 roles from an accent and a second accent (the tertiary), over a mode's ground and surface, with its text
 *  and muted text: the accent itself as the primary — drawn lighter (dark) or deeper (light) only as far as it takes to
 *  stand at 3:1 on the ground —, its containers mixed into the ground, every «on» colour at 4.6:1 or more. */
export function rolesFrom(o: { accent: string; second: string; dark: boolean; ground: string; surface: string; text: string; muted: string }): Roles {
  const { second: b, dark, ground: g, surface: s, text: t, muted: m } = o; let a = o.accent;
  for (let i = 0; i < 12 && ratioHex(a, g) < 3; i++) a = mixHex(a, dark ? '#ffffff' : '#000000', 0.12);
  const pc = dark ? mixHex(a, g, 0.7) : mixHex(a, s, 0.84); const tc = dark ? mixHex(b, g, 0.7) : mixHex(b, s, 0.84);
  const sc = dark ? mixHex(mixHex(a, m, 0.6), g, 0.8) : mixHex(mixHex(a, m, 0.5), s, 0.88);
  return { primary: a, onPrimary: onOf(a, dark), primaryContainer: pc, onPrimaryContainer: inkOn(pc, a, dark), secondaryContainer: sc, onSecondaryContainer: inkOn(sc, t, dark), tertiaryContainer: tc, onTertiaryContainer: inkOn(tc, b, dark) };
}
