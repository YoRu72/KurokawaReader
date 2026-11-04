// The player's own preferences and per-video memory (position, chosen subtitle, speed, zoom, bookmarks), kept
// apart from the app's settings; the keys are REX Player's and VLC's ideas in the app's words.
export type TapAction = 'seek' | 'playpause' | 'none' | 'chapter';
export type EqBands = [number, number, number, number, number, number, number, number, number, number];
export interface PlayerPrefs {
  doubleTapSeek: number; swipeSeek: boolean; swipeVolume: boolean; swipeBrightness: boolean; longPressSpeed: number; pinchZoom: boolean;
  speedPresets: number[]; defaultSpeed: number; pitchCorrection: boolean; volumeBoost: number;
  subSize: number; subColor: string; subBackground: 'none' | 'shadow' | 'box'; subPos: number; subFont: string; subBold: boolean; subCodepage: string; subAssOverride: boolean; subDelay: number;
  resume: 'always' | 'ask' | 'never'; watchedAt: number; markWatched: boolean; autoplayNext: boolean; keepScreenOn: boolean; orientation: 'auto' | 'landscape' | 'sensor';
  aspect: 'fit' | 'fill' | 'stretch' | '16:9' | '4:3' | '21:9';
  sleepTimer: number;
  /** REX Player's extras: a skip button's amount, skipping openings/endings (AniSkip, chapters), the picture's filters, the ambient glow, the remaining time, the double-tap zones' width (%), shuffle. */
  skipAmount: number; autoSkip: 'off' | 'button' | 'auto'; filters: { brightness: number; contrast: number; saturation: number; hue: number; gamma: number; sharpness: number; temperature: number }; ambient: boolean; showRemaining: boolean; doubleTapArea: number; shuffle: boolean;
  /** Gestures (REX Player): what a double tap does on each side and in the middle, the sides swapped (volume on
   *  the left), how far a swipe seeks, a swipe while holding for speed changing it, the held speed remembered. */
  tapLeft: TapAction; tapCentre: TapAction; tapRight: TapAction; swapSides: boolean; swipeSensitivity: number; holdSwipeSpeed: boolean; rememberHoldSpeed: boolean;
  /** Controls: how long they stay, the seek bar's previews, a clock on top, the seek time shown while seeking. */
  controlsTimeout: number; seekPreview: boolean; showClock: boolean;
  /** REX Player's layout: the buttons on the bar, in their order (the rest in the tools menu). */
  bar: string[];
  /** Appearance (REX Player's page): the accent colour (empty: the app's), the seek bar's look, how dark the controls' shade is, the title shown, the chapter marks on the bar, the controls' size. */
  accent: string; seekStyle: 'thin' | 'thick' | 'wave'; controlsDim: number; showTitle: boolean; chapterMarks: boolean; controlSize: 'small' | 'normal' | 'large';
  /** Decoder (mpv): hardware (MediaCodec), hardware with copying (works with filters and screenshots), software; GPU
   *  debanding; the newer renderer. */
  hwdec: 'hw' | 'hwcopy' | 'sw'; deband: boolean; gpuNext: boolean;
  /** Audio: the preferred languages (two-letter codes, in order), the channels (as the file has them, or down to stereo). */
  audioLangs: string[]; audioChannels: 'auto' | 'stereo';
  /** Subtitles fetched by themselves when the video has none in the preferred languages (the Subtitles add-on). */
  autoSubs: boolean;
  /** Saved frames carry the subtitle on screen (drawn in the player's style). */
  shotSubs: boolean;
  /** Playback: repeat (off, all, one), closing at the end, the brightness kept between videos, playing on in the
   *  background, chapter skip by double tap. */
  repeat: 'off' | 'all' | 'one'; closeAtEnd: boolean; rememberBrightness: boolean; brightness: number; backgroundPlay: boolean;
  /** Subtitles (REX Player / VLC): italic, outline colour and width, background opacity, the second track's
   *  position and size, timing stretched (a 25 fps file on a 23.976 video), the line direction kept left-to-right. */
  subItalic: boolean; subOutline: string; subOutlineWidth: number; subBgOpacity: number; sub2Pos: number; sub2Size: number; subSpeed: number; subForceLtr: boolean;
  /** Audio (VLC): a 10-band equaliser and its preamp, a preset's name, loudness evened out (night mode), mono,
   *  left/right balance, the sound delayed against the picture. */
  eqOn: boolean; eq: EqBands; eqPreamp: number; eqPreset: string; normalize: boolean; mono: boolean; balance: number; audioDelay: number;
  /** Video (VLC): rotation, mirroring, cropping; the filter preset chosen. */
  rotate: 0 | 90 | 180 | 270; flipH: boolean; flipV: boolean; crop: string; filterPreset: string;
  /** REX Player's custom buttons: your own on the bar — seek by, a speed, a time to jump to, A/B, a screenshot, the next subtitle or audio track. */
  customButtons: { act: 'seek' | 'speed' | 'jump' | 'ab' | 'shot' | 'sub' | 'audio' | 'subline'; v?: number }[];
}
export const DEFAULT_FILTERS: PlayerPrefs['filters'] = { brightness: 100, contrast: 100, saturation: 100, hue: 0, gamma: 100, sharpness: 0, temperature: 0 };
export const DEFAULT_PREFS: PlayerPrefs = {
  doubleTapSeek: 10, swipeSeek: true, swipeVolume: true, swipeBrightness: true, longPressSpeed: 2, pinchZoom: true,
  speedPresets: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4], defaultSpeed: 1, pitchCorrection: true, volumeBoost: 30,
  subSize: 100, subColor: '#ffffff', subBackground: 'shadow', subPos: 100, subFont: '', subBold: false, subCodepage: '', subAssOverride: false, subDelay: 0,
  resume: 'always', watchedAt: 90, markWatched: true, autoplayNext: true, keepScreenOn: true, orientation: 'auto',
  aspect: 'fit', sleepTimer: 0,
  skipAmount: 85, autoSkip: 'button', filters: { ...DEFAULT_FILTERS }, ambient: false, showRemaining: false, doubleTapArea: 35, shuffle: false,
  tapLeft: 'seek', tapCentre: 'playpause', tapRight: 'seek', swapSides: false, swipeSensitivity: 100, holdSwipeSpeed: true, rememberHoldSpeed: false,
  controlsTimeout: 3.5, seekPreview: true, showClock: false,
  bar: ['skip', 'speed', 'ab', 'cut', 'aspect', 'shot', 'pip'], accent: '', seekStyle: 'thin', controlsDim: 55, showTitle: true, chapterMarks: true, controlSize: 'normal', hwdec: 'hw', deband: false, gpuNext: false, audioLangs: [], audioChannels: 'auto', autoSubs: false, shotSubs: true,
  repeat: 'off', closeAtEnd: false, rememberBrightness: false, brightness: 1, backgroundPlay: true,
  subItalic: false, subOutline: '#000000', subOutlineWidth: 2, subBgOpacity: 60, sub2Pos: 10, sub2Size: 85, subSpeed: 1, subForceLtr: false,
  eqOn: false, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eqPreamp: 0, eqPreset: 'flat', normalize: false, mono: false, balance: 0, audioDelay: 0,
  rotate: 0, flipH: false, flipV: false, crop: '', filterPreset: '',
  customButtons: [],
};
const KEY = 'kt.player'; const MEM = 'kt.player.memory';
let prefs: PlayerPrefs = load();
function load(): PlayerPrefs { try { const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PlayerPrefs>; return { ...DEFAULT_PREFS, ...p, filters: { ...DEFAULT_FILTERS, ...(p.filters ?? {}) } }; } catch { return { ...DEFAULT_PREFS }; } }
export const getPrefs = (): PlayerPrefs => prefs;
export function updatePrefs(p: Partial<PlayerPrefs>): PlayerPrefs { prefs = { ...prefs, ...p }; try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* full */ } return prefs; }
export function resetPrefs(keys: (keyof PlayerPrefs)[]): PlayerPrefs { const o: Partial<PlayerPrefs> = {}; for (const k of keys) (o as Record<string, unknown>)[k] = DEFAULT_PREFS[k]; return updatePrefs(o); }

