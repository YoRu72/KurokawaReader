// The language a book is filed under in the library (the filter's chips): its own language field, as a base code
// ('en-US' and 'eng' → 'en'), or 'unknown' when it has none. Shown by name in the interface's language.
const ISO3: Record<string, string> = { eng: 'en', ara: 'ar', jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', rus: 'ru', ita: 'it', por: 'pt', tur: 'tr', fas: 'fa', per: 'fa', urd: 'ur', heb: 'he', hin: 'hi', nld: 'nl', dut: 'nl', pol: 'pl', ind: 'id', vie: 'vi', tha: 'th', ukr: 'uk', ell: 'el', gre: 'el' };
export const UNKNOWN_LANG = 'unknown';

/** A book's language as a base code, or 'unknown'. */
export function langKeyOf(b: { language?: string }): string {
  const raw = (b.language ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!raw || raw === 'und' || raw === 'mul' || raw === 'zxx' || raw === 'x' || !/^[a-z]{2,3}$/.test(raw)) return UNKNOWN_LANG;
  return ISO3[raw] ?? raw;
}
/** The languages present among the books, the commonest first, 'unknown' last. */
export function languagesOf(books: { language?: string }[]): string[] {
  const n = new Map<string, number>();
  for (const b of books) { const k = langKeyOf(b); n.set(k, (n.get(k) ?? 0) + 1); }
  return [...n].sort((a, b) => (a[0] === UNKNOWN_LANG ? 1 : b[0] === UNKNOWN_LANG ? -1 : b[1] - a[1] || a[0].localeCompare(b[0]))).map(([k]) => k);
}
/** A language's name in `ui` (the interface's language). */
export function langLabel(key: string, ui: string, unknown: string): string {
  if (key === UNKNOWN_LANG) return unknown;
  try { const n = new Intl.DisplayNames([ui], { type: 'language' }).of(key); if (n && n !== key) return n; } catch { /* no name known */ }
  return key.toUpperCase();
}
