// The screen translator's settings (the «Translate on screen» add-on): kept here, and handed to the phone's
// floating translator (KtScreenService) whenever they change, so the bubble works without the app open.
import { t } from '../i18n';

export type Engine = 'google' | 'microsoft' | 'deepl' | 'ai';
export type AiStyle = 'openai' | 'anthropic' | 'gemini';
export type AiPreset = 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'custom';
export interface ScreenConfig {
  engine: Engine; source: string; target: string; deeplKey: string;
  ai: { preset: AiPreset; style: AiStyle; base: string; key: string; model: string; prompt: string };
  /** How the screen is read: its text (accessibility), a picture of it (OCR), or the text and else a picture. */
  read: 'auto' | 'text' | 'picture';
  /** What a translation covers by default: all of the screen, or the fixed region kept. */
  mode: 'full' | 'fixed';
  display: 'overlay' | 'panel';
  auto: 'scroll' | 'interval'; interval: number; settle: number; autoStop: number;
  hideAfter: number; tapClose: boolean; speak: boolean; ttsRate: number; history: boolean;
  style: { size: number; bg: string; bgAlpha: number; fg: string; smart: boolean; radius: number; center: boolean; outline: boolean; bold: boolean; /** erase: the words taken off the picture behind them (Ascent's way); fill: a box of one colour; none: bare text. */ bgMode: 'erase' | 'fill' | 'none'; erased?: boolean };
  bubble: { size: number; alpha: number; color: string; dim: boolean; dimAfter: number; edge: boolean };
  actions: { tap: Action; double: Action; long: Action };
  /** On a computer: the shortcuts on, kept in the tray, started with the computer, how the picture is read. */
  pcOn: boolean;
  pc: { keys: Record<PcKey, string>; tray: boolean; startup: boolean; ocr: 'system' | 'ai'; closeOnBlur: boolean };
  /** The lettering (Ascent's idea, taken further): fonts of the reader's own, one for each kind of text — a balloon's
   *  words, a thought, a box (narration), a sound effect, a sign —, the kinds told apart or not. */
  letter: { kinds: boolean; fonts: Record<'default' | TextKind, string>; lib: FontFile[] };
  /** Terms always translated the reader's way (names, places, attacks), each into one language or any; one with a
   *  kind sets the kind of a block holding it (a sound effect always in the sound-effect font). */
  glossary: { on: boolean; entries: GlossaryEntry[] };
}
export type TextKind = 'dialogue' | 'thought' | 'box' | 'sfx' | 'sign';
export const TEXT_KINDS: TextKind[] = ['dialogue', 'thought', 'box', 'sfx', 'sign'];
export interface FontFile { id: string; name: string; path: string }
export interface GlossaryEntry { from: string; to: string; kind?: TextKind | ''; lang?: string }
export type PcKey = 'region' | 'full' | 'repeat' | 'auto' | 'clipboard';
export const PC_KEYS: Record<PcKey, string> = { region: 'Alt+Shift+T', full: 'Alt+Shift+F', repeat: 'Alt+Shift+R', auto: 'Alt+Shift+A', clipboard: 'Alt+Shift+C' };
export type Action = 'translate' | 'region' | 'fixed' | 'auto' | 'panel' | 'menu' | 'clear' | 'none';

export const AI_PRESETS: { id: AiPreset; label: string; style: AiStyle; base: string; model: string; keyUrl: string }[] = [
  { id: 'gemini', label: 'Google Gemini', style: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openai', label: 'OpenAI', style: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic Claude', style: 'anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', label: 'OpenRouter', style: 'openai', base: 'https://openrouter.ai/api/v1', model: 'google/gemini-3.5-flash', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'custom', label: 'Custom API', style: 'openai', base: '', model: '', keyUrl: '' },
];

