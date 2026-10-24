// Read aloud with the device's own voices, in the language of what is read.
//  - Android: the system's text-to-speech engine through the app's plugin (the WebView has no speech of its own).
//  - Everywhere else: the Web Speech API (iOS, macOS, Windows and Chromium browsers carry voices for many languages).
// Each passage is spoken in its own language (Arabic, Persian, Urdu, Hebrew, Hindi, Thai, Japanese, Chinese,
// Korean, Russian, Greek… by its script; the book's language for Latin script), with a voice for that language:
// the one chosen in settings when it speaks it, else the best the device has. When the device has none, the
// reader is told so, with what to do, instead of hearing silence.
import { getLang } from './i18n';

type Native = {
  ttsSpeak(o: { text: string; lang: string; rate: number; id: string; voice?: string }): Promise<{ ok: boolean; reason?: string }>;
  ttsStop(): Promise<void>;
  ttsVoices(): Promise<{ voices: { name: string; lang: string; network?: boolean; installed?: boolean; quality?: number }[] }>;
  ttsInstallData?(): Promise<void>;
  addListener(ev: string, fn: (d: { id: string; code?: number }) => void): Promise<{ remove(): void }>;
};
function native(): Native | null {
  const cap = (window as unknown as { Capacitor?: { getPlatform?(): string; Plugins?: { Kurokawa?: Native } } }).Capacitor;
  const k = cap?.getPlatform?.() === 'android' ? cap.Plugins?.Kurokawa : undefined;
  return k && typeof k.ttsSpeak === 'function' ? k : null;
}

export type Voice = { name: string; lang: string; local: boolean };

/** Can this device read aloud at all? */
export function ttsAvailable(): boolean { return !!native() || 'speechSynthesis' in window; }

/** The language a passage is in, by its letters (and the book's language, for scripts many languages share). */
export function speechLangOf(text: string, bookLang?: string): string {
  const book = (bookLang ?? '').toLowerCase();
  const has = (re: RegExp) => re.test(text);
  if (has(/[぀-ヿ]/)) return 'ja-JP';
  if (has(/[가-힯ᄀ-ᇿ]/)) return 'ko-KR';
  if (has(/[一-鿿㐀-䶿]/)) return book.startsWith('ja') ? 'ja-JP' : book.startsWith('zh-tw') || book.startsWith('zh-hant') ? 'zh-TW' : book.startsWith('zh-hk') || book.startsWith('yue') ? 'zh-HK' : 'zh-CN';
  if (has(/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/)) {
    if (has(/[ٹڈڑںےۓھ]/) || book.startsWith('ur')) return 'ur-PK';
    if (has(/[پچژگ]/) && !has(/[ةى]/) || book.startsWith('fa')) return 'fa-IR';
    return 'ar-SA';
  }
  if (has(/[֐-׿]/)) return 'he-IL';
  if (has(/[ऀ-ॿ]/)) return book.startsWith('mr') ? 'mr-IN' : book.startsWith('ne') ? 'ne-NP' : 'hi-IN';
  if (has(/[ঀ-৿]/)) return 'bn-IN';
  if (has(/[஀-௿]/)) return 'ta-IN';
  if (has(/[ఀ-౿]/)) return 'te-IN';
  if (has(/[฀-๿]/)) return 'th-TH';
  if (has(/[຀-໿]/)) return 'lo-LA';
  if (has(/[ក-៿]/)) return 'km-KH';
  if (has(/[Ⴀ-ჿ]/)) return 'ka-GE';
  if (has(/[԰-֏]/)) return 'hy-AM';
  if (has(/[ሀ-፿]/)) return 'am-ET';
  if (has(/[Ͱ-Ͽἀ-῿]/)) return 'el-GR';
  if (has(/[Ѐ-ӿ]/)) return book && /^(uk|bg|sr|mk|be|kk|ky|mn|ru)/.test(book) ? book : has(/[іїєґ]/) ? 'uk-UA' : 'ru-RU';
  if (book && !/^(ar|fa|ur|he|ja|zh|ko|hi|th|el|ru)/.test(book)) return bookLang!;
  const ui = getLang();
  return ui === 'en' || ui === 'ar' || ui === 'ja' || ui === 'zh' || ui === 'ko' ? (/[A-Za-z]/.test(text) ? 'en-US' : ui) : 'en-US';
}

