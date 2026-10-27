import { familyFor } from './fonts';
// Visual settings for the reading surface, persisted in localStorage and
// applied as CSS custom properties on the .reader element.

export type Theme = 'grey' | 'dark' | 'black' | 'slate' | 'night' | 'sepia' | 'moon' | 'paper' | 'mintpaper' | 'rosepaper' | 'light' | 'olive' | 'amber' | 'forest' | 'plum' | 'sand' | 'ink' | 'coffee' | 'lavender' | 'sky' | 'charcoal' | 'nord' | 'dracula' | 'solardark' | 'gruvbox' | 'solarlight' | 'cream' | 'peach' | 'custom';
export type Texture = 'none' | 'paper' | 'linen' | 'parchment' | 'dots' | 'polka';
export type UiMode = 'system' | 'light' | 'dark' | 'page';
export type Accent = 'graphite' | 'aqua' | 'teal' | 'gold' | 'coral' | 'rose' | 'mint' | 'violet' | 'olive' | 'sand' | 'mono' | 'custom';
export type Orientation = 'auto' | 'portrait' | 'landscape';
export type LatinFont = 'merriweather' | 'termes' | 'lora' | 'literata' | 'garamond' | 'crimson' | 'gelasio' | 'vollkorn' | 'bitter' | 'sourceserif' | 'atkinson' | 'inter' | 'serif' | 'sans' | 'publisher' | (string & {});
export type ArabicFont = 'uthman' | 'sultan' | 'naskh' | 'mohanad' | 'publisher' | (string & {});
export type TapAction = 'none' | 'menu' | 'next' | 'prev' | 'nextChapter' | 'prevChapter' | 'bookmark' | 'toc' | 'search' | 'options' | 'speak' | 'autoScroll' | 'fullscreen';
export const DEFAULT_TAP_ZONES: TapAction[] = ['prev', 'prev', 'prev', 'menu', 'menu', 'menu', 'next', 'next', 'next'];
export type CjkFont = 'system' | 'mincho' | 'gothic' | 'publisher' | (string & {});

