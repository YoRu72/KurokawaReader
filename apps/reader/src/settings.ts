import { familyFor } from './fonts';
import { ensureFont } from './slim';
import { onPhone } from './platform';
import type { PlacedItem } from './ui/placeditems';
import { DEFAULT_FLOW_BUTTONS, DEFAULT_PDF_BUTTONS, buttonsMigrated, type PlacedButton, type BarAt, type BarLook } from './readbuttons';
// Visual settings for the reading surface, persisted in localStorage and
// applied as CSS custom properties on the .reader element.

export type Theme = 'grey' | 'dark' | 'black' | 'slate' | 'night' | 'sepia' | 'moon' | 'paper' | 'mintpaper' | 'rosepaper' | 'light' | 'olive' | 'amber' | 'forest' | 'plum' | 'sand' | 'ink' | 'coffee' | 'lavender' | 'sky' | 'charcoal' | 'nord' | 'dracula' | 'solardark' | 'gruvbox' | 'solarlight' | 'cream' | 'peach' | 'custom';
export type Texture = 'none' | 'paper' | 'linen' | 'parchment';
export type UiMode = 'system' | 'light' | 'dark' | 'page';
export type Accent = 'graphite' | 'aqua' | 'teal' | 'gold' | 'coral' | 'rose' | 'mint' | 'violet' | 'olive' | 'sand' | 'mono' | 'custom';
export type Orientation = 'auto' | 'portrait' | 'landscape';
export type LatinFont = 'merriweather' | 'termes' | 'lora' | 'literata' | 'garamond' | 'crimson' | 'gelasio' | 'vollkorn' | 'bitter' | 'sourceserif' | 'atkinson' | 'inter' | 'serif' | 'sans' | 'publisher' | (string & {});
export type ArabicFont = 'uthman' | 'sultan' | 'naskh' | 'mohanad' | 'publisher' | (string & {});
export type TapAction = 'none' | 'menu' | 'next' | 'prev' | 'nextChapter' | 'prevChapter' | 'bookmark' | 'toc' | 'search' | 'options' | 'speak' | 'autoScroll' | 'fullscreen' | 'dayNight' | 'statusLine';
/** The reading bar's items as it came before they could be chosen: the chapter and the page in it at the start;
 *  the minutes left (once a reading speed is known), the clock, the battery and the book's percentage at the end. The
 *  rest are there to be switched on. */
export const DEFAULT_STATUS_ITEMS: PlacedItem[] = [
  { id: 'chapter', on: true, at: 'start' }, { id: 'page', on: true, at: 'start' },
  { id: 'timeChapter', on: true, at: 'end' }, { id: 'clock', on: true, at: 'end' }, { id: 'battery', on: true, at: 'end' }, { id: 'bookPct', on: true, at: 'end' },
  { id: 'title', on: false, at: 'start' }, { id: 'chapterLeft', on: false, at: 'end' }, { id: 'chapterPct', on: false, at: 'end' },
  { id: 'bookPage', on: false, at: 'end' }, { id: 'bookLeft', on: false, at: 'end' }, { id: 'timeBook', on: false, at: 'end' },
];
/** A set of settings from before the reading bar's items (no `statusItems` in it) that had the minutes left switched
 *  off: the same bar, without that item. Anything else is left as it is. */
export function barItemsMigrated<T extends Partial<VisualSettings>>(v: T, base: PlacedItem[] = DEFAULT_STATUS_ITEMS): T {
  if (!v || typeof v !== 'object' || 'statusItems' in v || v.showTimeLeft !== false) return v;
  return { ...v, statusItems: base.map((x) => (x.id === 'timeChapter' ? { ...x, on: false } : { ...x })) };
}
export const DEFAULT_TAP_ZONES: TapAction[] = ['prev', 'prev', 'prev', 'menu', 'menu', 'menu', 'next', 'next', 'next'];
export type CjkFont = 'system' | 'mincho' | 'gothic' | 'publisher' | (string & {});

