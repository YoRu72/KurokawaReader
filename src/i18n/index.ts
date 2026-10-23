import { en, type Strings } from './en';
import { ar } from './ar';
import { ja } from './ja';
import { zh } from './zh';
import { ko } from './ko';

export type Lang = 'en' | 'ar' | 'ja' | 'zh' | 'ko';
const tables: Record<Lang, Partial<Strings>> = { en, ar, ja, zh, ko };
/** Interface languages, each named in its own language (the picker lists these). */
export const LANGS: [Lang, string][] = [['en', 'English'], ['ar', 'العربية'], ['ja', '日本語'], ['zh', '简体中文'], ['ko', '한국어']];
const isLang = (v: string | null): v is Lang => !!v && LANGS.some(([c]) => c === v);
/** The device's language when the app supports it, English otherwise. */
export function systemLang(): Lang {
  for (const l of navigator.languages ?? [navigator.language]) { const c = l.toLowerCase().split('-')[0]; if (isLang(c)) return c; }
  return 'en';
}

let current: Lang = detectInitial();
const listeners = new Set<(lang: Lang) => void>();

function detectInitial(): Lang {
  const saved = localStorage.getItem('kr.lang');
  if (isLang(saved)) return saved;
  return systemLang();
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  localStorage.setItem('kr.lang', lang);
  applyDocumentLang();
  listeners.forEach((fn) => fn(lang));
}

export type LangPref = 'system' | Lang;
export function getLangPref(): LangPref {
  const saved = localStorage.getItem('kr.lang');
  return isLang(saved) ? saved : 'system';
}
export function setLangPref(pref: LangPref): void {
  if (pref === 'system') { localStorage.removeItem('kr.lang'); current = systemLang(); applyDocumentLang(); listeners.forEach((fn) => fn(current)); }
  else setLang(pref);
}

export type DirPref = 'auto' | 'ltr' | 'rtl';
export function getDirPref(): DirPref {
  const d = localStorage.getItem('kr.dir');
  return d === 'ltr' || d === 'rtl' ? d : 'auto';
}
export function setDirPref(d: DirPref): void {
  if (d === 'auto') localStorage.removeItem('kr.dir'); else localStorage.setItem('kr.dir', d);
  applyDocumentLang();
  listeners.forEach((fn) => fn(current));
}

/** Touch-first device (phone/tablet) — hides keyboard-only hints. */
export function isTouchDevice(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyDocumentLang(): void {
  document.documentElement.lang = current;
  const pref = getDirPref();
  document.documentElement.dir = pref === 'auto' ? (current === 'ar' ? 'rtl' : 'ltr') : pref;
  document.title = t('appName');
}

/** Translate a key, substituting `{name}` placeholders. */
export function t(key: keyof Strings, vars?: Record<string, string | number>): string {
  let s = tables[current][key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, formatNumber(v));
  return s;
}

/** Numbers interpolated into strings: Western digits in English, Arabic-Indic in Arabic
 *  (strings such as file names pass through untouched). */
export function formatNumber(v: string | number): string {
  return typeof v === 'number' ? localDigits(new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, useGrouping: false }).format(v)) : v;
}

export function formatDate(ts: number | undefined): string {
  if (!ts) return t('never');
  const loc: Record<Lang, string> = { ar: 'ar-SA-u-nu-arab-ca-gregory', en: 'en-GB', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR' };
  return new Intl.DateTimeFormat(loc[current], { dateStyle: 'medium' }).format(new Date(ts));
}

/** Reading time as "2h 5m" (localised digits and unit). */
export function formatDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  return t('hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${localDigits(n)} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${localDigits(n.toFixed(n < 10 ? 1 : 0))} ${units[i]}`;
}

/** Heuristic: does this text read right-to-left? */
export function isRtlText(text: string): boolean {
  const sample = text.slice(0, 400);
  const rtl = (sample.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/g) ?? []).length;
  const ltr = (sample.match(/[A-Za-zÀ-ɏ]/g) ?? []).length;
  return rtl > ltr;
}

/** Arabic-Indic digits for Arabic UI. */
export function localDigits(n: number | string): string {
  const s = String(n);
  return current === 'ar' ? s.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]) : s;
}

/** "1 file / 2 files" — and the Arabic rules for the counted noun (تمييز العدد):
 *  كتاب · كتابان · ٣–١٠ كتب (جمعٌ مجرور) · ١١–٩٩ كتابًا (مفردٌ منصوب) · ١٠٠ و٢٠٠… كتابٍ (مفردٌ مجرور). */
export function countBooks(n: number): string {
  if (current !== 'ar') return `${n} ${n === 1 ? 'file' : 'files'}`;
  if (n === 0) return 'لا كتب';
  if (n === 1) return 'كتاب';
  if (n === 2) return 'كتابان';
  const r = n % 100;
  if (r === 0) return `${localDigits(n)} كتابٍ`;
  if (r >= 3 && r <= 10) return `${localDigits(n)} كتب`;
  if (r === 1 || r === 2) return `${localDigits(n)} كتابٍ`; // مئةٌ وكتابٌ… تُرَدُّ إلى المفرد المجرور عرفًا في العرض
  return `${localDigits(n)} كتابًا`;
}