export interface VisualSettings {
  theme: Theme;
  /** A night theme between two hours of the day ("22:00"–"06:30"), the page's theme the rest of the time. */
  nightSchedule: boolean;
  nightFrom: string;
  nightTo: string;
  nightTheme: Theme;
  /** A reminder to rest the eyes every so many minutes of reading (0: none). */
  eyeRestMinutes: number;
  latinFont: LatinFont;
  arabicFont: ArabicFont;
  cjkFont: CjkFont;           // Japanese, Chinese and Korean books
  headingsFont: boolean;      // the chosen reading fonts apply to headings too (else headings keep the default faces)
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
  pdfBar: 'auto' | 'row' | 'rows' | 'side';
  pdfBarSide: 'right' | 'left';      // which side the upright bar stands on
  pdfBarRow: 'bottom' | 'top';       // where the lying bar goes   // the PDF page bar: two rows when the screen is upright and one when it is wide, or fixed
  pdfPinchZoom: boolean;    // two-finger zoom in PDFs (on by default since 0.32)
  pdfAutoCrop: boolean;     // show only each page's printed area (margins cropped), at a common width
  pdfPageNumbers: boolean;  // page number badge on each PDF page
  pdfNoteStyle: 'badge' | 'pin' | 'dot';  // how PDF notes are drawn on the page
  autoScrollSpeed: number; // px per second
  /* Background systems */
  customBg: string;        // hex, used by theme 'custom'
  customFg: string;
  texture: Texture;
  textureOpacity: number;  // 0–1
  polkaAmount: number;     // 1–5: how many dots the polka texture scatters in the margins
  polkaPlace: 'both' | 'left' | 'right' | 'edges'; // which margins carry dots (edges: top and bottom too)
  polkaSize: 1 | 2 | 3;    // dot size
  bgImage: boolean;        // a picture is stored in IndexedDB under 'bg-image'
  bgImageOpacity: number;  // 0–1
  bgBlur: number;          // px
  bgShade: number;         // 0–0.8 dark veil over the picture
  bgSaturate: number;      // 0–2 colour saturation of the picture
  bgPosition: 'center' | 'top' | 'bottom';
  bgFit: 'cover' | 'contain' | 'tile';
  /* Comfort */
  warmth: number;          // 0–0.6 amber overlay
  dimOverlay: number;      // 0–0.7 darkening overlay
  /* Interface */
  uiMode: UiMode;
  accent: Accent;
  accentCustom: string;    // hex, used when accent === 'custom'
  orientation: Orientation;
  highlightColor: 'amber' | 'rose' | 'mint' | 'sky' | 'violet';
  /* Overrides that apply on top of any theme ('' = theme default) */
  fgOverride: string;
  linkOverride: string;    // link colour on top of any theme ('' = theme's)
  selOverride: string;     // selection colour ('' = the accent's)
  /** The reader's own themes, saved by name; `myTheme` is the one in force (theme 'custom' then carries its colours). */
  myThemes: { id: string; name: string; bg: string; fg: string; link: string; sel: string }[];
  myTheme: string;
  indent: number;          // first-line indent of paragraphs, em (0 = none)
  dropCap: boolean;        // a large first letter at the start of a chapter
  bookFormat: boolean;     // printed-book formatting in one switch: justified, hyphenated, indented paragraphs
  customCss: string;       // the reader's own CSS for the text (scoped to the book's content)
  smartTypography: boolean; // curly quotes, dashes and ellipses in the text
  focusMode: boolean;      // the paragraph being read stands out; the rest of the page is dimmed
  readingRuler: boolean;   // a clear band that follows the pointer or the last touch; the rest dimmed a little
  vocabSave: boolean;      // words looked up go into the vocabulary notebook
  bgOverride: string;
  /* Reading flow */
  readingMode: 'chapters' | 'flow' | 'continuous';   // flow: chapter by chapter, the next one loads when you scroll past the end
  hideSystemBars: boolean;
  /* Library */
  libraryView: 'cards' | 'chips';
  autoUpdateCheck: boolean;
  updateChannel: 'stable' | 'beta';   // beta: pre-releases too
  updateEvery: 'launch' | 'daily' | 'weekly'; // how often the start-up check runs
  updateAutoDownload: boolean;       // desktop: fetch the update in the background and install it on quit
  /** Long work (conversions) shows its progress in notifications. */
  jobNotify: boolean;
  tapToTurn: boolean;
  /** What a tap does in each of nine zones of the page (rows top to bottom, left to right), when tapping turns pages. */
  tapZones: TapAction[];
  turnAnimation: 'none' | 'slide' | 'fade';   // when a tap or key moves a screen
  showStatusLine: boolean;
  showTimeLeft: boolean;      // minutes left in the chapter on the status line, from the reading speed
  importButton: 'chips' | 'top' | 'fab';
  appName: 'auto' | 'en' | 'ar' | 'ja' | 'zh' | 'ko';   // launcher name on the device (Android)
  importMode: 'link' | 'copy';   // keep imported files where they are (Android/desktop) or copy them into the app
  translator: 'builtin' | 'system';
  snapStyle: 'plain' | 'card';
  snapWatermark: boolean;
  invertLineArt: boolean;
  snapFolder: string;
  formatFilter: string[];
  shelves: { id: string; name: string; formats: string[]; statuses: string[]; tag: string | null }[]; // saved filter sets
  showProgress: boolean;      // a book's progress on its cover
  showDone: boolean;          // the 'read' mark on its cover
  doneMark: 'beside' | 'below' | 'topLeft' | 'bottom';   // where that mark sits
  statusFilter: string[];     // 'unread' | 'reading' | 'finished'
  readingGoalMinutes: number; // daily reading goal in minutes, 0 = off
  calendar: 'gregory' | 'hijri' | 'both';
  darkTone: 'dim' | 'grey' | 'black'; // the dark interface's surfaces: near-black, Material grey, or pure black (OLED)
  arDigits: 'auto' | 'western' | 'eastern'; // digits in the Arabic interface: 123 for data and ١٢٣ in prose, or one of them throughout
  sizeUnits: 'latin' | 'arabic'; // KB/MB/GB, or كيلوبايت/ميغابايت/قيقابايت in Arabic
  bookPage: 'chaptered' | 'always' | 'never'; // open a book's own page (chapters, tracking) before the reader
  anilistEnabled: boolean; // AniList tracking shown in the app
  anilistClientId: string; // the reader's own AniList API client
  anilistAutoProgress: boolean; // chapters read in the app sent to AniList as progress // how dates are written: the civil calendar, the Hijri (Umm al-Qura), or both
  keepAwake: boolean;         // screen wake lock while reading
  edgeBrightness: boolean;    // left-edge swipe adjusts dimming
  brightnessMode: 'app' | 'device';   // what the swipe (and dimming) controls: the reader's overlay or the screen itself
  pinchText: boolean;         // two-finger pinch changes the text size
  speechRate: number;
  speechScope: 'chapter' | 'book';   // read aloud stops at the end of the chapter, or carries on to the end of the book         // read-aloud speed, 0.5–2
  speechVoice: string;        // voice name, '' = system default for the language
  openLastOnLaunch: boolean;  // reopen the last book when the app starts
  coverSize: 'small' | 'medium' | 'large';
  gridColumns: number;     // library cards per row (0: as many as fit)
  showQuote: boolean;      // a line from the reader's highlights on the library page, a new one each day
  // AI (chapter translation, AI voices)
  aiProvider: 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'custom' | 'local';
  localEngine: 'device' | 'server';
  localModel: string;
  localServer: string;
  localServerModel: string;
  aiKey: string;
  aiModel: string;
  aiBaseUrl: string;
  aiPrompt: string;
  aiPromptPrefill: boolean;   // show the built-in instructions in the box, ready to be extended
  aiTarget: string;           // target language code
  aiTask: 'translate' | 'furigana';  // what the chapter pass does
  furigana: boolean;
  autoReadings: boolean;      // show furigana / pinyin as soon as CJK text is selected          // show ruby readings in Japanese books
  aiTtsModel: string;
  aiVoice: string;
  speechEngine: 'system' | 'ai';
  readerToolbar: string[];    // ids of the floating toolbar buttons, in order
  systemFonts: string[];      // system font families picked on desktop
  highlightPalette: Record<'amber' | 'rose' | 'mint' | 'sky' | 'violet', string>;
  shortcuts: Record<string, string>;   // user rebindings, id → combo
  // Cloud sync
  syncProvider: 'none' | 'dropbox' | 'webdav' | 'folder';
  syncAuto: boolean;
  syncDropboxKey: string;
  syncDropboxRefresh: string;
  syncWebdavUrl: string;
  syncWebdavUser: string;
  syncWebdavPass: string;
  syncFolder: string;
  syncLastAt: number;
  volumeKeys: boolean;        // page turning with volume keys (Android)
}

