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
  // (A number inside a sentence is prose: ١٢٣ in Arabic by default; figures that stand alone are data.)
  return typeof v === 'number' ? localDigits(new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, useGrouping: false }).format(v), 'prose') : v;
}

const DATE_LOCALE: Record<Lang, string> = { ar: 'ar-SA-u-ca-gregory', en: 'en-GB', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR' };
/** The locale dates are written in for the current language (Arabic: with the digits the interface uses;
 *  a civil date is data, a Hijri one prose). */
export const dateLocale = (ctx: 'data' | 'prose' = 'data'): string => {
  if (current !== 'ar') return DATE_LOCALE[current];
  const pref = digitsPref();
  return `${DATE_LOCALE.ar}-nu-${pref === 'eastern' || (pref === 'auto' && ctx === 'prose') ? 'arab' : 'latn'}`;
};
/** The calendar dates are written in (read from the saved settings, so this file needs nothing of settings.ts). */
export function calendarPref(): 'gregory' | 'hijri' | 'both' {
  try { const v = (JSON.parse(localStorage.getItem('kr.visual') ?? '{}') as { calendar?: string }).calendar; return v === 'hijri' || v === 'both' ? v : 'gregory'; } catch { return 'gregory'; }
}
/** A date in the Hijri (Umm al-Qura) calendar, in the current language. */
export function formatHijri(d: Date, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  const base = DATE_LOCALE[current].split('-u-')[0];
  const nu = current === 'ar' ? (digitsPref() === 'western' ? '-nu-latn' : '-nu-arab') : '';
  return new Intl.DateTimeFormat(`${base}-u-ca-islamic-umalqura${nu}`, opts).format(d);
}
export function formatDate(ts: number | undefined): string {
  if (!ts) return t('never');
  const civil = new Intl.DateTimeFormat(dateLocale(), { dateStyle: 'medium' }).format(new Date(ts));
  const cal = calendarPref();
  if (cal === 'gregory') return civil;
  const hijri = formatHijri(new Date(ts));
  return cal === 'hijri' ? hijri : `${hijri} · ${civil}`;
}

/** Reading time as "2h 5m" (localised digits and unit). */
export function formatDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  return t('hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}

export function formatBytes(n: number): string {
  const arabic = current === 'ar' && visualPref('sizeUnits') === 'arabic';
  if (n < 1024) return `${localDigits(n)} ${arabic ? 'بايت' : 'B'}`;
  const units = arabic ? ['كيلوبايت', 'ميغابايت', 'قيقابايت', 'تيرابايت'] : ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  // (Latin units keep their own left-to-right order after the number, whichever way the line runs.)
  return arabic ? `${localDigits(n.toFixed(n < 10 ? 1 : 0))} ${units[i]}` : `\u2066${localDigits(n.toFixed(n < 10 ? 1 : 0))} ${units[i]}\u2069`;
}

/** Heuristic: does this text read right-to-left? */
export function isRtlText(text: string): boolean {
  const sample = text.slice(0, 400);
  const rtl = (sample.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/g) ?? []).length;
  const ltr = (sample.match(/[A-Za-zÀ-ɏ]/g) ?? []).length;
  return rtl > ltr;
}

/** Arabic-Indic digits for Arabic UI. */
/** A saved visual setting, read here so this file needs nothing of settings.ts. */
function visualPref(key: string): string | undefined {
  try { return (JSON.parse(localStorage.getItem('kr.visual') ?? '{}') as Record<string, string>)[key]; } catch { return undefined; }
}
/** How digits are written in the Arabic interface: 'auto' keeps 123 for data (pages, sizes, times, dates) and
 *  ١٢٣ in prose (counted nouns, Hijri dates); the others use one kind throughout. */
export function digitsPref(): 'auto' | 'western' | 'eastern' {
  const v = visualPref('arDigits'); return v === 'western' || v === 'eastern' ? v : 'auto';
}
const EASTERN = (s: string) => s.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
/** Digits as the interface writes them: `prose` for a number inside an Arabic sentence, `data` (the default)
 *  for a count, a size, a time, a page. */
export function localDigits(n: number | string, ctx: 'data' | 'prose' = 'data'): string {
  const s = String(n);
  if (current !== 'ar') return s;
  const pref = digitsPref();
  return pref === 'eastern' || (pref === 'auto' && ctx === 'prose') ? EASTERN(s) : s;
}

/** A counted noun in Arabic (تمييز العدد), as the case requires: `one` and `two` are the noun alone (واحد
 *  and the dual, nominative or genitive), `few` the plural for 3–10, `many` the singular for 11–99
 *  (accusative), `hundred` the singular for 100, 200… (genitive). */
export function arCount(n: number, f: { one: string; two: string; few: string; many: string; hundred: string }): string {
  if (n === 1) return f.one;
  if (n === 2) return f.two;
  const r = n % 100;
  if (r === 0 || r === 1 || r === 2) return `${localDigits(n, 'prose')} ${f.hundred}`;
  if (r >= 3 && r <= 10) return `${localDigits(n, 'prose')} ${f.few}`;
  return `${localDigits(n, 'prose')} ${f.many}`;
}

/** "1 page / 2 pages" — in Arabic: صفحة واحدة · صفحتان · ٣–١٠ صفحات · ١١–٩٩ صفحةً · ١٠٠ صفحةٍ. */
/** Counted nouns in Japanese, Chinese and Korean: a counter word after the figure, no plural. */
const CJK_COUNT: Record<string, Record<'page' | 'minute' | 'card' | 'book' | 'chapter', string>> = {
  ja: { page: '{n}ページ', minute: '{n}分', card: '{n}枚', book: '{n}冊', chapter: '{n}章' },
  zh: { page: '{n} 页', minute: '{n} 分钟', card: '{n} 张', book: '{n} 本', chapter: '{n} 章' },
  ko: { page: '{n}쪽', minute: '{n}분', card: '카드 {n}장', book: '{n}권', chapter: '{n}장' },
};
const cjkCount = (n: number, what: keyof (typeof CJK_COUNT)['ja']): string | null => (CJK_COUNT[current] ? CJK_COUNT[current][what].replace('{n}', String(n)) : null);
export function countPages(n: number): string {
  if (current !== 'ar') return cjkCount(n, 'page') ?? `${n} ${n === 1 ? 'page' : 'pages'}`;
  return arCount(n, { one: 'صفحة واحدة', two: 'صفحتان', few: 'صفحات', many: 'صفحةً', hundred: 'صفحةٍ' });
}

/** "12 chapters" — in Arabic: فصل واحد · فصلان · ٣–١٠ فصول · ١١–٩٩ فصلًا · ١٠٠ فصلٍ. */
export function countChapters(n: number): string {
  if (current !== 'ar') return cjkCount(n, 'chapter') ?? `${n} ${n === 1 ? 'chapter' : 'chapters'}`;
  return arCount(n, { one: 'فصل واحد', two: 'فصلان', few: 'فصول', many: 'فصلًا', hundred: 'فصلٍ' });
}

/** A format's name as the interface shows it: the file kind in capitals, the online kinds by name. */
export function formatLabel(format: string): string {
  if (format === 'shamela') return 'الشاملة';
  if (format === 'webnovel') return t('webnovelBadge');
  return format.toUpperCase();
}

/** "3 novels" — in Arabic: رواية واحدة · روايتان · ٣–١٠ روايات · ١١–٩٩ روايةً · ١٠٠ روايةٍ. */
export function countNovels(n: number): string {
  if (current !== 'ar') return `${n} ${n === 1 ? 'novel' : 'novels'}`;
  return arCount(n, { one: 'رواية واحدة', two: 'روايتان', few: 'روايات', many: 'روايةً', hundred: 'روايةٍ' });
}

/** "3 volumes" — in Arabic: مجلد واحد · مجلدان · ٣–١٠ مجلدات · ١١–٩٩ مجلدًا · ١٠٠ مجلدٍ. */
export function countVolumes(n: number): string {
  if (current !== 'ar') return `${n} ${n === 1 ? 'volume' : 'volumes'}`;
  return arCount(n, { one: 'مجلد واحد', two: 'مجلدان', few: 'مجلدات', many: 'مجلدًا', hundred: 'مجلدٍ' });
}

/** "3 files" — in Arabic: ملف واحد · ملفان · ٣–١٠ ملفات · ١١–٩٩ ملفًا · ١٠٠ ملفٍ. */
export function countFiles(n: number): string {
  if (current !== 'ar') return `${n} ${n === 1 ? 'file' : 'files'}`;
  return arCount(n, { one: 'ملف واحد', two: 'ملفان', few: 'ملفات', many: 'ملفًا', hundred: 'ملفٍ' });
}

/** "3 min" — in Arabic: دقيقة واحدة · دقيقتان · ٣–١٠ دقائق · ١١–٩٩ دقيقةً · ١٠٠ دقيقةٍ. */
export function countMinutes(n: number): string {
  if (current !== 'ar') return cjkCount(n, 'minute') ?? `${n} min`;
  return arCount(n, { one: 'دقيقة واحدة', two: 'دقيقتان', few: 'دقائق', many: 'دقيقةً', hundred: 'دقيقةٍ' });
}

/** "12 cards" — in Arabic: بطاقة واحدة · بطاقتان · ٣–١٠ بطاقات · ١١–٩٩ بطاقةً · ١٠٠ بطاقةٍ. */
export function countCards(n: number): string {
  if (current !== 'ar') return cjkCount(n, 'card') ?? `${n} ${n === 1 ? 'card' : 'cards'}`;
  return arCount(n, { one: 'بطاقة واحدة', two: 'بطاقتان', few: 'بطاقات', many: 'بطاقةً', hundred: 'بطاقةٍ' });
}

/** "1 file / 2 files" — and the Arabic rules for the counted noun (تمييز العدد):
 *  كتاب · كتابان · ٣–١٠ كتب (جمعٌ مجرور) · ١١–٩٩ كتابًا (مفردٌ منصوب) · ١٠٠ و٢٠٠… كتابٍ (مفردٌ مجرور). */
export function countBooks(n: number): string {
  if (current !== 'ar') return cjkCount(n, 'book') ?? `${n} ${n === 1 ? 'file' : 'files'}`;
  if (n === 0) return 'لا كتب';
  if (n === 1) return 'كتاب';
  if (n === 2) return 'كتابان';
  const r = n % 100;
  if (r === 0) return `${localDigits(n, 'prose')} كتابٍ`;
  if (r >= 3 && r <= 10) return `${localDigits(n, 'prose')} كتب`;
  if (r === 1 || r === 2) return `${localDigits(n, 'prose')} كتابٍ`; // مئةٌ وكتابٌ… تُرَدُّ إلى المفرد المجرور عرفًا في العرض
  return `${localDigits(n, 'prose')} كتابًا`;
}