/** Languages offered (code, own name). Google takes all; DeepL most; an AI model any. */
export const SCREEN_LANGS: [string, string][] = [
  ['ar', 'العربية'], ['en', 'English'], ['ja', '日本語'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['pt', 'Português'], ['it', 'Italiano'], ['ru', 'Русский'],
  ['tr', 'Türkçe'], ['fa', 'فارسی'], ['ur', 'اردو'], ['hi', 'हिन्दी'], ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['uk', 'Українська'], ['sv', 'Svenska'],
];

export const DEFAULT_SCREEN: ScreenConfig = {
  engine: 'google', source: 'auto', target: 'en', deeplKey: '',
  ai: { preset: 'gemini', style: 'gemini', base: '', key: '', model: '', prompt: '' },
  read: 'auto', mode: 'full', display: 'overlay', auto: 'scroll', interval: 3, settle: 0.5, autoStop: 30,
  hideAfter: 0, tapClose: true, speak: false, ttsRate: 1, history: true,
  style: { size: 15, bg: '#1E1E1E', bgAlpha: 0.88, fg: '#FFFFFF', smart: true, radius: 6, center: false, outline: false, bold: false, bgMode: 'erase', erased: true },
  bubble: { size: 52, alpha: 0.92, color: '#6750A4', dim: true, dimAfter: 4, edge: true },
  actions: { tap: 'translate', double: 'region', long: 'menu' },
  pcOn: false, pc: { keys: { ...PC_KEYS }, tray: true, startup: false, ocr: 'system', closeOnBlur: true },
  letter: { kinds: true, fonts: { default: '', dialogue: '', thought: '', box: '', sfx: '', sign: '' }, lib: [] },
  glossary: { on: true, entries: [] },
};

const KEY = 'kt.screen';
type Deep<T> = { [K in keyof T]?: T[K] extends object ? Deep<T[K]> : T[K] };
function merge<T extends object>(base: T, over: Deep<T> | undefined): T {
  const out = { ...base } as Record<string, unknown>; if (!over) return out as T;
  for (const [k, v] of Object.entries(over)) { const b = (base as Record<string, unknown>)[k]; out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' ? merge(b as object, v as Deep<object>) : v; }
  return out as T;
}
export function loadScreen(): ScreenConfig {
  let c: ScreenConfig; try { c = merge(DEFAULT_SCREEN, JSON.parse(localStorage.getItem(KEY) ?? '{}') as Deep<ScreenConfig>); } catch { c = merge(DEFAULT_SCREEN, {}); }
  // (Once: the box of one colour becomes the words taken off the picture — the better look — unless bare text was chosen.)
  if (!c.style.erased) { c.style = { ...c.style, bgMode: c.style.bgMode === 'none' ? 'none' : 'erase', erased: true }; saveScreen(c); }
  return c;
}
export function saveScreen(c: ScreenConfig): void { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* storage full or blocked */ } }

/** The words the bubble shows (its menu, its notes), in the app's language. */
export function screenLabels(): Record<string, string> {
  const k = ['translate', 'translateScreen', 'region', 'fixed', 'fixedSet', 'fixedChange', 'autoOn', 'autoOff', 'autoStarted', 'autoStopped', 'readAs', 'readText', 'readPicture', 'readAuto', 'list', 'copy', 'copied', 'clear', 'openApp', 'close',
    'noText', 'detect', 'needA11y', 'needCapture', 'needOverlay', 'needDeepl', 'captureFailed', 'failed', 'drawFixed', 'drawRegion', 'translations', 'noteTitle', 'noteText', 'channel', 'bubble', 'clipboard', 'quit', 'smaller', 'bigger', 'textSize', 'ai', 'onlyGoogle'];
  const out: Record<string, string> = {};
  for (const x of k) out[x] = t(`scr_${x}` as 'scr_translate');
  return out;
}
/** What is sent to the phone: the settings, the AI's address and model filled from its preset, the labels. */
export function nativeConfig(c: ScreenConfig): Record<string, unknown> {
  const p = AI_PRESETS.find((x) => x.id === c.ai.preset) ?? AI_PRESETS[0];
  const ai = { style: c.ai.preset === 'custom' ? c.ai.style : p.style, base: (c.ai.base.trim() || p.base).replace(/\/+$/, ''), key: c.ai.key.trim(), model: c.ai.model.trim() || p.model, prompt: c.ai.prompt, headers: c.ai.preset === 'openrouter' ? { 'HTTP-Referer': 'https://github.com/yoru72/KurokawaReader', 'X-Title': 'Kurokawa Tools' } : {} };
  return { ...c, ai, labels: screenLabels(), langs: SCREEN_LANGS };
}
/** Whether the chosen translator has what it needs (a key, a model address). */
export function engineReady(c: ScreenConfig): boolean {
  if (c.engine === 'deepl') return !!c.deeplKey.trim();
  if (c.engine === 'ai') return c.ai.preset === 'custom' ? !!c.ai.base.trim() && !!c.ai.model.trim() : !!c.ai.key.trim();
  return true;
}
