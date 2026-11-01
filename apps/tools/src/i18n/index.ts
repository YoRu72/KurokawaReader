import { en, type Strings } from './en';

export type Lang = 'en' | 'ar' | 'ja' | 'zh' | 'ko';
// (English is always here, the fallback for any string; the language in use is fetched before the first view is
// drawn, and another when chosen — not all five read at every start: a third of the startup's code.)
const tables: Partial<Record<Lang, Partial<Strings>>> = { en };
const loaders: Record<Exclude<Lang, 'en'>, () => Promise<Partial<Strings>>> = {
  ar: () => import('./ar').then((m) => m.ar), ja: () => import('./ja').then((m) => m.ja), zh: () => import('./zh').then((m) => m.zh), ko: () => import('./ko').then((m) => m.ko),
};
/** The strings of `lang` fetched (at once when already here). */
export async function loadLang(lang: Lang): Promise<void> {
  if (tables[lang]) return;
  try { tables[lang] = await loaders[lang as Exclude<Lang, 'en'>](); } catch { /* English meanwhile */ }
}
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
  void loadLang(lang).then(() => { if (current !== lang) return; applyDocumentLang(); listeners.forEach((fn) => fn(lang)); });
}

export type LangPref = 'system' | Lang;
export function getLangPref(): LangPref {
  const saved = localStorage.getItem('kr.lang');
  return isLang(saved) ? saved : 'system';
}
export function setLangPref(pref: LangPref): void {
  if (pref === 'system') { localStorage.removeItem('kr.lang'); const l = current = systemLang(); void loadLang(l).then(() => { if (current !== l) return; applyDocumentLang(); listeners.forEach((fn) => fn(l)); }); }
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
  let s = tables[current]?.[key] ?? en[key] ?? key;
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
  if (!ts) return '';
  const civil = new Intl.DateTimeFormat(dateLocale(), { dateStyle: 'medium' }).format(new Date(ts));
  const cal = calendarPref();
  if (cal === 'gregory') return civil;
  const hijri = formatHijri(new Date(ts));
  return cal === 'hijri' ? hijri : `${hijri} · ${civil}`;
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
  void key; return undefined;
  // (The reader keeps such preferences in kr.visual; Tools has none of them yet.)
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
const CJK_COUNT: Record<string, Record<'file' | 'minute' | 'second' | 'item' | 'episode' | 'connection' | 'peer' | 'result' | 'addon' | 'video' | 'source', string>> = {
  ja: { file: '{n}個のファイル', minute: '{n}分', second: '{n}秒', item: '{n}件', episode: '{n}話', connection: '{n}接続', peer: '{n}ピア', result: '{n}件', addon: '{n}個のアドオン', video: '{n}本の動画', source: '{n}件のソース' },
  zh: { file: '{n} 个文件', minute: '{n} 分钟', second: '{n} 秒', item: '{n} 项', episode: '{n} 集', connection: '{n} 个连接', peer: '{n} 个节点', result: '{n} 个结果', addon: '{n} 个附加组件', video: '{n} 个视频', source: '{n} 个来源' },
  ko: { file: '파일 {n}개', minute: '{n}분', second: '{n}초', item: '{n}개', episode: '{n}화', connection: '연결 {n}개', peer: '피어 {n}개', result: '결과 {n}개', addon: '부가 기능 {n}개', video: '동영상 {n}개', source: '소스 {n}개' },
};
const cjkCount = (n: number, what: keyof (typeof CJK_COUNT)['ja']): string | null => (CJK_COUNT[current] ? CJK_COUNT[current][what].replace('{n}', String(n)) : null);
const enCount = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** Counted nouns, each language's way: Arabic by its grammar (ملف، ملفان، ٣–١٠ ملفات، ١١+ ملفًا، ١٠٠ ملفٍ), CJK with
 *  their counters, English with its plural. */
export function countFiles(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'ملف واحد', two: 'ملفان', few: 'ملفات', many: 'ملفًا', hundred: 'ملفٍ' });
  return cjkCount(n, 'file') ?? enCount(n, 'file', 'files');
}
export function countItems(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'عنصر واحد', two: 'عنصران', few: 'عناصر', many: 'عنصرًا', hundred: 'عنصرٍ' });
  return cjkCount(n, 'item') ?? enCount(n, 'item', 'items');
}
export function countEpisodes(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'حلقة واحدة', two: 'حلقتان', few: 'حلقات', many: 'حلقةً', hundred: 'حلقةٍ' });
  return cjkCount(n, 'episode') ?? enCount(n, 'episode', 'episodes');
}
export function countConnections(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'اتصال واحد', two: 'اتصالان', few: 'اتصالات', many: 'اتصالًا', hundred: 'اتصالٍ' });
  return cjkCount(n, 'connection') ?? enCount(n, 'connection', 'connections');
}
export function countVersions(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'إصدار واحد', two: 'إصداران', few: 'إصدارات', many: 'إصدارًا', hundred: 'إصدارٍ' });
  return cjkCount(n, 'item') ?? enCount(n, 'version', 'versions');
}
export function countSegments(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'مقطع واحد', two: 'مقطعان', few: 'مقاطع', many: 'مقطعًا', hundred: 'مقطعٍ' });
  if (current === 'en') return enCount(n, 'segment', 'segments');
  return t('segmentsN', { n: localDigits(n) });
}
export function countPeers(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'نظير واحد', two: 'نظيران', few: 'نظراء', many: 'نظيرًا', hundred: 'نظيرٍ' });
  return cjkCount(n, 'peer') ?? enCount(n, 'peer', 'peers');
}
export function countResults(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'نتيجة واحدة', two: 'نتيجتان', few: 'نتائج', many: 'نتيجةً', hundred: 'نتيجةٍ' });
  return cjkCount(n, 'result') ?? enCount(n, 'result', 'results');
}
export function countAddons(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'إضافة واحدة', two: 'إضافتان', few: 'إضافات', many: 'إضافةً', hundred: 'إضافةٍ' });
  return cjkCount(n, 'addon') ?? enCount(n, 'add-on', 'add-ons');
}
export function countSources(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'مصدر واحد', two: 'مصدران', few: 'مصادر', many: 'مصدرًا', hundred: 'مصدرٍ' });
  return cjkCount(n, 'source') ?? enCount(n, 'source', 'sources');
}
export function countVideos(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'مقطع واحد', two: 'مقطعان', few: 'مقاطع', many: 'مقطعًا', hundred: 'مقطعٍ' });
  return cjkCount(n, 'video') ?? enCount(n, 'video', 'videos');
}
export function countDays(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'يوم واحد', two: 'يومان', few: 'أيام', many: 'يومًا', hundred: 'يومٍ' });
  return enCount(n, 'day', 'days');
}
export function countHours(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'ساعة واحدة', two: 'ساعتان', few: 'ساعات', many: 'ساعةً', hundred: 'ساعةٍ' });
  return enCount(n, 'hour', 'hours');
}
export function countMinutes(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'دقيقة واحدة', two: 'دقيقتان', few: 'دقائق', many: 'دقيقةً', hundred: 'دقيقةٍ' });
  return cjkCount(n, 'minute') ?? enCount(n, 'minute', 'minutes');
}
export function countSeconds(n: number): string {
  if (current === 'ar') return arCount(n, { one: 'ثانية واحدة', two: 'ثانيتان', few: 'ثوانٍ', many: 'ثانيةً', hundred: 'ثانيةٍ' });
  return cjkCount(n, 'second') ?? enCount(n, 'second', 'seconds');
}