export const DEFAULTS: VisualSettings = {
  theme: 'grey',
  nightSchedule: false,
  nightFrom: '22:00',
  nightTo: '06:30',
  nightTheme: 'dark',
  eyeRestMinutes: 0,
  latinFont: 'literata',
  arabicFont: 'uthman',
  cjkFont: 'system',
  headingsFont: false,
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
  pdfInvert: false,
  pdfPinchZoom: true,
  pdfAutoCrop: false,
  pdfBar: 'auto',
  pdfBarSide: 'right',
  pdfBarRow: 'bottom',
  pdfPageNumbers: true,
  pdfNoteStyle: 'badge',
  autoScrollSpeed: 40,
  customBg: '#1b2430',
  customFg: '#e4e9f0',
  texture: 'none',
  textureOpacity: 0.5,
  polkaAmount: 3,
  polkaPlace: 'both',
  polkaSize: 2,
  bgImage: false,
  bgImageOpacity: 0.35,
  bgBlur: 0,
  bgShade: 0,
  bgSaturate: 1,
  bgPosition: 'center',
  bgFit: 'cover',
  warmth: 0,
  dimOverlay: 0,
  uiMode: 'page',
  accent: 'graphite',
  accentCustom: '#7fb8ff',
  orientation: 'auto',
  highlightColor: 'amber',
  fgOverride: '',
  linkOverride: '',
  selOverride: '',
  myThemes: [],
  myTheme: '',
  indent: 0,
  dropCap: false,
  bookFormat: false,
  customCss: '',
  smartTypography: false,
  focusMode: false,
  readingRuler: false,
  vocabSave: true,
  bgOverride: '',
  readingMode: 'chapters',
  hideSystemBars: true,
  libraryView: 'cards',
  autoUpdateCheck: true,
  updateChannel: 'stable',
  updateEvery: 'launch',
  updateAutoDownload: false,
  jobNotify: true,
  tapToTurn: true,
  showStatusLine: false,
  tapZones: DEFAULT_TAP_ZONES,
  turnAnimation: 'none',
  showTimeLeft: true,
  importButton: 'chips',
  appName: 'auto',
  importMode: 'link',
  translator: 'builtin',
  snapStyle: 'plain',
  snapWatermark: false,
  invertLineArt: false,
  snapFolder: 'Screenshots',
  formatFilter: [],
  shelves: [],
  showProgress: true,
  showDone: true,
  doneMark: 'beside',
  statusFilter: [],
  readingGoalMinutes: 0,
  calendar: 'gregory',
  darkTone: 'dim',
  arDigits: 'auto',
  sizeUnits: 'latin',
  bookPage: 'chaptered',
  anilistEnabled: false,
  anilistClientId: '',
  anilistAutoProgress: false,
  keepAwake: true,
  edgeBrightness: false,
  brightnessMode: 'device',
  pinchText: true,
  speechRate: 1,
  speechScope: 'chapter',
  speechVoice: '',
  openLastOnLaunch: false,
  coverSize: 'medium',
  gridColumns: 0,
  showQuote: true,
  aiProvider: 'gemini',
  localEngine: 'device',
  localModel: '',
  localServer: '',
  localServerModel: '',
  aiKey: '',
  aiModel: '',
  aiBaseUrl: '',
  aiPrompt: '',
  aiPromptPrefill: true,
  aiTarget: 'ar',
  aiTask: 'translate',
  furigana: true,
  autoReadings: false,
  aiTtsModel: '',
  aiVoice: '',
  speechEngine: 'system',
  readerToolbar: ['toc', 'search', 'images', 'bookmark', 'sep', 'type', 'more'],
  systemFonts: [],
  shortcuts: {},
  syncProvider: 'none',
  syncAuto: true,
  syncDropboxKey: '',
  syncDropboxRefresh: '',
  syncWebdavUrl: '',
  syncWebdavUser: '',
  syncWebdavPass: '',
  syncFolder: '',
  syncLastAt: 0,
  highlightPalette: { amber: '#e5c56b', rose: '#e58a8a', mint: '#7fcfa5', sky: '#7fb4e5', violet: '#b9a3e8' },
  volumeKeys: false,
};

