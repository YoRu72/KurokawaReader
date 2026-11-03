// The screen translator's settings (the «Translate on screen» add-on): kept here, and handed to the phone's
// floating translator (KtScreenService) whenever they change, so the bubble works without the app open.
import { t } from '../i18n';

export type Engine = 'google' | 'deepl' | 'ai';
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
  style: { size: number; bg: string; bgAlpha: number; fg: string; smart: boolean; radius: number; center: boolean; outline: boolean; bold: boolean; bgMode: 'fill' | 'none' };
  bubble: { size: number; alpha: number; color: string; dim: boolean; dimAfter: number; edge: boolean };
  actions: { tap: Action; double: Action; long: Action };
}
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
  engine: 'google', source: 'auto', target: 'ar', deeplKey: '',
  ai: { preset: 'gemini', style: 'gemini', base: '', key: '', model: '', prompt: '' },
  read: 'auto', mode: 'full', display: 'overlay', auto: 'scroll', interval: 3, settle: 0.7, autoStop: 30,
  hideAfter: 0, tapClose: true, speak: false, ttsRate: 1, history: true,
  style: { size: 15, bg: '#1E1E1E', bgAlpha: 0.88, fg: '#FFFFFF', smart: true, radius: 6, center: false, outline: false, bold: false, bgMode: 'fill' },
  bubble: { size: 52, alpha: 0.92, color: '#6750A4', dim: true, dimAfter: 4, edge: true },
  actions: { tap: 'translate', double: 'region', long: 'menu' },
};

const KEY = 'kt.screen';
type Deep<T> = { [K in keyof T]?: T[K] extends object ? Deep<T[K]> : T[K] };
function merge<T extends object>(base: T, over: Deep<T> | undefined): T {
  const out = { ...base } as Record<string, unknown>; if (!over) return out as T;
  for (const [k, v] of Object.entries(over)) { const b = (base as Record<string, unknown>)[k]; out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' ? merge(b as object, v as Deep<object>) : v; }
  return out as T;
}
export function loadScreen(): ScreenConfig { try { return merge(DEFAULT_SCREEN, JSON.parse(localStorage.getItem(KEY) ?? '{}') as Deep<ScreenConfig>); } catch { return merge(DEFAULT_SCREEN, {}); } }
export function saveScreen(c: ScreenConfig): void { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* storage full or blocked */ } }

/** The words the bubble shows (its menu, its notes), in the app's language. */
export function screenLabels(): Record<string, string> {
  const k = ['translate', 'translateScreen', 'region', 'fixed', 'fixedSet', 'fixedChange', 'autoOn', 'autoOff', 'autoStarted', 'autoStopped', 'readAs', 'readText', 'readPicture', 'readAuto', 'list', 'copy', 'copied', 'clear', 'openApp', 'close',
    'noText', 'needA11y', 'needCapture', 'needOverlay', 'needDeepl', 'captureFailed', 'failed', 'drawFixed', 'drawRegion', 'translations', 'noteTitle', 'noteText', 'channel', 'bubble'];
  const out: Record<string, string> = {};
  for (const x of k) out[x] = t(`scr_${x}` as 'scr_translate');
  return out;
}
/** What is sent to the phone: the settings, the AI's address and model filled from its preset, the labels. */
export function nativeConfig(c: ScreenConfig): Record<string, unknown> {
  const p = AI_PRESETS.find((x) => x.id === c.ai.preset) ?? AI_PRESETS[0];
  const ai = { style: c.ai.preset === 'custom' ? c.ai.style : p.style, base: (c.ai.base.trim() || p.base).replace(/\/+$/, ''), key: c.ai.key.trim(), model: c.ai.model.trim() || p.model, prompt: c.ai.prompt, headers: c.ai.preset === 'openrouter' ? { 'HTTP-Referer': 'https://github.com/yoru72/KurokawaReader', 'X-Title': 'Kurokawa Tools' } : {} };
  return { ...c, ai, labels: screenLabels() };
}
/** Whether the chosen translator has what it needs (a key, a model address). */
export function engineReady(c: ScreenConfig): boolean {
  if (c.engine === 'deepl') return !!c.deeplKey.trim();
  if (c.engine === 'ai') return c.ai.preset === 'custom' ? !!c.ai.base.trim() && !!c.ai.model.trim() : !!c.ai.key.trim();
  return true;
}
