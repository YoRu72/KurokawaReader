import { en, type Strings } from './en';
import { ar } from './ar';

export type Lang = 'en' | 'ar';
const tables: Record<Lang, Strings> = { en, ar };

let current: Lang = detectInitial();
const listeners = new Set<(lang: Lang) => void>();

function detectInitial(): Lang {
  const saved = localStorage.getItem('kr.lang');
  if (saved === 'en' || saved === 'ar') return saved;
  return navigator.language.toLowerCase().startsWith('ar') ? 'ar' : 'en';
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

export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyDocumentLang(): void {
  document.documentElement.lang = current;
  document.documentElement.dir = current === 'ar' ? 'rtl' : 'ltr';
  document.title = t('appName');
}

/** Translate a key, substituting `{name}` placeholders. */
export function t(key: keyof Strings, vars?: Record<string, string | number>): string {
  let s = tables[current][key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, formatNumber(v));
  return s;
}

/** Numbers are shown with Western digits in both languages — book pages, percentages
 *  and sizes stay unambiguous that way; Arabic prose still uses the Arabic percent sign. */
export function formatNumber(v: string | number): string {
  return typeof v === 'number' ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(v) : v;
}

export function formatDate(ts: number | undefined): string {
  if (!ts) return t('never');
  return new Intl.DateTimeFormat(current === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { dateStyle: 'medium' }).format(new Date(ts));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** Heuristic: does this text read right-to-left? */
export function isRtlText(text: string): boolean {
  const sample = text.slice(0, 400);
  const rtl = (sample.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/g) ?? []).length;
  const ltr = (sample.match(/[A-Za-zÀ-ɏ]/g) ?? []).length;
  return rtl > ltr;
}
