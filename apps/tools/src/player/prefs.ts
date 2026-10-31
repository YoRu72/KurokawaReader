// The player's own preferences and per-video memory (position, chosen subtitle, speed, zoom), kept apart from
// the app's settings; the keys are REX Player's ideas in the app's words.
export interface PlayerPrefs {
  doubleTapSeek: number; swipeSeek: boolean; swipeVolume: boolean; swipeBrightness: boolean; longPressSpeed: number; pinchZoom: boolean;
  speedPresets: number[]; defaultSpeed: number; pitchCorrection: boolean; volumeBoost: number;
  subSize: number; subColor: string; subBackground: 'none' | 'shadow' | 'box'; subPos: number; subFont: string; subBold: boolean; subCodepage: string; subAssOverride: boolean; subDelay: number;
  resume: 'always' | 'ask' | 'never'; watchedAt: number; markWatched: boolean; autoplayNext: boolean; keepScreenOn: boolean; orientation: 'auto' | 'landscape' | 'sensor';
  aspect: 'fit' | 'fill' | 'stretch' | '16:9' | '4:3' | '21:9';
  sleepTimer: number;
  /** REX Player's extras: a skip button's amount, skipping openings/endings (AniSkip, chapters), the picture's filters, the ambient glow, the remaining time, the double-tap zones' width (%), shuffle. */
  skipAmount: number; autoSkip: 'off' | 'button' | 'auto'; filters: { brightness: number; contrast: number; saturation: number; hue: number }; ambient: boolean; showRemaining: boolean; doubleTapArea: number; shuffle: boolean;
}
export const DEFAULT_PREFS: PlayerPrefs = {
  doubleTapSeek: 10, swipeSeek: true, swipeVolume: true, swipeBrightness: true, longPressSpeed: 2, pinchZoom: true,
  speedPresets: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3], defaultSpeed: 1, pitchCorrection: true, volumeBoost: 30,
  subSize: 100, subColor: '#ffffff', subBackground: 'shadow', subPos: 100, subFont: '', subBold: false, subCodepage: '', subAssOverride: false, subDelay: 0,
  resume: 'always', watchedAt: 90, markWatched: true, autoplayNext: true, keepScreenOn: true, orientation: 'auto',
  aspect: 'fit', sleepTimer: 0,
  skipAmount: 85, autoSkip: 'button', filters: { brightness: 100, contrast: 100, saturation: 100, hue: 0 }, ambient: false, showRemaining: false, doubleTapArea: 35, shuffle: false,
};
const KEY = 'kt.player'; const MEM = 'kt.player.memory';
let prefs: PlayerPrefs = load();
function load(): PlayerPrefs { try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PlayerPrefs>) }; } catch { return { ...DEFAULT_PREFS }; } }
export const getPrefs = (): PlayerPrefs => prefs;
export function updatePrefs(p: Partial<PlayerPrefs>): PlayerPrefs { prefs = { ...prefs, ...p }; try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* full */ } return prefs; }

export interface VideoMemory { pos: number; duration: number; sub?: string; subDelay?: number; speed?: number; zoom?: number; watched?: boolean; at: number }
type Memory = Record<string, VideoMemory>;
const memory = (): Memory => { try { return JSON.parse(localStorage.getItem(MEM) ?? '{}') as Memory; } catch { return {}; } };
export const memoryOf = (key: string): VideoMemory | undefined => memory()[key];
export function remember(key: string, m: Partial<VideoMemory>): void {
  const all = memory(); const prev: VideoMemory = all[key] ?? { pos: 0, duration: 0, at: 0 }; all[key] = { ...prev, ...m, at: Date.now() };
  // The oldest forgotten past three hundred videos.
  const keys = Object.keys(all); if (keys.length > 300) for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 300)) delete all[k];
  try { localStorage.setItem(MEM, JSON.stringify(all)); } catch { /* full */ }
}
