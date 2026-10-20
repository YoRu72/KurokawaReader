// Visual settings for the reading surface, persisted in localStorage and
// applied as CSS custom properties on the .reader element.

export type Theme = 'dark' | 'black' | 'sepia' | 'paper' | 'light';
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

/** Write the settings onto a reader root element as CSS variables. */
export function applySettings(root: HTMLElement, s: VisualSettings = current): void {
  root.dataset.theme = s.theme;
  root.dataset.dimImages = String(s.dimImages);
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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--r-bg').trim() || '#14110f');
}
