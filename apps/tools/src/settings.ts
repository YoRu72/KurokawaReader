// The app's settings: kept in localStorage under one key, applied to the document (theme, accent) on change.
import type { Limits } from './engine/types';

export type UiMode = 'system' | 'light' | 'dark';
export type DarkTone = 'default' | 'grey' | 'black';
export type Accent = 'graphite' | 'mono' | 'teal' | 'aqua' | 'mint' | 'olive' | 'gold' | 'sand' | 'coral' | 'rose' | 'violet' | 'custom';

export interface Settings {
  uiMode: UiMode;
  /** The interface's size, in percent (phones with big system fonts want less). */
  uiScale: number;
  darkTone: DarkTone;
  accent: Accent;
  accentCustom: string;
  /** The download folder (a path, or a content: URI on Android); '' = the engine's default. */
  downloadDir: string;
  maxActive: number;
  limits: Limits;
  seedAfterDone: boolean;
  listenPort: number;
  /** Sequential download by default for video torrents. */
  sequentialVideo: boolean;
  /** A remote aria2 (JSON-RPC) used for every download. */
  aria2: { url: string; secret: string; use: boolean };
  autoUpdateCheck: boolean;
  updateChannel: 'stable' | 'beta';
  notifyDone: boolean;
  notifyFailed: boolean;
  incognito: boolean;
  /** Installed add-ons by id. */
  addons: string[];
  /** Each add-on's own settings (keys, choices), by add-on id. */
  addonSettings: Record<string, Record<string, string | number | boolean>>;
  /** AniList: the OAuth client id the user made, changes queued while offline, progress marked as episodes are watched. */
  anilistClientId: string;
  anilistPending: Record<string, unknown>;
  anilistAutoProgress: boolean;
  /** Anime: extension repositories (Hayase index.json or Seanime marketplace URLs), the preferred quality, adult shows. */
  animeRepos: string[];
  animeQuality: '' | '2160' | '1080' | '720' | '480';
  animeAdult: boolean;
  animeTitleLang: 'preferred' | 'romaji' | 'english' | 'native';
  /** Subtitles: the languages wanted, in order. */
  subLangs: string[];
  /** Archives: unpack subtitle archives as they arrive; unpack every downloaded archive. */
  autoUnpackSubs: boolean;
  autoUnpackAll: boolean;
  /** Debrid: torrents go through the service by default; the transfers waiting on it. */
  debridDefault: boolean;
  debridTransfers: unknown[];
  /** Categories (Prism's): the user's own, folders per category, how the list is sorted. */
  categories: { id: string; name: string; icon: string; exts: string[]; dir?: string }[];
  useCategoryFolders: boolean;
  sort: 'added' | 'name' | 'size' | 'state';
  /** The clipboard watched for links (asked before adding), and the schedule downloads run in. */
  clipboardWatch: boolean;
  /** Archives (HatchZip): space never used by an extraction in place (bytes), every checksum read before an archive is cut, the sheet closed when done. */
  archiveKeepFree: number; archiveVerifyFirst: boolean; archiveCloseWhenDone: boolean;
  /** The Video add-on: the quality taken when none is picked, the container, the cover and sponsor-skip. */
  videoQuality: 'best' | '2160' | '1440' | '1080' | '720' | '480' | 'audio'; videoContainer: 'mp4' | 'mkv' | 'webm'; videoEmbedThumb: boolean; videoSponsor: boolean;
  schedule: { enabled: boolean; start: string; stop: string; days: number[] };
}

const KEY = 'kt.settings';
const DEFAULTS: Settings = {
  uiMode: 'dark', uiScale: 100, darkTone: 'default', accent: 'graphite', accentCustom: '#7fb8ff',
  downloadDir: '', maxActive: 3, limits: { down: 0, up: 0 }, seedAfterDone: false, listenPort: 0, sequentialVideo: true,
  aria2: { url: 'http://127.0.0.1:6800/jsonrpc', secret: '', use: false },
  autoUpdateCheck: true, updateChannel: 'stable', notifyDone: true, notifyFailed: true, incognito: false, addons: [], addonSettings: {},
  anilistClientId: '', anilistPending: {}, anilistAutoProgress: true, animeRepos: [], animeQuality: '1080', animeAdult: false, animeTitleLang: 'preferred',
  subLangs: [], autoUnpackSubs: true, autoUnpackAll: false, debridDefault: false, debridTransfers: [],
  categories: [], useCategoryFolders: false, sort: 'added', clipboardWatch: false, archiveKeepFree: -1, archiveVerifyFirst: false, archiveCloseWhenDone: true, videoQuality: 'best', videoContainer: 'mp4', videoEmbedThumb: true, videoSponsor: false, schedule: { enabled: false, start: '01:00', stop: '07:00', days: [] },
};

let current: Settings = load();
if (!current.subLangs.length) { const ui = (localStorage.getItem('kr.lang') || navigator.language || 'en').slice(0, 2); current.subLangs = [...new Set([ui, 'en'])]; }
const listeners = new Set<(s: Settings) => void>();
function load(): Settings {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>), aria2: { ...DEFAULTS.aria2, ...((JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>).aria2 ?? {}) } }; } catch { return { ...DEFAULTS }; }
}
export const getSettings = (): Settings => current;
export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode */ }
  applyChrome(current);
  listeners.forEach((fn) => fn(current));
  return current;
}
export function onSettingsChange(fn: (s: Settings) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

/* ---------- the look ---------- */
const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
mql?.addEventListener?.('change', () => applyChrome());
export function applyChrome(s: Settings = current): void {
  const light = s.uiMode === 'light' ? true : s.uiMode === 'dark' ? false : !!mql?.matches;
  const html = document.documentElement;
  html.dataset.ui = light ? 'light' : 'dark';
  (html.style as CSSStyleDeclaration & { zoom?: string }).zoom = s.uiScale && s.uiScale !== 100 ? String(s.uiScale / 100) : '';
  html.dataset.dark = s.darkTone;
  html.dataset.accent = s.accent;
  const roles = ['--md-primary', '--md-on-primary', '--md-primary-container', '--md-on-primary-container', '--md-secondary-container', '--md-on-secondary-container', '--md-tertiary-container', '--md-on-tertiary-container'];
  if (s.accent === 'custom') applyCustomAccent(html, s.accentCustom, light); else roles.forEach((k) => html.style.removeProperty(k));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#f7f8fa' : s.darkTone === 'black' ? '#000000' : s.darkTone === 'grey' ? '#1c1b1f' : '#121314');
}
function hexToHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()); const n = m ? parseInt(m[1], 16) : 0x7fb8ff;
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0; const l = (max + min) / 2; const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, sat * 100, l * 100];
}
/** The M3 colour roles derived from one accent hue (as the reader does). */
function applyCustomAccent(html: HTMLElement, hex: string, light: boolean): void {
  const [h, sRaw] = hexToHsl(hex); const s = Math.min(90, Math.max(25, sRaw));
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
    set('--md-tertiary-container', `hsl(${(h + 60) % 360} ${Math.round(s * .5)}% 26%)`); set('--md-on-tertiary-container', `hsl(${(h + 60) % 360} ${Math.round(s * .5)}% 88%)`);
  }
}