export interface Bookmark { t: number; label: string }
export interface VideoMemory { pos: number; duration: number; sub?: string; subDelay?: number; speed?: number; zoom?: number; watched?: boolean; at: number; marks?: Bookmark[]; aspect?: PlayerPrefs['aspect']; audioDelay?: number; rotate?: number; flipH?: boolean; flipV?: boolean; crop?: string }
type Memory = Record<string, VideoMemory>;
const memory = (): Memory => { try { return JSON.parse(localStorage.getItem(MEM) ?? '{}') as Memory; } catch { return {}; } };
export const memoryOf = (key: string): VideoMemory | undefined => memory()[key];
export function remember(key: string, m: Partial<VideoMemory>): void {
  const all = memory(); const prev: VideoMemory = all[key] ?? { pos: 0, duration: 0, at: 0 }; all[key] = { ...prev, ...m, at: Date.now() };
  // The oldest forgotten past three hundred videos.
  const keys = Object.keys(all); if (keys.length > 300) for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 300)) delete all[k];
  try { localStorage.setItem(MEM, JSON.stringify(all)); } catch { /* full */ }
}
/** Every remembered video, newest first (the player's history). */
export function history(): (VideoMemory & { key: string })[] { const all = memory(); return Object.entries(all).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.at - a.at); }
export function forget(key?: string): void { if (!key) { localStorage.removeItem(MEM); return; } const all = memory(); delete all[key]; try { localStorage.setItem(MEM, JSON.stringify(all)); } catch { /* full */ } }