let webVoices: SpeechSynthesisVoice[] = [];
/** The device's voices (the web list fills in a moment after start-up). */
export async function voices(): Promise<Voice[]> {
  const n = native();
  if (n) { try { return (await n.ttsVoices()).voices.filter((v) => v.installed !== false).map((v) => ({ name: v.name, lang: v.lang, local: !v.network })); } catch { return []; } }
  if (!('speechSynthesis' in window)) return [];
  webVoices = speechSynthesis.getVoices();
  if (!webVoices.length) {
    await new Promise<void>((res) => { const done = () => { speechSynthesis.removeEventListener('voiceschanged', done); res(); }; speechSynthesis.addEventListener('voiceschanged', done); setTimeout(done, 1500); });
    webVoices = speechSynthesis.getVoices();
  }
  return webVoices.map((v) => ({ name: v.name, lang: v.lang, local: v.localService }));
}

const base = (l: string) => l.toLowerCase().replace('_', '-').split('-')[0];
/** The voice for a language: the preferred one when it speaks it, else the best the device has for it. */
export function voiceFor(list: Voice[], lang: string, preferred?: string): Voice | undefined {
  const want = lang.toLowerCase().replace('_', '-'), b = base(lang);
  const same = list.filter((v) => base(v.lang) === b);
  if (preferred) { const p = same.find((v) => v.name === preferred); if (p) return p; }
  const score = (v: Voice) => (v.lang.toLowerCase().replace('_', '-') === want ? 4 : 0) + (/natural|neural|premium|enhanced|online|google/i.test(v.name) ? 2 : 0) + (v.local ? 1 : 0);
  return same.sort((a, c) => score(c) - score(a))[0];
}

export type SpeakResult = 'ok' | 'no-voice' | 'missing-data' | 'unavailable';
let seq = 0;
let cancelNative: (() => void) | null = null;

/**
 * Speak one passage; `onEnd` when it has been spoken (not when stopped). Resolves at once with whether it
 * could start: 'no-voice' when the device has no voice for the language.
 */
export async function speakPassage(text: string, lang: string, rate: number, preferred: string | undefined, onEnd: () => void, onError: (e: string) => void): Promise<SpeakResult> {
  const list = await voices();
  const n = native();
  if (n) {
    const id = `kr${++seq}`;
    const v = voiceFor(list, lang, preferred);
    const subs: { remove(): void }[] = [];
    const clear = () => { for (const s of subs.splice(0)) s.remove(); };
    subs.push(await n.addListener('ttsDone', (d) => { if (d.id === id) { clear(); onEnd(); } }));
    subs.push(await n.addListener('ttsError', (d) => { if (d.id === id) { clear(); onError(`tts ${d.code ?? ''}`); } }));
    cancelNative = clear;
    const r = await n.ttsSpeak({ text, lang: v?.lang ?? lang, rate, id, voice: v?.name }).catch(() => ({ ok: false, reason: 'unavailable' }));
    if (!r.ok) { clear(); return r.reason === 'missing-data' ? 'missing-data' : r.reason === 'not-supported' ? 'no-voice' : 'unavailable'; }
    return 'ok';
  }
  if (!('speechSynthesis' in window)) return 'unavailable';
  const v = voiceFor(list, lang, preferred);
  // (With no voice for the language the system would read it with another one, or say nothing.)
  if (!v && list.length) return 'no-voice';
  const u = new SpeechSynthesisUtterance(text);
  u.lang = v?.lang ?? lang; u.rate = rate;
  const wv = v && webVoices.find((x) => x.name === v.name); if (wv) u.voice = wv;
  u.onend = () => onEnd();
  u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') onError(e.error); };
  // (Chrome stops a long utterance after about 15 s unless kept going; passages are short, but a paused
  // engine is resumed.)
  if (speechSynthesis.paused) speechSynthesis.resume();
  speechSynthesis.speak(u);
  return 'ok';
}

export function stopSpeech(): void {
  const n = native();
  if (n) { cancelNative?.(); cancelNative = null; void n.ttsStop().catch(() => undefined); return; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

/** Open the system's page for downloading voice data (Android). */
export async function installVoices(): Promise<boolean> {
  const n = native(); if (!n?.ttsInstallData) return false;
  try { await n.ttsInstallData(); return true; } catch { return false; }
}

/** A language's name in the interface language ("Arabic", "العربية"). */
export function languageName(lang: string): string {
  try { return new Intl.DisplayNames([getLang()], { type: 'language' }).of(base(lang)) ?? lang; } catch { return lang; }
}
