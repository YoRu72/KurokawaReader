// Visual settings for the reading surface, persisted in localStorage and
// applied as CSS custom properties on the .reader element.

export type Theme = 'dark' | 'black' | 'sepia' | 'paper' | 'light' | 'custom';
export type Texture = 'none' | 'paper' | 'linen' | 'parchment' | 'dots';
export type LatinFont = 'lora' | 'inter' | 'serif' | 'sans' | 'publisher';
export type ArabicFont = 'uthman' | 'sultan' | 'naskh' | 'publisher';

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

const LATIN: Record<LatinFont, string> = {
  lora: "'Lora'",
  inter: "'Inter'",
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  publisher: 'inherit',
};
const ARABIC: Record<ArabicFont, string> = {
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

/** The interface chrome follows the page: light reading themes get light chrome. */
export function applyChrome(s: VisualSettings = current): void {
  const lightTheme = s.theme === 'sepia' || s.theme === 'paper' || s.theme === 'light' || (s.theme === 'custom' && isLightColor(s.customBg));
  document.documentElement.dataset.ui = lightTheme ? 'light' : 'dark';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', lightTheme ? '#fbf6ef' : '#141110');
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
  const latin = LATIN[s.latinFont];
  const arabic = ARABIC[s.arabicFont];
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