export interface VisualSettings {
  theme: Theme;
  /** A night theme between two hours of the day ("22:00"–"06:30"), the page's theme the rest of the time. */
  nightSchedule: boolean;
  nightFrom: string;
  nightTo: string;
  nightTheme: Theme;
  /** The theme a day/night tap left (to come back to). */
  dayTheme?: Theme;
  /** A reminder to rest the eyes every so many minutes of reading (0: none). */
  eyeRestMinutes: number;
  latinFont: LatinFont;
  arabicFont: ArabicFont;
  cjkFont: CjkFont;           // Japanese, Chinese and Korean books
  headingsFont: boolean;      // the chosen reading fonts apply to headings too (else headings keep the default faces)
  fontSize: number;       // px
  lineHeight: number;     // unitless
  /** Font thickness (ReadEra's): a weight for variable fonts, 300–700; 400 is as the font comes. */
  fontWeight: number;
  /** Android: the Back button leaves the app only when pressed twice (ReadEra's). */
  doubleBackExit: boolean;
  /** Where «Search the web» from a selection goes. */
  searchEngine: 'duckduckgo' | 'google' | 'bing' | 'wikipedia' | 'yandex' | 'baidu';
  paragraphSpacing: number; // em
  textWidth: number;      // px
  margin: number;         // px
  align: 'start' | 'justify' | 'center';
  publisherStyles: boolean;
  dimImages: boolean;
  hyphenate: boolean;      // (no longer a switch of its own: hyphenation follows book formatting; kept so stored settings and backups load)
  /** Chapter titles and heading-like lines: centred, at the start, or as the book places them. */
  chapterTitles: 'center' | 'start' | 'book';
  /** The label of a chapter's title («Chapter 1», «الفصل الأول») hidden when the title has more (the name shown too). */
  hideChapterWord: boolean;
  /** The book's own relative sizes, bold and italic (its inline styles and stylesheet), under the reader's size. */
  bookSizes: boolean;
  /** A paragraph's large first letter (a drop cap the book sets): bold at the text's size, as the book sets it, or plain. */
  firstLetter: 'bold' | 'book' | 'plain';
  wordSpacing: number;    // em
  letterSpacing: number;  // em
  pdfInvert: boolean;
  pdfBar: 'auto' | 'row' | 'rows' | 'side';
  /** Which side the upright bar stands on: «start» or «end» (mirrored right to left); «right» and «left» as an older
   *  version chose, kept as they look. */
  pdfBarSide: 'right' | 'left' | 'start' | 'end';
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
  /** Volumes of one series shown as one card on the library page. */
  groupSeries: boolean;
  /** A card for the books lying on the device (its Download folder) on the library page. */
  deviceShelf: boolean;
  autoUpdateCheck: boolean;
  updateChannel: 'stable' | 'beta';   // beta: pre-releases too
  updateEvery: 'launch' | 'daily' | 'weekly'; // how often the start-up check runs
  updateAutoDownload: boolean;       // the update fetched in the background (desktop: installed on quit; Android: offered ready to install)
  /** Android: which installer takes the update — Kurokawa Installer (the Tools app's, when it is on the phone) or the system's. */
  updateInstaller: 'kurokawa' | 'system';
  /** Long work (conversions) shows its progress in notifications. */
  jobNotify: boolean;
  tapToTurn: boolean;
  /** A picture in a book opens on its own, to pinch and zoom, when tapped. */
  pictureZoom: boolean;
  /** What a tap does in each of nine zones of the page (rows top to bottom, left to right), when tapping turns pages. */
  tapZones: TapAction[];
  turnAnimation: 'none' | 'slide' | 'fade';   // when a tap or key moves a screen
  showStatusLine: boolean;
  /** (Before 0.61: the minutes left in the chapter on the status line. Now an item of `statusItems`; read once, to
   *  carry an older choice over — see barItemsMigrated.) */
  showTimeLeft: boolean;
  /** What the reading bar (the status line) shows, in what order, at which place along it — src/ui/readbar.ts. */
  statusItems: PlacedItem[];
  /** The reading bar stays when a tap hides the rest of the chrome (immersive reading). */
  statusImmersive: boolean;
  importButton: 'chips' | 'top' | 'fab';
  /** A computer's window (the desktop shell that draws its own bar — src/ui/winbar.ts): the app's own title bar in the
   *  theme's colours, or the system's frame. */
  titleBarKind: 'own' | 'system';
  /** The app's own bar without a surface: the window's buttons float over the top of the page. */
  titleBarClear: boolean;
  /** The app's icon and name at the start of its own (solid) bar; off, the sidebar keeps them. */
  titleBarName: boolean;
  appName: 'auto' | 'en' | 'ar' | 'ja' | 'zh' | 'ko';   // launcher name on the device (Android)
  importMode: 'link' | 'copy';   // keep imported files where they are (Android/desktop) or copy them into the app
  translator: 'builtin' | 'system';
  snapStyle: 'plain' | 'card';
  snapWatermark: boolean;
  pdfSnapKind: 'page' | 'card';      // «Text as image» on a PDF: the page itself cut out, or the words set again on a card
  pdfSnapCut: 'column' | 'words';    // the cut: whole lines across the text column, or only the words picked (the rest masked)
  pdfSnapCaption: boolean;           // the book's title and the page number under the cut
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
  incognito: boolean;         // reading leaves no trace: no history, reading stats or AniList progress (Mihon's incognito mode)
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
  /** How a card looks: title below the cover, over it, the cover alone, or a list of rows. */
  cardLook: 'comfortable' | 'compact' | 'cover' | 'list';
  showQuote: boolean;      // a line from the reader's highlights on the library page, a new one each day
  // AI (chapter translation, AI voices)
  aiProvider: 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'opencode' | 'custom' | 'local';
  /** Custom APIs kept (any OpenAI-, Anthropic- or Gemini-style service), and the one in use. */
  aiCustomApis?: { id: string; name: string; style: 'openai' | 'anthropic' | 'gemini'; base: string; key: string; model: string; headers?: string }[]; aiCustomId?: string;
  localEngine: 'device' | 'server';
  localModel: string;
  localServer: string;
  localServerModel: string;
  aiKey: string;
  aiModel: string;
  aiBaseUrl: string;
  aiPrompt: string;
  /** The glossary's Retranslate: the reader's own instructions ('' or absent: the default); «{lang}» in it is the language translated into. */
  aiGlossPrompt?: string;
  aiPromptPrefill: boolean;   // show the built-in instructions in the box, ready to be extended
  aiTarget: string;           // target language code
  aiTask: 'translate' | 'furigana';  // what the chapter pass does
  /** The translator: the translation in place of the text or under it; the book, the chapter and the lines
   *  before given as context; italics and bold kept; paragraphs already in the target script left; requests at
   *  once; the next chapter translated ahead while this one is read. */
  aiDisplay?: 'replace' | 'bilingual'; /** Titles: translated with the original beneath, translated only, or left as they are. */ aiTitles?: 'both' | 'translation' | 'original'; /** Names the translator meets put in the book's glossary on their own (off until chosen). */ aiAutoGlossary?: boolean; aiContext?: boolean; aiKeepStyle?: boolean; aiSkipSame?: boolean; aiParallel?: number; aiPrefetch?: boolean;
  furigana: boolean;
  autoReadings: boolean;      // show furigana / pinyin as soon as CJK text is selected          // show ruby readings in Japanese books
  aiTtsModel: string;
  aiVoice: string;
  speechEngine: 'system' | 'ai' | 'kitten';
  /** KittenTTS on the device: the model downloaded and chosen, its voice and speed. */
  kittenModel: string;
  kittenVoice: string;
  kittenSpeed: number;
  /** (Before the buttons could be placed: the ids of the floating toolbar's buttons, in order. Kept in step with
   *  `readerButtons` for an older version reading the same settings; read once to carry an older choice over.) */
  readerToolbar: string[];
  /** Where each of a flowing book's actions lives — top bar (start, end), toolbar, «More», hidden — in order
   *  (src/readbuttons.ts). */
  readerButtons: PlacedButton[];
  /** A PDF's, the same way (its toolbar is the page bar). */
  pdfButtons: PlacedButton[];
  /** Where a flowing book's toolbar stands, and how it looks (a floating pill, or docked the full width/height). */
  toolbarAt: BarAt;
  toolbarLook: BarLook;
  /** A PDF page bar's look (where it stands is `pdfBar`, `pdfBarRow`, `pdfBarSide`). */
  pdfBarLook: BarLook;
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
  /** The volume keys the other way round: volume up forward, volume down back. */
  volumeSwap: boolean;
  /** Back (the phone's button or gesture, a computer's back) leaves a book only when pressed twice within 2 s. */
  backTwiceLeave: boolean;
  /** Android: a band in the middle of each side edge kept from the system's back gesture while sideways swipes
   *  turn chapters and the bars are hidden, so a swipe begun there reaches the page. Off by default (0.61.1). */
  edgeGuard: boolean;
  /** A sideways swipe turns the chapter while a book is read chapter by chapter (a phone). */
  swipeTurn: boolean;
  /** How short or quick a sideways swipe may be and still turn (views/reader.ts SWIPE). */
  swipeSensitivity: 'low' | 'normal' | 'high';
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
  lineHeight: 1.7, fontWeight: 400, doubleBackExit: true, searchEngine: 'duckduckgo',
  paragraphSpacing: 0.9,
  textWidth: 720,
  margin: 22,
  align: 'start',
  publisherStyles: false,
  dimImages: true,
  hyphenate: true,
  chapterTitles: 'center',
  hideChapterWord: false,
  bookSizes: true,
  firstLetter: 'bold',
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
  bookFormat: true,
  customCss: '',
  smartTypography: false,
  focusMode: false,
  readingRuler: false,
  vocabSave: true,
  bgOverride: '',
  readingMode: 'chapters',
  hideSystemBars: true,
  libraryView: 'cards',
  groupSeries: true,
  deviceShelf: true,
  autoUpdateCheck: true,
  updateChannel: 'stable',
  updateEvery: 'launch',
  updateAutoDownload: true, updateInstaller: 'kurokawa',
  jobNotify: true,
  tapToTurn: true,
  pictureZoom: true,
  showStatusLine: false,
  tapZones: DEFAULT_TAP_ZONES,
  turnAnimation: 'none',
  showTimeLeft: true,
  statusItems: DEFAULT_STATUS_ITEMS,
  statusImmersive: true,
  importButton: 'chips',
  appName: 'auto',
  importMode: 'link',
  translator: 'builtin',
  snapStyle: 'plain',
  snapWatermark: false,
  pdfSnapKind: 'page',
  pdfSnapCut: 'column',
  pdfSnapCaption: true,
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
  incognito: false,
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
  cardLook: 'comfortable',
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
  kittenModel: '',
  kittenVoice: 'leo',
  kittenSpeed: 1,
  readerToolbar: ['toc', 'search', 'images', 'bookmark', 'sep', 'type', 'more'],
  readerButtons: DEFAULT_FLOW_BUTTONS.map((x) => ({ ...x })),
  pdfButtons: DEFAULT_PDF_BUTTONS.map((x) => ({ ...x })),
  toolbarAt: 'auto',
  toolbarLook: 'pill',
  pdfBarLook: 'pill',
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
  volumeSwap: false,
  backTwiceLeave: false,
  edgeGuard: false,
  swipeTurn: true,
  swipeSensitivity: 'normal',
  titleBarKind: 'own',
  titleBarClear: false,
  titleBarName: true,
};