const KEY = 'kr.visual';
const listeners = new Set<(s: VisualSettings) => void>();
let current: VisualSettings = load();

function load(): VisualSettings {
  try {
    const raw = localStorage.getItem(KEY);
    const s: VisualSettings = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    // 0.18: the add-books button moved from the top bar to the folder row (sync took its place).
    if (s.importButton === 'top' && !localStorage.getItem('kr.importMigrated')) { s.importButton = 'chips'; localStorage.setItem('kr.importMigrated', '1'); }
    // 0.32: two-finger zoom in PDFs is on for everyone (it was off by default before).
    if (!localStorage.getItem('kr.pinchMigrated')) { s.pdfPinchZoom = true; localStorage.setItem('kr.pinchMigrated', '1'); localStorage.setItem(KEY, JSON.stringify(s)); }
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSettings(): VisualSettings {
  return current;
}

// Settings for one book: while a book with its own settings is open, what the reader sees is the global
// settings with that book's changes on top, and every change made goes to the book alone — a Qur'an with
// its own face and size, a novel in another, the library untouched.
const BOOK_KEY = 'kr.bookVisual';
let activeBook: string | null = null;
let globals: VisualSettings = current;
let bookOverrides: Record<string, Partial<VisualSettings>> | null = null;
const overrides = (): Record<string, Partial<VisualSettings>> => { if (!bookOverrides) { try { bookOverrides = JSON.parse(localStorage.getItem(BOOK_KEY) ?? '{}') as Record<string, Partial<VisualSettings>>; } catch { bookOverrides = {}; } } return bookOverrides; };
const saveOverrides = () => { try { localStorage.setItem(BOOK_KEY, JSON.stringify(overrides())); } catch { /* full */ } };
const merged = (): VisualSettings => (activeBook && overrides()[activeBook] ? { ...globals, ...overrides()[activeBook] } : globals);

/** The book now open (null in the library): its own settings, if it has any, come into force. */
export function setActiveBook(id: string | null): void {
  if (id === activeBook) return;
  activeBook = id; current = merged();
  listeners.forEach((fn) => fn(current));
}
export const activeBookId = (): string | null => activeBook;
/** Whether the open book keeps settings of its own. */
export const bookScoped = (): boolean => !!activeBook && !!overrides()[activeBook];
/** Give the open book settings of its own (starting from the global ones), or take them away. */
export function setBookScoped(on: boolean): void {
  if (!activeBook) return;
  if (on) overrides()[activeBook] = overrides()[activeBook] ?? {}; else delete overrides()[activeBook];
  saveOverrides(); current = merged(); listeners.forEach((fn) => fn(current));
}
/** Drop the settings kept for books no longer in the library. */
export function forgetBookSettings(ids: string[]): void { for (const id of ids) delete overrides()[id]; saveOverrides(); }

export function updateSettings(patch: Partial<VisualSettings>): VisualSettings {
  if (activeBook && overrides()[activeBook]) {
    overrides()[activeBook] = { ...overrides()[activeBook], ...patch }; saveOverrides();
  } else {
    globals = { ...globals, ...patch };
    localStorage.setItem(KEY, JSON.stringify(globals));
  }
  current = merged();
  listeners.forEach((fn) => fn(current));
  return current;
}

export function resetSettings(): VisualSettings {
  return updateSettings({ ...DEFAULTS });
}

/** The factory value of one setting. */
export function defaultOf<K extends keyof VisualSettings>(key: K): VisualSettings[K] { return DEFAULTS[key]; }
/** True when the setting still has its factory value. */
export function isDefault(key: keyof VisualSettings, s: VisualSettings = current): boolean { return JSON.stringify(s[key]) === JSON.stringify(DEFAULTS[key]); }
/** Put one setting back to its factory value. */
export function resetSetting(...keys: (keyof VisualSettings)[]): VisualSettings {
  const patch: Partial<VisualSettings> = {};
  for (const k of keys) (patch as Record<string, unknown>)[k] = DEFAULTS[k];
  return updateSettings(patch);
}

export function onSettingsChange(fn: (s: VisualSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const LATIN: Record<string, string> = {
  merriweather: "'Merriweather'",
  termes: "'TeX Gyre Termes'",
  lora: "'Lora'",
  literata: "'Literata'",
  garamond: "'EB Garamond'",
  crimson: "'Crimson Pro'",
  gelasio: "'Gelasio'",
  vollkorn: "'Vollkorn'",
  bitter: "'Bitter'",
  sourceserif: "'Source Serif'",
  atkinson: "'Atkinson Hyperlegible'",
  inter: "'Inter'",
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  publisher: 'inherit',
};
const ARABIC: Record<string, string> = {
  uthman: "'Uthman TN1'",
  sultan: "'Sultan'",
  naskh: "'Noto Naskh Arabic'",
  mohanad: "'AL-Mohanad'",
  publisher: 'inherit',
};
const CJK: Record<string, string> = {
  system: 'inherit',
  mincho: "'Noto Serif CJK JP', 'Noto Serif JP', 'Noto Serif SC', 'Noto Serif KR', 'Hiragino Mincho ProN', 'Yu Mincho', 'MS Mincho', 'Songti SC', 'SimSun', 'Apple Myungjo', 'Batang', serif",
  gothic: "'Noto Sans CJK JP', 'Noto Sans JP', 'Noto Sans SC', 'Noto Sans KR', 'Hiragino Sans', 'Yu Gothic', 'Meiryo', 'PingFang SC', 'Microsoft YaHei', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif",
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
const LIGHT_THEMES: Theme[] = ['sepia', 'moon', 'paper', 'light', 'mintpaper', 'rosepaper', 'sand', 'lavender', 'sky', 'solarlight', 'cream', 'peach'];
/** The theme in force now: the night theme in the night hours when that is set, else the chosen one. */
export function themeNow(s: VisualSettings = current): Theme {
  if (!s.nightSchedule) return s.theme;
  const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const d = new Date(); const now = d.getHours() * 60 + d.getMinutes(); const a = mins(s.nightFrom), b = mins(s.nightTo);
  const night = a <= b ? now >= a && now < b : now >= a || now < b;
  return night ? s.nightTheme : s.theme;
}
// (The clock moves: at each minute the night may begin or end.)
let lastThemeNow: string | null = null;
if (typeof window !== 'undefined') window.setInterval(() => { if (!current.nightSchedule) return; const t = themeNow(); if (t !== lastThemeNow) { lastThemeNow = t; listeners.forEach((fn) => fn(current)); } }, 30_000);

export function pageIsLight(s: VisualSettings = current): boolean {
  if (s.bgOverride) return isLightColor(s.bgOverride);
  const theme = themeNow(s);
  return LIGHT_THEMES.includes(theme) || (theme === 'custom' && isLightColor(s.customBg));
}

const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
mql?.addEventListener?.('change', () => applyChrome());

/** Interface mode (system / light / dark / follow the page) and accent colour. */
export function applyChrome(s: VisualSettings = current): void {
  const light = s.uiMode === 'light' ? true : s.uiMode === 'dark' ? false : s.uiMode === 'page' ? pageIsLight(s) : !!mql?.matches;
  const html = document.documentElement;
  html.dataset.ui = light ? 'light' : 'dark';
  html.dataset.dark = s.darkTone;
  html.dataset.accent = s.accent;
  for (const [k, v] of Object.entries(s.highlightPalette ?? {})) html.style.setProperty(`--hl-${k}`, v);
  html.style.setProperty('--cover-min', s.coverSize === 'small' ? '104px' : s.coverSize === 'large' ? '176px' : '136px');
  if (s.gridColumns > 0) html.style.setProperty('--lib-cols', String(s.gridColumns)); else html.style.removeProperty('--lib-cols');
  if (s.accent === 'custom') applyCustomAccent(html, s.accentCustom, light);
  else ['--md-primary', '--md-on-primary', '--md-primary-container', '--md-on-primary-container', '--md-secondary-container', '--md-on-secondary-container', '--md-tertiary-container', '--md-on-tertiary-container'].forEach((v) => html.style.removeProperty(v));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#f7f8fa' : s.darkTone === 'black' ? '#000000' : s.darkTone === 'grey' ? '#1c1b1f' : '#121314');
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
  root.dataset.theme = themeNow(s);
  root.dataset.dimImages = String(s.dimImages);
  root.dataset.invertLineart = String(s.invertLineArt);
  root.dataset.texture = s.texture;
  root.dataset.furigana = String(s.furigana);
  root.dataset.dark = String(!pageIsLight(s));
  if (s.fgOverride) root.style.setProperty('--r-fg-override', s.fgOverride); else root.style.removeProperty('--r-fg-override');
  if (s.bgOverride) root.style.setProperty('--r-bg-override', s.bgOverride); else root.style.removeProperty('--r-bg-override');
  root.classList.toggle('has-fg-override', !!s.fgOverride);
  root.classList.toggle('has-bg-override', !!s.bgOverride);
  if (s.linkOverride) root.style.setProperty('--r-link-override', s.linkOverride); else root.style.removeProperty('--r-link-override');
  root.classList.toggle('has-link-override', !!s.linkOverride);
  if (s.selOverride) root.style.setProperty('--r-sel', s.selOverride); else root.style.removeProperty('--r-sel');
  root.style.setProperty('--r-indent', s.bookFormat ? `${s.indent || 2}em` : s.indent ? `${s.indent}em` : '0');
  root.classList.toggle('book-format', s.bookFormat);
  root.classList.toggle('focus-mode', s.focusMode);
  root.classList.toggle('drop-cap', s.dropCap);
  root.style.setProperty('--r-custom-bg', s.customBg);
  root.style.setProperty('--r-custom-fg', s.customFg);
  root.style.setProperty('--r-texture-opacity', String(s.textureOpacity));
  if (s.texture === 'polka') { const [l, r, tb] = polkaStrips(s.polkaAmount, s.polkaSize); root.style.setProperty('--r-polka-l', l); root.style.setProperty('--r-polka-r', r); root.style.setProperty('--r-polka-tb', tb); }
  root.dataset.polka = s.texture === 'polka' ? s.polkaPlace : '';
  root.style.setProperty('--r-bg-image-opacity', String(s.bgImage ? s.bgImageOpacity : 0));
  root.style.setProperty('--r-bg-blur', `${s.bgBlur}px`);
  root.style.setProperty('--r-bg-shade', String(s.bgShade));
  root.style.setProperty('--r-bg-sat', String(s.bgSaturate));
  root.style.setProperty('--r-bg-pos', s.bgPosition);
  root.style.setProperty('--r-bg-size', s.bgFit === 'tile' ? 'auto' : s.bgFit);
  root.style.setProperty('--r-bg-repeat', s.bgFit === 'tile' ? 'repeat' : 'no-repeat');
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
  const cjk = familyFor(s.cjkFont, CJK);
  root.style.setProperty('--r-font-cjk', s.cjkFont === 'system' || s.cjkFont === 'publisher' ? 'inherit' : `${cjk}, ${latin}, ${fallback}`);
  // Headings keep the default faces unless asked to follow the text's.
  root.style.setProperty('--r-font-head', s.headingsFont ? 'var(--r-font)' : (s.latinFont === 'publisher' ? 'inherit' : `${LATIN.merriweather}, ${ARABIC.uthman}, ${fallback}`));
  root.style.setProperty('--r-font-head-rtl', s.headingsFont ? 'var(--r-font-rtl)' : (s.arabicFont === 'publisher' ? 'inherit' : `${ARABIC.uthman}, ${LATIN.lora}, ${fallback}`));
  root.style.setProperty('--r-size', `${s.fontSize}px`);
  root.style.setProperty('--r-lh', String(s.lineHeight));
  root.style.setProperty('--r-para', `${s.paragraphSpacing}em`);
  root.style.setProperty('--r-width', `${s.textWidth}px`);
  root.style.setProperty('--r-margin', `${s.margin}px`);
  root.style.setProperty('--r-align', s.bookFormat ? 'justify' : s.align);
  root.style.setProperty('--r-word', s.wordSpacing ? `${s.wordSpacing}em` : 'normal');
  root.style.setProperty('--r-letter', s.letterSpacing ? `${s.letterSpacing}em` : 'normal');
  root.style.setProperty('--r-hyphens', s.hyphenate || s.bookFormat ? 'auto' : 'manual');
  root.classList.toggle('publisher-styles', s.publisherStyles);
  applyCustomCss(s.customCss);
}

// The polka texture: dots scattered at random down both page margins — a background, never under the text —
// as in Moon+ Reader. Two strips (left and right) are drawn once per amount and kept, so the dots stay put
// while other settings change; each strip is 240 px wide and cropped to the margin, so a wider margin (a
// desktop window) shows more of its dots. Colour comes from the theme (currentColor via the CSS mask).
const polkaCache = new Map<string, [string, string, string]>();
function polkaStrips(amount: number, size: 1 | 2 | 3): [string, string, string] {
  const key = `${amount}/${size}`; const hit = polkaCache.get(key); if (hit) return hit;
  const H = 900, W = 240, big = [2, 3, 5, 8, 12][Math.max(1, Math.min(5, Math.round(amount))) - 1];
  const R = [4.5, 6.5, 8.5][size - 1], r0 = [1.5, 2, 2.6][size - 1];
  const strip = (side: 'l' | 'r' | 'tb'): string => {
    const dots: string[] = []; const placed: [number, number][] = [];
    // Vertical strips run down a margin; the top/bottom band is the same strip turned on its side.
    const place = (r: number, nearEdge: boolean) => {
      // Near the edge: within the narrowest margin (a phone's 22 px); further out only a wide margin shows.
      // A few tries keep dots from clumping; the tile also repeats, so the ends stay clear of each other.
      for (let tries = 0; tries < 12; tries++) {
        const x = nearEdge ? r + 1 + Math.random() * Math.max(0, 20 - 2 * r) : 24 + Math.random() * (W - 32);
        const y = r + 8 + Math.random() * (H - 2 * r - 16);
        if (placed.some(([px, py]) => Math.abs(px - x) < 30 && Math.abs(py - y) < 70) && tries < 11) continue;
        placed.push([x, y]);
        const [cx, cy] = side === 'l' ? [x, y] : side === 'r' ? [W - x, y] : [y, x];
        dots.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}"/>`);
        break;
      }
    };
    for (let i = 0; i < big; i++) place(R, i % 2 === 0);
    for (let i = 0; i < big * 2; i++) place(r0, i % 3 !== 0);
    for (let i = 0; i < big; i++) place(R, false);
    const [w, h] = side === 'tb' ? [H, W] : [W, H];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="${side === 'l' ? 'xMinYMin' : side === 'r' ? 'xMaxYMin' : 'xMinYMin'} slice"><g fill="#000">${dots.join('')}</g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  };
  const out: [string, string, string] = [strip('l'), strip('r'), strip('tb')];
  polkaCache.set(key, out);
  return out;
}

// The reader's own CSS, as Moon+ allows: every rule is scoped to the book's text, so `p { text-indent: 2em }`
// touches paragraphs of the book and nothing of the app. `body` and `html` mean the text as a whole.
let lastCss: string | undefined;
function applyCustomCss(css: string): void {
  if (css === lastCss) return;
  lastCss = css;
  let el = document.getElementById('kr-user-css') as HTMLStyleElement | null;
  if (!css.trim()) { el?.remove(); return; }
  if (!el) { el = document.createElement('style'); el.id = 'kr-user-css'; document.head.appendChild(el); }
  el.textContent = scopeCss(css, '.reader .kr-content');
}
export function scopeCss(css: string, scope: string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const scopeSel = (sel: string) => sel.split(',').map((x) => { const s2 = x.trim(); if (!s2) return ''; if (/^(html|body)$/i.test(s2)) return scope; return `${scope} ${s2.replace(/^(html|body)\s+/i, '')}`; }).filter(Boolean).join(', ');
  // A small walk over the braces: plain rules get their selectors scoped; @media / @supports blocks are kept
  // and the rules inside them scoped; other @-rules (fonts, keyframes) are kept as they are.
  const walk = (text: string): string => {
    let out = ''; let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i); if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (!head) { i = j; continue; }
      if (/^@(media|supports|container)/i.test(head)) out += `${head} {\n${walk(body)}\n}\n`;
      else if (head.startsWith('@')) out += `${head} {${body}}\n`;
      else out += `${scopeSel(head)} {${body}}\n`;
      i = j;
    }
    return out;
  };
  return walk(src);
}
