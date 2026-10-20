import { familyFor } from './fonts';
// Visual settings for the reading surface, persisted in localStorage and
// applied as CSS custom properties on the .reader element.

export type Theme = 'dark' | 'black' | 'sepia' | 'paper' | 'light' | 'custom';
export type Texture = 'none' | 'paper' | 'linen' | 'parchment' | 'dots';
export type UiMode = 'system' | 'light' | 'dark' | 'page';
export type Accent = 'aqua' | 'gold' | 'rose' | 'mint' | 'violet' | 'mono' | 'custom';
export type Orientation = 'auto' | 'portrait' | 'landscape';
export type LatinFont = 'lora' | 'inter' | 'serif' | 'sans' | 'publisher' | (string & {});
export type ArabicFont = 'uthman' | 'sultan' | 'naskh' | 'publisher' | (string & {});

export interface VisualSettings {
  theme: Theme;
  latinFont: LatinFont;
  arabicFont: ArabicFont;
  fontSize: number;       // px
  lineHeight: number;     // unitless
  paragraphSpacing: number; // em
  textWidth: number;      // px
  margin: number;         // px
  align: 'start' | 'justify' | 'center';
  publisherStyles: boolean;
  dimImages: boolean;
  hyphenate: boolean;
  wordSpacing: number;    // em
  letterSpacing: number;  // em
  pdfInvert: boolean;
  autoScrollSpeed: number; // px per second
  /* Background systems */
  customBg: string;        // hex, used by theme 'custom'
  customFg: string;
  texture: Texture;
  textureOpacity: number;  // 0–1
  bgImage: boolean;        // a picture is stored in IndexedDB under 'bg-image'
  bgImageOpacity: number;  // 0–1
  bgBlur: number;          // px
  /* Comfort */
  warmth: number;          // 0–0.6 amber overlay
  dimOverlay: number;      // 0–0.7 darkening overlay
  /* Interface */
  uiMode: UiMode;
  accent: Accent;
  accentCustom: string;    // hex, used when accent === 'custom'
  orientation: Orientation;
  highlightColor: 'amber' | 'rose' | 'mint' | 'sky' | 'violet';
}

export const DEFAULTS: VisualSettings = {
  theme: 'dark',
  latinFont: 'lora',
  arabicFont: 'uthman',
  fontSize: 19,
  lineHeight: 1.7,
  paragraphSpacing: 0.9,
  textWidth: 720,
  margin: 22,
  align: 'start',
  publisherStyles: false,
  dimImages: true,
  hyphenate: false,
  wordSpacing: 0,
  letterSpacing: 0,
  pdfInvert: true,
  autoScrollSpeed: 40,
  customBg: '#1b2430',
  customFg: '#e4e9f0',
  texture: 'none',
  textureOpacity: 0.5,
  bgImage: false,
  bgImageOpacity: 0.35,
  bgBlur: 0,
  warmth: 0,
  dimOverlay: 0,
  uiMode: 'system',
  accent: 'aqua',
  accentCustom: '#7fb8ff',
  orientation: 'auto',
  highlightColor: 'amber',
};

const KEY = 'kr.visual';
const listeners = new Set<(s: VisualSettings) => void>();
let current: VisualSettings = load();

function load(): VisualSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSettings(): VisualSettings {
  return current;
}

export function updateSettings(patch: Partial<VisualSettings>): VisualSettings {
  current = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(current));
  listeners.forEach((fn) => fn(current));
  return current;
}

export function resetSettings(): VisualSettings {
  return updateSettings({ ...DEFAULTS });
}

export function onSettingsChange(fn: (s: VisualSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const LATIN: Record<string, string> = {
  lora: "'Lora'",
  inter: "'Inter'",
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  publisher: 'inherit',
};
const ARABIC: Record<string, string> = {
  uthman: "'Uthman TN1'",
  sultan: "'Sultan'",
  naskh: "'Noto Naskh Arabic'",
  publisher: 'inherit',
};

let bgImageUrl: string | null = null;
/** Object URL for the stored background picture (loaded lazily from IndexedDB). */
export async function loadBgImage(): Promise<string | null> {
  if (bgImageUrl) return bgImageUrl;
  const { db } = await import('./db');
  const blob = await db.getFile('bg-image');
  if (!blob) return null;
  bgImageUrl = URL.createObjectURL(blob);
  return bgImageUrl;
}
export async function setBgImage(blob: Blob | null): Promise<void> {
  const { db } = await import('./db');
  if (bgImageUrl) { URL.revokeObjectURL(bgImageUrl); bgImageUrl = null; }
  if (blob) await db.putFile('bg-image', blob); else await db.deleteFile('bg-image');
  updateSettings({ bgImage: !!blob });
}

/** Is a hex colour light? Used to flip the interface chrome. */
export function isLightColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55;
}

/** Which chrome the page would call for (light reading themes → light chrome). */
export function pageIsLight(s: VisualSettings = current): boolean {
  return s.theme === 'sepia' || s.theme === 'paper' || s.theme === 'light' || (s.theme === 'custom' && isLightColor(s.customBg));
}

const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
mql?.addEventListener?.('change', () => applyChrome());

/** Interface mode (system / light / dark / follow the page) and accent colour. */
export function applyChrome(s: VisualSettings = current): void {
  const light = s.uiMode === 'light' ? true : s.uiMode === 'dark' ? false : s.uiMode === 'page' ? pageIsLight(s) : !!mql?.matches;
  const html = document.documentElement;
  html.dataset.ui = light ? 'light' : 'dark';
  html.dataset.accent = s.accent;
  if (s.accent === 'custom') applyCustomAccent(html, s.accentCustom, light);
  else ['--md-primary', '--md-on-primary', '--md-primary-container', '--md-on-primary-container', '--md-secondary-container', '--md-on-secondary-container', '--md-tertiary-container', '--md-on-tertiary-container'].forEach((v) => html.style.removeProperty(v));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#f7f8fa' : '#121314');
}

function hexToHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x7fb8ff;
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2; const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, sat * 100, l * 100];
}