const KEY = 'kr.visual';
const listeners = new Set<(s: VisualSettings) => void>();
let current: VisualSettings = load();

function load(): VisualSettings {
  try {
    const raw = localStorage.getItem(KEY);
    const s: VisualSettings = raw ? { ...DEFAULTS, ...buttonsMigrated(barItemsMigrated(JSON.parse(raw) as Partial<VisualSettings>)) } : { ...DEFAULTS };
    // 0.18: the add-books button moved from the top bar to the folder row (sync took its place).
    if (s.importButton === 'top' && !localStorage.getItem('kr.importMigrated')) { s.importButton = 'chips'; localStorage.setItem('kr.importMigrated', '1'); }
    // 0.32: two-finger zoom in PDFs is on for everyone (it was off by default before).
    if (!localStorage.getItem('kr.pinchMigrated')) { s.pdfPinchZoom = true; localStorage.setItem('kr.pinchMigrated', '1'); localStorage.setItem(KEY, JSON.stringify(s)); }
    // 0.61.1: hyphenation is on by default. It was off by default and the whole settings object is stored at every change,
    // so a «false» left by the old default cannot be told from one chosen: it is turned on once for everyone; turned off
    // again after that, it stays off.
    if (!localStorage.getItem('kr.hyphenMigrated')) { s.hyphenate = true; localStorage.setItem('kr.hyphenMigrated', '1'); if (raw) localStorage.setItem(KEY, JSON.stringify(s)); }
    // 0.61.2: book formatting is on by default. It was off by default and the whole settings object is stored at every
    // change, so a «false» left by the old default cannot be told from one chosen: it is turned on once for everyone;
    // turned off again after that, it stays off. (A book with a «bookFormat» of its own keeps it.)
    if (!localStorage.getItem('kr.bookFormatMigrated')) { s.bookFormat = true; localStorage.setItem('kr.bookFormatMigrated', '1'); if (raw) localStorage.setItem(KEY, JSON.stringify(s)); }
    // 0.59.8: the dots and polka textures are gone; a page that had one is plain again.
    if (!['none', 'paper', 'linen', 'parchment'].includes(s.texture as string)) s.texture = 'none';
    // 0.61.1: the edge guard is off by default; 0.61.0 stored the old default (on) with every other setting, so it is
    // turned off once for everyone, and kept as the reader sets it from then on.
    if (!localStorage.getItem('kr.edgeGuardOff')) { localStorage.setItem('kr.edgeGuardOff', '1'); if (s.edgeGuard) { s.edgeGuard = false; const kept = localStorage.getItem(KEY); if (kept) localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(kept), edgeGuard: false })); } }
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
/** Settings that are the app's whatever book is open: the AI service and its key, sync and its sign-in, updates,
 *  the library's look and filters, tracking, the interface's language-wide habits. A book's own settings are
 *  about how that book is read (its face, size, theme, layout…); these are never kept with one. */
const GLOBAL_ONLY = new Set<string>([
  // AI services and voices downloaded
  'aiProvider', 'aiGlossPrompt', 'aiCustomApis', 'aiCustomId', 'localEngine', 'localModel', 'localServer', 'localServerModel', 'aiKey', 'aiModel', 'aiBaseUrl', 'aiTtsModel', 'kittenModel',
  // sync, accounts, tracking
  'syncProvider', 'syncAuto', 'syncDropboxKey', 'syncDropboxRefresh', 'syncWebdavUrl', 'syncWebdavUser', 'syncWebdavPass', 'syncFolder', 'syncLastAt',
  'anilistEnabled', 'anilistClientId', 'anilistAutoProgress', 'incognito',
  // updates, jobs, the app on the device
  'autoUpdateCheck', 'updateChannel', 'updateEvery', 'updateAutoDownload', 'updateInstaller', 'jobNotify', 'appName', 'importMode', 'importButton', 'openLastOnLaunch', 'bookPage',
  // the computer's window
  'titleBarKind', 'titleBarClear', 'titleBarName',
  // the device's keys and gestures while reading
  'volumeKeys', 'volumeSwap', 'backTwiceLeave', 'edgeGuard', 'swipeTurn', 'swipeSensitivity',
  // the library
  'libraryView', 'groupSeries', 'deviceShelf', 'formatFilter', 'shelves', 'showProgress', 'showDone', 'doneMark', 'statusFilter', 'coverSize', 'gridColumns', 'cardLook', 'showQuote', 'readingGoalMinutes',
  // lists the reader builds up for every book
  'myThemes', 'systemFonts', 'shortcuts', 'snapFolder',
]);
/** Whether a setting is the app's alone (never one book's). */
export const isGlobalOnly = (k: string): boolean => GLOBAL_ONLY.has(k) || /(?:Key|Token|Secret|Pass|Password|Refresh)$/.test(k);
/** A book's settings without the app's own. */
const bookPart = (v: Partial<VisualSettings>): Partial<VisualSettings> => { const o = { ...v } as Record<string, unknown>; for (const k of Object.keys(o)) if (isGlobalOnly(k)) delete o[k]; return o as Partial<VisualSettings>; };
const overrides = (): Record<string, Partial<VisualSettings>> => {
  if (!bookOverrides) {
    try { bookOverrides = JSON.parse(localStorage.getItem(BOOK_KEY) ?? '{}') as Record<string, Partial<VisualSettings>>; } catch { bookOverrides = {}; }
    if (!bookOverrides || typeof bookOverrides !== 'object') bookOverrides = {};
    // (A book's own «minutes left» switched off before the reading bar's items: the bar of the app, without them.)
    for (const [id, v] of Object.entries(bookOverrides)) if (v && typeof v === 'object' && !('statusItems' in v) && v.showTimeLeft === false) bookOverrides[id] = barItemsMigrated(v, globals.statusItems);
    // (A book's own toolbar buttons from before they could be placed: the same buttons, placed — src/readbuttons.ts.)
    for (const [id, v] of Object.entries(bookOverrides)) if (v && typeof v === 'object') bookOverrides[id] = buttonsMigrated(v);
    // (Kept in a book's overrides by an older version — a key typed with a book open —: taken out of them; where
    // the app has no value of its own yet the book's is moved to the app, so nothing typed is lost. Values are
    // never printed.)
    let moved = false, cleaned = false;
    for (const v of Object.values(bookOverrides)) {
      if (!v || typeof v !== 'object') continue;
      for (const k of Object.keys(v)) {
        if (!isGlobalOnly(k)) continue;
        const val = (v as Record<string, unknown>)[k]; const g = globals as unknown as Record<string, unknown>;
        const unset = JSON.stringify(g[k]) === JSON.stringify((DEFAULTS as unknown as Record<string, unknown>)[k]);
        // (The custom services: the book's that the app lacks added to the app's list.)
        if (k === 'aiCustomApis' && Array.isArray(val)) { const mine = (Array.isArray(g[k]) ? g[k] : []) as { id: string }[]; const add = (val as { id: string }[]).filter((a) => a && a.id && !mine.some((x) => x.id === a.id)); if (add.length) { globals = { ...globals, aiCustomApis: [...mine, ...add] as VisualSettings['aiCustomApis'] }; moved = true; } }
        else if (unset && JSON.stringify(val) !== JSON.stringify(g[k])) { globals = { ...globals, [k]: val }; moved = true; }
        delete (v as Record<string, unknown>)[k]; cleaned = true;
      }
    }
    if (moved) { try { localStorage.setItem(KEY, JSON.stringify(globals)); } catch { /* full */ } if (!activeBook) current = globals; }
    if (cleaned) { try { localStorage.setItem(BOOK_KEY, JSON.stringify(bookOverrides)); } catch { /* full */ } }
  }
  return bookOverrides;
};
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
/** The library's own settings (not a book's on top of them): what a backup keeps. */
export const globalSettings = (): VisualSettings => globals;
/** Every book's own settings (a copy), and one book's set (a backup's, restored). */
export const allBookSettings = (): Record<string, Partial<VisualSettings>> => JSON.parse(JSON.stringify(overrides())) as Record<string, Partial<VisualSettings>>;
export function setBookSettings(id: string, v: Partial<VisualSettings>): void { overrides()[id] = bookPart(buttonsMigrated(barItemsMigrated(v, globals.statusItems))); saveOverrides(); if (id === activeBook) { current = merged(); listeners.forEach((fn) => fn(current)); } }
/** Drop the settings kept for books no longer in the library. */
export function forgetBookSettings(ids: string[]): void { for (const id of ids) delete overrides()[id]; saveOverrides(); }