/** Derive the M3 colour roles from one accent hue. */
function applyCustomAccent(html: HTMLElement, hex: string, light: boolean): void {
  const [h, sRaw] = hexToHsl(hex);
  const s = Math.min(90, Math.max(25, sRaw));
  const set = (k: string, v: string) => html.style.setProperty(k, v);
  if (light) {
    set('--md-primary', `hsl(${h} ${s}% 34%)`); set('--md-on-primary', '#fff');
    set('--md-primary-container', `hsl(${h} ${s}% 88%)`); set('--md-on-primary-container', `hsl(${h} ${s}% 12%)`);
    set('--md-secondary-container', `hsl(${h} ${Math.round(s * .5)}% 90%)`); set('--md-on-secondary-container', `hsl(${h} ${Math.round(s * .5)}% 15%)`);
    set('--md-tertiary-container', `hsl(${(h + 60) % 360} ${Math.round(s * .6)}% 86%)`); set('--md-on-tertiary-container', `hsl(${(h + 60) % 360} ${Math.round(s * .6)}% 14%)`);
  } else {
    set('--md-primary', `hsl(${h} ${s}% 74%)`); set('--md-on-primary', `hsl(${h} ${s}% 14%)`);
    set('--md-primary-container', `hsl(${h} ${Math.round(s * .7)}% 28%)`); set('--md-on-primary-container', `hsl(${h} ${s}% 90%)`);
    set('--md-secondary-container', `hsl(${h} ${Math.round(s * .35)}% 24%)`); set('--md-on-secondary-container', `hsl(${h} ${Math.round(s * .4)}% 88%)`);
    set('--md-tertiary-container', `hsl(${(h + 60) % 360} ${Math.round(s * .4)}% 26%)`); set('--md-on-tertiary-container', `hsl(${(h + 60) % 360} ${Math.round(s * .5)}% 88%)`);
  }
}

/** Lock or release the screen orientation (Capacitor plugin when present, Web API otherwise). */
export async function applyOrientation(s: VisualSettings = current): Promise<void> {
  const cap = (window as unknown as { Capacitor?: { Plugins?: { ScreenOrientation?: { lock(o: { orientation: string }): Promise<void>; unlock(): Promise<void> } } } }).Capacitor;
  const plugin = cap?.Plugins?.ScreenOrientation;
  try {
    if (plugin) { if (s.orientation === 'auto') await plugin.unlock(); else await plugin.lock({ orientation: s.orientation }); return; }
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };
    if (s.orientation === 'auto') so.unlock?.(); else await so.lock?.(s.orientation);
  } catch { /* not permitted outside fullscreen / unsupported — silently ignore */ }
}

/** Write the settings onto a reader root element as CSS variables. */
export function applySettings(root: HTMLElement, s: VisualSettings = current): void {
  root.dataset.theme = s.theme;
  root.dataset.dimImages = String(s.dimImages);
  root.dataset.texture = s.texture;
  root.dataset.dark = String(s.theme === 'custom' ? !isLightColor(s.customBg) : s.theme === 'dark' || s.theme === 'black');
  root.style.setProperty('--r-custom-bg', s.customBg);
  root.style.setProperty('--r-custom-fg', s.customFg);
  root.style.setProperty('--r-texture-opacity', String(s.textureOpacity));
  root.style.setProperty('--r-bg-image-opacity', String(s.bgImage ? s.bgImageOpacity : 0));
  root.style.setProperty('--r-bg-blur', `${s.bgBlur}px`);
  root.style.setProperty('--r-warmth', String(s.warmth));
  root.style.setProperty('--r-dim-overlay', String(s.dimOverlay));
  if (s.bgImage) void loadBgImage().then((u) => root.style.setProperty('--r-bg-image', u ? `url("${u}")` : 'none'));
  else root.style.setProperty('--r-bg-image', 'none');
  applyChrome(s);
  const latin = familyFor(s.latinFont, LATIN);
  const arabic = familyFor(s.arabicFont, ARABIC);
  const fallback = "'Noto Naskh Arabic', Georgia, serif";
  root.style.setProperty('--r-font', s.latinFont === 'publisher' ? 'inherit' : `${latin}, ${arabic}, ${fallback}`);
  root.style.setProperty('--r-font-rtl', s.arabicFont === 'publisher' ? 'inherit' : `${arabic}, ${latin}, ${fallback}`);
  root.style.setProperty('--r-size', `${s.fontSize}px`);
  root.style.setProperty('--r-lh', String(s.lineHeight));
  root.style.setProperty('--r-para', `${s.paragraphSpacing}em`);
  root.style.setProperty('--r-width', `${s.textWidth}px`);
  root.style.setProperty('--r-margin', `${s.margin}px`);
  root.style.setProperty('--r-align', s.align);
  root.style.setProperty('--r-word', s.wordSpacing ? `${s.wordSpacing}em` : 'normal');
  root.style.setProperty('--r-letter', s.letterSpacing ? `${s.letterSpacing}em` : 'normal');
  root.style.setProperty('--r-hyphens', s.hyphenate ? 'auto' : 'manual');
  root.classList.toggle('publisher-styles', s.publisherStyles);
}