export function updateSettings(patch: Partial<VisualSettings>): VisualSettings {
  // (With a book of its own settings open, what is about reading it goes to the book; the app's own settings —
  // the AI key, sync, the library — to the app, always.)
  const scoped = !!activeBook && !!overrides()[activeBook];
  const toBook = scoped ? bookPart(patch) : {};
  const toApp = scoped ? Object.fromEntries(Object.entries(patch).filter(([k]) => isGlobalOnly(k))) as Partial<VisualSettings> : patch;
  if (scoped && Object.keys(toBook).length) { overrides()[activeBook!] = { ...overrides()[activeBook!], ...toBook }; saveOverrides(); }
  if (Object.keys(toApp).length || !scoped) {
    globals = { ...globals, ...toApp };
    localStorage.setItem(KEY, JSON.stringify(globals));
  }
  current = merged();
  listeners.forEach((fn) => fn(current));
  return current;
}

/** The reading options back to their factory values (the app's own — the AI key, sync, the library — left as they
 *  are: the reading options' «Reset» is not a sign-out). */
export function resetSettings(): VisualSettings {
  return updateSettings(bookPart({ ...DEFAULTS }));
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
  html.dataset.cardLook = s.cardLook;
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
  // (A computer's screen does not turn: an orientation synced from the phone is left alone there. src/platform.ts.)
  if (!onPhone()) return;
  const cap = (window as unknown as { Capacitor?: { Plugins?: { ScreenOrientation?: { lock(o: { orientation: string }): Promise<void>; unlock(): Promise<void> } } } }).Capacitor;
  const plugin = cap?.Plugins?.ScreenOrientation;
  try {
    if (plugin) { if (s.orientation === 'auto') await plugin.unlock(); else await plugin.lock({ orientation: s.orientation }); return; }
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };
    if (s.orientation === 'auto') so.unlock?.(); else await so.lock?.(s.orientation);
  } catch { /* not permitted outside fullscreen / unsupported — silently ignore */ }
}

/** Write the settings onto a reader root element as CSS variables. */
/** A reading font the slim package left out: fetched and registered the first time it is chosen (said when it
 *  cannot be, offline). */
export function warmFonts(s: VisualSettings = current): void {
  const fam = LATIN[s.latinFont]; if (!fam || /^(serif|sans|publisher)$/.test(s.latinFont)) return;
  void ensureFont(fam).then((ok) => { if (!ok) window.dispatchEvent(new CustomEvent('kr:font-missing', { detail: fam })); });
}
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
  root.style.setProperty('--r-indent-own', s.indent ? `${s.indent}em` : '0');  // (Japanese, Chinese and Korean text keep the reader's own indent under book formatting.)
  root.classList.toggle('book-format', s.bookFormat);
  root.classList.toggle('focus-mode', s.focusMode);
  root.classList.toggle('drop-cap', s.dropCap);
  root.style.setProperty('--r-custom-bg', s.customBg);
  root.style.setProperty('--r-custom-fg', s.customFg);
  root.style.setProperty('--r-texture-opacity', String(s.textureOpacity));
  root.style.setProperty('--r-bg-image-opacity', String(s.bgImage ? s.bgImageOpacity : 0));
  // (The picture and texture layers exist only when there is something on them: an empty full-screen layer
  // with a filter still costs the phone a composited surface on every scrolled frame.)
  root.dataset.bgImage = s.bgImage ? 'on' : '';
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
  warmFonts(s);
  const fallback = "'Noto Naskh Arabic', Georgia, serif";
  root.style.setProperty('--r-font', s.latinFont === 'publisher' ? 'inherit' : `${latin}, ${arabic}, ${fallback}`);
  root.style.setProperty('--r-font-rtl', s.arabicFont === 'publisher' ? 'inherit' : `${arabic}, ${latin}, ${fallback}`);
  const cjk = familyFor(s.cjkFont, CJK);
  root.style.setProperty('--r-font-cjk', s.cjkFont === 'system' || s.cjkFont === 'publisher' ? 'inherit' : `${cjk}, ${latin}, ${fallback}`);
  // Headings keep the default faces unless asked to follow the text's.
  root.style.setProperty('--r-font-head', s.headingsFont ? 'var(--r-font)' : (s.latinFont === 'publisher' ? 'inherit' : `${LATIN.merriweather}, ${ARABIC.uthman}, ${fallback}`));
  root.style.setProperty('--r-font-head-rtl', s.headingsFont ? 'var(--r-font-rtl)' : (s.arabicFont === 'publisher' ? 'inherit' : `${ARABIC.uthman}, ${LATIN.lora}, ${fallback}`));
  root.style.setProperty('--r-size', `${s.fontSize}px`); root.style.setProperty('--r-weight', String(s.fontWeight || 400));
  root.style.setProperty('--r-lh', String(s.lineHeight));
  root.style.setProperty('--r-para', `${s.paragraphSpacing}em`);
  root.style.setProperty('--r-width', `${s.textWidth}px`);
  root.style.setProperty('--r-margin', `${s.margin}px`);
  root.style.setProperty('--r-align', s.bookFormat ? 'justify' : s.align);
  root.style.setProperty('--r-word', s.wordSpacing ? `${s.wordSpacing}em` : 'normal');
  root.style.setProperty('--r-letter', s.letterSpacing ? `${s.letterSpacing}em` : 'normal');
  root.style.setProperty('--r-hyphens', s.bookFormat ? 'auto' : 'manual');
  root.classList.toggle('publisher-styles', s.publisherStyles);
  applyCustomCss(s.customCss);
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
